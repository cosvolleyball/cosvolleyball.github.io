#!/usr/bin/env bash
# Verify actual Postgres role execution, not only privilege introspection.
# Only against the fake PostgreSQL container in GitHub Actions.
set -euo pipefail

must_deny() {
  local sql="$1"
  if psql -X -v ON_ERROR_STOP=1 -At -c "$sql" >/dev/null 2>&1; then
    echo "ERROR: unauthorized statement succeeded: $sql" >&2
    exit 1
  fi
}
must_allow() {
  local sql="$1"
  if ! psql -X -v ON_ERROR_STOP=1 -At -c "$sql" >/dev/null; then
    echo "ERROR: intended role could not execute statement" >&2
    exit 1
  fi
}
must_allow "set role anon; select public.tm_public_snapshot();"
must_deny "set role anon; select email from public.tm_profiles;"
must_deny "set role anon; select * from public.tm_sessions;"
must_deny "set role anon; select public.tm_org_roster('11111111-1111-4111-8111-111111111111');"
must_deny "set role anon; select public.tm_org_stats('11111111-1111-4111-8111-111111111111');"
must_deny "set role anon; select public.tm_org_game_appearances('11111111-1111-4111-8111-111111111111');"
must_deny "set role anon; select public.tm_org_teammate_pairs('11111111-1111-4111-8111-111111111111');"
must_deny "set role anon; select public.tm_org_transfers('11111111-1111-4111-8111-111111111111');"
must_deny "set role anon; select public.tm_org_correct_transfer('11111111-1111-4111-8111-111111111111','11111111-1111-4111-8111-111111111111','11111111-1111-4111-8111-111111111111');"
must_deny "set role anon; select public.tm_org_save_profile('x@example.com','No',5::smallint,null,'{}'::text[]);"
must_deny "set role authenticated; select email from public.tm_profiles;"
must_deny "set role authenticated; select * from public.tm_games;"

# Authenticated but NOT an organizer. Role membership alone must not pass
# an auth.uid() membership check in SECURITY DEFINER routines.
must_deny "set role authenticated;
  set request.jwt.claim.sub='22222222-2222-4222-8222-222222222222';
  select public.tm_org_roster('11111111-1111-4111-8111-111111111111');"

# An authorized organizer may use the private roster RPC without acquiring
# raw SELECT access to its private base tables.
must_allow "set role authenticated;
  set request.jwt.claim.sub='11111111-1111-4111-8111-111111111111';
  select public.tm_org_roster('11111111-1111-4111-8111-111111111111');"
echo "PASS: real anon/authenticated role access boundaries"
