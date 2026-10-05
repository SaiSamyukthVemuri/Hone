# Decision — the PR shepherd (ENG-LOOP-01) is SINGLE-SHOT and OBSERVATION-ONLY

| Field | Value |
|---|---|
| **Decision** | `npm run eng -- shepherd <pr>` v1 reads a pull request ONCE, observes and recommends. It is not release authority, and nothing it reports authorizes anything. It does not poll: watch mode moved to ENG-LOOP-02 (§8). |
| **Date** | 2026-10-05 |
| **Status** | **ACCEPTED** |
| **Decided by** | Sam (operator), after the §7.4 stop law fired on PR #795; amended by the operator in §6 (external checks) and §8 (single-shot) |
| **Scope** | `scripts/eng/shepherd.mjs`, the shepherd collector in `scripts/eng/github-facts.mjs`, the one-shot `shepherd` command in `scripts/eng/cli.mjs`, and every document that describes their output. `npm run eng -- status` (CP-005a) is unchanged. `scripts/eng/watch.mjs` was in scope until §8 removed it. |
| **Enforced by** | The code and `tests/eng/shepherd.test.ts` / `tests/eng/shepherd-cli.test.ts` — see section 5. |
| **Supersedes** | The authority-bearing model #795 first proposed: `READY_FOR_HUMAN_MERGE`, review-request inference, and "the shepherd's rules are the delivery rules". |

---

## 1. The decision, plainly

ENG-LOOP-01 v1 is **observation-only**. It may:

- collect deterministic GitHub / CI / review facts for one pull request at its exact head;
- normalize them into one state;
- **recommend** a next action;
- ~~watch for transitions, within bounds;~~ removed by §8 — ENG-LOOP-01 reads once;
- report **candidate** readiness.

It may **not**:

- act as release authority;
- merge, or offer to;
- refresh a branch, or take any other action on its own;
- issue normative repository delivery decisions;
- have its best state treated as sufficient authorization.

**The human / existing release procedure remains authoritative.** The never-merge invariant is
preserved: the shepherd only reads, and its fetcher refuses anything but `gh api` reads and
read-only GraphQL queries.

## 2. Why

The §7.4 stop law fired on #795 at `8ed5dea8` — and the shepherd itself reported it. Two
consecutive Codex rounds raised P0–P2 findings in the **same two root-cause families**:

| Family | Round 1 (`7a4d628e`) | Round 2 (`8ed5dea8`) |
|---|---|---|
| Text from an untrusted actor used as authority | severity badges from any author were findings | `@codex review` from any commenter was an operator request |
| A timestamp used as a proxy for an event | a draft's creation time dated the implicit review request | a commit's time stood in for when it was pushed |

