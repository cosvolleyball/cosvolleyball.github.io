-- Run after db/tests/contracts.sql; test DRAFT, regenerate and publish flow.
do $rotation_contract$
declare
  v_session uuid;
  v_revision bigint;
  v_draft uuid;
  v_new_draft uuid;
  v_published uuid;
  v_payload jsonb;
  v_members jsonb;
  v_count integer;
  v_index integer;
  v_team_count integer;
  v_games integer;
  v_snapshot jsonb;
begin
  if has_function_privilege('anon','public.tm_org_save_draft(uuid,bigint,jsonb)','execute')
     or has_function_privilege('anon','public.tm_org_publish_draft(uuid,bigint)','execute')
     or has_function_privilege('anon','public.tm_org_end_rotation(uuid,boolean)','execute')
  then
    raise exception 'Anonymous role gained organizer-only draft controls';
  end if;
  perform set_config('request.jwt.claim.sub',
    '11111111-1111-4111-8111-111111111111',true);
  v_session := public.tm_org_start_session(
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',4::smallint,true,false,true);
  for v_index in 1..24 loop
    perform public.tm_org_add_walkin(v_session,'Player '||v_index,
      'player-'||v_index||'@example.com');
  end loop;

  -- Six teams of four: every available player appears exactly once.
  v_payload := '[]'::jsonb;
  for v_index in 1..6 loop
    select jsonb_agg(id order by id) into v_members from
      (select id from public.tm_session_players
        where session_id=v_session order by id
        limit 4 offset (v_index-1)*4) p;
    v_payload := v_payload || jsonb_build_array(
      jsonb_build_object('seed',v_index,'playerIds',v_members));
  end loop;
  select revision into v_revision from public.tm_sessions where id=v_session;

  -- Reject partial team lists and stale revision updates atomically.
  begin
    perform public.tm_org_save_draft(v_session,v_revision,
      jsonb_build_array(jsonb_build_object('seed',1,
        'playerIds',v_payload->0->'playerIds')));
    raise exception 'An incomplete draft unexpectedly succeeded';
  exception when sqlstate '22023' then null;
  end;

  v_draft := public.tm_org_save_draft(v_session,v_revision,v_payload);
  if jsonb_array_length(public.tm_org_draft(v_session)->'teams') <> 6 then
    raise exception 'Six-team private draft not saved';
  end if;
  if (public.tm_public_snapshot()->>'rotation_id') is not null then
    raise exception 'Unpublished draft visible to public';
  end if;

  -- Repeat generation before publishing. Old draft is replaced.
  select revision into v_revision from public.tm_sessions where id=v_session;
  v_new_draft := public.tm_org_save_draft(v_session,v_revision,v_payload);
  if v_new_draft = v_draft
     or exists(select 1 from public.tm_rotations where id=v_draft) then
    raise exception 'Regenerate failed to replace prior private draft';
  end if;

  begin
    perform public.tm_org_publish_draft(v_session,v_revision);
    raise exception 'Stale publish revision unexpectedly accepted';
  exception when sqlstate '40001' then null;
  end;
  select revision into v_revision from public.tm_sessions where id=v_session;
  v_published := public.tm_org_publish_draft(v_session,v_revision);
  if v_published<>v_new_draft or
     (select team_count from public.tm_sessions where id=v_session)<>6 then
    raise exception 'Published wrong rotation or team count';
  end if;
  select count(*) into v_games from public.tm_games
    where rotation_id=v_published;
  v_snapshot := public.tm_public_snapshot();
  if v_games<>6
     or jsonb_array_length(v_snapshot->'games')<>6
     or jsonb_array_length(v_snapshot->'teams')<>6
     or v_snapshot::text like '%example.com%'
  then
    raise exception 'Published public view incorrect or leaked private data';
  end if;
  if (select count(*) from public.tm_games
      where rotation_id=v_published and status='ready')<>2 then
    raise exception 'Opening games should be ready; dependencies unresolved';
  end if;

  -- No new drafts while a rotation is published.
  begin
    perform public.tm_org_save_draft(v_session,
      (select revision from public.tm_sessions where id=v_session),v_payload);
    raise exception 'An organizer drafted over an active rotation';
  exception when sqlstate '22023' then null;
  end;
  begin
    perform public.tm_org_end_rotation(v_published,false);
    raise exception 'Unfinished rotation ended as complete';
  exception when sqlstate '22023' then null;
  end;
  perform public.tm_org_end_rotation(v_published,true);
  if (select count(*) from public.tm_games
    where rotation_id=v_published and status='abandoned')<>6 then
    raise exception 'Early ending did not abandon unfinished games';
  end if;
  if (public.tm_public_snapshot()->>'rotation_id')<>v_published::text then
    raise exception 'Last published teams must remain visible until replaced';
  end if;

  -- Four-team full round robin after early end.
  v_payload := '[]'::jsonb;
  for v_index in 1..4 loop
    select jsonb_agg(id order by id) into v_members from
      (select id from public.tm_session_players
        where session_id=v_session order by id
        limit 6 offset (v_index-1)*6) p;
    v_payload := v_payload || jsonb_build_array(
      jsonb_build_object('seed',v_index,'playerIds',v_members));
  end loop;
  select revision into v_revision from public.tm_sessions where id=v_session;
  perform public.tm_org_save_draft(v_session,v_revision,v_payload);
  select revision into v_revision from public.tm_sessions where id=v_session;
  v_published := public.tm_org_publish_draft(v_session,v_revision);
  if (select count(*) from public.tm_games where rotation_id=v_published)<>6
     or (select count(*) from public.tm_games
          where rotation_id=v_published and team_a_id is not null
             and team_b_id is not null)<>6 then
    raise exception 'Four-team schedule should have all pairings resolved';
  end if;
  perform public.tm_org_end_rotation(v_published,true);

  -- Five-team rotation has two openings and four dependency slots.
  v_payload := '[]'::jsonb;
  for v_index in 1..5 loop
    select jsonb_agg(id order by id) into v_members from
      (select id from public.tm_session_players
        where session_id=v_session order by id
        limit case when v_index<=4 then 5 else 4 end
        offset (v_index-1)*5) p;
    v_payload := v_payload || jsonb_build_array(
      jsonb_build_object('seed',v_index,'playerIds',v_members));
  end loop;
  select revision into v_revision from public.tm_sessions where id=v_session;
  perform public.tm_org_save_draft(v_session,v_revision,v_payload);
  select revision into v_revision from public.tm_sessions where id=v_session;
  v_published := public.tm_org_publish_draft(v_session,v_revision);
  if (select count(*) from public.tm_games where rotation_id=v_published
       and team_a_id is null and team_b_id is null)<>4 then
    raise exception 'Five-team dependent schedule not correctly staged';
  end if;
  perform public.tm_org_end_rotation(v_published,true);
  perform public.tm_org_end_session(v_session);
  raise notice 'Draft, regenerate, publish, early end and schedule contracts passed';
end $rotation_contract$;
