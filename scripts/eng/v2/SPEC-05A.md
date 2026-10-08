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
- `reason` is always a member of `contract/reasons.mjs`. Nothing throws: an exotic input (a throwing getter, a
  Proxy, `null` options) is `malformed`. Every returned record is frozen.
- **Request parameters are required.** A parser checks the answer against what was asked for: the PR number, the
  base SHA, the head branch, the run id, the activity type and ref, the commit. A missing or invalid parameter is
  `malformed`, even when the answer is empty, because an unchecked answer is not evidence for the request.
- **Malformed wins.** A schema violation is `malformed` even when the collection is also incomplete, so the reason
  never depends on the order of the checks.
- **Canonical order.** A record's lists come out in a fixed order, so any reordering of the same answer normalizes to
  the identical record (CAP-01 L7):
  - compare `files`, rule `types`: by string;
  - `associatedPrNumbers`, head-branch `numbers`: by number;
  - activity `events`: by `timestamp`, then `before`, then `after`;
  - runs: by `runNumber`; jobs: by `name`, `status`, `conclusion`;
  - reviews and comments: by `id`; threads and rollup contexts: by their canonical JSON.
- **Binders check their inputs first.** Every binder validates every input against the record shapes this spec
  defines before any rule runs. An input outside them — `null`, a partial key, a `Map` where a plain object is
  specified, a missing flag — is `malformed`, never a pass and never another rule's reason.
- **GraphQL** answers must carry exactly the requested fields. **REST** answers must carry each *consumed* field with
  the right type. Other REST fields are ignored, because GitHub adds REST fields over time.
- A collection is either complete in one response or it fails closed. Nothing pages across requests.
- **`totalCount` on a filtered `timelineItems` connection is never used.** Live (2026-10-07), it counts every timeline
  item, not the filtered ones. #720 reports `totalCount` 36 for its single `BaseRefChangedEvent`. Only filtered
  `nodes` plus `pageInfo.hasNextPage == false` count.

## 1. Row 1 — PR identity (implemented)

`contract/pr-key.mjs`: `parsePrKey(raw, { expectedNumber })`, `isPrKey(k)` and `keysEqual(a, b)`.
`adapter/internal/coherence.mjs`: `collectCoherent({ readKey, readBody })` and
`confirmPass({ first, readKey, readBody, sameEvidence })`.

The rules are PR-SNAPSHOT-01 §2–§7 (nine fields, with `isDraft` included) and ARCH-01 §15 (the confirming pass).

- `expectedNumber` is required (§0): without it, `parsePrKey` is `malformed`.
- `isPrKey(k)` is true exactly for a value `parsePrKey` could return as a key: the nine fields and nothing else; an
  OPEN key has a positive `headRepoId` and a 40-hex `baseSha`; a terminal key has `baseSha: null` and a `headRepoId`
  that is `null` or positive.
- The coherence passes re-check every reader result. A key result whose `key` fails `isPrKey` is `malformed`, even
  when it repeats. A body result without an own, defined `value` is `read_failed`. A failure naming a reason outside
  `contract/reasons.mjs`, or anything that is not a result, is `read_failed`.

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

### 2.2 `parsePrContext(raw, { expectedNumber })` — GraphQL, exact fields

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

`activityType` is one of `force_push`, `branch_deletion` or `branch_creation`. `ref` is the **full** ref,
`refs/heads/<productionRef>`; a bare branch name is refused (§0).
The answer is an array. Each element has `activity_type` equal to the requested type, `ref` equal to the requested
`ref`, an ISO-8601 `timestamp`, and `before`/`after` that are 40-hex strings.
Record: `{ events: [{ timestamp, before, after }], capped: length >= 100 }`.

Live (2026-10-07): production has no `force_push` and no `branch_deletion` event, and one `branch_creation`
(2026-05-16T14:46:37Z, `before` all zeros).

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

### 3.1 `parseWorkflowRuns(raw)`

