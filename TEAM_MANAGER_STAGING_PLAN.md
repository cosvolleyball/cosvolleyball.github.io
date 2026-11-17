# Event Day Manager — staging verification and release gate

**Status:** Preparation only. This file does NOT authorize creating a project, applying SQL to production, deploying the frontend, or merging draft PR #6.

## No third hosted project — Free plan constraint

The owner uses **both free Supabase project slots** for Colorado Springs Pickup Volleyball and Tournament Builder. **Do not create, pause, transfer, replace, or upgrade either project for Teams Manager testing.** Supabase's two-active-free-project limit is account-wide for owners/admins.

Use the **local Supabase CLI stack with Docker** (or an ephemeral isolated runner) as staging. It runs local Postgres, Auth, PostgREST and Realtime without consuming a hosted Supabase project slot or modifying the existing two projects. Keep the manager's connection pointed exclusively at local or temporary test infrastructure. Never export real registered-player emails, payments, finance records, organizer credentials or other sensitive production data into tests.

## Why dedicated staging matters

The automated SQL tests use disposable PostgreSQL 17 with a deliberately reduced fake version of the existing events, registrations, organizers, and Supabase Auth structures. They establish SQL correctness and useful behavioral contracts, but they are NOT substitutes for a real Supabase project's Data API, JWT authorization, schema exposure, Broadcast connection behavior or mobile browser testing.

The current live website and Supabase project must stay unchanged.

## Automated local Supabase integration (verified)

A separate workflow, `.github/workflows/team-manager-local-supabase.yml`, now starts a **fully local, unlinked Supabase CLI/Docker stack** in GitHub Actions, applies a synthetic version of the existing COS Volleyball event/registration tables and all Teams Manager review SQL, then runs `db/tests/local_supabase_api.mjs` against actual local Supabase Auth and REST APIs. This workflow **passed on the feature branch**. It verifies organizer/non-organizer/anonymous authorization, confirmed-registration auto-inclusion, waitlist visibility without automatic inclusion, one-click no-show exclusion, walk-ins without source registration writes, private draft/publish, and winner-submission validation. No hosted Supabase project is used.

This is not a complete release acceptance: actual Realtime WebSocket delivery, malicious-request throttling, full real-device QA and compatibility with every production schema constraint still require deliberate validation. Neither hosted Supabase project nor GitHub Pages was changed.

## Local staging setup — no new Supabase account/project

1. Use the current Supabase CLI and a Docker-compatible container runtime in a **separate, unlinked** local checkout or GitHub Actions test workspace. Review command arguments with the then-current CLI help. Run `supabase init` and `supabase start` locally (or `npx supabase init` / `npx supabase start` when installed as a dev dependency). **Never run `supabase link`, `db push --remote`, `db reset --linked`, or any remote mutation command.**
2. Create only synthetic events, registrations, organizer accounts and profiles. Do not enable outbound emails, payments, reminders, scheduled jobs or webhooks. The existing fixture is a simplified Postgres model; rebuild the relevant schema with real local Supabase Auth/PostgREST functionality.
3. Review these SQL drafts and their dependencies in order before applying anything to the **local** database:
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
5. Serve a temporary preview from the feature branch pointing only to the locally running Supabase services. A nonproduction hostname refuses a connection unless `window.TEAMS_MANAGER_STAGING_CONFIG` contains the **local API URL and local publishable/anon key**, set before teams.mjs loads. The local credentials are emitted by `supabase status`. Never use a service_role or secret key in client code, and never point previews at either hosted production project. If the local site is accessed from a phone, use an isolated trusted network or port-forwarding arrangement and do not expose the local Supabase stack publicly.
6. Exercise the manager with two browser sessions (one authorized organizer, one anonymous), then simultaneous anonymous clients on distinct devices. Verify real Broadcast delivery, reconnection and the polling fallback.
7. After local Supabase integration testing, prepare a clean migration using the then-current CLI workflow and review a backup/rollback plan. Optional later hosted integration testing would require a separate explicit decision; **no third hosted project or paid upgrade is presumed**. Production migration and merging the PR still require explicit approval.

## Functional acceptance matrix

- [ ] Event picker loads public/private published source events, without altering original registrations, waitlists, payments, organizer access or emails.
- [ ] Confirmed event registrations import **already included as available**; waitlisted players remain visible but excluded pending organizer inclusion; canceled entries are not imported. One-click no-show removes a player from the team's eligible pool and one-click Include restores them. Walk-ins join without registering. The official COS Volleyball registrations, waitlists and payments remain unchanged.
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

1. Real local Supabase JWT/RLS/PostgREST/Broadcast integration testing against a completely isolated CLI/Docker stack; no third hosted project needed.
2. Mobile-device verification on an appropriately isolated test network, without connecting previews to production.
3. Deliberate testing of abuse/rate-limit recovery for public no-login actions.
4. Independent code review, clean migration/rollback documentation, then explicit production deployment approval.
