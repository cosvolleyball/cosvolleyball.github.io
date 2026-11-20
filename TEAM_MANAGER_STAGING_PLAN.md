# Testing the Event Day Teams Manager

The automated suites use fictional players and disposable databases. The local integration suite runs the same versioned migration used for the production manager.

| Check | What it exercises |
| --- | --- |
| [Frontend regression workflow](.github/workflows/pr-regression.yml) | Existing site workflows, scheduling, team balance, roster distributions, organizer controls, sign-out and interrupted refreshes |
| [Database contracts](.github/workflows/team-manager-db-contracts.yml) | All rotation schedules, game eligibility, participation, corrections, late arrivals, competing requests and rate-limit recovery on PostgreSQL 17 |
| Migration and access recovery in the database contracts | Install on a fresh baseline, verify grants, reject a duplicate installation, suspend and restore access, compare source event and registration records |
| [Chromium and WebKit](.github/workflows/team-manager-browser-qa.yml) | Team results with extra players, five-team transfers, organizer attendance, floating position checkboxes and logout at desktop and phone widths |
| [Local Supabase integration](.github/workflows/team-manager-local-supabase.yml) | Real local Auth, PostgREST and Realtime. A signed-in organizer and anonymous player run a 25-player session, record a winner, reshuffle and close it. |
| [Phone practice gym](db/release/PHONE_REVIEW.md) | Touch interaction on a physical device, private tabs and recovery after backgrounding the browser |

Pull requests list applicable workflow results under **Checks**. Repository-wide runs are available in [GitHub Actions](https://github.com/cosvolleyball/cosvolleyball.github.io/actions).

[Local test commands](tests/README.md) · [Database installation and recovery](db/release/README.md)
