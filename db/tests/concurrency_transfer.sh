#!/usr/bin/env bash
# Independent simultaneous public transfers of the same player.
# Only the first valid move may be applied until organizer correction.
set -euo pipefail
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
keys="$(psql -X -v ON_ERROR_STOP=1 -At -F '|' -c \
  "select rotation_id,session_id,session_player_id,team_a_id,team_b_id
   from public.tm_test_transfer_keys limit 1")"
IFS='|' read -r rotation session player team_a team_b <<< "$keys"
if [[ -z "$rotation" || -z "$player" || -z "$team_a" || -z "$team_b" ]]; then
  echo "ERROR: five-team transfer fixture missing" >&2
  exit 1
fi

psql -X -v ON_ERROR_STOP=1 -At -c "
  begin;
  select 1 from public.tm_sessions where id='$session' for update;
  select pg_sleep(1.25);
  select public.tm_public_transfer('$rotation','$player','$team_a');
  commit;
" >"$tmp/first.log" 2>&1 &
first_pid=$!
sleep 0.35
set +e
psql -X -v ON_ERROR_STOP=1 -At -c \
  "select public.tm_public_transfer('$rotation','$player','$team_b');" \
  >"$tmp/second.log" 2>&1
second_status=$?
wait "$first_pid"
first_status=$?
set -e
if [[ "$first_status" -ne 0 || "$second_status" -eq 0 ]]; then
  echo "ERROR: simultaneous public transfers were not first-valid-wins" >&2
  cat "$tmp/first.log" "$tmp/second.log"
  exit 1
fi

psql -X -v ON_ERROR_STOP=1 -At -c "
do \$\$ begin
  if (select team_id from public.tm_memberships
    where rotation_id='$rotation' and session_player_id='$player')<>'$team_a'
    or (select count(*) from public.tm_transfers
      where rotation_id='$rotation' and session_player_id='$player')<>1
    or (select count(*) from public.tm_action_audit
      where session_id='$session' and action='transfer')<>1 then
    raise exception 'Concurrent public transfer double-moved a player';
  end if;
end \$\$;"
echo "PASS: two-connection player transfer race recorded exactly one move"
