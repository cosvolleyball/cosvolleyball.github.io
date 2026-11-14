-- PHASE 10: player restrictions, bans and automatic waitlist eligibility.
-- Run ONCE in Supabase SQL Editor as the project database owner.
-- No existing registration, payment, attendance, finance, or email rows are deleted.
-- Install BEFORE merging the Phase 10 website pull request.
BEGIN;

CREATE TABLE public.volleyball_player_access (
  email text PRIMARY KEY,
  rule_type text NOT NULL CHECK (rule_type IN ('restricted', 'banned')),
  expires_at timestamptz,
  reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 3 AND 240),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  created_by_email text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  updated_by_email text,
  CONSTRAINT volleyball_player_access_email CHECK (
    email = lower(btrim(email)) AND char_length(email) BETWEEN 3 AND 254
    AND position('@' IN email) > 1
  ),
  CONSTRAINT volleyball_player_access_expiry CHECK (
    (rule_type = 'restricted' AND expires_at IS NOT NULL)
    OR (rule_type = 'banned' AND expires_at IS NULL)
  )
);
CREATE INDEX volleyball_player_access_active_idx
  ON public.volleyball_player_access (rule_type, expires_at);

CREATE TABLE public.volleyball_player_access_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email text NOT NULL,
  action text NOT NULL CHECK (action IN ('restrict', 'ban', 'clear')),
  reason text,
  previous_rule text,
  previous_expires_at timestamptz,
  new_rule text,
  new_expires_at timestamptz,
  actor_id uuid,
  actor_email text,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX volleyball_player_access_audit_recent_idx
  ON public.volleyball_player_access_audit (recorded_at DESC, id DESC);

-- No direct browser mutation: only the checked organizer RPC below can write.
ALTER TABLE public.volleyball_player_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.volleyball_player_access_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.volleyball_player_access FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.volleyball_player_access_audit FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.volleyball_player_access TO authenticated;
GRANT SELECT ON public.volleyball_player_access_audit TO authenticated;
CREATE POLICY volleyball_player_access_organizer_read
  ON public.volleyball_player_access FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.organizers o WHERE o.user_id = auth.uid()
  ));
CREATE POLICY volleyball_player_access_audit_organizer_read
  ON public.volleyball_player_access_audit FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.organizers o WHERE o.user_id = auth.uid()
  ));

-- Callers: cancellation trigger, registration RPC, organizer RPC, and cron.
-- The event lock serializes capacity decisions; candidate priority is:
-- (1) unrestricted / expired restriction, (2) eligible restricted, then FIFO.
CREATE OR REPLACE FUNCTION public.volleyball_phase10_promote_event(p_event_id uuid)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_event public.events%ROWTYPE;
  v_count integer;
  v_next uuid;
  v_promoted integer := 0;
BEGIN
  SELECT * INTO v_event
    FROM public.events
   WHERE id = p_event_id FOR UPDATE;
  IF NOT FOUND OR v_event.status <> 'published' OR v_event.ends_at <= now() THEN
    RETURN 0;
  END IF;

  LOOP
    SELECT count(*)::integer INTO v_count
      FROM public.registrations
     WHERE event_id = p_event_id AND registration_status = 'registered';
    EXIT WHEN v_count >= v_event.capacity;

    SELECT r.id INTO v_next
      FROM public.registrations r
      LEFT JOIN public.volleyball_player_access a
        ON a.email = lower(btrim(r.player_email))
     WHERE r.event_id = p_event_id
       AND r.registration_status = 'waitlisted'
       AND (
         a.email IS NULL
         OR (a.rule_type = 'restricted' AND (
           a.expires_at <= now()
           OR v_event.starts_at <= now() + interval '24 hours'
         ))
       )
     ORDER BY
       CASE WHEN a.rule_type = 'restricted' AND a.expires_at > now()
         THEN 1 ELSE 0 END,
       r.created_at, r.id
     LIMIT 1
     FOR UPDATE OF r;
    EXIT WHEN v_next IS NULL;

    UPDATE public.registrations
       SET registration_status = 'registered'
     WHERE id = v_next AND registration_status = 'waitlisted';
    v_promoted := v_promoted + 1;
  END LOOP;
  RETURN v_promoted;
