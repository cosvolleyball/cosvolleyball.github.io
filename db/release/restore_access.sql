-- Restore the manager API grants following incident recovery.
-- Restore only the reviewed public/organizer RPC boundary, never table grants.
do $restore$
declare fn record;
begin
  for fn in select p.oid::regprocedure as signature,p.proname from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and left(p.proname,3)='tm_'
  loop
    execute format('revoke execute on function %s from public, anon, authenticated',fn.signature);
    if left(fn.proname,10)='tm_public_' then
      execute format('grant execute on function %s to anon, authenticated',fn.signature);
    elsif left(fn.proname,7)='tm_org_' then
      execute format('grant execute on function %s to authenticated',fn.signature);
    else
      raise exception 'Unknown manager function %; manual review required',fn.signature;
    end if;
  end loop;
end $restore$;
notify pgrst, 'reload schema';
