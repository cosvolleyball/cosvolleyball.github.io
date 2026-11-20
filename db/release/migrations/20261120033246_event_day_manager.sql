-- Event Day Teams Manager initial migration. Apply in a single transaction.
set local lock_timeout = '5s';

-- Source: db/release/preflight.sql
-- Read-only compatibility checks for the initial manager installation.
do $preflight$
declare expected record; actual text;
begin
  if current_setting('server_version_num')::integer < 150000 then
    raise exception 'Teams Manager requires PostgreSQL 15 or newer';
  end if;
  for expected in select * from (values
    ('public','events','starts_at','timestamptz'),
    ('public','events','id','uuid'),('public','events','title','text'),
    ('public','events','status','text'),('public','events','visibility','text'),
    ('public','registrations','id','uuid'),('public','registrations','event_id','uuid'),
    ('public','registrations','player_name','text'),('public','registrations','player_email','text'),
    ('public','registrations','registration_status','text'),('public','registrations','created_at','timestamptz'),
    ('public','organizers','user_id','uuid'),('auth','users','id','uuid')
  ) as required(schema_name,table_name,column_name,type_name)
  loop
    select udt_name into actual from information_schema.columns
      where table_schema=expected.schema_name and table_name=expected.table_name
        and column_name=expected.column_name;
    if actual is distinct from expected.type_name then
      raise exception 'Incompatible source column %.%.%',expected.schema_name,expected.table_name,expected.column_name;
    end if;
  end loop;
  if to_regprocedure('auth.uid()') is null
    or to_regprocedure('realtime.send(jsonb,text,text,boolean)') is null then
    raise exception 'Supabase Auth/Realtime prerequisites are missing';
  end if;
  if to_regnamespace('tm_internal') is not null
    or exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and left(c.relname,3)='tm_')
    or exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and left(p.proname,3)='tm_') then
    raise exception 'Manager objects already exist: stop and inspect migration history';
  end if;
  if exists(select 1 from public.events where status='published'
    and length(btrim(title)) not between 1 and 120)
    or exists(select 1 from public.registrations r join public.events e on e.id=r.event_id
      where e.status='published' and r.registration_status in ('registered','waitlisted')
        and (length(btrim(r.player_name)) not between 1 and 100
          or length(lower(btrim(r.player_email))) not between 3 and 254
          or position('@' in lower(btrim(r.player_email)))<=1)) then
    raise exception 'Source import data needs organizer review before release';
  end if;
end $preflight$;

-- Source: db/drafts/event_day_manager_foundation.sql
-- Session, roster and profile tables and functions for the Event Day Teams Manager.
-- Source events, registrations, payments and notifications remain in the existing site schema.
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
    'rotations', totals.rotations, 'regular_games', totals.regular_games,
    'sub_games', totals.sub_games, 'wins', totals.wins
  ) order by sp.display_name,sp.id),'[]'::jsonb)
  into v_result
  from public.tm_session_players sp
  join public.tm_profiles p on p.id=sp.profile_id
  cross join lateral (
    select count(distinct g.rotation_id) as rotations,
      count(*) filter (where not a.is_substitute) as regular_games,
      count(*) filter (where a.is_substitute) as sub_games,
      count(*) filter (where a.team_id=g.winner_team_id) as wins
    from public.tm_game_appearances a
    join public.tm_games g on g.id=a.game_id
    where a.session_player_id=sp.id and g.status='completed'
  ) totals
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

-- Source: db/drafts/event_day_manager_rotations.sql
-- Organizer functions for saving private team drafts and publishing rotations.
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
  v_format smallint;
  v_draft_teams jsonb;
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
  if v_session.revision is distinct from p_expected_revision then
    raise exception 'Session changed; refresh roster before saving teams'
      using errcode='40001';
  end if;
  if exists (select 1 from public.tm_rotations
             where session_id=p_session_id and status='published') then
    raise exception 'Complete or end the active rotation before drafting the next'
      using errcode='22023';
  end if;
  -- Organizers can choose format afresh on EVERY reshuffle.
  -- For existing clients an array means the session's default format;
  -- new clients send {"playing_format":6,"teams":[...]}. Both are validated.
  if jsonb_typeof(p_teams)='object' then
    v_draft_teams:=p_teams->'teams';
    if (p_teams->>'playing_format') !~ '^[456]$' then
      raise exception 'Choose a 4v4, 5v5, or 6v6 playing format'
        using errcode='22023';
    end if;
    v_format:=(p_teams->>'playing_format')::smallint;
  else
    v_draft_teams:=p_teams;
    v_format:=v_session.format;
  end if;
  if v_session.event_visibility='private' and v_format=5 then
    raise exception 'Private competitive sessions support only 4v4 or 6v6'
      using errcode='22023';
  end if;
  if jsonb_typeof(v_draft_teams) is distinct from 'array'
     or jsonb_array_length(v_draft_teams) not in (4,5,6) then
    raise exception 'Expected 4, 5 or 6 teams' using errcode='22023';
  end if;
  v_team_count := jsonb_array_length(v_draft_teams);
  v_min_size := case when v_team_count=6 then 4 else v_format end;

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
  insert into public.tm_rotations(session_id,sequence,playing_format,status)
    values (p_session_id,v_sequence,v_format,'draft')
    returning id into v_rotation;

  for v_team in select value from jsonb_array_elements(v_draft_teams) loop
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
      if v_count < 2*v_format then
        raise exception 'Court % cannot field both competing teams',v_index
          using errcode='22023';
      end if;
    end loop;
  end if;

  update public.tm_sessions set revision=revision+1 where id=p_session_id;
  insert into public.tm_action_audit(session_id,action,actor_user_id,details)
    values (p_session_id,'save_draft',auth.uid(),
      jsonb_build_object('rotation_id',v_rotation,'teams',v_team_count,
        'playing_format',v_format));
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
  return jsonb_build_object('rotation_id',v_rotation,'teams',v_teams,
    'playing_format',(select playing_format from public.tm_rotations
      where id=v_rotation));
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
  if v_session.revision is distinct from p_expected_revision then
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
  if v_session is null or not exists(select 1 from public.tm_rotations
    where id=p_rotation_id and status='published') then
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

-- Source: db/drafts/event_day_manager_game_actions.sql
-- Game readiness, starts, winner reports and organizer corrections.
--
-- Anonymous callers may start READY games and submit their first valid winner.
-- Every operation locks its session row, validating concurrent actions atomically.
-- No private email, position, gender, skill or participation count is returned.

create schema if not exists tm_internal;
revoke all on schema tm_internal from public, anon, authenticated;

-- Requested one-game substitutions are stored separately from actual
-- appearances. An appearance is inserted only when the game really starts.
create table public.tm_game_subs (
  game_id uuid not null,
  rotation_id uuid not null,
  session_id uuid not null,
  session_player_id uuid not null,
  target_team_id uuid not null,
  recorded_at timestamptz not null default now(),
  primary key (game_id,session_player_id),
  foreign key (game_id,rotation_id)
    references public.tm_games(id,rotation_id) on delete cascade,
  foreign key (rotation_id,session_id)
    references public.tm_rotations(id,session_id) on delete cascade,
  foreign key (session_player_id,session_id)
    references public.tm_session_players(id,session_id) on delete restrict,
  foreign key (target_team_id,rotation_id)
    references public.tm_teams(id,rotation_id) on delete restrict
);
create index tm_game_subs_by_player on public.tm_game_subs(session_player_id);
alter table public.tm_game_subs enable row level security;
revoke all on public.tm_game_subs from public,anon,authenticated;

-- The caller must already hold a FOR UPDATE lock on the session. This
-- helper is in a non-exposed schema; nobody can call it from the Data API.
create function tm_internal.refresh_slots(p_rotation_id uuid)
returns void language plpgsql security invoker set search_path=''
as $$
declare
  v_count integer;
  v_team uuid[];
  v_w1 uuid;
  v_l1 uuid;
  v_w2 uuid;
  v_l2 uuid;
