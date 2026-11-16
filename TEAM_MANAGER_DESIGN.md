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
- Do not require every roster to be divisible by the number of on-court positions. Distribute all present, available players into team rosters when feasible.
- A roster may contain one or more extra players (e.g., five-person roster in a 4v4 match); the **actual lineup for each match** determines who played. Between-match lineup rotation must give extra roster members opportunities without midgame forced swaps.
- Organizers may override the recommended distribution and court assignments before publication.
- Once published, teams stay fixed until the rotation finishes or organizer ends it early. Explicit departure/replacement/substitution actions are not a general reshuffle.

## Schedules — validated mathematical core

A **game round** is one scheduled game per active court. A **rotation** comprises three such rounds and ends in a new team reshuffle.

### Four teams: full round robin

| Round | Court 1 | Court 2 |
|---|---|---|
| 1 | A–B | C–D |
| 2 | A–C | B–D |
| 3 | A–D | B–C |

Six unique matches. Every team plays **three**, no resting team while both courts play. This means **resting-team substitution is unavailable** in a standard four-team round; extra roster players may rotate into each team's lineup between matches.

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
- Exactly **one team rests per round** in a five-team/two-court schedule. There cannot be a resting team on *both* courts simultaneously. The same-court substitution rule therefore sometimes means **no eligible resting team is available on one court**. Never silently borrow from the other court.
- Court-assignment semantics for a resting team in this five-team case must be explicit before enabling public substitution submissions. This is a real scheduling constraint, not an algorithm bug.

All schedule invariants above are covered by the dedicated pure-function test suite; this is **not** yet a full server-authorized match engine.

## On-court substitutions

- Players arrange them in person. Routine substitutions require **no organizer approval**.
- Any player with the public Teams Manager link may **record** a same-court, available, consenting substitute, subject to strict server validation; the organizer can correct the record.
- The substitute must come from a **resting team assigned to the court needing help**, not from the other court. A person cannot be assigned to two concurrent games.
- One-game substitutions do not permanently change team membership and do **not count** toward regular-game fairness numbers. Store substitute appearances separately, visible to organizers only.
- Permanent late-arrival replacements are organizer-managed roster changes between games.
- When no eligible substitute is available, the match may be played short-handed or deferred; do not forcibly reshuffle.

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

## Supabase architecture proposal (NOT implemented)

**Existing observed database:** `public.events` (`id`, `visibility`, `status`), `public.registrations` (`event_id`, `player_name`, `player_email`, `registration_status`, `attendance_status`), and `public.organizers` (`user_id`). All three have RLS enabled. Organizer access is currently represented by a row in `public.organizers`.

New isolated data model:
- Private `team_manager_profiles`: profile ID, normalized unique email, skill/gender/positions, audit timestamps; organizer-only RLS.
- `team_manager_sessions`: selected event ID, 1-active-session invariant, settings, status, version.
- `team_manager_session_players`: present/late/break/departed state, profile ID, optional registration ID, display name.
- `team_manager_rotations`, `team_manager_teams`, `team_manager_team_members`: unpublished draft and current published roster snapshots, balance settings and court assignments.
- `team_manager_games`, `team_manager_game_participants`, `team_manager_substitutions`: match state, actual players on court, winner, substitution role.
- Restricted action log with timestamps, action type, changed IDs, and organizer identity when authenticated; no public emails.

Use separate, **narrow RPC endpoints**:
- Organizer-only: choose source event, import players, edit profiles/attendance, generate and publish teams, correct results, end session, view private stats.
- Public read: fetch only sanitized active-session state (even if source event is invite-only, as the owner requested).
- Public write: start eligible game, submit its winner, record one-game eligible substitute. No arbitrary public table INSERT/UPDATE.

Concurrency: server-side validation and row locking/version checking for every state-changing RPC. Lock enough records to enforce first-valid-write and no double-booked substitutes; reject stale writes. Audit public actions without pretending a public user has a verified identity. Consider rate limits and abuse recovery given anonymous write permission.

**Security:** private player profile/email/statistics tables must never be exposed via an anonymous read; RLS and function permissions are enforced in Postgres. Do not publish a Realtime stream of sensitive row payloads. Instead send a public revision signal / sanitized projection and refetch the authorized public snapshot. Explicit grants, pinned search paths and least-privilege functions must be tested with anon and organizer roles. No schema or live database changes are authorized by this design-only branch.

## Implementation order

1. **Foundation (this branch):** inspected schema/site structure; tested pure scheduling invariants for 4/5/6 teams; this living spec. No public link or backend alterations.
2. **Data contract and security:** design migration with organizer/private/public projections, anonymous action RPC validations, concurrency tests and appropriate local/staging verification. Apply to production only after review and controlled rollout.
3. **Organizer experience:** event picker, attendance, persistent profiles, draft team generator, swap/undo, publish.
4. **Public experience:** public single-active-session view, live court updates, player-reported starts/winners/substitutions, safe correction workflow.
5. **Unusual attendance and end-to-end QA:** 4v4/5v5/6v6 lineup capacities, player breaks, late/early movement, five-team court transitions, full real-device testing; release only when confirmed.

## Decisions still requiring validation before live release

- How to display/limit the available **same-court substitute pool for five-team scheduling**, when only one team rests for two simultaneously active courts.
- Organizer defaults for **playing format** (4v4/5v5/6v6) across attendance counts and public vs private events, especially when extra roster players must rotate into individual games.
- Anonymous write abuse/rate-limit expectations and how to recover from malicious or mistaken player inputs.
- What should happen when teams cannot field enough players for a legitimate game; do not automatically steal from another court.

These issues should be exercised in simulated rotations before database migrations or public launch.
