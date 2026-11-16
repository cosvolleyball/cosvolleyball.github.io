-- EVENT DAY MANAGER PART 4: PUBLIC SUBS AND FIVE-TEAM TRANSFERS
-- REVIEW DRAFT ONLY. Applied only to disposable PostgreSQL test service.
--
-- The six-team format permits game-specific same-court resting-team subs.
-- Five-team rotations permit NO temporary subs; instead, roster transfers
-- between games persist until the next organizer-published reshuffle.
-- Four-team round robin has no resting team to borrow from.

create function public.tm_public_record_sub(
  p_game_id uuid,
  p_session_player_id uuid,
  p_target_team_id uuid
)
returns void language plpgsql security definer set search_path=''
as $$
declare
  v_session public.tm_sessions%rowtype;
  v_game public.tm_games%rowtype;
  v_team_count integer;
  v_source_court smallint;
  v_source_team uuid;
  v_format smallint;
  v_player_status text;
  v_regular_count integer;
  v_sub_count integer;
begin
  select s.* into v_session
  from public.tm_games g
  join public.tm_rotations r on r.id=g.rotation_id
  join public.tm_sessions s on s.id=r.session_id
  where g.id=p_game_id and s.status='active' and r.status='published'
  for update of s;
  if not found then
    raise exception 'Game is outside the active rotation'
      using errcode='22023';
  end if;
  select * into v_game from public.tm_games where id=p_game_id;
  select playing_format into v_format from public.tm_rotations
    where id=v_game.rotation_id;
  select count(*) into v_team_count from public.tm_teams
    where rotation_id=v_game.rotation_id;
  if v_team_count<>6 then
    raise exception 'One-game substitutions are only allowed with six teams'
      using errcode='22023';
  end if;
  perform tm_internal.refresh_slots(v_game.rotation_id);
  select * into v_game from public.tm_games where id=p_game_id;
  if v_game.status<>'ready'
     or p_target_team_id not in (v_game.team_a_id,v_game.team_b_id) then
    raise exception 'Game must be ready; choose a playing team'
      using errcode='22023';
  end if;

  select m.team_id,t.court,sp.attendance
    into v_source_team,v_source_court,v_player_status
  from public.tm_memberships m
  join public.tm_teams t on t.id=m.team_id
  join public.tm_session_players sp on sp.id=m.session_player_id
  where m.rotation_id=v_game.rotation_id
    and m.session_player_id=p_session_player_id;
  if v_source_team is null or v_source_court is distinct from v_game.court
     or v_source_team in (v_game.team_a_id,v_game.team_b_id)
     or v_player_status not in ('present','waiting') then
    raise exception 'Player is not eligible from a resting team on this court'
      using errcode='22023';
  end if;
  if exists (
    select 1 from public.tm_game_appearances a
    join public.tm_games g on g.id=a.game_id
    where a.session_player_id=p_session_player_id and g.status='playing'
  ) then
    raise exception 'Player is already in a live game'
      using errcode='22023';
  end if;
  select count(*) into v_regular_count
  from public.tm_memberships m
  join public.tm_session_players sp on sp.id=m.session_player_id
  where m.rotation_id=v_game.rotation_id and m.team_id=p_target_team_id
    and sp.attendance in ('present','waiting')
    and not exists (
      select 1 from public.tm_game_appearances a
      join public.tm_games g on g.id=a.game_id
      where a.session_player_id=sp.id and g.status='playing'
    );
  select count(*) into v_sub_count from public.tm_game_subs
    where game_id=p_game_id and target_team_id=p_target_team_id;
  if v_regular_count+v_sub_count>=v_format then
    raise exception 'Team already has enough players for this game'
      using errcode='22023';
  end if;

  -- Primary key ensures one person cannot be assigned to both teams.
  insert into public.tm_game_subs(
    game_id,rotation_id,session_id,session_player_id,target_team_id
  ) values (
    p_game_id,v_game.rotation_id,v_session.id,p_session_player_id,p_target_team_id
  );
  update public.tm_sessions set revision=revision+1 where id=v_session.id;
  insert into public.tm_action_audit(session_id,action,details)
    values (v_session.id,'record_sub',
      jsonb_build_object('game_id',p_game_id,
        'player_id',p_session_player_id,'team_id',p_target_team_id));
end $$;

-- A public caller may undo an erroneous pre-game substitute assignment.
-- Once the match starts, appearances are fixed; organizer handles mistakes
-- by correction workflows, never rewriting a completed game silently.
create function public.tm_public_cancel_sub(
  p_game_id uuid,p_session_player_id uuid
)
returns void language plpgsql security definer set search_path=''
as $$
declare
  v_session uuid;
  v_status text;
