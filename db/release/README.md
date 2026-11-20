# Teams Manager database installation and recovery

The website and manager use the **Colorado Springs Pickup Volleyball** Supabase project (`mfumtentefcuysibknyl`). The initial installation is recorded as migration `20261120033246_event_day_manager`. Starting a session reads a published event and its registrations. The manager writes its own rosters, games, appearances and history.

## Release files

| File | Purpose |
| --- | --- |
| [Initial migration](migrations/20261120033246_event_day_manager.sql) | Complete, ordered installation, including dependency checks, grants and PostgREST schema reload |
| [Profile choices and five-team transfers](migrations/20261120094220_team_manager_profiles_and_transfers.sql) | Validates changed profile choices and restricts public transfers to available players who can fill a vacancy between games |
| [Team game participation](migrations/20261120170249_team_game_participation.sql) | Records available teammates and pre-game substitutes at game start and awards credit from the team result |
| [Preflight](preflight.sql) | Read-only checks for the first installation, including source columns, importable data, Realtime and conflicting manager objects |
| [Privilege audit](../tests/security_matrix.sql) | Read-only verification of table access and database functions after installation or recovery |
| [Suspend access](suspend_access.sql) and [restore access](restore_access.sql) | Temporarily disable or restore the manager API while retaining its data |

## Release order

1. In a checkout of the intended release, run `python3 db/release/build_release.py --check` to verify that the initial migration matches its components. The database and local Supabase workflows test the packaged installation on a disposable database. Subsequent schema changes use new, versioned migrations.
2. Check the target project's migration history. A fresh installation requires the existing COS event, registration, organizer, Auth and Realtime services. The preflight rejects an already-installed or partial manager. An installation already present in migration history can proceed directly to verification.
3. Apply a pending migration through the project's migration interface as one transaction. For the initial installation, the database runs the preflight before creating objects and verifies grants before commit. A failed check or lock timeout rolls back the transaction.
4. Verify the public `tm_public_snapshot` RPC. A fresh installation returns `{"active":false}`. The read-only privilege audit can run against an installed manager at any time.
5. Publish the matching website through the GitHub Pages workflow. The **Teams Manager** link on the homepage opens the current session. A signed-in organizer can open the published-event picker. An event session begins when an organizer selects **Start session**.

## Recovery

For a website-only problem, revert the relevant website change and verify the replacement Pages deployment. For a manager database incident, run the access-suspension script in one transaction before withdrawing the frontend. This revokes API access while preserving the manager's history and the site's event and registration records.

After the cause has been corrected, run the access-restoration script in one transaction. Run the privilege audit and verify the anonymous snapshot before restoring the website entry point. The first-install migration is retained as the historical record.

[Maintainer guide](../../MAINTAINERS_GUIDE.md) · [Disposable practice database](PHONE_REVIEW.md)
