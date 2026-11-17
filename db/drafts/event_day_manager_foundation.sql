-- EVENT DAY MANAGER — REVIEW DRAFT ONLY
-- This SQL has NOT been executed against the production Supabase project.
-- Apply with a reviewed, timestamped migration after local/staging tests.
-- Deliberately does not ALTER existing events, registrations, organizers,
-- payment, audit, ban/restriction or email infrastructure.
--
-- Privacy model:
--   * New base tables have RLS enabled, and no anon/authenticated table grants.
--   * Organizer functions explicitly verify membership in public.organizers.
--   * Public access is ONLY a sanitized JSON snapshot of the active session.
--   * Future player match/substitution RPCs must have their own limited grants.
--   * No realtime publication is configured for these private base tables.

-- 1. Persistent organizer-maintained profiles, keyed by normalized email.
create table public.tm_profiles (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  display_name text not null check (length(btrim(display_name)) between 1 and 100),
  skill smallint check (skill between 1 and 10),
  gender text check (gender is null or length(btrim(gender)) between 1 and 40),
  positions text[] not null default '{}'::text[]
    check (cardinality(positions) between 0 and 2),
  updated_at timestamptz not null default now(),
  constraint tm_profiles_normalized_email check (
    email = lower(btrim(email))
    and length(email) between 3 and 254
    and position('@' in email) > 1
  )
);

create table public.tm_sessions (
  id uuid primary key default gen_random_uuid(),
  -- Preserve the existing event deletion workflow. The snapshot survives even
  -- when a linked event is deleted later.
  event_id uuid references public.events(id) on delete set null,
  event_title text not null check (length(btrim(event_title)) between 1 and 120),
  event_visibility text not null check (event_visibility in ('public','private')),
  -- Session.format is a suggested initial setting; each rotation stores its own playing_format.
  status text not null default 'active'
    check (status in ('active', 'ended')),
  format smallint not null check (format in (4, 5, 6)),
  team_count smallint check (team_count is null or team_count in (4, 5, 6)),
  balance_skill boolean not null default true,
  balance_gender boolean not null default false,
  balance_positions boolean not null default false,
  revision bigint not null default 1 check (revision > 0),
  created_by uuid references auth.users(id) on delete set null,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  constraint tm_sessions_end_consistency
    check ((status = 'active' and ended_at is null)
        or (status = 'ended' and ended_at is not null))
);
-- Exactly one live session across the entire website.
create unique index tm_single_active_session on public.tm_sessions(status)
where status = 'active';

create table public.tm_session_players (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.tm_sessions(id) on delete cascade,
  profile_id uuid not null references public.tm_profiles(id) on delete restrict,
  registration_id uuid references public.registrations(id) on delete set null,
  display_name text not null check (length(btrim(display_name)) between 1 and 100),
  attendance text not null default 'candidate'
    check (attendance in ('candidate', 'present', 'waiting', 'absent', 'break', 'departed')),
  joined_at timestamptz not null default now(),
  unique (session_id, profile_id),
  unique (session_id, registration_id),
  unique (id, session_id)
);

create table public.tm_rotations (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.tm_sessions(id) on delete cascade,
  sequence integer not null check (sequence > 0),
  playing_format smallint not null check (playing_format in (4,5,6)),
  status text not null default 'draft'
    check (status in ('draft', 'published', 'completed', 'ended_early', 'closed')),
  created_at timestamptz not null default now(),
  published_at timestamptz,
  finished_at timestamptz,
  unique (session_id, sequence),
  unique (id, session_id)
);
create unique index tm_one_current_rotation on public.tm_rotations(session_id)
where status = 'published';
create unique index tm_one_draft_rotation on public.tm_rotations(session_id)
where status = 'draft';

create table public.tm_teams (
  id uuid primary key default gen_random_uuid(),
  rotation_id uuid not null references public.tm_rotations(id) on delete cascade,
  label text not null check (length(btrim(label)) between 1 and 40),
  court smallint check (court is null or court in (1,2)),
  seed smallint not null check (seed between 1 and 6),
  unique (rotation_id, seed),
  unique (id, rotation_id)
);

