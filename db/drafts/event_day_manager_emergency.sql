-- EVENT DAY MANAGER PART 7: EMERGENCY IN-GAME SIX-TEAM SUBSTITUTIONS
-- Review draft. Changes ONLY the new Teams Manager tables, not registrations.
-- Apply after parts 1-6 in disposable PostgreSQL tests.
--
-- An appearance means a person participated at least once. Someone injured
-- mid-game retains that appearance, but is no longer actively on court.
-- A substitute is a new appearance and does not affect regular-game fairness.
alter table public.tm_game_appearances
  add column active_on_court boolean not null default true;

-- Player-facing display of the CURRENT playing lineup, no private attributes.
create function public.tm_public_game_lineup(p_game_id uuid)
returns jsonb language sql stable security definer set search_path=''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'player_id',sp.id,'name',sp.display_name,
    'team_id',a.team_id,'is_substitute',a.is_substitute
  ) order by sp.display_name,sp.id),'[]'::jsonb)
  from public.tm_game_appearances a
  join public.tm_session_players sp on sp.id=a.session_player_id
  join public.tm_games g on g.id=a.game_id
  join public.tm_rotations r on r.id=g.rotation_id
  join public.tm_sessions s on s.id=r.session_id
  where a.game_id=p_game_id and a.active_on_court
    and g.status='playing' and r.status='published'
    and s.status='active'
$$;

create function public.tm_public_emergency_sub(
  p_game_id uuid,p_out_player_id uuid,p_in_player_id uuid
)
returns void language plpgsql security definer set search_path=''
as $$
declare
  v_session public.tm_sessions%rowtype;
  v_game public.tm_games%rowtype;
  v_team uuid;
  v_source uuid;
  v_source_court smallint;
  v_in_status text;
  v_team_count integer;
begin
  select s.* into v_session
  from public.tm_games g
  join public.tm_rotations r on r.id=g.rotation_id
  join public.tm_sessions s on s.id=r.session_id
  where g.id=p_game_id and g.status='playing'
    and r.status='published' and s.status='active'
  for update of s;
  if not found then
    raise exception 'Emergency substitutions require an active game'
      using errcode='22023';
  end if;
  select * into v_game from public.tm_games where id=p_game_id;
  select count(*) into v_team_count from public.tm_teams
    where rotation_id=v_game.rotation_id;
  if v_team_count<>6 then
    raise exception 'Midgame emergency substitutions require a six-team rotation'
      using errcode='22023';
  end if;
  select a.team_id into v_team from public.tm_game_appearances a
  where a.game_id=p_game_id and a.session_player_id=p_out_player_id
    and a.active_on_court;
  if v_team is null then
    raise exception 'Outgoing player is not currently on this court'
      using errcode='22023';
  end if;
  select m.team_id,t.court,sp.attendance
  into v_source,v_source_court,v_in_status
  from public.tm_memberships m
  join public.tm_teams t on t.id=m.team_id
  join public.tm_session_players sp on sp.id=m.session_player_id
  where m.rotation_id=v_game.rotation_id and m.session_player_id=p_in_player_id;
  if v_source is null or v_source_court is distinct from v_game.court
     or v_source in (v_game.team_a_id,v_game.team_b_id)
     or v_in_status not in ('present','waiting') then
    raise exception 'Replacement must be available from the resting same-court team'
      using errcode='22023';
  end if;
  if exists(select 1 from public.tm_game_appearances
    where game_id=p_game_id and session_player_id=p_in_player_id)
    or exists(
      select 1 from public.tm_game_appearances a
      join public.tm_games g on g.id=a.game_id
      where a.session_player_id=p_in_player_id and g.status='playing'
        and a.active_on_court
    ) then
    raise exception 'Replacement is already assigned to a current game'
      using errcode='22023';
  end if;
  update public.tm_game_appearances
    set active_on_court=false
    where game_id=p_game_id and session_player_id=p_out_player_id
      and active_on_court;
  if not found then
    raise exception 'Outgoing player already replaced'
      using errcode='22023';
  end if;
  insert into public.tm_game_appearances(
    game_id,rotation_id,session_id,session_player_id,team_id,
    is_substitute,active_on_court)
  values (p_game_id,v_game.rotation_id,v_session.id,p_in_player_id,
    v_team,true,true);
  update public.tm_sessions set revision=revision+1 where id=v_session.id;
  insert into public.tm_action_audit(session_id,action,details)
    values(v_session.id,'emergency_sub',jsonb_build_object(
      'game_id',p_game_id,'out_player_id',p_out_player_id,
      'in_player_id',p_in_player_id,'team_id',v_team
    ));
end $$;

-- Organizer correction: replace a mistaken appearance entry. This is
-- administrative correction, not permission to change an ongoing lineup
-- across courts. Corrected players must be eligible for the same team role.
create function public.tm_org_correct_appearance(
  p_game_id uuid,p_wrong_player_id uuid,p_correct_player_id uuid
)
returns void language plpgsql security definer set search_path=''
as $$
declare
  v_session uuid;
  v_game public.tm_games%rowtype;
  v_wrong public.tm_game_appearances%rowtype;
  v_source_team uuid;
  v_source_court smallint;
  v_correct_attendance text;
  v_target_court smallint;
  v_team_count int;
