# ARCH-01 — ENG-LOOP V2: one evidence boundary, a pure decision engine, human merge authority

| Field | Value |
|---|---|
| **Decision** | ENG-LOOP V2's core is a **stateless pipeline**: an **evidence adapter** (05A: GitHub → `Evidence` \| `UNKNOWN(reason)`), a **pure decision engine** (05B: `Evidence` → `Decision`) and a **stateless render** of the exact-head outcome (05C). Raw GitHub data crosses exactly one validation boundary. The human keeps merge authority. ARCH-01 owns **no durable state** (§28). |
| **Date** | 2026-10-06; final re-entry by removal 2026-10-07 |
| **Status** | **PROPOSED** in the ARCH-01 pull request; **ACCEPTED** when merged. |
| **Decided by** | Sam (operator): the ENG-LOOP V2 architecture contract, including the two-channel Codex evidence decision (§17). After the §36 stop law fired, the operator moved all durable state to ARCH-02 (§28). Once CAP-01, PR-SNAPSHOT-01 and CI-ATTEST-01 had merged, the operator made the final re-entry by removal that consumes them (§36). |
| **archVersion** | `ARCH-01` |
| **Scope** | ENG-LOOP-05A, 05B and 05C's stateless render; every later ENG-LOOP component consumes this pipeline and its laws. Durable state is out of scope (§28). Standing law: ENGINEERING_STANDARDS §8. |
| **Depends on** | Three merged records, consumed and not restated (§4a): CAP-01 (`docs/decisions/cap-01-github-capability-boundary.md`), PR-SNAPSHOT-01 (`docs/decisions/pr-snapshot-01-identity-key.md`) and CI-ATTEST-01 (`docs/decisions/ci-attest-01-run-side-attestation.md`). |
| **Supersedes** | The ENG-LOOP-01/03/04 implementations — PRs #795, #798 and #799 — which stay frozen as draft **evidence** branches (§27). |
| **Enforced by** | ENGINEERING_STANDARDS §8 now. When those lanes land, also CAP-01's static architecture lint, the test law (§26) and the fixture corpus (§22). |
| **Authored at** | production `7134239097908a8780aef7fd8fe9b3505d0f4ae0` (#788); re-entered at production `5fb25c8c26ccd882e4fac930ea31d874f5d4370b`, where CAP-01, PR-SNAPSHOT-01 and CI-ATTEST-01 are merged. Every pinned value below was read from the live GitHub API on 2026-10-05/06. |

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

ENG-LOOP is **not** an autonomous merge system. This is CANONICAL_ROADMAP §16.2 (*Phase 1: Sam merges all PRs*). Everything
ARCH-01 specifies — 05A, 05B and 05C's stateless render — is **observation-only** reporting under §16.5's observation
clause: it keeps no durable state and changes nothing. Durable components and authority components (ENG-LOOP-06 bounded
actions) are outside ARCH-01, and §16.5's re-entry gate governs them (§28).

## 2. Root cause learned from #795 / #798 / #799

- raw GitHub representation leaked into decision logic;
- fail-closed became negative enumeration over an open domain;
- increasingly broad raw JS helper contracts allowed impossible shapes;
- #798 and #799 over-modelled GitHub run history and snapshot reconciliation;
- "latest execution" was reconstructed although GitHub already exposes each run's **current** state;
- temporal ordering brought timestamp, run-id and attempt complexity that the question never needed.

We keep the invariants, not the implementation. **Retired premise:** ENG-LOOP reconstructs "latest execution" from
timestamps, run ids or attempts. V2 takes CI state from CI-ATTEST-01's current-run frontier, which orders runs only by
GitHub's documented `run_number` (§8).

## 3. Evidence-boundary law

Raw external GitHub data crosses **exactly one** strict validation / normalization boundary: `collect()` (05A).
Downstream ENG-LOOP logic receives only **`Evidence`** or **`UNKNOWN(reason)`**. There is **no partial trusted Evidence**.

Downstream decision code never interprets: raw REST or GraphQL payloads, workflow path representation, arbitrary
comments, pagination details, sparse arrays, `undefined`, malformed dates, timestamp precision, raw `run_attempt`
semantics, raw check-suite representation, or any GitHub API quirk.

Ambiguous or unrecognized **required** evidence → `UNKNOWN(reason)` for the whole snapshot (§15).

## 4. Components

```
collect(pr, policy)          →  Evidence | Unknown(reason)          (05A)
decide(evidence, policy)     →  Decision                             (05B)
shepherd CLI                 →  renders the exact-head outcome; persists nothing (05C)
```

`collect` takes no GitHub client, reader or transport argument: its readers come only from CAP-01's transport (CAP-01
§6). `decide()` is called **only** with valid `Evidence`; collection failure returns `Unknown` before 05B runs. `UNKNOWN`
is **not** a member of `Decision`. The shepherd renders an outcome union:

```ts
type ObservationOutcome =
  | { kind: "decision"; decision: Decision }
  | { kind: "unknown"; reason: UnknownReason };
```

Later, separately and **not** in 05A/05B/05C: the **orchestrator** and the **watcher** (ENG-LOOP-06, ENG-LOOP-02), and
any durable state (§28).

### 4a. Governing records

| Record | Owns | ARCH-01 consumes |
|---|---|---|
| CAP-01 | the GitHub capability graph; the readers, their typed results and their completeness; static architecture lint | each reader's complete result; a typed failure becomes `UNKNOWN` in `collect` |
| PR-SNAPSHOT-01 | the coherent `PrSnapshotKey`; the `K0`/`K1` pass boundary; the bounded key retry; terminal passes | `K0` and its coherence |
| CI-ATTEST-01 | immutable run-side CI identity; attestation trust; the `run_number` current-run frontier; the normalized CI result | one normalized CI fact (§8) |
| ARCH-01 | the evidence boundary; the bounded full confirming re-read; review-authority and external-context semantics; the drift decision input; 05B's precedence; the pure 05A/05B contract; stateless rendering and human merge authority | — |

ARCH-01 restates none of the three records. Where they meet this record, it points to them.

## 5. 05A — evidence adapter

05A owns GitHub → validated normalized facts → `Evidence | UNKNOWN`. It knows GitHub only through CAP-01's readers. It
makes **no** release or readiness decision and has no decision vocabulary (§25).

### 5.1 Required reads — the only sources of truth

Every read goes through a CAP-01 reader, and every revision-specific read is keyed by `K0` (PR-SNAPSHOT-01 §5):

| Fact | CAP-01 reader | Keyed by |
|---|---|---|
| the PR's identity and lifecycle (`K0`, `K1`) and its draft flag | `readPrKey` | PR number |
| review objects, PR issue comments, review threads | `readReviewEvidence` | PR number |
| external contexts | `readCommitRollup` | `K0.headSha` |
| drift, and the merge base that CI-ATTEST-01's trust anchor uses | `readCompare` | `K0.baseSha`, `K0.headSha` (§14) |
| CI: candidates, attestations and the trust anchor, as CI-ATTEST-01 uses them | `readCandidateRuns`, `readRunAttestation`, `readFileBlob` | `K0.headSha`; run id; file path and commit SHA |

A terminal pass reads only `readPrKey` (§15). Every read is a **read**: 05A never writes to GitHub. One **pass** is
PR-SNAPSHOT-01's `K0` → reads → `K1`. §15 adds one confirming pass.

## 6. 05B — pure decision engine

05B receives only normalized `Evidence` and policy. It knows **nothing** about REST vs GraphQL, GitHub URLs, workflow
paths, `statusCheckRollup` structure, `checkSuite.app.slug`, timestamp or `run_attempt` parsing, pagination, raw review
or check JSON, compare syntax, attestation parsing or the `run_number` frontier. It implements only the precedence law
(§7).

## 7. Advisory decision precedence

`decide(E, P)` is total and deterministic. The **first** row that holds is the decision:

| # | Condition over `Evidence` E and policy P | Decision |
|---|---|---|
| 1 | `E.kind` is `terminal`: the key's `state` is `CLOSED` or `MERGED` | `NOT_OPEN` |
| 2 | `E.draft` | `DRAFT_HOLD` |
| 3 | `E.drift.behindBy > 0` | `NEEDS_REFRESH` |
| 4 | `E.ci.outcome` is `FAILED` | `CI_FAILED` |
| 5 | any external context is `failure` | `EXTERNAL_BLOCKED` |
| 6 | `E.ci.outcome` is `NO_FRONTIER` | `CI_NOT_STARTED` |
| 7 | `E.ci.outcome` is `PENDING` | `CI_PENDING` |
| 8 | any external context is `pending` | `EXTERNAL_PENDING` |
| 9 | not `TRUSTED_REVIEW_AT_HEAD` (§17) | `REVIEW_MISSING` |
| 10 | `FINDINGS_OPEN` (§18, §19) | `FINDINGS_OPEN` |
| 11 | otherwise | `CANDIDATE_READY_FOR_HUMAN_REVIEW` |

