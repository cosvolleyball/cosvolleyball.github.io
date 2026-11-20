-- Verify teammate history is organizer-only and actual-game based.
do $history_contract$
declare
  v_session uuid;
  v_rotation uuid;
  v_revision bigint;
  v_payload jsonb := '[]'::jsonb;
  v_members jsonb;
  v_game uuid;
  v_team uuid;
  v_pairs jsonb;
  v_i integer;
begin
  if has_function_privilege('anon',
      'public.tm_org_teammate_pairs(uuid)','execute') then
    raise exception 'Anonymous role can read private teammate history';
  end if;
  perform set_config('request.jwt.claim.sub',
    '22222222-2222-4222-8222-222222222222',true);
  begin
    perform public.tm_org_teammate_pairs(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    raise exception 'A non-organizer read private history';
  exception when insufficient_privilege then null;
  end;
  perform set_config('request.jwt.claim.sub',
    '11111111-1111-4111-8111-111111111111',true);
  v_session:=public.tm_org_start_session(
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    4::smallint,true,false,false);
  for v_i in 1..16 loop
    perform public.tm_org_add_walkin(v_session,
      'History player '||v_i,
      'history-'||v_i||'@example.com');
  end loop;
  for v_i in 1..4 loop
    select jsonb_agg(id order by id) into v_members from (
      select id from public.tm_session_players
      where session_id=v_session order by id limit 4
        offset (v_i-1)*4
    ) q;
    v_payload:=v_payload||jsonb_build_array(
      jsonb_build_object('seed',v_i,'playerIds',v_members));
  end loop;
  select revision into v_revision from public.tm_sessions where id=v_session;
  perform public.tm_org_save_draft(v_session,v_revision,v_payload);
  select revision into v_revision from public.tm_sessions where id=v_session;
  v_rotation:=public.tm_org_publish_draft(v_session,v_revision);

  if jsonb_array_length(public.tm_org_teammate_pairs(v_session))<>0 then
    raise exception 'Unplayed draft should not count teammate appearances';
  end if;
  select id,team_a_id into v_game,v_team
    from public.tm_games where rotation_id=v_rotation
      and round_number=1 and court=1;
  perform public.tm_public_start_game(v_game);
  perform public.tm_public_report_winner(v_game,v_team);
  v_pairs:=public.tm_org_teammate_pairs(v_session);
  if jsonb_array_length(v_pairs)<>12
    or v_pairs::text like '%example.com%' then
    raise exception 'Expected 12 actual teammate pairs, got %',
      jsonb_array_length(v_pairs);
  end if;
  perform public.tm_org_end_session(v_session);
  if jsonb_array_length(public.tm_org_teammate_pairs(v_session))<>12 then
    raise exception 'Finished game history should survive session closure';
  end if;
  raise notice 'Private teammate history contracts passed';
end $history_contract$;