begin
  select array_agg(id order by seed),count(*)
  into v_team,v_count
  from public.tm_teams where rotation_id=p_rotation_id;

  if v_count in (5,6) then
    select g.winner_team_id,
      case when g.winner_team_id = g.team_a_id
        then g.team_b_id else g.team_a_id end
    into v_w1,v_l1
    from public.tm_games g
    where g.rotation_id=p_rotation_id
      and g.round_number=1 and g.court=1 and g.status='completed';

    select g.winner_team_id,
      case when g.winner_team_id = g.team_a_id
        then g.team_b_id else g.team_a_id end
    into v_w2,v_l2
    from public.tm_games g
    where g.rotation_id=p_rotation_id
      and g.round_number=1 and g.court=2 and g.status='completed';

    if v_count=6 then
      update public.tm_games g set
        team_a_id=case when g.court=1 and g.round_number=2 then v_w1
                       when g.court=1 and g.round_number=3 then v_l1
                       when g.court=2 and g.round_number=2 then v_w2
                       when g.court=2 and g.round_number=3 then v_l2 end,
        team_b_id=case when g.court=1 then v_team[3] else v_team[6] end
      where g.rotation_id=p_rotation_id and g.round_number>1
        and g.status in ('scheduled','ready');
    else
      update public.tm_games g set
        team_a_id=case
          when g.round_number=2 and g.court=1 then v_w1
          when g.round_number=2 and g.court=2 then v_w2
          when g.round_number=3 and g.court=1 then v_w1
          when g.round_number=3 and g.court=2 then v_w2 end,
        team_b_id=case
          when g.round_number=2 and g.court=1 then v_team[3]
          when g.round_number=2 and g.court=2 then v_l1
          when g.round_number=3 and g.court=1 then v_l2
          when g.round_number=3 and g.court=2 then v_team[3] end
      where g.rotation_id=p_rotation_id and g.round_number>1
        and g.status in ('scheduled','ready');
    end if;
  end if;

  -- A game is ready only after the prior game on its court and every
  -- earlier game involving either of its teams is COMPLETED. This handles
  -- five-team cross-court movement without unnecessarily synchronizing
  -- the six-team courts.
  update public.tm_games g set status=case
    when g.team_a_id is not null and g.team_b_id is not null
      and not exists (
        select 1 from public.tm_games prev
        where prev.rotation_id=g.rotation_id
          and prev.round_number<g.round_number
          and (prev.court=g.court
            or prev.team_a_id in (g.team_a_id,g.team_b_id)
            or prev.team_b_id in (g.team_a_id,g.team_b_id))
          and prev.status<>'completed'
      )
      and not exists (
        select 1 from public.tm_games live
        where live.rotation_id=g.rotation_id and live.status='playing'
          and (live.team_a_id in (g.team_a_id,g.team_b_id)
            or live.team_b_id in (g.team_a_id,g.team_b_id))
      )
    then 'ready' else 'scheduled' end
  where g.rotation_id=p_rotation_id and g.status in ('scheduled','ready');
end $$;

-- The internal scheduler is called exclusively from audited SECURITY DEFINER
-- RPCs. Revoking default PUBLIC EXECUTE is defense-in-depth even though
-- tm_internal is not exposed in PostgREST and its schema USAGE is denied.
revoke execute on function tm_internal.refresh_slots(uuid)
  from public,anon,authenticated;

-- A game can be started publicly only after its participants are available.
-- For six-team sessions, the resting team on the SAME court can lend
-- volunteers via tm_public_record_sub below. For five-team sessions,
-- temporary subs are prohibited; transfer between games instead.
create function public.tm_public_start_game(p_game_id uuid)
returns void language plpgsql security definer set search_path=''
as $$
declare
  v_session public.tm_sessions%rowtype;
  v_game public.tm_games%rowtype;
  v_rotation_status text;
  v_format smallint;
  v_team uuid;
  v_sub_count integer;
  v_available_count integer;
  v_regular_limit integer;
  v_started_count integer;
  v_minimum integer := 4;
begin
  select s.* into v_session
  from public.tm_games g
  join public.tm_rotations r on r.id=g.rotation_id
  join public.tm_sessions s on s.id=r.session_id
  where g.id=p_game_id and s.status='active'
  for update of s;
  if not found then
    raise exception 'No active session for this game' using errcode='22023';
  end if;
  select * into v_game from public.tm_games where id=p_game_id;
  select status,playing_format into v_rotation_status,v_format
    from public.tm_rotations where id=v_game.rotation_id;
  if v_rotation_status<>'published' then
    raise exception 'Rotation is not published' using errcode='22023';
  end if;
  perform tm_internal.refresh_slots(v_game.rotation_id);
  select * into v_game from public.tm_games where id=p_game_id;
  if v_game.status<>'ready' or v_game.team_a_id is null
     or v_game.team_b_id is null then
    raise exception 'Game is not ready; refresh the schedule'
      using errcode='22023';
  end if;

  -- Disallow the same team playing two simultaneous games on ANY court.
  if exists (
    select 1 from public.tm_games g
    where g.rotation_id=v_game.rotation_id and g.status='playing'
      and (g.team_a_id in (v_game.team_a_id,v_game.team_b_id)
        or g.team_b_id in (v_game.team_a_id,v_game.team_b_id))
  ) then
    raise exception 'One of these teams is already playing'
      using errcode='22023';
  end if;

  foreach v_team in array array[v_game.team_a_id,v_game.team_b_id] loop
    select count(*) into v_sub_count from public.tm_game_subs subs
    join public.tm_session_players sp on sp.id=subs.session_player_id
    where subs.game_id=p_game_id and subs.target_team_id=v_team
      and sp.attendance in ('present','waiting')
      and not exists(
        select 1 from public.tm_game_appearances a
        join public.tm_games g on g.id=a.game_id
        where a.session_player_id=sp.id and g.status='playing'
      );
    -- Reject stale subs rather than silently dropping one after a departure.
    if v_sub_count<>(
      select count(*) from public.tm_game_subs
      where game_id=p_game_id and target_team_id=v_team
    ) then
      raise exception 'A planned substitute is unavailable'
        using errcode='22023';
    end if;
    v_regular_limit := greatest(v_format-v_sub_count,0);
    select count(*) into v_available_count
    from public.tm_memberships m
    join public.tm_session_players sp on sp.id=m.session_player_id
    where m.rotation_id=v_game.rotation_id and m.team_id=v_team
      and sp.attendance in ('present','waiting')
      and not exists(
        select 1 from public.tm_game_appearances a
        join public.tm_games g on g.id=a.game_id
        where a.session_player_id=sp.id and g.status='playing'
      );

    if least(v_available_count,v_regular_limit)+v_sub_count<v_minimum then
      raise exception 'A team needs at least four available players'
        using errcode='22023';
    end if;
  end loop;

  -- Selection intentionally prioritizes those who have played fewer actual
  -- regular games; this rotates the fifth roster member into a 4v4 lineup.
  foreach v_team in array array[v_game.team_a_id,v_game.team_b_id] loop
    select count(*) into v_sub_count from public.tm_game_subs
      where game_id=p_game_id and target_team_id=v_team;
    v_regular_limit := greatest(v_format-v_sub_count,0);
    insert into public.tm_game_appearances
      (game_id,rotation_id,session_id,session_player_id,team_id,is_substitute)
    select p_game_id,v_game.rotation_id,v_session.id,ranked.player_id,v_team,false
    from (
      select sp.id as player_id
      from public.tm_memberships m
      join public.tm_session_players sp on sp.id=m.session_player_id
      where m.rotation_id=v_game.rotation_id and m.team_id=v_team
        and sp.attendance in ('present','waiting')
        and not exists (
          select 1 from public.tm_game_appearances a
          join public.tm_games g on g.id=a.game_id
          where a.session_player_id=sp.id and g.status='playing'
        )
      order by (
        select count(*) from public.tm_game_appearances a
        join public.tm_games g on g.id=a.game_id
        where a.session_player_id=sp.id and not a.is_substitute
          and g.status in ('completed','playing')
      ),sp.id
      limit v_regular_limit
    ) ranked;

    insert into public.tm_game_appearances
      (game_id,rotation_id,session_id,session_player_id,team_id,is_substitute)
    select p_game_id,v_game.rotation_id,v_session.id,
      subs.session_player_id,v_team,true
    from public.tm_game_subs subs
    where subs.game_id=p_game_id and subs.target_team_id=v_team;
  end loop;
  -- Above insertion can never reuse someone who is already in another
  -- playing game because all sessions serialize on the tm_sessions lock.
  update public.tm_games set status='playing',started_at=now()
    where id=p_game_id and status='ready';
  if not found then
    raise exception 'Someone already started this game'
      using errcode='22023';
  end if;
  update public.tm_sessions set revision=revision+1 where id=v_session.id;
  insert into public.tm_action_audit(session_id,action,details)
    values (v_session.id,'start_game',
      jsonb_build_object('game_id',p_game_id));
  perform tm_internal.refresh_slots(v_game.rotation_id);
