# Maintaining the COS Volleyball website

## Repository map

| Location | Responsibility |
| --- | --- |
| `website/index.html`, `styles.css`, `app.js` | Event listings, registration, organizer dashboard, finance tools and shared styling |
| `website/teams/` | Event-day page, team scheduling, balancing, game controls and manager styling |
| `website/` image and icon files | Hero image, favicon and touch icon |
| `tests/` | Site regression tests, manager logic tests and browser checks |
| `db/drafts/` | Ordered SQL components of the initial Teams Manager migration |
| `db/release/` | Versioned manager migration, preflight, verification and recovery scripts |
| `db/tests/` and `scripts/` | Synthetic fixtures, database contracts and the practice gym launcher |
| `.github/workflows/` | Pull-request checks, GitHub Pages deployment and the scheduled activity check |

## Common edits

- Theme colors come from `:root` in `website/styles.css`. The manager's styles are scoped in `website/teams/teams.css`.
- The main page's forms and help text are in `website/index.html`. Element IDs are shared with the handlers in `website/app.js`.
- Event defaults are set in the editor markup and `clearEditor()`. The default start time is 6 PM, with a blank date, a three-hour duration, Hillside Community Center, a $5 contribution and 24 spots.
- The registration form's payment choices are under `#payment-method`. Website confirmation text lives in the signup handler. The separate email services generate the actual confirmation email.
- `openDuplicateEventEditor()` copies event settings into a new draft. The new event starts with a blank date and receives its own ID and invitation information.
- `googleCalendarLink()` and `createIcsCalendar()` use the event's start and end instants. Calendar exports contain public event details.
- `loadEvents()`, `loadEventRoster()`, `openSignup()` and `loadManageRegistration()` handle public player workflows. `loadAdminEvents()` and `refreshAdmin()` load organizer data.

## Preview and deploy

1. Serve the static frontend from the repository root with `python3 -m http.server 8000 --directory website`, then open `http://localhost:8000`. The homepage uses its configured Supabase service. The [local practice gym](db/release/PHONE_REVIEW.md) supplies an isolated manager backend for interactive testing.
2. Run the [automated tests](tests/README.md) and the relevant [manual checks](TEST_CHECKLIST.md). Pull requests show applicable frontend, browser, database and local Supabase workflows.
3. Database changes use the [manager migration process](db/release/README.md) before the matching frontend is published.
4. Merge the tested change into `main`. **Deploy Colorado Springs Pickup Volleyball** runs frontend regressions and publishes the contents of `website/` to GitHub Pages. Verify the published route from the homepage.

## Data and access

Public pages use a publishable key. Organizer operations require authentication and authorization in Supabase. Invitation and registration-management links grant access to a specific event or registration. Production exports, private player contact details, service-role keys, database passwords and `EMAIL_BRIDGE_TOKEN` belong outside this public repository. Manager migrations contain schema and functions. Test fixtures use fictional players.

## Troubleshooting

| Symptom | Checks |
| --- | --- |
| Site still shows a previous version | Check the commit and outcome of the latest Pages deployment, then reload the published URL. |
| A public event is missing | Check the event's status and visibility, the public event feed and Supabase availability. |
| Registration succeeds but email is delayed | Check the spam folder, the email outbox and the separate delivery worker. The organizer can manage a registration even if the email is unavailable. |
| Teams Manager shows no active session | This is the expected public state between events. A signed-in organizer can choose a published event and start the session. |
| Pages cannot locate the uploaded artifact | Start a fresh **Deploy Colorado Springs Pickup Volleyball** workflow run for `main` and inspect its upload and deployment steps. |
| An update needs to be withdrawn | Revert the website change and wait for the replacement Pages deployment. Manager API incident recovery is documented separately. |

[Architecture](ARCHITECTURE.md) · [Database recovery](db/release/README.md) · [Maintenance notes](BACKLOG.md)

### Event-day checklist

The organizer dashboard links to the event-day checklist in Teams Manager. Starting a session imports confirmed registrations and keeps waitlisted players pending. During an active session the checklist shows the registered count, no-shows, included walk-ins, and the headcount used to generate teams. Attendance changes apply to the session roster.

Opening **Unpaid players** refreshes the payment list for available players with linked registrations. Selecting the received method and choosing **Mark paid** updates the same registration used by the organizer dashboard. Walk-ins without a registration have no payment record in this list. **Go to team setup** opens the format and team-count controls for the current headcount.
