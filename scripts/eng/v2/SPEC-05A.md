# ENG-LOOP V1 05A — evidence rules and interfaces

This is the implementation spec that **both** the implementation and the independent verifier work from. The verifier
derives every expected outcome from this file and the records it cites, never from the code under test. It is not an
architecture record. Where it differs from a merged record, `README.md` lists the difference.

## 0. Conventions

- Every parser and binder is **pure**: no I/O, no clock and no shared state. Time enters only as a value: the
  observation time, and the timestamps GitHub recorded.
- A parser takes the raw response and the request parameters. It returns
  `{ ok: true, record }` or `{ ok: false, reason, detail }`. A binder returns `{ ok: true, value }` or
  `{ ok: false, reason, detail }`.
- `reason` is always a member of `contract/reasons.mjs`. Nothing throws. Every returned record is frozen.
- **GraphQL** answers must carry exactly the requested fields. **REST** answers must carry each *consumed* field with
  the right type. Other REST fields are ignored, because GitHub adds REST fields over time.
- A collection is either complete in one response or it fails closed. Nothing pages across requests.
- **`totalCount` on a filtered `timelineItems` connection is never used.** Live (2026-10-07), it counts every timeline
  item, not the filtered ones. #720 reports `totalCount` 36 for its single `BaseRefChangedEvent`. Only filtered
  `nodes` plus `pageInfo.hasNextPage == false` count.

## 1. Row 1 — PR identity (implemented)

`contract/pr-key.mjs`: `parsePrKey(raw, { expectedNumber })` and `keysEqual(a, b)`.
`adapter/internal/coherence.mjs`: `collectCoherent({ readKey, readBody })` and
`confirmPass({ first, readKey, readBody, sameEvidence })`.

The rules are PR-SNAPSHOT-01 §2–§7 (nine fields, with `isDraft` included) and ARCH-01 §15 (the confirming pass).

## 2. Row 2 — production base, drift and PR context

**Policy:** `productionRef = "claude/build-hone-saas-hOex7"` and `targetRepoId = 1240764106`.

### 2.1 `parseCompare(raw, { baseSha })` — REST `compare/{baseSha}...{headSha}`

| Field | Rule |
|---|---|
| `status` | `ahead`, `behind`, `diverged` or `identical`; anything else → `malformed` |
| `behind_by`, `ahead_by` | non-negative safe integers |
| `base_commit.sha` | 40 lowercase hex, equal to `baseSha` |
| `merge_base_commit.sha` | 40 lowercase hex |
| `files` | an array, each element with a non-empty string `filename`. An absent `files` is `malformed` |

Record: `{ status, behindBy, aheadBy, baseSha, mergeBaseSha, files: [filenames], filesCapped }`. `filesCapped` is
`files.length >= 300`, because GitHub truncates a compare's file list at 300.

### 2.2 `parsePrContext(raw, { expectedNumber, headSha })` — GraphQL, exact fields

```
repository(owner,name){
  pullRequest(number:N){ number createdAt changedFiles
    baseRefChanges: timelineItems(itemTypes:[BASE_REF_CHANGED_EVENT], first:100){ pageInfo{hasNextPage} nodes{__typename} } }
  object(oid:H){ __typename ... on Commit { associatedPullRequests(first:100){ pageInfo{hasNextPage} nodes{number} } } } }
```

| Field | Rule |
|---|---|
| `number` | equal to `expectedNumber` |
| `createdAt` | an ISO-8601 UTC timestamp string |
| `changedFiles` | a non-negative safe integer |
| `baseRefChanges` | every node is `{ __typename: "BaseRefChangedEvent" }`. `hasNextPage: true` → the record carries `baseRefChanges: "too_many"` |
| `object` | a `Commit`; `null` → `read_failed` |
| `associatedPullRequests` | `nodes[].number` positive integers. `hasNextPage: true` → `"too_many"` |

A GraphQL error → `read_failed`. Any other shape → `malformed`.
Record: `{ createdAt, changedFiles, baseRefChanges: <count> | "too_many", associatedPrNumbers: [..] | "too_many" }`.

### 2.3 `parseHeadBranchPrs(raw, { headRef })` — REST `pulls?head=<owner>:<headRef>&state=all&per_page=100`

The answer is an array. Each element has `number` (positive integer), `state` (`open` or `closed`), `head.ref` equal
to `headRef`, and `head.repo` that is `null` or carries a positive integer `id`. Anything else → `malformed`.
Record: `{ numbers: [...], capped: length >= 100 }`.

### 2.4 `parseBranchRules(raw)` — REST `rules/branches/{productionRef}`