end $$;

-- First valid result wins. Second/stale result attempts always fail.
create function public.tm_public_report_winner(
  p_game_id uuid,p_winner_team_id uuid
)
returns void language plpgsql security definer set search_path=''
as $$
declare
  v_session uuid;
  v_rotation uuid;
  v_game public.tm_games%rowtype;
begin
  select s.id,r.id into v_session,v_rotation
  from public.tm_games g
  join public.tm_rotations r on r.id=g.rotation_id
  join public.tm_sessions s on s.id=r.session_id
  where g.id=p_game_id and s.status='active' and r.status='published'
  for update of s;
  if not found then
    raise exception 'Game is outside an active rotation'
      using errcode='22023';
  end if;
  select * into v_game from public.tm_games where id=p_game_id;
  if v_game.status<>'playing' then
    raise exception 'Game already completed or has not started'
      using errcode='22023';
  end if;
  if p_winner_team_id is null
     or p_winner_team_id not in (v_game.team_a_id,v_game.team_b_id) then
    raise exception 'Winner must be one of the playing teams'
      using errcode='22023';
  end if;
  update public.tm_games set status='completed',
    winner_team_id=p_winner_team_id,completed_at=now()
  where id=p_game_id and status='playing';
  if not found then
    raise exception 'Winner already reported' using errcode='22023';
  end if;

  update public.tm_sessions set revision=revision+1 where id=v_session;
  insert into public.tm_action_audit(session_id,action,details)
    values (v_session,'report_winner',
      jsonb_build_object('game_id',p_game_id,
        'winner_team_id',p_winner_team_id));
  perform tm_internal.refresh_slots(v_rotation);
  if not exists(
    select 1 from public.tm_games where rotation_id=v_rotation
      and status<>'completed'
  ) then
    update public.tm_rotations set status='completed',finished_at=now()
    where id=v_rotation and status='published';
  end if;
end $$;

-- Organizer correction is allowed while downstream matches depending
-- on an opening result have NOT started. Last-round games remain correctable
-- even after a six-game rotation automatically becomes 'completed', while
-- the event-day session is still active. Four-team round-robin pairings do
-- not depend on winners, so their results can be corrected independently.
create function public.tm_org_correct_winner(
  p_game_id uuid,p_winner_team_id uuid
)
returns void language plpgsql security definer set search_path=''
as $$
declare
  v_session uuid;
  v_rotation uuid;
  v_game public.tm_games%rowtype;
  v_team_count integer;
begin
  if auth.uid() is null or not exists(
    select 1 from public.organizers where user_id=auth.uid()
  ) then
    raise exception 'Organizer access required' using errcode='42501';
  end if;
  select s.id,r.id into v_session,v_rotation
  from public.tm_games g
  join public.tm_rotations r on r.id=g.rotation_id
  join public.tm_sessions s on s.id=r.session_id
  where g.id=p_game_id and s.status='active'
    and r.status in ('published','completed')
  for update of s;
  if not found then
    raise exception 'No active published game to correct'
      using errcode='22023';
  end if;
  select * into v_game from public.tm_games where id=p_game_id;
  if v_game.status<>'completed'
     or p_winner_team_id not in (v_game.team_a_id,v_game.team_b_id) then
    raise exception 'Only a completed game can have its winner corrected'
      using errcode='22023';
  end if;
  if v_game.winner_team_id=p_winner_team_id then return; end if;
  select count(*) into v_team_count from public.tm_teams
    where rotation_id=v_rotation;

  if v_game.round_number=1 and v_team_count>4 and exists(
    select 1 from public.tm_games dependent
    where dependent.rotation_id=v_rotation
      and dependent.round_number>1
      and (dependent.started_at is not null
        or dependent.status in ('playing','completed'))
      and (
        (v_team_count=6 and dependent.court=v_game.court)
        or
        (v_team_count=5 and
          ((v_game.court=1 and
            (dependent.round_number=2 or
             (dependent.round_number=3 and dependent.court=1)))
          or
           (v_game.court=2 and
            ((dependent.round_number=2 and dependent.court=2)
             or dependent.round_number=3))))
      )
  ) then
    raise exception 'Cannot change winner after dependent match started'
      using errcode='22023';
  end if;

  -- A six-team opening-winner correction can change which team is
  -- resting in its next game. Remove planned subs for that court before
  -- rewiring, or a former resting-team player could end up playing both.
  -- Five-team games never have temporary substitutes.
  if v_game.round_number=1 and v_team_count=6 then
    delete from public.tm_game_subs subs
    using public.tm_games dependent
    where subs.game_id=dependent.id
      and dependent.rotation_id=v_rotation
      and dependent.court=v_game.court
      and dependent.round_number>1
      and dependent.status in ('scheduled','ready');
  end if;

  update public.tm_games set winner_team_id=p_winner_team_id
    where id=p_game_id;
  update public.tm_sessions set revision=revision+1 where id=v_session;
  insert into public.tm_action_audit(session_id,action,actor_user_id,details)
    values (v_session,'correct_winner',auth.uid(),
      jsonb_build_object('game_id',p_game_id,
        'previous',v_game.winner_team_id,'new',p_winner_team_id));
  perform tm_internal.refresh_slots(v_rotation);
end $$;

-- Read-only public information about planned temporary substitutes.
-- This exposes display names and team IDs, not private profiles.
create function public.tm_public_game_subs(p_game_id uuid)
returns jsonb language sql stable security definer set search_path=''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'player_id',sp.id,
    'name',sp.display_name,
    'team_id',subs.target_team_id
  ) order by sp.display_name,sp.id),'[]'::jsonb)
  from public.tm_game_subs subs
  join public.tm_session_players sp on sp.id=subs.session_player_id
  join public.tm_games g on g.id=subs.game_id
  join public.tm_rotations r on r.id=g.rotation_id
  join public.tm_sessions s on s.id=r.session_id
  where subs.game_id=p_game_id and s.status='active'
    and r.status='published'
$$;

revoke execute on function tm_internal.refresh_slots(uuid)
  from public,anon,authenticated;
revoke execute on function public.tm_public_start_game(uuid)
  from public,anon,authenticated;
revoke execute on function public.tm_public_report_winner(uuid,uuid)
  from public,anon,authenticated;
revoke execute on function public.tm_org_correct_winner(uuid,uuid)
  from public,anon,authenticated;
revoke execute on function public.tm_public_game_subs(uuid)
  from public,anon,authenticated;
grant execute on function public.tm_public_start_game(uuid)
  to anon,authenticated;
grant execute on function public.tm_public_report_winner(uuid,uuid)
  to anon,authenticated;
grant execute on function public.tm_org_correct_winner(uuid,uuid)
  to authenticated;
grant execute on function public.tm_public_game_subs(uuid)
  to anon,authenticated;

-- Source: db/drafts/event_day_manager_player_actions.sql
-- Same-court substitutes, between-game transfers and organizer corrections.
--
-- The six-team format permits game-specific same-court resting-team subs.
-- Five-team rotations permit NO temporary subs; instead, roster transfers
-- between games persist until the next organizer-published reshuffle.
-- Four-team round robin has no resting team to borrow from.

create function public.tm_public_record_sub(
  p_game_id uuid,
  p_session_player_id uuid,
  p_target_team_id uuid
)
returns void language plpgsql security definer set search_path=''
as $$
declare
  v_session public.tm_sessions%rowtype;
  v_game public.tm_games%rowtype;
  v_team_count integer;
  v_source_court smallint;
  v_source_team uuid;
  v_format smallint;
  v_player_status text;
  v_regular_count integer;
  v_sub_count integer;
