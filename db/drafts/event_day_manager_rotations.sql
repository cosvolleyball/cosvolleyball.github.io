-- EVENT DAY MANAGER — REVIEW DRAFT, PART 2: ORGANIZER TEAM DRAFTS
-- Run AFTER event_day_manager_foundation.sql in a disposable test database.
-- NOT applied to the hosted Supabase project.
--
-- Organizer submits an array of {seed,playerIds:[session_player_uuid]}.
-- Everyone physically available (present or waiting) must be assigned
-- exactly once. Clients may regenerate and resend this private draft.
-- Only a separate, explicit organizer operation publishes to the public.
-- All operations lock the session and check revision before mutating state.

create function public.tm_org_save_draft(
  p_session_id uuid,
  p_expected_revision bigint,
  p_teams jsonb
)
returns uuid language plpgsql security definer set search_path = ''
as $$
declare
  v_session public.tm_sessions%rowtype;
  v_rotation uuid;
  v_sequence integer;
  v_team_count integer;
  v_index integer := 0;
  v_team jsonb;
  v_member jsonb;
  v_member_id uuid;
  v_new_team uuid;
  v_seen uuid[] := '{}'::uuid[];
  v_min_size integer;
  v_ready_count integer;
  v_count integer;
begin
  if auth.uid() is null or not exists
    (select 1 from public.organizers where user_id=auth.uid()) then
    raise exception 'Organizer access required' using errcode='42501';
  end if;
  select * into v_session from public.tm_sessions
    where id=p_session_id and status='active' for update;
  if not found then
    raise exception 'Active session not found' using errcode='22023';
  end if;
  if v_session.revision <> p_expected_revision then
    raise exception 'Session changed; refresh roster before saving teams'
      using errcode='40001';
  end if;
  if exists (select 1 from public.tm_rotations
             where session_id=p_session_id and status='published') then
    raise exception 'Complete or end the active rotation before drafting the next'
      using errcode='22023';
  end if;
  if jsonb_typeof(p_teams) is distinct from 'array'
     or jsonb_array_length(p_teams) not in (4,5,6) then
    raise exception 'Expected 4, 5 or 6 teams' using errcode='22023';
  end if;
  v_team_count := jsonb_array_length(p_teams);
  v_min_size := case when v_team_count=6 then 4 else v_session.format end;

  select count(*) into v_ready_count from public.tm_session_players sp
    where sp.session_id=p_session_id and sp.attendance in ('present','waiting');
  if v_ready_count < v_team_count * v_min_size then
    raise exception 'Insufficient available players' using errcode='22023';
  end if;

  -- Only one private draft exists. Repeated save/regenerate REPLACES it;
  -- published teams and their match history are untouched.
  delete from public.tm_rotations
    where session_id=p_session_id and status='draft';
  select coalesce(max(sequence),0)+1 into v_sequence
    from public.tm_rotations where session_id=p_session_id;
  insert into public.tm_rotations(session_id,sequence,status)
    values (p_session_id,v_sequence,'draft') returning id into v_rotation;

  for v_team in select value from jsonb_array_elements(p_teams) loop
    v_index := v_index + 1;
    if jsonb_typeof(v_team) <> 'object' or
       jsonb_typeof(v_team->'playerIds') is distinct from 'array' or
       coalesce((v_team->>'seed')::integer, -1) <> v_index or
       jsonb_array_length(v_team->'playerIds') < v_min_size then
      raise exception 'Invalid team at seed %', v_index using errcode='22023';
    end if;
    insert into public.tm_teams(rotation_id,label,court,seed)
      values (v_rotation,'Team '||v_index,
        case when v_team_count=6 and v_index<=3 then 1
             when v_team_count=6 then 2
             else null end,
        v_index)
      returning id into v_new_team;

    for v_member in select value from jsonb_array_elements(v_team->'playerIds')
    loop
      if jsonb_typeof(v_member) <> 'string' then
        raise exception 'Each team player must be a UUID string' using errcode='22023';
      end if;
      v_member_id := (v_member #>> '{}')::uuid;
      if v_member_id = any(v_seen) then
        raise exception 'Player assigned to more than one team' using errcode='22023';
      end if;
      if not exists (
        select 1 from public.tm_session_players sp
        where sp.id=v_member_id and sp.session_id=p_session_id
          and sp.attendance in ('present','waiting')
      ) then
        raise exception 'Team contains an unavailable or foreign-session player'
          using errcode='22023';
      end if;
      v_seen := array_append(v_seen,v_member_id);
      insert into public.tm_memberships
        (rotation_id,session_id,team_id,session_player_id)
      values (v_rotation,p_session_id,v_new_team,v_member_id);
    end loop;
  end loop;

  if cardinality(v_seen) <> v_ready_count then
    raise exception 'Every available player must have a team'
      using errcode='22023';
  end if;

  -- With six teams, two play and one rests per court. The third team's
  -- players must be enough to cover any shortfall in that court's lineups.
  if v_team_count=6 then
    for v_index in 1..2 loop
      select count(*) into v_count
      from public.tm_memberships m
      join public.tm_teams t on t.id=m.team_id
      where t.rotation_id=v_rotation and t.court=v_index;
      if v_count < 2*v_session.format then
        raise exception 'Court % cannot field both competing teams',v_index
          using errcode='22023';
      end if;
    end loop;
  end if;

  update public.tm_sessions set revision=revision+1 where id=p_session_id;
  insert into public.tm_action_audit(session_id,action,actor_user_id,details)
    values (p_session_id,'save_draft',auth.uid(),
      jsonb_build_object('rotation_id',v_rotation,'teams',v_team_count));
  return v_rotation;
end $$;

-- Organizer-only private draft representation. Public snapshot never
-- references draft rotations or their prospective team assignments.
create function public.tm_org_draft(p_session_id uuid)
returns jsonb language plpgsql stable security definer set search_path=''
as $$
declare
  v_rotation uuid;
  v_teams jsonb;
begin
  if auth.uid() is null or not exists
    (select 1 from public.organizers where user_id=auth.uid()) then
    raise exception 'Organizer access required' using errcode='42501';
  end if;
  select id into v_rotation from public.tm_rotations
    where session_id=p_session_id and status='draft' limit 1;
  if v_rotation is null then return null; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'seed',t.seed,
    'playerIds',coalesce((
      select jsonb_agg(m.session_player_id order by m.joined_at,m.session_player_id)
      from public.tm_memberships m where m.team_id=t.id
    ),'[]'::jsonb)
  ) order by t.seed),'[]'::jsonb)
  into v_teams from public.tm_teams t where t.rotation_id=v_rotation;
  return jsonb_build_object('rotation_id',v_rotation,'teams',v_teams);
