# CI-ATTEST-01 — immutable run-side CI attestation

| Field | Value |
|---|---|
| **Decision** | A CI execution names the PR, head and base it ran for in **one immutable artifact** that the authoritative workflow emits from the triggering event, before any PR code runs. ENG-LOOP binds a CI run to a PR **only** through that attestation. |
| **Date** | 2026-10-06 |
| **Status** | **PROPOSED** in this pull request; **ACCEPTED** when merged. |
| **Decided by** | Sam (operator): CI-ATTEST-01 is the re-entry architecture after ARCH-01's CI-authority stop law fired on PR #800; re-entered **by removal** after PR-SNAPSHOT-01 (PR #803) and CAP-01 (PR #804) merged. |
| **Purpose** | Exactly one fact: *"This trusted CI execution ran for PR N, at head H, against base B, under authoritative workflow W."* |
| **Consumed by** | ARCH-01 (`docs/decisions/arch-01-eng-loop-v2.md`, PR #800). ARCH-01 **consumes** this fact; it never derives it (§12). |
| **Depends on** | PR-SNAPSHOT-01 (`docs/decisions/pr-snapshot-01-identity-key.md`, merged) for the coherent key `K0`; CAP-01 (`docs/decisions/cap-01-github-capability-boundary.md`, merged) for GitHub-access architectural lint. |
| **Scope** | The artifact contract, binding against `K0`, the trust anchor, attempts and re-runs, retention, terminal PRs, fixtures. |
| **Not in scope** | The `ci.yml` change (a separate implementation PR, §11); any edit to #800; 05A; 05B; ARCH-02; reading or re-validating the PR, which PR-SNAPSHOT-01 owns; GitHub-access lint, which CAP-01 owns. |
| **Authored at** | production `7134239097908a8780aef7fd8fe9b3505d0f4ae0`; re-entered at production `9402c21718f31dd72016ed0c4d421bb00f9551ee`, where PR-SNAPSHOT-01 and CAP-01 are merged. Live evidence read on 2026-10-06. |

> **Normative.** Where an implementation and this record disagree, the implementation is wrong. A change to these semantics
> is proposed, reviewed and merged **here first**; it never evolves through review-repair rounds.

---

## 1. The fact, and what it is not

The attestation supplies **identity only**: PR number, head, base, repository and run. It never grants CI success and never
creates a failure or a pending state. Whether a run succeeded, failed or is pending is decided, as before, by the run's own
`status` and `conclusion` (ARCH-01 §8). An attestation can only make a candidate run **designated** for a PR, or exclude it.

**Never PR identity:** a run's or check run's `pull_requests`, a run's `display_title` or `run-name`, a job or check name,
a commit status, a check run, a timestamp, a run id ordering, a `run_attempt` ordering, or the runs endpoint's `branch`
filter.

**Ownership — no overlap.**

| Record | Owns |
|---|---|
| PR-SNAPSHOT-01 | the PR's current state, head, base and repositories, as one coherent `PrSnapshotKey`; `K0`/`K1` coherence; the bounded retry |
| CI-ATTEST-01 (this record) | immutable CI execution identity, and its comparison with `K0` |
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

## 4. The artifact contract — schema v1 (frozen)

### 4.1 Emitter

- **Workflow:** the authoritative CI workflow, `.github/workflows/ci.yml` (workflow id `289443461`, ARCH-01 §23).
- **Event:** `pull_request` only.
- **Position:** the **first step of the first job** (today `changes`), before `actions/checkout` and before any repository
  or PR code executes. Every job that runs repository code depends on that job.
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

## 5. Binding — one candidate run (05A)

This section applies to an **open** pass; a terminal pass reads no CI (§9). Candidates are ARCH-01's: the `ci.yml`
endpoint ∩ the exact head `K0.headSha` ∩ `event=pull_request`. Trust (§7) is settled first, once per pass. Then, for each
candidate:

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
| `prNumber`, `headSha`, `headRef`, `headRepositoryId`, `baseRef`, `baseRepositoryId` and `baseSha` equal `K0`'s `prNumber`, `headSha`, `headRef`, `headRepoId`, `baseRef`, `baseRepoId` and `baseSha`; and `K0.baseRef` is the configured production ref, so `K0.baseSha` is the production head | **DESIGNATED** | takes part in ARCH-01's CI rules; its result is the run's `status` and `conclusion` |
| `prNumber` ≠ `K0.prNumber` | **UNRELATED** | excluded: never grants success, never creates a failure or a pending state |
| `prNumber` = `K0.prNumber`, and the head fields and `baseRepositoryId` match, but `baseRef` ≠ `K0.baseRef`, or `K0.baseRef` is not the configured production ref, or `baseSha` ≠ `K0.baseSha` | **STALE** | excluded: the run tested another base, or the PR no longer targets production, and the run cannot satisfy CI for the current PR |
| `prNumber` = `K0.prNumber` but any head field, or `baseRepositoryId`, differs from `K0` | **INVALID** | `UNKNOWN(ci_attestation_invalid)` |

Any failure in steps 1–3 is **INVALID**. One INVALID candidate makes the **whole snapshot**
`UNKNOWN(ci_attestation_invalid)`. Otherwise ARCH-01's designated runs are exactly the DESIGNATED candidates; with none,
ARCH-01 decides `CI_NOT_STARTED`. Classification depends on no ordering of the candidates.

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

| Situation | GitHub behaviour | Result |
|---|---|---|
| first attempt | one upload | binds |
| re-run all jobs | earlier artifacts removed (E5); the emitter uploads again | one artifact → binds |
| partial re-run that does not re-execute the emitter's job | the earlier artifact moves into the new attempt (E5) | one artifact → binds; if GitHub did not keep it, none → `UNKNOWN(ci_attestation_invalid)` |
| partial re-run that re-executes the emitter's job | the moved artifact plus a second upload of the same name | the upload is refused (E4), the emitter fails and so does the run → `CI_FAILED`; or two are listed → `UNKNOWN(ci_attestation_invalid)`. Never a false ready. |

**Why one fixed name.** GitHub moves earlier artifacts into later attempts (E5) and offers no attempt filter (E7), so
per-attempt names would require choosing between attempts — an ordering ARCH-01 forbids. Recovery from any fail-closed row:
re-run all jobs, or push.

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
- **Expired or unreadable:** an expired, removed or unreadable attestation is `UNKNOWN(ci_attestation_invalid)`. It is
  never a CI failure, never a CI success, and never permission to infer identity elsewhere.
- **Operational requirement:** an open PR's current head needs a CI run younger than 90 days. An idle PR needs a new
  execution: a re-run within 30 days (E3), a push, or a close and reopen.
- **Rollout:** runs created before the emitter ships carry no attestation and are `UNKNOWN` until their next run.

## 9. Closed and merged PRs (frozen)

- **Terminal handling is PR-SNAPSHOT-01's.** When `K0.state` is not `OPEN`, the pass is terminal; its key, `K1 == K0`
  and `NOT_OPEN` are PR-SNAPSHOT-01 §7's.
- **No CI read.** A terminal pass makes none of this record's reads: no candidate, artifact or anchor. An expired
  attestation, a removed artifact or an emptied GitHub association therefore can never make a closed or merged PR
  `UNKNOWN`, and a terminal PR needs no historical artifact.

## 10. Required fixtures and negative controls

| # | Fixture | Required result |
|---|---|---|
| 1 | a real, valid attested run of a current Hone PR (§11) | DESIGNATED |
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

## 11. Implementation-lane proof obligations

The `ci.yml` implementation PR proves the following live on real Hone runs, before 05A depends on this record:

- **Positive fixture:** a real attested run, pinned with its run metadata as fixture 1.
- **Full re-run:** "re-run all jobs" leaves exactly one `ci-attest-v1` with identical identity.
- **Partial re-run:** one that does not re-execute the emitter's job leaves the earlier artifact listed. If it does not,
  §6's fail-closed row is the recorded outcome.
- **Integrity:** the zip holds one entry, and its SHA-256 equals `digest` (already observed in general, E8).
- **Emitter:** first step, before checkout, with §4.2's options.

A proof that contradicts this record returns to architecture: it is amended here first and never patched into a parser.

## 12. Sequence, and what ARCH-01 consumes

1. **PR-SNAPSHOT-01 and CAP-01** are merged.
2. **This record re-enters by removal and merges.**
3. **#800 is narrowed by removal:**
   - delete the mutable `pull_requests` association law and the reason `ci_pr_binding_ambiguous`;
   - add one normative pointer: *"Designated CI membership requires a valid immutable CI-ATTEST-01 run-side
     attestation."*;
   - consume PR-SNAPSHOT-01's `K0` and its terminal handling;
   - add no parser and no reconstruction mechanism, and do not copy this record's specification into ARCH-01.
4. **The emitter ships.** A separate implementation PR adds it to `ci.yml` — shared CI infrastructure, so the full CI
   matrix runs — and discharges §11.
5. **05A, then 05B,** only after steps 1–4. ARCH-02 remains later.

ARCH-01 gains two closed reasons from this record: `ci_attestation_invalid` and `ci_attestation_untrusted`. This
binding consumes:
- `K0`, from PR-SNAPSHOT-01;
- the target repository id;
- the `merge_base_commit` of the compare read bound to `K0`;
- the run metadata §5 compares against.

Until step 3, #800 stays a frozen draft; its open CI-binding findings are this record's origin.

## 13. Review budget

One legitimate semantic repair round is allowed. A second fresh, legitimate semantic P0–P2 in the **same** family →
**stop**: no third patch, and a return to architecture discussion.

Families: the artifact contract, binding classes, trust, attempts and re-runs, retention, closed PRs.

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

## 14. Non-goals

This record adds no `ci.yml` change, no 05A, no 05B, no edit to #800 or ARCH-01, no ARCH-02, no OIDC (escalation only),
no use of GitHub's current PR views, no read or re-validation of the PR (PR-SNAPSHOT-01 owns it), no GitHub-access
guard (CAP-01 owns that lint), no status or check emission, no attempt ordering and no history reconstruction.

---

## Appendix — sources

- GitHub Docs: [Events that trigger workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows) ·
  [Re-running workflows and jobs](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs) ·
  [Variables reference](https://docs.github.com/en/actions/reference/workflows-and-actions/variables) ·
  [REST: artifacts](https://docs.github.com/en/rest/actions/artifacts) ·
  [OpenID Connect reference](https://docs.github.com/en/actions/reference/security/oidc)
- [`actions/upload-artifact`](https://github.com/actions/upload-artifact) README and v7.0.0 release notes;
  [non-zipped artifacts changelog, 2026-02-26](https://github.blog/changelog/2026-02-26-github-actions-now-supports-uploading-and-downloading-non-zipped-artifacts/)
- GitHub Support on artifacts and re-runs, quoted in [community discussion #17854](https://github.com/orgs/community/discussions/17854)
- Live reads, 2026-10-06: #800 runs `37395019207`, `37396356200`, `37398647168`, `37400917099`; #788 run `37387844240`;
  #660 run `33328302918`; re-run attempts of runs `37362604831`, `37345932970` and `36713945166`; artifact `11357189201`.
