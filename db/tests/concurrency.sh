#!/usr/bin/env bash
# Two independent PostgreSQL connections racing on ONE public match.
# Must run against the disposable PostgreSQL service, not production.
set -euo pipefail
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
keys="$(psql -X -v ON_ERROR_STOP=1 -At -F '|' -c \
  "select game_id,session_id,team_a_id,team_b_id from public.tm_test_concurrency_keys limit 1")"
IFS='|' read -r game session team_a team_b <<< "$keys"
if [[ -z "$game" || -z "$session" || -z "$team_a" || -z "$team_b" ]]; then
  echo "ERROR: missing concurrency game fixture" >&2
  exit 1
fi

# Client A deliberately holds the session lock before writing; Client B
# starts during that transaction and must wait, then receive a stale error.
psql -X -v ON_ERROR_STOP=1 -At -c "
  begin;
  select 1 from public.tm_sessions where id='$session' for update;
  select pg_sleep(1.25);
  select public.tm_public_start_game('$game');
  commit;
" >"$tmp/start-first.log" 2>&1 &
first_pid=$!
sleep 0.35
set +e
psql -X -v ON_ERROR_STOP=1 -At -c \
  "select public.tm_public_start_game('$game');" \
  >"$tmp/start-second.log" 2>&1
second_status=$?
wait "$first_pid"
first_status=$?
set -e
if [[ "$first_status" -ne 0 || "$second_status" -eq 0 ]]; then
  echo "ERROR: simultaneous starts were not first-valid-wins" >&2
  cat "$tmp/start-first.log" "$tmp/start-second.log"
  exit 1
fi

psql -X -v ON_ERROR_STOP=1 -At -c "
do \$\$ begin
  if (select status from public.tm_games where id='$game') <> 'playing'
    or (select count(*) from public.tm_action_audit
      where session_id='$session' and action='start_game')<>1 then
    raise exception 'Concurrent starts duplicated the game';
  end if;
end \$\$;"

# Repeat against two different winner submissions from two independent
# connections. The losing writer must NOT rewrite recorded results.
psql -X -v ON_ERROR_STOP=1 -At -c "
  begin;
  select 1 from public.tm_sessions where id='$session' for update;
  select pg_sleep(1.25);
  select public.tm_public_report_winner('$game','$team_a');
  commit;
" >"$tmp/winner-first.log" 2>&1 &
first_pid=$!
sleep 0.35
set +e
psql -X -v ON_ERROR_STOP=1 -At -c \
  "select public.tm_public_report_winner('$game','$team_b');" \
  >"$tmp/winner-second.log" 2>&1
second_status=$?
wait "$first_pid"
first_status=$?
set -e
if [[ "$first_status" -ne 0 || "$second_status" -eq 0 ]]; then
  echo "ERROR: simultaneous winner submissions both succeeded or the first failed" >&2
  cat "$tmp/winner-first.log" "$tmp/winner-second.log"
  exit 1
fi

psql -X -v ON_ERROR_STOP=1 -At -c "
do \$\$ begin
  if (select status from public.tm_games where id='$game') <> 'completed'
    or (select winner_team_id from public.tm_games where id='$game') <> '$team_a'
    or (select count(*) from public.tm_action_audit
      where session_id='$session' and action='report_winner')<>1 then
    raise exception 'Concurrent winner submission overwrote a result';
  end if;
end \$\$;"
echo "PASS: two-connection game-start and winner races accepted exactly one result"