Repairing one surface moved each defect to the next — the pattern that retired CP-005's
authority vehicles (#617–#623). The answer is a smaller model, not a third patch.

## 3. The simplified model

1. **No review-request inference.** Nothing is inferred from PR creation, ready-for-review
   events, commit times, or comments asking for a review.
2. **One review fact.** Is there a **trusted** Codex verdict for the **current exact head**?
3. **If not:** the recommendation is `REQUEST_EXACT_HEAD_REVIEW` — whether or not someone
   already asked, which the shepherd does not try to know.
4. **One authority gate.** Every comment-derived input (submitted reviews, issue comments,
   inline review comments) passes `admit()` once. Only the Codex reviewer's immutable account id
   and type is evidence; no public commenter is ever treated as an operator. Untrusted comments
   survive only as counts, for display.
5. **CI is the latest applicable run.** The latest run of `.github/workflows/ci.yml` triggered by
   `pull_request` at the exact head, with its own jobs — never every run that ever ran at that sha.
6. **Advisory vocabulary.** `CANDIDATE_READY_FOR_HUMAN_REVIEW` replaces `READY_FOR_HUMAN_MERGE`;
   `ACTION_RECOMMENDED` replaces `ACTION_REQUIRED`; every reason is phrased as a recommendation.

## 4. What this decision is not

- **Not an authority re-entry.** CANONICAL_ROADMAP §16.5 is unchanged: authoritative
  control-plane state (CP-005b ledger, CP-007 stop engine, readiness authority, auto-merge)
  remains NOT_NOW. This decision uses the clause that permits *observation-only reporting when
  bounded and independently reviewed*.
- **Not a weakening of the stop laws.** §7.4 still binds people. The shepherd evaluates it and
  *recommends* `ESCALATE`; the operator decides what follows.
- **Not a change to `status`.** Its output stays byte-identical, pinned by test.

## 5. Enforcement

| Rule | Proved by |
|---|---|
| Candidate state is one explicit point; UNKNOWN never reaches it | the whole decision product enumerated |
| Only trusted Codex evidence counts | the inertness sweep: adding or re-attributing any comment in any situation changes nothing but the untrusted counts |
| No request inference | `@codex review` from anyone, opening a PR, or marking it ready changes nothing |
| Exact-head binding | a verdict naming any other commit, or a near-miss prefix, is not a verdict for the head |
| Latest applicable run only | earlier runs at the same sha, other workflows and other events change nothing; run order does not matter |
| External checks are negative-only | a failed or pending external check holds a PR back; adding a passing one, in any situation, changes nothing |
| Single-shot (§8) | the watch flags are refused, never ignored; no watch module, timer or polling loop exists in the eng sources |
| No malformed or partial answer produces a candidate | request, answer, leaf and truncation fault sweeps derived from what the collector actually reads |
| Never merges / writes | the fetcher's exact argv, the refused GraphQL documents, and a source scan |

## 6. Amendment (2026-10-05): external head checks are NEGATIVE-ONLY

Codex's exact-head review of `46234e71` showed that reading CI from the latest Actions run alone
dropped external head checks (Vercel's, for example) from the picture. Decided (option b):

1. The latest applicable GitHub Actions run for the exact head remains the **authority** for
   Actions CI state.
2. Historical Actions runs at the same sha are ignored — including their check runs, which are
   never read as "external".
3. External exact-head check runs (any app but GitHub Actions) and commit statuses are read
   **separately**, as their own signal.
4. An external state **may** block candidacy (failed, errored, cancelled, or another failing
   conclusion) and **may** keep candidacy waiting (pending). Production has no required-check
   configuration, so every external check reported for the exact head is treated as relevant.
5. An external state may **never** make CI green, make a PR a candidate, or compensate for a
   failed or missing Actions run.
6. An unknown, partial or undocumented external state never grants anything: it keeps a PR from
   candidacy.
7. ENG-LOOP-01 remains observation-only: the candidate state is advisory, nothing merges, no
   branch is refreshed, and nothing it reports is normative release authority.

This was the final bounded repair for this re-entry decision. A further P0–P2 finding after it is
proposed as follow-on work, not patched on this PR.

## 7. A future authority re-entry would need

An explicit operator decision recorded here, satisfying §16.5 in full: mechanically derived
completeness, an independent falsifier by construction, and fault injection at every authority
boundary — plus a role-based authority model for operators (not "anyone who is not Codex") and
event-bound head evidence (not timestamps).

## 8. Amendment (2026-10-05): SINGLE-SHOT — watch mode moves to ENG-LOOP-02

Codex's exact-head review of `a8c874bb` raised one P2, in watch mode only: the watch's progress
fingerprint named pending external checks without their status, so a check moving from `queued`
to `in_progress` did not count as progress, and `NO_PROGRESS` could end a watch moments after
real progress began. Under §6's final-repair rule it was not patched on #795. Decided by the
operator: a **scope removal, not another repair round**.

**ENG-LOOP-01 is SINGLE-SHOT and OBSERVATION-ONLY.** It reads a pull request once, at its exact
head, and recommends. It keeps:

- exact-head GitHub facts collection, and production drift facts;
- the latest applicable Actions run, and external checks as negative-only signals (§6);
- trusted exact-head Codex evidence, through the one actor-authority gate;
- deterministic single-shot interpretation, with the advisory `CANDIDATE_READY_FOR_HUMAN_REVIEW`;
- the observation-only boundary and the never-merge invariant;
- JSON output and the one-shot command line.

**Removed from the shipped contract:** `--watch` and its `--interval` / `--max-minutes` flags,
`scripts/eng/watch.mjs`, the no-progress timer, the transition fingerprint, repeated polling,
and the tests and documentation whose only purpose was watch mode. Nothing in the single-shot
core depended on the watch, so the collector and every derivation are unchanged. The flags are
now refused, never ignored.

**ENG-LOOP-02 — a bounded watch controller — owns:** polling; transition fingerprints, including
recognising `queued` → `in_progress` as progress; no-progress timers; bounded termination; and
notifications later, if separately authorized. It re-enters as its own pull request, under its
own review, and stays observation-only.
