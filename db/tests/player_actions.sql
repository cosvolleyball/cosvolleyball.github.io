-- Six-team one-game substitutes, five-team rotation-long transfers.
-- Isolated PostgreSQL 17 fixture only, no production DB.
do $player_actions$
declare
  v_session uuid;
  v_rotation uuid;
  v_revision bigint;
  v_payload jsonb;
  v_members jsonb;
  v_game uuid;
  v_next_game uuid;
  v_team1 uuid;
  v_team2 uuid;
  v_team3 uuid;
  v_team6 uuid;
  v_sub uuid;
  v_other uuid;
  v_target_bench uuid;
  v_index integer;
  v_size integer;
begin
  if not has_function_privilege('anon','public.tm_public_record_sub(uuid,uuid,uuid)','execute')
     or not has_function_privilege('anon','public.tm_public_cancel_sub(uuid,uuid)','execute')
     or not has_function_privilege('anon','public.tm_public_transfer(uuid,uuid,uuid)','execute')
     or has_table_privilege('anon','public.tm_transfers','select')
     or has_table_privilege('anon','public.tm_game_subs','select')
  then
    raise exception 'Sub/transfer privilege check failed';
  end if;
  perform set_config('request.jwt.claim.sub',
    '11111111-1111-4111-8111-111111111111',true);

  -- Six-team case: Team 1 has five; resting Team 3 can loan one player.
  v_session:=public.tm_org_start_session(
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',6::smallint,true,false,false);
  for v_index in 1..35 loop
    perform public.tm_org_add_walkin(v_session,'Player '||v_index,
      'sub-'||v_index||'@example.com');
  end loop;
  v_payload:='[]'::jsonb;
  for v_index in 1..6 loop
    v_size:=case when v_index=1 then 5 else 6 end;
    select jsonb_agg(id order by id) into v_members from
      (select id from public.tm_session_players
       where session_id=v_session order by id limit v_size
       offset case when v_index=1 then 0 else 5+(v_index-2)*6 end) q;
    v_payload:=v_payload||jsonb_build_array(
      jsonb_build_object('seed',v_index,'playerIds',v_members));
  end loop;
  select revision into v_revision from public.tm_sessions where id=v_session;
  perform public.tm_org_save_draft(v_session,v_revision,v_payload);
  select revision into v_revision from public.tm_sessions where id=v_session;
  v_rotation:=public.tm_org_publish_draft(v_session,v_revision);
  select id into v_game from public.tm_games
    where rotation_id=v_rotation and round_number=1 and court=1;
  select id into v_team1 from public.tm_teams
    where rotation_id=v_rotation and seed=1;
  select id into v_team2 from public.tm_teams
    where rotation_id=v_rotation and seed=2;
  select id into v_team3 from public.tm_teams
    where rotation_id=v_rotation and seed=3;
  select id into v_team6 from public.tm_teams
    where rotation_id=v_rotation and seed=6;
  select session_player_id into v_sub from public.tm_memberships
    where rotation_id=v_rotation and team_id=v_team3 limit 1;
  select session_player_id into v_other from public.tm_memberships
    where rotation_id=v_rotation and team_id=v_team6 limit 1;

  begin
    perform public.tm_public_record_sub(v_game,v_other,v_team1);
    raise exception 'Cross-court substitute was accepted';
  exception when sqlstate '22023' then null;
  end;
  begin
    perform public.tm_public_record_sub(v_game,v_sub,v_team2);
    raise exception 'Substitute assigned to a full team';
  exception when sqlstate '22023' then null;
  end;
  perform public.tm_public_record_sub(v_game,v_sub,v_team1);
  if jsonb_array_length(public.tm_public_game_subs(v_game))<>1 then
    raise exception 'Public pregame sub display failed';
  end if;
  begin
    perform public.tm_public_record_sub(v_game,v_sub,v_team1);
    raise exception 'Duplicate substitute assignment accepted';
  exception when sqlstate '22023' then null;
             when unique_violation then null;
  end;
  perform public.tm_public_cancel_sub(v_game,v_sub);
  if jsonb_array_length(public.tm_public_game_subs(v_game))<>0 then
    raise exception 'Public pregame cancellation failed';
  end if;
  perform public.tm_public_record_sub(v_game,v_sub,v_team1);
  perform public.tm_public_start_game(v_game);
  if (select count(*) from public.tm_game_appearances
      where game_id=v_game)<>12
     or (select count(*) from public.tm_game_appearances
      where game_id=v_game and is_substitute)<>1 then
    raise exception 'Full lineup did not include designated sub';
  end if;
  begin
    perform public.tm_public_cancel_sub(v_game,v_sub);
    raise exception 'Sub cancellation after game start was allowed';
  exception when sqlstate '22023' then null;
  end;
  perform public.tm_public_report_winner(v_game,v_team1);
  if (select count(*) from public.tm_game_appearances a
      join public.tm_games g on g.id=a.game_id
      where a.session_player_id=v_sub
        and a.is_substitute and g.status='completed')<>1 then
    raise exception 'Substitute was not counted separately';
  end if;
  begin
    perform public.tm_public_transfer(v_rotation,v_sub,v_team1);
    raise exception 'Six-team rotation permitted a permanent transfer';
  exception when sqlstate '22023' then null;
  end;

  -- Team 1 originally won and needs another substitute for its next match.
  -- Correcting the opening winner makes Team 2 play instead. Its own
  -- player cannot remain borrowed as Team 1's planned substitute.
  select id into v_next_game from public.tm_games
    where rotation_id=v_rotation and court=1 and round_number=2;
  select session_player_id into v_other from public.tm_memberships
    where rotation_id=v_rotation and team_id=v_team2 limit 1;
  perform public.tm_public_record_sub(v_next_game,v_other,v_team1);
  if jsonb_array_length(public.tm_public_game_subs(v_next_game))<>1 then
    raise exception 'Expected an accepted next-game substitute';
  end if;
  perform public.tm_org_correct_winner(v_game,v_team2);
  if jsonb_array_length(public.tm_public_game_subs(v_next_game))<>0
     or (select team_a_id from public.tm_games
          where id=v_next_game)<>v_team2 then
    raise exception 'Winner correction left an unsafe planned substitute';
  end if;
  perform public.tm_org_end_session(v_session);

  -- Five-team case: transfer a surplus player from six-player roster.
  v_session:=public.tm_org_start_session(
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',5::smallint,true,false,false);
  for v_index in 1..26 loop
    perform public.tm_org_add_walkin(v_session,'Transfer player '||v_index,
      'move-'||v_index||'@example.com');
  end loop;
  v_payload:='[]'::jsonb;
  for v_index in 1..5 loop
    v_size:=case when v_index=1 then 6 else 5 end;
    select jsonb_agg(id order by id) into v_members from
      (select id from public.tm_session_players
        where session_id=v_session order by id limit v_size
        offset case when v_index=1 then 0 else 6+(v_index-2)*5 end) q;
    v_payload:=v_payload||jsonb_build_array(
      jsonb_build_object('seed',v_index,'playerIds',v_members));
  end loop;
  select revision into v_revision from public.tm_sessions where id=v_session;
  perform public.tm_org_save_draft(v_session,v_revision,v_payload);
  select revision into v_revision from public.tm_sessions where id=v_session;
  v_rotation:=public.tm_org_publish_draft(v_session,v_revision);
  select id into v_team1 from public.tm_teams
    where rotation_id=v_rotation and seed=1;
  select id into v_team2 from public.tm_teams
    where rotation_id=v_rotation and seed=2;
  select session_player_id into v_sub from public.tm_memberships
    where rotation_id=v_rotation and team_id=v_team1 limit 1;
  select session_player_id into v_other from public.tm_memberships
    where rotation_id=v_rotation and team_id=v_team1
      and session_player_id<>v_sub limit 1;
  select id into v_game from public.tm_games
    where rotation_id=v_rotation and round_number=1 and court=1;

  perform public.tm_public_transfer(v_rotation,v_sub,v_team2);
  if (select team_id from public.tm_memberships where rotation_id=v_rotation
      and session_player_id=v_sub)<>v_team2
      or (select count(*) from public.tm_transfers
       where rotation_id=v_rotation and session_player_id=v_sub)<>1 then
    raise exception 'Five-team permanent transfer was not recorded';
  end if;
  begin
    perform public.tm_public_transfer(v_rotation,v_other,v_team2);
    raise exception 'Transfer allowed source roster below format';
  exception when sqlstate '22023' then null;
  end;
  begin
    perform public.tm_public_record_sub(v_game,v_other,v_team2);
    raise exception 'Five-team temporary substitute was accepted';
  exception when sqlstate '22023' then null;
  end;
  -- Team 2 has an extra roster member; give them a break so the
  -- transferred player is guaranteed to appear in this actual lineup.
  select session_player_id into v_target_bench
  from public.tm_memberships
  where rotation_id=v_rotation and team_id=v_team2
    and session_player_id<>v_sub limit 1;
  perform public.tm_org_set_attendance(v_target_bench,'break');
  perform public.tm_public_start_game(v_game);
  begin
    perform public.tm_public_transfer(v_rotation,v_sub,v_team1);
    raise exception 'Player transferred back during live game';
  exception when sqlstate '22023' then null;
  end;
  perform public.tm_public_report_winner(v_game,v_team2);
  -- Completing a game frees both teams for between-game transfers,
  -- but it never rewrites the actual prior appearance team.
  if not exists(
    select 1 from public.tm_game_appearances
    where game_id=v_game and session_player_id=v_sub and team_id=v_team2
      and not is_substitute
  ) then
    raise exception 'Transfer participant was not counted on new team';
  end if;
  perform public.tm_org_end_session(v_session);
  raise notice 'Six-team substitutes and five-team transfers passed';
end $player_actions$;