-- Current rotation membership. A five-team transfer changes team_id here
-- and writes an audit record below. New rotation = entirely new memberships.
create table public.tm_memberships (
  rotation_id uuid not null,
  session_id uuid not null,
  team_id uuid not null,
  session_player_id uuid not null,
  joined_at timestamptz not null default now(),
  primary key (rotation_id, session_player_id),
  foreign key (team_id, rotation_id)
    references public.tm_teams(id, rotation_id) on delete cascade,
  foreign key (rotation_id, session_id)
    references public.tm_rotations(id, session_id) on delete cascade,
  foreign key (session_player_id, session_id)
    references public.tm_session_players(id, session_id) on delete restrict
);
create index tm_memberships_by_team on public.tm_memberships(team_id);

create table public.tm_games (
  id uuid primary key default gen_random_uuid(),
  rotation_id uuid not null references public.tm_rotations(id) on delete cascade,
  round_number smallint not null check (round_number between 1 and 3),
  court smallint not null check (court in (1, 2)),
  team_a_id uuid references public.tm_teams(id) on delete restrict,
  team_b_id uuid references public.tm_teams(id) on delete restrict,
  winner_team_id uuid references public.tm_teams(id) on delete restrict,
  status text not null default 'scheduled'
    check (status in ('scheduled', 'ready', 'playing', 'completed', 'abandoned')),
  started_at timestamptz,
  completed_at timestamptz,
  unique (rotation_id, round_number, court),
  unique (id, rotation_id),
  foreign key (team_a_id, rotation_id)
    references public.tm_teams(id, rotation_id) on delete restrict,
  foreign key (team_b_id, rotation_id)
    references public.tm_teams(id, rotation_id) on delete restrict,
  foreign key (winner_team_id, rotation_id)
    references public.tm_teams(id, rotation_id) on delete restrict,
  constraint tm_game_distinct_teams
    check (team_a_id is null or team_b_id is null or team_a_id <> team_b_id),
  constraint tm_game_valid_winner
    check (winner_team_id is null or
      (team_a_id is not null and team_b_id is not null
       and winner_team_id in (team_a_id, team_b_id))),
  constraint tm_game_completed_consistency
    check ((status = 'completed') =
      (winner_team_id is not null and completed_at is not null))
);

-- An appearance is recorded for a real completed game, not inferred
-- from membership. Mark one-game substitute appearances separately.
create table public.tm_game_appearances (
  game_id uuid not null,
  rotation_id uuid not null,
  session_id uuid not null,
  session_player_id uuid not null,
  team_id uuid not null,
  is_substitute boolean not null default false,
  primary key (game_id, session_player_id),
  foreign key (game_id, rotation_id)
    references public.tm_games(id, rotation_id) on delete cascade,
  foreign key (team_id, rotation_id)
    references public.tm_teams(id, rotation_id) on delete restrict,
  foreign key (rotation_id, session_id)
    references public.tm_rotations(id, session_id) on delete cascade,
  foreign key (session_player_id, session_id)
    references public.tm_session_players(id, session_id) on delete restrict
);

create table public.tm_transfers (
  id bigint generated always as identity primary key,
  rotation_id uuid not null,
  session_id uuid not null,
  session_player_id uuid not null,
  from_team_id uuid not null,
  to_team_id uuid not null,
  recorded_at timestamptz not null default now(),
  recorded_by uuid references auth.users(id) on delete set null,
  foreign key (rotation_id,session_id)
    references public.tm_rotations(id,session_id) on delete cascade,
  foreign key (session_player_id,session_id)
    references public.tm_session_players(id,session_id) on delete restrict,
  foreign key (from_team_id,rotation_id)
    references public.tm_teams(id,rotation_id) on delete restrict,
  foreign key (to_team_id,rotation_id)
    references public.tm_teams(id,rotation_id) on delete restrict,
  constraint tm_transfer_different_teams check (from_team_id <> to_team_id)
);

