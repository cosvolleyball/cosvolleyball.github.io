#!/usr/bin/env bash
# Fresh ephemeral database only. Never use a hosted project connection here.
set -euo pipefail
[[ "${PGHOST:-}" == localhost || "${PGHOST:-}" == 127.0.0.1 ]] || {
  echo 'Release smoke test requires local PostgreSQL' >&2; exit 1;
}
python3 db/release/build_release.py --check
release_db=tm_release_candidate_test
createdb "$release_db"
export PGDATABASE="$release_db"
# The parent contract suite created these cluster-wide roles already.
sed '/^create role /d' db/tests/fixture.sql | psql -X -v ON_ERROR_STOP=1 -1 >/dev/null
fingerprint="select md5(jsonb_build_object('events',(select jsonb_agg(to_jsonb(t) order by id) from public.events t),'registrations',(select jsonb_agg(to_jsonb(t) order by id) from public.registrations t),'organizers',(select jsonb_agg(to_jsonb(t) order by user_id) from public.organizers t))::text)"
before="$(psql -X -At -c "$fingerprint")"
for migration in db/release/migrations/*.sql; do
  psql -X -v ON_ERROR_STOP=1 -1 -f "$migration" >/dev/null
done
[[ "$(psql -X -At -c "select has_function_privilege('anon','public.tm_public_transfer_options(uuid)','execute')")" == t ]]
[[ "$(psql -X -At -c "$fingerprint")" == "$before" ]]
# A duplicate/partial install must be stopped by preflight, not overwritten.
if psql -X -v ON_ERROR_STOP=1 -1 -f db/release/preflight.sql >/dev/null 2>&1; then
  echo 'Preflight accepted an existing installation' >&2; exit 1;
fi
psql -X -v ON_ERROR_STOP=1 -1 -f db/release/suspend_access.sql >/dev/null
[[ "$(psql -X -At -c "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and left(p.proname,3)='tm_' and (has_function_privilege('anon',p.oid,'execute') or has_function_privilege('authenticated',p.oid,'execute'))")" == 0 ]]
psql -X -v ON_ERROR_STOP=1 -1 -f db/release/restore_access.sql >/dev/null
psql -X -v ON_ERROR_STOP=1 -f db/tests/security_matrix.sql >/dev/null
[[ "$(psql -X -At -c "$fingerprint")" == "$before" ]]
echo 'PASS: fresh release, duplicate-install gate, suspend/restore grants, unchanged source rows'
