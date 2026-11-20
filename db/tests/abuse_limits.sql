-- Guards against anonymous write spam without requiring player logins.
-- Local/ephemeral Postgres only; never apply fixture audit writes to hosted DB.
do $abuse_contract$
declare
  v_prior uuid;
  v_session uuid;
  v_rotation uuid;
  v_revision bigint;
  v_game uuid;
  v_teams jsonb:='[]'::jsonb;
  v_members jsonb;
  v_i integer;
begin
  if has_schema_privilege('anon','tm_internal','usage')
     or has_function_privilege(
       'anon','tm_internal.guard_public_action_rate()','execute') then
    raise exception 'Anonymous caller can use internal public-rate function';
  end if;
  perform set_config('request.jwt.claim.sub',
    '11111111-1111-4111-8111-111111111111',true);
  select session_id into v_prior from public.tm_test_transfer_keys limit 1;
  if v_prior is not null and exists(
    select 1 from public.tm_sessions
    where id=v_prior and status='active'
  ) then
    perform public.tm_org_end_session(v_prior);
  end if;

  v_session:=public.tm_org_start_session(
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',4::smallint,
    true,false,false);
  for v_i in 1..120 loop
    insert into public.tm_action_audit(session_id,action,details)
    values (v_session,'record_sub',
      jsonb_build_object('game_id',gen_random_uuid()));
  end loop;
  begin
    insert into public.tm_action_audit(session_id,action,details)
      values(v_session,'record_sub',jsonb_build_object(
        'game_id',gen_random_uuid()));
    raise exception 'Session-wide anonymous burst limit failed';
  exception when sqlstate '22023' then null;
  end;
  if (select count(*) from public.tm_action_audit
      where session_id=v_session and action='record_sub')<>120 then
    raise exception 'Rejected rate-limited action was recorded';
  end if;
  -- Other administrative operations must never be blocked by public spam.
  perform public.tm_org_end_session(v_session);

  v_session:=public.tm_org_start_session(
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',4::smallint,
    true,false,false);
  for v_i in 1..40 loop
    insert into public.tm_action_audit(session_id,action,details)
      values (v_session,'cancel_sub',
        jsonb_build_object('game_id',
          'cccccccc-cccc-4ccc-8ccc-cccccccccccc'));
  end loop;
  begin
    insert into public.tm_action_audit(session_id,action,details)
      values(v_session,'cancel_sub',
        jsonb_build_object('game_id',
          'cccccccc-cccc-4ccc-8ccc-cccccccccccc'));
    raise exception 'Per-game burst limit failed';
  exception when sqlstate '22023' then null;
  end;
  if (select count(*) from public.tm_action_audit
      where session_id=v_session and action='cancel_sub')<>40 then
    raise exception 'Rejected per-game write was recorded';
  end if;
  perform public.tm_org_end_session(v_session);

  -- Force a real game-start RPC into the rate cap and prove the entire
  -- transaction rolls back: no started game, appearances or revision.
  v_session:=public.tm_org_start_session(
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',4::smallint,
    true,false,false);
  for v_i in 1..16 loop
    perform public.tm_org_add_walkin(v_session,'Abuse test '||v_i,
      'abuse-'||v_i||'@example.invalid');
  end loop;
  for v_i in 1..4 loop
    select jsonb_agg(id order by id) into v_members from (
      select id from public.tm_session_players where session_id=v_session
      order by id limit 4 offset (v_i-1)*4
    ) p;
    v_teams:=v_teams||jsonb_build_array(jsonb_build_object(
      'seed',v_i,'playerIds',v_members));
  end loop;
  select revision into v_revision from public.tm_sessions where id=v_session;
  perform public.tm_org_save_draft(v_session,v_revision,v_teams);
  select revision into v_revision from public.tm_sessions where id=v_session;
  v_rotation:=public.tm_org_publish_draft(v_session,v_revision);
  select id into v_game from public.tm_games
    where rotation_id=v_rotation and court=1 and round_number=1;
  for v_i in 1..120 loop
    insert into public.tm_action_audit(session_id,action,details)
      values(v_session,'record_sub',
        jsonb_build_object('game_id',gen_random_uuid()));
  end loop;
  select revision into v_revision from public.tm_sessions where id=v_session;
  begin
    perform public.tm_public_start_game(v_game);
    raise exception 'Rate-limited public RPC unexpectedly started the game';
  exception when sqlstate '22023' then null;
  end;
  if (select status from public.tm_games where id=v_game)<>'ready'
     or (select count(*) from public.tm_game_appearances
         where game_id=v_game)<>0
     or (select revision from public.tm_sessions
         where id=v_session)<>v_revision then
    raise exception 'Rate-limited public RPC left partial game changes';
  end if;
  -- Advance only synthetic audit timestamps, rather than sleep a minute.
  -- Legitimate public actions must recover automatically once the window expires.
  update public.tm_action_audit set recorded_at=clock_timestamp()-interval '61 seconds'
    where session_id=v_session and action='record_sub';
  perform public.tm_public_start_game(v_game);
  if (select status from public.tm_games where id=v_game)<>'playing' then
    raise exception 'Public action did not recover after the rate window expired';
  end if;
  perform public.tm_org_end_session(v_session);
  raise notice 'Anonymous burst limits, atomic rollback and recovery passed';
end $abuse_contract$;
