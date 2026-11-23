# Repository UI cleanup

Verdict: Light. Repository-wide audit; targeted copy and decorative cleanup, not a visual redesign.

Reference: https://github.com/felipebasurto/unslop-ui/blob/main/skills/unslop-ui/SKILL.md
Read blob: 94df3c6e03b96a05ceb2093e95df66a054524766 (1.0.1). No installation, dependency, skill or agent configuration change.

## Scope and result

Inventoried 1,221 TS/TSX/HTML/JSON files under app, components, lib and public. The AST inventory contains 57,191 strings, including class names and other non-UI strings; this is not a claim that every literal was manually reviewed. Reviewed the candidate findings and the 630-entry heading/helper inventory, then traced ambiguous cases to their rendering context. Repo documentation, migrations, test fixtures, generated data and agent instructions are not product copy.

The combined PR changes 35 runtime files. The extension makes 48 visible source-occurrence edits, plus cleanup of the deleted elements' imports and spacing. Initial Analytics rewrites are listed separately in [analytics-unslop-ui.md](analytics-unslop-ui.md). Shared occurrences may render on several screens; rule counts overlap when an edit addresses more than one rule.

| Rule | Fixed source occurrences in repo-wide extension |
| --- | ---: |
| U1 | 6 |
| U21 | 18 |
| U22 | 4 |
| U3 | 2 |
| U4 | 7 |
| U5 | 1 |
| U8 | 1 |
| length | 3 |
| unslop 13 | 13 |
| unslop 17 | 1 |
| unslop 32 | 1 |

## Every repo-wide rewrite