Row 1 takes every terminal `Evidence`, so rows 2–11 read only open `Evidence` (§24). `E.ci.outcome` `SUCCEEDED` does
not block. `CANDIDATE_READY_FOR_HUMAN_REVIEW` is **advisory only**. The human retains merge authority.

## 8. CI evidence — one normalized fact from CI-ATTEST-01

**CI state is CI-ATTEST-01's current-run frontier result.** CI-ATTEST-01 owns which run speaks for this pull request:
the candidates, the immutable run-side attestation, trust, the head-repository disproof, and the `run_number` current-run
frontier with its run-state table (CI-ATTEST-01 §5). ARCH-01 adds no run-selection rule. It consumes exactly one
normalized fact:

| CI-ATTEST-01 result | `E.ci.outcome` |
|---|---|
| a frontier whose state is `SUCCEEDED` | `SUCCEEDED` |
| a frontier whose state is `FAILED` | `FAILED` |
| a frontier whose state is `PENDING` | `PENDING` |
| no frontier | `NO_FRONTIER` |
| `UNKNOWN(reason)` | the whole snapshot is `UNKNOWN(reason)`, and 05B never runs |

05B maps the fact in §7's order. No run, `run_number`, attempt, artifact id, attestation payload or `pull_requests`
association reaches `Evidence` or 05B.

§8.1 and §8.2 are vacant. They held a CI-run-to-PR binding through GitHub's mutable `pull_requests` association, which
was removed: PR-SNAPSHOT-01 now owns the current PR identity, and CI-ATTEST-01 owns the immutable triggering execution
identity. The numbers are kept so #800's review record still resolves.

## 9. CI source of truth

GitHub Actions CI state comes **only** from CI-ATTEST-01's normalized result (§8). `statusCheckRollup` is **not**
authoritative for Actions CI; it is read only for external contexts (§10).

## 10. External context domain

External contexts are the head commit's `statusCheckRollup.contexts`, read by CAP-01's `readCommitRollup(K0.headSha)`.
That reader returns one complete response or a typed failure, and `collect` turns *incomplete* into
`UNKNOWN(external_contexts_too_large)` and *malformed* into `UNKNOWN(malformed)` (CAP-01 §4, §17). The domain is
restricted to:

- every `StatusContext`; and
- every `CheckRun` whose check suite's app is **not** GitHub Actions (§12).

GitHub Actions `CheckRun`s in the rollup are ignored for the external domain — the Actions domain is §8's — which
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

For an open pass, if `K0.baseRef` ≠ the configured production ref → `UNKNOWN(wrong_base)`. When it is equal, `K0.baseSha`
**is** the live production tip for that pass (PR-SNAPSHOT-01 §5): there is no separate production-head read.

## 14. Compare direction

Drift comparison is frozen as `compare/{K0.baseSha}...{K0.headSha}`, read by CAP-01's `readCompare`: **base** = the
production tip, **head** = the exact PR head. Refresh predicate: `behind_by > 0` → `NEEDS_REFRESH`. `ahead_by` is
metadata only and **never** drives a decision. Swapping the direction is an implementation defect.

## 15. Pass coherence and the bounded full re-read

`collect()` produces **one** coherent, confirmed snapshot, or `UNKNOWN`.

- **Pass coherence is PR-SNAPSHOT-01's** (§3, §4). `K0 = readPrKey()` comes first; every other read of an open pass is
  keyed by `K0`, and a terminal pass makes none; `K1 = readPrKey()` comes last, and `K1 == K0` structurally. A moved key
  discards the whole pass, with exactly one retry, and a second move → `UNKNOWN(pr_key_moved)`. There is no head
  assertion, head-only re-read or field-specific check.
- **Reader completeness is CAP-01's.** Each reader returns one complete response or a typed failure, which `collect`
  turns into `UNKNOWN` (CAP-01 §4, §15–§17). Nothing pages.
- **Any** required read, parse or authorization failure → the whole snapshot is `UNKNOWN(reason)`. No partial Evidence.
  A pass stops at its first failure, and that failure names the reason.