begin
  if auth.uid() is null or not exists(
    select 1 from public.organizers where user_id=auth.uid()
  ) then
    raise exception 'Organizer access required' using errcode='42501';
  end if;
  select s.id into v_session
  from public.tm_games g
  join public.tm_rotations r on r.id=g.rotation_id
  join public.tm_sessions s on s.id=r.session_id
  where g.id=p_game_id and s.status='active'
    and r.status in ('published','completed','ended_early')
    and g.status in ('playing','completed')
  for update of s;
  if v_session is null then
    raise exception 'Game is not eligible for lineup correction'
      using errcode='22023';
  end if;
  select * into v_game from public.tm_games where id=p_game_id;
  select * into v_wrong from public.tm_game_appearances
    where game_id=p_game_id and session_player_id=p_wrong_player_id;
  if not found or p_wrong_player_id=p_correct_player_id then
    raise exception 'Choose a different recorded game participant'
      using errcode='22023';
  end if;
  if exists(select 1 from public.tm_game_appearances
    where game_id=p_game_id and session_player_id=p_correct_player_id) then
    raise exception 'Corrected player is already in this game'
      using errcode='22023';
  end if;
  select attendance into v_correct_attendance from public.tm_session_players
    where id=p_correct_player_id and session_id=v_session;
  if v_correct_attendance is null then
    raise exception 'Corrected player does not belong to this session'
      using errcode='22023';
  end if;
  if not v_wrong.is_substitute then
    if not exists(
      select 1 from public.tm_memberships
      where rotation_id=v_game.rotation_id
        and team_id=v_wrong.team_id
        and session_player_id=p_correct_player_id
    ) then
      raise exception 'Regular lineup correction must remain on the same team'
        using errcode='22023';
    end if;
  else
    select count(*) into v_team_count from public.tm_teams
      where rotation_id=v_game.rotation_id;
    if v_team_count<>6 then
      raise exception 'No substitute corrections in this rotation'
        using errcode='22023';
    end if;
    select m.team_id,t.court into v_source_team,v_source_court
    from public.tm_memberships m
    join public.tm_teams t on t.id=m.team_id
    where m.rotation_id=v_game.rotation_id
      and m.session_player_id=p_correct_player_id;
    if v_source_team is null or v_source_court is distinct from v_game.court
       or v_source_team in (v_game.team_a_id,v_game.team_b_id) then
      raise exception 'Substitute correction must use the resting same-court team'
        using errcode='22023';
    end if;
  end if;

  if v_game.status='playing' and v_wrong.active_on_court and exists(
    select 1 from public.tm_game_appearances a
    join public.tm_games g on g.id=a.game_id
    where a.session_player_id=p_correct_player_id and g.status='playing'
      and a.active_on_court
  ) then
    raise exception 'Corrected player is currently playing elsewhere'
      using errcode='22023';
  end if;
  update public.tm_game_appearances set session_player_id=p_correct_player_id
  where game_id=p_game_id and session_player_id=p_wrong_player_id;
  update public.tm_sessions set revision=revision+1 where id=v_session;
  insert into public.tm_action_audit(session_id,action,actor_user_id,details)
    values (v_session,'correct_appearance',auth.uid(),
      jsonb_build_object('game_id',p_game_id,
        'wrong_player_id',p_wrong_player_id,
        'correct_player_id',p_correct_player_id,
        'team_id',v_wrong.team_id,'is_substitute',v_wrong.is_substitute));
end $$;

-- Organizer-only historical roster to correct an erroneous recorded
-- participant without revealing completed-game appearance details publicly.
create function public.tm_org_game_appearances(p_game_id uuid)
returns jsonb language plpgsql stable security definer set search_path=''
as $
declare
  v_result jsonb;
begin
  if auth.uid() is null or not exists(
    select 1 from public.organizers where user_id=auth.uid()
  ) then
    raise exception 'Organizer access required' using errcode='42501';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'player_id',sp.id,'name',sp.display_name,
    'team_id',a.team_id,'is_substitute',a.is_substitute,
    'active_on_court',a.active_on_court
  ) order by sp.display_name,sp.id),'[]'::jsonb)
  into v_result
  from public.tm_game_appearances a
  join public.tm_session_players sp on sp.id=a.session_player_id
  join public.tm_games g on g.id=a.game_id
  where a.game_id=p_game_id and g.status in ('playing','completed');
  return coalesce(v_result,'[]'::jsonb);
end $;

revoke execute on function public.tm_public_game_lineup(uuid)
  from public,anon,authenticated;
revoke execute on function public.tm_public_emergency_sub(uuid,uuid,uuid)
  from public,anon,authenticated;
revoke execute on function public.tm_org_correct_appearance(uuid,uuid,uuid)
  from public,anon,authenticated;
grant execute on function public.tm_public_game_lineup(uuid)
  to anon,authenticated;
grant execute on function public.tm_public_emergency_sub(uuid,uuid,uuid)
  to anon,authenticated;
grant execute on function public.tm_org_correct_appearance(uuid,uuid,uuid)
  to authenticated;
revoke execute on function public.tm_org_game_appearances(uuid)
  from public,anon,authenticated;
grant execute on function public.tm_org_game_appearances(uuid)
  to authenticated;
