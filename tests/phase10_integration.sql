\set ON_ERROR_STOP on
-- Isolated PostgreSQL 16 integration tests: NO connection to live Supabase.
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
CREATE TABLE auth.users(id uuid PRIMARY KEY, email text);
CREATE TABLE public.organizers(user_id uuid PRIMARY KEY REFERENCES auth.users(id));
CREATE TABLE public.events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL, venue text NOT NULL DEFAULT 'Test gym',
  starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'published',
  visibility text NOT NULL DEFAULT 'public',
  invite_token uuid NOT NULL DEFAULT gen_random_uuid(),
  capacity integer NOT NULL
);
CREATE TABLE public.registrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES public.events(id),
  player_name text NOT NULL, player_email text NOT NULL,
  player_phone text, payment_method text NOT NULL,
  registration_status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  manage_token uuid NOT NULL DEFAULT gen_random_uuid()
);
CREATE TABLE public.test_emails (registration_id uuid, change text);
CREATE FUNCTION public.test_email_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.registration_status = 'waitlisted' AND NEW.registration_status = 'registered' THEN
    INSERT INTO public.test_emails VALUES (NEW.id, 'promoted');
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER test_emails AFTER UPDATE OF registration_status
  ON public.registrations FOR EACH ROW EXECUTE FUNCTION public.test_email_trigger();
-- The cancellation trigger is installed just after the migration.

INSERT INTO auth.users VALUES
  ('11111111-1111-1111-1111-111111111111','organizer@example.test');
INSERT INTO public.organizers VALUES
  ('11111111-1111-1111-1111-111111111111');
SELECT set_config('request.jwt.claim.sub',
  '11111111-1111-1111-1111-111111111111', false);
INSERT INTO public.events(title, starts_at, ends_at, capacity) VALUES
 ('Future', now()+interval '48 hours', now()+interval '50 hours', 2),
 ('Ban-test', now()+interval '48 hours', now()+interval '50 hours', 1),
 ('Expire-test', now()+interval '72 hours', now()+interval '74 hours', 1);

\i sql/phase10_player_access.sql

CREATE TRIGGER registrations_promote_after_cancel AFTER UPDATE OF registration_status
  ON public.registrations FOR EACH ROW EXECUTE FUNCTION public.promote_waitlist_after_cancellation();

-- Restriction must be 15 days, and only authorized organizer can write it.
SELECT public.volleyball_organizer_set_access(
  ' Restrict@Example.Test ', 'restrict', 'Repeated no-shows');
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.volleyball_player_access
     WHERE email='restrict@example.test' AND rule_type='restricted'
       AND expires_at BETWEEN now()+interval '14 days 23 hours'
                          AND now()+interval '15 days 1 hour'
  ) THEN RAISE EXCEPTION '15-day restriction not saved correctly'; END IF;
  IF has_table_privilege('anon','public.volleyball_player_access','SELECT')
     OR has_function_privilege('anon',
       'public.volleyball_organizer_set_access(text,text,text)','EXECUTE')
  THEN RAISE EXCEPTION 'Anonymous access grant regression'; END IF;
END;
$$;

-- Restricted player joins waitlist even when capacity is available.
SELECT public.register_for_open_gym(
  (SELECT id FROM public.events WHERE title='Future'),
  'Restricted', 'restrict@example.test', NULL, 'venmo', NULL);
DO $$
BEGIN
  IF (SELECT registration_status FROM public.registrations
       WHERE player_email='restrict@example.test') <> 'waitlisted' THEN
    RAISE EXCEPTION 'Restricted signup bypassed waitlist'; END IF;
END;
$$;

-- Normal players fill spots and any normal waitlist is prioritized.
SELECT public.register_for_open_gym((SELECT id FROM public.events WHERE title='Future'),
  'Holder A','holda@example.test',NULL,'cash',NULL);
SELECT public.register_for_open_gym((SELECT id FROM public.events WHERE title='Future'),
  'Holder B','holdb@example.test',NULL,'cash',NULL);
SELECT public.register_for_open_gym((SELECT id FROM public.events WHERE title='Future'),
  'Normal Waiting','normalwait@example.test',NULL,'cash',NULL);
UPDATE public.registrations SET registration_status='cancelled'
 WHERE player_email='holda@example.test';
DO $$
BEGIN
  IF (SELECT registration_status FROM public.registrations
       WHERE player_email='normalwait@example.test') <> 'registered'
     OR (SELECT registration_status FROM public.registrations
       WHERE player_email='restrict@example.test') <> 'waitlisted'
  THEN RAISE EXCEPTION 'FIFO priority ahead of restricted players failed'; END IF;
END;
$$;
UPDATE public.registrations SET registration_status='cancelled'
 WHERE player_email='holdb@example.test';
