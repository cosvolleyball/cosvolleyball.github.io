# Release the Event Day Teams Manager

The manager uses the existing **Colorado Springs Pickup Volleyball** project, reference `mfumtentefcuysibknyl`, and the existing website at `cosvolleyball.github.io`. Starting a session imports the selected event's confirmed and waitlisted registrations into manager-owned tables. Registration, waitlist ordering and payment records continue to belong to the existing site.

[Feature pull request](https://github.com/cosvolleyball/cosvolleyball.github.io/pull/6) · [iPhone practice session](PHONE_REVIEW.md) · [Test coverage](../../TEAM_MANAGER_STAGING_PLAN.md)

## Verify the candidate

1. Use the commit approved for release. Run `python3 db/release/build_release.py --check` to compare the packaged SQL with its reviewed source. Record the commit and the output of `sha256sum db/release/migrations/*_event_day_manager.sql` (macOS users can run `shasum -a 256`).
2. Read the checks attached to PR #6. They exercise the existing site, organizer and player browsers, PostgreSQL contract/concurrency tests, and a release installation on a disposable local Supabase stack. The local phone rehearsal uses the same migration and a synthetic roster.
3. The production compatibility review used catalog metadata and aggregate checks on the COS project. The required event, organizer, registration and Auth fields, Realtime function, and existing registration-to-event deletion rule matched the candidate. Recheck the [read-only preflight](preflight.sql) against the intended project immediately before installing. It checks for incompatible columns, invalid import data and prior or partial manager installations.

## Approved rollout

The owner explicitly approves **both** applying the database migration and merging PR #6. Carry out those operations in this order.

1. Confirm the project reference and the reviewed commit. Apply the single [versioned migration](migrations/20261117022704_event_day_manager.sql) as one transaction through the Supabase migration interface. With a direct connection, use `psql -X -v ON_ERROR_STOP=1 --single-transaction -f db/release/migrations/20261117022704_event_day_manager.sql` against the selected COS database and record the release in its migration history. A preflight failure, privilege failure or lock timeout stops the installation. Investigate the error before retrying.
2. Verify the anonymous `tm_public_snapshot` RPC returns an inactive session on a fresh install. The migration checks grants on manager tables and functions and requests a PostgREST schema reload. Leave real events and registrations untouched during release verification.
3. Merge the approved PR, wait for GitHub Pages to publish, and open **Teams Manager** from the live site's navigation. Check the inactive public view in a signed-out tab. The organizer can open the event picker using their existing website login. Start a live session only when the organizer intends to run the event.

## If the rollout needs to be reversed

A failed migration transaction rolls back its own changes. If the migration succeeded and the release needs to be withdrawn, apply [suspend_access.sql](suspend_access.sql) as one transaction, then revert the frontend merge and wait for Pages. Suspending access revokes the manager RPC grants while retaining sessions and history. The existing registration, payment and organizer workflows use separate functions.

For an approved recovery, correct the cause, apply [restore_access.sql](restore_access.sql) in one transaction, run [the privilege audit](../tests/security_matrix.sql), and verify the anonymous snapshot before restoring the frontend. Use a new versioned migration for database changes after the first installation.