The source is REST `actions/workflows/{workflowId}/runs?head_sha=H&event=pull_request&per_page=100`. The request's
filters are never trusted: §3.4 step 7 re-applies them to every run. The listing law is CAP-01 §4/§15:
- `total_count` is a non-negative integer and `workflow_runs` an array, else `malformed`;
- every run satisfies the schema below, and run ids and `run_number`s are unique, else `malformed`;
- then `total_count > 100`, or `total_count !== workflow_runs.length`, → `ci_candidate_listing_too_large` (CAP-01 L4:
  the listing is not provably complete). A schema violation wins (§0).

Each run carries:
- `id` and `run_number`: positive integers;
- `workflow_id`: positive integer;
- `event`: a string;
- `head_sha`: 40 hex;
- `head_branch`: a string or `null`;
- `head_repository`: `{ id: positive integer }` or `null`;
- `status`: any string, the empty string included. An unknown status is §3.4 step 9's `unrecognized_ci_status`;
- `conclusion`: a string or `null`;
- `run_attempt`: a positive integer;
- `created_at`: ISO-8601.

Record: `{ runs: [{ id, runNumber, workflowId, event, headSha, headBranch, headRepoId, status, conclusion,
runAttempt, createdAt }] }`, sorted by ascending `runNumber`. It never keeps `pull_requests`.

### 3.2 `parseRunJobs(raw, { runId })` — REST `actions/runs/{runId}/jobs?filter=latest&per_page=100`

- `runId` is required (§0).
- Each job has a non-empty `name`, `run_id` equal to `runId`, a `status` that is any string, and a `conclusion` that
  is a string or `null`. Otherwise `malformed`.
- Then `total_count > 100`, or `total_count !== jobs.length`, → `ci_candidate_listing_too_large`.
- Record: `{ jobs: [{ name, status, conclusion }] }`, sorted by `name`, then `status`, then `conclusion` (`null`
  first).

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

Inputs:
- `base`: the §2.6 value;
- `headBranchPrs`: the §2.3 record;
- `runs`: the §3.1 record, `{ runs: [...] }`;
- `jobsByRunId`: a plain object from run id to that run's §3.2 record. A run with no entry has no available listing;
- `requiredJobNames`: the §3.3 set;
- `rules`: the §2.4 record;
- `activity`: `{ forcePush, branchDeletion, branchCreation }`, each a §2.5 record;
- `observedAt`: an ISO-8601 time from 05A.

An input outside these shapes is `malformed`, never a pass. The shapes are checked **before** rule 1, so `malformed`
wins over every rule below. `requiredJobNames` must be a non-empty list of distinct §3.3 job names that includes
both always-required jobs (`changed-path detection` and `browser e2e (local stack)`).

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
   - any of the three activity listings is `capped` (a listing whose `capped` or `events` is malformed never gets
     here: it is `malformed` before rule 1);
   - **any** `force_push` or `branch_deletion` event in the listing, whatever its time;
   - any `branch_creation` event whose `timestamp` is not strictly before the earliest applicable `created_at` (an
     unparseable timestamp included).

   **Why any rewrite in the year blocks (verifier finding A1).** A `pull_request` run's base is fixed when GitHub
   computes the test merge, which happens *before* the run record exists: a PR with a merge conflict gets no run at
   all. So `created_at` cannot bound a rewrite. The unsafe sequence is: GitHub computes merge(P_old, H); a force push
   moves production to P_new, an ancestor of H; the run record is created. The run then tested code that is not H's
   tree, while `behind_by` is 0 and the force push predates `created_at`. Blocking on any rewrite in the recorded year
   closes it, at no cost today: production's recorded year has none.

   Production's creation is benign only when it precedes every applicable run. A creation at or after one means the
   branch was replaced while a run's merge was in flight, and the deletion before it may have aged out of a listing.
