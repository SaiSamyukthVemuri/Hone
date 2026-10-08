# R-STACK — independent proof attempt (operator gate, 2026-10-08)

Independent verifier for ENG-LOOP V1 05A. Sources: SPEC-05A (14522609) §2–§3 and §7, ARCH-01 §41, CI-ATTEST-01 §13,
GitHub documentation (quoted, fetched read-only on 2026-10-08), GitHub's published GraphQL schema and REST OpenAPI
description, and live read-only observations (REST `GET` and GraphQL queries only). No implementation source was read.
Executable rows: `rstack.verify.test.ts`. Recorded evidence: `fixtures/real/rstack/*.json` (third-party logins and branch
names removed; Hone data as read).

## 0. Verdict

**NOT PROVEN.**

The remaining rules exclude every enumerated vector except three: B1 (rename), B2 (archive) and B3 (permanent
deletion). Each of those three rests on a GitHub behaviour that is undocumented and that read-only access cannot
observe. They are set out in §5.

The associated-PR clause does not exclude B1–B3 either. GitHub's schema says `associatedPullRequests` returns only the
merged PR that introduced a commit and, for a commit outside the default branch, open PRs. A closed, archived or deleted
PR is therefore never in it. So B1–B3 are residuals of today's §3.4, with or without the clause. Under the operator's
decision, the clause stays and this report names the blocker.

A separate finding came up while checking the base half of "exact PR/head/base binding". Rule 4 does not see automatic
base changes (§7).

## 1. The question

Let K0 be the coherent key of PR X: OPEN, head SHA H, head ref h, head repository T (the target, by rule 1), base ref P
(production). A run R is *applicable* when it passes rule 7:
- `workflow_id = 289443461`;
- `event = "pull_request"`;
- `head_sha = H`;
- `head_repository.id = T`;
- `head_branch = h`.

Remove rule 5's associated-PR clause. The remaining rules are:
- rule 1: fork exclusion;
- rule 4: no `BaseRefChangedEvent`;
- rule 5's head-branch list: `pulls?head=<owner>:<h>&state=all` is exactly `[X]` and not capped;
- rule 6: production's current rules;
- rule 7: the run filter above;
- rule 8: production's recorded year;
- the coherent key, confirmed by the second pass;
- 05B's `behindBy == 0`.

**Claim C.** Every applicable run was triggered by PR X.

## 2. Premises and their evidence

