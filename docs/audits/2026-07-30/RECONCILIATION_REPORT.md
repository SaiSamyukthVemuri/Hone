# Exact-production findings reconciliation — `c64366c9ba4130283932bbe21e32bf2ed62c4975`, migration max 0160

**Corrected pass 2, 2026-07-30.** Supersedes the first pass, whose 33 self-review defects are all
dispositioned in [REVIEW_CLOSURE_REGISTER.md](./REVIEW_CLOSURE_REGISTER.md).

Sibling reports: [CURRENT_P0_P1_REPORT.md](./CURRENT_P0_P1_REPORT.md) ·
[P2_DISPOSITION_REPORT.md](./P2_DISPOSITION_REPORT.md) ·
[LAUNCH_GATE_MATRIX.md](./LAUNCH_GATE_MATRIX.md) ·
[DEPENDENCY_REMEDIATION_PLAN.md](./DEPENDENCY_REMEDIATION_PLAN.md) ·
[FIRST_REMEDIATION_PR_TRAIN.md](./FIRST_REMEDIATION_PR_TRAIN.md) ·
[DUPLICATE_AND_SUPERSESSION_MAP.md](./DUPLICATE_AND_SUPERSESSION_MAP.md) ·
[EVIDENCE_LIMITATIONS.md](./EVIDENCE_LIMITATIONS.md) ·
[INDEPENDENT_REVIEW_FINDINGS.md](./INDEPENDENT_REVIEW_FINDINGS.md) ·
[AUDIT_INPUT_MANIFEST.json](./AUDIT_INPUT_MANIFEST.json)

## Baseline — per-row verification class

| Field | Value | Verification |
|---|---|---|
| Production SHA | `c64366c9ba4130283932bbe21e32bf2ed62c4975` | **hosted/git-verified** |
| Hosted migration max | **0160** (0159×1, 0160×1, no 0158, 159 total, 0 dupes) | **hosted-verified** |
| Signed-record retirement | flags false ×5 + 2 validated CHECKs; 0/10 retired fns runtime-executable; 1 snapshot re-derives; Willow 0 non-draft | **hosted-verified** |
| Lineage protection | 2 guards, 5 enabled triggers, 0093 guard enabled | **hosted-verified** |
| Willow practitioners | Willow: 2 practitioners total — 1 ACTIVE owner, 1 INACTIVE non-owner. Active non-owner practitioners: 0. Read-only aggregate (roles/active/counts only), 2026-07-30. | **hosted-verified** |
| Latest production deployment | `EdFCbgfuPn7jsh6n73kTcsVwVqEX` | **supplied, not independently verified** — only that hone.care//login//dashboard return 200 was checked |
| Health | 200 / 200 / 200 · 0 unresolved ops alerts | **hosted-verified** |

## A. Executive counts

Original column = the July-27 audit's own severities. Current = this reconciliation, which also adds
rows the July-27 audit did not contain (5 limitations, 5 Chloe items, 2 discovered).

| Severity | Original (Jul 27) | Current OPEN | Partial | Deployed/Verified | Retired/Superseded | Not-a-launch-req | False positive | Status=EVIDENCE_LIMITATION |
|---|---|---|---|---|---|---|---|---|
| P0 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| P1 | 14 | 9 | 1 | 0 | 0 | 0 | 0 | 0 |
| P2 | 31 | 16 | 3 | 0 | 0 | 0 | 0 | 1 |
| P3 | 2 | 19 | 3 | 1 | 3 | 4 | 0 | 0 |
| **Total** | **48** | **44** | **7** | **1** | **3** | **4** | **0** | **1** |

> **Counting convention, used identically in every report:** a finding is **open/partial** when its
> status is `OPEN` or `PARTIALLY_FIXED`. `EVIDENCE_LIMITATION` is never counted as open; it has its
> own column. The last column counts findings whose **status** is `EVIDENCE_LIMITATION`. Separately,
> **51 of 60** findings record something in `missing_evidence` — a "0" in that column never means
> "no finding rests on unverified evidence". See [EVIDENCE_LIMITATIONS.md](./EVIDENCE_LIMITATIONS.md).

**Canonical total: 60** · source rows in the CSV: **134**.

## B. Current P0s

**Zero current P0 confirmed.** Evidence in [CURRENT_P0_P1_REPORT.md](./CURRENT_P0_P1_REPORT.md).

