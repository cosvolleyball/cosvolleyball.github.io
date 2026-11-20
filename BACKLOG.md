# Maintenance notes

## Deferred work

| Area | Considerations |
| --- | --- |
| End-of-season cleanup | Define which event records need archiving, how financial history is retained and how the community balance carries forward. |
| Seasonal automation | Identify a seasonal task and its schedule before adding another workflow. The existing Supabase Activity Check runs three times daily. |

## Feature history

- **Event Day Teams Manager** uses an event's registrations as its starting roster. It supports attendance exceptions, private drafts, two-court rotations, substitutions, winner reporting and organizer statistics. [Event-day guide](TEAM_MANAGER_DESIGN.md)
- **Event duplication and calendar export** let an organizer copy event settings into a new draft with a blank date. Confirmed registrants can add their event to Google Calendar or download an Apple/Outlook calendar file.
- **Registration safeguards** include server-side email syntax validation, invitation-link validation and clearing stale organizer data after logout.
- **Player access** includes 15-day restrictions, permanent bans, organizer audit history and eligibility-aware waitlist promotion.

[Manual release checks](TEST_CHECKLIST.md) cover calendar imports in local time, saving duplicate drafts, keyboard navigation and screen-reader behavior.
