# Release test checklist

Run against your local server **before** uploading to GitHub, then repeat critical checks on `https://cosvolleyball.github.io/`.

## Website checks

- [ ] Homepage loads; public event cards and event detail pages still work.
- [ ] Open Incognito: private events are not listed, and organizer tools are not visible.
- [ ] Log in as organizer: published private events appear on Upcoming Events with **Copy link** (unchanged).
- [ ] Organizer dashboard (`?dashboard=1`) lists events with **earliest starts first**, public and private.
- [ ] Dashboard has **View event ↗** instead of Copy event link, opening a new browser tab. Private event opens through its invitation URL.
- [ ] Create and edit event modals still work; 6 PM, blank date, quarter-hour minutes, three-hour duration remain.
- [ ] Payment selector offers **Venmo** and **Cash at the gym** only. Other arrangements are coordinated with the host.

## Player and email checks

- [ ] Register a test player with a real email address you control; check the banner clearly says registered / waitlisted.
- [ ] Banner says to check email and **Spam/Junk**, and doesn't reveal or provide a copy button for the management token.
- [ ] Organizer dashboard no longer shows a **Copy manage link** control.
- [ ] The confirmation email contains the private `?manage=` link.
- [ ] Opening that emailed `?manage=` link still shows the player's status and allows cancellation.
- [ ] Cancellation of a confirmed player automatically promotes the next waitlisted player.
- [ ] Waitlist/promotion/cancellation emails still arrive after the scheduled worker runs; `sent` appears in the queue log when accepted for sending.
- [ ] Existing historical Apple Cash entries still display accurately to the organizer; do not modify their data.

## Safety

- [ ] No `service_role` key, Gmail token, or `EMAIL_BRIDGE_TOKEN` exists in GitHub files.
- [ ] The public page never reveals contact details (only player names and waitlist status).
- [ ] New public event and private invitation links still open correctly from the live domain.
- [ ] SQL change to registration methods is installed **before** the new site is deployed.

Use test events and addresses you control. Since emails are live, test registrations can send real email messages. Delete temporary events only after checking the results you need.
