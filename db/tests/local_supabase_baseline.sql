-- LOCAL SUPABASE ONLY: minimal, synthetic stand-in for the existing
-- COS Volleyball tables. Apply AFTER 'supabase start' to its local DB.
-- Do not apply to either user's existing hosted Supabase project.
--
-- In local Supabase, auth.users/auth.uid(), anon and authenticated roles
-- already exist. Unlike fixture.sql, we do not recreate them.
create table public.organizers (
  user_id uuid primary key references auth.users(id) on delete cascade
);
create table public.events (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  status text not null default 'published',
  visibility text not null default 'public',
  starts_at timestamptz not null default now()
);
create table public.registrations (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete restrict,
  player_name text not null,
  player_email text not null,
  registration_status text not null,
  created_at timestamptz not null default now()
);
alter table public.organizers enable row level security;
alter table public.events enable row level security;
alter table public.registrations enable row level security;

-- The organizer can verify that their own account is in organizers.
-- An authenticated non-organizer must not read someone else's membership.
grant select on public.organizers to authenticated;
create policy tm_local_org_self on public.organizers
  for select to authenticated
  using (user_id=(select auth.uid()));

-- Approximate the existing site's organizer-only base table access.
grant select,insert,update,delete on public.events,public.registrations
  to authenticated;
create policy tm_local_org_events on public.events
  for all to authenticated
  using (exists(select 1 from public.organizers
    where user_id=(select auth.uid())))
  with check (exists(select 1 from public.organizers
    where user_id=(select auth.uid())));
create policy tm_local_org_registrations on public.registrations
  for all to authenticated
  using (exists(select 1 from public.organizers
    where user_id=(select auth.uid())))
  with check (exists(select 1 from public.organizers
    where user_id=(select auth.uid())));

insert into public.events(id,title,status,visibility,starts_at) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'Private local synthetic game','published','private',now()),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'Public local synthetic game','published','public',now());
insert into public.registrations(event_id,player_name,player_email,
  registration_status) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Alice Local',
    'alice-local@example.invalid','registered'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Alice Duplicate',
    'ALICE-LOCAL@example.invalid','waitlisted'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Bob Local',
    'bob-local@example.invalid','waitlisted'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Canceled Local',
    'canceled-local@example.invalid','cancelled');
