# Colorado Springs Pickup Volleyball

The site handles open-gym registration, waitlists, event-day teams and two-court play. Organizers also manage event settings, check-in, payments, player restrictions and group finances.

| Task | Where to go |
| --- | --- |
| Find an open gym, register or join a waitlist | [Upcoming events](https://cosvolleyball.github.io/) |
| Cancel a registration | Open the private management link in the confirmation email. An organizer can help if the email is unavailable. |
| Create or duplicate an event, record attendance or review finances | [Organizer dashboard](https://cosvolleyball.github.io/?dashboard=1) |
| Run a pickup session or see the current teams, courts and games | [Teams Manager](https://cosvolleyball.github.io/teams/) · [Event-day guide](TEAM_MANAGER_DESIGN.md) |

## Running the site locally

From the repository root, start a static server and open `http://localhost:8000`.

```sh
python3 -m http.server 8000 --directory website
```

This serves the site files, including the homepage's configured connection to Supabase. For a full practice session with fictional players, a local organizer login and two independent browser views, use the [practice gym](db/release/PHONE_REVIEW.md).

## Project references

- [Maintainer guide](MAINTAINERS_GUIDE.md) and [architecture](ARCHITECTURE.md) cover site configuration, deployments, data access and email delivery.
- [Automated tests](tests/README.md), [manager test coverage](TEAM_MANAGER_STAGING_PLAN.md) and the [manual checklist](TEST_CHECKLIST.md) cover website changes.
- [Database installation and recovery](db/release/README.md) describes the manager migration, verification and access recovery.
- [Maintenance notes](BACKLOG.md) record deferred work and feature history.

GitHub Pages publishes the contents of `website/`. Database scripts, tests and guides are available in the repository.
