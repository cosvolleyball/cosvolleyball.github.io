-- Run AFTER db/tests/fixture.sql and db/drafts/event_day_manager_foundation.sql.
-- PostgreSQL 17 integration tests using no external test extensions.
do $contract$
declare
  v_session uuid;
  v_next uuid;
  v_roster jsonb;
  v_snapshot jsonb;
  v_player uuid;
  v_profile uuid;
begin
  -- The private base tables must be inaccessible from the anonymous or
  -- authenticated Data API, even if someone guesses table/row IDs.
  if has_table_privilege('anon','public.tm_profiles','select')
     or has_table_privilege('anon','public.tm_session_players','select')
     or has_table_privilege('anon','public.tm_game_appearances','select')
     or has_table_privilege('authenticated','public.tm_profiles','select')
     or has_table_privilege('authenticated','public.tm_sessions','update')
  then
    raise exception 'Teams Manager private base table grants are unsafe';
  end if;
  if has_function_privilege('anon','public.tm_org_roster(uuid)','execute')
     or has_function_privilege('anon','public.tm_org_save_profile(text,text,smallint,text,text[])','execute')
     or has_function_privilege('anon','public.tm_org_start_session(uuid,smallint,boolean,boolean,boolean)','execute')
     or not has_function_privilege('anon','public.tm_public_snapshot()','execute')
  then
    raise exception 'Teams Manager public RPC permissions are unsafe';
  end if;

  -- A logged-in user without a public.organizers row is not an organizer.
  perform set_config('request.jwt.claim.sub',
    '22222222-2222-4222-8222-222222222222', true);
  begin
    perform public.tm_org_start_session(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',6::smallint,true,false,false);
    raise exception 'Non-organizer unexpectedly started a session';
  exception when insufficient_privilege then
    null; -- expected
  end;

  -- Organizer can create profiles and start a session, preincluding
  -- confirmed registrations while holding waitlisted players for review.
  perform set_config('request.jwt.claim.sub',
    '11111111-1111-4111-8111-111111111111', true);
  v_profile := public.tm_org_save_profile(' Alice@Example.com ','Alice',
    8::smallint,'female',array['setter','outside']);
  v_session := public.tm_org_start_session(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',6::smallint,true,true,true);

  v_roster := public.tm_org_roster(v_session);
  if jsonb_array_length(v_roster) <> 2 then
    raise exception 'Expected two distinct imported players (got %)',
      jsonb_array_length(v_roster);
  end if;
  if (select skill from public.tm_profiles where id=v_profile) <> 8
     or (select email from public.tm_profiles where id=v_profile)
       <> 'alice@example.com'
  then
    raise exception 'Registration import overwrote a curated profile';
  end if;
  if (select count(*) from public.registrations
       where event_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') <> 4
  then
    raise exception 'Session import modified original registrations';
  end if;
  if (select count(*) from public.tm_session_players
        where session_id=v_session and attendance='present')<>1
     or (select count(*) from public.tm_session_players
        where session_id=v_session and attendance='candidate')<>1
  then
    raise exception 'Confirmed players must be preincluded and waitlist held out';
  end if;
  if not exists(
       select 1 from jsonb_array_elements(v_roster) p
       where p->>'source_status'='registered' and p->>'attendance'='present'
     )
     or not exists(
       select 1 from jsonb_array_elements(v_roster) p
       where p->>'source_status'='waitlisted' and p->>'attendance'='candidate'
     ) then
    raise exception 'Organizer cannot distinguish registered from waitlisted';
  end if;

  -- Single active session is protected at DATABASE level, not UI level.
  begin
    perform public.tm_org_start_session(
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',6::smallint,true,false,false);
    raise exception 'A second active session unexpectedly succeeded';
  exception when unique_violation then
    null; -- expected
  end;

  select id into v_player from public.tm_session_players
    where session_id=v_session and profile_id=v_profile;
  perform public.tm_org_set_attendance(v_player,'absent');
  if (select attendance from public.tm_session_players where id=v_player)
      <> 'absent' then
    raise exception 'No-show did not leave the eligible player pool';
  end if;
  perform public.tm_org_set_attendance(v_player,'present');
  if (select revision from public.tm_sessions where id=v_session) <> 3
  then
    raise exception 'Attendance change did not advance session revision';
  end if;

  -- A waitlisted player who arrives can be included without altering
  -- the official registration or waitlist status.
  select sp.id into v_player from public.tm_session_players sp
  join public.registrations r on r.id=sp.registration_id
  where sp.session_id=v_session and r.registration_status='waitlisted';
  perform public.tm_org_set_attendance(v_player,'present');
  if (select registration_status from public.registrations
      where id=(select registration_id from public.tm_session_players
                where id=v_player))<>'waitlisted' then
    raise exception 'Waitlist status was incorrectly modified';
  end if;

  v_player := public.tm_org_add_walkin(v_session,'Charlie',
    'charlie@example.com');
  if (select attendance from public.tm_session_players where id=v_player)
       <> 'present' then
    raise exception 'Walk-in check-in was not persisted';
  end if;
  if (select count(*) from public.registrations where
    player_email='charlie@example.com') > 0 then
    raise exception 'Walk-in was incorrectly registered';
  end if;

  -- The public view exposes the selected private event BY DESIGN, but
  -- never profile data, registration tokens or organizer-only statistics.
  v_snapshot := public.tm_public_snapshot();
  if v_snapshot->>'active' <> 'true'
     or v_snapshot->>'event_title' <> 'Private game night'
     or v_snapshot ? 'players' or v_snapshot ? 'registrations'
     or v_snapshot ? 'emails' or v_snapshot ? 'profiles'
     or v_snapshot::text like '%example.com%'
     or v_snapshot::text like '%setter%'
  then
    raise exception 'Public snapshot contract failed: %',v_snapshot;
  end if;

  -- Deleting an original event must remain possible (and not erase
  -- persistent player profiles or crash the active public snapshot).
  delete from public.events
    where id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  if (select event_id from public.tm_sessions where id=v_session) is not null
     or (public.tm_public_snapshot()->>'event_title') <> 'Private game night'
     or not exists(select 1 from public.tm_profiles where id=v_profile)
  then
    raise exception 'Source event deletion broke Teams Manager isolation';
  end if;

  perform public.tm_org_end_session(v_session);
  if (public.tm_public_snapshot()->>'active') <> 'false' then
    raise exception 'Ended session is incorrectly visible';
  end if;
  if jsonb_array_length(public.tm_org_stats(v_session)) <> 3 then
    raise exception 'Organizer historical stats not retained';
  end if;

  -- Old event/session is complete; a new session starts cleanly.
  v_next := public.tm_org_start_session(
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',4::smallint,true,false,true);
  if (select balance_positions from public.tm_sessions where id=v_next) then
    raise exception '4v4 must disable position balancing';
  end if;
  perform public.tm_org_end_session(v_next);
  raise notice 'Teams Manager database contracts passed';
end $contract$;