| File | Before | After | Rule | Occurrences |
| --- | --- | --- | --- | ---: |
| components/appointment-prep-memory-card.tsx | Open full chart → | Open full chart | U21 | 2 |
| components/last-treatment-memory-card.tsx | Open full chart → | Open full chart | U21 | 1 |
| app/(app)/clients/[id]/sessions/new/page.tsx | Open full chart → | Open full chart | U21 | 1 |
| components/last-visit-card.tsx | Open session → | Open session | U21 | 1 |
| components/session-timeline.tsx | Open session → | Open session | U21 | 1 |
| app/(app)/records/page.tsx | Open session → | Open session | U21 | 2 |
| components/last-treatment-memory-card.tsx | Full notes → | Full notes | U21 | 1 |
| app/(app)/calendar/[id]/page.tsx | Open Treatment Plans → | Open treatment plans | U21 + unslop 17 | 1 |
| app/(app)/clients/[id]/page.tsx | View intake → | View intake | U21 | 3 |
| app/(app)/clients/[id]/page.tsx | Open → | Open session | U21 + U22 | 1 |
| app/(app)/clients/[id]/intake/IntakeHistoryList.tsx | View → | View version | U21 + U22 | 1 |
| app/(app)/clients/ClientsDirectory.tsx | Open | Open client | U22 | 1 |
| app/(app)/getting-started/page.tsx | Open → | Open {item.label} | U21 + U22 | 1 |
| app/(app)/dashboard/secondary-stack.tsx | steps complete →` | steps complete` | U21 | 1 |
| app/(app)/dashboard/secondary-stack.tsx | Some steps could not be checked just now → | Some steps could not be checked just now | U21 | 1 |
| app/reschedule/[token]/page.tsx | Reschedule appointment | Deleted | U1 | 1 |
| app/reschedule/[token]/page.tsx | Choose a new time that works better for you. | Deleted | U3 | 1 |
| app/cancel/[token]/page.tsx | Cancel appointment | Deleted | U1 | 1 |
| app/intake/thank-you/page.tsx | Thank you | Deleted | U1 | 1 |
| app/resources/electrolysis-treatment-record-checklist/page.tsx | Guide | Deleted | U1 | 1 |
| app/resources/moving-an-electrolysis-practice-from-paper-records/page.tsx | Guide | Deleted | U1 | 1 |
| app/portal/page.tsx | Anything you need to handle is at the top. Your appointments and records live below. | Deleted | U4 | 1 |
| app/portal/verify/[token]/page.tsx | This secure link is ready. Continue to access your appointments, forms, and appointment details. | Deleted | U3 | 1 |
| app/(app)/error.tsx | Hone could not finish loading this page. This is a problem on our side, not something you did. | Hone could not finish loading this page. | U4 | 1 |
| app/global-error.tsx | Hone could not finish loading this page. This is a problem on our side, not something you did. | Hone could not finish loading this page. | U4 | 1 |
| app/(app)/calendar/[id]/ManualFeeChargeCard.tsx | The previous click is still resolving with Stripe. Click Refresh to recheck; the system will not create a second PaymentIntent. | The previous payment attempt is still being checked. Use Refresh status to check it again. Hone will not create another payment attempt. | U5 | 1 |
| app/(app)/clients/[id]/sessions/[sessionId]/SessionPhotos.tsx | Photo unavailable — reload to view | Photo unavailable. Reload to view. | unslop 13 | 1 |
| components/client-budget-card.tsx | Nothing has been changed. Reload the page to try again — any budget already saved for this client is still there. | Nothing has been changed. Any budget already saved for this client is still there. Reload the page to try again. | unslop 13 | 1 |
| components/client-budget-card.tsx | Practitioner-only — never shown to the client. | Practitioner-only. Never shown to the client. | unslop 13 | 1 |
| components/waitlist/add-to-waitlist-panel.tsx | For enquiries that arrived by phone, email or in person — and for people who were already waiting before you started using Hone. | For enquiries that arrived by phone, email or in person, and for people who were already waiting before you started using Hone. | unslop 13 | 1 |
| lib/waitlist/join-copy.ts | A general answer is enough — we'll confirm exact times when we contact you. | A general answer is enough. We'll confirm exact times when we contact you. | unslop 13 | 1 |
| lib/waitlist/join-copy.ts | Thanks — that's everything we need. | Your details are saved. | U4 + unslop 13 | 1 |
| lib/waitlist/join-copy.ts | We can't use the mobile number on file, and it can't be changed from this page — so your details can't be completed yet. Please contact the studio. | We can't use the mobile number on file, and it can't be changed from this page. Your details can't be completed yet. Please contact the studio. | unslop 13 | 1 |
| app/features/waitlist-invitation/InvitationScreen.tsx | Thanks — your reply is saved for the studio | Your reply is saved | U4 + length | 1 |
| app/features/waitlist-invitation/InvitationScreen.tsx | Please don’t try to book again — contact the studio and they can check whether your appointment exists. | Please don’t try to book again. Contact the studio and they can check whether your appointment exists. | unslop 13 | 1 |
| app/features/waitlist-invitation/InvitationScreen.tsx | Nothing is open in these times right now. This can change — try again, or let the studio know this doesn’t work. | Nothing is open in these times right now. Try again, or let the studio know these times don’t work. | U4 + unslop 13 | 1 |
| lib/finance/financial-copy.ts | Nothing here is zero — Hone simply could not look. | These figures are unavailable, not zero. | unslop 13 + unslop 32 | 1 |
| lib/finance/financial-copy.ts | How each completed visit was settled — paid by card, collected outside Hone, still owed, waived — is not on this screen yet. | Settlement details are not on this screen yet: card payments, money collected outside Hone, amounts still owed and waived amounts. | unslop 13 | 1 |
| app/(app)/dashboard/capacity/page.tsx | Future treatment time for current clients | Current clients’ booked treatment time | length | 1 |
| app/(app)/dashboard/capacity/page.tsx | Counted across future treatment appointments only, cumulatively — a client with three booked treatments appears in all three bands. | Counted cumulatively across future treatment appointments only. A client with three booked treatments appears in all three bands. | unslop 13 | 1 |
| app/(app)/dashboard/capacity/page.tsx | booked — a booked consultation is not treatment. | booked. A booked consultation is not treatment. | unslop 13 | 1 |
| app/(app)/calendar/DragActionChooser.tsx | What would you like to do? | Choose an action | U4 + length | 1 |
| app/electrolysis-software/page.tsx | At a glance | How Hone works | U8 | 1 |
| app/manage/[token]/page.tsx | Manage appointment (eyebrow repeated above the same heading) | Deleted | U1 | 1 |

