# Maintaining Colorado Springs Pickup Volleyball

## Structure

- `website/`: The only folder deployed as the public website. Contains the existing HTML, CSS, JavaScript, icons, and images.
- `docs/`: Documentation for organizers and maintainers. Included in the public GitHub repository but **not** deployed as website pages by this workflow.
- `.github/workflows/deploy.yml`: Publishes `website/` to GitHub Pages whenever the default branch is updated.
- `README.md`: Repo overview.

## Normal website update

1. Update only the file(s) you need inside `website/`.
2. Test locally when possible:

   ```bash
   cd website
   python3 -m http.server 8000
   ```

   Visit http://localhost:8000 . Stop with Ctrl+C.

3. Commit and push to your production branch (`main` or `master`).
4. Check the GitHub **Actions** tab for a successful deployment.
5. Refresh https://cosvolleyball.github.io/ and verify the changed behavior.

Do not edit the former root-level `app.js`, `styles.css`, or `index.html` after migration. Those should be removed after the safe cleanup step.

## System boundaries

The public static site uses Supabase for events, organizer authentication, registrations, waitlists, and financial records. Email delivery uses a separate Supabase Edge Function and Google Apps Script process. Reorganizing the repository **does not** change those systems.

## Security

The GitHub repository is public. Do not commit Supabase secret/service-role keys, database credentials, Gmail bridge tokens, organizer passwords, or private records. The Supabase project URL and *publishable* key are intended for browser use; database access is protected by RLS and organizer authentication.

## Public URLs

The website still deploys to the domain root, https://cosvolleyball.github.io/ . GitHub Actions publishes the **contents** of `website/`, not the directory itself. Event and management links using query parameters retain their path.