- **Stability: one bounded full confirming pass (ARCH-01).** Pass coherence cannot see a change that keeps the key: a
  thread resolved or reopened, a body edited, the frontier run or a context changing state, the draft flag toggled. So
  once one coherent pass has produced normalized `Evidence`, 05A immediately performs **one more complete pass** and
  normalizes it too. `Evidence` is emitted only if the confirming pass:
  - is itself coherent (`K1 == K0`) and has the **same** key as the first coherent pass, with no retry — otherwise
    `UNKNOWN(pr_key_moved)` (PR-SNAPSHOT-01 §4);
  - normalizes to **identical** `Evidence`, compared as values with `capturedAt` excluded and the order-irrelevant
    arrays (§26: external contexts, reviews, threads) compared as multisets — otherwise `UNKNOWN(unstable_snapshot)`.

  A read, parse or completeness failure in the confirming pass → that reason. There is no third pass and no loop: a
  later invocation is the retry. What the re-read does and does not guarantee is stated in §41.
- **Terminal passes** read only the key (PR-SNAPSHOT-01 §7). Their confirming pass is another terminal pass, whose key
  must be equal. No CI candidate, artifact, attestation, trust anchor, compare, review or context is read, so historical
  artifact expiry or a cleared GitHub association can never make a stable terminal PR `UNKNOWN`.

## 16. Reads keyed by K0

Every revision-specific read is keyed by `K0` (PR-SNAPSHOT-01 §5), never by a moving branch name or an independently
discovered "latest" sha. Two heads are never mixed in one pass. Rendered output always names the exact head it describes.

## 17. Trusted Codex artifact at head

Review evidence comes from CAP-01's `readReviewEvidence(prNumber)`: one complete response or a typed failure, which
`collect` turns into `UNKNOWN(review_evidence_too_large)` or `UNKNOWN(malformed)` (CAP-01 §4, §17). "The exact head"
below is `K0.headSha`; review binding never re-reads the PR.