| Id | Premise | Evidence | Status |
|---|---|---|---|
| P-BASE | A `pull_request` run listed under T's workflow was triggered by a PR whose base repository is T. | Docs: "For pull requests from a forked repository to the base repository, GitHub sends the `pull_request` … events to the base repository. No pull request events occur on the forked repository." REST *Create a pull request*: "You cannot submit a pull request to one repository that requests a merge to a base of another repository." Live: a cli/cli fork PR's run has `repository_id` = the base repository (`public-run-identity.json`). | PROVEN |
| P-RUN | A `pull_request` run records the triggering PR's head SHA, its head ref as `head_branch` and its head repository as `head_repository`. For a fork that is the fork, never the base. These are trigger-time values, kept after the branch is deleted. | OpenAPI `workflow-run.head_sha`: "The SHA of the head commit that points to the version of the workflow being run." Live: Hone #810 (11 runs: `feat/eng-loop-v1-05a`, T, `pull_requests [810]`) and #815 (6 runs: `feat/eng-loop-v1-05b`). cli/cli fork #14617 (run `head_repository` = the fork's id ≠ base). cli/cli reopened fork #14294 (runs 2 s after the reopen carry that PR's head ref and head repository). cli/cli deleted forks #14544 and others (PR `head.repo` null; runs still carry the fork's id). Hone #601 and #596 (branch deleted; runs keep `head_branch`). | PROVEN for same-repo, fork, reopened, deleted-branch and deleted-fork. UNPROVEN after a rename. |
| P-RERUN | A re-run keeps the record's identity fields. | Docs: "The workflow will also use the same `GITHUB_SHA` (commit SHA) and `GITHUB_REF` (git ref) of the original event that triggered the workflow run." OpenAPI `run_started_at`: "Resets on re-run." Live: Hone runs 37366170753 and 37362604831, attempt 1 vs 2. `head_branch`, `head_sha`, `head_repository` and `created_at` are equal; only `run_started_at` moves. | PROVEN |
| P-LABEL | A PR whose head repository is T has head label `<T's owner>:<head ref>`. | REST `head` filter: "Filter pulls by head user or head organization and branch name in the format of `user:ref-name`". Live: #810 `SaiSamyukthVemuri:feat/eng-loop-v1-05a`, #815 `SaiSamyukthVemuri:feat/eng-loop-v1-05b`. | PROVEN |
| P-LIST | `pulls?head=<owner>:<ref>&state=all` returns every PR of T with that label, in any state and to any base. That includes after the head branch is deleted, and after it is restored. | REST `state`: "Either `open`, `closed`, or `all`". Live, Hone: #601 and #596 (branch deleted), #495 (head ref deleted 2026-08-01, restored 2026-08-16), #809 (merged), #810 (open). Live, nodejs/node and grafana/grafana: two PRs on one label with different bases, both returned (`public-shared-head-labels.json`). Exception observed: a PR whose head **repository** was deleted is not returned (cli/cli #14544, #14502). That applies to forks only, since a same-repo PR's head repository is T. | PROVEN except for B2 and B3 |
| P-FIXED | A PR's head label cannot be edited and survives deletion of its ref. | REST *Update a pull request* body: `title`, `body`, `state`, `base`, `maintainer_can_modify` (no head). GraphQL `UpdatePullRequestInput`: no head field (`graphql-schema.json`). `PullRequest.headRefName`: "Identifies the name of the head Ref associated with the pull request, even if the ref has been deleted." Live: #601, #596, #495. | PROVEN except for B1 |
| P-RENAME | Renaming a PR's head branch leaves the PR's label and its runs' `head_branch` consistent: both keep the old name, or both change. | Docs: "If the renamed branch is the head branch of an open pull request, this pull request is closed." Nothing documents the closed PR's label or its runs. No rename in Hone: each of the 63 PRs whose head branch is gone has a `HeadRefDeletedEvent`. A 64th, #816, only looked gone: it was opened after the branch list was read, and its branch exists. Closing rather than retargeting (bases are retargeted) fits "label kept", but that is an inference. | **UNPROVEN (B1)** |
| P-VISIBLE | The dedicated read-only token sees every PR in the head listing, archived ones included. | Docs (*Archive pull requests*), quoted below this table. GraphQL `archivePullRequest`: "Users with the triage role or higher can archive pull requests." This conflicts with the docs' "Repository administrators". The V1 token is fine-grained and read-only, with no Administration permission (README). No archived PR exists in Hone, and making one is a write. | **UNPROVEN, and the docs point the other way (B2)** |
| P-NODELETE | A PR cannot vanish from the listing by deletion. | The archive docs call archiving "a moderation option between leaving a pull request up and permanently deleting it". Who can delete, and what happens to the PR's runs, is undocumented. | **UNPROVEN (B3)** |
| P-NOTRIGGER | GitHub records no field saying which PR triggered a run, so attribution can only be inferred. | OpenAPI `workflow-run.pull_requests`: "Pull requests that are open with a `head_sha` or `head_branch` that matches the workflow run. The returned pull requests do not necessarily indicate pull requests that triggered the run." Live: runs of deleted-branch PRs show `pull_requests: []`. | PROVEN (it is why the proof must go through the listing) |

The *Archive pull requests* docs page says:

> "Archiving a pull request removes it from public view while preserving its history for repository administrators."
> "The pull request is only visible to repository administrators. Visitors without administrator access to the repository receive a 404 error."
> "The pull request is automatically closed and locked."

## 3. The argument, and where it stops

1. **Lemma 1 (base repository).** By P-BASE, R was triggered by a PR Y of repository T.
2. **Lemma 2 (identity).** Rules 1 and 7 give `R.head_repository = T` and `R.head_branch = h`. By P-RUN, Y's head repository was T and Y's head ref was h when R was triggered. By P-LABEL, Y's label was then `O:h`, where O is T's owner.
3. **Lemma 3 (persistence).** Y's label is still `O:h`. P-FIXED covers every edit path and the deletion and restoration of the ref. Closing, merging and reopening never touch it: #809, #601 and #495 are live examples. **Not covered:**
   - a rename (P-RENAME);
   - an archive (P-VISIBLE);
   - a deletion (P-NODELETE).
4. **Lemma 4 (listing).** By P-LIST and P-VISIBLE, Y is in `pulls?head=O:h&state=all`. Rule 5 requires that listing to be exactly `[X]` and not capped, so Y = X.
5. **Lemma 5 (re-runs).** By P-RERUN, Lemmas 2–4 hold for every attempt of R.
6. **Lemma 6 (timing).** Rule 5's listing is read before the runs in each pass, and the confirming pass re-reads both (§5.3).
   - Suppose a PR's run appears in the first pass's runs read. Then that PR existed, with its label, before the confirming pass read the listing.
   - The PR is missing from both listing reads only if it left the listing in between. Only B1–B3 can do that.
   - If it entered or left between the passes, the bodies differ, and the result is `unstable_snapshot`.

