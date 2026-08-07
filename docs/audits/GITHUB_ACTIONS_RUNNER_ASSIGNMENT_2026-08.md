# GitHub Actions — jobs cancelled before runner assignment (2026-08-06)

Audit of the CI failure blocking draft PRs **#517** and **#518**.

Branch: `audit/github-actions-runner-assignment` · base: production
`03e7deaa38a7646a1f19a3d883c0a2b07894cec0`

---

## 1. Executive verdict

**Mixed cause (classification D).**

1. **The initiating condition is external and confirmed.** GitHub declared an
   official incident — *"Incident with Actions"*, impact **critical**, started
   **2026-08-06T15:22:49Z**, component `Actions` at **`major_outage`**, and
   **still unresolved** at the time of writing. Its 17:02 update states
   verbatim: *"Workflow runs are still failing or delayed in starting, and **some
   queued jobs may time out**."* That is precisely the observed signature.

2. **A separate, pre-existing, repository-owned defect was exposed by it, and is
   the more serious of the two.** When `changed-path detection` does not
   succeed, its job outputs are empty, so the aggregator `browser e2e (local
   stack)` — the job this repository designates as **the stable required
   check** — computed "no browser coverage required" and reported **success
   having run zero tests**. This is observable right now on a live PR head
   (#518). It is a **fail-open**, and it is fixed on this branch.

**No application code, migration, or feature branch was touched. Neither the
incident nor the fix has any relationship to the contents of #517 or #518 — the
code on both branches was never evaluated by CI.**

---

## 2. Affected PRs, SHAs and runs

| PR | Branch | Head SHA | Run | Attempts |
|---|---|---|---|---|
| #517 | `feat/calendar-appointment-prep-memory` | `2633871a1aadee80baa3d99bd04f5c2e13af298e` | `31118347711` | 2 |
| #518 | `feat/intake-electrolysis-acknowledgement` | `fd6538209dfc202de2818af313f8f2f01ed9cbeb` | `31120309970` | 1 |

Both runs are `event: pull_request`, workflow `ci` (`workflow_id: 289443461`,
path `.github/workflows/ci.yml`).

**`ci.yml` is byte-identical across production and both PR heads** — blob
`a9501cf6b7024d2a8152727fd2205ecdb007638c` at all three SHAs. The workflow was
last modified `ea46a43` on **2026-08-03**, three days earlier, and CI passed on
it repeatedly afterwards. *A workflow change cannot explain the regression.*

---

## 3. Timeline (UTC)

| Time | Event |
|---|---|
| 2026-08-06T11:12–13:17 | Four `ci` runs, **all success** (last green created **13:17:06**) |
| **15:22:49** | **GitHub incident "Incident with Actions" begins** (impact critical) |
| 15:45:14 | GitHub: *"Some workflow runs are failing to start or failing partway through"* |
| 16:01:55 | #517 run created (attempt 1) — 39 min into the incident |
| 16:01:56 → 16:16:58 | #517 gate queued **902 s**, cancelled, **no runner, 0 steps** |
| 16:17:47 → 16:32:49 | #517 aggregator queued **902 s**, cancelled, **no runner, 0 steps** |
| 16:33:31 | GitHub sets component `Actions` → **`major_outage`** |
| 16:34:33 → 16:49:36 | #518 gate queued **903 s**, cancelled, **no runner, 0 steps** |
| 16:35:12 → 16:50:14 | #517 attempt 2 gate queued **902 s**, cancelled, **no runner, 0 steps** |
| 16:50:15 → 17:05:17 | #517 attempt 2 aggregator queued **902 s**, cancelled, **no runner** |
| **16:50:31** | **#518 aggregator IS assigned runner `GitHub Actions 1000004033` after 7 s** and succeeds |
| 17:02:43 | GitHub: *"…some queued jobs may time out"* — incident **still investigating** |

No `ci` run occurred between 13:17:06 (green) and 16:01:55 (first affected), so
the incident began inside that gap. **Every run created after the incident start
is affected; every run before it passed.**

---

## 4. Raw job evidence

Two distinct JSON signatures, and the difference is diagnostic:

| Field | Cancelled gate | Skipped downstream job | Healthy job (green run) |
|---|---|---|---|
| `conclusion` | `cancelled` | `skipped` | `success` |
| `runner_id` | **`0`** | `null` | e.g. `1000004009` |
| `runner_name` | **`""`** (empty string) | `null` | `GitHub Actions 1000004009` |
| `steps` | **`0`** | `0` | `10` |
| `labels` | `["ubuntu-latest"]` | `["ubuntu-latest"]` | `["ubuntu-latest"]` |

`runner_id: 0` / `runner_name: ""` (rather than `null`) means the job **was
admitted for scheduling but never assigned a runner**. Zero steps means no
workflow code executed — so nothing in either PR's diff was evaluated.

### Measured durations — `changed-path detection`

| Run | Queue | Execution | Runner | Steps | Result |
|---|---|---|---|---|---|
| 31105198151 | 9 s | **10 s** | assigned | 10 | success |
| 31103579780 | 10 s | **14 s** | assigned | 10 | success |
| 31097446057 | 10 s | **13 s** | assigned | 10 | success |
| 31096326219 | 3 s | **13 s** | assigned | 10 | success |
| 31069740643 | 3 s | **14 s** | assigned | 10 | success |
| **31118347711 a1** | **902 s** | **0 s** | **none** | **0** | **cancelled** |
| **31118347711 a2** | **902 s** | **0 s** | **none** | **0** | **cancelled** |
| **31120309970** | **903 s** | **0 s** | **none** | **0** | **cancelled** |

---

## 5. Workflow graph

```
pull_request
  └─ changes ................. "changed-path detection"   (gate, timeout 2 min)
       ├─ validate ........... needs: changes,  if: docs_only != 'true'
       ├─ db-integration ..... needs: changes,  if: database || security || ...
       ├─ browser-e2e-shard .. needs: changes,  matrix from changes outputs
       │    └─ browser-e2e ... needs: [changes, browser-e2e-shard], if: always()
       ├─ payment-browser-e2e
       ├─ mobile-completion-e2e
       └─ google-browser-e2e
```

Every lane derives from the gate's outputs. When the gate dies, all `needs:
changes` jobs **skip** (correct GitHub semantics), and only `browser-e2e` — which
carries `if: always()` — still requires a runner.

---

## 6. Timeout analysis

**The configured timeouts are not implicated, and this is provable.**

* The gate declares `timeout-minutes: 2` (120 s). It was cancelled at **902 s** —
  ~7.5× that budget. **A job timeout firing would have cancelled it at 120 s.**
* Therefore **`timeout-minutes` did NOT count queued time in this incident.**
  GitHub's `timeout-minutes` clock starts when a job begins executing on a
  runner; these jobs never executed (0 steps, no runner), so it never armed.
* The 2-minute budget is generous against reality: measured execution on green
  runs is **10–14 s**, i.e. **~8.5× headroom**. It is not too aggressive.
* `timeout-minutes: 15` appears exactly once in `ci.yml` — on the *browser
  shard* (line 334), a different job that did not run here. The 902 s figure is
  **not sourced from this repository's configuration**; it is GitHub's own queue
  expiry, matching the incident's *"some queued jobs may time out"*.

**Conclusion: no timeout value in `ci.yml` should be changed on this evidence,
and none has been.** Raising the gate timeout would be speculative and would
weaken a bound that is currently correct.

---

## 7. Concurrency analysis — refuted

```yaml
concurrency:
  group: hone-pr-ci-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: true
```

* The group is **PR-scoped**, so #517 and #518 occupy different groups and cannot
  cancel one another.
* `gh run list` shows **exactly one run per branch** — nothing superseded
  anything.
* Concurrency cancellation is immediate; these cancellations occurred at a
  uniform ~902 s.
* No `environment:` key exists anywhere in `ci.yml`, so deployment-environment
  concurrency does not apply.
* No manual cancellation: `triggering_actor` and `actor` are the PR author from
  the `pull_request` event; no cancel action was issued.

---

## 8. Runner label / runner group analysis — refuted

* Both cancelled jobs request `["ubuntu-latest"]` — a standard GitHub-hosted
  label.
* `GET /actions/runners` → `{"total_count": 0}` — **no self-hosted runners**, so
  no runner-group or label-matching misconfiguration is possible.
* The **same label** was successfully served at **16:50:31** (#518's aggregator,
  assigned in 7 s). The label is valid and was being honoured intermittently
  throughout the window.

---

## 9. Permissions, policy and billing evidence

| Check | Result |
|---|---|
| `GET /actions/permissions` | `{"enabled": true, "allowed_actions": "all"}` — Actions **enabled**, no policy restriction |
| `GET /actions/permissions/selected-actions` | `409` — *"All actions and workflows are allowed"* |
| `GET /actions/permissions/workflow` | `default_workflow_permissions: read` (sufficient; the workflow needs no write) |
| `GET /actions/runners` | `total_count: 0` |
| Repository | `private: false`, `archived: false`, `disabled: false`, owner type **User** |
| Branch protection on `claude/build-hone-saas-hOex7` | **404 — branch not protected** |

**Billing could not be queried.** `users/.../settings/billing/actions`,
`user/settings/billing/actions` and `.../shared-storage` all return `404`; the
CLI reports the token lacks the `user` scope (present scopes: `gist`,
`read:org`, `repo`, `workflow`). **This is recorded as a limitation, not a
finding.**

However, a quota/spending cause is **structurally implausible**: the repository
is **public**, and GitHub does not bill minutes for standard GitHub-hosted
runners on public repositories, so no spending limit or included-minutes
exhaustion can gate these jobs. Stated as strong inference from repository
visibility plus GitHub's published policy — **not** as API-proven.

---

## 10. GitHub service status evidence (official)

Source: `https://www.githubstatus.com/api/v2/` (official status API).

* **Incident:** "Incident with Actions" — <https://stspg.io/rcz3fcm83sff>
* **Impact:** `critical`
* **Started:** `2026-08-06T15:22:49.021Z`
* **Resolved:** *none — still `investigating` at time of writing*
* **Components:** Actions, Pages
* **Component `Actions`:** `major_outage` (set `2026-08-06T16:33:31.366Z`)

Relevant updates:

| Time | Text |
|---|---|
| 15:45:14 | *"Some workflow runs are failing to start or failing partway through, and some requests to the Actions REST API are returning errors."* |
| 16:27:47 | *"Some workflow runs are still delayed or failing to complete…"* |
| 17:02:43 | *"Workflow runs are still failing or delayed in starting, and **some queued jobs may time out**."* |

The incident window **fully contains** every affected run and **excludes** every
green run.

---

## 11–12. Root-cause classification

### Classification D — mixed cause

**External initiating condition (not fixable in this repository).**
The GitHub Actions incident above prevented GitHub-hosted runner assignment;
jobs queued and expired at ~902 s without executing. Confirmed by the official
status API and by job telemetry (`runner_name: ""`, `steps: 0`).

**Repository-owned design weakness (fixable, and fixed here).**
`browser e2e (local stack)` derives *"is browser coverage required?"* entirely
from the gate's **outputs**. When the gate does not succeed those outputs are
`""`, so:

```
BROWSER_RUN=""  FULL_MATRIX=""   →  REQUIRED="false"
needs.browser-e2e-shard.result   →  "skipped"
  → case skipped) + REQUIRED=false → "no browser coverage required — satisfied" → exit 0
```

The required check goes **green having executed nothing**. Proven on a live PR
head:

```
$ gh api repos/SaiSamyukthVemuri/Hone/commits/fd65382.../check-runs
success    browser e2e (local stack)      ← REQUIRED CHECK, GREEN
cancelled  changed-path detection
skipped    typecheck / lint / build / test / safety gates
skipped    db integration (local supabase)
skipped    payment / google / mobile / browser shard
```

#517 escaped this only by accident — its aggregator *also* failed to get a
runner, so it went red instead of falsely green.

The branch is **not** protected, so nothing merges automatically; the risk is
that a human (or agent) reading that check list sees a green *required browser
check* and concludes browser coverage passed. `CLAUDE.md` states *"A lane that
does not apply is reported skipped, which satisfies branch protection"* — so if
protection is ever enabled, this becomes a mechanical bypass as well.

---

## 13. Fix implemented

One file, additive only: **`.github/workflows/ci.yml`**, job `browser-e2e`.

* Adds `CHANGES_RESULT: ${{ needs.changes.result }}` to the step env.
* Fails closed when the gate did not succeed, before any output-derived logic:

```bash
if [ "${CHANGES_RESULT:-}" != "success" ]; then
  echo "::error::changed-path detection did not succeed (result: ...) — browser coverage cannot be proven unnecessary, so this required check fails closed"
  exit 1
fi
```

This satisfies the conservative rule: **uncertain classification must mean more
checks, never fewer.** Nothing else changed — no timeout, no concurrency, no
classifier, no runner label, no action version.

### Behavioural proof (no CI spend)

The old and new aggregator scripts were extracted from both revisions of
`ci.yml` and executed directly across the full decision table:

| Scenario | OLD | NEW | Intended |
|---|---|---|---|
| gate **cancelled**, shards skipped *(the 2026-08-06 case)* | **PASS** | **FAIL** | FAIL |
| gate **failure**, shards skipped | **PASS** | **FAIL** | FAIL |
| gate **skipped**, shards skipped | **PASS** | **FAIL** | FAIL |
| gate result **missing**, shards skipped | **PASS** | **FAIL** | FAIL |
| gate ok, not required, shards skipped | PASS | PASS | PASS |
| gate ok, required, shards success | PASS | PASS | PASS |
| gate ok, required, shards skipped | FAIL | FAIL | FAIL |
| gate ok, required, shards cancelled | FAIL | FAIL | FAIL |
| gate ok, required, shards failure | FAIL | FAIL | FAIL |
| gate ok, required, shard result missing | FAIL | FAIL | FAIL |
| gate ok, not required, shard result missing | PASS | PASS | PASS |
| gate ok, full matrix, 4 shards success | PASS | PASS | PASS |
| gate ok, extended but 1 shard declared | FAIL | FAIL | FAIL |

**The four fail-open scenarios flip from PASS to FAIL; all nine
gate-success scenarios are unchanged.** 0 mismatches against intent.

> An earlier version of this harness was **vacuous** — a field-count bug left
> `SHARDS="FAIL"`, so the OLD script died on malformed JSON rather than on its
> logic, making the four critical rows look correct for the wrong reason. The
> table above is from the corrected harness.

### Regression pin (closes the review's P2)

`tests/ci/aggregate-fail-closed.test.ts` **executes** the aggregate script
mechanically extracted from `.github/workflows/ci.yml` — it is never a
reimplementation, because a hand-written copy would drift from the workflow
silently, which is the exact class of bug this file guards against. The extractor
self-verifies (throws if the block is short or missing known markers) so the
suite can never pass against nothing.

It pins both halves: a gate result of `cancelled` / `failure` / `skipped` /
empty must fail the required check, and every gate-success path must behave
exactly as before.

**Negative control (mandatory, performed):** deleting the guard from
`ci.yml` turned **7 of 17** tests red — the decisive ones reporting exit code
`0` where `1` was required, i.e. the fail-open reproduced — while the 10
gate-success tests stayed green, proving the file detects the missing guard
specifically rather than being globally broken. The workflow was then restored
**byte-identically** (sha256 `5b16796592…` before and after) and all 17 pass.

### Other validation

* YAML parses (8 jobs; `browser-e2e` retains `needs: [changes,
  browser-e2e-shard]`, `if: always()`, `timeout-minutes: 2`).
* `npx vitest run tests/ci/` → **89 passed / 3 files** (includes
  `ci-config.test.ts`, which pins the aggregator's shape and required-check
  names).
* `git diff --check` → clean. The **workflow-code** change is 1 file, **+32 / −0** (`.github/workflows/ci.yml`). The commit as a whole also adds this audit record and the regression test that pins the contract, so the PR diff is larger — derive it from `git diff --numstat origin/claude/build-hone-saas-hOex7...HEAD` rather than from this line.
* Classifier outputs verified unchanged for representative diffs — docs-only,
  application, migration, browser spec, payment, Google, mobile — and
  `.github/workflows/ci.yml` correctly yields `full_matrix_required=true`.

---

## 14. Diagnostic runs performed

**None.** Budget was 2; **0 were used.**

A reproduction run was judged unnecessary and actively unhelpful: the mechanism
is already established from the official incident (which explicitly describes
queued jobs timing out), from job telemetry showing no runner and zero steps, and
from a direct behavioural proof of the aggregator. Dispatching CI during an
active **critical, unresolved** Actions incident would most likely have consumed
another ~15 minutes to reproduce a known-external symptom.

Note: opening the fix PR itself triggers `pull_request` CI. That is the normal
consequence of the change, not a diagnostic run — and because the diff touches
`.github/workflows/**`, the classifier requires the **full matrix**, which will
very likely be delayed or cancelled while the incident persists.

---

## 15. Risks and rollback

* **Risk:** the aggregator now fails when the gate is cancelled — including when
  cancellation is legitimate supersession (`cancel-in-progress`). A superseded
  run will show a red required check instead of a misleading green one. This is
  the intended trade: a superseded run's verdict is meaningless either way, and
  the newer run supplies the real one.
* **Risk:** during an Actions incident, PRs will now go **red** rather than
  falsely green. That is the point.
* **No risk** to normal operation — all nine gate-success paths are byte-identical.
* **Rollback:** revert the single commit. No state, no migration, no data.

---

## 16. Safely rerunning #517 and #518

1. **Wait for <https://stspg.io/rcz3fcm83sff> to reach `resolved`.** Rerunning
   while `Actions` is in `major_outage` reproduces the same 15-minute expiry.
2. Confirm the component is green:
   `curl -s https://www.githubstatus.com/api/v2/components.json | grep -A2 '"Actions"'`
3. Rerun **once** per PR, at the exact existing head, to learn whether runners
   are being assigned again:
   `gh run rerun 31118347711 --failed` · `gh run rerun 31120309970 --failed`

   ⚠️ **Such a rerun is a liveness probe, NEVER final merge evidence.** A rerun
   replays the workflow definition bound to that run's original SHA / ref /
   workflow context. #517's and #518's heads predate this fix, so their reruns
   execute the OLD aggregate and therefore do **not** acquire the fail-closed
   guard — if the gate starves again, the old aggregate still reports the
   required check green with zero tests run. Final evidence for either feature
   must come from a **fresh head and a new run created after that branch is
   rebased/updated onto production containing this fix.**
4. Use one watcher per PR; do not poll in parallel (CLAUDE.md §4).

Do not rerun repeatedly during the incident. Two attempts on #517 already
consumed ~30 minutes of wall-clock for zero executed steps.

---

## 17. Conditions required before merging either feature

* The Actions incident resolved, and a rerun that **actually executes** — every
  required job showing a `runner_name` and non-zero `steps`.
* **#518 in particular must be re-evaluated from scratch.** Its currently green
  `browser e2e (local stack)` is the fail-open described in §11–12 and is
  **not** evidence of anything. Treat that PR as untested until a run with a real
  runner reports on it.
* This CI fix must merge first, and each feature branch must then be updated
  onto a production commit that contains it. Merging the fix alone changes
  nothing for an existing #517/#518 head: those runs are pinned to their own
  SHA's workflow, so only a NEW head produces a run judged by a gate that
  cannot go green without running.
* #517's own local verification is already complete (7,786 unit; 1,540 DB on a
  fresh 0171 stack; 235 browser, 0 failed; payment 51; Google 13; mobile 6;
  35/35 negative controls; typecheck, lint, build, `verify:prepush` clean) — but
  local evidence is not a substitute for CI.