9. Each applicable run's state, as a closed table:
   - `status: "completed"`:
     - `conclusion` `success` → SUCCEEDED;
     - `failure`, `cancelled`, `timed_out`, `action_required`, `neutral`, `skipped`, `stale` or `startup_failure`
       → FAILED;
     - any other string → `unrecognized_ci_conclusion`;
     - `null` → `malformed`.
   - `status` `queued`, `in_progress`, `waiting`, `requested` or `pending` → PENDING.
   - Any other status, the empty string included → `unrecognized_ci_status`.

   Step 9 classifies every applicable run before step 10 aggregates, so one unrecognized run is UNKNOWN even beside
   a FAILED one.
10. Aggregate over **every** applicable run. Any FAILED → `FAILED`; otherwise any PENDING → `PENDING`. Otherwise, every
    SUCCEEDED run's latest-attempt jobs must include each required job with `completed`/`success`. A missing or
    non-success required job → `INCOMPLETE`, and so is a required name that appears more than once when any of its
    jobs is not `completed`/`success`; otherwise `SUCCEEDED`. A SUCCEEDED run with no job listing in `jobsByRunId` →
    `ci_candidate_listing_too_large`.

Value: `{ outcome: "SUCCEEDED" | "FAILED" | "PENDING" | "NO_RUN" | "INCOMPLETE", applicableRunIds: [...] }`.

**Why this binds the execution context** (the claim the verifier must try to break):
- The run's PR is the one PR whose head branch is `key.headRef`, by steps 5 and 7 — **except** for the GitHub
  behaviours §7 R-ATTRIBUTION lists (a renamed head branch, an archived PR, a permanently deleted PR), which are
  undocumented and not observable read-only. Step 5's associated-PR clause does not exclude them either.
- The run's base was always production, because this PR has no base change (step 4).
- Production has no recorded force push or deletion in the year, and it existed before every applicable run (step 8).
  So the base tip B that GitHub merged for the run is an ancestor of today's tip.
- `behindBy == 0` makes today's tip an ancestor of H. So B is an ancestor of H, and the tested merge's tree is H's
  tree.

### 3.5 Provenance negative controls (each must yield non-candidacy)

| # | Case | Expected | Source |
|---|---|---|---|
| NC1 | An older same-SHA run belonged to another PR that is now closed | `shared_head` (same branch), or ignored at step 7 (other branch) | synthetic: no Hone head branch has had two PRs in the last 400 |
| NC2 | Production was rewritten — before or after a run's record — while current rules look fine | `base_history_unverified` (step 8) | synthetic activity; real activity shows 0 force pushes |
| A1 | A force push lands between GitHub's test merge and the run record | `base_history_unverified` (step 8) | synthetic; verifier finding A1 |
| NC3 | A successful **push** run at H did not run PR validation | ignored at step 7 → `NO_RUN` | real run shape, synthetic pairing |
| NC4 | The PR was retargeted without a fresh run | `base_ref_changed` | **real**: #720 (`feat/ui-r02-product-polish` → production), #716, #721–#723, #727, #764 |
| NC5 | A required job was skipped, missing or incomplete | `INCOMPLETE`, or `NO_RUN`, or `ci_candidate_listing_too_large` | real job shapes from #810's run, synthetic skips |
| NC6 | An unrelated successful run exists at the same head SHA | ignored at step 7 | synthetic |

## 4. Rows 4–6 — review evidence, threads and external contexts

### 4.1 `parseReviewEvidence(raw, { expectedNumber })` — GraphQL, exact fields, one response (CAP-01 §17)

```
repository(owner,name){ pullRequest(number:N){ number
  reviews(first:100){ totalCount pageInfo{hasNextPage}
    nodes{ databaseId state body commit{oid} author{__typename login ... on Bot{databaseId} ... on User{databaseId}} } }
  comments(first:100){ totalCount pageInfo{hasNextPage} nodes{ databaseId body lastEditedAt author{…same…} } }
  reviewThreads(first:100){ totalCount pageInfo{hasNextPage}
    nodes{ isResolved isOutdated resolvedBy{__typename login databaseId}
      comments(first:100){ totalCount pageInfo{hasNextPage} nodes{ databaseId author{…same…} } } } } } }
```

