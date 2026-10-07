# CI-ATTEST-01 — immutable run-side CI attestation

| Field | Value |
|---|---|
| **Decision** | A CI execution names the PR, head and base it ran for in **one immutable artifact** that the authoritative workflow emits from the triggering event, before any PR code runs. ENG-LOOP binds a CI run to a PR **only** through that attestation. |
| **Date** | 2026-10-06 |
| **Status** | **PROPOSED** in this pull request; **ACCEPTED** when merged. |
| **Decided by** | Sam (operator): CI-ATTEST-01 is the re-entry architecture after ARCH-01's CI-authority stop law fired on PR #800; re-entered **by removal** after PR-SNAPSHOT-01 (PR #803) and CAP-01 (PR #804) merged; the two-step emitter and the `run_number` current-run frontier by operator decision after the ready-gate stop on `557ed2ce96`. |
| **Purpose** | Exactly one fact: *"This trusted CI execution ran for PR N, at head H, against base B, under authoritative workflow W."* |
| **Consumed by** | ARCH-01 (`docs/decisions/arch-01-eng-loop-v2.md`, PR #800). ARCH-01 **consumes** this fact; it never derives it (§12). |
| **Depends on** | PR-SNAPSHOT-01 (`docs/decisions/pr-snapshot-01-identity-key.md`, merged) for the coherent key `K0`; CAP-01 (`docs/decisions/cap-01-github-capability-boundary.md`, merged) for GitHub-access architectural lint and its reader contract, including `readCandidateRuns` as amended by CAP-01-READER-STATE-01 (PR #805). |
| **Scope** | The artifact contract, binding against `K0`, the current-run frontier, the trust anchor, attempts and re-runs, retention, terminal PRs, fixtures. |
| **Not in scope** | The `ci.yml` change (a separate implementation PR, §11); any edit to #800; 05A; 05B; ARCH-02; reading or re-validating the PR, which PR-SNAPSHOT-01 owns; GitHub-access lint, which CAP-01 owns. |
| **Authored at** | production `7134239097908a8780aef7fd8fe9b3505d0f4ae0`; re-entered at production `9402c21718f31dd72016ed0c4d421bb00f9551ee`, where PR-SNAPSHOT-01 and CAP-01 are merged; refreshed onto production `da15f1785ec11adfcfaaf0176b19780fcacc268d`, where CAP-01-READER-STATE-01 is merged. Live evidence read on 2026-10-06. |

> **Normative.** Where an implementation and this record disagree, the implementation is wrong. A change to these semantics
> is proposed, reviewed and merged **here first**; it never evolves through review-repair rounds.

---

## 1. The fact, and what it is not

The attestation supplies **identity only**: PR number, head, base, repository and run. It never grants CI success and never
creates a failure or a pending state. CI state is the current `status` and `conclusion` of one run, the **current-run
frontier** (§5), never the attestation. An attestation can only make a candidate run the frontier for a PR, or exclude
it.

**Never PR identity:** a run's or check run's `pull_requests`, a run's `display_title` or `run-name`, a job or check name,
a commit status, a check run, a timestamp, a run id ordering, a `run_attempt` ordering, or the runs endpoint's `branch`
filter. `run_number` orders candidate runs (§5); it never identifies a PR.

**Ownership — no overlap.**

| Record | Owns |
|---|---|
| PR-SNAPSHOT-01 | the PR's current state, head, base and repositories, as one coherent `PrSnapshotKey`; `K0`/`K1` coherence; the bounded retry |
| CI-ATTEST-01 (this record) | immutable CI execution identity, its comparison with `K0`, and candidate and frontier membership: which one run supplies CI state (§5) |
| CAP-01 | declared, static GitHub capability architecture lint |

This record receives `K0` from PR-SNAPSHOT-01 and never reads the pull request itself.

## 2. Why — GitHub's current views cannot bind a run to a PR

| Surface | Evidence |
|---|---|
| a run's `pull_requests` | GitHub's API description: *"Pull requests that are open with a `head_sha` or `head_branch` that matches the workflow run. The returned pull requests do not necessarily indicate pull requests that triggered the run."* Live: #800's run `37396356200`, made at `5982d7d025`, now reports #800's later head `01421d0b17`; merged #788's run `37387844240` now reports `[]`. |
| a run's `display_title` | Live: #800 was renamed at about 01:20Z; its runs `37395019207` (00:37Z) and `37396356200` (00:53Z) now show the **new** title. It is rewritten after the run is created. |
| the run object | No field names the triggering PR or its merge ref (API property list). |
| `head_sha`, `head_branch`, `head_repository` of a run | Unchanged on those same runs. This record uses them as GitHub-controlled run metadata (§5). |

This record starts from the three CI-binding findings left open on #800 — `4190617309` (runs not bound to the PR),
`4190741980` (a mutable association cannot prove the base) and `4190741986` (a closed PR must reach `NOT_OPEN`) — as its
requirements.

## 3. Execution facts this record relies on

| # | Fact | Evidence |
|---|---|---|
| E1 | A `pull_request` run executes the **merge commit's** context, including the PR's own version of the workflow file. | Docs: `pull_request_target` *"runs in the context of the default branch of the base repository, rather than in the context of the merge commit, as the `pull_request` event does"*. Live: #660's run `33328302918` (created 18:31Z; #660 merged 18:46Z) downloaded `actions/checkout@3d3c42e5…`, the pin #660 introduced, while production's `ci.yml` at #660's merge parent `66ef31710a` named `actions/checkout@v4`. |
| E2 | `pull_request` runs by default only on `opened`, `synchronize` and `reopened`; editing a PR's base starts **no** run. | Docs; `ci.yml` declares `pull_request:` with no `types`. |
| E3 | A re-run uses the same `GITHUB_SHA` and `GITHUB_REF` as the original event; a run can be re-run for 30 days. | Docs, "Re-running workflows and jobs". |
| E4 | Artifact names are unique within a run, and an uploaded artifact cannot be modified (*"each created artifact is idempotent"*). | `actions/upload-artifact` README. |
| E5 | "Re-run all jobs" removes a run's earlier artifacts; re-running a subset of jobs moves them into the new attempt. | GitHub Support, quoted in GitHub community discussion #17854. **Not** in GitHub's documentation — proven live in the implementation PR (§11). |
| E6 | A partial re-run lists the jobs it did not re-execute in the new attempt, with new job ids and the earlier attempt's timestamps. | Live: all 10 Hone re-runs since 2026-09-28 were partial. Run `37362604831`'s `changed-path detection` job shows 19:19:52–19:20:05Z in both attempts; attempt 2 began at 19:37Z. |
| E7 | The run-artifact list has no attempt filter; an artifact carries `workflow_run` `{id, repository_id, head_repository_id, head_branch, head_sha}`, `expired`, `expires_at` and a SHA-256 `digest`, and no attempt. | GitHub's API description. |
| E8 | The REST download is a zip (`archive_format` must be `zip`; a redirect valid for 1 minute), and its SHA-256 equals `digest`. | Docs. Live: artifact `11357189201` downloaded as 1,796,526 bytes with a `PK` header and a SHA-256 equal to its `digest`. |
| E9 | `archive: false` (upload-artifact v7) ignores `name` and names the artifact after the file; its REST representation is undocumented. | upload-artifact v7.0.0 release notes; the REST docs document zip only. |
| E10 | A running job sees `GITHUB_WORKFLOW_REF`, `GITHUB_RUN_ID`, `GITHUB_RUN_ATTEMPT`, `GITHUB_REPOSITORY_ID` and `GITHUB_EVENT_PATH`, but **no** numeric workflow id. | Docs, default variables. |
| E11 | Artifact retention defaults to 90 days and can be set from 1 to 90 days per upload. | `actions/upload-artifact` README. |
| E12 | In a PR from a fork, `GITHUB_TOKEN` is read-only. | Docs. |
| E13 | The compare read returns `merge_base_commit`; the contents read returns a file's git blob `sha`. | GitHub's API description. Live: #800 against production gives `behind_by` 0 and merge base `7134239097`; `ci.yml` has blob `e69cefa9013b` at both. |
| E14 | A workflow's `run_number` begins at 1 for its first run, increments with each **new** run, and does not change when the run is re-run; `run_attempt` increments only within one run. | Docs, variables and contexts reference; REST: a required integer, *"the auto incrementing run number"*. Live, all 2,829 `ci.yml` runs: `run_number` 1–2829, unique and gap-free, shared by `push` and `pull_request`, in creation order without exception; re-run runs keep their `run_number` and id. Five head SHAs carry two `pull_request` runs, one of them cancelled by the PR-scoped `cancel-in-progress` before any step ran; for PR #686, both created in one second, GitHub cancelled the higher number (1897) and kept 1896. |

## 4. The artifact contract — schema v1 (frozen)

### 4.1 Emitter

- **Workflow:** the authoritative CI workflow, `.github/workflows/ci.yml` (workflow id `289443461`, ARCH-01 §23).
- **Event:** `pull_request` only.
- **Position:** the **first two steps of the first job** (today `changes`), both before `actions/checkout` and before any
  repository or PR code executes. Every job that runs repository code depends on that job.
  1. **Generate.** A trusted inline `run` step writes exactly `ci-attest.json`, reading only the GitHub-provided event
     payload and default variables the schema needs (§4.3).
  2. **Upload.** Immediately afterwards, the repository's SHA-pinned `actions/upload-artifact` uploads exactly that
     file, under §4.2's name, representation and options.

  Only after both steps may `actions/checkout` run. No composite repository action, repository script or checked-out
  helper takes part. One step cannot do both, because a step is either a `run` or a `uses` and the upload needs an
  existing file. The split makes the model implementable without changing its trust (§7).
- **Self-contained:** inline in `ci.yml` plus the repository's SHA-pinned `actions/upload-artifact`; it reads no repository
  file.
- **Copied, never computed:** every value comes from `$GITHUB_EVENT_PATH` or a default variable (E10).

### 4.2 Artifact

- **Name:** exactly `ci-attest-v1` — one fixed name, not one per attempt (§6).
- **Representation:** the default zipped upload, never `archive: false` (E9). The zip holds exactly one entry,
  `ci-attest.json`, of at most 4096 bytes.
- **Upload options:** `overwrite: false`, `if-no-files-found: error`, `retention-days: 90` (§8).

### 4.3 Payload

One JSON object with **exactly** these 13 keys:

| Key | Type | Source |
|---|---|---|
| `schemaVersion` | integer, exactly `1` | constant |
| `repositoryId` | positive integer | `GITHUB_REPOSITORY_ID` |
| `event` | exactly `"pull_request"` | `GITHUB_EVENT_NAME` |
| `workflowRef` | non-empty string | `GITHUB_WORKFLOW_REF` |
| `runId` | positive integer | `GITHUB_RUN_ID` |
| `runAttempt` | positive integer | `GITHUB_RUN_ATTEMPT` |
| `prNumber` | positive integer | event `pull_request.number` |
| `headSha` | 40 lowercase hex | event `pull_request.head.sha` |
| `headRef` | non-empty string | event `pull_request.head.ref` |
| `headRepositoryId` | positive integer | event `pull_request.head.repo.id` |
| `baseSha` | 40 lowercase hex | event `pull_request.base.sha` |
| `baseRef` | non-empty string | event `pull_request.base.ref` |
| `baseRepositoryId` | positive integer | event `pull_request.base.repo.id` |

A missing key, an extra key or a wrong type makes the artifact malformed. A numeric workflow id is not available to a running
job (E10), so workflow W is taken from GitHub's run metadata (`workflow_id`, §5); `workflowRef` is recorded and its path is
checked.

## 5. Binding — candidates and the current-run frontier (05A)

This section applies to an **open** pass; a terminal pass reads no CI (§9). Trust (§7) is settled first, once per pass.

**Candidates** are the configured authoritative workflow's runs ∩ the exact head `K0.headSha` ∩ `event=pull_request`,
as CAP-01's `readCandidateRuns` returns them from one complete response. Its single-response listing law (CAP-01 §4)
makes a listing that cannot prove completeness `UNKNOWN(ci_candidate_listing_too_large)`. Every candidate's
`run_number` must be a positive integer, and no two candidates may share one; a missing, malformed or duplicated
`run_number` makes the pass `UNKNOWN(malformed)`. The same response supplies each candidate's `status`, `conclusion`
and `run_attempt`, which CAP-01 §4 defines as mutable evidence — not identity, and not an ordering.

The walk below classifies each candidate it examines in four steps:

1. **Locate.** The run's artifact list, filtered by the exact name `ci-attest-v1`, holds exactly one artifact; it is not
   expired, and its `workflow_run.id` equals the run's id.
2. **Read.** Download it; the SHA-256 of the bytes equals `digest`; the zip holds exactly one entry, `ci-attest.json`; the
   payload satisfies schema v1 (§4.3).
3. **Agree with GitHub's run metadata:**
   - `runId` = the run's `id` = `workflow_run.id`, and 1 ≤ `runAttempt` ≤ the run's `run_attempt`;
   - `event` = the run's `event` = `pull_request`, the run's `workflow_id` = the policy workflow id, and `workflowRef` begins
     with the run's `repository.full_name` followed by `/.github/workflows/ci.yml@`;
   - `repositoryId` = the run's `repository.id` = `workflow_run.repository_id` = the target repository id;
   - `headSha` = the run's `head_sha` = `workflow_run.head_sha`; `headRef` = the run's `head_branch` =
     `workflow_run.head_branch`; `headRepositoryId` = the run's `head_repository.id` = `workflow_run.head_repository_id`;
   - `baseRepositoryId` = `repositoryId`.
4. **Classify** against `K0`, the coherent key that PR-SNAPSHOT-01 supplies for this pass. This record reads nothing
   about the PR itself:

| Attestation | Class | Effect |
|---|---|---|
| `prNumber`, `headSha`, `headRef`, `headRepositoryId`, `baseRef`, `baseRepositoryId` and `baseSha` equal `K0`'s `prNumber`, `headSha`, `headRef`, `headRepoId`, `baseRef`, `baseRepoId` and `baseSha`; and `K0.baseRef` is the configured production ref, so `K0.baseSha` is the production head | **DESIGNATED** | it is the **current-run frontier**; the walk stops |
| `prNumber` ≠ `K0.prNumber` | **UNRELATED** | excluded, granting and blocking nothing; the walk continues |
| `prNumber` = `K0.prNumber`, and the head fields and `baseRepositoryId` match, but `baseRef` ≠ `K0.baseRef`, or `K0.baseRef` is not the configured production ref, or `baseSha` ≠ `K0.baseSha` | **STALE** | excluded: the run tested another base, or the PR no longer targets production, so it cannot grant CI for `K0`; the walk continues |
| `prNumber` = `K0.prNumber` but any head field, or `baseRepositoryId`, differs from `K0` | **INVALID** | the walk stops: `UNKNOWN(ci_attestation_invalid)` |

Any failure in steps 1–3 — a missing, expired, duplicated, malformed or disagreeing attestation — is **INVALID**.

**The current-run frontier.** `run_number` is the **only** cross-run ordering (E14): no timestamp, run id, cross-run
`run_attempt` or event history. The walk examines candidates from the highest `run_number` down; GitHub's listing order
does not matter.
- **INVALID before a frontier stops the walk** with `UNKNOWN(ci_attestation_invalid)`. It never falls back to an older
  run: this newer run may be the PR's own replacement execution, and nothing proves otherwise.
- **The first DESIGNATED candidate is the current-run frontier.** Every candidate with a lower `run_number` is
  superseded: it is not read, and it can neither grant nor block anything.
- **No frontier.** With zero candidates, or when every candidate is UNRELATED or STALE, there is no frontier, and
  ARCH-01 decides `CI_NOT_STARTED`.

**Frontier state.** The frontier's **current** run `status` and `conclusion`, as `readCandidateRuns` returned them in
this pass, alone supply CI state; older runs never override it.

| Run `status` | Run `conclusion` | Normalized outcome |
|---|---|---|
| `completed` | `success` | `SUCCEEDED` |
| `completed` | `failure`, `cancelled`, `timed_out`, `action_required`, `neutral`, `skipped`, `stale`, `startup_failure` | `FAILED` |
| `completed` | any other string | `UNKNOWN(unrecognized_ci_conclusion)` |
| `completed` | `null` or not a string | `UNKNOWN(malformed)` |
| `queued`, `in_progress`, `waiting`, `requested`, `pending` | (any) | `PENDING` |
| any other status | (any) | `UNKNOWN(unrecognized_ci_status)` |

This record supplies ARCH-01 one normalized CI result: the frontier's outcome, no frontier, or `UNKNOWN` with a closed
reason. 05B maps it in ARCH-01's precedence order — `FAILED` → `CI_FAILED`, `PENDING` → `CI_PENDING`, `SUCCEEDED` → CI
acceptable, no frontier → `CI_NOT_STARTED` — and holds no `run_number` logic of its own.

**Why STALE excludes rather than fails.** A run against an older production head must leave ARCH-01's `NEEDS_REFRESH`
(ARCH-01 §7 row 3) free to decide; `UNKNOWN` would hide it.

**Base edits.** A base edit completed before the pass, without a new execution (E2), is STALE in **either
direction**, because the attested base no longer equals `K0.baseRef`:
- production → another branch: the attested `baseRef` is production, but `K0.baseRef` is not. The PR is also
  `UNKNOWN(wrong_base)` in ARCH-01 §13, but this rule does not rely on that.
- another branch → production: the attested `baseRef` is the old branch.

Either way, the old run can never satisfy CI for the edited PR, whatever GitHub's current views say. A base edit
**during** the pass changes the key, so PR-SNAPSHOT-01 discards the whole pass (`K1 ≠ K0`) and retries it once. This
record never re-reads or re-validates the base.

## 6. Attempts and re-runs (frozen)

- **No attempt selection.** 05A never chooses between attempts; it requires exactly one `ci-attest-v1` listed for the run
  (§5 step 1). The run's current `status` and `conclusion` — its latest attempt's — come from the run object, never from
  the attestation.
- **Identity does not depend on the attempt.** Every attempt replays the original event (E3), so whichever attempt
  emitted the surviving attestation, it names the same PR, head and base. `runAttempt` is recorded and bounded, never used
  to select.
- **A re-run never moves the frontier.** A re-run keeps its `run_number` (E14), so the frontier stays the same run and
  its current state is its latest attempt's. A changed `run_attempt` is never a reason to look for another run, and
  re-running a superseded run changes nothing.

| Situation | GitHub behaviour | Result |
|---|---|---|
| first attempt | one upload | binds |
| re-run all jobs | earlier artifacts removed (E5); the emitter uploads again | one artifact → binds |
| partial re-run that does not re-execute the emitter's job | the earlier artifact moves into the new attempt (E5) | one artifact → binds; if GitHub did not keep it, none → `UNKNOWN(ci_attestation_invalid)` |
| partial re-run that re-executes the emitter's job | the moved artifact plus a second upload of the same name | the upload is refused (E4), the emitter fails and so does the run → `CI_FAILED`; or two are listed → `UNKNOWN(ci_attestation_invalid)`. Never a false ready. |

**Why one fixed name.** GitHub moves earlier artifacts into later attempts (E5) and offers no attempt filter (E7), so
per-attempt names would require choosing between attempts — an attempt ordering this record never uses (§5). Recovery
from any fail-closed row: re-run all jobs, a close and reopen, or a push.

## 7. Trust (frozen)

### 7.1 What GitHub executes

A `pull_request` run executes the PR's own merge-commit version of the workflow (E1). A PR can change or remove the
emitter. The fact that a file is named `ci.yml` proves nothing.

### 7.2 The anchor

05A trusts attestations in a pass only when **`.github/workflows/ci.yml` at the PR head `H` = `K0.headSha` has the
same git blob `sha` as at the merge base** of `K0.baseSha` and `H` — the `merge_base_commit` of the compare read bound
to `K0` (E13; PR-SNAPSHOT-01 §5). If the two blobs differ, the whole snapshot is `UNKNOWN(ci_attestation_untrusted)`,
and no artifact is read. For a PR that targets production, `K0.baseSha` is the production head.

- **The anchor asks whether the PR changed CI.** Comparing against the merge base, not the current production head,
  keeps a later production change to `ci.yml` from hiding `NEEDS_REFRESH`.
- **A PR that changes `ci.yml` goes to human judgment.** That change is shared CI infrastructure and runs the full CI
  matrix anyway.
- **What the anchor guarantees.** When the run's actual base was production, the executed workflow is
  production-authored: `H` did not change `ci.yml` since it left production, so the tested merge takes production's
  version. Candidacy also requires `H` to contain the production head (ARCH-01 §14, before every CI row), and then the
  tested merge has `H`'s tree, whose `ci.yml` is production's.
- **Forks.** An open pass whose `K0.headRepoId` is not the target repository is `UNKNOWN(ci_attestation_untrusted)`.
  No fork attestation is trusted in schema v1: fork code is not a trusted writer (E12). A closed fork PR is §9's.

### 7.3 Residuals (writer class: recorded, not closed)

- A run executed while the PR's base was another, writer-controlled branch ran that branch's workflow merged with `H`.
  Its attestation can claim anything, even when the anchor holds.
- Malicious same-repository PR code that obtains the run's runtime token could replace the artifact after the emitter ran.

Both need repository write access, which already reaches production (the production branch is unprotected). GitHub-signed
OIDC claims (`base_ref`, `workflow_sha`, `run_id`) are the escalation path if that trust model changes. They need
`id-token: write` and carry no head or base SHA.

## 8. Retention (frozen)

- **Period:** `retention-days: 90`, the per-upload maximum without a repository-setting change (E11).
- **Expired or unreadable:** an expired, removed or unreadable attestation makes its run INVALID. Above any frontier
  that is `UNKNOWN(ci_attestation_invalid)` (§5); below the frontier the run is superseded and never read. It is never a
  CI failure, never a CI success, and never permission to infer identity elsewhere.
- **Operational requirement:** an open PR's frontier needs an attestation that has not expired. Recovery is a newer run
  that becomes the frontier — a close and reopen, or a push — or, within 30 days (E3), a re-run of the frontier run.
- **Rollout:** runs created before the emitter ships carry no attestation. A head whose newest run predates the emitter
  is `UNKNOWN` until a newer run, from a close and reopen or a push, becomes its frontier. Re-running a pre-emitter run
  cannot help, because it replays the old workflow (E3).

## 9. Closed and merged PRs (frozen)

- **Terminal handling is PR-SNAPSHOT-01's.** When `K0.state` is not `OPEN`, the pass is terminal; its key, `K1 == K0`
  and `NOT_OPEN` are PR-SNAPSHOT-01 §7's.
- **No CI read.** A terminal pass makes none of this record's reads: no candidate, artifact or anchor. An expired
  attestation, a removed artifact or an emptied GitHub association therefore can never make a closed or merged PR
  `UNKNOWN`, and a terminal PR needs no historical artifact.

## 10. Required fixtures and negative controls

| # | Fixture | Required result |
|---|---|---|
| 1 | a real, valid attested run of a current Hone PR (§11) | DESIGNATED — the frontier |
| 2 | a valid attestation naming another PR | UNRELATED — excluded |
| 3 | another PR's run at the same head SHA; the target PR has no run of its own | UNRELATED — `CI_NOT_STARTED`, never an inherited success |
| 4 | a run of the same commit bytes from a fork; and a forged attestation claiming the target PR from that run | UNRELATED; the forgery fails metadata agreement (head repository id) → `UNKNOWN(ci_attestation_invalid)`. Never an inherited success |
| 5 | the PR's base edited after its run and before the pass, in both directions: production → another branch, and another branch → production | STALE — excluded |
| 6 | a malformed artifact: bad JSON, an extra or missing key, a wrong type, two zip entries, a wrong entry name, a digest mismatch | `UNKNOWN(ci_attestation_invalid)` |
| 7 | no `ci-attest-v1` artifact, or an expired one | `UNKNOWN(ci_attestation_invalid)` |
| 8 | two `ci-attest-v1` artifacts in one run | `UNKNOWN(ci_attestation_invalid)` |
| 9 | the artifact disagreeing with run metadata: `runId`, `runAttempt` above the run's, `event`, the `workflowRef` path, `repositoryId`, a head field, `workflow_run` | `UNKNOWN(ci_attestation_invalid)` |
| 10 | the PR changes `.github/workflows/ci.yml` | `UNKNOWN(ci_attestation_untrusted)` |
| 11 | re-run all jobs | one attestation, identical identity → DESIGNATED, with the latest attempt's result |
| 12 | re-run failed jobs only | the moved attestation → DESIGNATED; with none listed → `UNKNOWN(ci_attestation_invalid)`; one that re-executes the emitter's job → `CI_FAILED` or `UNKNOWN(ci_attestation_invalid)` |
| 13 | a closed or a merged PR | `NOT_OPEN`, with no artifact read |
| 14 | a PR whose head repository is a fork | `UNKNOWN(ci_attestation_untrusted)` |
| 15 | an old pre-emitter run with no attestation, and a newer valid run for the current `K0` | the newer run is the frontier |
| 16 | an old run whose attestation expired, and a newer valid run for the current `K0` | the newer run is the frontier |
| 17 | an old valid run that failed, and a newer valid run that succeeded | the newer run governs: CI succeeds |
| 18 | an old valid run that succeeded, and a newer valid run that failed | the newer run governs: `CI_FAILED` |
| 19 | an older successful run for the current `K0`, and a newer INVALID run — for example one cancelled before any step ran, as PR #686's run 1897 was | `UNKNOWN(ci_attestation_invalid)`; never the older success |
| 20 | a newer valid run attested for another PR, and an older valid run for the current `K0` | the unrelated run is skipped; the older run is the frontier |
| 21 | a newer STALE run, and a lower run matching the current `K0` exactly | the STALE run is excluded; the lower run is the frontier |
| 22 | one head used by two PRs | each PR's frontier comes only from runs attested for that PR |
| 23 | a re-run of the frontier | `run_number` unchanged; the same frontier, with its latest attempt's state |
| 24 | zero candidate runs | `CI_NOT_STARTED` |
| 25 | candidates, none of which establishes a safe frontier: an INVALID run above any match; or only UNRELATED and STALE runs | `UNKNOWN(ci_attestation_invalid)`; or `CI_NOT_STARTED`. Never readiness |
| 26 | any permutation of the same candidate records; and a duplicated or malformed `run_number` | the same frontier and result in every order; `UNKNOWN(malformed)` in every order |
| 27 | the frontier `queued` or `in_progress`; an unrecognized status or conclusion | `PENDING`; `UNKNOWN(unrecognized_ci_status)` or `UNKNOWN(unrecognized_ci_conclusion)` |

Fixtures 6–9, and fixture 4's forgery, classify one run as INVALID. That run makes the pass `UNKNOWN` only when it lies
above any frontier; below a frontier it is never read (§5).

## 11. Implementation-lane proof obligations

The `ci.yml` implementation PR proves the following live on real Hone runs, before 05A depends on this record:

- **Positive fixture:** a real attested run, pinned with its run metadata as fixture 1.
- **Full re-run:** "re-run all jobs" leaves exactly one `ci-attest-v1` with identical identity.
- **Partial re-run:** one that does not re-execute the emitter's job leaves the earlier artifact listed. If it does not,
  §6's fail-closed row is the recorded outcome.
- **Integrity:** the zip holds one entry, and its SHA-256 equals `digest` (already observed in general, E8).
- **Emitter:** the two steps of §4.1 — generate, then upload — both before checkout, with §4.2's options.
- **Replacement:** a close and reopen at an unchanged head creates a run with a higher `run_number`, which becomes the
  frontier (§5).

A proof that contradicts this record returns to architecture: it is amended here first and never patched into a parser.

## 12. Sequence, and what ARCH-01 consumes

1. **PR-SNAPSHOT-01 and CAP-01** are merged.
2. **This record re-enters by removal and merges.**
3. **#800 is narrowed by removal:**
   - delete the mutable `pull_requests` association law and the reason `ci_pr_binding_ambiguous`;
   - delete its run-selection rule — `ALL_DESIGNATED_RUNS`, the `LATEST_CREATED` relaxation and its run-state table —
     and consume this record's normalized frontier result (§5) instead. CI-ATTEST-01 owns candidate and frontier
     membership;
   - add one normative pointer: *"CI state is CI-ATTEST-01's current-run frontier result."*;
   - consume PR-SNAPSHOT-01's `K0` and its terminal handling;
   - keep 05B free of `run_number` logic: it decides from normalized CI evidence only;
   - add no parser and no reconstruction mechanism, and do not copy this record's specification into ARCH-01.
4. **The emitter ships.** A separate implementation PR adds it to `ci.yml` — shared CI infrastructure, so the full CI
   matrix runs — and discharges §11.
5. **05A, then 05B,** only after steps 1–4. ARCH-02 remains later.

ARCH-01 gains two closed reasons from this record: `ci_attestation_invalid` and `ci_attestation_untrusted`. This
binding consumes:
- `K0`, from PR-SNAPSHOT-01;
- the target repository id;
- the `merge_base_commit` of the compare read bound to `K0`;
- from CAP-01's `readCandidateRuns`, each candidate's run metadata, `run_number`, `status`, `conclusion` and
  `run_attempt`.

Until step 3, #800 stays a frozen draft; its open CI-binding findings are this record's origin.

## 13. Review budget

One legitimate semantic repair round is allowed. A second fresh, legitimate semantic P0–P2 in the **same** family →
**stop**: no third patch, and a return to architecture discussion.

Families: the artifact contract, binding classes and run selection, trust, attempts and re-runs, retention, closed PRs.

Pure prose, formatting or non-normative feedback does not consume the budget.

**Round 1** (Codex review of `8d20b1a3f3`): the **binding classes** family. P1 `4190932205` found that the DESIGNATED
row never compared the attested base with the PR's current base. A PR retargeted from production without a new run could
keep a designated run. Repaired at `907699df66`: designation required the attested base to equal the PR's current base,
which had to be the production ref; every other base outcome was STALE.

**Round 2** (Codex review of `907699df66`): a second **binding classes** finding. P1 `4190972680` showed that the
current base was read once and never re-validated, so a retarget concurrent with collection could still designate the
old production attestation. The stop law fired, and no patch was made.

**Re-entry by removal** (operator decision after PR-SNAPSHOT-01 and CAP-01 merged; not a repair round). This record's
own reads and re-validation of the PR were **removed rather than extended**. It compares the attestation with `K0`
only, and PR-SNAPSHOT-01's `K1 == K0` discards any pass in which the base moved. No base re-read, guard or other
mechanism was added. A fresh semantic P0–P2 affecting CI attestation correctness → **stop**, with no automatic patch.

**Ready-gate review** (Codex review of `557ed2ce96`, triggered by marking the PR ready). P1 `4199398920`, in the
artifact contract: the emitter cannot be one step. P2 `4199398926`, in binding classes: an older INVALID run poisoned
the head even after a valid replacement run existed, so §8's recovery paths could not work. The binding-classes budget
was already spent, and the stop law fired.

**Architecture re-entry** (operator decision after that stop; not a repair round). §4.1 now specifies the two-step
pre-checkout emitter, and §5 replaces the all-candidates rule with the `run_number` current-run frontier. Nothing else
changed. One fresh exact-head review and the ready-for-review gate follow. Any further P0–P2 in run selection, frontier
semantics, attestation binding, or replacement and recovery → **stop**, with no patch.

**CAP-01 dependency.** The ready-gate review of `9480ce37c0` (P1 `4200685968`) found that no CAP-01 reader exposed the
frontier's `status` and `conclusion`. The owning record was amended first: CAP-01-READER-STATE-01 (PR #805, merged as
`da15f178`) makes `readCandidateRuns` return each run's execution state from one complete response, with no new reader
or capability. This record now cites that reader; its frontier semantics did not change.

## 14. Non-goals

This record adds no `ci.yml` change, no 05A, no 05B, no edit to #800 or ARCH-01, no ARCH-02, no OIDC (escalation only),
no use of GitHub's current PR views, no read or re-validation of the PR (PR-SNAPSHOT-01 owns it), no GitHub-access
guard (CAP-01 owns that lint), no status or check emission, no timestamp, run-id or cross-run `run_attempt` ordering
(`run_number` is the only cross-run order, §5), and no history reconstruction.

---

## Appendix — sources

- GitHub Docs: [Events that trigger workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows) ·
  [Re-running workflows and jobs](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs) ·
  [Variables reference](https://docs.github.com/en/actions/reference/workflows-and-actions/variables) ·
  [Contexts reference](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts) ·
  [REST: workflow runs](https://docs.github.com/en/rest/actions/workflow-runs) ·
  [REST: artifacts](https://docs.github.com/en/rest/actions/artifacts) ·
  [OpenID Connect reference](https://docs.github.com/en/actions/reference/security/oidc)
- [`actions/upload-artifact`](https://github.com/actions/upload-artifact) README and v7.0.0 release notes;
  [non-zipped artifacts changelog, 2026-02-26](https://github.blog/changelog/2026-02-26-github-actions-now-supports-uploading-and-downloading-non-zipped-artifacts/)
- GitHub Support on artifacts and re-runs, quoted in [community discussion #17854](https://github.com/orgs/community/discussions/17854)
- Live reads, 2026-10-06: #800 runs `37395019207`, `37396356200`, `37398647168`, `37400917099`; #788 run `37387844240`;
  #660 run `33328302918`; re-run attempts of runs `37362604831`, `37345932970` and `36713945166`; artifact `11357189201`;
  all 2,829 `ci.yml` runs and the attempts of 12 re-run runs (E14); the five same-head pairs, including PR #686's runs
  `34289324265` (1896) and `34289324311` (1897).