create table public.tm_action_audit (
  id bigint generated always as identity primary key,
  session_id uuid not null references public.tm_sessions(id) on delete cascade,
  action text not null check (length(btrim(action)) between 1 and 80),
  actor_user_id uuid,
  details jsonb not null default '{}'::jsonb,
  recorded_at timestamptz not null default now()
);

-- Defense in depth: RLS on EVERY new table. No direct table API access.
alter table public.tm_profiles enable row level security;
alter table public.tm_sessions enable row level security;
alter table public.tm_session_players enable row level security;
alter table public.tm_rotations enable row level security;
alter table public.tm_teams enable row level security;
alter table public.tm_memberships enable row level security;
alter table public.tm_games enable row level security;
alter table public.tm_game_appearances enable row level security;
alter table public.tm_transfers enable row level security;
alter table public.tm_action_audit enable row level security;

revoke all on public.tm_profiles, public.tm_sessions, public.tm_session_players,
  public.tm_rotations, public.tm_teams, public.tm_memberships, public.tm_games,
  public.tm_game_appearances, public.tm_transfers, public.tm_action_audit
  from public, anon, authenticated;
revoke all on sequence public.tm_transfers_id_seq,
  public.tm_action_audit_id_seq from public, anon, authenticated;

-- 2. Organizer-only session setup. This copies *candidate* players and
-- does NOT write to original registrations or affect waitlist/payment.
create function public.tm_org_start_session(
  p_event_id uuid,
  p_format smallint default 6,
  p_balance_skill boolean default true,
  p_balance_gender boolean default false,
  p_balance_positions boolean default false
)
returns uuid language plpgsql security definer set search_path = ''
as $$
declare
  v_session uuid;
begin
  if auth.uid() is null or not exists
    (select 1 from public.organizers where user_id = auth.uid()) then
    raise exception 'Organizer access required' using errcode = '42501';
  end if;
  if not exists (select 1 from public.events
                 where id = p_event_id and status = 'published') then
    raise exception 'Published source event not found' using errcode = '22023';
  end if;
  if p_format not in (4, 5, 6) then
    raise exception 'Format must be 4v4, 5v5 or 6v6' using errcode = '22023';
  end if;
  if p_format=5 and exists (
    select 1 from public.events
    where id=p_event_id and visibility='private'
  ) then
    raise exception 'Private competitive events support only 4v4 or 6v6'
      using errcode='22023';
  end if;
  -- The unique active-session index rejects concurrent starts atomically.
  insert into public.tm_sessions(event_id, event_title, event_visibility,
    format, balance_skill, balance_gender, balance_positions, created_by)
  select e.id, e.title, e.visibility, p_format, coalesce(p_balance_skill,true),
    coalesce(p_balance_gender,false),
    case when p_format = 4 then false else coalesce(p_balance_positions,false) end,
    auth.uid()
  from public.events e where e.id = p_event_id
  returning id into v_session;

  -- A returning player's curated profile (skill, gender, positions)
  -- must never be overwritten by a registration import.
  insert into public.tm_profiles (email, display_name)
  select distinct on (lower(btrim(r.player_email)))
    lower(btrim(r.player_email)), btrim(r.player_name)
  from public.registrations r
  where r.event_id = p_event_id
    and r.registration_status in ('registered','waitlisted')
  order by lower(btrim(r.player_email)),
    case when r.registration_status='registered' then 0 else 1 end,
    r.created_at asc, r.id asc
  on conflict (email) do nothing;

  -- Confirmed registrations are presumed present, saving the organizer
  -- from checking everyone in individually. Waitlisted players are visible
  -- in the roster but excluded from teams until explicitly included.
  -- Absence/walk-ins are tracked here ONLY, never in registrations/payments.
  insert into public.tm_session_players
    (session_id, profile_id, registration_id, display_name, attendance)
  select distinct on (p.id)
    v_session, p.id, r.id, btrim(r.player_name),
    case when r.registration_status='registered'
      then 'present' else 'candidate' end
  from public.registrations r
  join public.tm_profiles p on p.email = lower(btrim(r.player_email))
  where r.event_id = p_event_id
    and r.registration_status in ('registered','waitlisted')
  order by p.id, case when r.registration_status='registered' then 0 else 1 end,
    r.created_at asc, r.id asc;

  insert into public.tm_action_audit(session_id, action, actor_user_id)
    values (v_session, 'start_session', auth.uid());
  return v_session;
