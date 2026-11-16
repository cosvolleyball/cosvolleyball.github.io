-- Organizer can permanently replace departed players without resetting rotation.
do $roster_contract$
declare
  v_session uuid;
  v_rotation uuid;
  v_revision bigint;
  v_payload jsonb:='[]'::jsonb;
  v_members jsonb;
  v_out uuid;
  v_in uuid;
  v_other_out uuid;
  v_second_in uuid;
  v_team1 uuid;
  v_team2 uuid;
  v_game uuid;
  v_i int;
begin
  if has_function_privilege('anon',
    'public.tm_org_adjust_roster(uuid,uuid,uuid,uuid)','execute') then
    raise exception 'Anonymous users can change published team rosters';
  end if;
  perform set_config('request.jwt.claim.sub',
    '11111111-1111-4111-8111-111111111111',true);
  v_session:=public.tm_org_start_session(
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',6::smallint,
    true,false,false);
  for v_i in 1..36 loop
    perform public.tm_org_add_walkin(v_session,
      'Roster player '||v_i,
      'roster-'||v_i||'@example.com');
  end loop;
  for v_i in 1..6 loop
    select jsonb_agg(id order by id) into v_members from (
      select id from public.tm_session_players
        where session_id=v_session order by id
        limit 6 offset (v_i-1)*6
    ) q;
    v_payload:=v_payload||jsonb_build_array(
      jsonb_build_object('seed',v_i,'playerIds',v_members));
  end loop;
  select revision into v_revision from public.tm_sessions where id=v_session;
  perform public.tm_org_save_draft(v_session,v_revision,v_payload);
  select revision into v_revision from public.tm_sessions where id=v_session;
  v_rotation:=public.tm_org_publish_draft(v_session,v_revision);
  select id into v_team1 from public.tm_teams
    where rotation_id=v_rotation and seed=1;
  select id into v_team2 from public.tm_teams
    where rotation_id=v_rotation and seed=2;
  select session_player_id into v_out from public.tm_memberships
    where rotation_id=v_rotation and team_id=v_team1 limit 1;

  v_in:=public.tm_org_add_walkin(v_session,'Late arrival',
    'late-arrival@example.com');
  begin
    perform public.tm_org_adjust_roster(v_rotation,v_in,v_team1,null);
    raise exception 'Added unassigned player to already-full team';
  exception when sqlstate '22023' then null;
  end;
  perform public.tm_org_set_attendance(v_out,'departed');
  perform public.tm_org_adjust_roster(v_rotation,v_in,v_team1,v_out);

  if exists(select 1 from public.tm_memberships
    where rotation_id=v_rotation and session_player_id=v_out)
    or not exists(select 1 from public.tm_memberships
    where rotation_id=v_rotation and session_player_id=v_in
      and team_id=v_team1)
    or (select count(*) from public.tm_memberships where rotation_id=v_rotation
      and team_id=v_team1)<>6 then
    raise exception 'Late arrival did not fill departed roster spot';
  end if;

  -- Returning departed player is now unassigned and should be treated as
  -- a new arrival; cannot displace the replacement automatically.
  perform public.tm_org_set_attendance(v_out,'waiting');
  if exists(select 1 from public.tm_memberships
    where rotation_id=v_rotation and session_player_id=v_out) then
    raise exception 'Returning player displaced permanent replacement';
  end if;

  -- Team 2 is unavailable to edit during its live opening game.
  select session_player_id into v_other_out from public.tm_memberships
    where rotation_id=v_rotation and team_id=v_team2 limit 1;
  perform public.tm_org_set_attendance(v_other_out,'break');
  v_second_in:=public.tm_org_add_walkin(v_session,
    'Second late arrival','second-late@example.com');
  select id into v_game from public.tm_games
    where rotation_id=v_rotation and round_number=1 and court=1;
  perform public.tm_public_start_game(v_game);
  begin
    perform public.tm_org_adjust_roster(
      v_rotation,v_second_in,v_team2,v_other_out);
    raise exception 'Live game roster was altered';
  exception when sqlstate '22023' then null;
  end;
  perform public.tm_org_end_session(v_session);
  raise notice 'Late arrival and permanent replacement contracts passed';
end $roster_contract$;