begin
  select s.id,g.status into v_session,v_status
  from public.tm_games g
  join public.tm_rotations r on r.id=g.rotation_id
  join public.tm_sessions s on s.id=r.session_id
  where g.id=p_game_id and s.status='active'
    and r.status='published'
  for update of s;
  if v_session is null or v_status<>'ready' then
    raise exception 'Can only cancel substitutions before a game begins'
      using errcode='22023';
  end if;
  delete from public.tm_game_subs
    where game_id=p_game_id and session_player_id=p_session_player_id;
  if not found then
    raise exception 'Substitution was not found' using errcode='22023';
  end if;
  update public.tm_sessions set revision=revision+1 where id=v_session;
  insert into public.tm_action_audit(session_id,action,details)
    values (v_session,'cancel_sub',
      jsonb_build_object('game_id',p_game_id,
        'player_id',p_session_player_id));
end $$;

create function public.tm_public_transfer(
  p_rotation_id uuid,p_session_player_id uuid,p_to_team_id uuid
)
returns void language plpgsql security definer set search_path=''
as $$
declare
  v_session public.tm_sessions%rowtype;
  v_from_team_id uuid;
  v_available_count integer;
  v_format smallint;
  v_team_count integer;
  v_attendance text;
begin
  select s.* into v_session from public.tm_rotations r
  join public.tm_sessions s on s.id=r.session_id
  where r.id=p_rotation_id and r.status='published'
    and s.status='active'
  for update of s;
  if not found then
    raise exception 'Transfer is outside an active published rotation'
      using errcode='22023';
  end if;
  select playing_format into v_format from public.tm_rotations
    where id=p_rotation_id;
  select count(*) into v_team_count from public.tm_teams
    where rotation_id=p_rotation_id;
  if v_team_count<>5 then
    raise exception 'Permanent transfers are only for five-team rotations'
      using errcode='22023';
  end if;
  if not exists (
    select 1 from public.tm_teams where id=p_to_team_id
      and rotation_id=p_rotation_id
  ) then
    raise exception 'Target is not a team in this rotation'
      using errcode='22023';
  end if;
  select m.team_id,sp.attendance into v_from_team_id,v_attendance
  from public.tm_memberships m
  join public.tm_session_players sp on sp.id=m.session_player_id
  where m.rotation_id=p_rotation_id
    and m.session_player_id=p_session_player_id;
  if v_from_team_id is null
     or v_attendance not in ('present','waiting')
     or v_from_team_id=p_to_team_id then
    raise exception 'Invalid available player or target team'
      using errcode='22023';
  end if;
  -- A public transfer lasts the WHOLE rotation. Repeated public moves
  -- would undermine player agreement and distort the actual team record.
  -- Only an authenticated organizer can correct a mistaken transfer.
  if exists (
    select 1 from public.tm_transfers
    where rotation_id=p_rotation_id
      and session_player_id=p_session_player_id
  ) then
    raise exception 'Player already transferred in this rotation; ask an organizer to correct'
      using errcode='22023';
  end if;
  if exists (
    select 1 from public.tm_games g
    where g.rotation_id=p_rotation_id and g.status='playing'
      and (g.team_a_id in (v_from_team_id,p_to_team_id)
        or g.team_b_id in (v_from_team_id,p_to_team_id))
  ) or exists (
    select 1 from public.tm_game_appearances a
    join public.tm_games g on g.id=a.game_id
    where a.session_player_id=p_session_player_id and g.status='playing'
  ) then
    raise exception 'Transfers cannot interrupt a game'
      using errcode='22023';
  end if;

  select count(*) into v_available_count
  from public.tm_memberships m
  join public.tm_session_players sp on sp.id=m.session_player_id
  where m.rotation_id=p_rotation_id and m.team_id=v_from_team_id
    and sp.attendance in ('present','waiting');
  if v_available_count-1<v_format then
    raise exception 'Source team needs enough players for its own matches'
      using errcode='22023';
  end if;

  update public.tm_memberships set team_id=p_to_team_id
    where rotation_id=p_rotation_id and session_player_id=p_session_player_id;
  insert into public.tm_transfers(
    rotation_id,session_id,session_player_id,from_team_id,to_team_id,
    recorded_by
  ) values (
    p_rotation_id,v_session.id,p_session_player_id,
    v_from_team_id,p_to_team_id,auth.uid()
  );
  update public.tm_sessions set revision=revision+1 where id=v_session.id;
  insert into public.tm_action_audit(session_id,action,actor_user_id,details)
    values (v_session.id,'transfer',auth.uid(),
      jsonb_build_object('rotation_id',p_rotation_id,
        'player_id',p_session_player_id,
        'from_team_id',v_from_team_id,'to_team_id',p_to_team_id));
