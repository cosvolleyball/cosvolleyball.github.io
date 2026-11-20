ALTER TABLE public.volleyball_player_access
  DROP CONSTRAINT volleyball_player_access_reason_check,
  ADD CONSTRAINT volleyball_player_access_reason_check CHECK (char_length(btrim(reason)) <= 240);

CREATE OR REPLACE FUNCTION public.volleyball_organizer_set_access(p_email text, p_action text, p_reason text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_email text := lower(btrim(coalesce(p_email,'')));
  v_actor uuid := auth.uid();
  v_actor_email text;
  v_previous_rule text;
  v_previous_expires timestamptz;
  v_new_rule text;
  v_new_expires timestamptz;
  v_reason text := regexp_replace(coalesce(p_reason, ''), '^[[:space:]]+|[[:space:]]+$', '', 'g');
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
  IF p_action <> 'clear' AND char_length(v_reason) > 240 THEN
    RAISE EXCEPTION 'The reason must be 240 characters or fewer.';
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
$function$;

CREATE OR REPLACE FUNCTION public.register_for_open_gym(p_event_id uuid, p_name text, p_email text, p_phone text, p_payment_method text, p_invite_token uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_event public.events%ROWTYPE;
  v_status text;
  v_id uuid;
  v_token uuid;
  v_access text;
  v_reason text;
  v_access_expires timestamptz;
  v_email_local text;
  v_email_domain text;
  v_email_label text;
  v_normalized_email text := lower(btrim(p_email));
BEGIN
  IF char_length(trim(coalesce(p_name,''))) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'Enter a valid name.';
  END IF;
  -- Match the website's supported email syntax at the API boundary.
  -- This checks format only, not domain existence or mailbox ownership.
  IF v_normalized_email IS NULL
     OR char_length(v_normalized_email) NOT BETWEEN 3 AND 254
     OR char_length(v_normalized_email) - char_length(replace(v_normalized_email, '@', '')) <> 1
     OR v_normalized_email ~ '[[:space:]]' THEN
    RAISE EXCEPTION 'Enter a valid email address.';
  END IF;
  v_email_local := split_part(v_normalized_email, '@', 1);
  v_email_domain := split_part(v_normalized_email, '@', 2);
  IF char_length(v_email_local) NOT BETWEEN 1 AND 64
     OR v_email_local !~ $email_local$^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+$$email_local$
     OR left(v_email_local, 1) = '.'
     OR right(v_email_local, 1) = '.'
     OR position('..' IN v_email_local) > 0
     OR char_length(v_email_domain) > 253
     OR position('.' IN v_email_domain) = 0 THEN
    RAISE EXCEPTION 'Enter a valid email address.';
  END IF;
  FOREACH v_email_label IN ARRAY string_to_array(v_email_domain, '.') LOOP
    IF char_length(v_email_label) NOT BETWEEN 1 AND 63
       OR v_email_label !~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$' THEN
      RAISE EXCEPTION 'Enter a valid email address.';
    END IF;
  END LOOP;
  -- The final label follows the same alphabetic 2–63 character rule as the form.
  IF v_email_label !~ '^[a-z]{2,63}$' THEN
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

  SELECT rule_type, expires_at, nullif(regexp_replace(reason, '^[[:space:]]+|[[:space:]]+$', '', 'g'), '')
    INTO v_access, v_access_expires, v_reason
    FROM public.volleyball_player_access WHERE email = v_normalized_email;
  IF v_access = 'banned' THEN
    RAISE EXCEPTION 'You are banned from registering for COS Volleyball events.'
      USING ERRCODE = 'VB001', DETAIL = coalesce(v_reason, '');
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
      THEN concat_ws(' ', 'An active restriction placed you on the waitlist.',
        CASE WHEN v_reason IS NOT NULL THEN 'Organizer’s reason: ' || v_reason END,
        'You may be considered for an available spot within 24 hours of the event, after other eligible waitlisted players.')
      ELSE NULL END
  );
END;
$function$;
