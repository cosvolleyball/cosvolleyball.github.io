# Frontend regression tests

Requires Node 24 or newer. From this directory:

```sh
npm ci --ignore-scripts
npm test
```

The tests execute the actual website HTML and JavaScript in JSDOM with a fake
Supabase client. They never contact the live database, create registrations,
send email, or require organizer credentials. Date tests use America/Denver.

Coverage includes form validation, HTML escaping, duration/DST handling,
finance pagination and calculations, invalid links, and delayed responses
after logout or a newer dashboard refresh. Failures exit with a nonzero status;
the deployment workflow runs this suite before publishing the website.

JSDOM does not render layout. These checks do not replace visual/mobile testing
or real browser authentication tests. Database regression checks are maintained
separately from the public repository.
