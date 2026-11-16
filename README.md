# Colorado Springs Pickup Volleyball

Public website: https://cosvolleyball.github.io/

A small GitHub Pages site for publishing pickup volleyball sessions, taking registrations, handling waitlists and cancellations, and giving authorized organizers tools for events, check-in, player restrictions, and group finances.

## Where things live

- `website/` — **only this folder is published** by GitHub Pages. Source HTML, CSS, JavaScript, images and icons.
- `tests/` — isolated, fake-backend frontend regression tests; no live registrations, payments, or messages are created.
- `.github/workflows/deploy.yml` — regression tests, then GitHub Pages deployment from `main`.
- `.github/workflows/pr-regression.yml` — regression tests on proposed changes.
- `.github/workflows/supabase-activity-check.yml` — scheduled activity check; separate from event registration and promotion automation.

## Documentation

- [Maintainer guide](MAINTAINERS_GUIDE.md) — safe edits, deployment, security, recovery.
- [Test checklist](TEST_CHECKLIST.md) — practical post-change and mobile checks.
- [System architecture](ARCHITECTURE.md) — GitHub Pages, Supabase and email infrastructure.
- [Backlog](BACKLOG.md) — outstanding and deferred work.
- [Automated tests](tests/README.md) — local regression-test setup.

This is a **public repository**. Never commit database credentials, service-role keys, email bridge tokens, private player information, or invitation/registration-management links.