begin
  select s.* into v_session
  from public.tm_games g
  join public.tm_rotations r on r.id=g.rotation_id
  join public.tm_sessions s on s.id=r.session_id
  where g.id=p_game_id and s.status='active' and r.status='published'
  for update of s;
  if not found then
    raise exception 'Game is outside the active rotation'
      using errcode='22023';
  end if;
  select * into v_game from public.tm_games where id=p_game_id;
  select playing_format into v_format from public.tm_rotations
    where id=v_game.rotation_id;
  select count(*) into v_team_count from public.tm_teams
    where rotation_id=v_game.rotation_id;
  if v_team_count<>6 then
    raise exception 'One-game substitutions are only allowed with six teams'
      using errcode='22023';
  end if;
  perform tm_internal.refresh_slots(v_game.rotation_id);
  select * into v_game from public.tm_games where id=p_game_id;
  if v_game.status<>'ready'
     or p_target_team_id not in (v_game.team_a_id,v_game.team_b_id) then
    raise exception 'Game must be ready; choose a playing team'
      using errcode='22023';
  end if;

  select m.team_id,t.court,sp.attendance
    into v_source_team,v_source_court,v_player_status
  from public.tm_memberships m
  join public.tm_teams t on t.id=m.team_id
  join public.tm_session_players sp on sp.id=m.session_player_id
  where m.rotation_id=v_game.rotation_id
    and m.session_player_id=p_session_player_id;
  if v_source_team is null or v_source_court is distinct from v_game.court
     or v_source_team in (v_game.team_a_id,v_game.team_b_id)
     or v_player_status not in ('present','waiting') then
    raise exception 'Player is not eligible from a resting team on this court'
      using errcode='22023';
  end if;
  if exists (
    select 1 from public.tm_game_appearances a
    join public.tm_games g on g.id=a.game_id
    where a.session_player_id=p_session_player_id and g.status='playing'
  ) then
    raise exception 'Player is already in a live game'
      using errcode='22023';
  end if;
  select count(*) into v_regular_count
  from public.tm_memberships m
  join public.tm_session_players sp on sp.id=m.session_player_id
  where m.rotation_id=v_game.rotation_id and m.team_id=p_target_team_id
    and sp.attendance in ('present','waiting')
    and not exists (
      select 1 from public.tm_game_appearances a
      join public.tm_games g on g.id=a.game_id
      where a.session_player_id=sp.id and g.status='playing'
    );
  select count(*) into v_sub_count from public.tm_game_subs
    where game_id=p_game_id and target_team_id=p_target_team_id;
  if v_regular_count+v_sub_count>=v_format then
    raise exception 'Team already has enough players for this game'
      using errcode='22023';
  end if;

  -- Primary key ensures one person cannot be assigned to both teams.
  insert into public.tm_game_subs(
    game_id,rotation_id,session_id,session_player_id,target_team_id
  ) values (
    p_game_id,v_game.rotation_id,v_session.id,p_session_player_id,p_target_team_id
  );
  update public.tm_sessions set revision=revision+1 where id=v_session.id;
  insert into public.tm_action_audit(session_id,action,details)
    values (v_session.id,'record_sub',
      jsonb_build_object('game_id',p_game_id,
        'player_id',p_session_player_id,'team_id',p_target_team_id));
end $$;

-- A public caller may undo an erroneous pre-game substitute assignment.
-- Once the match starts, appearances are fixed; organizer handles mistakes
-- by correction workflows, never rewriting a completed game silently.
create function public.tm_public_cancel_sub(
  p_game_id uuid,p_session_player_id uuid
)
returns void language plpgsql security definer set search_path=''
as $$
declare
  v_session uuid;
  v_status text;
begin
  select s.id into v_session
  from public.tm_games g
  join public.tm_rotations r on r.id=g.rotation_id
  join public.tm_sessions s on s.id=r.session_id
  where g.id=p_game_id and s.status='active'
    and r.status='published'
  for update of s;
  -- A joined game's status can come from the statement snapshot taken
  -- BEFORE waiting for the session lock. Read it again after obtaining
  -- that lock so a concurrent start cannot be followed by a stale cancel.
  select g.status into v_status
  from public.tm_games g
  join public.tm_rotations r on r.id=g.rotation_id
  where g.id=p_game_id and r.status='published';
  if v_session is null or v_status is distinct from 'ready' then
    raise exception 'Can only cancel substitutions before a game begins'
      using errcode='22023';
  end if;
  delete from public.tm_game_subs
    where game_id=p_game_id and session_player_id=p_session_player_id;
  if not found then
    raise exception 'Substitution was not found' using errcode='22023';
  end if;
  update public.tm_sessions set revision=revision+1 where id=v_session;
  insert into public.tm_action_audit(session_id,action,details)
    values (v_session,'cancel_sub',
      jsonb_build_object('game_id',p_game_id,
        'player_id',p_session_player_id));
end $$;

create function public.tm_public_transfer(
  p_rotation_id uuid,p_session_player_id uuid,p_to_team_id uuid
)
returns void language plpgsql security definer set search_path=''
as $$
declare
  v_session public.tm_sessions%rowtype;
  v_from_team_id uuid;
  v_available_count integer;
  v_format smallint;
  v_team_count integer;
  v_attendance text;
begin
  select s.* into v_session from public.tm_rotations r
  join public.tm_sessions s on s.id=r.session_id
  where r.id=p_rotation_id and r.status='published'
    and s.status='active'
  for update of s;
  if not found or not exists(select 1 from public.tm_rotations
    where id=p_rotation_id and status='published') then
    raise exception 'Transfer is outside an active published rotation'
      using errcode='22023';
  end if;
  select playing_format into v_format from public.tm_rotations
    where id=p_rotation_id;
  select count(*) into v_team_count from public.tm_teams
    where rotation_id=p_rotation_id;
  if v_team_count<>5 then
    raise exception 'Permanent transfers are only for five-team rotations'
      using errcode='22023';
  end if;
  if not exists (
    select 1 from public.tm_teams where id=p_to_team_id
      and rotation_id=p_rotation_id
  ) then
    raise exception 'Target is not a team in this rotation'
      using errcode='22023';
  end if;
  select m.team_id,sp.attendance into v_from_team_id,v_attendance
  from public.tm_memberships m
  join public.tm_session_players sp on sp.id=m.session_player_id
  where m.rotation_id=p_rotation_id
    and m.session_player_id=p_session_player_id;
  if v_from_team_id is null
     or v_attendance not in ('present','waiting')
     or v_from_team_id=p_to_team_id then
    raise exception 'Invalid available player or target team'
      using errcode='22023';
  end if;
  -- A public transfer lasts the WHOLE rotation. Repeated public moves
  -- would undermine player agreement and distort the actual team record.
  -- Only an authenticated organizer can correct a mistaken transfer.
  if exists (
    select 1 from public.tm_transfers
    where rotation_id=p_rotation_id
      and session_player_id=p_session_player_id
  ) then
    raise exception 'Player already transferred in this rotation; ask an organizer to correct'
      using errcode='22023';
  end if;
  if exists (
    select 1 from public.tm_games g
    where g.rotation_id=p_rotation_id and g.status='playing'
      and (g.team_a_id in (v_from_team_id,p_to_team_id)
        or g.team_b_id in (v_from_team_id,p_to_team_id))
  ) or exists (
    select 1 from public.tm_game_appearances a
    join public.tm_games g on g.id=a.game_id
    where a.session_player_id=p_session_player_id and g.status='playing'
  ) then
    raise exception 'Transfers cannot interrupt a game'
      using errcode='22023';
  end if;

  select count(*) into v_available_count
  from public.tm_memberships m
  join public.tm_session_players sp on sp.id=m.session_player_id
  where m.rotation_id=p_rotation_id and m.team_id=v_from_team_id
    and sp.attendance in ('present','waiting');
  if v_available_count-1<v_format then
    raise exception 'Source team needs enough players for its own matches'
      using errcode='22023';
  end if;

  update public.tm_memberships set team_id=p_to_team_id
    where rotation_id=p_rotation_id and session_player_id=p_session_player_id;
  insert into public.tm_transfers(
    rotation_id,session_id,session_player_id,from_team_id,to_team_id,
    recorded_by
  ) values (
    p_rotation_id,v_session.id,p_session_player_id,
    v_from_team_id,p_to_team_id,auth.uid()
  );
  update public.tm_sessions set revision=revision+1 where id=v_session.id;
  insert into public.tm_action_audit(session_id,action,actor_user_id,details)
    values (v_session.id,'transfer',auth.uid(),
      jsonb_build_object('rotation_id',p_rotation_id,
        'player_id',p_session_player_id,
        'from_team_id',v_from_team_id,'to_team_id',p_to_team_id));
end $$;


-- Organizer may correct a mistaken five-team transfer. A correction remains
-- between games only; it is audited and is NOT a general mid-game reshuffle.
create function public.tm_org_correct_transfer(
  p_rotation_id uuid,p_session_player_id uuid,p_to_team_id uuid
)
returns void language plpgsql security definer set search_path=''
as $$
declare
  v_session public.tm_sessions%rowtype;
  v_from_team uuid;
  v_available_count integer;
  v_format smallint;
  v_count integer;
