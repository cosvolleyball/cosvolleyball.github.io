-- PHASE 10: automatic promotion runner (run AFTER phase10_player_access.sql).
-- Supabase Cron uses pg_cron; does not require HTTP tokens, new secrets,
-- Edge Functions, or changes to the existing Gmail email worker.
-- Only the specifically named Phase 10 job is created/replaced.
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
GRANT USAGE ON SCHEMA cron TO postgres;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA cron TO postgres;

SELECT cron.schedule(
  'cos-volleyball-phase10-waitlist',
  '*/5 * * * *',
  'SELECT public.volleyball_phase10_promote_due();'
);

-- Verify the job is active:
SELECT jobname, schedule, active
FROM cron.job
WHERE jobname = 'cos-volleyball-phase10-waitlist';