`TRUSTED_REVIEW_AT_HEAD` is satisfied by **either** of two explicit artifact forms. Live evidence (2026-10-05): every
**clean** Codex verdict is a PR **issue comment** — 21 of 21 across 12 PRs (#782–#797), none a review object — while
every **findings** verdict is a PR **review object**, all state `COMMENTED`. ARCH-01 models both channels rather than
forcing both through a review object.

### A. Findings / PR-review artifact

A GitHub PR **review object** where **all** hold:

- the actor's numeric id is in the trusted Codex allowlist (§20);
- the actor's account type is `Bot`;
- `review.commit_id` == `K0.headSha`;
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
- the captured 10 hex must equal the **first 10 characters** of `K0.headSha`;
- for channel A it must also agree with `review.commit_id`, which must equal `K0.headSha`.

The default is deliberately narrow: not "any 7–40 hex". Evidence (2026-10-05): all 21 real clean artifacts and all 27
non-empty real findings artifacts carry exactly one 10-lowercase-hex marker; on every findings artifact it equals
`commit_id[0:10]`.

The **clean verdict pattern** (policy value): the body **begins** with the exact text
`Codex Review: Didn't find any major issues.` (ASCII apostrophe). The cheer phrase that follows varies and is ignored. All
21 real clean artifacts match it, and no real findings body does.

If Codex changes either representation, the current policy fails closed to `REVIEW_MISSING`, and the policy is updated
deliberately (§32).

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

## 23. Workflow identity

The authoritative workflow, its expected id (`.github/workflows/ci.yml`, `289443461`, live `GET actions/workflows/ci.yml`
on 2026-10-05) and the authoritative event are policy values (§32). CAP-01's candidate listing is filtered by them
(CAP-01 §4), and a run that CI-ATTEST-01 examines and that disagrees with them is INVALID (CI-ATTEST-01 §5). A run's
`path` field is display and debug metadata only: no matching on it, in any form (#798's `ci.yml@main` lesson). ARCH-01
adds no workflow rule of its own.

## 24. Minimal normalized Evidence model

Immutable, constructed only by 05A through validating constructors:

```ts
type Evidence = TerminalEvidence | OpenEvidence;

interface TerminalEvidence {   // a terminal pass (§15): key.state is CLOSED or MERGED
  readonly kind: "terminal";
  readonly key: PrSnapshotKey; // PR-SNAPSHOT-01 §2; a terminal pass's Evidence is its key (PR-SNAPSHOT-01 §7)
  readonly capturedAt: string; // display metadata; decide() never reads it
}

interface OpenEvidence {       // key.state is OPEN and key.baseRef is the configured production ref (§13)
  readonly kind: "open";
  readonly key: PrSnapshotKey; // K0 (PR-SNAPSHOT-01 §2)
  readonly draft: boolean;     // the flag read with K0 (PR-SNAPSHOT-01 §9); ordinary evidence, not part of the key
  readonly drift: { behindBy: number; aheadBy: number /* metadata */ };
  readonly ci: { outcome: "SUCCEEDED" | "FAILED" | "PENDING" | "NO_FRONTIER" }; // §8
  readonly external: ReadonlyArray<{ source: string /* display */; state: "pending" | "success" | "failure" }>;
  readonly reviews: ReadonlyArray<{
    channel: "PR_REVIEW" | "CLEAN_COMMENT";
    actor: { id: number; type: string };
    verdict: "COMMENTED" | "APPROVED" | "CHANGES_REQUESTED" | "DISMISSED" | "PENDING" | "CLEAN";
    // Validated construction: the head binding and the marker policy hold for K0.headSha
    // (A: commit_id == K0.headSha and the single marker == its first 10 hex; B: the clean pattern and the single
    // marker == its first 10 hex). The actor and the state are NOT folded in: 05B checks them against policy.
    qualifiesAtHead: boolean;
  }>;
  readonly threads: ReadonlyArray<{
    opener: { id: number; type: string };
    resolved: boolean;
    resolver: { id: number; type: string } | null;
    outdated: boolean; // metadata, never readiness authority
  }>;
  readonly capturedAt: string; // display metadata; decide() never reads it
}
```

`TRUSTED_REVIEW_AT_HEAD` (05B) ⇔ some review has `qualifiesAtHead`, an actor in the trusted allowlist with type `Bot`,
and verdict `COMMENTED`, `APPROVED` or `CHANGES_REQUESTED` (channel A) or `CLEAN` (channel B). 05A computes
`qualifiesAtHead`; 05B never sees a marker, a body or a `commit_id`. `Evidence` carries no CI run list, `run_number`,
artifact id, attestation payload, `pull_requests` association, pagination or raw GitHub representation.

## 25. 05A / 05B boundary

CAP-01 owns the module graph, the readers and the static architecture lint that enforces them (CAP-01 §3, §8). ARCH-01
adds no guard family. It keeps the **semantic** separation that the lint protects:

| | 05A — evidence adapter (`collect`) | 05B — decision engine (`decide`) |
|---|---|---|
| Produces | `Evidence` or `UNKNOWN(reason)` | `Decision` |
| Knows | GitHub, only through CAP-01's readers; PR-SNAPSHOT-01's key; CI-ATTEST-01's binding | normalized `Evidence` and policy only |
| Never | defines `Decision`, names a §7 decision state, or encodes readiness precedence | imports GitHub transport or adapter internals; sees a raw response, pagination, attestation parsing or the `run_number` frontier |

Permitted direction, never reversed:

```
raw GitHub  →  CAP-01 readers  →  collect (05A)  →  normalized Evidence contract  →  decide (05B)
```

## 26. Test law

**Adapter domain (05A):** raw response strings and realistic API payloads → `Evidence | Unknown`. It never throws; the
schema is strict and positive; unknown enums, truncated bodies, malformed bodies and missing required fields → `UNKNOWN`.
Use mutated **realistic** GitHub responses, not impossible GitHub histories. Stability (§15) is proven with paired passes:
a confirming pass that differs only in the order of an order-irrelevant array yields the same `Evidence`; one that
differs in any normalized value — a thread resolved or reopened, the frontier run or a context changing state — yields
`UNKNOWN(unstable_snapshot)`; another key yields `UNKNOWN(pr_key_moved)`. The fixtures that the merged records require
are specified there (CAP-01 §9, PR-SNAPSHOT-01 §10, CI-ATTEST-01 §10) and not restated.

**Core domain (05B):** valid normalized `Evidence` → a deterministic `Decision`. It is total and deterministic;
permutation-invariant wherever array order is semantically irrelevant (external contexts, reviews, threads); `Unknown`
never reaches candidacy; a stale review is inert; an untrusted actor is inert; external success is inert; explicit
failures dominate according to §7; irrelevant evidence cannot change the state.

The independent falsifier inherits #799's lessons (§27): permutation invariance, malformed boundary inputs, and the
no-throw boundary.

## 27. Historical salvage

| Branch | Lane, frozen head | Open findings | Disposition |
|---|---|---|---|
| **#795** | ENG-LOOP-01, `555d200615` | P1 4188450896 (ref-qualified workflow path) | **Keep:** the single-shot CLI concept, the observation-only posture, advisory candidacy, the exact-head law, stop laws, the external-negative-only rule, the trusted-actor concept. **Rewrite:** trusted actors against numeric ids and normalized evidence. **Delete:** workflow-path selection, latest-applicable-run reconstruction, review-request inference. **Defer:** watch behaviour (ENG-LOOP-02). |
| **#798** | ENG-LOOP-03, `314f118f78` | P2 4189402172 (order-dependent snapshot reconciliation) | **Keep, as fixtures:** the workflow-identity lessons, the `@main` path fixture, documented event and schema knowledge. **Delete:** run-id recency, cross-run attempt comparison, `run_started_at` selection, pairwise reconciliation. |
| **#799** | ENG-LOOP-04, `52d5daadcd` | P2 4189779531, P2 4189779535 | **Delete from production design:** the snapshot canonicalization system, calendar validation, dense-array defensive decision helpers, fractional-timestamp ordering. **Move to the falsifier:** permutation invariance, malformed boundary inputs, the no-throw boundary. |

#795, #798 and #799 remain historical evidence branches. **Do not rehabilitate them as implementation PRs.**

## 28. Durable measurement — out of scope (ARCH-02 handoff)

ARCH-01 owns **no durable state**. After the §36 stop law fired on the shadow-metrics family, the whole durable family left
this record: the shadow ledger, its validator and falsifier, the ledger's CANONICAL_ROADMAP §16.5 durable-state gate,
`false_ready`, `false_block`, `human_override`, `time_in_state` and the other shadow metrics, measurement-series grouping
and its `policyHash` / `archVersion` partitioning, the shadow graduation gate, and authority graduation to ENG-LOOP-06.

Durable measurement begins only under a **separate architecture record, ARCH-02**. ARCH-02 starts from three findings
raised on this record's pull request (#800) — resolved there as transferred, not fixed — as requirements:

| Finding | Requirement |
|---|---|
| `4190459605` | `UNKNOWN` must not make the gate appear clean |
| `4190459613` | a terminal `NOT_OPEN` must not erase pre-merge blocking history |
| `4190459619` | metric series must account for the architecture version |

Until ARCH-02 is accepted, nothing ARCH-01 specifies persists an outcome, and CANONICAL_ROADMAP §16.5 governs any durable
component proposed later. Sections 29–31 and 33 are intentionally vacant: they held the metric definitions that moved, and
the numbers are kept so #800's review record still resolves.

## 32. Policy

The policy — every value that can affect evidence or decision semantics — includes at least:

| Policy value | Current value |
|---|---|
| production ref | `claude/build-hone-saas-hOex7` |
| authoritative workflow, expected workflow id | `.github/workflows/ci.yml`, `289443461` |
| authoritative event | `pull_request` |
| target repository (id) | `SaiSamyukthVemuri/Hone`, `1240764106` |
| trusted Codex reviewers (id, type) | `199175422`, `Bot` |
| human resolvers (id, type) | `26781116`, `User` |
| accepted channel-A review states | `COMMENTED`, `APPROVED`, `CHANGES_REQUESTED` |
| Reviewed-commit marker | §17b: the literal `**Reviewed commit:**` then 10 lowercase hex in backticks; exactly once; equal to the head's first 10 hex |
| clean verdict pattern | body begins `Codex Review: Didn't find any major issues.` |

Any later evidence- or decision-affecting value joins this table. CI-ATTEST-01's artifact and frontier semantics are
frozen in that record and are not policy switches. `archVersion` identifies this contract (`ARCH-01`).

## 34. Delivery sequence

```
ARCH-01         this record + ENGINEERING_STANDARDS §8
   ↓
ci.yml          CI-ATTEST-01's emitter: the first two steps (generate, upload), before checkout — a separate PR
   ↓
live proof      the attestation path on real runs (CI-ATTEST-01 §11)
   ↓
ENG-LOOP-05A    GitHub → Evidence | Unknown            (no decisions)
   ↓
ENG-LOOP-05B    Evidence → Decision                    (no GitHub knowledge)
   ↓
ENG-LOOP-05C    shepherd CLI: stateless render         (persists nothing)
```

Later, and outside ARCH-01: ARCH-02 (durable measurement), the watcher (ENG-LOOP-02), bounded actions (ENG-LOOP-06) and
any stronger authority. No durable state exists before ARCH-02 (§28). 05A does not start until ARCH-01 is merged and the
attestation path is proven.

**05A credential precondition (operator decision; CAP-01 §11).** 05A must not use the operator's current write-scoped,
interactive `gh` credential. Before its first live GitHub collection, 05A uses a separate read-only GitHub credential
suited to CAP-01's frozen reader set, and the 05A work derives and documents that credential's minimum read permissions
from the exact GitHub operations it uses. ARCH-01 creates no credential and guesses no permission. The operator's
write-scoped session remains for human and operator work. This does not make CAP-01 a sandbox (CAP-01 §10).

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

**Spent in round 1** (Codex review of `789d470d6b`): the **evidence boundary** family — §15's bounded full re-read — and
the **shadow metrics** family — the shadow ledger's §16.5 gate — each spent their first semantic resolution.

**Round 2 stopped** (Codex review of `5982d7d025`): three semantic findings in the shadow-metrics family. After the
stop-law architecture discussion the operator **removed the whole durable family** from ARCH-01 (§28) — a removal, not a
third semantic patch — and its three findings became ARCH-02's requirements.

**Round 3 stopped** (Codex review of `aeb18aaedc`): P1 `4190617309` found that designated CI runs were not bound to the
PR. The re-entry added a CI-run-to-PR binding through the `pull_requests` association.

**Round 4 stopped** (Codex review of `01421d0b17`): two more CI-authority findings — P1 `4190741980` (after a base
edit, a run created for the old base could still count) and P2 `4190741986` (a terminal PR must reach `NOT_OPEN`). The
REST association approach was non-converged. Its replacement was built and merged as separate records: CAP-01 with its
reader amendments, PR-SNAPSHOT-01 and CI-ATTEST-01.

**Final re-entry by removal** (operator decision after those records merged; consolidation, not new architecture). The
following are removed:
- the `pull_requests` association model;
- `ALL_DESIGNATED_RUNS` and `LATEST_CREATED`;
- the per-page head assertion and the head re-read;
- the paging language;
- the separate production-head read;
- the bespoke guard tests.

ARCH-01 consumes the merged records instead (§4a, §5, §8, §13–§16, §25). The shadow-metrics findings are transferred to
ARCH-02 (§28), and the CI-association findings are resolved by the removal. Any fresh semantic P0–P2 → **stop**, with no
automatic patch.

## 37. Standing engineering law

ENGINEERING_STANDARDS §8 carries the standing principles: one evidence boundary; normalized evidence downstream; fail
closed; a pure decision core; human merge authority; durable state deferred to ARCH-02; and architecture changes before
implementation. It points to this record and to CAP-01, PR-SNAPSHOT-01 and CI-ATTEST-01 for their mechanisms rather than
restating them.

## 38. Non-goals

ARCH-01 adds **no** runtime feature code, no `collect()` or `decide()` implementation, no `ci.yml` change, watcher,
orchestrator or durable state of any kind (§28). It adds no merge automation, autonomous repair, LangGraph, CrewAI,
state-machine framework, Redis, database, event store or arbitrary GitHub event reconstruction. It adds no CI
run-selection rule of its own (§8) and no GitHub-access guard (CAP-01). It is documentation and normative engineering
standards only.

## 39. Completion test

ARCH-01 is complete only if 05A/05B need to invent nothing. Each question has one owner:

| Must not be invented | Owner |
|---|---|
| which GitHub reads exist, their parameters, typed results and completeness; the capability graph and its lint | CAP-01 (§3, §4, §6, §8, §15–§17) |
| the PR identity key; pass coherence; the key retry; terminal-pass handling | PR-SNAPSHOT-01 (§2–§7) |
| which CI run speaks for the PR; the attestation, trust and re-runs; the run-state table; the normalized CI result | CI-ATTEST-01 (§4–§9) |
| the evidence boundary; the outcome union; the closed reason set | ARCH-01 §3, §4, §40 |
| the bounded full confirming re-read | ARCH-01 §15 |
| what the CI fact means for decisions | ARCH-01 §7, §8 |
| the external source and collapse mapping; the Actions discriminator | ARCH-01 §10–§12 |
| the production ref, compare direction and refresh predicate | ARCH-01 §13, §14 |
| review authority: identities, channels, states, marker and verdict policy, marker failure, `CHANGES_REQUESTED`, open findings | ARCH-01 §17–§21 |
| artifact fixtures for both real forms | ARCH-01 §22, Appendix A |
| the Evidence model; 05B's precedence; the 05A/05B semantic split | ARCH-01 §24, §7, §25 |

If any of these turns out to be an implementation choice, **stop** and amend the owning record before 05A. The completion
items for `false_ready`, `false_block` and `human_override` calculation and for policy- and architecture-series
partitioning moved with the durable family to ARCH-02 (§28).

## 40. UnknownReason — closed set

Every `UNKNOWN` names exactly one of these reasons, and no other reason exists:

| Reason | When | Produced by |
|---|---|---|
| `read_failed` | a required read failed, was refused or was unauthorized | any read (PR-SNAPSHOT-01, CAP-01) |
| `malformed` | a required answer does not fit its strict positive schema — including a *malformed* reader result, a `null` conclusion on a completed frontier run and a `CheckRun` without an app slug (§12) | CAP-01, CI-ATTEST-01, ARCH-01 |
| `wrong_base` | an open pass's `K0.baseRef` is not the configured production ref (§13) | ARCH-01 |
| `pr_key_moved` | the key moved in both passes, or the confirming pass's key differs from the first (§15) | PR-SNAPSHOT-01, ARCH-01 |
| `unstable_snapshot` | the confirming pass normalizes to different `Evidence` (§15) | ARCH-01 |
| `ci_candidate_listing_too_large` | the CI candidate listing cannot prove completeness in one response | CAP-01 §4, §15 |
| `ci_attestation_invalid` | a candidate examined before the frontier is INVALID (CI-ATTEST-01 §5) | CI-ATTEST-01 |
| `ci_attestation_untrusted` | the trust anchor fails, or an open PR's head repository is not the target repository (CI-ATTEST-01 §7.2) | CI-ATTEST-01 |
| `review_evidence_too_large` | review evidence cannot be complete in one response | CAP-01 §4, §17 |
| `external_contexts_too_large` | the external contexts cannot be complete in one response | CAP-01 §4, §17 |
| `unrecognized_ci_status` | the frontier run's status is outside CI-ATTEST-01's run-state table | CI-ATTEST-01 |
| `unrecognized_ci_conclusion` | the frontier run's conclusion is outside that table | CI-ATTEST-01 |
| `unrecognized_context_state` | an external context value is outside §11's table | ARCH-01 |

## 41. Known limitations (non-normative)

- **Resolver authority is credential-based.** An agent acting with a human-allowlisted credential is indistinguishable
  from that human (in the ENG-LOOP-04 session an agent resolved threads with the operator's credential, on the operator's
  instruction). ARCH-01 adds no rule for this; it is recorded so policy can address it deliberately.
- **Reaction verdicts are not artifacts.** Codex's own boilerplate says it may "react with 👍" instead of commenting. A
  reaction carries no body and no head binding, so it is neither channel and the PR reads `REVIEW_MISSING`. No real clean
  verdict in this repository has taken that form (§17).
- **Two agreeing passes are not a transaction.** GitHub documents no snapshot isolation across requests. Every read of
  §15's first pass precedes every read of its confirming pass. So if nothing a read returns changed between that read's
  two executions, the agreed `Evidence` is the true state at the moment between the two passes. A change made and then
  reverted inside that window is invisible, and only such a reversal can let a combination that never existed survive.
  Recorded so policy can address it deliberately.
- **Limitations owned elsewhere** are recorded in their owning records and not restated here:
  - the single-response caps and their fail-closed outcomes (CAP-01 §4, §15–§17);
  - change-and-revert inside one pass (PR-SNAPSHOT-01 §12);
  - V1's CI fail-closed cases — a run examined before the frontier whose attestation is missing, expired, duplicated or
    unreadable, including a run that predates the emitter or stopped before it, and same-repository ambiguity
    (CI-ATTEST-01 §5, §6, §8 and §10; CAP-01 §16);
  - the CI trust residuals of the writer class (CI-ATTEST-01 §7.3).

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