- `number` must equal `expectedNumber`, which is required.
- A connection is complete when `hasNextPage` is false and `totalCount` is ≤ 100 and equals `nodes.length`. If any
  connection — each thread's own comments included — is not, the result is `review_evidence_too_large`.
- `malformed` wins over incompleteness. Malformed means: a field missing, extra or of the wrong type; a `commit`
  that is neither `null` nor `{ oid: <40 hex> }`; an actor that is not `null`, a `User` or `Bot` with exactly
  `{ __typename, login, databaseId }` (positive id), or another type with exactly `{ __typename, login }`; a
  resolver that is not `null` or exactly `{ __typename, login, databaseId }`; or a review or comment id that repeats.
- A GitHub error, an invisible repository or a missing pull request → `read_failed`.
- A comment's `lastEditedAt` is `null` or an ISO-8601 UTC time, else `malformed`.
- Record: `{ reviews: [{ id, state, body, commitOid, author }], comments: [{ id, body, edited, author }],
  threads: [{ isResolved, isOutdated, resolver, opener }] }`, where `edited` is `lastEditedAt !== null`.
  - `author`, `resolver` and `opener` are `{ id, type }`, with `id: null` for a non-User, non-Bot actor, or `null`
    when deleted.
  - `opener` is the author of the thread's first comment, or `null` when it has none.
  - Reviews and comments are sorted by `id`; threads in a fixed content order.
  - Logins never enter the record.

### 4.2 `bindReviews({ key, evidence, policy })`

ARCH-01 §17–§21. `policy` is required and is exactly `{ cleanPrefix }`, a non-empty string; the collector passes
`{ cleanPrefix: "Codex Review: Didn't find any major issues." }`. A missing, empty or extended policy is `malformed`.
Whom to trust — the Codex bot and the human resolvers — is 05B's policy (SPEC-05B §3), never 05A's.

- A review whose `state` is outside GitHub's `PENDING`, `COMMENTED`, `APPROVED`, `CHANGES_REQUESTED`, `DISMISSED` →
  `malformed`.
- Channel A: every review becomes `{ id, channel: "PR_REVIEW", actor, verdict: state, qualifiesAtHead }`.
  `qualifiesAtHead` is `commitOid === key.headSha` **and** the marker rule.