end $$;

-- Only an authorized organizer can publish. This creates six ordered game
-- slots, with opening matchups decided now and winner/loser-dependent
-- slots left unassigned until results are recorded.
create function public.tm_org_publish_draft(
  p_session_id uuid,
  p_expected_revision bigint
)
returns uuid language plpgsql security definer set search_path=''
as $$
declare
  v_session public.tm_sessions%rowtype;
  v_rotation uuid;
  v_teams uuid[];
  v_count integer;
begin
  if auth.uid() is null or not exists
    (select 1 from public.organizers where user_id=auth.uid()) then
    raise exception 'Organizer access required' using errcode='42501';
  end if;
  select * into v_session from public.tm_sessions
    where id=p_session_id and status='active' for update;
  if not found then
    raise exception 'Active session not found' using errcode='22023';
  end if;
  if v_session.revision <> p_expected_revision then
    raise exception 'Session changed; refresh before publishing'
      using errcode='40001';
  end if;
  if exists (select 1 from public.tm_rotations
             where session_id=p_session_id and status='published') then
    raise exception 'Another rotation is still active' using errcode='22023';
  end if;
  select id into v_rotation from public.tm_rotations
    where session_id=p_session_id and status='draft' for update;
  if v_rotation is null then
    raise exception 'No draft to publish' using errcode='22023';
  end if;
  select array_agg(t.id order by t.seed),count(*) into v_teams,v_count
    from public.tm_teams t where t.rotation_id=v_rotation;
  if v_count not in (4,5,6) then
    raise exception 'Draft has unsupported team count' using errcode='22023';
  end if;

  -- A draft is not automatically valid forever. Check against the CURRENT
  -- available roster and profile edits, even if the caller presents the
  -- latest revision after a check-in or departure.
  if exists (
    select 1 from public.tm_memberships m
    join public.tm_session_players sp on sp.id=m.session_player_id
    join public.tm_profiles p on p.id=sp.profile_id
    join public.tm_rotations r on r.id=m.rotation_id
    where m.rotation_id=v_rotation
      and (sp.attendance not in ('present','waiting') or
           p.updated_at > r.created_at)
  ) or (
    select count(*) from public.tm_memberships where rotation_id=v_rotation
  ) <> (
    select count(*) from public.tm_session_players
    where session_id=p_session_id and attendance in ('present','waiting')
  ) then
    raise exception 'Player availability or profiles changed; regenerate teams'
      using errcode='22023';
  end if;

  update public.tm_rotations set status='published',published_at=now()
    where id=v_rotation;

  if v_count=4 then
    insert into public.tm_games(rotation_id,round_number,court,
      team_a_id,team_b_id,status)
    values
      (v_rotation,1,1,v_teams[1],v_teams[2],'ready'),
      (v_rotation,1,2,v_teams[3],v_teams[4],'ready'),
      (v_rotation,2,1,v_teams[1],v_teams[3],'scheduled'),
      (v_rotation,2,2,v_teams[2],v_teams[4],'scheduled'),
      (v_rotation,3,1,v_teams[1],v_teams[4],'scheduled'),
      (v_rotation,3,2,v_teams[2],v_teams[3],'scheduled');
  else
    insert into public.tm_games(rotation_id,round_number,court,
      team_a_id,team_b_id,status)
    values
      (v_rotation,1,1,v_teams[1],v_teams[2],'ready'),
      (v_rotation,1,2,v_teams[4],v_teams[5],'ready'),
      (v_rotation,2,1,null,null,'scheduled'),
      (v_rotation,2,2,null,null,'scheduled'),
      (v_rotation,3,1,null,null,'scheduled'),
      (v_rotation,3,2,null,null,'scheduled');
  end if;
  update public.tm_sessions
    set revision=revision+1,team_count=v_count where id=p_session_id;
  insert into public.tm_action_audit(session_id,action,actor_user_id,details)
    values (p_session_id,'publish_draft',auth.uid(),
      jsonb_build_object('rotation_id',v_rotation));
  return v_rotation;
