# Phase 11: Mobile and Accessibility Review

**Reviewed:** 2026-11-16  
**Branch:** `feature/duplicate-event-20261116`  
**Production:** Unchanged until PR #4 is merged

## Scope and limits

Reviewed frontend markup, JavaScript behavior, and responsive CSS for public event pages, registration and confirmation dialogs, organizer event editing, dashboard tabs, check-in controls, and finance tables.

Automated regression tests use JSDOM and fake Supabase responses. They test behavior and markup, **not rendered pixels, actual screen-reader announcements, real browser focus trapping, or operating-system calendar import**. Real-device QA items below must not be considered passed by the automated suite.

## Issues addressed on the Phase 11 branch

| Area | Finding | Fix |
|---|---|---|
| Navigation | No skip-to-content option | Added keyboard-visible skip links for public content and organizer workspace |
| Registration | Registration dialog did not advertise its label/description | Added `aria-labelledby` and `aria-describedby`; focus starts on Full name |
| Confirmation | Success dialog needed more predictable announcement | Added programmatic description and focusable status heading focused after successful submission |
| Organizer tabs | Buttons used `role=tablist` container but lacked `role=tab` and roving focus | Added complete tab roles, selected state, `tabindex`, and Left/Right/Home/End keyboard navigation |
| Event check-in | Repeated “Cancel” buttons did not identify players | Added player-specific accessible names |
| Mobile check-in | `display:none` removed table header from accessibility tree | Preserved column headers visually hidden at narrow widths; named the roster table |
| Finance ledger | Repeated “Void” buttons lacked transaction context | Added type, amount, and date to accessible names |
| Mobile touch | Several actions were 35–42px high | Raised relevant editor close, registration close, check-in, dashboard event, finance void, and restriction actions to at least 44px |
| Mobile forms | Some form controls used 12–15px text, potentially triggering iOS input zoom | Added 16px text and 44px minimum control height at narrow widths |
| Color and focus | Some small labels were below 4.5:1 contrast; a malformed CSS focus selector was present | Darkened key small-text colors and corrected selector; reinforced visible keyboard outlines |

## Automated verification

- Existing isolated regression coverage remains in place for registration validation, finance calculations, event editing, stale organizer data after logout, and private links.
- Additional tests verify skip-link destinations, accessible dialog names/descriptions, keyboard tab switching, specific roster labels, focus placement, and accessible mobile table headers.
- New Phase 11 Duplicate Event and calendar tests remain part of the same test suite.
- The pull-request workflow prevents an unnoticed failing test suite from being treated as a clean release; review the CI result before merging.

## Manual QA required before final sign-off

This is a review checklist, **not a claim that these checks have already run**.

- [ ] **iPhone Safari at ~375px:** Open a public event, register with a controlled test email if appropriate, and ensure every dialog action is reachable without horizontal page scrolling or zoom.
- [ ] **Small phone at ~320px:** Event cards, registration form, confirmation/calendar buttons, editor date/time controls, and organizer check-in actions reflow without clipping.
- [ ] **Android Chrome at ~360px:** Check the same flows, particularly native date and select inputs, scrolling within dialogs, and touch targets.
- [ ] **Desktop keyboard:** Tab to skip link, open event, open/close registration dialog using keyboard, and ensure focus stays within native dialogs.
- [ ] **Organizer keyboard:** In dashboard, Left/Right/Home/End changes between Events and Finances, updates selection state, and focuses the selected tab.
- [ ] **Organizer phone:** Expand a current/past event, open Duplicate Event, select a new date, review Draft status, and confirm action buttons remain usable.
- [ ] **Check-in phone:** Record attendance/payment for a controlled entry and verify no accidental nearby control activation or disruptive scrolling.
- [ ] **200% browser zoom:** Event detail and organizer pages remain readable and usable.
- [ ] **Calendar smoke test:** Confirm Google Calendar and an Apple/Outlook .ics import show correct local event times and venue, and that waitlisted users do not receive add-to-calendar choices.
- [ ] **VoiceOver or TalkBack (when available):** Verify modal names, tab selection, player-specific Cancel labels, and finance Void labels are announced meaningfully.

**Privacy:** Use controlled test events/addresses only. Do not include production registration records, finance data, credentials, invitation tokens, or screenshots containing private details in issues or test reports.
