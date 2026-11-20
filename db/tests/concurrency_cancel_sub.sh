#!/usr/bin/env bash
# Disposable fixture only: a queued cancellation must recheck after a start.
set -euo pipefail
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
keys="$(psql -X -v ON_ERROR_STOP=1 -At -F '|' <<'SQL'
select g.id,s.id,g.team_a_id,m.session_player_id
from public.tm_test_concurrency_keys k
join public.tm_sessions s on s.id=k.session_id
join public.tm_rotations r on r.session_id=s.id
join public.tm_games g on g.rotation_id=r.id and g.round_number=1 and g.court=2
join public.tm_teams t on t.rotation_id=r.id and t.seed=6
join public.tm_memberships m on m.team_id=t.id
limit 1;
SQL
)"
IFS='|' read -r game session team player <<< "$keys"
[[ -n "$game" && -n "$session" && -n "$team" && -n "$player" ]]
psql -X -v ON_ERROR_STOP=1 <<SQL
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',false);
select public.tm_org_set_attendance((select session_player_id from public.tm_memberships where team_id='$team' limit 1),'break');
select public.tm_public_record_sub('$game','$player','$team');
SQL

# The starter holds the session lock while the cancellation takes its
# statement snapshot. Keep the lock until pg_stat_activity proves it waits.
psql -X -v ON_ERROR_STOP=1 >"$tmp/start.log" 2>&1 <<SQL &
begin;
select 1 from public.tm_sessions where id='$session' for update;
\! touch '$tmp/locked'
\! while [ ! -f '$tmp/release' ]; do sleep 0.05; done
select public.tm_public_start_game('$game');
commit;
SQL
starter=$!
for i in {1..100}; do
  [[ -f "$tmp/locked" ]] && break
  sleep 0.05
done
[[ -f "$tmp/locked" ]] || { kill "$starter"; exit 1; }
PGAPPNAME=tm_cancel_sub_race psql -X -v ON_ERROR_STOP=1 -c \
  "select public.tm_public_cancel_sub('$game','$player');" >"$tmp/cancel.log" 2>&1 &
canceller=$!
blocked=false
for i in {1..100}; do
  if [[ "$(psql -X -At -c "select count(*) from pg_stat_activity where application_name='tm_cancel_sub_race' and wait_event_type='Lock'")" == 1 ]]; then
    blocked=true
    break
  fi
  sleep 0.05
done
touch "$tmp/release"
wait "$starter" || { cat "$tmp/start.log"; exit 1; }
set +e
wait "$canceller"
cancel_status=$?
set -e
if [[ "$blocked" != true || "$cancel_status" == 0 ]] || ! grep -q 'Can only cancel substitutions before a game begins' "$tmp/cancel.log"; then
  echo 'FAIL: queued cancellation did not reject the newly started game'
  cat "$tmp/cancel.log"
  exit 1
fi
psql -X -v ON_ERROR_STOP=1 <<SQL
do \$\$ begin
  if (select status from public.tm_games where id='$game')<>'playing'
    or not exists(select 1 from public.tm_game_subs where game_id='$game' and session_player_id='$player')
    or not exists(select 1 from public.tm_game_appearances where game_id='$game' and session_player_id='$player')
    or exists(select 1 from public.tm_action_audit where session_id='$session' and action='cancel_sub') then
    raise exception 'Queued cancellation changed live substitute data';
  end if;
end \$\$;
SQL
echo 'PASS: queued substitute cancellation preserves started-game assignment and appearances'