---

## 18. Remaining uncertainties

1. **Billing/quota is unverified**, not disproven — the token lacks the `user`
   scope. The public-repository argument is strong but is inference.
2. **The exact 902 s expiry is not documented by GitHub** as a published queue
   limit. It is highly consistent (902/902/903 s across three independent jobs)
   and matches the incident text, but the precise mechanism is GitHub-internal
   and cannot be proven from outside.
3. **Why one job was served at 16:50:31 while others were not** is not
   determinable from available data — consistent with the partial, intermittent
   degradation the incident describes.
4. **The incident was unresolved at the time of writing**, so no post-incident
   root-cause analysis from GitHub is available yet.
5. **SEPARATE FOLLOW-UP, deliberately NOT fixed here (P3).**
   `scripts/ci-plan.mjs:114` prints `EXTENDED (all specs, 2 shards)` while the
   machine plan emits `browser_shards=[1,2,3,4]`; the stale "two separate jobs"
   wording also survives in the `ci.yml:113-115` comment. Both appeared in this
   PR's own gate log (run 31123533948, job 92721276082, 23:33:53) directly above
   `browser_shards=[1,2,3,4]`. It is display-only — the aggregate asserts
   `EXPECTED -ne 4` against the machine value, so no behaviour depends on the
   printed text — but it is an active trap for anyone auditing CI evidence.
   Widening this PR to fix it would mix an unrelated change into a required-check
   contract fix, so it is recorded here for its own change instead.

6. **Other lanes still report `skipped` when the gate dies.** This fix hardens
   the designated required check only. If branch protection is enabled later,
   the required-check list must be reviewed — a skipped job satisfies protection,
   so `browser e2e (local stack)` must remain the gate that everything else is
   judged through.