end $$;

-- Profile fields are deliberately writable ONLY via an organizer function.
create function public.tm_org_save_profile(
  p_email text,
  p_name text,
  p_skill smallint default null,
  p_gender text default null,
  p_positions text[] default '{}'::text[]
)
returns uuid language plpgsql security definer set search_path = ''
as $$
declare
  v_email text := lower(btrim(p_email));
  v_id uuid;
  v_positions text[] := coalesce(p_positions, '{}'::text[]);
begin
  if auth.uid() is null or not exists
    (select 1 from public.organizers where user_id = auth.uid()) then
    raise exception 'Organizer access required' using errcode = '42501';
  end if;
  if v_email is null or length(v_email) not between 3 and 254
     or position('@' in v_email) <= 1
     or p_name is null or length(btrim(p_name)) not between 1 and 100
     or (p_skill is not null and p_skill not between 1 and 10)
     or cardinality(v_positions) > 2
     or exists (select 1 from unnest(v_positions) as val
                where val is null or length(btrim(val)) not between 1 and 40)
     or (p_gender is not null and length(btrim(p_gender)) not between 1 and 40)
  then
    raise exception 'Invalid player profile' using errcode = '22023';
  end if;
  insert into public.tm_profiles(email, display_name, skill, gender,
    positions)
  values (v_email, btrim(p_name), p_skill, nullif(btrim(p_gender),''),
          v_positions)
  on conflict (email) do update
    set display_name = excluded.display_name,
        skill = excluded.skill, gender = excluded.gender,
        positions = excluded.positions, updated_at = now()
  returning id into v_id;
  return v_id;
end $$;

create function public.tm_org_add_walkin(
  p_session_id uuid, p_name text, p_email text
)
returns uuid language plpgsql security definer set search_path = ''
as $$
declare
  v_profile uuid;
  v_player uuid;
begin
  if auth.uid() is null or not exists
    (select 1 from public.organizers where user_id = auth.uid()) then
    raise exception 'Organizer access required' using errcode = '42501';
  end if;
  perform 1 from public.tm_sessions
    where id = p_session_id and status = 'active' for update;
  if not found then
    raise exception 'Active session not found' using errcode = '22023';
  end if;
  if p_name is null or length(btrim(p_name)) not between 1 and 100 then
    raise exception 'Invalid player name' using errcode = '22023';
  end if;
  insert into public.tm_profiles(email, display_name)
    values (lower(btrim(p_email)), btrim(p_name))
    on conflict (email) do nothing;
  select id into v_profile from public.tm_profiles
    where email = lower(btrim(p_email));
  if v_profile is null then
    raise exception 'Valid email required for walk-in' using errcode = '22023';
  end if;
  insert into public.tm_session_players
    (session_id, profile_id, display_name, attendance)
    values (p_session_id, v_profile, btrim(p_name), 'present')
  on conflict (session_id, profile_id) do update
    set attendance = 'present'
  returning id into v_player;

  update public.tm_sessions set revision = revision + 1 where id = p_session_id;
  insert into public.tm_action_audit(session_id, action, actor_user_id,
    details) values (p_session_id, 'walkin', auth.uid(),
      jsonb_build_object('session_player_id', v_player));
  return v_player;
end $$;

create function public.tm_org_set_attendance(
  p_session_player_id uuid, p_attendance text
)
returns void language plpgsql security definer set search_path = ''
as $$
declare
  v_session uuid;