The answer is an array of objects, each with a non-empty string `type`.
Record: `{ types: [...], nonFastForward: types.includes("non_fast_forward"), deletion: types.includes("deletion") }`.

Bypass actors are **not readable** with a read-only token (GitHub returns them only to writers). So rules prove
only the *current* prevention, never history (§3).

### 2.5 `parseActivity(raw, { activityType, ref })` — REST `activity?ref=refs/heads/<productionRef>&activity_type=<t>&time_period=year&per_page=100`

The answer is an array. Each element has `activity_type` equal to the requested type, `ref` equal to
`refs/heads/<productionRef>`, an ISO-8601 `timestamp`, and `before`/`after` that are 40-hex strings.
Record: `{ events: [{ timestamp, before, after }], capped: length >= 100 }`.

### 2.6 `bindBase({ key, productionRef, compare, prContext })`

Called for OPEN keys only.

1. `key.baseRef !== productionRef` → `base_ref`.
2. The compare was requested with `key.baseSha`. If the record's base disagrees → `malformed`.
3. Value: `{ drift: { behindBy, aheadBy }, mergeBaseSha, files, filesCapped, changedFiles, createdAt, baseRefChanges,
   associatedPrNumbers }`.

The 05B precedence puts `behindBy > 0` → `NEEDS_REFRESH` before every CI rule.

## 3. Row 3 — applicable CI: the V1 conservative model

V1 has **no run-side attestation** (no `ci.yml` change). It proves the execution context from GitHub-computed evidence
instead. **Policy:** `workflowId = 289443461` (`.github/workflows/ci.yml`); accepted event `pull_request` only.

### 3.1 `parseWorkflowRuns(raw, { workflowId, headSha })`

The source is REST `actions/workflows/{workflowId}/runs?head_sha=H&event=pull_request&per_page=100`. The listing law
is CAP-01 §4/§15:
- `total_count` is a non-negative integer, ≤ 100, equal to `workflow_runs.length`;
- run ids and `run_number`s are unique;
- otherwise `total_count > 100` → `ci_candidate_listing_too_large`, and any other violation → `malformed`.

Each run carries:
- `id` and `run_number`: positive integers;
- `workflow_id`: positive integer;
- `event`: a string;
- `head_sha`: 40 hex;
- `head_branch`: a string or `null`;
- `head_repository`: `{ id: positive integer }` or `null`;
- `status`: a string;
- `conclusion`: a string or `null`;
- `run_attempt`: a positive integer;
- `created_at`: ISO-8601.

The record keeps these fields only, never `pull_requests`.

### 3.2 `parseRunJobs(raw, { runId })` — REST `actions/runs/{runId}/jobs?filter=latest&per_page=100`

- `total_count` equals `jobs.length` and is ≤ 100; otherwise `ci_candidate_listing_too_large` or `malformed`.
- Each job has a non-empty `name`, `run_id` equal to `runId`, a string `status`, and a `conclusion` that is a string
  or `null`.

### 3.3 Required jobs — `requiredJobs(classification)`

`classification` is the output of **production's** `scripts/classify-changes.mjs` `classify(files)` on the PR's
changed files.

| Job name (from production `ci.yml`) | Required when |
|---|---|
| `changed-path detection` | always |
| `browser e2e (local stack)` | always (the aggregator, `if: always()`) |
| `typecheck / lint / build / test / safety gates` | `!docs_only` |
| `db integration (local supabase)` | `database \|\| security \|\| full_matrix_required` |
| `payment browser e2e (fake stripe)` | `payment \|\| full_matrix_required` |
| `mobile completion e2e (chromium iphone-profile)` | `mobile \|\| full_matrix_required` |
| `google browser e2e (fake google)` | `google_calendar \|\| full_matrix_required` |

Browser shards are covered by the aggregator. A test pins these names against production's `ci.yml`, so a rename
there turns CI red rather than leaving the table stale.

### 3.4 `bindCi({ key, base, headBranchPrs, runs, jobsByRunId, requiredJobNames, rules, activity, observedAt, workflowId, targetRepoId })`

`base` is the §2.6 value, `headBranchPrs` the §2.3 record, `requiredJobNames` the §3.3 set, `rules` the §2.4 record,
`activity` `{ forcePush, branchDeletion }` (each a §2.5 record), and `observedAt` an ISO-8601 time from 05A.

Rules apply in this order. The first that fires decides.

1. `key.headRepoId !== targetRepoId` (a fork) → `fork_head`.
2. Changed files cannot be proven complete: `filesCapped`, or `files.length !== changedFiles` → `diff_too_large`.
3. The PR changes CI's own definition — `.github/workflows/ci.yml`, `scripts/classify-changes.mjs` or
   `scripts/browser-groups.mjs` → `ci_definition_changed`. Required lanes would then come from code the PR controls.