## C. Current P1s (10)

| ID | Title | Exposure | Gate | Train | PR |
|---|---|---|---|---|---|
| `F-CLIN-004` | "Mark reviewed" accepts an unsubmitted (in_progress) intake and any intake in the studio — one UI click creates a false clinical-review sig… | REACHABLE_IN_PRODUCTION | WILLOW_NOW | T5-intake | PR-06 |
| `F-SEC-002` | Any authenticated studio member can create, retime, re-status or delete appointments by direct PostgREST DML, bypassing the owner gates, du… | REACHABLE_IN_PRODUCTION | BEFORE_STUDIO_2 | T8-schedule | PR-16 |
| `F-PAY-001` | Session-payment amount is browser-supplied and unbounded up to CAD 2,000; any active practitioner (not just the owner) can prepare and exec… | REACHABLE_IN_PRODUCTION | BEFORE_STUDIO_2 | T2-payment | PR-03 |
| `F-PRIV-001` | Sentry receives raw bearer credentials embedded in URL path segments (intake, portal, appointment-manage and calendar-feed tokens) | REACHABLE_IN_PRODUCTION | WILLOW_NOW | T4-privacy | PR-05 |
| `F-DATA-001` | Owner ZIP export omits most tenant-owned data (intake, consent, clinical notes, images, payments, portal, numbing/inventory fields) while t… | REACHABLE_IN_PRODUCTION | BEFORE_STUDIO_2 | T0-copy | PR-02, PR-22 |
| `F-IMPORT-001` | Quick Import commits clients and treatment memories in separate statements; a memory-insert failure strands clients permanently with no ide… | REACHABLE_IN_PRODUCTION | BEFORE_STUDIO_2 | T10-data | PR-20 |
| `F-COMP-001` | The in-app Data settings page tells studio owners their clinical data is hosted in Canada while the privacy policy states it is in AWS US-E… | REACHABLE_IN_PRODUCTION | WILLOW_NOW | T0-copy | PR-02 |
| `N-SEC-001` | Session practitioner attribution can be re-pointed, including to another studio's practitioner | REACHABLE_IN_PRODUCTION | BEFORE_STUDIO_2 | T6-identity | PR-08 |
| `N-DOC-001` | Public terms and pricing pages claim a subscription, payment-processing and refund lifecycle the product does not have | REACHABLE_IN_PRODUCTION | WILLOW_NOW | T0-copy | PR-02 |
| `CHLOE-001` | Typing a custom treatment area commits one partial area row per keystroke | REACHABLE_IN_PRODUCTION | WILLOW_NOW | T3-charting | PR-04 |

Four of these did not exist as P1s in the first pass: **`F-PAY-001`** was raised from P2 (live money,
no server-side amount authority), **`N-DOC-001`** was split out of a row that had been closed,
**`F-CLIN-004`** was raised in pass 2 (the P2 basis — practitioner-initiated and reversible — did not
distinguish it from P1s held at P1 on identical grounds), and **`CHLOE-001`** is new from the
studio-owner report.

## D. P2 and P3 disposition summary

| Severity | Count | Open/partial | Evidence-limited | With a PR | Closed/not-required |
|---|---|---|---|---|---|
| P2 | 20 | 19 | 1 | 20 | 0 |
| P3 | 30 | 22 | 0 | 12 | 8 |

Full tables in [P2_DISPOSITION_REPORT.md](./P2_DISPOSITION_REPORT.md).

## E. Retired / superseded / not-required