begin
  if auth.uid() is null or not exists(
    select 1 from public.organizers where user_id=auth.uid()
  ) then
    raise exception 'Organizer access required' using errcode='42501';
  end if;
  select s.* into v_session
  from public.tm_rotations r
  join public.tm_sessions s on s.id=r.session_id
  where r.id=p_rotation_id and r.status='published'
    and s.status='active' for update of s;
  if not found or not exists(select 1 from public.tm_rotations
    where id=p_rotation_id and status='published') then
    raise exception 'Rotation is no longer active' using errcode='22023';
  end if;
  select playing_format into v_format from public.tm_rotations
    where id=p_rotation_id;
  select count(*) into v_count from public.tm_teams
    where rotation_id=p_rotation_id;
  if v_count<>5 then
    raise exception 'Transfer correction requires five teams' using errcode='22023';
  end if;
  if not exists(select 1 from public.tm_transfers
    where rotation_id=p_rotation_id
      and session_player_id=p_session_player_id) then
    raise exception 'No transfer exists to correct' using errcode='22023';
  end if;
  select team_id into v_from_team from public.tm_memberships
    where rotation_id=p_rotation_id and session_player_id=p_session_player_id;
  if v_from_team is null or v_from_team=p_to_team_id
    or not exists (
      select 1 from public.tm_teams
      where id=p_to_team_id and rotation_id=p_rotation_id
    ) then
    raise exception 'Invalid current team or correction target'
      using errcode='22023';
  end if;
  if exists(
    select 1 from public.tm_games
    where rotation_id=p_rotation_id and status='playing'
      and (v_from_team in (team_a_id,team_b_id)
        or p_to_team_id in (team_a_id,team_b_id))
  ) then
    raise exception 'Cannot correct transfer while either team is playing'
      using errcode='22023';
  end if;
  select count(*) into v_available_count
  from public.tm_memberships m
  join public.tm_session_players sp on sp.id=m.session_player_id
  where m.rotation_id=p_rotation_id and m.team_id=v_from_team
    and sp.attendance in ('present','waiting');
  if v_available_count-1 < v_format then
    raise exception 'Correction would leave the source team short'
      using errcode='22023';
  end if;
  update public.tm_memberships set team_id=p_to_team_id
    where rotation_id=p_rotation_id and session_player_id=p_session_player_id;
  insert into public.tm_transfers(
    rotation_id,session_id,session_player_id,from_team_id,to_team_id,
    recorded_by
  ) values (
    p_rotation_id,v_session.id,p_session_player_id,
    v_from_team,p_to_team_id,auth.uid()
  );
  update public.tm_sessions set revision=revision+1 where id=v_session.id;
  insert into public.tm_action_audit(session_id,action,actor_user_id,details)
    values(v_session.id,'correct_transfer',auth.uid(),jsonb_build_object(
      'rotation_id',p_rotation_id,'player_id',p_session_player_id,
      'from_team_id',v_from_team,'to_team_id',p_to_team_id));
end $$;

-- The organizer correction UI needs the set of previously transferred
-- players; anonymous visitors cannot retrieve this operational history.
create function public.tm_org_transfers(p_rotation_id uuid)
returns jsonb language plpgsql stable security definer set search_path=''
as $$
declare
  v_result jsonb;
begin
  if auth.uid() is null or not exists(
    select 1 from public.organizers where user_id=auth.uid()
  ) then
    raise exception 'Organizer access required' using errcode='42501';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'player_id',history.session_player_id,
    'name',sp.display_name,
    'current_team_id',m.team_id,
    'previous_team_id',history.from_team_id
  ) order by sp.display_name,history.session_player_id),'[]'::jsonb)
  into v_result
  from (
    select distinct on (t.session_player_id)
      t.session_player_id,t.from_team_id
    from public.tm_transfers t
    where t.rotation_id=p_rotation_id
    order by t.session_player_id,t.id desc
  ) history
  join public.tm_memberships m
    on m.rotation_id=p_rotation_id
    and m.session_player_id=history.session_player_id
  join public.tm_session_players sp
    on sp.id=history.session_player_id;
  return coalesce(v_result,'[]'::jsonb);
end $$;

revoke execute on function public.tm_org_transfers(uuid)
  from public,anon,authenticated;
grant execute on function public.tm_org_transfers(uuid)
  to authenticated;

revoke execute on function public.tm_org_correct_transfer(uuid,uuid,uuid)
  from public,anon,authenticated;
grant execute on function public.tm_org_correct_transfer(uuid,uuid,uuid)
  to authenticated;

revoke execute on function public.tm_public_record_sub(uuid,uuid,uuid)
  from public,anon,authenticated;
revoke execute on function public.tm_public_cancel_sub(uuid,uuid)
  from public,anon,authenticated;
revoke execute on function public.tm_public_transfer(uuid,uuid,uuid)
  from public,anon,authenticated;
grant execute on function public.tm_public_record_sub(uuid,uuid,uuid)
  to anon,authenticated;
grant execute on function public.tm_public_cancel_sub(uuid,uuid)
  to anon,authenticated;
grant execute on function public.tm_public_transfer(uuid,uuid,uuid)
  to anon,authenticated;

-- Source: db/drafts/event_day_manager_team_history.sql
-- Organizer-only teammate history within a session.
-- Counts *actual completed-game shared appearances*, not assumed rosters.
-- The IDs are session-player IDs. No history carries between sessions.
create function public.tm_org_teammate_pairs(p_session_id uuid)
returns jsonb language plpgsql stable security definer set search_path=''
as $$
declare
  v_result jsonb;
begin
  if auth.uid() is null or not exists (
    select 1 from public.organizers where user_id=auth.uid()
  ) then
    raise exception 'Organizer access required' using errcode='42501';
  end if;
  select coalesce(jsonb_agg(
    jsonb_build_array(p.a_id::text,p.b_id::text,p.games)
    order by p.a_id,p.b_id
  ),'[]'::jsonb) into v_result
  from (
    select a.session_player_id as a_id,
      b.session_player_id as b_id,
      count(*)::integer as games
    from public.tm_game_appearances a
    join public.tm_game_appearances b
      on a.game_id=b.game_id
      and a.team_id=b.team_id
      and a.session_player_id < b.session_player_id
    join public.tm_games g on g.id=a.game_id
    where a.session_id=p_session_id and b.session_id=p_session_id
      and g.status='completed'
    group by a.session_player_id,b.session_player_id
  ) p;
  return coalesce(v_result,'[]'::jsonb);
end $$;
revoke execute on function public.tm_org_teammate_pairs(uuid)
  from public,anon,authenticated;
grant execute on function public.tm_org_teammate_pairs(uuid)
  to authenticated;

-- Source: db/drafts/event_day_manager_roster_adjustments.sql
-- Late arrivals and between-game roster replacements.
-- Organizer may fill an unoccupied rotation slot OR replace an unavailable
-- player between games without changing the original registration system.
create function public.tm_org_adjust_roster(
  p_rotation_id uuid,
  p_in_player_id uuid,
  p_team_id uuid,
  p_out_player_id uuid default null
)
returns void language plpgsql security definer set search_path=''
as $$
declare
  v_session public.tm_sessions%rowtype;
  v_in_status text;
  v_out_status text;
  v_total_count integer;
  v_format smallint;
