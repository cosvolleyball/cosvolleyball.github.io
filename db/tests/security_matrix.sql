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
