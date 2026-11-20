-- Suspend the manager API during incident response in one transaction.
-- Retains all profiles, histories and source registration/payment records.
-- Apply BEFORE reverting frontend navigation. No DROP or source-table writes.
do $suspend$
declare fn record;
begin
  for fn in select p.oid::regprocedure as signature from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and left(p.proname,3)='tm_'
  loop
    execute format('revoke execute on function %s from public, anon, authenticated',fn.signature);
  end loop;
end $suspend$;
notify pgrst, 'reload schema';
