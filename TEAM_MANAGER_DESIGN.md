# Event Day Teams Manager — living design

**Status:** Pre-release foundation. This document is a working specification, not proof of a deployed feature. It is intended to be maintained while building the manager, not kept as a historical phase report.

## Product boundary

- Add a **Teams Manager** link in the existing navigation, replacing the existing external **Teams** link; no second site or repo.
- One shared public view of **one active session at a time**, attached to a published event selected by an authorized organizer. The source event may be public or private.
- Import its registered **and waitlisted** players as candidates, but only organizer-confirmed **present and available** people participate. Walk-ins may be added without creating or changing registration or payment rows.
- Registration order and waitlist promotion order do not determine team assignments or substitutions.
- Registration, cancellation, payment, finance, email notification, access restriction and Supabase Cron workflows must remain unchanged.
- When no session is active, show "No active volleyball session right now."
- Organizer-only UI reveals private profile fields and participation statistics; public UI reveals only display names, teams, courts, games, and permitted game/substitution actions.

## Player profiles and availability

- Persistent organizer-managed profile with a UUID and **normalized email unique lookup key** (lowercase + trim). The internal UUID survives an email change or merge.
- Optional skill (integer 1–10), optional gender, and up to two preferred positions. Missing values never exclude a player or create assumed values.
- Only organizers enter, update, or link profiles. Updates during an event affect future team generations, not games already underway.
- Status for a session: available, waiting, resting/break, playing, departed. Attendance belongs to Teams Manager, independent of event registration's attendance/payment fields.
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

All schedule invariants above are covered by the dedicated pure-function test suite; this is **not** yet a full server-authorized match engine.

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

## Supabase architecture — draft implementation, NOT deployed

**Existing observed database:** `public.events` (`id`, `visibility`, `status`), `public.registrations` (`event_id`, `player_name`, `player_email`, `registration_status`, `attendance_status`), and `public.organizers` (`user_id`). All three have RLS enabled. Organizer access is currently represented by a row in `public.organizers`.

A first version of the isolated data model is in `db/drafts/event_day_manager_foundation.sql`. It has been applied successfully against a disposable PostgreSQL 17 test database, **not production**. `db/tests/fixture.sql` and `db/tests/contracts.sql` verify access control, profile and roster import, walk-ins, stats isolation, and deletion independence. The CI workflow is `.github/workflows/team-manager-db-contracts.yml`. This is not a signed-off migration and must not be applied to production before complete backend review.

New isolated data model:
- Private `team_manager_profiles`: profile ID, normalized unique email, skill/gender/positions, audit timestamps; organizer-only RLS.
- `team_manager_sessions`: selected event ID, 1-active-session invariant, settings, status, version.
- `team_manager_session_players`: present/late/break/departed state, profile ID, optional registration ID, display name.
- `tm_rotations`, `tm_teams`, `tm_memberships`: unpublished draft and current published roster snapshots, **rotation-specific playing format**, balance settings, court assignments where applicable, and a history of approved between-game five-team transfers.
- `team_manager_games`, `team_manager_game_participants`, `team_manager_substitutions`: match state, actual players on court, winner, substitution role.
- Restricted action log with timestamps, action type, changed IDs, and organizer identity when authenticated; no public emails.

Use separate, **narrow RPC endpoints**:
- Organizer-only: choose source event, import players, edit profiles/attendance, generate and publish teams, correct results, end session, view private stats.
- Public read: fetch only sanitized active-session state (even if source event is invite-only, as the owner requested).
- Public write: start eligible game, submit its winner, and record a one-game eligible substitute **only for a supported format**. Implement a separate validated five-team transfer workflow; its authorization and audit requirements must be tested explicitly. No arbitrary public table INSERT/UPDATE.

Concurrency: server-side validation and row locking/version checking for every state-changing RPC. Lock enough records to enforce first-valid-write and no double-booked substitutes; reject stale writes. Audit public actions without pretending a public user has a verified identity. Consider rate limits and abuse recovery given anonymous write permission.

**Security:** private player profile/email/statistics tables must never be exposed via an anonymous read; RLS and function permissions are enforced in Postgres. Do not publish a Realtime stream of sensitive row payloads. Instead send a public revision signal / sanitized projection and refetch the authorized public snapshot. Explicit grants, pinned search paths and least-privilege functions must be tested with anon and organizer roles. No schema or live database changes are authorized by this design-only branch.

## Implementation order

1. **Foundation (this branch):** inspected schema/site structure; tested pure scheduling invariants for 4/5/6 teams and organizer-only draft balancing; this living spec. No public link or production backend alterations.
2. **Data contract and security:** foundation plus organizer draft/publish SQL review drafts are committed in `db/drafts/` and integrated against PostgreSQL 17 fixtures in CI. Still outstanding: the public game-action RPCs, concurrency tests, true Supabase staging/RLS verification, and migration review. **Nothing has been applied to production.**
3. **Organizer experience (initial implementation):** the new isolated `website/teams/` page includes an event picker, attendance, walk-ins, profile editing, local draft generation/regeneration, swaps, moves, undo, private draft saving, explicit publish, early rotation closing and private session statistics. It is not production-tested and is not deployed.
4. **Public experience (initial implementation):** same-site navigation now links to the new Teams Manager; it renders sanitized active-session teams/courts and refreshes automatically at an 8-second interval. The feature branch now includes anonymous game start, winner reporting, same-court voluntary subs for six teams, five-team permanent transfers, emergency injury substitutions, ordinary in-game teammate rotations, and organizer corrections. These are backed by isolated PostgreSQL tests, **not yet staging or production verification**. Still missing: true realtime notification subscriptions, negative/security abuse testing, comprehensive concurrent connection tests, and real-device QA.
5. **Unusual attendance and end-to-end QA:** 4v4/5v5/6v6 lineup capacities, player breaks, late/early movement, five-team court transitions, full real-device testing; release only when confirmed.

## Decisions still requiring validation before live release

- Validate **five-team permanent-transfer** timing, source-team lineup capacity, and fairness accounting with concurrent match-state tests; temporary substitutes are explicitly prohibited in this format.
- Exercise **per-rotation format changes** across one session (e.g., 25 check-ins: 4 teams 6v6 then 6 teams 4v4) and ensure attendance, position-balancing toggles, and participation stats remain correct when player counts change.
- Anonymous write abuse/rate-limit expectations and how to recover from malicious or mistaken player inputs.
- What should happen when teams cannot field enough players for a legitimate game; do not automatically steal from another court.

These issues should be exercised in simulated rotations before database migrations or public launch.
