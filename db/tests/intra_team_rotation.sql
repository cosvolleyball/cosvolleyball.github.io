-- 25 present players may choose four teams (7,6,6,6) playing 6v6.
-- The seventh rotates inside their own team during the match and counts as
-- a regular appearance. The choice is per rotation, not a session default.
do $intra_team_contract$
declare
  v_session uuid;
  v_rotation uuid;
  v_revision bigint;
  v_payload jsonb := '[]'::jsonb;
  v_members jsonb;
  v_game uuid;
  v_team1 uuid;
  v_out uuid;
  v_in uuid;
  v_other_team uuid;
  v_i integer;
  v_size integer;
  v_snapshot jsonb;
begin
  if not has_function_privilege('anon',
    'public.tm_public_rotate_teammate(uuid,uuid,uuid)','execute')
    or has_table_privilege('anon','public.tm_game_appearances','select')
  then
    raise exception 'Within-team rotations have unsafe privileges';
  end if;
  perform set_config('request.jwt.claim.sub',
    '11111111-1111-4111-8111-111111111111',true);

  v_session:=public.tm_org_start_session(
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    4::smallint,true,false,true);
  for v_i in 1..25 loop
    perform public.tm_org_add_walkin(v_session,
      'Intra player '||v_i, 'intra-'||v_i||'@example.com');
  end loop;
  for v_i in 1..4 loop
    v_size:=case when v_i=1 then 7 else 6 end;
    select jsonb_agg(id order by id) into v_members from (
      select id from public.tm_session_players
        where session_id=v_session order by id limit v_size
        offset case when v_i=1 then 0 else 7+(v_i-2)*6 end
    ) q;
    v_payload:=v_payload||jsonb_build_array(
      jsonb_build_object('seed',v_i,'playerIds',v_members));
  end loop;
  select revision into v_revision from public.tm_sessions where id=v_session;
  v_rotation:=public.tm_org_save_draft(v_session,v_revision,
    jsonb_build_object('playing_format',6,'teams',v_payload));
  if (select playing_format from public.tm_rotations where id=v_rotation)<>6
    or (select format from public.tm_sessions where id=v_session)<>4 then
    raise exception 'Rotation format did not override session default';
  end if;
  select revision into v_revision from public.tm_sessions where id=v_session;
  v_rotation:=public.tm_org_publish_draft(v_session,v_revision);
  v_snapshot:=public.tm_public_snapshot();
  if (v_snapshot->>'format')::integer<>6
     or jsonb_array_length(v_snapshot->'teams')<>4 then
    raise exception 'Published 6v6 team format not displayed';
  end if;
  select id,team_a_id into v_game,v_team1
    from public.tm_games where rotation_id=v_rotation
    and round_number=1 and court=1;
  perform public.tm_public_start_game(v_game);

  select session_player_id into v_in from public.tm_memberships
    where rotation_id=v_rotation and team_id=v_team1
    and session_player_id not in (
      select session_player_id from public.tm_game_appearances
      where game_id=v_game
    ) limit 1;
  select session_player_id into v_out from public.tm_game_appearances
    where game_id=v_game and team_id=v_team1 and active_on_court limit 1;
  if v_in is null or v_out is null then
    raise exception 'Six-player lineup with a seventh waiting was not built';
  end if;
  select session_player_id into v_other_team from public.tm_game_appearances
    where game_id=v_game and team_id<>v_team1 limit 1;
  begin
    perform public.tm_public_rotate_teammate(v_game,v_out,v_other_team);
    raise exception 'Player moved to opposing team midgame';
  exception when sqlstate '22023' then null;
  end;
  perform public.tm_public_rotate_teammate(v_game,v_out,v_in);
  if (select count(*) from public.tm_game_appearances
      where game_id=v_game and team_id=v_team1)<>7
    or (select count(*) from public.tm_game_appearances
      where game_id=v_game and team_id=v_team1
      and active_on_court)<>6
    or exists(select 1 from public.tm_game_appearances
      where game_id=v_game and is_substitute)
  then
    raise exception 'All seven must be regular appearances, six active at once';
  end if;
  perform public.tm_public_rotate_teammate(v_game,v_in,v_out);
  if (select count(*) from public.tm_game_appearances
      where game_id=v_game and team_id=v_team1)<>7 then
    raise exception 'Re-entry double counted a regular appearance';
  end if;
  perform public.tm_public_report_winner(v_game,v_team1);
  if (select count(*) from public.tm_game_appearances
       where game_id=v_game and team_id=v_team1 and not is_substitute)<>7 then
    raise exception 'Seven-person teammate rotation lost an appearance';
  end if;
  -- After the first partial round robin, the SAME organizer may reshuffle
  -- all 25 check-ins into six teams: 5,4,4,4,4,4 playing 4v4.
  perform public.tm_org_end_rotation(v_rotation,true);
  v_payload:='[]'::jsonb;
  for v_i in 1..6 loop
    v_size:=case when v_i=1 then 5 else 4 end;
    select jsonb_agg(id order by id) into v_members from (
      select id from public.tm_session_players
        where session_id=v_session order by id limit v_size
          offset case when v_i=1 then 0 else 5+(v_i-2)*4 end
    ) q;
    v_payload:=v_payload||jsonb_build_array(
      jsonb_build_object('seed',v_i,'playerIds',v_members));
  end loop;
  select revision into v_revision from public.tm_sessions where id=v_session;
  perform public.tm_org_save_draft(v_session,v_revision,
    jsonb_build_object('playing_format',4,'teams',v_payload));
  select revision into v_revision from public.tm_sessions where id=v_session;
  v_rotation:=public.tm_org_publish_draft(v_session,v_revision);
  v_snapshot:=public.tm_public_snapshot();
  if (v_snapshot->>'format')::integer<>4
     or jsonb_array_length(v_snapshot->'teams')<>6
     or (select count(*) from public.tm_memberships
       where rotation_id=v_rotation)<>25 then
    raise exception 'Reshuffle to six 4v4 teams lost attendees';
  end if;
  select id into v_game from public.tm_games
    where rotation_id=v_rotation and round_number=1 and court=1;
  perform public.tm_public_start_game(v_game);
  if (select count(*) from public.tm_game_appearances
       where game_id=v_game and active_on_court)<>8 then
    raise exception 'Reshuffled 4v4 game must have eight on-court participants';
  end if;
  perform public.tm_org_end_session(v_session);
  raise notice '25-player session changed 4-team 6v6 to 6-team 4v4 successfully';
end $intra_team_contract$;