begin
  if auth.uid() is null or not exists (
    select 1 from public.organizers where user_id=auth.uid()
  ) then
    raise exception 'Organizer access required' using errcode='42501';
  end if;
  select s.* into v_session from public.tm_rotations r
  join public.tm_sessions s on s.id=r.session_id
  where r.id=p_rotation_id and r.status='published'
    and s.status='active'
  for update of s;
  if not found or not exists(select 1 from public.tm_rotations
    where id=p_rotation_id and status='published') then
    raise exception 'Only an active published rotation can be adjusted'
      using errcode='22023';
  end if;
  select playing_format into v_format from public.tm_rotations
    where id=p_rotation_id;
  if not exists(
    select 1 from public.tm_teams
    where id=p_team_id and rotation_id=p_rotation_id
  ) then
    raise exception 'Team is not in this rotation' using errcode='22023';
  end if;
  if exists(
    select 1 from public.tm_games
    where rotation_id=p_rotation_id and status='playing'
      and p_team_id in (team_a_id,team_b_id)
  ) then
    raise exception 'Cannot change the roster while this team is playing'
      using errcode='22023';
  end if;
  select attendance into v_in_status from public.tm_session_players
    where id=p_in_player_id and session_id=v_session.id;
  if v_in_status is null or v_in_status not in ('present','waiting') then
    raise exception 'Incoming player must be checked in and available'
      using errcode='22023';
  end if;
  if exists (
    select 1 from public.tm_memberships
    where rotation_id=p_rotation_id and session_player_id=p_in_player_id
  ) then
    raise exception 'Incoming player already belongs to a team'
      using errcode='22023';
  end if;
  if p_out_player_id is not null then
    select sp.attendance into v_out_status
    from public.tm_memberships m
    join public.tm_session_players sp on sp.id=m.session_player_id
    where m.rotation_id=p_rotation_id
      and m.team_id=p_team_id and m.session_player_id=p_out_player_id;
    if v_out_status not in ('break','departed') or v_out_status is null then
      raise exception 'Only an unavailable roster member may be replaced'
        using errcode='22023';
    end if;
    delete from public.tm_memberships
    where rotation_id=p_rotation_id and team_id=p_team_id
      and session_player_id=p_out_player_id;
  else
    select count(*) into v_total_count
    from public.tm_memberships
    where rotation_id=p_rotation_id and team_id=p_team_id;
    if v_total_count>=v_format then
      raise exception 'Team has no unoccupied roster spot; select an unavailable member'
        using errcode='22023';
    end if;
  end if;
  insert into public.tm_memberships(
    rotation_id,session_id,team_id,session_player_id)
  values (p_rotation_id,v_session.id,p_team_id,p_in_player_id);
  update public.tm_sessions set revision=revision+1 where id=v_session.id;
  insert into public.tm_action_audit(session_id,action,actor_user_id,details)
  values(v_session.id,'adjust_roster',auth.uid(),jsonb_build_object(
    'rotation_id',p_rotation_id,'team_id',p_team_id,
    'in_player_id',p_in_player_id,'out_player_id',p_out_player_id
  ));
end $$;
revoke execute on function public.tm_org_adjust_roster(uuid,uuid,uuid,uuid)
  from public,anon,authenticated;
grant execute on function public.tm_org_adjust_roster(uuid,uuid,uuid,uuid)
  to authenticated;

-- Source: db/drafts/event_day_manager_emergency.sql
-- Emergency substitutions during a live six-team game.
--
-- An appearance means a person participated at least once. Someone injured
-- mid-game retains that appearance, but is no longer actively on court.
-- A substitute is a new appearance and does not affect regular-game fairness.
alter table public.tm_game_appearances
  add column active_on_court boolean not null default true;

-- Player-facing display of the CURRENT playing lineup, no private attributes.
create function public.tm_public_game_lineup(p_game_id uuid)
returns jsonb language sql stable security definer set search_path=''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'player_id',sp.id,'name',sp.display_name,
    'team_id',a.team_id,'is_substitute',a.is_substitute
  ) order by sp.display_name,sp.id),'[]'::jsonb)
  from public.tm_game_appearances a
  join public.tm_session_players sp on sp.id=a.session_player_id
  join public.tm_games g on g.id=a.game_id
  join public.tm_rotations r on r.id=g.rotation_id
  join public.tm_sessions s on s.id=r.session_id
  where a.game_id=p_game_id and a.active_on_court
    and g.status='playing' and r.status='published'
    and s.status='active'
$$;

create function public.tm_public_emergency_sub(
  p_game_id uuid,p_out_player_id uuid,p_in_player_id uuid
)
returns void language plpgsql security definer set search_path=''
as $$
declare
  v_session public.tm_sessions%rowtype;
  v_game public.tm_games%rowtype;
  v_team uuid;
  v_source uuid;
  v_source_court smallint;
  v_in_status text;
  v_team_count integer;
begin
  select s.* into v_session
  from public.tm_games g
  join public.tm_rotations r on r.id=g.rotation_id
  join public.tm_sessions s on s.id=r.session_id
  where g.id=p_game_id and g.status='playing'
    and r.status='published' and s.status='active'
  for update of s;
  if not found then
    raise exception 'Emergency substitutions require an active game'
      using errcode='22023';
  end if;
  -- Joined game/rotation predicates may be stale after waiting for s.
  -- Read their state again under the acquired session lock.
  select g.* into v_game from public.tm_games g
  join public.tm_rotations r on r.id=g.rotation_id
  where g.id=p_game_id and g.status='playing' and r.status='published';
  if not found then
    raise exception 'Emergency substitutions require an active game'
      using errcode='22023';
  end if;
  select count(*) into v_team_count from public.tm_teams
    where rotation_id=v_game.rotation_id;
  if v_team_count<>6 then
    raise exception 'Midgame emergency substitutions require a six-team rotation'
      using errcode='22023';
  end if;
  select a.team_id into v_team from public.tm_game_appearances a
  where a.game_id=p_game_id and a.session_player_id=p_out_player_id
    and a.active_on_court;
  if v_team is null then
    raise exception 'Outgoing player is not currently on this court'
      using errcode='22023';
  end if;
  select m.team_id,t.court,sp.attendance
  into v_source,v_source_court,v_in_status
  from public.tm_memberships m
  join public.tm_teams t on t.id=m.team_id
  join public.tm_session_players sp on sp.id=m.session_player_id
  where m.rotation_id=v_game.rotation_id and m.session_player_id=p_in_player_id;
  if v_source is null or v_source_court is distinct from v_game.court
     or v_source in (v_game.team_a_id,v_game.team_b_id)
     or v_in_status not in ('present','waiting') then
    raise exception 'Replacement must be available from the resting same-court team'
      using errcode='22023';
  end if;
  if exists(select 1 from public.tm_game_appearances
    where game_id=p_game_id and session_player_id=p_in_player_id)
    or exists(
      select 1 from public.tm_game_appearances a
      join public.tm_games g on g.id=a.game_id
      where a.session_player_id=p_in_player_id and g.status='playing'
        and a.active_on_court
    ) then
    raise exception 'Replacement is already assigned to a current game'
      using errcode='22023';
  end if;
  update public.tm_game_appearances
    set active_on_court=false
    where game_id=p_game_id and session_player_id=p_out_player_id
      and active_on_court;
  if not found then
    raise exception 'Outgoing player already replaced'
      using errcode='22023';
  end if;
  insert into public.tm_game_appearances(
    game_id,rotation_id,session_id,session_player_id,team_id,
    is_substitute,active_on_court)
  values (p_game_id,v_game.rotation_id,v_session.id,p_in_player_id,
    v_team,true,true);
  update public.tm_sessions set revision=revision+1 where id=v_session.id;
  insert into public.tm_action_audit(session_id,action,details)
    values(v_session.id,'emergency_sub',jsonb_build_object(
      'game_id',p_game_id,'out_player_id',p_out_player_id,
      'in_player_id',p_in_player_id,'team_id',v_team
    ));
end $$;

-- Organizer correction: replace a mistaken appearance entry. This is
-- administrative correction, not permission to change an ongoing lineup
-- across courts. Corrected players must be eligible for the same team role.
create function public.tm_org_correct_appearance(
  p_game_id uuid,p_wrong_player_id uuid,p_correct_player_id uuid
)
returns void language plpgsql security definer set search_path=''
as $$
declare
  v_session uuid;
  v_game public.tm_games%rowtype;
  v_wrong public.tm_game_appearances%rowtype;
  v_source_team uuid;
  v_source_court smallint;
  v_correct_attendance text;
  v_target_court smallint;
  v_team_count int;
