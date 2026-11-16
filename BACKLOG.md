# COS Volleyball Website — Backlog

**Last reviewed:** 2026-11-16  
**Site:** https://cosvolleyball.github.io/  
**Status:** Maintenance mode. Phase 11 is deployed; automated tests and a basic phone smoke check have passed.

This is the source of truth for approved and deferred website work. Keep private credentials, player data and bearer links out of this public file.

## Final release verification (not a new feature request)

- **Phase 11:** Duplicate Event, Add to Calendar, and mobile/accessibility fixes were merged into `main` on November 16, 2026.
- Automated tests: **45 passed, 0 failed**. The fresh GitHub Pages deployment workflow succeeded after the first run encountered an artifact-publishing error.
- **Phone smoke check confirmed by site owner (2026-11-16):** site looks usable on their phone; **Duplicate Event** appears in the organizer dashboard, and **Add to Calendar** appears after registration.
- **Not separately verified:** actual calendar import/local-time accuracy, saving a new duplicate Draft without changing the original, and a full VoiceOver/TalkBack or keyboard check. These remain in the [test checklist](TEST_CHECKLIST.md) as targeted checks if needed; do not use real player or payment records to test.
- No further feature development is scheduled. Revisit only when organizer/player feedback, a reproducible issue, or necessary infrastructure maintenance warrants it.

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
