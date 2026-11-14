-- PHASE 10 TARGETED ROLLBACK: run after reverting the Phase 10 website commit.
-- IMPORTANT: Removing access enforcement permits previously restricted or
-- banned email addresses to register again and resume normal FIFO promotion.
-- We retain restriction/audit tables for historical evidence; no player,
-- payment, attendance, finance, registration, or email rows are removed.
-- Do NOT run this unless intentionally disabling Phase 10.

-- Unschedule only the Phase 10 job, if Supabase Cron was activated.
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    IF EXISTS (SELECT 1 FROM cron.job
               WHERE jobname = 'cos-volleyball-phase10-waitlist') THEN
      PERFORM cron.unschedule('cos-volleyball-phase10-waitlist');
    END IF;
  END IF;
END;
$do$;

BEGIN;

-- Restore the exact pre-Phase-10 trigger behavior from the schema backup.
CREATE OR REPLACE FUNCTION public.promote_waitlist_after_cancellation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_capacity integer;
  v_status text;
  v_ends_at timestamptz;
  v_count integer;
  v_next_id uuid;
BEGIN
  IF old.registration_status <> 'registered'
     OR new.registration_status <> 'cancelled' THEN
    RETURN new;
  END IF;

  SELECT capacity, status, ends_at INTO v_capacity, v_status, v_ends_at
    FROM public.events WHERE id = new.event_id FOR UPDATE;
  IF NOT FOUND OR v_status = 'cancelled' OR v_ends_at <= now() THEN
    RETURN new;
  END IF;

  LOOP
    SELECT count(*)::integer INTO v_count
      FROM public.registrations
     WHERE event_id = new.event_id AND registration_status = 'registered';
    EXIT WHEN v_count >= v_capacity;

    SELECT id INTO v_next_id
      FROM public.registrations
     WHERE event_id = new.event_id AND registration_status = 'waitlisted'
     ORDER BY created_at, id
     LIMIT 1 FOR UPDATE;
    EXIT WHEN v_next_id IS NULL;

    UPDATE public.registrations
       SET registration_status = 'registered'
     WHERE id = v_next_id AND registration_status = 'waitlisted';
  END LOOP;
  RETURN new;
END;
$$;

-- Restore the exact pre-Phase-10 registration semantics and return shape.
CREATE OR REPLACE FUNCTION public.register_for_open_gym(
  p_event_id uuid, p_name text, p_email text, p_phone text,
  p_payment_method text, p_invite_token uuid DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_event public.events%ROWTYPE;
  v_status text;
  v_id uuid;
  v_token uuid;
BEGIN
  IF char_length(trim(coalesce(p_name,''))) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'Enter a valid name.';
  END IF;
  IF char_length(trim(coalesce(p_email,''))) NOT BETWEEN 3 AND 254
     OR position('@' IN coalesce(p_email,'')) = 0 THEN
    RAISE EXCEPTION 'Enter a valid email address.';
  END IF;
  IF p_payment_method IS NULL OR p_payment_method NOT IN ('venmo','cash','apple_cash') THEN
    RAISE EXCEPTION 'Choose a valid payment method.';
  END IF;
  IF char_length(coalesce(p_phone,'')) > 30 THEN
    RAISE EXCEPTION 'Phone number is too long.';
  END IF;

  SELECT * INTO v_event FROM public.events
   WHERE id = p_event_id AND status = 'published' AND ends_at > now()
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This event is not available for registration.';
  END IF;
  IF v_event.visibility = 'private'
     AND (p_invite_token IS NULL OR p_invite_token <> v_event.invite_token) THEN
    RAISE EXCEPTION 'A valid invitation link is required for this event.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.registrations
     WHERE event_id = p_event_id
       AND lower(player_email) = lower(trim(p_email))
       AND registration_status <> 'cancelled'
  ) THEN
    RAISE EXCEPTION 'duplicate registration';
  END IF;

  IF (SELECT count(*) FROM public.registrations
      WHERE event_id = p_event_id AND registration_status = 'registered')
      < v_event.capacity THEN
    v_status := 'registered';
  ELSE
    v_status := 'waitlisted';
  END IF;

  INSERT INTO public.registrations
    (event_id, player_name, player_email, player_phone,
     payment_method, registration_status)
  VALUES
    (p_event_id, trim(p_name), lower(trim(p_email)),
     nullif(trim(coalesce(p_phone,'')),''), p_payment_method, v_status)
  RETURNING id, manage_token INTO v_id, v_token;

  RETURN jsonb_build_object('id',v_id,'status',v_status,'manage_token',v_token);
END;
$$;
REVOKE ALL ON FUNCTION public.register_for_open_gym(uuid,text,text,text,text,uuid)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.register_for_open_gym(uuid,text,text,text,text,uuid)
  TO anon, authenticated;

DROP FUNCTION IF EXISTS public.volleyball_organizer_set_access(text,text,text);
DROP FUNCTION IF EXISTS public.volleyball_phase10_promote_due();
DROP FUNCTION IF EXISTS public.volleyball_phase10_promote_event(uuid);
COMMIT;

-- Access tables and audit records remain private, organizer-readable, and
-- inert; they can be inspected for forensics or retained for a later update.
-- Do not drop pg_cron: it may be used by other tasks.