END;
$$;
REVOKE ALL ON FUNCTION public.volleyball_phase10_promote_event(uuid)
  FROM PUBLIC, anon, authenticated;

-- A player canceling a reserved spot runs the same eligibility-aware promotion
-- routine; the existing email trigger still queues promoted notifications.
CREATE OR REPLACE FUNCTION public.promote_waitlist_after_cancellation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF OLD.registration_status = 'registered'
     AND NEW.registration_status = 'cancelled' THEN
    PERFORM public.volleyball_phase10_promote_event(NEW.event_id);
  END IF;
  RETURN NEW;
END;
$$;

-- Preserve existing RPC signature, invitation validation, duplicate check,
-- event row locking, payment/phone validation, and management link behavior.
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
  v_access text;
  v_access_expires timestamptz;
  v_normalized_email text := lower(btrim(p_email));
BEGIN
  IF char_length(trim(coalesce(p_name,''))) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'Enter a valid name.';
  END IF;
  IF char_length(trim(coalesce(p_email,''))) NOT BETWEEN 3 AND 254
     OR position('@' IN coalesce(p_email,'')) = 0 THEN
    RAISE EXCEPTION 'Enter a valid email address.';
  END IF;
  IF p_payment_method IS NULL
     OR p_payment_method NOT IN ('venmo','cash','apple_cash') THEN
    RAISE EXCEPTION 'Choose a valid payment method.';
  END IF;
  IF char_length(coalesce(p_phone,'')) > 30 THEN
    RAISE EXCEPTION 'Phone number is too long.';
  END IF;

  SELECT * INTO v_event
    FROM public.events
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
       AND lower(player_email) = v_normalized_email
       AND registration_status <> 'cancelled'
  ) THEN
    RAISE EXCEPTION 'duplicate registration';
  END IF;

  SELECT rule_type, expires_at INTO v_access, v_access_expires
    FROM public.volleyball_player_access WHERE email = v_normalized_email;
  IF v_access = 'banned' THEN
    -- Do not reveal which access rule exists in the browser error.
    RAISE EXCEPTION 'Registration is unavailable for this email. Contact the organizer.';
  END IF;

  -- Fill previously open spots from eligible waitlisted players BEFORE
  -- reserving a spot for a newly arriving player.
  PERFORM public.volleyball_phase10_promote_event(p_event_id);

  IF v_access = 'restricted' AND v_access_expires > now() THEN
    -- Always waitlist a newly registering restricted email, even if a spot
    -- is available within the final 24 hours. The scheduled job can promote it.
    v_status := 'waitlisted';
  ELSIF (SELECT count(*) FROM public.registrations
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
    (p_event_id, trim(p_name), v_normalized_email,
     nullif(trim(coalesce(p_phone,'')),''), p_payment_method, v_status)
  RETURNING id, manage_token INTO v_id, v_token;

  RETURN jsonb_build_object(
    'id', v_id, 'status', v_status, 'manage_token', v_token,
    'eligibility_notice', CASE WHEN v_access = 'restricted'
      AND v_access_expires > now()
      THEN 'Your entry is waitlisted. You may be considered for an available spot within 24 hours of the event, after other eligible waitlisted players.'
      ELSE NULL END
  );
END;
$$;
-- SECURITY DEFINER retains the existing explicit grants; keep them explicit.
REVOKE ALL ON FUNCTION public.register_for_open_gym(uuid,text,text,text,text,uuid)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.register_for_open_gym(uuid,text,text,text,text,uuid)
  TO anon, authenticated;

-- Manual organizer actions are logged with actor email and recorded time.
-- Existing confirmed registrations are deliberately NOT canceled or demoted.
CREATE OR REPLACE FUNCTION public.volleyball_organizer_set_access(
  p_email text, p_action text, p_reason text DEFAULT NULL
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_email text := lower(btrim(coalesce(p_email,'')));
  v_actor uuid := auth.uid();
  v_actor_email text;
  v_previous_rule text;
  v_previous_expires timestamptz;
  v_new_rule text;
  v_new_expires timestamptz;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_event_id uuid;
BEGIN
  IF v_actor IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.organizers WHERE user_id = v_actor
  ) THEN
    RAISE EXCEPTION 'Organizer access required.' USING ERRCODE = '42501';
  END IF;
  IF char_length(v_email) NOT BETWEEN 3 AND 254
     OR position('@' IN v_email) < 2
     OR v_email ~ '[[:space:]]' THEN
    RAISE EXCEPTION 'Enter a valid email address.';
  END IF;
  IF p_action NOT IN ('restrict', 'ban', 'clear') OR p_action IS NULL THEN
    RAISE EXCEPTION 'Invalid access action.';
  END IF;
  IF p_action <> 'clear' AND char_length(v_reason) NOT BETWEEN 3 AND 240 THEN
    RAISE EXCEPTION 'Provide a reason (3–240 characters).';
  END IF;

  SELECT email INTO v_actor_email FROM auth.users WHERE id = v_actor;
  SELECT rule_type, expires_at
    INTO v_previous_rule, v_previous_expires
    FROM public.volleyball_player_access WHERE email = v_email FOR UPDATE;

  IF p_action = 'clear' THEN
    IF v_previous_rule IS NULL THEN
      RAISE EXCEPTION 'No access rule found for this email.';
    END IF;
    DELETE FROM public.volleyball_player_access WHERE email = v_email;
  ELSE
    v_new_rule := CASE WHEN p_action = 'ban' THEN 'banned' ELSE 'restricted' END;
    v_new_expires := CASE WHEN p_action = 'restrict'
      THEN now() + interval '15 days' ELSE NULL END;
    INSERT INTO public.volleyball_player_access
      (email, rule_type, expires_at, reason, created_by, created_by_email,
       updated_by, updated_by_email)
    VALUES
      (v_email, v_new_rule, v_new_expires, v_reason, v_actor, v_actor_email,
       v_actor, v_actor_email)
    ON CONFLICT (email) DO UPDATE SET
      rule_type = EXCLUDED.rule_type,
      expires_at = EXCLUDED.expires_at,
      reason = EXCLUDED.reason,
      updated_at = now(),
      updated_by = v_actor,
      updated_by_email = v_actor_email;
  END IF;

  INSERT INTO public.volleyball_player_access_audit
    (email, action, reason, previous_rule, previous_expires_at,
     new_rule, new_expires_at, actor_id, actor_email)
  VALUES
    (v_email, p_action, nullif(v_reason,''),
     v_previous_rule, v_previous_expires,
     v_new_rule, v_new_expires, v_actor, v_actor_email);

  -- Reassess only future events containing this email on the waitlist.
  -- Unrestricted players always precede restricted players.
  FOR v_event_id IN
    SELECT DISTINCT e.id
      FROM public.events e
      JOIN public.registrations r ON r.event_id = e.id
     WHERE e.status = 'published' AND e.ends_at > now()
       AND r.registration_status = 'waitlisted'
       AND lower(btrim(r.player_email)) = v_email
     ORDER BY e.id
  LOOP
    PERFORM public.volleyball_phase10_promote_event(v_event_id);
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION public.volleyball_organizer_set_access(text,text,text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.volleyball_organizer_set_access(text,text,text)
  TO authenticated;

-- Called only by a database cron task, not browser clients.
-- Safe for repeated calls and zero-open-spot events.
CREATE OR REPLACE FUNCTION public.volleyball_phase10_promote_due()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_event_id uuid;
  v_total integer := 0;
BEGIN
  FOR v_event_id IN
    SELECT e.id FROM public.events e
     WHERE e.status = 'published' AND e.ends_at > now()
       AND EXISTS (
         SELECT 1 FROM public.registrations r
          WHERE r.event_id = e.id AND r.registration_status = 'waitlisted'
       )
       AND (SELECT count(*) FROM public.registrations r
             WHERE r.event_id = e.id AND r.registration_status = 'registered')
           < e.capacity
     ORDER BY e.starts_at, e.id
     LIMIT 200
     FOR UPDATE OF e SKIP LOCKED
  LOOP
    v_total := v_total + public.volleyball_phase10_promote_event(v_event_id);
  END LOOP;
  RETURN v_total;
END;
$$;
REVOKE ALL ON FUNCTION public.volleyball_phase10_promote_due()
  FROM PUBLIC, anon, authenticated;

COMMIT;

-- Supabase Cron / pg_cron is installed and scheduled SEPARATELY in
-- phase10_activate_cron.sql. This isolates all application logic from
-- any extension or scheduling permissions issue.