| ID | Status | Basis |
|---|---|---|
| `F-CLIN-001` | SUPERSEDED_BY_PRODUCT_DECISION | The race requires a finalizer transaction to run concurrently with a child write. There is no longer any way to start a finalizer transaction: the RPC's EXECUTE is revoked from every runtime role, no application code ca… |
| `F-CLIN-002` | SUPERSEDED_BY_PRODUCT_DECISION | The finding's harm is that a verifier could call a hash valid while the snapshot fails to represent structured areas or the later 0155 probe-inventory / 0156 numbing fields. That harm requires snapshots to be a live pro… |
| `F-PAY-002` | NOT_A_LAUNCH_REQUIREMENT | This is not a defect. It is an accurate scope statement about capability that was deliberately not built, and the current source confirms the absence completely and cleanly — the public booking action never touches any … |
| `F-BILL-001` | NOT_A_LAUNCH_REQUIREMENT | SPLIT by the frozen-head review. The unbuilt subscription/billing platform is a capability gap: Willow is invoiced outside the product, so it blocks nothing today but is required before public self-service. The LIVE FAL… |
| `F-EXEC-001` | RETIRED | Retired. The finding described a limitation of the original audit's evidence-gathering environment, not a property of the product, and that limitation does not apply to this reconciliation. Unlike the original ZIP, the … |
| `F-GCAL-003` | NOT_A_LAUNCH_REQUIREMENT | Confirmed as an accurate description of scope, and explicitly NOT an active defect. The two inbound/two-way flag columns exist from 0121 but default false and are read by no runtime code at all - the only reference outs… |
| `F-PROV-001` | NOT_A_LAUNCH_REQUIREMENT | This finding is about the ORIGINAL audit's evidence base, not about the product, and it is now resolved by construction. This reconciliation is not reading a ZIP: it reads a git worktree whose HEAD is the production SHA… |

## F. Open limitations — now first-class canonical rows

L18–L21 are no longer prose: each is a canonical row with severity, reachability, gate, train and
dependencies.

| Limitation | Canonical | Severity | Status | Reachable | Gate | Train |
|---|---|---|---|---|---|---|
| `L18` | `HN-051` | P2 | OPEN | true | BEFORE_TEN_STUDIOS | T7-clinical-dml |
| `L19a` | `HN-052` | P2 | OPEN | false | BEFORE_THREE_STUDIOS | T1-privilege |
| `L19b` | `HN-053` | P2 | OPEN | true | BEFORE_THREE_STUDIOS | T1-privilege |
| `L20` | `HN-054` | P3 | OPEN | false | BEFORE_THREE_STUDIOS | T1-privilege |
| `L21` | `HN-055` | P3 | OPEN | false | POST_GA | NONE |

**L19(a) is larger than previously documented — 64 of 86 public tables** grant TRUNCATE to both browser
roles, including `session_audit`, `audit_logs`, `record_keeping_audit_events`, `stripe_events` and 16
payment/portal tables with RLS-on/zero-policies. It is **not browser-reachable** (NOLOGIN roles;
PostgREST has no TRUNCATE verb), which is why it is P2 defence-in-depth rather than P0.

## G. Historical July-18 register (34 rows)

All 34 preserved with their own `source_recorded_disposition`: **16 PARTIALLY FIXED, 10 OPEN,
5 DEPLOYED, 3 PRODUCTION VERIFIED**. 18 IDs also appear in the July-10 register and are recorded once
per register. `HNE-REC-001`/`HNE-REC-002` are **RETIRED, not future enablement items**.

## H. Independent audit (48 findings)

All 48 preserved and individually re-verified against `c64366c9ba4130283932bbe21e32bf2ed62c4975`, with full source evidence, failure
scenario, prerequisites, test limitations, acceptance criteria, recommended fix and rollout notes
carried into explicit columns.

## I. Findings discovered outside the July-27 audit (12)

| ID | Sev | Source | Why it was not in the July-27 audit |
|---|---|---|---|
| `N-SEC-001` | P1 | this reconciliation | Surfaced by challenging the `F-SEC-001` closure — that finding's own acceptance criteria named practitioner re-parenting, which 0160 does not cover. |
| `N-DOC-001` | P1 | this reconciliation | Split out of `F-BILL-001`, where a live public-claim defect had been buried inside a row closed as not-a-launch-requirement. |
| `CHLOE-001..005` | P1×1, P2×4 | studio-owner report 2026-07-30 | Post-dates the audit; sanitized (no names, screenshots or treatment content). |
| `L18`,`L19a`,`L19b`,`L20`,`L21` | P2×3, P3×2 | known-limitations register | Previously tracked only as prose, outside the machine-readable register. |

## Method

- Nothing classified from a title, PR title, commit message, documentation claim, source-string test,
  or the existence of a function or table.
- Every non-open verdict in pass 1 was adversarially challenged; two were overturned.
- Pass 1's self-review raised 33 defects; pass 2's independent re-review raised a further 25 against
  the corrected head, including several pass-1 items that had been recorded as corrected but were not.
  Both sets are dispositioned in [REVIEW_CLOSURE_REGISTER.md](./REVIEW_CLOSURE_REGISTER.md), which is
  authoritative over the status column of any earlier review artifact.
