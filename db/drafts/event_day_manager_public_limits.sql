-- EVENT DAY MANAGER PART 10: ANONYMOUS WRITE ABUSE GUARD
-- REVIEW DRAFT ONLY, apply to local Supabase or disposable CI Postgres.
--
-- Deliberately conservative *shared* limits, not proof of player identity:
-- 120 public changes / active session / rolling minute;
-- 40 public changes / game / rolling minute.
-- All public state-changing RPCs already lock the same tm_sessions row before
-- auditing their action; this serializes concurrent callers for enforcement.
-- The guard runs before the audit insert, and any limit breach rolls back
-- the entire public RPC transaction, including a match/roster change.
--
-- This does NOT create IP identifiers or log private network information.
-- It does not rate-limit read-only public snapshots (platform handles those).
-- Organizers can always end/correct sessions through distinct organizer RPCs.

create index if not exists tm_public_action_rate_idx
on public.tm_action_audit(session_id,recorded_at desc)
where action in (
  'start_game','report_winner','record_sub','cancel_sub',
  'transfer','emergency_sub','rotate_teammate'
);

create function tm_internal.guard_public_action_rate()
returns trigger language plpgsql security definer
set search_path=''
as $$
declare
  v_window_start timestamptz;
  v_actions integer;
  v_match_actions integer;
  v_game_id text;
begin
  if new.action not in (
    'start_game','report_winner','record_sub','cancel_sub',
    'transfer','emergency_sub','rotate_teammate'
  ) then
    return new;
  end if;
  v_window_start:=clock_timestamp()-interval '60 seconds';

  select count(*) into v_actions from public.tm_action_audit a
  where a.session_id=new.session_id
    and a.action in (
      'start_game','report_winner','record_sub','cancel_sub',
      'transfer','emergency_sub','rotate_teammate'
    ) and a.recorded_at>v_window_start;
  if v_actions>=120 then
    raise exception 'Too many public game-day changes; try again shortly'
      using errcode='22023';
  end if;

  v_game_id:=new.details->>'game_id';
  if v_game_id is not null then
    select count(*) into v_match_actions from public.tm_action_audit a
    where a.session_id=new.session_id and a.recorded_at>v_window_start
      and a.action in (
        'start_game','report_winner','record_sub','cancel_sub',
        'transfer','emergency_sub','rotate_teammate'
      ) and a.details->>'game_id'=v_game_id;
    if v_match_actions>=40 then
      raise exception 'Too many changes to this game; try again shortly'
        using errcode='22023';
    end if;
  end if;
  return new;
end $$;

revoke execute on function tm_internal.guard_public_action_rate()
from public,anon,authenticated;

create trigger tm_reject_excessive_public_changes
before insert on public.tm_action_audit
for each row execute function tm_internal.guard_public_action_rate();
