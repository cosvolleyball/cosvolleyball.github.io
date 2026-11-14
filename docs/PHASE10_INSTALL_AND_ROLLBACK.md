# Phase 10 — Player access rules (NOT YET DEPLOYED)

## Scope
Organizer-managed **15-day email restrictions** and **permanent email bans**.
Rules apply to new registrations and automatic waitlist promotions, not to
previously confirmed spots. Organizers manually choose when to restrict/ban;
a no-show does not automatically create a restriction.

- Restricted: new registrations are **always waitlisted**, even when capacity
  is available. A restricted waitlisted player is eligible after other normal
  waitlisted players once the event is within 24 hours of starting. A rule
  expires **15 days after it is set**, at which point normal eligibility returns.
- Banned: new registration is rejected with a generic message; existing
  waitlist entries cannot be automatically promoted while the ban is active.
- Removed/expired: the eligible waitlisted player can be promoted if a spot
  exists, normal waitlist first. Removal checks affected events immediately;
  expiry and 24-hour windows are checked by a recurring database job.
- Restrictions use **normalized email addresses** only. They are not an identity
  verification system; someone can attempt to use another email.
- Already registered players are **not automatically demoted/cancelled** when
  a rule is added. Organizers can still cancel them manually if appropriate.
- Database tables and the audit trail are organizer-only. No restriction status
  is added to the public roster. The registration confirmation explains a
  restricted waitlist entry, while ban errors don't disclose the type of rule.
- Existing waiting/registration/promotion/cancellation emails continue to be
  generated through the unchanged queue and Google Apps Script worker.

## Files and installation sequence

1. Confirm that the existing GitHub recovery branch and private Supabase
   exports are accessible. Do not upload database exports or credentials to
   the public repository.
2. Wait for **Phase 10 Safety Checks** on the pull request to pass.
   They include JavaScript parsing, SQL parsing, and PostgreSQL integration
   tests (eligibility, bans, expiry, audit, rollback). The checks do not touch
   the real database.
3. In the **live project's** Supabase SQL Editor, open and run
   **sql/phase10_player_access.sql** exactly once. If it errors, STOP:
   the migration runs inside BEGIN/COMMIT and should roll back as a unit.
   Do not merge the website PR yet.
4. Next run **sql/phase10_activate_cron.sql** exactly once. It enables
   Supabase Cron if needed, then installs the single five-minute job
   **cos-volleyball-phase10-waitlist**. A failed Cron activation does not
   undo Step 3, so resolve it **before merging**. The SQL returns one job
   row with active=true. Supabase Dashboard → Integrations → Cron is an
   alternate verification point.
5. After both SQL steps succeed, merge the Phase 10 pull request into
   **main** to deploy the organizer interface and registration notice.
   GitHub Pages automatically deploys only from main/master.
6. Minimal targeted live verification:
   - Sign in as organizer; open Player restrictions & bans. Add a 15-day
     test restriction for an **unused, controlled email address** (not an
     existing player's), then remove it. Check the audit entry. Do not test
     against an actual player's email or generate an unwanted real signup.
   - If you choose to verify actual registration, create a private test
     event and controlled test email, confirm restricted signup remains
     waitlisted, then clean up the test event and rule. This is optional
     and may generate real email notifications.

## If something fails

- Before merge: **do not merge** until both SQL scripts succeed. The site
  remains on the earlier version until you merge.
- After merge: revert the Phase 10 website commit (or restore the GitHub
  recovery branch), then run **sql/phase10_rollback.sql** in Supabase.
  That script unschedules only the Phase 10 cron job and restores the original
  registration and waitlist logic. It retains all event, registration,
  finance, payment, attendance, email, access, and audit rows.
- **Important:** rollback **disables restriction/ban enforcement**. Previously
  blocked emails will again be eligible according to the old rules.
- Do not drop pg_cron: other services may use it. Do not run the full
  schema.sql backup against the live project.
- This targeted rollback isn't a full disaster-recovery restore. Existing
  separate backups cover database data and supporting email components.

## Operational notes

The job runs every five minutes. Time-based promotions can therefore occur
up to ~5 minutes after a rule expires or the 24-hour window opens.
It only promotes into currently open spots of published, unended events.
An already full event does not force anyone off the confirmed roster.
The ordinary cancellation trigger still promotes an eligible player
immediately, preserving queue email notifications.

The access table retains expired rows and audit history for accountability.
Only active restrictions and bans appear in the dashboard's "Current rules"
list; up to 40 recent changes appear under "Recent access changes".
All organizers share the same permissions and can remove each other's rules.
