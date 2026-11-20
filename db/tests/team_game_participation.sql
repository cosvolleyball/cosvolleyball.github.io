-- Run against the complete migration chain on the disposable release database.
begin;
do $test$
declare
  v_session uuid;
  v_rotation uuid;
  game public.tm_games%rowtype;
  teams jsonb := '[]';
  members jsonb;
  rev bigint;
  bench_player uuid;
  volunteer uuid;
  alternate uuid;
  regular uuid;
  i integer;
begin
  perform set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
  v_session := public.tm_org_start_session('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',6::smallint);
  for i in 1..37 loop
    perform public.tm_org_add_walkin(v_session,'Player '||i,'team-'||i||'@example.invalid');
  end loop;
  -- Seed one has seven, the other five teams have six apiece.
  for i in 1..6 loop
    select jsonb_agg(p.id order by p.id) into members from (
      select sp.id from public.tm_session_players sp where sp.session_id=v_session
      order by sp.id limit case when i=1 then 7 else 6 end
      offset case when i=1 then 0 else 7+(i-2)*6 end
    ) p;
    teams := teams||jsonb_build_array(jsonb_build_object('seed',i,'playerIds',members));
  end loop;
  select s.revision into rev from public.tm_sessions s where s.id=v_session;
  perform public.tm_org_save_draft(v_session,rev,teams);
  select s.revision into rev from public.tm_sessions s where s.id=v_session;
  v_rotation := public.tm_org_publish_draft(v_session,rev);
  select g.* into strict game from public.tm_games g where g.rotation_id=v_rotation and g.court=1 and g.round_number=1;
  select m.session_player_id into regular from public.tm_memberships m where m.team_id=game.team_a_id limit 1;
  select m.session_player_id into bench_player from public.tm_memberships m where m.team_id=game.team_b_id limit 1;
  select m.session_player_id into volunteer from public.tm_memberships m join public.tm_teams t on t.id=m.team_id
    where t.rotation_id=v_rotation and t.seed=3 order by m.session_player_id limit 1;
  select m.session_player_id into alternate from public.tm_memberships m join public.tm_teams t on t.id=m.team_id
    where t.rotation_id=v_rotation and t.seed=3 and m.session_player_id<>volunteer limit 1;

  perform public.tm_org_set_attendance(bench_player,'break');
  perform public.tm_public_record_sub(game.id,volunteer,game.team_b_id);
  perform public.tm_org_set_attendance(volunteer,'break');
  begin
    perform public.tm_public_start_game(game.id);
    raise exception 'Unavailable planned substitute accepted';
  exception when sqlstate '22023' then null;
  end;
  if exists(select 1 from public.tm_game_appearances a where a.game_id=game.id) then
    raise exception 'Rejected start saved a partial team';
  end if;
  perform public.tm_org_set_attendance(volunteer,'present');
  perform public.tm_public_start_game(game.id);
  if (select count(*) from public.tm_game_appearances a where a.game_id=game.id and a.team_id=game.team_a_id and not a.is_substitute)<>7
    or (select count(*) from public.tm_game_appearances a where a.game_id=game.id)<>13
    or not exists(select 1 from public.tm_game_appearances a where a.game_id=game.id and a.session_player_id=volunteer and a.is_substitute)
    or exists(select 1 from public.tm_game_appearances a where a.game_id=game.id and a.session_player_id=bench_player) then
    raise exception 'Wrong participants recorded at game start';
  end if;
  if public.tm_public_game_lineup(game.id)<>'[]'::jsonb or public.tm_org_game_appearances(game.id)<>'[]'::jsonb then
    raise exception 'In-game individual lineup returned';
  end if;
  begin
    perform public.tm_public_rotate_teammate(game.id,regular,alternate);
    raise exception 'In-game teammate rotation accepted';
  exception when sqlstate '55000' then null;
  end;
  begin
    perform public.tm_public_emergency_sub(game.id,regular,alternate);
    raise exception 'In-game substitute accepted';
  exception when sqlstate '55000' then null;
  end;
  begin
    perform public.tm_org_correct_appearance(game.id,volunteer,alternate);
    raise exception 'Live appearance correction accepted';
  exception when sqlstate '22023' then null;
  end;
  perform public.tm_public_report_winner(game.id,game.team_a_id);
  if (select count(*) from jsonb_array_elements(public.tm_org_stats(v_session)) p
      where (p->>'wins')::int=1 and (p->>'regular_games')::int=1)<>7 then
    raise exception 'A winning team member missed game or win credit';
  end if;
  perform public.tm_org_correct_appearance(game.id,volunteer,alternate);
  if not exists(select 1 from public.tm_game_appearances a where a.game_id=game.id and a.session_player_id=alternate and a.is_substitute)
    or exists(select 1 from public.tm_game_appearances a where a.game_id=game.id and a.session_player_id=volunteer) then
    raise exception 'Completed-game substitute correction failed';
  end if;
end $test$;
rollback;