begin
  if auth.uid() is null or not exists
    (select 1 from public.organizers where user_id = auth.uid()) then
    raise exception 'Organizer access required' using errcode = '42501';
  end if;
  if p_attendance is null or p_attendance not in
      ('candidate', 'present', 'waiting', 'absent', 'break', 'departed') then
    raise exception 'Invalid attendance status' using errcode = '22023';
  end if;
  select s.id into v_session
  from public.tm_session_players sp
  join public.tm_sessions s on s.id = sp.session_id
  where sp.id = p_session_player_id and s.status = 'active'
  for update of s;
  if v_session is null then
    raise exception 'Active session player not found' using errcode='22023';
  end if;

  update public.tm_session_players set attendance = p_attendance
  where id = p_session_player_id;
  update public.tm_sessions set revision = revision + 1 where id = v_session;
  insert into public.tm_action_audit(session_id, action, actor_user_id, details)
  values (v_session, 'set_attendance', auth.uid(),
    jsonb_build_object('player_id',p_session_player_id,'status',p_attendance));
end $$;

-- Private organizer roster; includes sensitive attributes for balancing.
create function public.tm_org_roster(p_session_id uuid)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if auth.uid() is null or not exists
    (select 1 from public.organizers where user_id = auth.uid()) then
    raise exception 'Organizer access required' using errcode='42501';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', sp.id,
    'profile_id', p.id,
    'name', sp.display_name,
    'email', p.email,
    'skill', p.skill,
    'gender', p.gender,
    'positions', p.positions,
    'attendance', sp.attendance,
    'source_status', r.registration_status,
    'registration_id', sp.registration_id
  ) order by sp.display_name,sp.id), '[]'::jsonb)
  into v_result
  from public.tm_session_players sp
  join public.tm_profiles p on p.id = sp.profile_id
  left join public.registrations r on r.id = sp.registration_id
  where sp.session_id = p_session_id;
  return coalesce(v_result, '[]'::jsonb);
end $$;

-- Public snapshot exposes only the currently published rotation.
-- NO emails, skills, genders, positions, participation counts or registration IDs.
create function public.tm_public_snapshot()
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare
  v_session public.tm_sessions%rowtype;
  v_rotation uuid;
  v_rotation_status text;
  v_rotation_format smallint;
  v_title text;
  v_teams jsonb;
  v_games jsonb;
begin
  select * into v_session from public.tm_sessions
  where status = 'active' limit 1;
  if not found then
    return jsonb_build_object('active',false);
  end if;

  v_title := v_session.event_title;
  select id,status,playing_format into v_rotation,v_rotation_status,v_rotation_format
    from public.tm_rotations
    where session_id=v_session.id
      and status in ('published','completed','ended_early')
    order by sequence desc limit 1;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', t.id, 'label', t.label, 'court',t.court, 'seed',t.seed,
    'players', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', sp.id, 'name', sp.display_name) order by sp.display_name,sp.id)
      from public.tm_memberships m
      join public.tm_session_players sp on sp.id = m.session_player_id
      where m.team_id=t.id
    ),'[]'::jsonb)
  ) order by t.seed),'[]'::jsonb)
  into v_teams from public.tm_teams t where t.rotation_id=v_rotation;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', g.id, 'round',g.round_number, 'court',g.court,
    'team_a_id',g.team_a_id, 'team_b_id',g.team_b_id,
    'winner_team_id',g.winner_team_id,'status',g.status
  ) order by g.round_number,g.court),'[]'::jsonb)
  into v_games from public.tm_games g where g.rotation_id=v_rotation;

  return jsonb_build_object(
    'active',true,
    'session_id',v_session.id,
    'event_title',v_title,
    'format',coalesce(v_rotation_format,v_session.format),
    'allowed_formats',case when v_session.event_visibility='private'
      then jsonb_build_array(4,6) else jsonb_build_array(4,5,6) end,
    'revision',v_session.revision,
    'rotation_id',v_rotation,
    'rotation_status',v_rotation_status,
    'teams',v_teams,
    'games',v_games
  );
end $$;

