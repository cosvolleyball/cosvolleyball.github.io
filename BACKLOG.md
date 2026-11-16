# COS Volleyball Website — Backlog

**Last reviewed:** 2026-11-16  
**Site:** https://cosvolleyball.github.io/  
**Status:** Maintenance mode, pending final Phase 11 real-device smoke tests.

This is the source of truth for approved and deferred website work. Keep private credentials, player data and bearer links out of this public file.

## Final release verification (not a new feature request)

- **Phase 11:** Duplicate Event, Add to Calendar, and mobile/accessibility fixes were merged into `main` on November 16, 2026.
- Automated tests: **45 passed, 0 failed**. The fresh GitHub Pages deployment workflow succeeded after the first run encountered an artifact-publishing error.
- **Still to confirm on real devices:** create a duplicate Draft without modifying its source, import a calendar event with the correct local time, and verify registration/check-in on mobile and keyboard. Use the [release test checklist](TEST_CHECKLIST.md). Do not manipulate real player or payment data to conduct smoke tests.
- When these checks are accepted, mark Phase 11 fully verified and return to normal maintenance without additional feature work.

## Deferred / low priority

### Annual Season Cleanup
- Revisit after winter, if organizers need end-of-season cleanup.
- Retain financial history and accurately carry forward the community balance.
- Review backup/recovery and deletion scope first. **No automatic data deletion approved.**

### Summer Supabase Automation
- Revisit previously discussed seasonal automation only when its purpose is established.
- The existing scheduled Supabase Activity Check workflow already runs three times daily; do not recreate it unnecessarily.

## As needed

- Address confirmed bug reports, actionable organizer/player feedback, and security/infrastructure maintenance.
- Run targeted mobile/desktop testing when a modified feature warrants it.
- No additional specific feature is approved.

## Recently completed

- **Phase 11 (2026-11-16):** Organizer Duplicate Event creates a new Draft with a blank date; confirmed registrations offer Google/Apple/Outlook calendar options; mobile and accessibility fixes; pull-request regression CI.
- **Regression safeguards (2026-11-16):** Discard stale organizer data after logout/refresh, reject invalid invitation routes, and validate email syntax server-side. **Email-domain existence/ownership verification is not in the active backlog.**
- **Player restrictions and bans (2026-11-14):** 15-day restrictions, permanent bans, organizer audit history and scheduled eligibility-aware waitlist promotion; core workflows verified and test records cleaned up. Long-duration, time-based QA will be revisited only if an issue makes it relevant.

## Maintenance policy

Add new work only when there's a concrete need and clear acceptance criteria; record implementation and verification when completed. `website/` is the only published directory. Keep SQL migrations, secrets and personal data out of this repository.
