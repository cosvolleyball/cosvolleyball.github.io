-- Emergency on-court six-team sub and organizer correction tests.
do $emergency_contract$
declare
  v_session uuid;
  v_rotation uuid;
  v_revision bigint;
  v_payload jsonb:='[]'::jsonb;
  v_members jsonb;
  v_game uuid;
  v_team1 uuid;
  v_team3 uuid;
  v_out uuid;
  v_in uuid;
  v_correct uuid;
  v_i int;
begin
  if not has_function_privilege('anon',
        'public.tm_public_emergency_sub(uuid,uuid,uuid)','execute')
    or has_function_privilege('anon',
        'public.tm_org_correct_appearance(uuid,uuid,uuid)','execute')
    or not has_function_privilege('anon',
        'public.tm_public_game_lineup(uuid)','execute')
    or has_function_privilege('anon',
        'public.tm_org_game_appearances(uuid)','execute') then
    raise exception 'Emergency RPC permissions are unsafe';
  end if;
  perform set_config('request.jwt.claim.sub',
    '11111111-1111-4111-8111-111111111111',true);
  v_session:=public.tm_org_start_session(
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',6::smallint,
    true,false,false);
  for v_i in 1..36 loop
    perform public.tm_org_add_walkin(v_session,'Emergency player '||v_i,
      'injury-'||v_i||'@example.com');
  end loop;
  for v_i in 1..6 loop
    select jsonb_agg(id order by id) into v_members from(
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
  select id into v_game from public.tm_games
    where rotation_id=v_rotation and round_number=1 and court=1;
  select id into v_team1 from public.tm_teams
    where rotation_id=v_rotation and seed=1;
  select id into v_team3 from public.tm_teams
    where rotation_id=v_rotation and seed=3;
  select session_player_id into v_out from public.tm_memberships
    where rotation_id=v_rotation and team_id=v_team1 limit 1;
  select session_player_id into v_in from public.tm_memberships
    where rotation_id=v_rotation and team_id=v_team3 limit 1;
  select session_player_id into v_correct from public.tm_memberships
    where rotation_id=v_rotation and team_id=v_team3
      and session_player_id<>v_in limit 1;

  perform public.tm_public_start_game(v_game);
  if jsonb_array_length(public.tm_public_game_lineup(v_game))<>12 then
    raise exception 'Initial six-team court lineup must contain 12';
  end if;
  perform public.tm_public_emergency_sub(v_game,v_out,v_in);
  if (select count(*) from public.tm_game_appearances
    where game_id=v_game)<>13
    or (select count(*) from public.tm_game_appearances
      where game_id=v_game and active_on_court)<>12
    or (select count(*) from public.tm_game_appearances
      where game_id=v_game and is_substitute)<>1 then
    raise exception 'Emergency replaced player did not preserve appearance';
  end if;
  begin
    perform public.tm_public_emergency_sub(v_game,v_out,v_correct);
    raise exception 'Already replaced player was allowed to leave again';
  exception when sqlstate '22023' then null;
  end;
  begin
    perform public.tm_public_emergency_sub(v_game,v_in,v_out);
    raise exception 'Outgoing player was reused as resting-team substitute';
  exception when sqlstate '22023' then null;
  end;
  perform public.tm_public_report_winner(v_game,v_team1);
  if jsonb_array_length(public.tm_org_game_appearances(v_game))<>13 then
    raise exception 'Organizer correction should see all 13 real participants';
  end if;
  if (select count(*) from public.tm_game_appearances
    where game_id=v_game and session_player_id=v_out
      and not active_on_court)<>1 then
    raise exception 'Departed injured player lost historical appearance';
  end if;
  perform public.tm_org_correct_appearance(v_game,v_in,v_correct);
  if exists(select 1 from public.tm_game_appearances
       where game_id=v_game and session_player_id=v_in)
     or not exists(select 1 from public.tm_game_appearances
       where game_id=v_game and session_player_id=v_correct
         and is_substitute)
  then
    raise exception 'Organizer could not correct a wrong substitute';
  end if;
  if public.tm_public_game_lineup(v_game)::text like '%@example.com%' then
    raise exception 'Public game lineup leaked player email';
  end if;
  perform public.tm_org_end_session(v_session);
  raise notice 'Emergency and organizer appearance correction tests passed';
end $emergency_contract$;