4. `base.baseRefChanges` is not `0` (a count or `"too_many"`) → `base_ref_changed`. Recovery is a new PR.
5. Shared head. Either of these → `shared_head`:
   - `headBranchPrs.numbers` is not exactly `[key.prNumber]`, or `headBranchPrs.capped`;
   - `associatedPrNumbers` is not exactly `[key.prNumber]`, or is `"too_many"`.
6. Current prevention: `rules.nonFastForward && rules.deletion` is false → `base_history_unverified`.
7. **Applicable runs** are those with all of:
   - `workflow_id === workflowId`;
   - `event === "pull_request"`;
   - `head_sha === key.headSha`;
   - `head_repository?.id === key.headRepoId`;
   - `head_branch === key.headRef`.

   Any other run is ignored: it neither grants nor blocks. With none → value outcome `NO_RUN`.
8. **History.** The production history window must cover every applicable run, as recorded fact rather than settings.
   Any of these → `base_history_unverified`:
   - the earliest applicable `created_at` is more than 360 days before `observedAt`;
   - either activity listing is `capped`;
   - any `force_push` or `branch_deletion` event has `timestamp` ≥ the earliest applicable `created_at`.

   A rewrite before the earliest run is irrelevant: that run tested a base taken after it.
9. Each applicable run's state, as a closed table:
   - `status: "completed"`:
     - `conclusion` `success` → SUCCEEDED;
     - `failure`, `cancelled`, `timed_out`, `action_required`, `neutral`, `skipped`, `stale` or `startup_failure`
       → FAILED;
     - any other string → `unrecognized_ci_conclusion`;
     - `null` → `malformed`.
   - `status` `queued`, `in_progress`, `waiting`, `requested` or `pending` → PENDING.
   - Any other status → `unrecognized_ci_status`.
10. Aggregate over **every** applicable run. Any FAILED → `FAILED`; otherwise any PENDING → `PENDING`. Otherwise, every
    SUCCEEDED run's latest-attempt jobs must include each required job with `completed`/`success`. A missing or
    non-success required job → `INCOMPLETE`; otherwise `SUCCEEDED`. A required job's listing that cannot be complete →
    `ci_candidate_listing_too_large`.

Value: `{ outcome: "SUCCEEDED" | "FAILED" | "PENDING" | "NO_RUN" | "INCOMPLETE", applicableRunIds: [...] }`.

**Why this binds the execution context** (the claim the verifier must try to break):
- The run's PR is the one PR whose head branch is `key.headRef`, by steps 5 and 7.
- The run's base was always production, because this PR has no base change (step 4).
- Production has not been rewritten since the run (step 8). So the run's base tip B is an ancestor of today's tip.
- `behindBy == 0` makes today's tip an ancestor of H. So B is an ancestor of H, and the tested merge's tree is H's
  tree.

### 3.5 Provenance negative controls (each must yield non-candidacy)

| # | Case | Expected | Source |
|---|---|---|---|
| NC1 | An older same-SHA run belonged to another PR that is now closed | `shared_head` (same branch), or ignored at step 7 (other branch) | synthetic: no Hone head branch has had two PRs in the last 400 |
| NC2 | Production was rewritten after a run, while current rules look fine | `base_history_unverified` (step 8) | synthetic activity; real activity shows 0 force pushes |
| NC3 | A successful **push** run at H did not run PR validation | ignored at step 7 → `NO_RUN` | real run shape, synthetic pairing |
| NC4 | The PR was retargeted without a fresh run | `base_ref_changed` | **real**: #720 (`feat/ui-r02-product-polish` → production), #716, #721–#723, #727, #764 |
| NC5 | A required job was skipped, missing or incomplete | `INCOMPLETE`, or `NO_RUN`, or `ci_candidate_listing_too_large` | real job shapes from #810's run, synthetic skips |
| NC6 | An unrelated successful run exists at the same head SHA | ignored at step 7 | synthetic |

## 4. Rows 4–6 (to follow)

- **Review evidence and threads:** one GraphQL `readReviewEvidence` (CAP-01 §17 completeness).
  - The semantics are ARCH-01 §17–§21: two channels, the marker policy, `CHANGES_REQUESTED`, and trusted openers and
    resolvers.
  - Channel B is a 10-hex V1 binding (ARCH-01 §41).
- **External contexts:** one GraphQL `readCommitRollup(H)`, normalized by EXT-CONTEXT-01.

## 5. Reasons this spec adds to the V1 closed set

`fork_head`, `diff_too_large`, `ci_definition_changed`, and the profile's `base_ref`, `base_ref_changed`,
`shared_head` and `base_history_unverified`.
