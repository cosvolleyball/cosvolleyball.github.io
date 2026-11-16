# Event Day Manager — staging verification and release gate

**Status:** Preparation only. This file does NOT authorize creating a project, applying SQL to production, deploying the frontend, or merging draft PR #6.

## Approval requirement

A new hosted Supabase project may incur usage or billing. Obtain explicit approval from the owner before creating one. Never use a raw production database copy in staging, and never export real registered-player emails, payments, finance records, organizer credentials, or other sensitive production data into test systems.

## Why dedicated staging matters

The automated SQL tests use disposable PostgreSQL 17 with a deliberately reduced fake version of the existing events, registrations, organizers, and Supabase Auth structures. They establish SQL correctness and useful behavioral contracts, but they are NOT substitutes for a real Supabase project's Data API, JWT authorization, schema exposure, Broadcast connection behavior or mobile browser testing.

The current live website and Supabase project must stay unchanged.

## Staging setup after approval

1. Create a separate Supabase project with synthetic events, player profiles, registration and organizer data; do not enable outbound email, payments, scheduled jobs or webhooks.
2. Recreate only the minimum necessary existing project tables/roles, using dummy account emails. Do not point the staging site at the production database.
3. Review these SQL drafts and their dependencies in order before applying anything to staging:
   - db/drafts/event_day_manager_foundation.sql
   - db/drafts/event_day_manager_rotations.sql
   - db/drafts/event_day_manager_game_actions.sql
   - db/drafts/event_day_manager_player_actions.sql
   - db/drafts/event_day_manager_team_history.sql
   - db/drafts/event_day_manager_roster_adjustments.sql
   - db/drafts/event_day_manager_emergency.sql
   - db/drafts/event_day_manager_intra_team_rotation.sql
   - db/drafts/event_day_manager_realtime.sql
4. Validate actual Auth/JWT roles, RLS rules, SECURITY DEFINER grants and PostgREST exposure; run current Supabase security/performance advisors and fix relevant findings.
5. Use a separate static preview from this branch, not the production Pages site. A nonproduction hostname intentionally refuses a connection unless the page sets window.TEAMS_MANAGER_STAGING_CONFIG with the **staging URL and staging publishable key only**, before teams.mjs loads. Never use a service_role or secret key in client code.
6. Exercise the manager with two browser sessions (one authorized organizer, one anonymous), then simultaneous anonymous clients on distinct devices. Verify real Broadcast delivery, reconnection and the polling fallback.
7. Only after staging success, prepare a clean migration with the then-current Supabase CLI workflow and review a backup/rollback plan. Explicit approval is needed before production migration or merging the PR.

## Functional acceptance matrix

- [ ] Event picker loads public/private published source events, without altering original registrations, waitlists, payments, organizer access or emails.
- [ ] Registered/waitlisted players import as unchecked candidates; canceled entries are not automatically players. Walk-ins join without registering.
- [ ] Normalized email matches a persistent profile, optional skill 1–10, optional gender, and at most two preferred positions. All private attributes inaccessible to anonymous users.
- [ ] 16 available → four teams of four for a full 4v4 round robin, with no borrowing from resting teams.
- [ ] 25 available → four teams of 7/6/6/6 playing 6v6. An extra teammate rotates into a live game and is counted as an actual regular participant.
- [ ] Same 25-person session → next reshuffle into six teams of 5/4/4/4/4/4 playing 4v4, with position balancing disabled.
- [ ] Public events allow five teams of five playing 5v5; private competitive events prohibit 5v5 but still allow 4v4/6v6.
- [ ] 35 available → six teams of 6/6/6/6/6/5 playing 6v6, with optional one-game substitute from the resting team on that SAME court.
- [ ] Six-team courts advance independently. Five-team games enforce cross-court prerequisites and never loan a temporary substitute.
- [ ] Five-team transfers persist until next reshuffle. Repeated public moves of the same player are rejected; an organizer can correct between games.
- [ ] Two simultaneous public starts or opposite-winner reports on the same game accept at most one, preserving the authoritative recorded result.
- [ ] Organizer winner correction updates only unstarted downstream matches.
- [ ] Late arrivals, breaks, departures and replacements never force early reshuffle or interrupt ongoing matches.
- [ ] Emergency injury replacement in a six-team game preserves both players' actual appearances, counting borrowed subs separately.
- [ ] No canceled/unplayed game creates a phantom appearance. Organizer-only session statistics do not affect new session counts.
- [ ] Broadcast signals trigger prompt refresh but carry only revision number and active/inactive flag. Lost connections and backgrounded phones recover automatically.
- [ ] Full original website regression tests remain green, including organizer login, registration, cancellation, waitlist, payments, restrictions and email workflows.

## Security-specific checks

- [ ] Use genuine Supabase anon, authenticated organizer, and authenticated non-organizer JWTs; inspect function and table permissions, not just frontend visibility.
- [ ] Verify public Broadcast contains ONLY revision and active fields; private Teams Manager rows must not be published to Realtime or exposed through direct Data API table reads.
- [ ] Verify real database Broadcast with and without today's message partition; a Broadcast failure must never prevent valid gameplay changes.
- [ ] Stress-test malformed UUIDs, duplicate requests, stale client revisions, player double-booking, and simultaneous cross-court updates.
- [ ] Anonymous match and roster actions are deliberately allowed, but a public no-login action cannot cryptographically prove player consent. Review abuse cases, practical rate limits and organizer recovery.
- [ ] Test the pinned Supabase browser SDK against supported browsers, actual iPhones/Android phones, and the site's CSP.
- [ ] Verify no API error exposes secret credentials, private profiles or sensitive database information.

## Rollback strategy

- Before merging PR #6, no Teams Manager feature is live. An unfinished PR cannot affect the existing GitHub Pages deployment.
- If postrelease frontend errors occur, revert the Teams Manager navigation/page deployment; the original event-registration and financial workflows must remain independent.
- Database rollback requires a separate reviewed SQL plan; reverting a Git commit does NOT revert schema changes. Prefer disabling Teams Manager RPC grants temporarily and retaining audit/history data over unreviewed DROP statements.
- Keep profiles and session history private. Do not automatically erase records on session close.

## Release blockers

1. Approval for a dedicated Supabase staging project or identification of a suitably isolated staging project.
2. Real Supabase JWT/RLS/PostgREST/Broadcast and mobile-device verification.
3. Deliberate testing of abuse/rate-limit recovery for public no-login actions.
4. Independent code review, clean migration/rollback documentation, then explicit production deployment approval.
