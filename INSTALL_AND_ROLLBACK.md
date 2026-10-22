# Installation and rollback

## Prepare (important)

1. Back up your **currently working website folder** (including your configured `app.js`). Keep the backup until testing is complete.
2. In the website package, open `website/app.js`. Copy the existing `SUPABASE_URL` and `SUPABASE_ANON_KEY` values from your working backup to the two placeholders. **Copy only these two public values.**
3. Do not touch the deployed Supabase email Edge Function, Google Apps Script, or `EMAIL_BRIDGE_TOKEN`. This release does not modify any email infrastructure.

## Apply the SQL update

In **Supabase → SQL Editor → New query**, paste and run `sql/limit_new_registrations_to_venmo_or_cash.sql`.

- It adds a small **BEFORE INSERT trigger** that accepts **Venmo and cash for new registrations**; the existing registration RPC stays unchanged.
- Existing rows (including legacy `apple_cash` payment history), events, waitlists, and email-outbox triggers are retained.
- The migration does not replace the registration RPC. Existing capacity checks, invitation tokens, duplicate detection, management tokens, and email triggers continue unchanged.
- Expected SQL Editor output: `Success. No rows returned`.
- Database admins could still update historical payment-method values manually; do not change historical records just to hide an old UI option.

## Test locally first

1. Put **all files inside `website/`** in your existing site folder. Replace `index.html`, `styles.css`, and `app.js`. Keep the existing images and favicons if unchanged.
2. Open Terminal, `cd` to the folder containing `index.html`, and run:

   ```bash
   python3 -m http.server 8000
   ```
3. Visit `http://localhost:8000` and follow the [test checklist](TEST_CHECKLIST.md).
4. If you spot a problem, restore your backup. The SQL update is compatible with older website versions that still submit `venmo` or `cash`.

## Publish through GitHub Pages

1. Open the `cosvolleyball.github.io` repository on GitHub using the dedicated volleyball account.
2. Upload **only `website/index.html`, `website/styles.css`, and `website/app.js`** to the repository root, replacing the same existing files. Assets such as the hero image and favicons can stay in place.
3. Do **not** upload the entire package (`sql/` or `docs/`) to the site root unless you specifically want your documentation to be public. Do not upload any secrets.
4. Commit, then confirm GitHub Pages has deployed the change. Hard refresh (Command+Shift+R) if Chrome serves cached files.
5. Repeat the checklist on `https://cosvolleyball.github.io/`.

## Rollback

- Revert the three web files to the previous commit on GitHub or restore your backup copies.
- If you need to reverse only the payment restriction, run:

   ```sql
   DROP TRIGGER IF EXISTS registrations_limit_new_payment_methods ON public.registrations;
   DROP FUNCTION IF EXISTS public.limit_new_volleyball_payment_methods();
   ```

   Do not rerun older **schema** files, as that can revert unrelated features.
- Do not delete or reset your Supabase database. Existing records are compatible with this update.

## Troubleshooting

- **No events load:** Confirm the two public Supabase configuration values in `app.js`, then inspect Chrome DevTools → Console and Network.
- **Registration errors:** Check the RPC's error text. Only `venmo` and `cash` are supported for *new* registrations in this release.
- **No email arrives:** Check Spam/Junk, Google Apps Script → Executions, and the protected Supabase email queue. Do not create duplicate registrations to force a retry.
- **Lost management email:** Contact `cospickupvolleyball@gmail.com`; an organizer can cancel the registration from the dashboard. The website intentionally no longer displays personal management links.
