# EXT-CONTEXT-01 — closed external-check normalization for ENG-LOOP V1

| Field | Value |
|---|---|
| **Decision** | ENG-LOOP V1 normalizes a commit's external checks through **closed** tables only. Each GitHub value it accepts is listed explicitly, and any other value fails closed. GitHub Actions check runs are excluded from the external domain. The result is a multiset of normalized external facts — each `pending`, `success` or `failure` — or one closed `UNKNOWN` reason for the whole collection. |
| **Date** | 2026-10-07 |
| **Status** | **PROPOSED** in this pull request; **ACCEPTED** when merged. |
| **Decided by** | Sam (operator), after Codex's exact-head review of ARCH-01 (PR #800 at `390e12af8d`) found an open-domain rule — `CheckRun` `status` ≠ `COMPLETED` → `pending` (P2 `4209025702`) — and #800's stop law fired. |
| **Consumers** | ARCH-01 (ENG-LOOP V2 evidence collection and 05B precedence, PR #800), which re-enters by removal after this record merges (§11). |
| **Scope** | Which commit checks count as external; the GitHub Actions discriminator; the closed `StatusContext` mapping; the closed `CheckRun` status and conclusion mappings; the normalized external state. |
| **Not in scope** | Reading GitHub (CAP-01); GitHub Actions CI authority (CI-ATTEST-01); decision precedence (ARCH-01); edits to #800; `ci.yml`; 05A; 05B. |
| **Depends on** | CAP-01 (`docs/decisions/cap-01-github-capability-boundary.md`), whose `readCommitRollup` supplies the input (§3). |
| **Authored at** | production `c26bbdec96c3fb6cde0845e2d75ef012daa09755`. Schema and API evidence read on 2026-10-07 (Appendix). |

> **Normative.** Where an implementation and this record disagree, the implementation is wrong. A semantic change —
> including a value GitHub adds to any of these enums — is made here first, never through a default or a review-repair
> round (§10).

---

## 1. The class this record ends

The failure class is a mapping that names one value and sends everything else to a bucket: negative enumeration over an
open domain. The instance was `CheckRun` `status` ≠ `COMPLETED` → `pending`, which would silently turn any status GitHub
adds into `pending` instead of failing closed (Codex P2 `4209025702` on #800).

**The law.** Every accepted GitHub value is listed. There is no default branch, no "other" bucket, and no rule of the
form "not X".

## 2. Ownership — no overlap

| Owner | Owns |
|---|---|
| CAP-01 | the GraphQL read of the commit's rollup; one-response completeness; the typed *complete*, *incomplete* or *malformed* reader result (CAP-01 §4, §17) |
| EXT-CONTEXT-01 | converting the validated rollup contexts into the closed normalized external domain (§4–§8) |
| ARCH-01 (05B) | consuming only the normalized external facts and applying decision precedence |
| CI-ATTEST-01 | GitHub Actions CI authority, alone |

## 3. Input

The input is CAP-01's *complete* `readCommitRollup` result for `K0.headSha` (PR-SNAPSHOT-01 §5). An *incomplete* or
*malformed* reader result never reaches this record: `collect` maps it to `UNKNOWN(external_contexts_too_large)` or
`UNKNOWN(malformed)` first (CAP-01 §6, §17). A complete, empty set of contexts is valid and yields no external facts.

EXT-CONTEXT-01 reads nothing from GitHub. It consumes the context records only. Each is a `StatusContext` or a
`CheckRun`, the two members of GitHub's `StatusCheckRollupContext` union (Appendix).

## 4. The external domain and the GitHub Actions discriminator

- **Every `StatusContext` is external.**
- **A `CheckRun` belongs to GitHub Actions iff `checkSuite.app.slug == "github-actions"`.** That is the only
  discriminator. No check name, workflow name, context name, `detailsUrl` or naming convention is ever used.
- **GitHub Actions check runs are excluded from the external domain.** Whatever their status or conclusion, they never
  grant or block through external-context semantics. GitHub Actions CI authority is CI-ATTEST-01's alone.
- **Every other `CheckRun` is external.**
- **A `CheckRun` that cannot be classified** — its check suite has no app, or no readable `slug` — makes the collection
  `UNKNOWN(malformed)`. GitHub's schema allows `CheckSuite.app` to be `null` (Appendix).

## 5. `StatusContext.state` — closed table

| `state` | Normalized |
|---|---|
| `SUCCESS` | `success` |
| `PENDING`, `EXPECTED` | `pending` |
| `ERROR`, `FAILURE` | `failure` |
| any other value | `UNKNOWN(unrecognized_context_state)` |

## 6. External `CheckRun.status` — closed table

| `status` | Normalized |
|---|---|
| `REQUESTED`, `QUEUED`, `IN_PROGRESS`, `WAITING`, `PENDING` | `pending` |
| `COMPLETED` | the conclusion table (§7) |
| any other value | `UNKNOWN(unrecognized_context_state)` |

These five are exactly the non-completed values of GitHub's `CheckStatusState` at authoring (Appendix). There is no rule
of the form `status` ≠ `COMPLETED`. The conclusion of a check run that is not `COMPLETED` is not read.

## 7. External `CheckRun.conclusion` when `status` is `COMPLETED` — closed table

| `conclusion` | Normalized |
|---|---|
| `SUCCESS`, `NEUTRAL`, `SKIPPED` | `success` |
| `FAILURE`, `CANCELLED`, `TIMED_OUT`, `ACTION_REQUIRED`, `STARTUP_FAILURE`, `STALE` | `failure` |
| `null`, a malformed value, or any other value | `UNKNOWN(unrecognized_context_state)` |

## 8. Normalized output and the negative-only law

The binding yields either a multiset of normalized external facts, one per external context:

```ts
{ source: string /* display metadata only */; state: "pending" | "success" | "failure" }
```

or exactly one closed reason for the whole collection:
- `unrecognized_context_state` — a `StatusContext.state`, an external `CheckRun.status` or a completed external
  `CheckRun.conclusion` that is not a value its table lists, `null` and non-string values included (§5–§7);
- `malformed` — a context that cannot be placed in the domain: a `CheckRun` that §4 cannot classify, or a context that
  is neither a `StatusContext` nor a `CheckRun`.

`collect` turns the reason into `UNKNOWN(reason)` for the whole snapshot (CAP-01 §6), and no partial set survives. When
several contexts fail, the reason does not depend on their order: `malformed` if any context is malformed, otherwise
`unrecognized_context_state`. Both reasons are already in ARCH-01's closed reason set; this record adds none.

- `source` is the context's display name (`StatusContext.context`, `CheckRun.name`). It never decides anything.
- The multiset is order-free: a permutation of the same contexts normalizes to the same multiset.
- 05B never sees `CheckRun.status`, `CheckRun.conclusion`, `StatusContext.state`, `checkSuite.app.slug` or any GitHub
  enum string.

**Negative-only.** External facts can only hold or block:
- `success` is inert;
- `pending` may produce ARCH-01's `EXTERNAL_PENDING`;
- `failure` may produce ARCH-01's `EXTERNAL_BLOCKED`.

External success can **never** grant candidacy. Where these effects fall in the decision precedence is ARCH-01's.

## 9. Required fixtures

| # | Input | Required result |
|---|---|---|
| 1 | `StatusContext` `SUCCESS` | `success` |
| 2 | `StatusContext` `PENDING`; `StatusContext` `EXPECTED` | `pending` |
| 3 | `StatusContext` `ERROR`; `StatusContext` `FAILURE` | `failure` |
| 4 | `StatusContext` with an unknown state | `UNKNOWN(unrecognized_context_state)` |
| 5 | external `CheckRun` `REQUESTED` | `pending` |
| 6 | external `CheckRun` `QUEUED` | `pending` |
| 7 | external `CheckRun` `IN_PROGRESS` | `pending` |
| 8 | external `CheckRun` `WAITING` | `pending` |
| 9 | external `CheckRun` `PENDING` | `pending` |
| 10 | `COMPLETED` + `SUCCESS` | `success` |
| 11 | `COMPLETED` + `NEUTRAL` | `success` |
| 12 | `COMPLETED` + `SKIPPED` | `success` |
| 13 | `COMPLETED` + each of `FAILURE`, `CANCELLED`, `TIMED_OUT`, `ACTION_REQUIRED`, `STARTUP_FAILURE`, `STALE` | `failure`, for each |
| 14 | external `CheckRun` with an unknown status | `UNKNOWN(unrecognized_context_state)` |
| 15 | `COMPLETED` + an unknown conclusion | `UNKNOWN(unrecognized_context_state)` |
| 16 | `COMPLETED` + a `null` conclusion | `UNKNOWN(unrecognized_context_state)` |
| 17 | a GitHub Actions `CheckRun`, with any status or conclusion — `FAILURE` included | excluded from the external domain |
| 18 | a `CheckRun` whose check suite has no app, or no readable slug | `UNKNOWN(malformed)` |
| 19 | a permutation of the same contexts | the same normalized multiset |
| 20 | only external successes | never sufficient for readiness |
| 21 | one malformed and one unrecognized context, in either order | `UNKNOWN(malformed)` |
| 22 | the recorded real rollup of `390e12af8d` (Appendix) | two `success` facts: the `vercel` app's `CheckRun` and the `Vercel` `StatusContext` |

## 10. Schema change

A value GitHub adds to `CheckStatusState`, `CheckConclusionState` or `StatusState` makes every affected collection
`UNKNOWN(unrecognized_context_state)` until this record is amended to list it. That is deliberate: new API semantics
surface as `UNKNOWN`, never as a guess. Listing a new value is a semantic change made here first, with its own review.

## 11. Consumer re-entry

After this record merges, #800 re-enters **by removal**:
- it removes its raw `StatusContext` and `CheckRun` tables and its Actions-discriminator detail;
- it states only that ARCH-01 consumes this record's normalized external facts;
- it keeps 05B's precedence: any external `failure` → `EXTERNAL_BLOCKED`, any external `pending` → `EXTERNAL_PENDING`,
  `success` inert;
- it resolves P2 `4209025702` by pointing here.

## 12. Review budget

One plain exact-head review round. One semantic repair is allowed. A second P0–P2 in the same family → **stop**, with
no patch loop. Families: the external domain and the Actions discriminator; the closed value tables; the normalized
output and its reasons.

Pure prose, formatting or non-normative feedback does not consume the budget.

## 13. Non-goals

This record adds no GitHub read, reader or CAP-01 change; no CI authority, which is CI-ATTEST-01's; no decision
precedence, which is ARCH-01's; no new `UNKNOWN` reason; no name-based heuristics; no edit to #800; no `ci.yml`, 05A or
05B; and no runtime code.

---

## Appendix — schema and API evidence (2026-10-07)

**Live GraphQL introspection** (read-only, 2026-10-07T18:45Z; `includeDeprecated: true`, and no value is deprecated):

| Enum | Values |
|---|---|
| `CheckStatusState` | `REQUESTED`, `QUEUED`, `IN_PROGRESS`, `COMPLETED`, `WAITING`, `PENDING` |
| `CheckConclusionState` | `ACTION_REQUIRED`, `TIMED_OUT`, `CANCELLED`, `FAILURE`, `SUCCESS`, `NEUTRAL`, `SKIPPED`, `STARTUP_FAILURE`, `STALE` |
| `StatusState` | `EXPECTED`, `ERROR`, `FAILURE`, `PENDING`, `SUCCESS` |

§5 covers all five `StatusState` values. §6 lists the five non-completed `CheckStatusState` values plus `COMPLETED`, and
§7 covers all nine `CheckConclusionState` values.

**Field types** (`!` = non-null):

| Field | Type |
|---|---|
| `StatusCheckRollupContext` | union of `CheckRun`, `StatusContext` |
| `CheckRun.status` | `CheckStatusState!` |
| `CheckRun.conclusion` | `CheckConclusionState` (nullable) |
| `CheckRun.checkSuite` | `CheckSuite!` |
| `CheckSuite.app` | `App` (nullable) |
| `App.slug` | `String!` |
| `CheckRun.name` | `String!` |
| `StatusContext.state` | `StatusState!` |
| `StatusContext.context` | `String!` |

**Live rollups in this repository** (`statusCheckRollup.contexts`, `first: 100`, `hasNextPage` false):

| Commit | Contexts |
|---|---|
| production `c26bbdec96` | 12: eleven GitHub Actions `CheckRun`s (ten `COMPLETED`/`SUCCESS`, one `COMPLETED`/`FAILURE`), and one `StatusContext` `Vercel` = `SUCCESS` |
| #800 head `390e12af8d` | 10: eight GitHub Actions `CheckRun`s (six `COMPLETED`/`SKIPPED`, two `COMPLETED`/`SUCCESS`), one `CheckRun` from the app `vercel` (`COMPLETED`/`SUCCESS`), and one `StatusContext` `Vercel` = `SUCCESS` |

On `390e12af8d` the external domain is the `vercel` app's `CheckRun` and the `Vercel` `StatusContext`, both `success`
(fixture 22). On `c26bbdec96` the GitHub Actions `FAILURE` is outside the external domain: it never blocks through
external-context semantics (§4, fixture 17).