**Theorem.** Assume P-RENAME, P-VISIBLE and P-NODELETE. Then every applicable run was triggered by X, and C holds with
the clause removed. Without those three premises, C is **not proven**.

## 4. Vectors

Each row below has an executable row in `rstack.verify.test.ts`, run with the clause absent.

| # | Vector | Excluded by | Premises | Row |
|---|---|---|---|---|
| V1a | Another **open** PR on h (another base) with a green run at H | rule 5 list → `shared_head` | P-RUN, P-LIST | V1a |
| V1b | Another **closed** PR on h, its old run at H | rule 5 list | P-LIST | V1b |
| V1c | Another **merged** PR on h | rule 5 list | P-LIST | V1c |
| V1d | h deleted and recreated; the old PR is closed and its run predates K0's | rule 5 list | P-LIST, P-FIXED | V1d |
| V2 | A stacked or duplicate PR at H on its own branch (the live #815 shape) — green, failed, or the only run | rule 7 `head_branch` (inert: never grants, never blocks) | P-RUN | V2a–V2c |
| V3 | A fork PR with our branch name at H; the same after the fork is deleted; `head_repository` null | rule 7 `head_repository.id` (rule 1 fixes it to T) | P-RUN | V3a–V3c |
| V4a | Renamed **out of** h, old label kept | rule 5 list | **P-RENAME** | V4a |
| V4b | Renamed **into** h, runs recorded under the old name | rule 7 `head_branch` | **P-RENAME** | V4b |
| V5a | K0's own PR closed and reopened | not cross-PR: every run is X's | P-RUN | V5a |
| V5b | Another PR on h, closed and reopened | rule 5 list | P-LIST | V5b |
| V6 | Two open PRs from h with different bases | rule 5 list | P-LIST | V6 |
| V7 | Another PR's head branch h deleted and restored | rule 5 list | P-LIST (live #495) | V7 |
| V8 | A deleted head repository | same-repo: impossible while T exists; fork: rule 7 (the run keeps the fork id) | P-RUN | V3b |
| V9 | A re-run of any of the above | the same rule as the original | P-RERUN | V9a–V9c |
| V10 | `push` or `pull_request_target` runs at H on h | rule 7 `event` | none | V10 |
| — | A PR from T's branch to **another** repository | its runs live in that repository's listing, not T's | P-BASE | — |
| B1 | Renamed out of or into h, **with a label and run-name mismatch** | **nothing** | P-RENAME | blocker rows |
| B2 | Another PR on h **archived** | **nothing**, if the token cannot see it | P-VISIBLE | blocker rows |
| B3 | Another PR on h **permanently deleted** | **nothing** | P-NODELETE | blocker rows |

**Mutant.** The row file also drops rule 5's head-branch clause. Every row that the list excludes then fails: V1a–V1d,
V4a, V5b, V6, V7 and V9b. The foreign run is then counted for K0, so the remaining clause is load-bearing.

**Live #810/#815.**
- With the clause absent, #810 at b99b7332 does not read `shared_head` because of #815.
- #815's runs, even re-pointed to #810's head SHA, never count for #810: their `head_branch` is `feat/eng-loop-v1-05b`.
- With the clause present, #810 reads `shared_head`, as §7 R-STACK records.
- Live: no #815 run exists at any #810 head SHA.

## 5. The blockers

**B1 — rename.** The docs say only that renaming an open PR's head branch closes that PR. Two sequences are open:
- **Out of h.** PR Y (head h, any base, e.g. a stacked base) has a green run at H recorded with `head_branch = h`. h is
  renamed; Y closes. A new branch named h is created at H and X is opened to production. If GitHub rewrote Y's label to
  the new name but left its runs alone, rule 5's listing is `[X]` and Y's run passes rule 7.
- **Into h.** Y's branch z is renamed to h. Here the hole needs the opposite mismatch: runs rewritten, label not.

The clause never sees Y, because Y is closed. Rows: "R-STACK blockers B1–B3".

**B2 — archive.** Y (on h) is archived, which per the docs closes it and hides it from everyone without administrator
access. If the read-only token is treated as a non-administrator, rule 5's listing is `[X]`. If Y's runs stay in the
Actions listing (also unobserved), they pass rule 7. Who can archive is itself inconsistent: the docs say "repository
administrators", the schema says "triage role or higher". The clause never sees Y, because Y is closed.

**B3 — deletion.** The same as B2, for a PR permanently deleted by whoever can do that.

**How much harm.** In all three, rule 10's aggregation (any FAILED → FAILED, then any PENDING → PENDING) means a foreign
green run can turn the CI row into SUCCEEDED only in one case: K0's own runs at H are all green (then SUCCEEDED already
holds on K0's own evidence) or missing.
- K0's own run is missing only if Actions did not run it. 05B's `behindBy == 0` rules out a merge conflict (docs:
  "Workflows will not run on `pull_request` activity if the pull request has a merge conflict").
- The blocker rows show all three cases: missing → SUCCEEDED from the foreign run; failed → FAILED; running → PENDING.
  The same holds with and without the clause.

**What would close them.**
1. **Evidence.** An operator-run experiment in a scratch repository: rename a PR's head branch, archive a PR, and read
   both with a read-only fine-grained token. It needs writes, so it is outside this verifier's mandate.
2. **A direct binding of run to PR.** P-NOTRIGGER says GitHub's run record has none. Only run-side attestation of the
   triggering PR number (CI-ATTEST-01) provides one, and V1 excludes it by design.
3. **Partial: a creation-time bound.** Every applicable run's `created_at` must be at or after K0's `createdAt`. §2.2
   already reads `createdAt` and §3.1 reads `created_at`. Live: no `pull_request` run precedes its PR in the 40 most
   recent Hone PRs, and `created_at` survives re-runs (P-RERUN).
   - It closes B1, because the renamed PR's runs predate the rename, which predates K0.
   - It closes the single-PR forms of B2 and B3.
   - It leaves one case open: a second PR opened on K0's own head branch while K0 is open, then archived or deleted.
     Two open PRs on one head branch were not observed anywhere (§6).

## 6. The questions the gate asked to settle

- **`pulls?head=…&state=all`:**
  - head branch deleted → returned (#601, #596);
  - deleted then restored → returned (#495);
  - renamed → **UNPROVEN**;
  - head repository deleted → **not** returned (cli/cli #14544, #14502; forks only, and their runs are excluded by rule 7 anyway).
- **What a `pull_request` run records:**
  - fork → the fork's branch name and the fork as `head_repository` (cli/cli #14617);
  - reopened → that PR's head branch and head repository (cli/cli #14294);
  - deleted fork → still the fork's id (cli/cli #14544 and others);
  - renamed branch → **UNPROVEN**.
- **Can two open PRs share a head branch?**
  - Not observed. Hone has 814 PRs and 814 distinct head labels. Across 3,222 open PRs in nodejs/node, grafana/grafana,
    microsoft/vscode and home-assistant/core, no two share one.
  - Sequential PRs on one label with different bases do exist (nodejs/node, grafana/grafana).
  - It is not load-bearing, because rule 5's listing is `state=all`. It matters only for the residual of the
    creation-time bound.

## 7. New finding — rule 4 does not see automatic base changes (base binding)

**Observation.** Live: among grafana/grafana's 100 most recently updated PRs, 6 have an
`AutomaticBaseChangeSucceededEvent`.
- 5 of them have no `BaseRefChangedEvent` at all.
- #133976 shows both kinds: an earlier manual change as a `BaseRefChangedEvent`, and a later automatic one only as an
  `AutomaticBaseChangeSucceededEvent`.

Recorded in `public-automatic-base-change.json`.

**Why it matters.** SPEC-05A §2.2 counts only `BASE_REF_CHANGED_EVENT`. So §3.4's "the run's base was always production,
because this PR has no base change (step 4)" is false for a PR that GitHub retargeted automatically. Its runs from before
the retarget tested the old base, and rule 8 never covers that base's history.

**Practical reach.**
- In the usual flow, the lower PR merges into production as a new commit (a merge or squash commit). The retargeted PR
  is then behind production, and 05B's `behindBy == 0` (A9) forces a new head, and so a fresh run, before it can pass.
- The stale-base run can count only if production reaches a commit in the PR's own history without a new commit. That
  means a fast-forward push.
- Hone's production first-parent history includes direct pushes as well as merges.
- Hone today has 0 automatic base changes against 16 manual ones.

**Fix.** Count `AUTOMATIC_BASE_CHANGE_SUCCEEDED_EVENT` (and `_FAILED_EVENT`) in §2.2's `itemTypes`, so rule 4 binds the
base exactly. Like rule 4 today, this has no cost while there is no base change.
