# Try the Teams Manager on your iPhone

The practice gym starts with a fictional event, **25 registered players**, one waitlisted player and a canceled registration. It runs on a computer connected to the same private Wi-Fi as your phone. The computer and phone need internet access for the site's browser dependencies.

## Start the practice gym

On the computer, have Node.js 24, the Supabase CLI (tested with 2.122.1) and a running Docker Desktop or Docker Engine. A Supabase account or project login is unnecessary. For a fresh copy of the release candidate, run these commands in a terminal.

```sh
git clone --single-branch --branch feature/event-day-manager-foundation https://github.com/cosvolleyball/cosvolleyball.github.io.git cos-day-manager-review
cd cos-day-manager-review
node scripts/phone-review.mjs
```

If you already have the feature branch, run the last command from its root. Leave that terminal open. The first start downloads the local containers. The terminal prints a practice URL and a temporary password. Use those on your phone. If the URL won't load, check that both devices are on the same private Wi-Fi and the computer allows local connections to the page on port 8080 and the local Supabase API on port 54321. Guest Wi-Fi networks can isolate devices.

## Run a short pickup session

1. Open the practice URL in Safari. Tap **Organizer Login**, enter the printed password and sign in with the prefilled practice email. Choose **Public local synthetic game** and start the session.
2. Check that the roster opens with **25 available** and **1 pending**. Mark a registered player as a no-show, bring them back with **Include**, then mark them as a no-show again. Add a walk-in with a fictional name and email. You should be back at 25. The canceled player should be absent.
3. Choose **4 teams** and **6v6**, generate the draft and check the sizes **7, 6, 6, 6**. Try swapping opening slots and undoing the change. Save the draft. Open the practice URL in a Safari **Private** tab as a player. The teams should appear only after you publish in the organizer tab.
4. From the player tab, start both opening games. On the seven-player team, rotate a teammate into the game, then report a winner. Return to the organizer tab and confirm the result appears. Put Safari in the background briefly and return to check that the session catches up.
5. End the rotation early. Choose **6 teams** and **4v4**, generate, save and publish. The sizes should be **5, 4, 4, 4, 4, 4**. End the session. The player tab should show **No active volleyball session right now**, and the organizer should see the final participation totals.

Press **Ctrl+C** in the terminal when finished. The launcher removes the practice database. Starting it again gives you a fresh roster and password. If reporting a problem, the step number, what you saw and which tab you used are enough.