Deleted only redundant eyebrow elements, their now-unused imports and spacing tied to the deleted element. All links, action handlers, state branches, metric calculations and permission checks remain intact. Existing tests and two browser selectors now expect the new labels; they continue checking the same privacy, payment, navigation and availability behavior.

## Deliberate keeps and rejected candidates

- U1/U2/U7: Keep studio identity, booking/intake context where the main title is a studio name, field group headings, visible labels and real step numbers. Remove only repeated valid-state manage/cancel/reschedule labels, thank-you decoration and article category eyebrows. Error-state context remains.
- U3/U4/U5/U6/U8: Keep factual helper text that explains eligibility, payment status, recovery, single-use links, expiry, upcoming actions or the population measured. Shorten only redundant or abstract wording. Product positioning that identifies electrolysis practice software is real audience context. Retain clinical instructions and article prose.
- U9/U10/U11: Status badges, loading placeholders, failure icons and conditional receipt warnings represent real state. No fake Live indicators were introduced or found among the reviewed candidates. Icons identifying controls or destinations remain, including accessible labels.
- U12/U13/U14/U15/U16: Chart legends, series colors, comparison styles, accessible SVG titles/descriptions, axes, real dates, unavailable-data notices and filter scope convey information. Existing hairline grids and soft area fills remain; no gratuitous chart decoration change was justified.
- U21/U22: Remove trailing decorative link arrows and name destinations. Preserve actual directional controls, keyboard instructions, navigation paths, from/to arrows and illustration annotations. Preserve concise controls whose context already defines the action.
- U23: Report only. Analytics headline cards have equal hierarchy; changing their priority needs a separate product decision.
- U24: Retain colored edges that identify clinical caution, alerts, service/practitioner identity or state. No arbitrary accent-stripe removal was justified.
- Surface options (fonts, global geometry, shadows, motion and color system) were not requested. Preserve the established Hone design, keyboard focus and mobile touch targets. The copy changes do not introduce new layout components.
- Privacy, terms, SMS opt-in/evidence wording, clinical records, historical payloads, schema, auth/RLS, payment routing and provider settings are unchanged. Consent warnings and uncertain-booking instructions still communicate the original restrictions.

The 29 current open PRs and their changed-file inventory were checked for overlap. Calendar/charting/payment UI receive only small copy hunks in this branch; their concurrent feature work was not copied, replaced or merged. No changes to other branches.

## Validation

- 80 affected unit/component test files: 1,992 passed, one skipped. This combines the 76-file affected run, the mounted waitlist/calendar check and the two manage-page checks without double-counting the Analytics tests.
- TypeScript passes with a 6 GB Node heap. Default-heap typecheck exhausted memory; no compiler setting was weakened.
- ESLint: no errors; existing unused-code warnings remain. Stripe gates: all 15 checks pass. Diff whitespace check passes.
- Full local unit suite was stopped after automatic review rejected an attempted Sentry telemetry request whose payload was not verified. The completed affected tests use mocks for provider/action calls; no full-suite pass is claimed.
- Local production build could not complete: the default heap exhausted memory; the 6 GB retry was killed after compilation/lint output. Required build CI remains outstanding.
- Attempted representative Analytics desktop/phone fixture screenshots. Local Chromium could not start because its socket operation was denied. No visual/browser pass is claimed. The existing desktop/mobile browser selectors were updated; full CI must exercise them.
- No hosted database, signed-in customer session, real message, live payment or production configuration was accessed or changed.

## Tasks before release

1. Run normal required CI on the final head, including the classifier-selected T3 extended browser/database lanes. Public/token UI paths set the baseline; this copy-only patch adds no trust boundary or SQL. Do not weaken that classification.
2. Review desktop/mobile renders in CI or an available preview; verify the shortened action labels in context.
3. Reconcile overlapping copy hunks if concurrent feature PRs land first. Review and release through the existing authority; this PR is not merged or deployed by this task.
4. U23 remains a separate optional design decision; no action needed for the copy cleanup.