-- Organizer-only stats use *actual* appearances in completed games.
create function public.tm_org_stats(p_session_id uuid)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if auth.uid() is null or not exists
    (select 1 from public.organizers where user_id = auth.uid()) then
    raise exception 'Organizer access required' using errcode='42501';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'name',sp.display_name, 'email',p.email,
    'regular_games', (
      select count(*) from public.tm_game_appearances a
      join public.tm_games g on g.id = a.game_id
      where a.session_player_id=sp.id
      and g.status='completed' and not a.is_substitute
    ),
    'sub_games', (
      select count(*) from public.tm_game_appearances a
      join public.tm_games g on g.id = a.game_id
      where a.session_player_id=sp.id
      and g.status='completed' and a.is_substitute
    ),
    'wins', (
      select count(*) from public.tm_game_appearances a
      join public.tm_games g on g.id = a.game_id
      where a.session_player_id=sp.id and g.status='completed'
      and a.team_id=g.winner_team_id
    )
  ) order by sp.display_name,sp.id),'[]'::jsonb)
  into v_result
  from public.tm_session_players sp
  join public.tm_profiles p on p.id=sp.profile_id
  where sp.session_id=p_session_id;
  return coalesce(v_result,'[]'::jsonb);
end $$;

create function public.tm_org_end_session(p_session_id uuid)
returns void language plpgsql security definer set search_path = ''
as $$
begin
  if auth.uid() is null or not exists
    (select 1 from public.organizers where user_id = auth.uid()) then
    raise exception 'Organizer access required' using errcode='42501';
  end if;
  perform 1 from public.tm_sessions where id=p_session_id
    and status='active' for update;
  if not found then
    raise exception 'Active session not found' using errcode='22023';
  end if;
  update public.tm_games set status='abandoned',
    winner_team_id=null, completed_at=null
  where rotation_id in (
    select id from public.tm_rotations where session_id=p_session_id
  ) and status in ('scheduled','ready','playing');
  update public.tm_rotations set status='closed',finished_at=now()
  where session_id=p_session_id and status in ('draft','published');
  update public.tm_sessions
    set status='ended', ended_at=now(), revision=revision+1
    where id=p_session_id;
  insert into public.tm_action_audit(session_id,action,actor_user_id)
    values (p_session_id,'end_session',auth.uid());
end $$;

-- SECURITY: SECURITY DEFINER routines are executable by PUBLIC by default
-- unless revoked, so revoke before permitting the exact intended roles.
revoke execute on function public.tm_org_start_session(
  uuid,smallint,boolean,boolean,boolean) from public, anon, authenticated;
revoke execute on function public.tm_org_save_profile(
  text,text,smallint,text,text[]) from public, anon, authenticated;
revoke execute on function public.tm_org_add_walkin(uuid,text,text)
  from public, anon, authenticated;
revoke execute on function public.tm_org_set_attendance(uuid,text)
  from public, anon, authenticated;
revoke execute on function public.tm_org_roster(uuid)
  from public, anon, authenticated;
revoke execute on function public.tm_org_stats(uuid)
  from public, anon, authenticated;
revoke execute on function public.tm_org_end_session(uuid)
  from public, anon, authenticated;
revoke execute on function public.tm_public_snapshot()
  from public, anon, authenticated;

grant execute on function public.tm_org_start_session(
  uuid,smallint,boolean,boolean,boolean) to authenticated;
grant execute on function public.tm_org_save_profile(
  text,text,smallint,text,text[]) to authenticated;
grant execute on function public.tm_org_add_walkin(uuid,text,text)
  to authenticated;
grant execute on function public.tm_org_set_attendance(uuid,text)
  to authenticated;
grant execute on function public.tm_org_roster(uuid) to authenticated;
grant execute on function public.tm_org_stats(uuid) to authenticated;
grant execute on function public.tm_org_end_session(uuid) to authenticated;
grant execute on function public.tm_public_snapshot()
  to anon, authenticated;

-- STOP: this deliberately does not expose organizer-only table rows,
-- implement public mutation RPCs, enable Realtime on private data, or
-- alter existing registration logic. See TEAM_MANAGER_DESIGN.md.
