-- Read-only compatibility gate. Runs before any manager DDL in the release.
-- Re-run immediately before release; prior review is not a permanent guarantee.
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
