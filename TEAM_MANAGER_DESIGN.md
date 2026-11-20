# Running an open gym with Teams Manager

[Open Teams Manager](https://cosvolleyball.github.io/teams/) to see the current session. Players can use the page without an account. Organizers sign in with the same account used for the [event dashboard](https://cosvolleyball.github.io/?dashboard=1), then open **Teams Manager** from the navigation. One session can run at a time.

## Start the session and adjust attendance

1. Under **Session controls**, choose a published **Source event**, select a playing format and click **Start session**. Both public and private events are available to organizers. During a session, the public manager displays the event title, published team rosters and court activity, including for an invitation-only source event.
2. Confirmed registrations start **Included**. Waitlisted players start **Not included**. Canceled registrations are omitted. The import matches players by normalized email and gives a confirmed entry priority over a waitlist entry for the same person.
3. Use **Mark no-show** for someone who is absent and **Include** for someone who arrives. For a walk-in, enter a name and email under **Add walk-in**, then select **Add and check in**. These attendance changes are recorded in the session roster. The event's registration, waitlist and payment records are maintained separately.
4. For optional private profiles, select a skill rating from 1 to 10 and a gender of Male or Female. Under **Preferred positions**, check up to two of Outside, Setter, Middle, Libero and Right side, or select **Flex** for someone who can play all five. Choose **Done** to close the position menu, then select **Save** on the player's row. These preferences apply when teams are next generated.

## Prepare and publish teams

The organizer chooses **Number of teams** and **Playing format** for each rotation. The page shows which combinations the available players can support and flags arrangements that rely on borrowed players. Private events offer 4v4 and 6v6. Public events also offer 5v5.

| Example with 25 available | Distribution |
| --- | --- |
| Four teams playing 6v6 | 7, 6, 6, 6 |
| Five teams playing 5v5 at a public event | 5, 5, 5, 5, 5 |
| Six teams playing 4v4 | 5, 4, 4, 4, 4, 4 |

Select **Generate / regenerate** to preview the teams. Skill, gender and position balancing can be selected independently where available. Position balancing is available for 5v5 and 6v6. The generator also considers regular games played and previous teammates in the current session. A seven-player team may have a suggested front-row/back-row pairing.

In the preview, swap or move players, swap whole teams' opening court slots, or use **Undo last edit**. **Save private draft** stores the current preview. **Publish teams** puts the teams and games on the public page.

## Play on two courts

A rotation has three rounds and six games. The team numbers below match the opening slots in the manager. W1 and L1 are the winner and loser of Court 1's opening game. W2 and L2 refer to Court 2's opener.

| Teams | Round | Court 1 | Court 2 |
| --- | --- | --- | --- |
| 4 | 1 | 1 vs 2 | 3 vs 4 |
| 4 | 2 | 1 vs 3 | 2 vs 4 |
| 4 | 3 | 1 vs 4 | 2 vs 3 |
| 5 | 1 | 1 vs 2 | 4 vs 5 |
| 5 | 2 | W1 vs 3 | W2 vs L1 |
| 5 | 3 | W1 vs L2 | W2 vs 3 |
| 6 | 1 | 1 vs 2 | 4 vs 5 |
| 6 | 2 | W1 vs 3 | W2 vs 6 |
| 6 | 3 | L1 vs 3 | L2 vs 6 |

With four teams, each team plays every other team. With five, the opening winners play three games and the other teams play two. Some teams change courts. With six, each court has a group of three and every team plays twice.

Either players or organizers can select **Start game** on a ready game. At the end, select the winning team and click **Report winner**. The first accepted result updates both views. **Waiting for other court** means an earlier game or team is still needed. Court assignments and team results refresh automatically.

## Substitutes, late arrivals and corrections

| Situation | How to record it |
| --- | --- |
| A team has extra players | The team handles its own on-court rotation. All available team members at game start receive regular game credit on completion and a win if their team wins. |
| A six-team roster needs another player | Before starting the game, record an available volunteer from the resting team assigned to that court. A one-game substitute returns to their team afterward. |
| A five-team rotation needs a transfer | **Five-team player transfers** appears when one idle team is below the playing format and another idle team can spare an available player. For example, in 5v5 a team with six can send one to a team with four. Choose the player and short team. The assignment lasts until the next reshuffle. |
| A player takes a break, leaves or arrives late | The organizer updates attendance. Under **Late arrivals and replacements**, an eligible arrival can fill an open spot or replace an unavailable player between games. Other teams keep their assignments. |
| A winner, transfer or appearance was recorded incorrectly | The organizer can correct a completed winner while the session is active if affected later games have not started. The session controls also include **Correct a five-team transfer** and **Correct a recorded participant** for a completed game. |

## Reshuffle or close

A rotation completes after its scheduled games. **End rotation early** keeps completed results and abandons unfinished games. The organizer can then choose a different team count or format, review a new draft and publish the next rotation.

**End session and view stats** closes the public session and shows the organizer each player's rotations played, regular games, substitute games and wins. Only completed games count. A player earns one rotation played for appearing in one or more completed games in that rotation. The public page returns to **No active volleyball session right now**.

[Practice with a fictional roster](db/release/PHONE_REVIEW.md) · [Database and access model](ARCHITECTURE.md)