- Channel B: a comment whose body **begins** with the clean prefix becomes
  `{ id, channel: "CLEAN_COMMENT", actor, verdict: "CLEAN", qualifiesAtHead }`. `qualifiesAtHead` is `edited: false`
  **and** the marker rule. Anyone with write access can edit another account's comment while its author stays the
  same, so an edited body is no longer its author's statement (verifier finding R4-EDIT). Codex does not edit its
  clean verdicts (#802–#809: 12 of 12 unedited); it edits only its running "Codex Review Summary" comment, which is
  not a channel-B artifact. Channel B is a 10-hex V1 binding (ARCH-01 §41). Other comments are not artifacts.
- Marker rule: the body contains `**Reviewed commit:**` exactly once, and that marker is followed by `` `x` `` where x
  is 10 lowercase hex equal to `key.headSha.slice(0, 10)`.
- Threads become `{ opener, resolved, resolver, outdated }`.
- Value: `{ reviews: [...], threads: [...] }` (ARCH-01 §24's two lists).
- The marker pattern is fixed here. ARCH-01 §21 calls the marker a policy value; V1 does not make it configurable.
- 05A computes `qualifiesAtHead` and carries identities. Trust — whether an actor is Codex or a trusted resolver —
  is 05B's decision against the policy.

### 4.3 `parseRollup(raw, { headSha })` — GraphQL, exact fields, one response

```
repository(owner,name){ object(oid:H){ __typename ... on Commit{ oid statusCheckRollup{
  contexts(first:100){ totalCount pageInfo{hasNextPage} nodes{ __typename
    ... on CheckRun{ name status conclusion checkSuite{app{slug}} } ... on StatusContext{ context state } } } } } } }
```

- `oid` must equal `headSha`, which is required.
- A `null` object → `read_failed`. A `null` rollup is a complete, empty set.
- Schema (else `malformed`):
  - a CheckRun has a string `name`, a non-empty string `status`, a `conclusion` that is a string or `null`, and
    `checkSuite.app` that is `null` or `{ slug: <non-empty string> }`;
  - a StatusContext has a string `context` and a non-empty string `state`;
  - any other node type is malformed.
- Then `hasNextPage`, a `totalCount` over 100, or one that differs from `nodes.length` → `external_contexts_too_large`.
- Record: `{ contexts: [{ kind: "CheckRun", name, status, conclusion, appSlug } | { kind: "StatusContext", context,
  state }] }`, in a fixed content order.

### 4.4 `bindExternal(record)` — EXT-CONTEXT-01's closed tables

- Every StatusContext is external: `SUCCESS` → success; `PENDING` and `EXPECTED` → pending; `ERROR` and `FAILURE` →
  failure.
- A CheckRun with app slug `github-actions` is excluded, whatever its state.
- A CheckRun with no app (`appSlug: null`) → `malformed`.
- For any other CheckRun:
  - status `REQUESTED`, `QUEUED`, `IN_PROGRESS`, `WAITING` or `PENDING` → pending;
  - status `COMPLETED` → by conclusion: `SUCCESS`, `NEUTRAL` and `SKIPPED` → success; `FAILURE`, `CANCELLED`,
    `TIMED_OUT`, `ACTION_REQUIRED`, `STARTUP_FAILURE` and `STALE` → failure.
- Any other value → `unrecognized_context_state`. `malformed` wins over it.
- Value: `{ external: [{ source, state }] }`, where `source` is the CheckRun `name` or the StatusContext `context`.

## 5. The collector — readers, transport, passes and Evidence

### 5.1 Readers and transport

`adapter/internal/github/index.mjs`: `createReaders({ request, policy })`. `policy` may be omitted; if given, it must
equal V1's fixed policy (§2, §3) exactly, or construction fails — readers are never built for another repository,
production ref or workflow, so the history and CI reads cannot be pointed elsewhere (verifier pass 5). Each reader
takes typed scalars only and refuses anything else **before any request** (`malformed`, detail "refused before any
request"). It makes exactly one
request and returns its §2–§4 parser's result for the request it made. A transport failure passes through unchanged.

| Reader | Parameters | Request |
|---|---|---|
| `readPrKey` | PR number | GraphQL `PR_KEY_QUERY` |
| `readCompare` | base SHA, head SHA | REST `compare/{base}...{head}` |
| `readPrContext` | PR number, head SHA | GraphQL `PR_CONTEXT_QUERY` |
| `readHeadBranchPrs` | head branch | REST `pulls?head=<encodeURIComponent(owner:headRef)>&state=all&per_page=100` |
| `readBranchRules` | none (policy) | REST `rules/branches/<productionRef>` |
| `readActivity` | `force_push`, `branch_deletion` or `branch_creation` | REST `activity?ref=<encoded full ref>&activity_type=<t>&time_period=year&per_page=100` |
| `readCandidateRuns` | head SHA | REST `actions/workflows/<workflowId>/runs?head_sha=H&event=pull_request&per_page=100` |
| `readRunJobs` | run id | REST `actions/runs/<id>/jobs?filter=latest&per_page=100` |
| `readReviewEvidence` | PR number | GraphQL `REVIEW_EVIDENCE_QUERY` |
| `readCommitRollup` | head SHA | GraphQL `ROLLUP_QUERY` |
| `readFileBlob` | one of `.github/workflows/ci.yml`, `scripts/classify-changes.mjs`; commit SHA | REST `contents/<path>?ref=<sha>` |

`parseFileBlob(raw, { path })`: an object with `type: "file"`, `path` equal to the requested path and a 40-hex
`sha`; else `malformed`. Record `{ path, sha }`.

`adapter/internal/github/primitive.mjs`: `createPrimitive({ env, … })` is the only module that reaches GitHub.

- It requires the dedicated read-only token in `HONE_ENG_READ_TOKEN`. Without it, it makes no request and the result
  is `read_failed`. The operator's `gh` session is never a fallback.
- It runs `gh api` in a child environment built from nothing: `PATH`, a fresh empty directory as both `HOME` and
  `GH_CONFIG_DIR`, `GH_TOKEN` set to the dedicated token, and fixed non-interactive settings. No credential is
  inherited.
- The token is never an argument, a result, a detail or a statistic. An echo of it, or of anything shaped like a
  GitHub token, is redacted — in a successful answer's body (before it is parsed) as much as in a detail or a
  request label.
- A request must be exactly one of the two shapes — `{ label, rest }` or `{ label, graphql, variables }` with no other
  key, a non-empty `rest` or `graphql`, and `variables` a plain object of strings and integers — or it is refused as
  `malformed` before anything is spawned. "Plain" means an object literal: an array, a `Map`, a `Date` or any class
  instance is refused.
- REST is `GET` with fixed `Accept` and API-version headers. GraphQL sends numbers with `-F` and strings with `-f`.
- Exit 0 with JSON is the body. A non-zero exit is `read_failed`, with the reader's label and `gh`'s first stderr line
  as the detail (for example `candidate-runs: gh: … (HTTP 403)`), which names a missing permission. Non-JSON output
  is `malformed`. A timeout is `read_failed`.
- Every request is counted and timed: `{ label, ms, ok }`, never a body.

### 5.2 The CI definition the shepherd executes

Required lanes come from production's classifier (§3.3), but the shepherd runs the classifier in its own checkout.
`adapter/local-ci.mjs` hashes this checkout's `scripts/classify-changes.mjs` and `.github/workflows/ci.yml` exactly
as git does (`sha1("blob <size>\0" + bytes)`), and checks that every required-job name appears as `name: <job>` in
that `ci.yml`. The CI row is `ci_definition_mismatch` when either local blob differs from production's at
`K0.baseSha` (`readFileBlob`), when the table is not pinned to the local `ci.yml`, or when the classifier throws.

### 5.3 Passes

`adapter/collect.mjs`: `collect({ prNumber, readers, local, now, policy })`.

0. Before the first request, every option is checked: a positive PR number, all eleven readers, a complete local
   CI definition (§5.2: a classifier, a 40-hex blob for each path, the pin flag) and a clock that returns a time —
   milliseconds, a valid `Date`, or an ISO-8601 UTC string. `policy` may be omitted; if given, it must equal V1's
   fixed policy (§2, §3: the owner, name, repository id, production ref and workflow id) exactly.
   Anything else is `{ ok: false, reason: "malformed", stage: "collect" }` with no request made, never a throw.

1. The first coherent pass (§1): `K0 = readPrKey`, then the body, then `K1`. The pass gets one retry if the key
   moved.
2. The body, for an OPEN key, in this fixed order: compare, PR context, head-branch PRs, branch rules, activity
   (`force_push`, `branch_deletion`, `branch_creation`), candidate runs, review evidence, commit rollup, then the
   two file blobs. Then jobs, for exactly the runs that are applicable (§3.4 step 7) and `completed`/`success`.
   **The first failure ends the pass with its reason.** That order is the precedence among reader failures. A
   terminal key reads nothing but the key.
3. The confirming pass (ARCH-01 §15) runs once, with no retry. A different key is `pr_key_moved`. A body whose
   canonical JSON differs is `unstable_snapshot`, and the diagnostics name the body fields that changed.
4. Binding is pure and comes after both passes. A binder's closed failure is a **row result**, not a collection
   failure, so 05B can apply its own precedence (A9).

### 5.4 Evidence

Success: `{ ok: true, evidence, evidenceHash, diagnostics }`:
- `evidence`: `{ schema: "eng-loop-v1/evidence@1", observedAt, key, terminal, rows }`;
- `rows`: `null` for a terminal key; otherwise `{ base, ci, reviews, external }`, each a closed result;
- `evidenceHash`: SHA-256 of the canonical JSON of `{ schema, key, body, localCi: { blobs, tablePinned } }`, where
  `body` holds the first pass's normalized records. With V1's policy fixed by step 0, it names everything the rows
  were bound from except the clock.
  GitHub's listing order cannot change it, because every record is canonically ordered. The observation time is
  reported, never hashed: it enters the rows only through rule 8's 360-day window, so two collections with equal
  hashes bind equal rows unless an applicable run crosses that window between them (verifier pass 3). Never key a
  cache or an "unchanged since" check on the hash without the observation time;
- `diagnostics`: `{ observedAt, attempts, confirmed: true }`.

Failure: `{ ok: false, reason, detail, stage: "collect" | "confirm", diagnostics }`, never partial evidence.

## 6. Reasons this spec adds to the V1 closed set

`fork_head`, `diff_too_large`, `ci_definition_changed`, `ci_definition_mismatch`, and the profile's `base_ref`,
`base_ref_changed`, `shared_head` and `base_history_unverified`.

## 7. Residuals: what V1 does not prove

Each is a stated limit, not a hidden assumption. None can make a candidate out of evidence the rules above refuse.

- **A1b — a reopened run's merge.** If a `reopened` run reused a merge GitHub computed before the PR was closed, its
  base could predate the recorded year. GitHub does not document either way. Step 8's window bounds the run, not the
  merge.
- **A8 — activity-log completeness.** That the activity log records every rewrite is GitHub's claim, not proved
  here. Open questions: renaming production, or renaming another branch into its name; forced ref updates made
  through the API; whether a full year is always retained; and a force push that restores the same tip inside the
  log's write delay before the read, which would not change the key either.
- **A5 — browser-group completeness.** This qualifies README difference 2's "required validation actually executed":
  for browser groups it means the aggregator's own selection, not production's. The browser aggregator selects groups from the run's own diff against its
  own older base. If H reverts a change production made after that base, a group production would select may not
  have run, and the aggregator still succeeds. Named lanes are safe (`INCOMPLETE`). An empty `changed.txt` is safe
  because `classify([])` selects the full matrix.
- **A9 — drift is 05B's rule.** `bindCi` can return `SUCCEEDED` for a PR that is behind production. Requiring
  `behindBy == 0` is 05B's precedence (`NEEDS_REFRESH` before every CI rule), and 05B's tests must prove it.
- **R-ECHO-Q — no REST answer echoes its query parameters.** `per_page=100`, `state=all`, `time_period=year`,
  `event=pull_request` and `filter=latest` are pinned only by route construction (the collector's strict-fake tests
  pin every route), and the `length >= 100` caps assume `per_page=100`.
- **R-ECHO — four answers do not echo every request parameter.** The compare (§2.1) echoes its base but not its
  head; the PR context's `associatedPullRequests` (§2.2) does not echo the commit it was read for; the branch rules
  (§2.4) echo nothing, not even the branch, so only rule 6 rests on them while rule 8 uses echoed activity; and a
  file blob (§5.1) echoes its path but not its commit. The collector (§5) passes `K0.headSha`, `K0.baseSha` and the
  policy's production ref, and its strict-fake tests pin every route and variable.
- **R5-DELETE — a deleted finding (writer-class; verifier pass 3 confirmed it is a real false-ready path inside
  ARCH-01 §41's scope).** Anyone with write access, including an agent using the operator's
  credential, can delete Codex's thread-opening comment or its whole thread. Then the thread's opener is the next
  comment's author, or the thread is gone, and FINDINGS_OPEN cannot see it. GitHub's GraphQL `replyTo` of a reply
  whose parent was deleted is not proven to reveal the deletion, so V1 does not try. This is ARCH-01 §41's scope: V1
  does not defend against a deliberately malicious same-repository writer. The mitigation is policy, added to `CLAUDE.md`
  with the shepherd (05C): agents never edit, delete or hide a Codex review comment or thread, and resolve one only on
  the operator's explicit instruction for that thread.
- **R-STACK — a stacked pull request blocks the one beneath it (liveness, not safety).** A PR stacked on another
  contains the lower PR's head commit, so `associatedPullRequests(H)` lists both (live: `[810, 815]` while #815 is
  stacked on #810), and rule 5 makes the lower PR `shared_head` until the upper one closes. The operator approved
  removing the associated-PR clause on condition of an independent proof (2026-10-08). The verifier's proof
  (`tests/eng/v2/verify/R-STACK-PROOF.md`, 39 rows) is **NOT PROVEN**, so the clause **stays**: the vectors in
  R-ATTRIBUTION below are not excluded by the remaining rules — nor by the clause.
- **R-AUTOBASE — rule 4 misses GitHub's automatic retargeting (open; fix in verification).** When a PR's base
  branch is merged and deleted, GitHub retargets the PR and records `AutomaticBaseChangeSucceededEvent` (or
  `…FailedEvent`), not `BaseRefChangedEvent` (verifier, R-STACK pass: 5 of 6 such PRs in a large repository carried
  none). §2.2 counts only `BASE_REF_CHANGED_EVENT`, so "this PR has no base change (step 4)" can be false for a
  retargeted stack. Reach is narrow — `behindBy == 0` forces a new head and a fresh run in the merge and squash
  flows — and no PR in Hone's 100 most recently updated carries either event. The fix (count all three events)
  is implemented and awaits independent verification before it lands.
- **R-ATTRIBUTION — three ways a run could be another PR's (writer-class or GitHub-administrative).** Rules 5 and 7
  bind a run to this PR for every vector the verifier could evidence. Three rest on undocumented GitHub behaviour
  that cannot be observed read-only:
  - **B1, a renamed head branch.** GitHub closes the open PR whose head branch is renamed; whether that closed PR
    keeps its old head label, and its runs their old `head_branch`, is undocumented. No rename exists in Hone to
    observe.
  - **B2, an archived PR.** GitHub's moderation archive hides a PR from non-administrators; whether a read-only
    token still sees it in `pulls?head=…&state=all`, and its runs stay listed, is unobserved.
  - **B3, a permanently deleted PR.** What happens to its runs is undocumented.

  `associatedPullRequests` never lists a closed, archived or deleted PR, so step 5's clause does not exclude them.
  The harm is bounded: every applicable run counts (step 10), so a foreign green run can make CI `SUCCEEDED` only
  when this PR's own runs at H are all green already or missing — and with `behindBy == 0` a run is missing only if
  Actions did not run it. Candidate closures, for the operator: an operator-run write experiment in a scratch
  repository; run-side attestation (CI-ATTEST-01); or the partial rule "an applicable run's `created_at` is at or
  after the PR's `createdAt`", which closes B1 and the single-PR forms of B2 and B3 (live, no run precedes its PR in
  Hone's 40 most recent PRs).
- **R-WORKFLOWS — other pull-request workflows.** EXT-CONTEXT-01 excludes every GitHub Actions check run from the
  external contexts, so a failing check from a second PR-triggered workflow would block nothing. Today `ci.yml` is
  the only PR-triggered workflow (`nightly.yml` is schedule-only). Adding one requires deciding its authority first.
- **R-TABLE — a new lane.** §5.2 proves the table's names exist in production's `ci.yml`, not that the table names
  every lane. A lane added to production's `ci.yml` and skipped by its own condition is outside V1's required set
  until the table is updated.