begin
  if auth.uid() is null or not exists(
    select 1 from public.organizers where user_id=auth.uid()
  ) then
    raise exception 'Organizer access required' using errcode='42501';
  end if;
  select s.id into v_session
  from public.tm_games g
  join public.tm_rotations r on r.id=g.rotation_id
  join public.tm_sessions s on s.id=r.session_id
  where g.id=p_game_id and s.status='active'
    and r.status in ('published','completed','ended_early')
    and g.status in ('playing','completed')
  for update of s;
  if v_session is null then
    raise exception 'Game is not eligible for lineup correction'
      using errcode='22023';
  end if;
  select g.* into v_game from public.tm_games g
  join public.tm_rotations r on r.id=g.rotation_id
  where g.id=p_game_id and g.status in ('playing','completed')
    and r.status in ('published','completed','ended_early');
  if not found then
    raise exception 'Game is not eligible for lineup correction'
      using errcode='22023';
  end if;
  select * into v_wrong from public.tm_game_appearances
    where game_id=p_game_id and session_player_id=p_wrong_player_id;
  if not found or p_wrong_player_id=p_correct_player_id then
    raise exception 'Choose a different recorded game participant'
      using errcode='22023';
  end if;
  if exists(select 1 from public.tm_game_appearances
    where game_id=p_game_id and session_player_id=p_correct_player_id) then
    raise exception 'Corrected player is already in this game'
      using errcode='22023';
  end if;
  select attendance into v_correct_attendance from public.tm_session_players
    where id=p_correct_player_id and session_id=v_session;
  if v_correct_attendance is null then
    raise exception 'Corrected player does not belong to this session'
      using errcode='22023';
  end if;
  if not v_wrong.is_substitute then
    if not exists(
      select 1 from public.tm_memberships
      where rotation_id=v_game.rotation_id
        and team_id=v_wrong.team_id
        and session_player_id=p_correct_player_id
    ) then
      raise exception 'Regular lineup correction must remain on the same team'
        using errcode='22023';
    end if;
  else
    select count(*) into v_team_count from public.tm_teams
      where rotation_id=v_game.rotation_id;
    if v_team_count<>6 then
      raise exception 'No substitute corrections in this rotation'
        using errcode='22023';
    end if;
    select m.team_id,t.court into v_source_team,v_source_court
    from public.tm_memberships m
    join public.tm_teams t on t.id=m.team_id
    where m.rotation_id=v_game.rotation_id
      and m.session_player_id=p_correct_player_id;
    if v_source_team is null or v_source_court is distinct from v_game.court
       or v_source_team in (v_game.team_a_id,v_game.team_b_id) then
      raise exception 'Substitute correction must use the resting same-court team'
        using errcode='22023';
    end if;
  end if;

  if v_game.status='playing' and v_wrong.active_on_court and exists(
    select 1 from public.tm_game_appearances a
    join public.tm_games g on g.id=a.game_id
    where a.session_player_id=p_correct_player_id and g.status='playing'
      and a.active_on_court
  ) then
    raise exception 'Corrected player is currently playing elsewhere'
      using errcode='22023';
  end if;
  update public.tm_game_appearances set session_player_id=p_correct_player_id
  where game_id=p_game_id and session_player_id=p_wrong_player_id;
  update public.tm_sessions set revision=revision+1 where id=v_session;
  insert into public.tm_action_audit(session_id,action,actor_user_id,details)
    values (v_session,'correct_appearance',auth.uid(),
      jsonb_build_object('game_id',p_game_id,
        'wrong_player_id',p_wrong_player_id,
        'correct_player_id',p_correct_player_id,
        'team_id',v_wrong.team_id,'is_substitute',v_wrong.is_substitute));
end $$;

-- Organizer-only historical roster to correct an erroneous recorded
-- participant without revealing completed-game appearance details publicly.
create function public.tm_org_game_appearances(p_game_id uuid)
returns jsonb language plpgsql stable security definer set search_path=''
as $$
declare
  v_result jsonb;
begin
  if auth.uid() is null or not exists(
    select 1 from public.organizers where user_id=auth.uid()
  ) then
    raise exception 'Organizer access required' using errcode='42501';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'player_id',sp.id,'name',sp.display_name,
    'team_id',a.team_id,'is_substitute',a.is_substitute,
    'active_on_court',a.active_on_court
  ) order by sp.display_name,sp.id),'[]'::jsonb)
  into v_result
  from public.tm_game_appearances a
  join public.tm_session_players sp on sp.id=a.session_player_id
  join public.tm_games g on g.id=a.game_id
  where a.game_id=p_game_id and g.status in ('playing','completed');
  return coalesce(v_result,'[]'::jsonb);
end $$;

revoke execute on function public.tm_public_game_lineup(uuid)
  from public,anon,authenticated;
revoke execute on function public.tm_public_emergency_sub(uuid,uuid,uuid)
  from public,anon,authenticated;
revoke execute on function public.tm_org_correct_appearance(uuid,uuid,uuid)
  from public,anon,authenticated;
grant execute on function public.tm_public_game_lineup(uuid)
  to anon,authenticated;
grant execute on function public.tm_public_emergency_sub(uuid,uuid,uuid)
  to anon,authenticated;
grant execute on function public.tm_org_correct_appearance(uuid,uuid,uuid)
  to authenticated;
revoke execute on function public.tm_org_game_appearances(uuid)
  from public,anon,authenticated;
grant execute on function public.tm_org_game_appearances(uuid)
  to authenticated;

-- Source: db/drafts/event_day_manager_intra_team_rotation.sql
-- Ordinary within-team changes to the active lineup during a game.
-- Typical cases: 7-person roster playing 6v6 (middle/libero share time);
-- 5-person roster playing 4v4; other extra-roster combinations.
-- A player who actually enters a game is a REGULAR participant, not a sub.

create function public.tm_public_rotate_teammate(
  p_game_id uuid,p_out_player_id uuid,p_in_player_id uuid
)
returns void language plpgsql security definer set search_path=''
as $$
declare
  v_session uuid;
  v_rotation uuid;
  v_out_team uuid;
  v_format smallint;
  v_in_attendance text;
  v_game public.tm_games%rowtype;
begin
  select s.id,r.id,r.playing_format
  into v_session,v_rotation,v_format
  from public.tm_games g
  join public.tm_rotations r on r.id=g.rotation_id
  join public.tm_sessions s on s.id=r.session_id
  where g.id=p_game_id and g.status='playing'
    and r.status='published' and s.status='active'
  for update of s;
  if v_session is null then
    raise exception 'Within-team rotation requires a live game'
      using errcode='22023';
  end if;
  if p_out_player_id is null or p_in_player_id is null
     or p_out_player_id=p_in_player_id then
    raise exception 'Choose two different teammates'
      using errcode='22023';
  end if;
  select g.* into v_game from public.tm_games g
  join public.tm_rotations r on r.id=g.rotation_id
  where g.id=p_game_id and g.status='playing' and r.status='published';
  if not found then
    raise exception 'Within-team rotation requires a live game'
      using errcode='22023';
  end if;
  select a.team_id into v_out_team from public.tm_game_appearances a
    where a.game_id=p_game_id and a.session_player_id=p_out_player_id
      and a.active_on_court and not a.is_substitute;
  if v_out_team is null then
    raise exception 'Outgoing player must be a regular on-court teammate'
      using errcode='22023';
  end if;
  select sp.attendance into v_in_attendance
    from public.tm_memberships m
    join public.tm_session_players sp on sp.id=m.session_player_id
    where m.rotation_id=v_rotation and m.team_id=v_out_team
      and m.session_player_id=p_in_player_id;
  if v_in_attendance not in ('present','waiting') or v_in_attendance is null then
    raise exception 'Incoming player must be available on the same team'
      using errcode='22023';
  end if;
  if exists (
    select 1 from public.tm_game_appearances a
      join public.tm_games g on g.id=a.game_id
    where a.session_player_id=p_in_player_id
      and a.active_on_court and g.status='playing'
  ) then
    raise exception 'Incoming player is already playing'
      using errcode='22023';
  end if;
  -- Prevent a regular mid-game switch on a team that already lost players:
  -- this operation is a 1-for-1 player rotation, not a lineup creation.
  if (select count(*) from public.tm_game_appearances
      where game_id=p_game_id and team_id=v_out_team
        and active_on_court)=0 then
    raise exception 'No active player to rotate' using errcode='22023';
  end if;

  update public.tm_game_appearances
    set active_on_court=false
    where game_id=p_game_id and session_player_id=p_out_player_id
      and active_on_court and not is_substitute;
  if not found then
    raise exception 'Outgoing player no longer active'
      using errcode='22023';
  end if;
  insert into public.tm_game_appearances
    (game_id,rotation_id,session_id,session_player_id,team_id,
      is_substitute,active_on_court)
  values (p_game_id,v_rotation,v_session,p_in_player_id,v_out_team,
      false,true)
  on conflict (game_id,session_player_id) do update
    set active_on_court=true;
  update public.tm_sessions set revision=revision+1 where id=v_session;
  insert into public.tm_action_audit(session_id,action,details)
    values(v_session,'rotate_teammate',jsonb_build_object(
      'game_id',p_game_id,'out_player_id',p_out_player_id,
      'in_player_id',p_in_player_id,'team_id',v_out_team));
end $$;

revoke execute on function public.tm_public_rotate_teammate(uuid,uuid,uuid)
  from public,anon,authenticated;