end $$;

-- Organizer may explicitly stop an active rotation early.
-- Incomplete games are abandoned; completed results remain recorded.
create function public.tm_org_end_rotation(
  p_rotation_id uuid, p_early boolean default false
)
returns void language plpgsql security definer set search_path=''
as $$
declare
  v_session uuid;
begin
  if auth.uid() is null or not exists
    (select 1 from public.organizers where user_id=auth.uid()) then
    raise exception 'Organizer access required' using errcode='42501';
  end if;
  select s.id into v_session
    from public.tm_rotations r join public.tm_sessions s on s.id=r.session_id
    where r.id=p_rotation_id and r.status='published' and s.status='active'
    for update of s;
  if v_session is null then
    raise exception 'Active published rotation not found' using errcode='22023';
  end if;
  if p_early is not true and exists(
    select 1 from public.tm_games
    where rotation_id=p_rotation_id and status<>'completed'
  ) then
    raise exception 'Rotation has unfinished games' using errcode='22023';
  end if;
  if p_early is true then
    update public.tm_games set status='abandoned',
      winner_team_id=null,completed_at=null
    where rotation_id=p_rotation_id and status<>'completed';
  end if;
  update public.tm_rotations
    set status=case when p_early then 'ended_early' else 'completed' end,
        finished_at=now()
    where id=p_rotation_id;
  update public.tm_sessions set revision=revision+1 where id=v_session;
  insert into public.tm_action_audit(session_id,action,actor_user_id,details)
    values (v_session,'end_rotation',auth.uid(),
      jsonb_build_object('rotation_id',p_rotation_id,'early',p_early));
end $$;

revoke execute on function public.tm_org_save_draft(uuid,bigint,jsonb)
  from public,anon,authenticated;
revoke execute on function public.tm_org_draft(uuid)
  from public,anon,authenticated;
revoke execute on function public.tm_org_publish_draft(uuid,bigint)
  from public,anon,authenticated;
revoke execute on function public.tm_org_end_rotation(uuid,boolean)
  from public,anon,authenticated;
grant execute on function public.tm_org_save_draft(uuid,bigint,jsonb)
  to authenticated;
grant execute on function public.tm_org_draft(uuid) to authenticated;
grant execute on function public.tm_org_publish_draft(uuid,bigint)
  to authenticated;
grant execute on function public.tm_org_end_rotation(uuid,boolean)
  to authenticated;
