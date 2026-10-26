# Deployment and rollback

## Safe two-commit migration

1. Make a backup (`Code → Download ZIP` on GitHub, or `git branch backup-before-reorganization`).
2. Run the reorganization helper in `prepare` mode. This **copies** existing site files into `website/` and installs the new workflow and guides, without deleting the working root files.
3. Commit and push the prepared directory.
4. In GitHub: `Settings → Pages → Build and deployment → Source → GitHub Actions`.
5. In GitHub: `Actions → Deploy Colorado Springs Pickup Volleyball`, confirm a green successful workflow. If needed, use **Run workflow**.
6. Test https://cosvolleyball.github.io/ , an event page, organizer login, a private invitation link, and Community Finances.
7. Only after successful verification, run the helper's `cleanup --confirmed-live` command and commit/push the root-file removal.

## Rollback

If the new workflow does not successfully publish, the old root-level web files still exist after prepare. Switch `Settings → Pages → Source` back to `Deploy from a branch`, selecting your previous branch and `/ (root)` folder.

**Do not run cleanup until GitHub Actions is publishing the website correctly.** After cleanup, returning to branch-root deployment requires restoring root files from your backup or reverting the cleanup commit.

## Troubleshooting

- Workflow does not run: confirm `main` or `master` matches the repository's branch name; if not, update `deploy.yml` to use your real branch.
- Deployment reports missing files: `website/index.html`, `website/styles.css`, and `website/app.js` must be committed and pushed.
- Old version remains visible: check GitHub Actions for the newest green deployment, then force-refresh the browser.
- Image is missing: keep the same relative file layout underneath `website/` as it was in the repository root.
- Private/invite links should still use the same URL origin and query string, not `/website/` in the browser URL.
- Opening the folder locally directly as `file://` may not work for modules; use a local HTTP server.