grant execute on function public.tm_public_rotate_teammate(uuid,uuid,uuid)
  to anon,authenticated;

-- Source: db/drafts/event_day_manager_realtime.sql
-- Public revision signals for session updates using Supabase Realtime.
--
-- Supabase Realtime Broadcast is a notification *only*.
-- No private row is in the publication or sent to visitors.
-- Public clients receive the opaque change signal and fetch the already
-- sanitized public.tm_public_snapshot() RPC for the latest correct state.
--
-- Current Supabase documentation:
-- https://supabase.com/docs/guides/realtime/broadcast
-- realtime.send(payload jsonb, event text, topic text, private boolean).
--
-- The client subscribes to topic "teams-manager:public", event "changed",
-- with config.private=false. The message contains only version and active flag.
-- The DB transaction remains valid if Realtime has a temporary outage.

create function tm_internal.notify_public_session_change()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    if new.revision is not distinct from old.revision
       and new.status is not distinct from old.status then
      return new;
    end if;
  end if;

  -- IMPORTANT: send ONLY the permitted fields, never row_to_json(new),
  -- auth identities, player names/emails or sensitive private game data.
  begin
    perform realtime.send(
      jsonb_build_object(
        'revision', new.revision,
        'active', new.status = 'active'
      ),
      'changed',
      'teams-manager:public',
      false
    );
  exception when others then
    -- Realtime may not yet have today's message partition or may be offline.
    -- A broadcast failure MUST NOT block gameplay; polling catches up.
    raise warning 'Teams Manager realtime notification unavailable: %', sqlstate;
  end;

  return new;
end $$;

revoke execute on function tm_internal.notify_public_session_change()
  from public,anon,authenticated;

create trigger tm_broadcast_public_session_change
after insert or update of revision,status on public.tm_sessions
for each row
execute function tm_internal.notify_public_session_change();

-- Do NOT grant SELECT on tm_sessions or publish private Teams Manager tables.
-- Do NOT expose this trigger function via the Data API.
-- Do NOT publish realtime.messages; Supabase manages its broadcast channel.

-- Source: db/drafts/event_day_manager_public_limits.sql
-- Shared per-session and per-game limits on anonymous player actions.
--
-- Deliberately conservative *shared* limits, not proof of player identity:
-- 120 public changes / active session / rolling minute;
-- 40 public changes / game / rolling minute.
-- All public state-changing RPCs already lock the same tm_sessions row before
-- auditing their action; this serializes concurrent callers for enforcement.
-- The guard runs before the audit insert, and any limit breach rolls back
-- the entire public RPC transaction, including a match/roster change.
--
-- This does NOT create IP identifiers or log private network information.
-- It does not rate-limit read-only public snapshots (platform handles those).
-- Organizers can always end/correct sessions through distinct organizer RPCs.

create index if not exists tm_public_action_rate_idx
on public.tm_action_audit(session_id,recorded_at desc)
where action in (
  'start_game','report_winner','record_sub','cancel_sub',
  'transfer','emergency_sub','rotate_teammate'
);

create function tm_internal.guard_public_action_rate()
returns trigger language plpgsql security definer
set search_path=''
as $$
declare
  v_window_start timestamptz;
  v_actions integer;
  v_match_actions integer;
  v_game_id text;
begin
  if new.action not in (
    'start_game','report_winner','record_sub','cancel_sub',
    'transfer','emergency_sub','rotate_teammate'
  ) then
    return new;
  end if;
  v_window_start:=clock_timestamp()-interval '60 seconds';

  select count(*) into v_actions from public.tm_action_audit a
  where a.session_id=new.session_id
    and a.action in (
      'start_game','report_winner','record_sub','cancel_sub',
      'transfer','emergency_sub','rotate_teammate'
    ) and a.recorded_at>v_window_start;
  if v_actions>=120 then
    raise exception 'Too many public game-day changes; try again shortly'
      using errcode='22023';
  end if;

  v_game_id:=new.details->>'game_id';
  if v_game_id is not null then
    select count(*) into v_match_actions from public.tm_action_audit a
    where a.session_id=new.session_id and a.recorded_at>v_window_start
      and a.action in (
        'start_game','report_winner','record_sub','cancel_sub',
        'transfer','emergency_sub','rotate_teammate'
      ) and a.details->>'game_id'=v_game_id;
    if v_match_actions>=40 then
      raise exception 'Too many changes to this game; try again shortly'
        using errcode='22023';
    end if;
  end if;
  return new;
end $$;

revoke execute on function tm_internal.guard_public_action_rate()
from public,anon,authenticated;

create trigger tm_reject_excessive_public_changes
before insert on public.tm_action_audit
for each row execute function tm_internal.guard_public_action_rate();

-- Source: db/tests/security_matrix.sql
-- Read-only audit of grants, row security and function settings for manager objects.
do $security_matrix$
declare
  v_function record;
  v_table record;
  v_seq record;
  v_allowed_anon boolean;
  v_expected_auth boolean;
  v_anon_exec boolean;
  v_auth_exec boolean;
  v_tables integer:=0;
  v_functions integer:=0;
begin
  for v_function in
    select n.nspname as schema_name, p.oid, p.proname,
      p.prosecdef as security_definer,
      p.proconfig
    from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace
    where (n.nspname='public' and p.proname like 'tm\_%' escape '\')
       or n.nspname='tm_internal'
  loop
    v_functions:=v_functions+1;
    v_anon_exec:=has_function_privilege('anon',v_function.oid,'EXECUTE');
    v_auth_exec:=has_function_privilege('authenticated',v_function.oid,'EXECUTE');
    v_allowed_anon:=v_function.schema_name='public'
      and v_function.proname like 'tm_public\_%' escape '\';
    v_expected_auth:=v_function.schema_name='public';
    if v_anon_exec<>v_allowed_anon
       or v_auth_exec<>v_expected_auth then
      raise exception 'Function privilege regression: %.% anon=% auth=% expected_anon=% expected_auth=%',
        v_function.schema_name,v_function.proname,
        v_anon_exec,v_auth_exec,v_allowed_anon,v_expected_auth;
    end if;
    -- Every exposed Teams Manager function must pin search_path. Otherwise
    -- attacker-supplied objects could change resolution inside DEFINER SQL.
    -- PostgreSQL serializes SET search_path='' as search_path="" in
    -- pg_proc.proconfig on some versions. Verify the exact empty path,
    -- accepting either representation rather than falsely rejecting it.
    if v_function.schema_name='public'
       and (v_function.proconfig is null or not exists (
         select 1 from unnest(v_function.proconfig) cfg
         where cfg in ('search_path=', 'search_path=""')
       )) then
      raise exception 'Teams Manager function %.% has unsafe search_path',
        v_function.schema_name,v_function.proname;
    end if;
  end loop;
  if v_functions<20 then
    raise exception 'Expected complete Teams Manager function set, found only %',
      v_functions;
  end if;

  for v_table in
    select c.oid,c.relname,c.relrowsecurity,c.relkind
    from pg_class c
    join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind in ('r','p')
      and c.relname like 'tm\_%' escape '\'
      -- These throwaway concurrency fixture tables are not created by
      -- the application SQL drafts or deployed to Supabase.
      and c.relname not like 'tm\_test\_%' escape '\'
  loop
    v_tables:=v_tables+1;
    if not v_table.relrowsecurity then
      raise exception 'Private manager table % has RLS disabled',
        v_table.relname;
    end if;
    if has_table_privilege('anon',v_table.oid,
      'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
       or has_table_privilege('authenticated',v_table.oid,
      'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') then
      raise exception 'Direct client privilege on private manager table %',
        v_table.relname;
    end if;
  end loop;
  if v_tables<10 then
    raise exception 'Expected all manager tables, found only %',v_tables;
  end if;

  for v_seq in
    select c.oid,c.relname
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind='S'
      and c.relname like 'tm\_%' escape '\'
  loop
    if has_sequence_privilege('anon',v_seq.oid,'USAGE,SELECT,UPDATE')
      or has_sequence_privilege('authenticated',v_seq.oid,'USAGE,SELECT,UPDATE') then
      raise exception 'Direct client privilege on private manager sequence %',
        v_seq.relname;
    end if;
  end loop;
  raise notice 'PASS: % Teams Manager functions and % private RLS tables have least-privilege access',
    v_functions,v_tables;
end $security_matrix$;

notify pgrst, 'reload schema';
