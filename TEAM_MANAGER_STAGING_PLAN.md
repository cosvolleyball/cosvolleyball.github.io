# Event Day Teams Manager verification

The release candidate is on [PR #6](https://github.com/cosvolleyball/cosvolleyball.github.io/pull/6). The automated tests use synthetic players and disposable infrastructure. The existing Colorado Springs Pickup Volleyball database supplies real event registrations after the owner approves production rollout.

| Check | What it exercises |
| --- | --- |
| Existing website and manager tests | Registration, organizer workflows, scheduling, attendance distributions, team balance, public controls, sign-out and refresh recovery |
| PostgreSQL 17 contracts | All team counts, both courts, game eligibility, appearance statistics, corrections, substitution and transfer rules, late arrivals, stale requests and rate-limit recovery |
| Clean migration and backout | Install the packaged SQL on a fresh baseline, check roles and privileges, refuse a duplicate install, suspend and restore access, and compare source row fingerprints |
| Browser checks on Chromium and WebKit | Organizer and public controls at desktop and phone widths, touch layout, publication, and organizer access cleanup |
| Local Supabase integration | Actual Auth, PostgREST and Realtime on an unlinked local stack. A signed-in browser and a separate player browser run a 25-player session, including a no-show, walk-in, winner and reshuffle |
| Physical iPhone | Safari touch interaction, private tabs, return from background and visibility at the gym. The organizer can run the practice session on their own phone |

For current automated results, open the **Checks** tab on PR #6. A successful emulated phone check covers the browser engine and viewport. Physical-device results can be reported separately.

[Run the practice session](db/release/PHONE_REVIEW.md) · [Apply or reverse an approved release](db/release/README.md)
