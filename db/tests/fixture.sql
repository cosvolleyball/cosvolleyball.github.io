-- A minimal LOCAL-ONLY stand-in for the existing COS Volleyball project.
-- No Supabase credentials, network access or production data needed.
create schema auth;
-- Local-only emulation of Supabase's managed Realtime Broadcast function.
-- The sandbox records each message so we can assert it carries no private
-- player attributes. This shim is never deployed to a hosted project.
create schema realtime;
create table realtime.tm_test_broadcast (
  id bigint generated always as identity primary key,
  payload jsonb not null,
  event text not null,
  topic text not null,
  is_private boolean not null
);
create function realtime.send(
  payload jsonb, event text, topic text, private boolean default true
) returns void language sql as $$
  insert into realtime.tm_test_broadcast(payload,event,topic,is_private)
  values (payload,event,topic,private)
$$;
create role anon nologin;
create role authenticated nologin;
create function auth.uid() returns uuid language sql stable
as $$ select nullif(current_setting('request.jwt.claim.sub', true),'')::uuid $$;
create table auth.users (id uuid primary key);
create table public.organizers (user_id uuid primary key references auth.users(id));
create table public.events (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  starts_at timestamptz not null default now(),
  status text not null,
  visibility text not null default 'public'
);
create table public.registrations (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete restrict,
  player_name text not null,
  player_email text not null,
  registration_status text not null,
  created_at timestamptz not null default now()
);
alter table public.events enable row level security;
alter table public.registrations enable row level security;
alter table public.organizers enable row level security;
grant usage on schema public to anon, authenticated;
grant usage on schema auth to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;
insert into auth.users(id) values
  ('11111111-1111-4111-8111-111111111111'),
  ('22222222-2222-4222-8222-222222222222');
insert into public.organizers(user_id)
  values ('11111111-1111-4111-8111-111111111111');
insert into public.events(id,title,status,visibility) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Private game night','published','private'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Public game night','published','public');
insert into public.registrations(event_id,player_name,player_email,
  registration_status) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Alice','ALICE@example.com','registered'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Alice duplicate','alice@example.com','waitlisted'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Bob','bob@example.com','waitlisted'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','No show','cancel@example.com','cancelled');
