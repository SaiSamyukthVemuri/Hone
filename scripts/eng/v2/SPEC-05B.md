# ENG-LOOP V1 05B — the decision engine

This is the spec that **both** the implementation and the independent verifier work from. The verifier derives every
expected outcome from this file, ARCH-01 §7 and §17–§24 (frozen draft #800 at `fe62f51f`), and the operator's V1
directive. It never derives them from `decision/`. Where this differs from ARCH-01, `README.md` lists the difference.

## 0. Contract

- `decide(collected, policy)` in `decision/decide.mjs`. `collected` is the 05A collector's result (SPEC-05A §5.4):
  `{ ok: true, evidence }` or `{ ok: false, reason, detail, … }`. `policy` defaults to `decision/policy.mjs`.
- **Pure.** No GitHub, file, shell, clock or credential access, and no shared mutable state. It imports nothing from
  `adapter/`.
- **Total.** Nothing throws. Any input outside the contract decides `UNKNOWN` with reason `malformed`.
- **Deterministic and permutation-invariant.** The order of reviews, threads and external contexts never matters.
- Output, frozen: `{ decision, reasonCodes, blocking, nextAction, humanMergeRequired: true }`.
  - `decision` is one of the 13 values in §2.
  - `reasonCodes` is `[decision]`, or `[reason]` for `UNKNOWN`, where `reason` is a closed reason from
    `contract/reasons.mjs`. An open-set reason becomes `malformed`.
  - `blocking` is the evidence behind the decision (§2).
  - `nextAction` is the fixed string for that decision, or for that `UNKNOWN` reason (`decision/next-action.mjs`).
    Nothing GitHub says is ever copied into it.
  - `humanMergeRequired` is always `true`. `CANDIDATE_READY_FOR_HUMAN_REVIEW` is advisory, never merge permission.

## 1. What 05B reads

A collection failure (`ok: false`) decides `UNKNOWN(reason)` with `blocking: { row: "collection", detail }`.

Otherwise, from `evidence`:

- `schema`, which must be `"eng-loop-v1/evidence@1"`;
- `key` (`state`, `isDraft`, `headSha`, `baseSha`) and `terminal`, which must equal `key.state !== "OPEN"`;
- for an open key, `rows`: `base`, `ci`, `external` and `reviews`. Each is a closed result: `{ ok: true, value }`
  or `{ ok: false, reason, detail }`.
  - `base.value.drift.behindBy` is a non-negative integer.
  - `ci.value.outcome` is one of `SUCCEEDED`, `FAILED`, `PENDING`, `NO_RUN` or `INCOMPLETE`, with optional
    `applicableRunIds` (when present, a list of positive integers) and `missingJob`.
  - `external.value.external` is a list of `{ source: string, state: "success" | "pending" | "failure" }`.
  - `reviews.value.reviews` is a list of `{ channel, actor, verdict, qualifiesAtHead: boolean }`, where `channel` is
    `PR_REVIEW` or `CLEAN_COMMENT` and `verdict` is one of `COMMENTED`, `APPROVED`, `CHANGES_REQUESTED`, `DISMISSED`,
    `PENDING` or `CLEAN` (ARCH-01 §24's closed enums). A value outside them is outside the contract.
  - `reviews.value.threads` is a list of `{ opener, resolved: boolean, resolver, outdated }`.
  - An actor is `null` or `{ id: integer | null, type: string }`.

A value of the wrong type, or outside these closed sets, anywhere 05B reads decides `UNKNOWN(malformed)` — when the
table reaches the row that reads it (§2). Within the closed sets, §3 says which values establish trust; the rest
establish nothing.

## 2. Precedence

The **first** row that holds is the decision. A row result that is a failure decides `UNKNOWN(reason)` **when the
table reaches that row**, with `blocking: { row, detail }`. Rows are consulted in this order, so every row has been
consulted — and none was a failure — before row 11.

| # | Reads | Holds when | Decision | `blocking` |
|---|---|---|---|---|
| 1 | key | `terminal` | `NOT_OPEN` | `{ state }` |
| 2 | key | `key.isDraft` | `DRAFT_HOLD` | `{ headSha }` |
| 3 | `base` | failure, else `behindBy > 0` | `UNKNOWN`, else `NEEDS_REFRESH` | `{ behindBy, baseSha }` |
| 4 | `ci` | failure, else outcome `FAILED` | `UNKNOWN`, else `CI_FAILED` | `{ runIds }` |
| 5 | `external` | failure, else any context `failure` | `UNKNOWN`, else `EXTERNAL_BLOCKED` | `{ sources }`, sorted |
| 6 | `ci` | outcome `NO_RUN`; outcome `INCOMPLETE` | `CI_NOT_STARTED`; `CI_INCOMPLETE` | `{ headSha }`; `{ runIds, missingJob }` |
| 7 | `ci` | outcome `PENDING` | `CI_PENDING` | `{ runIds }` |
| 8 | `external` | any context `pending` | `EXTERNAL_PENDING` | `{ sources }`, sorted |
| 9 | `reviews` | failure, else not TRUSTED_REVIEW_AT_HEAD | `UNKNOWN`, else `REVIEW_MISSING` | `{ headSha10 }` |
| 10 | `reviews` | FINDINGS_OPEN | `FINDINGS_OPEN` | `{ changesRequested, openThreads }` |
| 11 | — | otherwise | `CANDIDATE_READY_FOR_HUMAN_REVIEW` | `{ headSha }` |

`SUCCEEDED` never blocks. External `success` never blocks, and never establishes anything.

## 3. Trust (ARCH-01 §17–§20)

An actor matches a policy entry only when its numeric `id` **and** its `type` both equal the entry's. A `null` actor
or a `null` id matches nothing. Logins are not evidence.

- **TRUSTED_REVIEW_AT_HEAD** holds when some review has `qualifiesAtHead: true`, an actor in `policy.codex`, and
  either channel `PR_REVIEW` with verdict `COMMENTED`, `APPROVED` or `CHANGES_REQUESTED`, or channel
  `CLEAN_COMMENT` with verdict `CLEAN`. Any other combination of the closed values — `DISMISSED`, `PENDING`, `CLEAN`
  on `PR_REVIEW`, `COMMENTED` on `CLEAN_COMMENT` — establishes nothing.
- **FINDINGS_OPEN** holds when either:
  - a `PR_REVIEW` with verdict `CHANGES_REQUESTED`, `qualifiesAtHead: true` and an actor in `policy.codex` exists
    (ARCH-01 §18); or
  - a thread's opener is in `policy.codex`, and the thread is unresolved or its resolver is not in
    `policy.humanResolvers` (§19).

  `outdated`, severity and the head that raised a thread never matter. A thread opened by anyone else never counts.

Policy (`decision/policy.mjs`): Codex `{ id: 199175422, type: "Bot" }`; human resolver
`{ id: 26781116, type: "User" }`.
