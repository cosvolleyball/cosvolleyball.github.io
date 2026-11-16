-- Run after db/tests/contracts.sql, rotations.sql, and part3 match operations.
-- Validates actual start/report/correction behavior across all 4/5/6 team formats.
do $game_contract$
declare
  v_session uuid;
  v_rotation uuid;
  v_revision bigint;
  v_roster_count int;
  v_team_count int;
  v_format smallint;
  v_payload jsonb;
  v_members jsonb;
  v_game1 uuid;
  v_game2 uuid;
  v_game3 uuid;
  v_game4 uuid;
  v_game5 uuid;
  v_game6 uuid;
  v_a uuid;
  v_b uuid;
  v_a2 uuid;
  v_b2 uuid;
  v_first uuid;
  v_index int;
  v_wins int;
  v_min int;
  v_max int;
begin
  if not has_function_privilege('anon','public.tm_public_start_game(uuid)','execute')
     or not has_function_privilege('anon','public.tm_public_report_winner(uuid,uuid)','execute')
     or has_function_privilege('anon','public.tm_org_correct_winner(uuid,uuid)','execute')
     or has_schema_privilege('anon','tm_internal','usage')
     or has_table_privilege('anon','public.tm_game_subs','select')
  then
    raise exception 'Unsafe public match permissions';
  end if;
  perform set_config('request.jwt.claim.sub',
    '11111111-1111-4111-8111-111111111111',true);

  for v_team_count in 4..6 loop
    v_format := case when v_team_count=4 then 4::smallint
                     when v_team_count=5 then 5::smallint
                     else 6::smallint end;
    v_roster_count:=case when v_team_count=4 then 24
      else v_team_count*v_format end;
    v_session := public.tm_org_start_session(
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',v_format,
      true,false,false);
    for v_index in 1..v_roster_count loop
      perform public.tm_org_add_walkin(v_session,
        'Test player '||v_index,
        'game-'||v_team_count||'-'||v_index||'@example.com');
    end loop;
    v_payload := '[]'::jsonb;
    for v_index in 1..v_team_count loop
      select jsonb_agg(id order by id) into v_members
      from (
        select id from public.tm_session_players
        where session_id=v_session order by id
        limit (v_roster_count/v_team_count)
        offset (v_index-1)*(v_roster_count/v_team_count)
      ) q;
      v_payload := v_payload || jsonb_build_array(
        jsonb_build_object('seed',v_index,'playerIds',v_members)
      );
    end loop;
    select revision into v_revision from public.tm_sessions
      where id=v_session;
    perform public.tm_org_save_draft(v_session,v_revision,v_payload);
    select revision into v_revision from public.tm_sessions
      where id=v_session;
    v_rotation := public.tm_org_publish_draft(v_session,v_revision);

    select id,team_a_id,team_b_id into v_game1,v_a,v_b
      from public.tm_games where rotation_id=v_rotation
        and round_number=1 and court=1;
    select id,team_a_id,team_b_id into v_game2,v_a2,v_b2
      from public.tm_games where rotation_id=v_rotation
        and round_number=1 and court=2;
    select id into v_game3 from public.tm_games
      where rotation_id=v_rotation and round_number=2 and court=1;
    select id into v_game4 from public.tm_games
      where rotation_id=v_rotation and round_number=2 and court=2;
    select id into v_game5 from public.tm_games
      where rotation_id=v_rotation and round_number=3 and court=1;
    select id into v_game6 from public.tm_games
      where rotation_id=v_rotation and round_number=3 and court=2;

    -- Cannot start a game with unresolved participants or prerequisites.
    begin
      perform public.tm_public_start_game(v_game3);
      raise exception 'Started second round before opening results';
    exception when sqlstate '22023' then null;
    end;

    perform public.tm_public_start_game(v_game1);
    if (select count(*) from public.tm_game_appearances
        where game_id=v_game1)<>v_format*2 then
      raise exception 'Expected two correct-size lineups on opening game';
    end if;
    begin
      perform public.tm_public_start_game(v_game1);
      raise exception 'First-start-wins guard failed';
    exception when sqlstate '22023' then null;
    end;
    perform public.tm_public_report_winner(v_game1,v_a);
    begin
      perform public.tm_public_report_winner(v_game1,v_b);
      raise exception 'Result overwrite unexpectedly accepted';
    exception when sqlstate '22023' then null;
    end;
    if (select winner_team_id from public.tm_games where id=v_game1)<>v_a then
      raise exception 'Second result overwrote the first';
    end if;

    if v_team_count=4 then
      -- Four-team full round robin: other court's first round must finish
      -- before either second-round match can start.
      begin
        perform public.tm_public_start_game(v_game3);
        raise exception '4-team round-robin advanced before opponent available';
      exception when sqlstate '22023' then null;
      end;
      perform public.tm_public_start_game(v_game2);
      perform public.tm_public_report_winner(v_game2,v_a2);
      perform public.tm_public_start_game(v_game3);
      perform public.tm_public_start_game(v_game4);
      select team_a_id into v_first from public.tm_games where id=v_game3;
      perform public.tm_public_report_winner(v_game3,v_first);
      select team_a_id into v_first from public.tm_games where id=v_game4;
      perform public.tm_public_report_winner(v_game4,v_first);
      perform public.tm_public_start_game(v_game5);
      perform public.tm_public_start_game(v_game6);
      select team_a_id into v_first from public.tm_games where id=v_game5;
      perform public.tm_public_report_winner(v_game5,v_first);
      select team_a_id into v_first from public.tm_games where id=v_game6;
      perform public.tm_public_report_winner(v_game6,v_first);
      if (select status from public.tm_rotations where id=v_rotation)
          <> 'completed' then
        raise exception 'Full six-game rotation not auto-completed';
      end if;
      select min(c),max(c) into v_min,v_max from (
        select count(*) c from public.tm_game_appearances a
        join public.tm_games g on g.id=a.game_id
        where a.session_id=v_session and g.status='completed'
        group by a.session_player_id
      ) x;
      if v_min<>2 or v_max<>2 then
        raise exception '4v4 roster rotation should give 2 actual games per player, got %..%',v_min,v_max;
      end if;
    elsif v_team_count=6 then
      -- Six-team courts advance independently.
      if (select status from public.tm_games where id=v_game3)<>'ready' then
        raise exception 'Court 1 should advance without Court 2';
      end if;
      -- Correct result before dependent game has started.
      perform public.tm_org_correct_winner(v_game1,v_b);
      if (select team_a_id from public.tm_games where id=v_game3)<>v_b then
        raise exception 'Corrected opener did not rewire next match';
      end if;
      perform public.tm_public_start_game(v_game3);
      begin
        perform public.tm_org_correct_winner(v_game1,v_a);
        raise exception 'Correction incorrectly allowed after dependent started';
      exception when sqlstate '22023' then null;
      end;
      select team_a_id into v_first from public.tm_games where id=v_game3;
      perform public.tm_public_report_winner(v_game3,v_first);
      perform public.tm_public_start_game(v_game5);
      select team_a_id into v_first from public.tm_games where id=v_game5;
      perform public.tm_public_report_winner(v_game5,v_first);
      perform public.tm_public_start_game(v_game2);
      perform public.tm_public_report_winner(v_game2,v_a2);
      if (select status from public.tm_games where id=v_game4)<>'ready' then
        raise exception 'Court 2 did not advance independently';
      end if;
      perform public.tm_org_end_rotation(v_rotation,true);
    else
      -- Five teams: second-round Court 2 depends on BOTH opening results.
      if (select status from public.tm_games where id=v_game4)='ready' then
        raise exception 'Five-team dependency missed other opening result';
      end if;
      perform public.tm_public_start_game(v_game3);
      select team_a_id into v_first from public.tm_games where id=v_game3;
      perform public.tm_public_report_winner(v_game3,v_first);
      perform public.tm_public_start_game(v_game2);
      perform public.tm_public_report_winner(v_game2,v_a2);
      if (select status from public.tm_games where id=v_game4)<>'ready'
        or (select status from public.tm_games where id=v_game5)<>'ready'
      then
        raise exception 'Five-team slots did not resolve both opening results';
      end if;
      -- These are DISJOINT teams: Court 1 round 3 may run concurrently
      -- with Court 2 round 2.
      perform public.tm_public_start_game(v_game4);
      perform public.tm_public_start_game(v_game5);
      begin
        perform public.tm_org_correct_winner(v_game1,v_b);
        raise exception 'Correction allowed after a dependent 5-team game began';
      exception when sqlstate '22023' then null;
      end;
      select team_a_id into v_first from public.tm_games where id=v_game4;
      perform public.tm_public_report_winner(v_game4,v_first);
      select team_a_id into v_first from public.tm_games where id=v_game5;
      perform public.tm_public_report_winner(v_game5,v_first);
      perform public.tm_public_start_game(v_game6);
      select team_a_id into v_first from public.tm_games where id=v_game6;
      perform public.tm_public_report_winner(v_game6,v_first);
      if (select status from public.tm_rotations where id=v_rotation)
        <> 'completed' then
        raise exception 'Five-team full rotation failed to complete';
      end if;
    end if;

    if public.tm_public_snapshot()::text like '%@example.com%' then
      raise exception 'Public snapshot leaked player emails';
    end if;
    perform public.tm_org_end_session(v_session);
  end loop;
  raise notice 'Match start/winner/correction dependency contracts passed for 4,5,6 teams';
end $game_contract$;
