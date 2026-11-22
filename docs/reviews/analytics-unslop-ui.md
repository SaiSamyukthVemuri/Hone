# Analytics copy cleanup

Verdict: Light.

Scope: Business > Analytics Overview, Clients, invalid-period header and shared print header. This is the first scoped application of the requested cleanup to Hone, not an app-wide redesign or a claim that other screens were audited.

Reference: https://github.com/felipebasurto/unslop-ui/blob/main/skills/unslop-ui/SKILL.md
Read blob: 94df3c6e03b96a05ceb2093e95df66a054524766 (1.0.1).
No installation, runtime dependency, agent configuration or global style change.

## Rules

Counts are source occurrences changed, not the number of times a shared component renders.

| Rule | Found | Fixed | Kept |
| --- | ---: | ---: | ---: |
| U3 redundant subtitle/context | 2 | 2 | 0 |
| U8 generic slogan/heading | 4 | 4 | 0 |
| unslop 26 abstract wording | 2 | 2 | 0 |
| length | 3 | 3 | 0 |

## Rewritten

| Before | After | Rule |
| --- | --- | --- |
| Your practice, in perspective. | Analytics | U8 |
| Your client relationships | Client rankings | U8 |
| Clients keep coming back | Returning clients | U8 |
| New relationships | First-time clients | U8 |
| Follow-through | Booking follow-up | unslop 26 |
| Client insights | Clients seen | unslop 26 |
| Current as of {date} · a starting point for your review. | Current as of {date}. | U3 |
| Clients without a next booking | No next booking | length |
| Service value and collected: how the figures reconcile | Service value and collected | length |
| What the collected total is made of | Collected breakdown | length |

Deleted the generic header subtitle, its unused source constant/import and single-child wrapper. The title now matches the Business menu destination. Changes do not introduce claims or change metric names in exports.

## Kept on purpose

- Payment and service-value definitions, reconciliation caveats, history limitations and filter scope. They explain facts a heading alone cannot communicate.
- The owner-page/database-access disclosure, print omission notices and missing-data reasons.
- Real dates, conditional unavailable states, chart series key, accessible SVG titles/descriptions, form labels, action links, data tables and pagination.
- The charts, colors, layout, figures, data queries and permissions. No surface option was applied.
- Existing rendered assertions for unreadable money/history, named-client print exclusion, filtering, CSV reconciliation and navigation.

Required access disclosure, unchanged:
Only the studio owner is shown this page. That is a choice about who is shown it, not a protection on the records: other practitioners in this studio can still read the same appointment and client records. Only payment records are restricted to the owner in the database.

## Validation

202 existing tests pass:
- tests/app/financials/analytics-overview-screen.test.ts (161)
- tests/app/financials/analytics-clients-screen.test.ts (41)

Only the two existing heading assertions were updated. Tests render the real screen components and real synthetic view-model fixtures. This local checkout contains the pinned source dependency closure, not a full repository checkout; no claim of a full build/typecheck or browser verification. Full required CI must qualify the PR before release.

## Tasks

- U23 (report only): Overview and Clients use equal headline cards. A separate owner-directed design pass could prioritize the most useful figure; this cleanup does not choose or alter that hierarchy.
- A wider app copy/surface audit is separate. Calendar, Roles, charting, consent/legal text and clinical printing have concurrent writers or specific decisions and were not changed.

