-- Team-based games. Existing results keep their recorded participants.
set local lock_timeout='5s';

create or replace function public.tm_public_start_game(p_game_id uuid)
returns void language plpgsql security definer set search_path=''
as $$
declare
  v_session public.tm_sessions%rowtype;
  v_game public.tm_games%rowtype;
  v_rotation_status text;
  v_team uuid;
  v_sub_count integer;
  v_regular_count integer;
  v_minimum integer := 4;
begin
  select s.* into v_session
  from public.tm_games g
  join public.tm_rotations r on r.id=g.rotation_id
  join public.tm_sessions s on s.id=r.session_id
  where g.id=p_game_id and s.status='active'
  for update of s;
  if not found then
    raise exception 'No active session for this game' using errcode='22023';
  end if;
  select * into v_game from public.tm_games where id=p_game_id;
  select status into v_rotation_status
    from public.tm_rotations where id=v_game.rotation_id;
  if v_rotation_status<>'published' then
    raise exception 'Rotation is not published' using errcode='22023';
  end if;
  perform tm_internal.refresh_slots(v_game.rotation_id);
  select * into v_game from public.tm_games where id=p_game_id;
  if v_game.status<>'ready' or v_game.team_a_id is null
     or v_game.team_b_id is null then
    raise exception 'Game is not ready; refresh the schedule'
      using errcode='22023';
  end if;

  -- Disallow the same team playing two simultaneous games on ANY court.
  if exists (
    select 1 from public.tm_games g
    where g.rotation_id=v_game.rotation_id and g.status='playing'
      and (g.team_a_id in (v_game.team_a_id,v_game.team_b_id)
        or g.team_b_id in (v_game.team_a_id,v_game.team_b_id))
  ) then
    raise exception 'One of these teams is already playing'
      using errcode='22023';
  end if;

  -- Take a game-day snapshot of everyone available on the two teams.
  -- Extra roster members share the team's result regardless of court changes.
  foreach v_team in array array[v_game.team_a_id,v_game.team_b_id] loop
    select count(*) into v_sub_count
    from public.tm_game_subs subs
    join public.tm_session_players sp on sp.id=subs.session_player_id
    join public.tm_memberships donor on donor.session_player_id=sp.id
      and donor.rotation_id=v_game.rotation_id
    join public.tm_teams t on t.id=donor.team_id
    where subs.game_id=p_game_id and subs.target_team_id=v_team
      and sp.attendance in ('present','waiting')
      and t.court=v_game.court and t.id not in (v_game.team_a_id,v_game.team_b_id)
      and not exists (
        select 1 from public.tm_game_appearances a join public.tm_games other on other.id=a.game_id
        where a.session_player_id=sp.id and other.status='playing'
      );
    if v_sub_count <> (select count(*) from public.tm_game_subs
      where game_id=p_game_id and target_team_id=v_team) then
      raise exception 'A planned substitute is unavailable' using errcode='22023';
    end if;

    insert into public.tm_game_appearances
      (game_id,rotation_id,session_id,session_player_id,team_id,is_substitute,active_on_court)
    select p_game_id,v_game.rotation_id,v_session.id,sp.id,v_team,false,false
    from public.tm_memberships m
    join public.tm_session_players sp on sp.id=m.session_player_id
    where m.rotation_id=v_game.rotation_id and m.team_id=v_team
      and sp.attendance in ('present','waiting')
      and not exists (
        select 1 from public.tm_game_appearances a join public.tm_games other on other.id=a.game_id
        where a.session_player_id=sp.id and other.status='playing'
      );
    get diagnostics v_regular_count = row_count;
    if v_regular_count + v_sub_count < v_minimum then
      raise exception 'A team needs at least four available players' using errcode='22023';
    end if;

    insert into public.tm_game_appearances
      (game_id,rotation_id,session_id,session_player_id,team_id,is_substitute,active_on_court)
    select p_game_id,v_game.rotation_id,v_session.id,subs.session_player_id,v_team,true,false
    from public.tm_game_subs subs
    where subs.game_id=p_game_id and subs.target_team_id=v_team;
  end loop;
  update public.tm_games set status='playing',started_at=now()
    where id=p_game_id and status='ready';
  if not found then
    raise exception 'Someone already started this game'
      using errcode='22023';
  end if;
  update public.tm_sessions set revision=revision+1 where id=v_session.id;
  insert into public.tm_action_audit(session_id,action,details)
    values (v_session.id,'start_game',
      jsonb_build_object('game_id',p_game_id));
  perform tm_internal.refresh_slots(v_game.rotation_id);
end $$;

-- Older clients can still refresh the schedule. There is no live individual lineup.
create or replace function public.tm_public_game_lineup(p_game_id uuid)
returns jsonb language sql immutable security invoker set search_path=''
as $$ select '[]'::jsonb $$;

-- Keep the old callable signatures safe for tabs opened before deployment.
create or replace function public.tm_public_rotate_teammate(
  p_game_id uuid,p_out_player_id uuid,p_in_player_id uuid
)
returns void language plpgsql security invoker set search_path=''
as $$
begin
  raise exception 'The game uses the team roster recorded at the start. Report the winning team when it finishes.'
    using errcode='55000';
end $$;

create or replace function public.tm_public_emergency_sub(
  p_game_id uuid,p_out_player_id uuid,p_in_player_id uuid
)
returns void language plpgsql security invoker set search_path=''
as $$
begin
  raise exception 'The game uses the team roster recorded at the start. Report the winning team when it finishes.'
    using errcode='55000';
end $$;

-- Organizers can correct a recorded participant after the game is complete.
create or replace function public.tm_org_correct_appearance(
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
    and g.status='completed'
  for update of s;
  if v_session is null then
    raise exception 'Participation can only be corrected after a game is completed'
      using errcode='22023';
  end if;
  select g.* into v_game from public.tm_games g
  join public.tm_rotations r on r.id=g.rotation_id
  where g.id=p_game_id and g.status='completed'
    and r.status in ('published','completed','ended_early');
  if not found then
    raise exception 'Participation can only be corrected after a game is completed'
      using errcode='22023';
  end if;
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

create or replace function public.tm_org_game_appearances(p_game_id uuid)
returns jsonb language plpgsql stable security definer set search_path=''
as $$
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
  where a.game_id=p_game_id and g.status='completed';
  return coalesce(v_result,'[]'::jsonb);
end $$;

notify pgrst, 'reload schema';
