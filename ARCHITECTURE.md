# How the website works

GitHub Pages serves the static files in `website/`. The browser uses the project's publishable Supabase key. Row security, grants and database functions determine what each visitor can access.

## Routes

| Route | Purpose |
| --- | --- |
| `/` | Public upcoming events. Signed-in organizers can also see private events. |
| `/?dashboard=1` | Organizer sign-in and the event, check-in, access and finance controls |
| `/?event=<uuid>` | A published public event |
| `/?invite=<uuid>` | A published private event accessible through its invitation link |
| `/?manage=<uuid>` | A player's private registration-management and cancellation page, linked from the confirmation email |
| `/teams/` | Public game-day teams and courts, with additional controls for signed-in organizers |

## Registration and email

The registration function locks the event row while checking capacity. It creates a confirmed registration or a waitlist entry. When a spot opens, eligible waitlisted players can be promoted. Public roster functions return display names and status. Access to private-event rosters requires the invitation link, and organizer access controls protect contact details, restrictions and finances.

New registrations accept Venmo and cash. Existing payment entries retain their original recorded methods. Confirmation and status changes are queued in a private email outbox. A scheduled Google Apps Script worker retrieves notifications through the authenticated `volleyball-email-bridge` Supabase Edge Function, sends them through Gmail/MailApp and reports delivery outcomes. A delayed message can be investigated independently of a successful registration. The email's management link supports self-cancellation.

## Event-day data

The manager reads the selected event, registration roster and organizer membership from the existing COS database. Dedicated manager tables hold profiles, session attendance, rotations, teams, games, appearances and audit history. The browser uses scoped functions to read public court information and submit permitted game actions. Organizer functions also verify membership in `public.organizers`.

Realtime broadcasts signal that the session changed. Clients fetch the latest snapshot and poll for missed updates. Database checks serialize competing court actions. Email addresses, profile attributes and participation totals are private to organizers. Public session information includes the live event title, published rosters, courts and games.

## Recovery

A failed static-site release can be reverted and republished through GitHub Pages. The manager API can be suspended or restored separately from the website while retaining its tables and history. Private invitation and registration-management tokens are bearer credentials and belong outside public issues, logs and calendar exports.

[Site maintenance](MAINTAINERS_GUIDE.md) · [Manager database recovery](db/release/README.md)
