# Running the website tests

From the repository root with Node.js 24 or newer, install the locked test dependencies and run the frontend suite.

```sh
npm ci --prefix tests --ignore-scripts
npm --prefix tests test
```

The suite runs the site's HTML and JavaScript with a fake Supabase client in JSDOM. Coverage includes registration, waitlists, form validation, HTML escaping, duration and daylight-saving changes, finance calculations, stale responses after logout, team balancing, attendance and rotations. The deployment workflow runs this suite before publishing the site.

## Browser checks

From the repository root, run the same browser checks used by the manager's CI workflow.

```sh
npm ci --prefix tests/browser --ignore-scripts
./tests/browser/node_modules/.bin/playwright install --with-deps chromium webkit
TM_BROWSER=chromium node tests/browser/smoke.mjs
TM_BROWSER=webkit node tests/browser/smoke.mjs
```

These checks use a mock backend and exercise real browser layout and interaction. The separate local Supabase integration uses Docker, synthetic registrations, real authentication and a separate anonymous player browser. Its setup and invocation are in the [workflow](../.github/workflows/team-manager-local-supabase.yml).

## Database and device tests

[PostgreSQL contracts](../.github/workflows/team-manager-db-contracts.yml) run the SQL, privilege, concurrency and release-recovery tests against disposable PostgreSQL 17. The baseline fixtures in `db/tests/` are for isolated databases. The [practice gym](../db/release/PHONE_REVIEW.md) runs an event on a local network with a phone or desktop browser. The [manual checklist](../TEST_CHECKLIST.md) covers native calendar imports, assistive technology and workflows that depend on device or email delivery.
