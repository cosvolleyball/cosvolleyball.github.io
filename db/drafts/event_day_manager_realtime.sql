-- Public revision signals for session updates using Supabase Realtime.
--
-- Supabase Realtime Broadcast is a notification *only*.
-- No private row is in the publication or sent to visitors.
-- Public clients receive the opaque change signal and fetch the already
-- sanitized public.tm_public_snapshot() RPC for the latest correct state.
--
-- Current Supabase documentation:
-- https://supabase.com/docs/guides/realtime/broadcast
-- realtime.send(payload jsonb, event text, topic text, private boolean).
--
-- The client subscribes to topic "teams-manager:public", event "changed",
-- with config.private=false. The message contains only version and active flag.
-- The DB transaction remains valid if Realtime has a temporary outage.

create function tm_internal.notify_public_session_change()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    if new.revision is not distinct from old.revision
       and new.status is not distinct from old.status then
      return new;
    end if;
  end if;

  -- IMPORTANT: send ONLY the permitted fields, never row_to_json(new),
  -- auth identities, player names/emails or sensitive private game data.
  begin
    perform realtime.send(
      jsonb_build_object(
        'revision', new.revision,
        'active', new.status = 'active'
      ),
      'changed',
      'teams-manager:public',
      false
    );
  exception when others then
    -- Realtime may not yet have today's message partition or may be offline.
    -- A broadcast failure MUST NOT block gameplay; polling catches up.
    raise warning 'Teams Manager realtime notification unavailable: %', sqlstate;
  end;

  return new;
end $$;

revoke execute on function tm_internal.notify_public_session_change()
  from public,anon,authenticated;

create trigger tm_broadcast_public_session_change
after insert or update of revision,status on public.tm_sessions
for each row
execute function tm_internal.notify_public_session_change();

-- Do NOT grant SELECT on tm_sessions or publish private Teams Manager tables.
-- Do NOT expose this trigger function via the Data API.
-- Do NOT publish realtime.messages; Supabase manages its broadcast channel.