DO $$
BEGIN
  IF (SELECT registration_status FROM public.registrations
       WHERE player_email='restrict@example.test') <> 'waitlisted'
  THEN RAISE EXCEPTION 'Restricted player promoted early'; END IF;
END;
$$;
-- Scheduler now inside 24 hours -> restricted is eligible for available spot.
UPDATE public.events SET starts_at=now()+interval '23 hours'
 WHERE title='Future';
SELECT public.volleyball_phase10_promote_due();
DO $$
BEGIN
  IF (SELECT registration_status FROM public.registrations
       WHERE player_email='restrict@example.test') <> 'registered'
   OR NOT EXISTS (
      SELECT 1 FROM public.test_emails t JOIN public.registrations r
        ON r.id=t.registration_id WHERE r.player_email='restrict@example.test'
          AND t.change='promoted'
   ) THEN RAISE EXCEPTION '24-hour promotion/email trigger failed'; END IF;
END;
$$;

-- Ban stops NEW registration, even when there is capacity.
SELECT public.volleyball_organizer_set_access('banned@example.test','ban','Permanent ban');
DO $$
BEGIN
  BEGIN
    PERFORM public.register_for_open_gym(
      (SELECT id FROM public.events WHERE title='Ban-test'),
      'Banned','banned@example.test',NULL,'cash',NULL);
    RAISE EXCEPTION 'Banned signup unexpectedly succeeded';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'Registration is unavailable%' THEN RAISE; END IF;
  END;
END;
$$;

-- Ban on an existing waitlisted player blocks later promotion; clearing
-- the ban causes immediate eligibility-aware promotion.
SELECT public.register_for_open_gym((SELECT id FROM public.events WHERE title='Ban-test'),
  'Holder','holder@example.test',NULL,'cash',NULL);
SELECT public.register_for_open_gym((SELECT id FROM public.events WHERE title='Ban-test'),
  'Old Wait','oldwait@example.test',NULL,'venmo',NULL);
SELECT public.volleyball_organizer_set_access('oldwait@example.test','ban','Manual ban');
UPDATE public.registrations SET registration_status='cancelled'
 WHERE player_email='holder@example.test';
DO $$
BEGIN
  IF (SELECT registration_status FROM public.registrations
       WHERE player_email='oldwait@example.test') <> 'waitlisted'
  THEN RAISE EXCEPTION 'Banned waitlist promoted'; END IF;
END;
$$;
SELECT public.volleyball_organizer_set_access('oldwait@example.test','clear','Lifted');
DO $$
BEGIN
  IF (SELECT registration_status FROM public.registrations
       WHERE player_email='oldwait@example.test') <> 'registered'
  THEN RAISE EXCEPTION 'Unban failed to promote on open spot'; END IF;
END;
$$;

-- Expired restriction becomes unrestricted automatically, even >24h before.
SELECT public.volleyball_organizer_set_access(
  'expire@example.test','restrict','Repeated no-shows');
SELECT public.register_for_open_gym(
  (SELECT id FROM public.events WHERE title='Expire-test'),
  'Expires','expire@example.test',NULL,'venmo',NULL);
UPDATE public.volleyball_player_access SET expires_at=now()-interval '1 second'
 WHERE email='expire@example.test';
SELECT public.volleyball_phase10_promote_due();
DO $$
BEGIN
  IF (SELECT registration_status FROM public.registrations
       WHERE player_email='expire@example.test') <> 'registered'
  THEN RAISE EXCEPTION 'Expiration did not restore eligibility'; END IF;
  IF (SELECT count(*) FROM public.volleyball_player_access_audit) < 5
  THEN RAISE EXCEPTION 'Access audit missing entries'; END IF;
END;
$$;

-- Direct non-organizer mutation must fail through RPC.
SELECT set_config('request.jwt.claim.sub', '', false);
DO $$
BEGIN
  BEGIN
    PERFORM public.volleyball_organizer_set_access(
      'other@example.test','ban','Not authorized');
    RAISE EXCEPTION 'Unauthorized change succeeded';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL;
  END;
END;
$$;

-- Test the targeted rollback without touching production data.
\i sql/phase10_rollback.sql

DO $$
BEGIN
  IF to_regprocedure('public.volleyball_phase10_promote_event(uuid)') IS NOT NULL
  THEN RAISE EXCEPTION 'Rollback retained promotion function'; END IF;
  IF to_regclass('public.volleyball_player_access_audit') IS NULL
  THEN RAISE EXCEPTION 'Rollback removed audit history'; END IF;
  IF (SELECT count(*) FROM public.registrations) < 5
  THEN RAISE EXCEPTION 'Rollback lost registrations'; END IF;
END;
$$;
SELECT 'Phase 10 isolated integration and rollback checks passed' AS result;
