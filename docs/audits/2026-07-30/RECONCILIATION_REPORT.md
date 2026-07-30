# Exact-production findings reconciliation — `c64366c9ba4130283932bbe21e32bf2ed62c4975`, migration max 0160

**Generated 2026-07-30.** Every current classification was verified against the exact production
source at `c64366c9ba4130283932bbe21e32bf2ed62c4975` and read-only hosted evidence. Historical counts are **not** reported as current
counts.

## Baseline (independently re-verified for this run)

| Field | Value |
|---|---|
| Production branch | `claude/build-hone-saas-hOex7` |
| Exact production SHA | `c64366c9ba4130283932bbe21e32bf2ed62c4975` (parents `d77d4434` + `7521dbc4`, PR #483 merge, 2026-07-30T14:50:32-04:00) |
| Runtime-bearing SHA | same |
| Hosted migration max | **0160** — `0159`×1, `0160`×1, **no `0158`**, nothing above 0160, **159 total**, 0 duplicates, `0159` immediately precedes `0160` |
| Latest production deployment | `EdFCbgfuPn7jsh6n73kTcsVwVqEX` (GitHub `5680522621`), success 2026-07-30T18:52:31Z |
| Health | `hone.care`, `/login`, `/dashboard` all 200; 0 unresolved ops alerts |
| Open PRs | 0 |
| Signed-record retirement | flags false on all 5 studios + 2 validated CHECKs; 0/10 retired functions runtime-executable; 1 legacy snapshot, hash re-derives; Willow 0 non-draft; 0 amendments; 0 clinical_audit_events |
| Lineage protection | 2 SECURITY INVOKER guards (`search_path` pinned), 5 enabled triggers, `treatment_images_enforce_integrity` enabled |
| Aggregates | 5 studios · 31 clients · 111 appointments · 76 sessions · 14 charge attempts · 2 copy operations · 1 GCal event link |

## A. Executive counts

| Severity | Original (Jul 27) | Current OPEN | Partial | Deployed/Verified | Retired/Superseded | Not-a-launch-req | False positive | Evidence limitation |
|---|---|---|---|---|---|---|---|---|
| P0 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| P1 | 14 | 6 | 0 | 0 | 0 | 0 | 0 | 0 |
| P2 | 31 | 11 | 4 | 0 | 0 | 0 | 0 | 0 |
| P3 | 2 | 17 | 3 | 1 | 3 | 4 | 0 | 0 |
| **Total** | **48** | **34** | **7** | **1** | **3** | **4** | **0** | **0** |

Current canonical total is **49** (48 July-27 findings + 1 discovered in this run).
The severity distribution moved substantially: the single P0 is gone, P1 fell from 14 to
6, and 28 findings are now P3.

## B. Current P0s

**Zero current P0 confirmed.** Full evidence in `CURRENT_P0_P1_REPORT.md`.

## C. Current P1s (6)

| ID | Title | Exposure | Studio #2 blocker | Dependency |
|---|---|---|---|---|
| `F-SEC-002` | Any authenticated studio member can create, retime, re-status or delete appointments by direct PostgREST DML, bypassing the owner gates, duration authority, booking kill switch, buffer rule and every audit row of create_internal_appointmen… | REACHABLE_IN_PRODUCTION | **YES** | Independent of L18 and of the clinical work. Two coupled steps: (1) revoke insert, update, delete on public.appointments from anon, authenticated (SELECT retained — the user-scoped server client reads appointments in lib/booking/queries.ts… |
| `F-PRIV-001` | Sentry receives raw bearer credentials embedded in URL path segments (intake, portal, appointment-manage and calendar-feed tokens) | REACHABLE_IN_PRODUCTION | no | None — fully self-contained and code-only, confined to lib/observability/sentry-scrub.ts. Three changes: (1) in scrubRequest, canonicalize the path against the known bearer-route prefixes (/intake/, /manage/, /cancel/, /reschedule/, /porta… |
| `F-DATA-001` | Owner ZIP export omits most tenant-owned data (intake, consent, clinical notes, images, payments, portal, numbing/inventory fields) while the UI presents it as a complete backup | REACHABLE_IN_PRODUCTION | **YES** | Two-phase. Phase 1 (no migration, days): correct app/(app)/settings/data/page.tsx to say "partial export", replace the "Not included" paragraph with the real exclusion list (intake, consent, clinical notes, treatment photos, payments, port… |
| `F-IMPORT-001` | Quick Import commits clients and treatment memories in separate statements; a memory-insert failure strands clients permanently with no idempotent repair, and the final batch-completion update is unchecked | REACHABLE_IN_PRODUCTION | **YES** | Needs a transactional import RPC (SECURITY DEFINER, owner-verified, taking the planned clients + memories as one JSON payload and inserting both inside one statement), or staged tables with validate→preview→commit. Requires giving each sou… |
| `F-COMP-001` | The in-app Data settings page tells studio owners their clinical data is hosted in Canada while the privacy policy states it is in AWS US-East-1 | REACHABLE_IN_PRODUCTION | no | Independent of all engineering findings. Shares a root cause with F-DOC-001 — no gated claims manifest — but must not wait for that control to be built. The verified-wording change should precede any further sales conversation. |
| `N-SEC-001` | Session practitioner attribution can be re-pointed, including to another studio's practitioner | REACHABLE_IN_PRODUCTION | **YES** | Independent of L18. Fix is a same-studio composite FK plus/or a 0160-style column guard; both are additive and need no application change (no call site writes these columns from a payload — verify before revoking). |

## E. Retired / superseded findings

| ID | Status | Basis |
|---|---|---|
| `F-CLIN-001` | SUPERSEDED_BY_PRODUCT_DECISION | Finalize-versus-child-write interleaving — unreachable: finalization is permanently retired and cannot be invoked by any runtime role |
| `F-CLIN-002` | SUPERSEDED_BY_PRODUCT_DECISION | Signed snapshot omits authoritative fields — moot: no new snapshot can ever be produced; the one legacy snapshot is frozen legacy evidence |
| `F-PAY-002` | NOT_A_LAUNCH_REQUIREMENT | Public-booking deposits, card-on-file capture at booking, packages and partial/split payments are not built (deliberate scope hold) |
| `F-BILL-001` | NOT_A_LAUNCH_REQUIREMENT | SaaS subscription billing, entitlements, dunning and access-suspension control plane do not exist (studio billing is manual) |
| `F-EXEC-001` | RETIRED | Exact-head verification lanes were environment-blocked for the original audit — now satisfied by a green all-lane CI run on the production SHA |
| `F-GCAL-003` | NOT_A_LAUNCH_REQUIREMENT | Inbound Google busy-time import and true two-way sync are not built (outbound-only scope, correctly labelled in the UI) |
| `F-PROV-001` | NOT_A_LAUNCH_REQUIREMENT | Repository provenance gap from the ZIP-based audit - resolved for this reconciliation by reading a git worktree pinned to the production SHA |

## F. Existing open limitations mapped to canonical findings

| Limitation | Canonical mapping | Current state |
|---|---|---|
| **L18** — `authenticated` direct row DML on 5 clinical tables | Cross-cuts `F-SEC-001` residual + train **T2** | **OPEN.** 0160 pinned lineage columns but removed no grant. Requires 26 call sites to move to narrow commands **first**, then revoke. |
| **L19(a)** — broad TRUNCATE outside the 9 covered tables | Train **T1** | **OPEN, and larger than documented: 64 of 86 public tables grant TRUNCATE to both `anon` and `authenticated`**, including `session_audit`, `audit_logs`, `record_keeping_audit_events`, `appointment_audit`, `stripe_events`, `stripe_payment_audit`, and 16 payment/portal tables that have RLS on with **zero policies**. **Not browser-reachable** (roles are NOLOGIN; PostgREST exposes no TRUNCATE). |
| **L19(b)** — `appointment_id` / `treatment_plan_id` not same-client validated | Train **T3** | **OPEN.** 0160 deliberately did not pin them so re-linking keeps working; the fix is a validating trigger, not a freeze. |
| **L20** — `service_role` retains TRIGGER on the 4 guarded tables | Train **T1** | **OPEN.** Shares L19(a)'s root cause; sweep together. Not app-reachable. |
| **L21** — same-transaction session delete → `23503` | Not a train; watch item | **OPEN, pre-existing, proven 0160-neutral, unreachable from the app.** |

## G. Historical P1 register mapping (July 18, 34 rows)

All 34 IDs preserved in `MASTER_FINDINGS_REGISTER.csv`. **18 of them also appear in the July 10
register** and are recorded once per register. Signed-record items `HNE-REC-001` and `HNE-REC-002`
are **RETIRED — not future enablement items**; see `DUPLICATE_AND_SUPERSESSION_MAP.md`.

## H. Independent audit mapping (July 27, 48 findings)

All 48 F-* IDs preserved and individually re-verified against `c64366c9ba4130283932bbe21e32bf2ed62c4975`. Per-finding evidence is in
`MASTER_FINDINGS_REGISTER.json`.

## I. New findings discovered against `c64366c9ba4130283932bbe21e32bf2ed62c4975`

| ID | Severity | Title | Why it was missed |
|---|---|---|---|
| `N-SEC-001` | **P1** | Session practitioner attribution can be re-pointed, including to another studio's practitioner | Surfaced by adversarially challenging the `F-SEC-001` closure. Migration 0160 closed client/studio/session/block re-parenting; the audit's own acceptance criteria for `F-SEC-001` also named **practitioner** re-parenting, which 0160 does not cover. Verified read-only: all five practitioner FKs on `sessions` are plain single-column FKs to `practitioners(id)` with **no** composite same-studio constraint (0094 added those only for `client_id`/`appointment_id`), **zero** triggers guard those columns, `authenticated` holds UPDATE, and the RLS predicate is on `studio_id` — which does not change. |

## Method notes

- **Two classifications were overturned by adversarial challenge**, both away from false closure:
  `F-SEC-001` (PRODUCTION_VERIFIED → **PARTIALLY_FIXED/P2**) and `F-PROV-001`
  (→ NOT_A_LAUNCH_REQUIREMENT/P3). The `F-SEC-001` correction directly contradicted this program's
  own stated expectation that 0160 would make it production-verified — the expectation was offered as
  a direction to *verify*, and verification found a residual.
- Nothing was classified from a title, PR title, commit message, documentation claim, source-string
  test, or the existence of a function or table.
