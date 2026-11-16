# COS Volleyball Website — Backlog

**Last reviewed:** 2026-11-16
**Project:** [Colorado Springs Pickup Volleyball](https://cosvolleyball.github.io/)  
**Status:** Active improvement batch approved; production remains in maintenance mode until reviewed changes are deployed.

This file is the shared source of truth for planned website work. Keep this list current as features are agreed, started, completed, or explicitly deferred. Do not add private player information, credentials, secret keys, or database exports; this repository is public.

## Approved improvements (2026-11-16)

### 1. Duplicate an existing event — In progress
- Add an organizer-only "Duplicate event" action to existing events.
- Copy title, venue, start time, duration, capacity, fee, host, payment instructions, visibility, and description.
- Require selection of a new date, create a separate draft, and do not copy the event ID, private invitation link, registrations, attendance, or payment records.
- **Acceptance:** creation uses INSERT, never UPDATE; existing event is unchanged, and the new event has no prior players or payments.
- **Delivery:** implement and test on a feature branch; review before production merge.

### 2. Add to Calendar — Implemented on feature branch; pending review
- Confirmed registrations show **Google Calendar** and **Apple / Outlook (.ics)** options in their success popup. Waitlisted players do not receive calendar buttons because they do not yet have a reserved spot.
- Calendar data uses actual UTC start/end instants, with daylight-saving-safe date conversion, and the event's title and gym venue.
- Calendar content contains no player email, private event invitation token, registration management token, or payment instructions.
- Both calendar options are keyboard accessible and wrap vertically on narrow screens; no Supabase changes needed.
- **Acceptance:** automated tests cover UTC/DST, ICS escaping and line folding, missing/invalid times, privacy, waitlist visibility, and download-on-click; manual mobile browser verification remains part of Phase 11 final review.

### 3. Mobile and accessibility audit — Queued
- Review public registration, event details, organizer dashboard, dialogs, and check-in on narrow screens.
- Focus on touch targets, labels, keyboard and screen-reader navigation, contrast, and focus behavior.
- **Acceptance:** documented findings and tested fixes, without unrelated redesign.

### 4. Expand regression testing — In progress / ongoing
- Add coverage for event duplication and subsequent calendar changes.
- Run automated isolated regression tests on pull requests **before** merging as well as on deployments.
- **Acceptance:** existing tests continue passing, and new functionality has meaningful positive and negative tests.

## Deferred / low priority

### 1. Annual Season Cleanup
- **Status:** Deferred until after winter / when the organizers want to plan the next season.
- **Goal:** Plan an end-of-season cleanup process for obsolete seasonal records.
- **Requirements:** Preserve financial history and carry forward the group's balance accurately. Review the cleanup scope and backup/rollback plan before deleting or archiving any records.
- **Next step:** Revisit requirements before implementation; no automatic deletion is authorized.

### 2. Summer Supabase Automation
- **Status:** Deferred; requirements to confirm.
- **Goal:** Revisit the previously discussed summer-related Supabase automation when it becomes relevant.
- **Existing automation:** The repository already has a Supabase Activity Check workflow scheduled three times a day. This is not a request to recreate that workflow.
- **Next step:** Confirm the intended seasonal behavior and whether additional automation is actually needed before writing code.

## Ongoing, as-needed

### Organizer and player experience
- Incorporate specific UI/UX changes when organizers or players report actionable feedback.
- Perform targeted mobile and desktop regression testing when related pages are modified.
- **Status:** No particular new change currently approved or scheduled.

## Recently completed

### Regression fixes (2026-11-16)
- Delayed organizer event, roster, and audit responses are discarded after logout or a newer refresh; logout clears audit history.
- Empty invitation links display an invalid-link message.
- Registration validates email syntax server-side as well as in the form. This does not add email-domain verification.
- Added isolated frontend regression tests to the deployment workflow.

### Phase 10 — Player restrictions and bans (2026-11-14)
- Organizer can add and clear 15-day email restrictions and permanent registration bans.
- Restrictions route new signups to the waitlist; removing a restriction restores eligibility for promotion.
- Bans block new registrations and waitlist promotions, without automatically canceling already confirmed spots. Organizers cancel confirmed registrations manually when necessary.
- Organizer audit history records rule changes.
- The five-minute Supabase Cron promotion job was installed, ran successfully, and core workflows were verified live.
- Cleanup of test records and access rules was completed.

## Backlog policy
- Do not promote deferred ideas into active work without an explicit new decision.
- Do not track speculative improvements simply because they might be useful someday.
- Add each new request with a short description, priority, and acceptance criteria; mark it done when verified.
- Website code is under `website/`. Keep SQL migrations, secrets, private exports, and player data out of this public backlog.
