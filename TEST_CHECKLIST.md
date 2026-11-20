# Website release and maintenance test checklist

The GitHub Actions suites cover site logic, browser behavior and the local Supabase integration. These manual checks cover production release visibility, native calendar imports, accessibility and account-specific operations.

A signed-out visitor can verify public navigation and the current manager state. Tests that create or change records use an isolated practice session or a designated test event and test address.

## Deployment and public event pages

- [ ] Newest **Deploy Colorado Springs Pickup Volleyball** Actions run succeeds on `main`.
- [ ] Homepage loads at https://cosvolleyball.github.io/ and event details show the correct venue, date, local time, capacity and contribution.
- [ ] Public event URLs (`?event=`) open correctly; private invitations (`?invite=`) work with a valid link and are absent from public lists while logged out.
- [ ] Public rosters show only player names and registration/waitlist status, never emails or personal management tokens.
- [ ] Keyboard skip link reaches the correct public content.

## Organizer workflows

- [ ] Organizer login and logout work; private dashboard data does not reappear when navigating back.
- [ ] Dashboard tabs are keyboard accessible; Left/Right/Home/End switch between Events and Finances.
- [ ] Create/Edit event preserves the correct default date/time/duration and does not change existing registrations.
- [ ] **Duplicate Event** opens a new Draft, copies settings but no date, and never edits the original. If testing a save, use a controlled event and delete it only after verifying.
- [ ] Existing check-in, payments and attendance display correctly on desktop and phones; avoid modifying real records during testing.
- [ ] Restricted/banned player rules and the event audit history remain organizer-only.
- [ ] Finance totals, host balances and historical transaction list load; do not create/void real finance entries as a smoke test.

## Teams Manager

- [ ] The homepage links to `/teams/`. Between sessions, a signed-out visitor sees **No active volleyball session right now**.
- [ ] In the [practice gym](db/release/PHONE_REVIEW.md), confirmed players begin included, waitlisted players are pending, and attendance exceptions change the session roster.
- [ ] A saved private draft becomes visible to the player browser after publication. Completing a game updates both browsers.
- [ ] Closing the session returns the player page to idle and displays the organizer's participation summary.

## Registration, email and calendar

- [ ] With a controlled event, a confirmed registration displays the correct status and **Google Calendar** and **Apple/Outlook (.ics)** options.
- [ ] Google Calendar and imported .ics show the correct Colorado local start/end times and gym. Check DST-sensitive events when relevant.
- [ ] Waitlisted players do **not** see a calendar button suggesting they have a reserved spot.
- [ ] Neither calendar choice includes email addresses, payment instructions, `?invite=` tokens or `?manage=` links.
- [ ] Email confirmation and private registration-management/cancellation links work if doing an authorized controlled end-to-end test.
- [ ] Event cancellation/waitlist promotion are tested only with controlled events; do not manipulate live players to exercise time-based restrictions.

## Phones, accessibility and readability

- [ ] iPhone Safari (~375px), Android Chrome (~360px), and narrow ~320px width: events, dialogs, calendar buttons and organizer controls fit with no clipped controls.
- [ ] Check-in form fields and action buttons are large enough to tap without hitting neighbors; mobile check-in table remains understandable.
- [ ] Registration dialog scrolls while its Close control stays reachable; keyboard and screen-reader users can identify the modal.
- [ ] Success dialog announces registration/waitlist status and does not trap navigation after dismissal.
- [ ] At 200% zoom, pages are readable and controls remain available.
- [ ] When available, verify VoiceOver/TalkBack announces player-specific Cancel actions, the finance Void action and organizer tab selection.

## Security and maintenance

- [ ] No private records, management/invitation URLs, passwords, database credentials or mail-worker tokens are committed.
- [ ] The operator and maintenance guides match the published controls.
- [ ] If deployment fails, check the **specific failing step** before trying a fresh workflow. Do not rerun old SQL migrations or modify Supabase to fix a GitHub Pages publishing failure.
