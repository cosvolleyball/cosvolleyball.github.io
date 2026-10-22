# How the system works

## Three services, separate responsibilities

```text
Player's browser
    │
    ├── GitHub Pages: index.html, styles.css, app.js and images
    │
    └── Supabase (public API using publishable key)
          │
          ├── Events, registrations, organizers
          ├── Secure SQL RPCs and Row Level Security
          └── Private email outbox (inaccessible to site visitors)
                  │
                  ▼
           Google Apps Script scheduled worker
                  │ securely contacts Supabase Edge Function
                  ▼
             Gmail / MailApp
                  └── sends registration and status-change emails
```

The scheduled Google Apps Script job retrieves queued email notifications through the authenticated `volleyball-email-bridge` Edge Function. It reports sending outcomes to Supabase. The live site never stores the Gmail bridge token.

## Page and link types

- `/` — Public Upcoming Events; signed-in **organizers** also see private upcoming events.
- `/?dashboard=1` — Organizer dashboard (sign-in required for data).
- `/?event=<uuid>` — Published public event detail page.
- `/?invite=<uuid>` — Published private event detail page, shared only by direct link.
- `/?manage=<uuid>` — Private player registration page, reached from confirmation email; no player account needed.

**Important:** Removing the management link from the registration success banner does **not** remove the `?manage=` route. Its existence is essential to self-cancellation and waitlist promotion.

## Server-side security

- Public event RPC only returns published public events.
- Private event lookups and rosters require the correct invitation token.
- Direct access to contact information is restricted to authenticated organizers through Supabase policies.
- Registration RPC locks the event row to enforce capacity and prevent overbooking.
- A secure trigger automatically promotes the first waitlisted player when a confirmed spot opens.
- Email notifications are queued by database triggers, then sent asynchronously by Gmail worker.
- An INSERT-only trigger limits new registration methods to `venmo` and `cash` without changing older records or the core registration RPC.

## What this release intentionally does not change

- Supabase table schema and existing registration identifiers
- Private invitation tokens and public event URLs
- Organizer accounts, RLS policies, and payment history
- Email queue, Edge Function, Google Apps Script, or schedule
- Existing cancellation link structure and auto-promotion trigger

## Failure and recovery

Registration succeeds independently of email delivery. If Gmail cannot deliver a notification, the queue maintains status information for an organizer to investigate. A player who has lost their email can contact the organizer for manual cancellation. Keep private management tokens out of support screenshots and public issues.
