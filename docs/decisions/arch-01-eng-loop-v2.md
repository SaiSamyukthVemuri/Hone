# ARCH-01 — ENG-LOOP V2: one evidence boundary, a pure decision engine, human merge authority

| Field | Value |
|---|---|
| **Decision** | ENG-LOOP V2 is built as an **evidence adapter** (05A: GitHub → `Evidence` \| `UNKNOWN(reason)`), a **pure decision engine** (05B: `Evidence` → `Decision`) and an **advisory shepherd CLI** with a shadow ledger (05C). Raw GitHub data crosses exactly one validation boundary. The human keeps merge authority. |
| **Date** | 2026-10-06 |
| **Status** | **PROPOSED** in the ARCH-01 pull request; **ACCEPTED** when merged. |
| **Decided by** | Sam (operator): the ENG-LOOP V2 architecture contract, including the two-channel Codex evidence decision (§17). |
| **archVersion** | `ARCH-01` |
| **Scope** | ENG-LOOP-05A, 05B and 05C, and every later ENG-LOOP component (06 bounded actions, 02 watcher). Standing law: ENGINEERING_STANDARDS §8. |
| **Supersedes** | The ENG-LOOP-01/03/04 implementations — PRs #795, #798 and #799 — which stay frozen as draft **evidence** branches (§27). |
| **Enforced by** | ENGINEERING_STANDARDS §8 now; the 05A/05B guard tests (§25), test law (§26) and fixture corpus (§22) when those lanes land. |
| **Authored at** | production `7134239097908a8780aef7fd8fe9b3505d0f4ae0` (#788). Every pinned value below was read from the live GitHub API on 2026-10-05/06. |

> **Normative.** Where an implementation and this document disagree, the implementation is wrong. A change to these
> semantics is proposed, reviewed and merged **here first** (§35); semantics never evolve through review-repair rounds.

---

## 1. Goal

```
human defines intent and retains judgment
        ↓
agents implement / test / review / repair / reconcile
        ↓
system prepares a release-clean candidate
        ↓
human retains production merge authority
```

ENG-LOOP is **not** an autonomous merge system. This is CANONICAL_ROADMAP §16.2 (*Phase 1: Sam merges all PRs*). 05A, 05B and
05C are **observation-only** reporting under §16.5's observation clause. ENG-LOOP-06 (bounded actions) is an authority
component: it needs §16.5's three re-entry conditions **and** the shadow gate (§33) — neither substitutes for the other.

## 2. Root cause learned from #795 / #798 / #799

- raw GitHub representation leaked into decision logic;
- fail-closed became negative enumeration over an open domain;
- increasingly broad raw JS helper contracts allowed impossible shapes;
- #798 and #799 over-modelled GitHub run history and snapshot reconciliation;
- "latest execution" was reconstructed although GitHub already exposes each run's **current** state;
- temporal ordering brought timestamp, run-id and attempt complexity that the question never needed.

We keep the invariants, not the implementation. **Retired premise:** ENG-LOOP reconstructs "latest execution". V2 reads
each designated run's current state and never orders runs (§8).

## 3. Evidence-boundary law

Raw external GitHub data crosses **exactly one** strict validation / normalization boundary: `collect()` (05A).
Downstream ENG-LOOP logic receives only **`Evidence`** or **`UNKNOWN(reason)`**. There is **no partial trusted Evidence**.

Downstream decision code never interprets: raw REST or GraphQL payloads, workflow path representation, arbitrary
comments, pagination details, sparse arrays, `undefined`, malformed dates, timestamp precision, raw `run_attempt`
semantics, raw check-suite representation, or any GitHub API quirk.

Ambiguous or unrecognized **required** evidence → `UNKNOWN(reason)` for the whole snapshot (§15).

## 4. Components

```
collect(pr, policy, github)  →  Evidence | Unknown(reason)          (05A)
decide(evidence, policy)     →  Decision                             (05B)
shepherd CLI                 →  renders and records the advisory outcome (05C)
```

`decide()` is called **only** with valid `Evidence`; collection failure returns `Unknown` before 05B runs. `UNKNOWN` is
**not** a member of `Decision`. The shepherd and the ledger record an outcome union:

```ts
type ObservationOutcome =
  | { kind: "decision"; decision: Decision }
  | { kind: "unknown"; reason: UnknownReason };
```

Later, separately and **not** in 05A/05B/05C: the **orchestrator** and the **watcher** (ENG-LOOP-06, ENG-LOOP-02).

## 5. 05A — evidence adapter

05A owns GitHub → validated normalized facts → `Evidence | UNKNOWN`. It knows GitHub. It makes **no** release or
readiness decision and has no decision vocabulary (§25).

### 5.1 Required reads — the only sources of truth

| Fact | Source | Keyed by |
|---|---|---|
| PR number, state, draft, base, head; review objects; PR issue comments; review threads; external contexts | **one GraphQL snapshot** (§15), every page | PR number |
| Production head | REST `git/ref/heads/<configured production ref>` | the configured ref (§13) |
| Drift | REST `compare/{production_head}...{H}` | `H` = the snapshot's head (§14, §16) |
| CI runs | REST `actions/workflows/ci.yml/runs?head_sha={H}&event=pull_request`, every page | `H` = the snapshot's head (§8, §9, §16) |

Every read is a **read**. 05A never writes to GitHub.

## 6. 05B — pure decision engine

05B receives only normalized `Evidence` and policy. It knows **nothing** about REST vs GraphQL, GitHub URLs, workflow
paths, `statusCheckRollup` structure, `checkSuite.app.slug`, timestamp or `run_attempt` parsing, pagination, raw review
or check JSON, or compare syntax. It implements only the precedence law (§7).

## 7. Advisory decision precedence

`decide(E, P)` is total and deterministic. The **first** row that holds is the decision:

| # | Condition over `Evidence` E and policy P | Decision |
|---|---|---|
| 1 | `E.pr.state` ≠ `OPEN` | `NOT_OPEN` |
| 2 | `E.pr.draft` | `DRAFT_HOLD` |
| 3 | `E.production.behindBy > 0` | `NEEDS_REFRESH` |
| 4 | any CI run outcome is `FAILED` | `CI_FAILED` |
| 5 | any external context is `failure` | `EXTERNAL_BLOCKED` |
| 6 | there are **zero** designated CI runs | `CI_NOT_STARTED` |
| 7 | any CI run outcome is `PENDING` | `CI_PENDING` |
| 8 | any external context is `pending` | `EXTERNAL_PENDING` |
| 9 | not `TRUSTED_REVIEW_AT_HEAD` (§17) | `REVIEW_MISSING` |
| 10 | `FINDINGS_OPEN` (§18, §19) | `FINDINGS_OPEN` |
| 11 | otherwise | `CANDIDATE_READY_FOR_HUMAN_REVIEW` |

`CANDIDATE_READY_FOR_HUMAN_REVIEW` is **advisory only**. The human retains merge authority.

## 8. Run selection rule

**Designated runs** for head `H` are exactly the runs the configured workflow endpoint returns for `head_sha=H` and
`event=pull_request` (§9): the endpoint ∩ the exact head ∩ the authoritative event. Push-event runs at the same sha are
**not** designated. No other event is authoritative unless policy is explicitly changed (§32).

Default policy: **`ALL_DESIGNATED_RUNS`** — every designated run must be completed with conclusion `success`.

Each run's **current** state is normalized by a closed table (05A):

| Run `status` | Run `conclusion` | Normalized outcome |
|---|---|---|
| `completed` | `success` | `SUCCEEDED` |
| `completed` | `failure`, `cancelled`, `timed_out`, `action_required`, `neutral`, `skipped`, `stale`, `startup_failure` | `FAILED` |
| `completed` | any other string | `UNKNOWN(unrecognized_ci_conclusion)` |
| `completed` | `null` or not a string | `UNKNOWN(malformed)` |
| `queued`, `in_progress`, `waiting`, `requested`, `pending` | (any) | `PENDING` |
| any other status | (any) | `UNKNOWN(unrecognized_ci_status)` |

Then (05B): any `FAILED` → `CI_FAILED`; zero runs → `CI_NOT_STARTED`; any `PENDING` → `CI_PENDING`; all `SUCCEEDED` →
CI acceptable — in §7's order.

**No timestamp ordering. No run-id ordering. No `run_attempt` ordering. No inferred "latest execution."** A re-run keeps
its run id, and the run's current state already reflects its latest attempt; `run_attempt` is never read for a decision.

**The only permitted future relaxation — `LATEST_CREATED`:** OFF by default; enabled only after shadow evidence shows
false blocking caused by legitimate duplicate runs at one head; defined solely as *the designated run with the highest
`run_number`*. Enabling it is a policy change (new `policyHash`, §32). No other ordering field may be introduced without
an architecture change (§35).

## 9. CI source of truth

GitHub Actions CI state comes **only** from REST, for the configured designated workflow and the exact head:

```
GET /repos/{owner}/{repo}/actions/workflows/ci.yml/runs?head_sha=<H>&event=pull_request
```

Every page is read; the stated `total_count` must equal the number of runs collected (else `UNKNOWN(incomplete)`). Every
returned run must carry `head_sha == H` and `event == pull_request` (else `UNKNOWN(malformed)`).

`statusCheckRollup` is **not** authoritative for Actions CI. It is read only for external contexts (§10).

## 10. External context domain

External contexts are the head commit's `statusCheckRollup.contexts` (every page), restricted to:

- every `StatusContext`; and
- every `CheckRun` whose check suite's app is **not** GitHub Actions (§12).

GitHub Actions `CheckRun`s in the rollup are ignored for the external domain — the Actions domain is §9's — which
prevents double-counting. The rollup's own aggregate `state` is never read.

## 11. External context collapse table

Normalized external state is exactly `{ pending, success, failure }`.

| Source | Value | Normalized |
|---|---|---|
| `StatusContext.state` | `SUCCESS` | `success` |
| | `PENDING`, `EXPECTED` | `pending` |
| | `ERROR`, `FAILURE` | `failure` |
| non-Actions `CheckRun` | `status` ≠ `COMPLETED` | `pending` |
| | `COMPLETED` + `SUCCESS`, `NEUTRAL`, `SKIPPED` | `success` |
| | `COMPLETED` + `FAILURE`, `CANCELLED`, `TIMED_OUT`, `ACTION_REQUIRED`, `STARTUP_FAILURE`, `STALE` | `failure` |

Any value outside these closed enums → `UNKNOWN(unrecognized_context_state)` for the **whole** snapshot. No context-name
heuristics.

External checks are **negative-only**: `success` is inert; `pending` may hold; `failure` may block. External success can
**never** grant candidacy.

## 12. Actions discriminator

A `CheckRun` belongs to GitHub Actions **iff** `checkSuite.app.slug == "github-actions"`. That is the only
discriminator. Never classify by check name, workflow name, context name, `detailsUrl` or naming convention. A `CheckRun`
without a readable `checkSuite.app.slug` cannot be classified → `UNKNOWN(malformed)`.

## 13. Production ref

Production is **explicit configuration**: `claude/build-hone-saas-hOex7`. Never infer it from the repository default
branch, `defaultBranchRef`, the latest deployment or PR heuristics.

If the PR's base ≠ the configured production ref → `UNKNOWN(wrong_base)`.

## 14. Compare direction

Drift comparison is frozen as `compare/{production_head}...{pr_head}` — **base** = the production head, **head** = the
exact PR head. Refresh predicate: `behind_by > 0` → `NEEDS_REFRESH`. `ahead_by` may be recorded and **never** drives a
decision. Swapping the direction is an implementation defect.

## 15. Snapshot consistency

`collect()` produces **one** internally consistent snapshot, or `UNKNOWN`.

- **Head assertion:** the GraphQL snapshot's `headRefOid` must equal `commits(last: 1)`'s `oid`. Every page of the
  snapshot query re-reads `headRefOid`, and every page must agree with the first.
- **On a head mismatch:** (1) discard the partial collection; (2) re-read once; (3) a second mismatch →
  `UNKNOWN(head_moved)`. No loop.
- **Completeness:** every paginated connection is read to its last page; a stated `totalCount` that disagrees with what
  was collected, or that changes between pages → `UNKNOWN(incomplete)`.
- **Any** required read, parse or authorization failure → the whole snapshot is `UNKNOWN(reason)`. No partial Evidence.

## 16. Head-keyed REST reads

Every revision-specific REST read is keyed by the **head oid from the GraphQL snapshot** — workflow runs
(`head_sha=<H>`) and compare (`<production_head>...<H>`) — never by a moving branch name, the PR number, or an
independently discovered "latest" sha. If the branch moves after collection, the result is a stale but internally
consistent snapshot about the old immutable head; that is acceptable. **Two heads are never mixed in one snapshot.**
Rendered output always names the exact sha it describes.

## 17. Trusted Codex artifact at head

`TRUSTED_REVIEW_AT_HEAD` is satisfied by **either** of two explicit artifact forms. Live evidence (2026-10-05): every
**clean** Codex verdict is a PR **issue comment** — 21 of 21 across 12 PRs (#782–#797), none a review object — while
every **findings** verdict is a PR **review object**, all state `COMMENTED`. ARCH-01 models both channels rather than
forcing both through a review object.

### A. Findings / PR-review artifact

A GitHub PR **review object** where **all** hold:

- the actor's numeric id is in the trusted Codex allowlist (§20);
- the actor's account type is `Bot`;
- `review.commit_id` == the exact PR head;
- `review.state` ∈ { `COMMENTED`, `APPROVED`, `CHANGES_REQUESTED` } — `DISMISSED` and `PENDING` never count;
- the body satisfies the Reviewed-commit marker policy (§17b), and the marker identifies the exact current head.

`CHANGES_REQUESTED` additionally forces `FINDINGS_OPEN` (§18). The trusted-thread rules (§19) still apply.

### B. Clean / issue-comment artifact

A GitHub PR **issue comment** where **all** hold:

- the actor's numeric id is in the trusted Codex allowlist (§20);
- the actor's account type is `Bot`;
- the body satisfies the configured **clean verdict pattern** (§17b);
- the body satisfies the Reviewed-commit marker policy (§17b), and the marker identifies the exact current head.

It counts as `TRUSTED_REVIEW_AT_HEAD` although GitHub exposes no review object or `commit_id` for a clean verdict.
It does **not** clear `FINDINGS_OPEN`: a clean comment at head plus an unresolved trusted finding remains
`FINDINGS_OPEN`.

### Not artifacts

Nothing else is a Codex artifact: no reaction (see §41), no inline review comment, no `codex-pull-request-review-summary`
status comment, no review object with an empty body, and no body from any actor outside the allowlist — whatever its text.

### Authority law

Text is **necessary but never sufficient**. A body match from an untrusted actor is inert. Authority comes from:

```
trusted numeric actor id  +  expected account type  +  accepted artifact channel
                          +  exact-head binding     +  configured marker / verdict shape
```

Login spelling is never authority.

## 17b. Marker policy — current default

The **Reviewed-commit marker** (policy value) is exactly the observed form:

```
**Reviewed commit:** `<10 lowercase hex>`
```

- the body contains this marker **exactly once** — zero or several occurrences → the artifact does not qualify;
- the captured 10 hex must equal the **first 10 characters** of the exact 40-hex PR head;
- for channel A it must also agree with `review.commit_id`, which must equal the head.

The default is deliberately narrow: not "any 7–40 hex". Evidence (2026-10-05): all 21 real clean artifacts and all 27
non-empty real findings artifacts carry exactly one 10-lowercase-hex marker; on every findings artifact it equals
`commit_id[0:10]`.

The **clean verdict pattern** (policy value): the body **begins** with the exact text
`Codex Review: Didn't find any major issues.` (ASCII apostrophe). The cheer phrase that follows varies and is ignored. All
21 real clean artifacts match it, and no real findings body does.

If Codex changes either representation, the current policy fails closed to `REVIEW_MISSING`; the policy is updated
deliberately; the `policyHash` changes; a new measurement series begins (§32).

## 18. CHANGES_REQUESTED

A trusted exact-head channel-A review with state `CHANGES_REQUESTED` counts as review-present **and** forces
`FINDINGS_OPEN`, even with zero unresolved threads. This keeps a stricter verdict from degrading into `REVIEW_MISSING` and
a review-request loop.

## 19. FINDINGS_OPEN

`FINDINGS_OPEN` holds when a trusted channel-A review at head has state `CHANGES_REQUESTED` (§18), **or** when **any**
review thread:

- was opened by a trusted reviewer — its first comment's author is a numeric id in the trusted Codex allowlist, with type
  `Bot`; **and**
- is unresolved, **or** was resolved by an account that is not in the human-resolver allowlist (numeric id **and** type
  `User`, §20).

This applies regardless of which historical head raised the thread, its outdated status, or any severity label. Severity
badges (P0–P3) may later be routing metadata; they **never** participate in readiness. A clean issue-comment artifact
never clears it.

## 20. Actor identity

Authority is the **numeric GitHub actor id plus the expected account type**. Logins are display-only: never authorize on
`chatgpt-codex-connector`, `chatgpt-codex-connector[bot]` or any other spelling. The same rule applies to human resolvers.

| Role | Numeric id | Type | Evidence (2026-10-05) |
|---|---|---|---|
| Trusted Codex reviewer | `199175422` | `Bot` | REST `users/chatgpt-codex-connector[bot]` → `199175422`, `Bot`; GraphQL `Bot.databaseId` on #799's reviews and threads → `199175422` |
| Human resolver | `26781116` | `User` | REST `users/SaiSamyukthVemuri` → `26781116`, `User`; GraphQL `resolvedBy.databaseId` on #799's resolved threads → `26781116` |

## 21. Codex review marker — behaviour

The marker and the clean verdict pattern are **policy values** (§32), never hard-coded implementation strings.

A trusted actor at the exact head with an accepted state or channel but **no qualifying marker**: the artifact does not
qualify → `REVIEW_MISSING` if no other artifact qualifies. It neither creates a finding nor grants readiness.

Later orchestrator behaviour (not 05A/05B/05C): request a review **at most once per head**; if it is still missing after
that → `ESCALATE`. No review-request loop.

## 22. Codex artifact fixtures

The recorded, redacted fixture corpus (05A) must contain at least these **real** artifacts (Appendix A):

| Form | Artifact | Head |
|---|---|---|
| **Clean** — issue comment (channel B) | #788 issue comment `6005578488` | `d9b18a35d9b6aafc27ab3159fc38361db3068336` |
| **Findings** — review object (channel A) | #799 review `5421736650`, state `COMMENTED` | `52d5daadcd7e2e1c215d7e9c681ac2cc259bb259` |

The configured marker and clean pattern must accept **both**; 05A's fixture tests fail if either is rejected, and they must
prove each channel binds its artifact to the correct head. Fixture acceptance never grants trust by itself — trust still
needs the numeric id, the account type, the exact head, an accepted channel and state, and the marker.

Required negative fixtures, each proven inert or not-current:

- the clean text from an untrusted actor → inert;
- a trusted clean comment for a stale head → not current;
- a findings review for a stale head → not current;
- a marker near-miss (a different hex, 7 or 40 hex, upper case, two markers) → not current;
- a trusted clean comment does **not** clear an unresolved trusted thread;
- the real empty-body Codex review (#795 review `5419722295`) → not an artifact.

## 23. Workflow membership

The workflow **endpoint selects membership**. V2 never fetches arbitrary repository runs and decides which belong.

`workflow_id` is kept as fixture evidence, a consistency assertion and an anti-drift check: every returned designated run
must carry the policy's expected workflow id, `289443461` (live `GET actions/workflows/ci.yml` on 2026-10-05). A mismatch →
`UNKNOWN(workflow_identity_mismatch)`. `workflow_id` is **never** used to select from arbitrary runs, to order runs or to
establish recency. `path` is display/debug metadata only: no matching on it, in any form (#798's `ci.yml@main` lesson).

## 24. Minimal normalized Evidence model

Immutable, constructed only by 05A through validating constructors (`Sha` is exactly 40 lowercase hex):

```ts
interface Evidence {
  readonly pr: { number: number; head: Sha; state: "OPEN" | "CLOSED" | "MERGED"; draft: boolean; base: string };
  readonly production: { ref: string; head: Sha; behindBy: number; aheadBy: number /* metadata */ };
  readonly ci: {
    readonly workflowId: number;
    readonly runs: ReadonlyArray<{ outcome: "SUCCEEDED" | "FAILED" | "PENDING"; runNumber: number /* metadata */ }>;
  };
  readonly external: ReadonlyArray<{ source: string /* display */; state: "pending" | "success" | "failure" }>;
  readonly reviews: ReadonlyArray<{
    channel: "PR_REVIEW" | "CLEAN_COMMENT";
    actor: { id: number; type: string };
    verdict: "COMMENTED" | "APPROVED" | "CHANGES_REQUESTED" | "DISMISSED" | "PENDING" | "CLEAN";
    // Validated construction: the head binding and the marker policy hold for the exact head
    // (A: commit_id == head and the single marker == head[0:10]; B: the clean pattern and the single
    // marker == head[0:10]). The actor and the state are NOT folded in: 05B checks them against policy.
    qualifiesAtHead: boolean;
  }>;
  readonly threads: ReadonlyArray<{
    opener: { id: number; type: string };
    resolved: boolean;
    resolver: { id: number; type: string } | null;
    outdated: boolean; // metadata, never readiness authority
  }>;
  readonly capturedAt: string; // may be recorded; decide() never reads it
}
```

`TRUSTED_REVIEW_AT_HEAD` (05B) ⇔ some review has `qualifiesAtHead`, an actor in the trusted allowlist with type `Bot`,
and verdict `COMMENTED`, `APPROVED` or `CHANGES_REQUESTED` (channel A) or `CLEAN` (channel B). 05A computes
`qualifiesAtHead`; 05B never sees a marker, a body or a `commit_id`.

## 25. 05A / 05B mechanical module boundary

Enforced by **build-failing** guard tests. V2 lives under `scripts/eng/v2/`, apart from the shipped CP-005a `status`
modules in `scripts/eng/` (including `scripts/eng/evidence.mjs`), which V2 neither imports nor changes.

| | 05A — `scripts/eng/v2/adapter/` | 05B — `scripts/eng/v2/decision/` |
|---|---|---|
| Public surface | `collect(...)`, `Evidence`, `Unknown(reason)`, the normalized fact types, the collection-policy types — through `scripts/eng/v2/adapter/index.mjs` only | `Decision` and its state vocabulary, `decide()` — through `scripts/eng/v2/decision/index.mjs` |
| Private | everything under `scripts/eng/v2/adapter/internal/` | — |
| Must not | define `Decision`, import 05B, name any §7 decision state, contain `decide()`, encode readiness precedence | import a GitHub REST or GraphQL client, raw response schemas, JSON parsers, endpoint helpers, compare, workflow, review or `statusCheckRollup` parsers, or anything under `scripts/eng/v2/adapter/internal/` |

Permitted direction, never reversed:

```
raw GitHub  →  05A internals  →  normalized Evidence contract  →  05B
```

**Guard test A:** 05A cannot import or name 05B decision concepts. **Guard test B:** 05B cannot import raw or adapter
internals. A violation fails CI.

## 26. Test law

**Adapter domain (05A):** raw response strings and realistic API payloads → `Evidence | Unknown`. It never throws; the
schema is strict and positive; unknown enums, truncated bodies, malformed bodies and missing required fields → `UNKNOWN`.
Use mutated **realistic** GitHub responses, not impossible GitHub histories.

**Core domain (05B):** valid normalized `Evidence` → a deterministic `Decision`. It is total and deterministic;
permutation-invariant wherever array order is semantically irrelevant (runs, external contexts, reviews, threads);
`Unknown` never reaches candidacy; a stale review is inert; an untrusted actor is inert; external success is inert;
explicit failures dominate according to §7; irrelevant evidence cannot change the state.

The independent falsifier inherits #799's lessons (§27): permutation invariance, malformed boundary inputs, and the
no-throw boundary.

## 27. Historical salvage

| Branch | Lane, frozen head | Open findings | Disposition |
|---|---|---|---|
| **#795** | ENG-LOOP-01, `555d200615` | P1 4188450896 (ref-qualified workflow path) | **Keep:** the single-shot CLI concept, the observation-only posture, advisory candidacy, the exact-head law, stop laws, the external-negative-only rule, the trusted-actor concept. **Rewrite:** trusted actors against numeric ids and normalized evidence. **Delete:** workflow-path selection, latest-applicable-run reconstruction, review-request inference. **Defer:** watch behaviour (ENG-LOOP-02). |
| **#798** | ENG-LOOP-03, `314f118f78` | P2 4189402172 (order-dependent snapshot reconciliation) | **Keep, as fixtures:** the workflow-identity lessons, the `@main` path fixture, documented event and schema knowledge. **Delete:** run-id recency, cross-run attempt comparison, `run_started_at` selection, pairwise reconciliation. |
| **#799** | ENG-LOOP-04, `52d5daadcd` | P2 4189779531, P2 4189779535 | **Delete from production design:** the snapshot canonicalization system, calendar validation, dense-array defensive decision helpers, fractional-timestamp ordering. **Move to the falsifier:** permutation invariance, malformed boundary inputs, the no-throw boundary. |

#795, #798 and #799 remain historical evidence branches. **Do not rehabilitate them as implementation PRs.**

## 28. Shadow ledger

Every shadow observation records:

```ts
{ pr, head, evidenceHash, outcome: ObservationOutcome, policyHash, archVersion, capturedAt }
```

`evidenceHash` is the SHA-256 of the canonical JSON (sorted keys, no whitespace) of the `Evidence` for a decision outcome,
and of `{ pr, head, unknown: reason }` for an unknown outcome (`head` is `null` when it could not be read). Unknown outcomes
are persisted with all fields and take part in transitions and time-in-state reporting.

## 29. false_ready

Computed mechanically over **decision** outcomes only (unknown rows are skipped). `false_ready` exists when
`CANDIDATE_READY_FOR_HUMAN_REVIEW` at exact head `H` is followed by a later decision **at the same head** `H` of
`CI_FAILED`, `EXTERNAL_BLOCKED`, `FINDINGS_OPEN` or `REVIEW_MISSING`. `NEEDS_REFRESH` after candidacy at the same head is
**not** `false_ready` — production may move after a valid candidate decision. No manual classification participates.

## 30. false_block

Computed mechanically over **decision** outcomes only. `false_block` exists when the **last decision** at exact head `H`
is `CI_FAILED`, `EXTERNAL_BLOCKED`, `FINDINGS_OPEN`, `REVIEW_MISSING` or `CI_NOT_STARTED`, **and** GitHub later records
the PR as merged with merged head == `H`. Every `false_block` is surfaced automatically as `{ pr, head, lastDecision }` for
policy review. A `false_block` **never** weakens 05B policy automatically.

## 31. human_override

Reported, not gating. `human_override` exists when the PR merged at `H` and **no** `CANDIDATE_READY_FOR_HUMAN_REVIEW`
decision was ever recorded at `H`. It may overlap `false_block`; they answer different questions.

## 32. Policy versioning

The policy, and `policyHash` over a canonical serialization of **every** value that can affect evidence or decision
semantics, includes at least:

| Policy value | Current value |
|---|---|
| production ref | `claude/build-hone-saas-hOex7` |
| authoritative workflow, expected workflow id | `.github/workflows/ci.yml`, `289443461` |
| authoritative event | `pull_request` |
| CI run-selection mode | `ALL_DESIGNATED_RUNS` (`LATEST_CREATED` off) |
| trusted Codex reviewers (id, type) | `199175422`, `Bot` |
| human resolvers (id, type) | `26781116`, `User` |
| accepted channel-A review states | `COMMENTED`, `APPROVED`, `CHANGES_REQUESTED` |
| Reviewed-commit marker | §17b: the literal `**Reviewed commit:**` then 10 lowercase hex in backticks; exactly once; equal to the head's first 10 hex |
| clean verdict pattern | body begins `Codex Review: Didn't find any major issues.` |

Any later decision-affecting value joins this table and the hash. A policy change → a new `policyHash` → a new
measurement series; historical entries remain, but old-policy outcomes neither count for nor against the current gate.
`archVersion` identifies this contract (`ARCH-01`); an architecture-semantic change → a new `archVersion` and, as
appropriate, a fresh measurement series.

## 33. Shadow gate metrics

**Formal and automatic** (only automatically reproducible metrics take part in the gate): `false_ready`, `false_block`,
`production_refresh_count`, decision transitions, `time_in_state`, `time_to_candidate_ready`, mechanically identifiable
unnecessary CI re-runs. All are computed per `policyHash` (§32).

**Manual / contextual** (may be collected; missing tags never block graduation): human touches, review rounds,
qualitative interventions, operator rationale.

Minimum safety condition before any bounded action authority: **`false_ready == 0`**, and every `false_block` surfaced and
reviewed individually. ARCH-01 sets no sample-size or time threshold without evidence. Meeting the gate is necessary for
ENG-LOOP-06, not sufficient: CANONICAL_ROADMAP §16.5 still applies.

## 34. Delivery sequence

```
ARCH-01         architecture + ENGINEERING_STANDARDS §8
   ↓
ENG-LOOP-05A    GitHub → Evidence | Unknown            (no decisions)
   ↓
ENG-LOOP-05B    Evidence → Decision                    (no GitHub knowledge)
   ↓
ENG-LOOP-05C    shepherd CLI + shadow ledger
   ↓
real-PR shadow period → automatic metrics gate (§33)
   ↓
ENG-LOOP-06     bounded actions                        (also §16.5)
   ↓
ENG-LOOP-02     watcher
```

05A does not start until ARCH-01 is merged.

## 35. Policy-change rule for 05A / 05B

05A and 05B do not redefine this architecture. A finding that means *"the code violates ARCH-01"* → fix the
implementation. A proposed fix that means *"ARCH-01's semantics must change"* → **stop** implementation, return to
architecture, amend and review this document, then resume. Architecture never evolves implicitly through review-repair
rounds.

## 36. ARCH-01 review budget

**Round 1:** one legitimate semantic architecture finding may be verified and repaired (this document and, where normative
law changes, ENGINEERING_STANDARDS), followed by a fresh exact-head review.

**Round 2:** another legitimate semantic finding in the **same** architecture family → **stop**; no third semantic patch;
return to architecture discussion. Families: CI authority, run semantics, review authority, production drift, the evidence
boundary, external-check semantics, shadow metrics, 05A/05B separation.

Pure prose, formatting, typo or non-normative feedback does not consume the semantic budget and may be deferred.

**Spent before review:** the two-channel Codex evidence model (§17, §17b) is the review-authority family's first semantic
resolution. A further semantic finding in **review authority** stops this document's patch loop.

## 37. Standing engineering law

ENGINEERING_STANDARDS §8 carries the standing law in the same change: raw external evidence crosses exactly one
validation boundary; downstream receives normalized evidence only; ambiguous evidence → `UNKNOWN`; no raw GitHub
representation and no temporal Actions-history reconstruction in the decision core; text is never sufficient authority
(the two Codex channels); human merge authority; a mechanically enforced 05A/05B import boundary; semantic changes require
architecture review first.

## 38. Non-goals

ARCH-01 adds **no** runtime feature code, `collect()` or `decide()` implementation, watcher, orchestrator, shadow-ledger
implementation, merge automation, autonomous repair, LangGraph, CrewAI, state-machine framework, Redis, database, event
store, or arbitrary GitHub event reconstruction. It is documentation and normative engineering standards only.

## 39. Completion test

ARCH-01 is complete only if 05A/05B need to invent none of the following. Each is answered here:

| Must not be invented | Where |
|---|---|
| which runs count; workflow membership; `workflow_id`'s role | §8, §9, §23 |
| run success / failure / pending mapping | §8 |
| CI source of truth | §9 |
| external source of truth; external collapse mapping | §10, §11 |
| Actions-vs-external discriminator | §12 |
| production ref; compare direction; refresh predicate | §13, §14 |
| head-consistency behaviour; exact-head REST binding | §15, §16 |
| trusted reviewer identity; resolver authority | §20 |
| accepted review states and channels; marker policy; marker failure behaviour | §17, §17b, §21 |
| `CHANGES_REQUESTED` behaviour; finding-open semantics; severity semantics | §18, §19 |
| marker fixtures for both the real clean and findings forms | §22, Appendix A |
| `false_ready`, `false_block`, `human_override` calculation | §29, §30, §31 |
| policy-series and architecture-series partitioning | §32 |
| unknown reasons; the outcome union | §4, §40 |
| 05A/05B module dependency direction | §25 |

If any of these turns out to be an implementation choice, **stop** and amend ARCH-01 before 05A.

## 40. UnknownReason — closed set

Every `UNKNOWN` names exactly one reason:

| Reason | When |
|---|---|
| `read_failed` | a required read failed, was refused or was unauthorized |
| `malformed` | a required answer does not fit the strict positive schema, including a `null` conclusion on a completed run and a `CheckRun` without an app slug |
| `incomplete` | a required collection is truncated, or its stated total disagrees with what was collected or changes between pages |
| `wrong_base` | the PR's base is not the configured production ref |
| `head_moved` | the snapshot head assertion failed twice |
| `workflow_identity_mismatch` | a designated run carries another workflow id |
| `unrecognized_ci_status` | a run status outside §8's table |
| `unrecognized_ci_conclusion` | a completed run's conclusion outside §8's table |
| `unrecognized_context_state` | an external context value outside §11's table |

## 41. Known limitations (non-normative)

- **Resolver authority is credential-based.** An agent acting with a human-allowlisted credential is indistinguishable
  from that human (in the ENG-LOOP-04 session an agent resolved threads with the operator's credential, on the operator's
  instruction). ARCH-01 adds no rule for this; it is recorded so policy can address it deliberately.
- **Reaction verdicts are not artifacts.** Codex's own boilerplate says it may "react with 👍" instead of commenting. A
  reaction carries no body and no head binding, so it is neither channel and the PR reads `REVIEW_MISSING`. No real clean
  verdict in this repository has taken that form (§17).
- **`ALL_DESIGNATED_RUNS` can false-block** a head with legitimate duplicate runs, such as a cancelled superseded run.
  `LATEST_CREATED` is the only pre-approved relaxation, gated by shadow evidence (§8).

---

## Appendix A — pinned real artifacts (redacted)

Both are public PR content. Only the identical `<details>` "About Codex in GitHub" boilerplate is elided.

**Clean form — channel B.** #788 issue comment `6005578488`; author `199175422` (`Bot`); 2026-10-05T23:38:28Z; #788 head
`d9b18a35d9b6aafc27ab3159fc38361db3068336`.

```
Codex Review: Didn't find any major issues. Keep them coming!

**Reviewed commit:** `d9b18a35d9`

<details> <summary>ℹ️ About Codex in GitHub</summary> … </details>
```

**Findings form — channel A.** #799 review `5421736650`; author `199175422` (`Bot`); state `COMMENTED`; `commit_id`
`52d5daadcd7e2e1c215d7e9c681ac2cc259bb259`; 2026-10-05T23:05:18Z.

```

### 💡 Codex Review

Here are some automated review suggestions for this pull request.

**Reviewed commit:** `52d5daadcd`

<details> <summary>ℹ️ About Codex in GitHub</summary> … </details>
```
