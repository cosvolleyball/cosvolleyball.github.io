-- The anonymous live signal contains only revision and active flag.
-- All private player profile/game data is still read through separate RPCs.
do $realtime_contract$
declare
  v_session uuid;
  v_player uuid;
  v_before bigint;
  v_after bigint;
  v_last jsonb;
begin
  if has_schema_privilege('anon','tm_internal','usage')
     or has_function_privilege(
        'anon','tm_internal.notify_public_session_change()','execute')
  then
    raise exception 'Internal realtime trigger function is public';
  end if;
  perform set_config('request.jwt.claim.sub',
    '11111111-1111-4111-8111-111111111111',true);
  select count(*) into v_before from realtime.tm_test_broadcast;
  v_session := public.tm_org_start_session(
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',6::smallint,
    true,false,false);
  if (select count(*) from realtime.tm_test_broadcast) <> v_before+1 then
    raise exception 'New active session did not notify viewers';
  end if;
  v_last := (select payload from realtime.tm_test_broadcast
    order by id desc limit 1);
  if v_last ? 'event_title' or v_last ? 'email'
     or v_last ? 'players' or v_last ? 'session_id'
     or v_last->>'active' <> 'true' or (v_last->>'revision')::int<>1
  then
    raise exception 'Unsafe new-session realtime signal: %',v_last;
  end if;
  v_player := public.tm_org_add_walkin(
    v_session,'Private Player','private-address@example.com');
  if (select count(*) from realtime.tm_test_broadcast)<>v_before+2 then
    raise exception 'Walk-in did not send one revision signal';
  end if;
  perform public.tm_org_set_attendance(v_player,'break');
  if (select count(*) from realtime.tm_test_broadcast)<>v_before+3 then
    raise exception 'Attendance change did not notify viewers';
  end if;
  -- An update unrelated to revision or status does not broadcast.
  update public.tm_sessions set team_count=4 where id=v_session;
  if (select count(*) from realtime.tm_test_broadcast)<>v_before+3 then
    raise exception 'Unrelated session update published extra signal';
  end if;
  perform public.tm_org_end_session(v_session);
  if (select count(*) from realtime.tm_test_broadcast)<>v_before+4 then
    raise exception 'Closing a session did not notify viewers';
  end if;
  if (select payload->>'active' from realtime.tm_test_broadcast
      order by id desc limit 1)<>'false' then
    raise exception 'Closed session did not emit inactive signal';
  end if;
  if exists(
    select 1 from realtime.tm_test_broadcast
    where event<>'changed'
       or topic<>'teams-manager:public' or is_private
       or payload::text like '%private-address%'
       or payload::text like '%@%'
       or (select count(*) from jsonb_object_keys(payload)) <> 2
  ) then
    raise exception 'Public Broadcast leaked data or unexpected fields';
  end if;
  raise notice 'Public realtime invalidation privacy contracts passed';
end $realtime_contract$;
