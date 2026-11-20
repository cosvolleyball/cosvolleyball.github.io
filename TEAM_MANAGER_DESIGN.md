# Event Day Teams Manager — living design

The release candidate is on [PR #6](https://github.com/cosvolleyball/cosvolleyball.github.io/pull/6). This document describes the organizer and player workflows.

## Product boundary

- Add a **Teams Manager** link in the existing navigation, replacing the existing external **Teams** link; no second site or repo.
- One shared public view of **one active session at a time**, attached to a published event selected by an authorized organizer. The source event may be public or private.
- Use the **existing COS Volleyball Supabase project** and the organizer-selected event's actual `public.registrations` to populate the attendance review; **never** use the Tournament Builder database or create another independent player registry.
- Import both registered and waitlisted entries (dedupe on normalized player email), excluding cancellations. **Confirmed registered players start included/assumed present** so the organizer does not have to individually check everyone in. **Waitlisted players appear in the roster but start excluded** until the organizer includes those who arrive.
- Organizer handles **exceptions only**: one-click mark a no-show (excluded from team generation), restore an arrival to present, include a waitlisted player, and add/check-in walk-ins. No-shows, breaks and Teams Manager attendance changes affect only manager tables, **never** the official registration, waitlist, payment or finance records.
- Registration order and waitlist promotion order do not determine team assignments or substitutions.
- Registration, cancellation, payment, finance, email notification, access restriction and Supabase Cron workflows must remain unchanged.
- When no session is active, show "No active volleyball session right now."
- Organizer-only UI reveals private profile fields and participation statistics; public UI reveals only display names, teams, courts, games, and permitted game/substitution actions.

## Player profiles and availability

- Persistent organizer-managed profile with a UUID and **normalized email unique lookup key** (lowercase + trim). The internal UUID survives an email change or merge.
- Optional skill (integer 1–10), optional gender, and up to two preferred positions. Missing values never exclude a player or create assumed values.
- Only organizers enter, update, or link profiles. Updates during an event affect future team generations, not games already underway.
- Attendance statuses include assumed present, pending/waitlisted, no-show/absent, waiting, break and departed. Attendance belongs to Teams Manager, independent of event registration's attendance/payment fields. Present/waiting are eligible for new teams; absent/pending are not.
- Departures and breaks create openings; **do not reshuffle before the rotation ends**.
- Returning from a break reclaims a temporarily substituted spot **between games** unless a late arrival has already filled the spot for the rotation. In that case the returning player is waiting.
- Late arrivals wait when teams are full. They may fill an opening between games on an eligible team; never interrupt a live game. Marking a permanent replacement is different from recording a one-game substitute.

## Team generation

- Organizers generate **preview drafts**, regenerate as often as needed, manually swap/move players, undo local edits, and explicitly publish.
- Independent toggles: skill balance, gender balance, preferred-position balance. Position balancing is disabled when the **playing format is 4v4**.
- Generate balanced teams with randomized tie-breaking and penalties for repeated teammate pairings across the *current session*. Previous sessions do not affect participation/game counts.
- **Before every organizer-initiated reshuffle**, recount currently checked-in/available players and ask for the **number of teams (4/5/6)** and the **playing format (4v4/5v5/6v6)**. These are separate choices, stored **on each rotation**, not fixed for the event. Display the exact roster distribution and flag options requiring temporary borrowed players.
- Example **25 available**: six 4v4 teams of sizes **5,4,4,4,4,4**, five 5v5 teams of **5 each** (public events only), or four 6v6 teams of sizes **7,6,6,6**. Private competitive event formats remain limited to 4v4/6v6.
- Teams with an extra roster member (e.g., seven for 6v6 or five for 4v4) can rotate a **teammate within a live game** using a one-for-one regular lineup change, without borrowing from a different team. Both players receive one **regular** appearance if they actually take the court; re-entry never counts twice. This does not change the existing five-team transfer / six-team temporary-sub rules.
- For seven-player 6v6 rosters and optional position balancing, look for compatible **front-row/back-row shared-role pairings** (e.g., middle blocker and libero) and show organizer-only suggestions. Keep preferred-position attributes private, never hardcode an assumption that every team must have a libero/middle pairing, and do not force volleyball position swaps without players agreeing.
- Do not require every roster to be divisible by the number of on-court positions. Distribute all present, available players into team rosters when feasible.
- A roster may contain one or more extra players (e.g., five-person roster in a 4v4 match); the **actual lineup for each match** determines who played. Between-match lineup rotation must give extra roster members opportunities without midgame forced swaps.
- Organizers may override the recommended distribution and court assignments before publication.
- Once published, the team structure stays fixed until the rotation finishes or an organizer ends it early. Explicit departures, replacements, and game-specific temporary substitutes (six-team format) or between-game permanent transfers (five-team format) are exceptions; they are not a full team reshuffle.

## Schedules — validated mathematical core

A **game round** is one scheduled game per active court. A **rotation** comprises three such rounds and ends in a new team reshuffle.

### Four teams: full round robin

| Round | Court 1 | Court 2 |
|---|---|---|
| 1 | A–B | C–D |
| 2 | A–C | B–D |
| 3 | A–D | B–C |

Six unique matches. Every team plays **three**, no resting team while both courts play. This means **resting-team substitution is unavailable** in a standard four-team round; extra roster players may rotate into a team's on-court lineup **during or between** matches as ordinary teammates.

### Six teams: three teams permanently assigned per court

| Round | Court 1 (A, B, C) | Court 2 (D, E, F) |
|---|---|---|
| 1 | A–B | D–E |
| 2 | Winner R1–C | Winner R1–F |
| 3 | Loser R1–C | Loser R1–F |

Six matches, each team plays **exactly two**, independent of results. Each court can advance on its own.

### Five teams: opening winners earn a third game

First round: A–B on Court 1 and C–D on Court 2, with E resting. Denote the opening winners W1 and W2, losers L1 and L2.

| Round | Court 1 | Court 2 |
|---|---|---|
| 1 | A–B | C–D |
| 2 | W1–E | W2–L1 |
| 3 | W1–L2 | W2–E |

Opening winners get **three** games; the other three teams get **two**. All six matches have unique pairings; no team is double-booked in the same round. Subsequent team placement should favor players with fewer **regular** games for the opening-match opportunity, without guaranteeing a win. A substitute appearance is **not** included in regular-game balancing.

**Scheduling constraints that must be visible in UI:**
- Five-team scheduling requires some teams to **move between courts**, unlike six-team scheduling. A dependent game may wait for the *other* court's result, and that is acceptable: display "Waiting for other court" rather than starting with an unavailable team.
- Exactly **one team rests per round** in a five-team/two-court schedule. There is no fixed assignment of teams to courts, and a resting team could be needed on either court next. **Therefore temporary substitutions are disabled in five-team rotations.** Use a valid between-game permanent transfer instead.
- A transfer changes a player's team membership for the **remainder of the current rotation only**. It cannot happen in the middle of a game or cause either team to fall below the playable lineup size. At the next team reshuffle, players are all available for new assignment.
- Prevent starting a match if a team or player is unavailable due to a still-active game on the other court. A match may wait for a prerequisite result; this is not considered a permanent court assignment.

The scheduling tests enumerate opening outcomes. The database checks readiness against the actual results and active lineups on both courts before allowing a game to start.

## Temporary substitutes and rotation-long transfers

### Six-team rotations: temporary one-game substitutes

- Players arrange substitutions in person. Routine substitutions require **no organizer approval**.
- Anyone with the public Teams Manager link may **record** a same-court, available, consenting substitute, subject to strict server validation; the organizer can correct a mistake.
- The substitute must come from a **resting team assigned to the same court** as the team needing help, never from the other court. A player cannot play two simultaneous games.
- One-game substitutions do not permanently change team membership; these **substitute appearances are tracked separately** from regular game counts and are visible to organizers only.
- When no eligible substitute exists, a match may be deferred or played short-handed if the selected format permits it. Do not forcibly reshuffle.

### Five-team rotations: transfers until next reshuffle

- **No temporary substitutions.** Since teams move across courts, borrowing a resting player for only one game may create a conflict when the player's original team needs them next.
- Instead, when teams agree and a transfer is legal, move a player to another team **between games**. The transfer persists for the **remainder of that rotation** and resets at the next organizer-published reshuffle.
- Neither the origin nor destination team may be playing when the transfer is applied. The origin team must still have enough available players to meet the chosen on-court format. Reject moves that would double-book a player or leave the original team unable to play.
- Record the transfer and the player's **actual regular game appearances**, not phantom appearances based on the team's prior schedule. They are **not substitute appearances**.
- If no legal transfer is available, wait until a suitable game boundary, play a supported smaller format, or defer the game; never force a mid-game interruption or automatically borrow across courts.

### Other roster changes

- Permanent late-arrival replacements are organizer-managed changes between games. Replacements, breaks, and departures do not automatically trigger a whole-rotation reshuffle.

## Public game workflow

- Public view updates without manual refresh (real-time notification, then request a **sanitized public snapshot**; reconnect and recover after disconnection).
- Anyone with the link can mark an eligible game started and submit its **winner only**, with a confirmation prompt.
- First valid database write wins; the next concurrent/stale submission is rejected and refreshed.
- Only organizers can correct completed winners. Correcting a result automatically updates downstream matchups only before affected games start. Otherwise block automatic edits and require an organizer resolution.
- Courts advance separately **where match dependencies permit**; five-team cross-court dependencies may require waiting.
- Public action access must not imply access to profiles, email addresses, statistics, restricted event details or original management/invitation tokens.

## Ending and closing

- A rotation ends after all planned games or when an organizer confirms early termination. Completed games are retained, unplayed/unfinished games are marked abandoned without awarding a win or a completed appearance.
- Organizer alone generates/previews/publishes the next rotation. The current published rotation stays visible until the replacement is published.
- At end of the session, organizer-only summary reports wins, rotations, regular games and substitute appearances. The public view returns to its inactive state.
- Session history may remain privately for troubleshooting but never influences future session game totals. Persistent profile attributes survive.

## Database and privacy

The manager reads the organizer-selected event from `public.events`, imports its roster from `public.registrations`, and verifies organizer membership through `public.organizers`. It keeps its profiles, attendance, teams, appearances, corrections and action history in dedicated manager tables. The organizer-only participation summary counts a rotation once per player who appeared in at least one completed game in that rotation.

Browser clients use scoped database functions. Organizer functions check the signed-in account. Players see a sanitized public snapshot and can start games, report winners, record valid substitutes, rotate a teammate or record a permitted five-team transfer. The database serializes competing changes and rejects actions that became stale while waiting. Realtime broadcasts carry a revision signal. Each client fetches the appropriate snapshot and polls for missed updates.

[Verification and test coverage](TEAM_MANAGER_STAGING_PLAN.md) · [Release migration and recovery](db/release/README.md)
