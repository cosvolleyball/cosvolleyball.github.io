# Local practice gym

The practice gym runs the complete Teams Manager on a local Supabase stack. It includes a fictional event with 25 confirmed registrations, one waitlist entry and one cancellation. It can be used from a desktop browser or a phone on the same private Wi-Fi network.

## Start and stop

The host computer needs Node.js 24, Docker Desktop or Docker Engine running, and the Supabase CLI on the command path. The integration workflow uses CLI 2.122.1. The first run downloads containers. The browser also needs internet access to load the site's Supabase client.

From the repository root, run the launcher.

```sh
node scripts/phone-review.mjs
```

The terminal prints the practice URL and a temporary organizer password. The login page prefills the practice email. Open the same URL in a separate private window to see the player view. **Ctrl+C** stops the practice stack and removes its database. A new run starts with a fresh roster.

For phone access, both devices use the same private network. The host must accept connections on port 8080 for the website and 54321 for its local API. Guest Wi-Fi can isolate devices from one another.

## Sample session

| Step | Expected result |
| --- | --- |
| Open **Organizer Login**, sign in and start **Public local synthetic game**. | The roster shows 25 available and one pending. The canceled player is absent. |
| Mark a registered player as a no-show, restore that player with **Include**, then mark the no-show again and add a fictional walk-in. | The available count returns to 25. The waitlisted player stays pending. |
| Generate four 6v6 teams. Try an opening-slot swap and undo it, save privately, then publish. | Sizes are 7, 6, 6 and 6. The player view shows the teams after publication. |
| Start both opening games and report a win for the seven-player team. | The organizer sees a regular game and a win for all seven players. Returning to the player tab after backgrounding the browser restores the current game state. |
| End the rotation early and publish six 4v4 teams. Then end the session. | Sizes are 5, 4, 4, 4, 4 and 4. The public view returns to idle and the organizer sees completed-game totals. |

[Event-day controls and rotation rules](../../TEAM_MANAGER_DESIGN.md) · [Automated test coverage](../../TEAM_MANAGER_STAGING_PLAN.md)