end $$;


-- Organizer may correct a mistaken five-team transfer. A correction remains
-- between games only; it is audited and is NOT a general mid-game reshuffle.
create function public.tm_org_correct_transfer(
  p_rotation_id uuid,p_session_player_id uuid,p_to_team_id uuid
)
returns void language plpgsql security definer set search_path=''
as $
declare
  v_session public.tm_sessions%rowtype;
  v_from_team uuid;
  v_available_count integer;
  v_format smallint;
  v_count integer;
begin
  if auth.uid() is null or not exists(
    select 1 from public.organizers where user_id=auth.uid()
  ) then
    raise exception 'Organizer access required' using errcode='42501';
  end if;
  select s.* into v_session
  from public.tm_rotations r
  join public.tm_sessions s on s.id=r.session_id
  where r.id=p_rotation_id and r.status='published'
    and s.status='active' for update of s;
  if not found then
    raise exception 'Rotation is no longer active' using errcode='22023';
  end if;
  select playing_format into v_format from public.tm_rotations
    where id=p_rotation_id;
  select count(*) into v_count from public.tm_teams
    where rotation_id=p_rotation_id;
  if v_count<>5 then
    raise exception 'Transfer correction requires five teams' using errcode='22023';
  end if;
  if not exists(select 1 from public.tm_transfers
    where rotation_id=p_rotation_id
      and session_player_id=p_session_player_id) then
    raise exception 'No transfer exists to correct' using errcode='22023';
  end if;
  select team_id into v_from_team from public.tm_memberships
    where rotation_id=p_rotation_id and session_player_id=p_session_player_id;
  if v_from_team is null or v_from_team=p_to_team_id
    or not exists (
      select 1 from public.tm_teams
      where id=p_to_team_id and rotation_id=p_rotation_id
    ) then
    raise exception 'Invalid current team or correction target'
      using errcode='22023';
  end if;
  if exists(
    select 1 from public.tm_games
    where rotation_id=p_rotation_id and status='playing'
      and (v_from_team in (team_a_id,team_b_id)
        or p_to_team_id in (team_a_id,team_b_id))
  ) then
    raise exception 'Cannot correct transfer while either team is playing'
      using errcode='22023';
  end if;
  select count(*) into v_available_count
  from public.tm_memberships m
  join public.tm_session_players sp on sp.id=m.session_player_id
  where m.rotation_id=p_rotation_id and m.team_id=v_from_team
    and sp.attendance in ('present','waiting');
  if v_available_count-1 < v_format then
    raise exception 'Correction would leave the source team short'
      using errcode='22023';
  end if;
  update public.tm_memberships set team_id=p_to_team_id
    where rotation_id=p_rotation_id and session_player_id=p_session_player_id;
  insert into public.tm_transfers(
    rotation_id,session_id,session_player_id,from_team_id,to_team_id,
    recorded_by
  ) values (
    p_rotation_id,v_session.id,p_session_player_id,
    v_from_team,p_to_team_id,auth.uid()
  );
  update public.tm_sessions set revision=revision+1 where id=v_session.id;
  insert into public.tm_action_audit(session_id,action,actor_user_id,details)
    values(v_session.id,'correct_transfer',auth.uid(),jsonb_build_object(
      'rotation_id',p_rotation_id,'player_id',p_session_player_id,
      'from_team_id',v_from_team,'to_team_id',p_to_team_id));
end $;

revoke execute on function public.tm_org_correct_transfer(uuid,uuid,uuid)
  from public,anon,authenticated;
grant execute on function public.tm_org_correct_transfer(uuid,uuid,uuid)
  to authenticated;

revoke execute on function public.tm_public_record_sub(uuid,uuid,uuid)
  from public,anon,authenticated;
revoke execute on function public.tm_public_cancel_sub(uuid,uuid)
  from public,anon,authenticated;
revoke execute on function public.tm_public_transfer(uuid,uuid,uuid)
  from public,anon,authenticated;
grant execute on function public.tm_public_record_sub(uuid,uuid,uuid)
  to anon,authenticated;
grant execute on function public.tm_public_cancel_sub(uuid,uuid)
  to anon,authenticated;
grant execute on function public.tm_public_transfer(uuid,uuid,uuid)
  to anon,authenticated;
