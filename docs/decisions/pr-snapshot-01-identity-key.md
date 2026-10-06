# PR-SNAPSHOT-01 — one coherent PR identity and lifecycle key

| Field | Value |
|---|---|
| **Decision** | 05A reads a pull request's identity and lifecycle as **one** normalized value, `PrSnapshotKey`. Every collection pass is bracketed by two reads of that value, which must be structurally equal. Every other piece of evidence in the pass is bound to the first read. |
| **Date** | 2026-10-06 |
| **Status** | **PROPOSED** in this pull request; **ACCEPTED** when merged. |
| **Decided by** | Sam (operator): the PR-snapshot-key re-entry after CI-ATTEST-01's stop law fired on PR #802; re-entered **by removal** after CAP-01 (PR #804) merged. |
| **Consumers** | ARCH-01 (ENG-LOOP V2 evidence collection, PR #800) and CI-ATTEST-01 (run-side CI attestation, PR #802). Both re-enter **by removal** after this record merges (§11). |
| **Scope** | The key, the pass boundary, the retry, open and terminal passes, fixtures, and the dependency on CAP-01 (§9). |
| **Not in scope** | Edits to #800 or #802; `ci.yml`; 05A; 05B; ARCH-02; GitHub-access architectural lint, which CAP-01 owns (§9). |
| **Authored at** | production `4eccefd2fff7efa1abc1a9048531e8046865027d`; re-entered at production `f0ba03b446eeda9917e9b504061a6ddb421bcee9`, where CAP-01 is merged. API evidence read on 2026-10-06 (Appendix). |

> **Normative and self-contained.** This record states every correctness rule it relies on. Its one dependency, CAP-01,
> is merged on production (§9). ARCH-01 and CI-ATTEST-01 are not on production; they consume this record. A semantic
> change is made here first, never through a review-repair round.

---

## 1. The class this record ends

The failure class: reading mutable PR fields **independently**, then adding a field-specific check each time a race is
found. Three instances:
- ARCH-01's per-page head assertion and head-only re-read;
- the base re-validation demanded by #802's open P1 `4190972680`;
- a separate state-first check for closed PRs.

**The law.** There is one key. No code may record that it "checked the head", "checked the base", "checked the
repository" or "checked the state" and then rely on a separate re-read. A pass either saw one key or it is discarded.

## 2. The key — `PrSnapshotKey` (frozen)

All fields come from **one** GraphQL request, `repository.pullRequest(number: N)`:

| Field | Type | GraphQL source |
|---|---|---|
| `prNumber` | positive integer | `number` |
| `state` | `OPEN`, `CLOSED` or `MERGED` | `state` |
| `headSha` | 40 lowercase hex | `headRefOid` |
| `headRef` | non-empty string | `headRefName` |
| `headRepoId` | positive integer; `null` only when `state` ≠ `OPEN` | `headRepository.databaseId` |
| `baseRef` | non-empty string | `baseRefName` |
| `baseRepoId` | positive integer | `baseRepository.databaseId` |
| `baseSha` | `OPEN`: 40 lowercase hex, the **live tip** of the base ref; otherwise `null` (any returned value is ignored) | `baseRef.target.oid` |

- **Strict.** Any other value — missing, the wrong type, `null` where not allowed — makes the pass
  `UNKNOWN(malformed)`. That is a read failure, not a key change.
- **Equality** is structural over all eight fields; `null` equals only `null`.
- **`baseSha` is the live base tip, never `baseRefOid` or REST `base.sha`.** Those report the base SHA GitHub recorded
  when the PR last changed. Live: open #800 reports `baseRefOid` = REST `base.sha` = `7134239097` while its base branch
  tip, `baseRef.target.oid`, is the production head `4eccefd2`. #802's `baseRefOid` moved to `4eccefd2` only after #802
  itself was updated. Drift and CI binding need the PR's live merge target.
- **`baseSha` is `null` for a closed or merged PR.** Such a PR has no live merge target, and reading the branch tip would
  tie a terminal snapshot to unrelated production movement. Merged #788's base branch tip says nothing about #788.
- **`headRepoId` may be `null` for a closed or merged PR.** A head repository can be deleted after the PR closes; an open
  PR needs it.
- **Not in the key:** a field that decides neither *what* is collected nor *how* evidence binds — for example `isDraft`,
  which is only a decision input. Such fields are ordinary evidence (§8), never binding anchors.

## 3. The pass boundary (frozen)

A **pass** is one complete collection:

1. `K0 = readKey()` — the first read of the pass;
2. every other read of the pass (§5, §7), each bound to `K0`;
3. `K1 = readKey()` — the last read of the pass, after every other read has completed.

The pass is **coherent** iff `K1 == K0`, structurally. An incoherent pass is discarded whole: nothing it read is used.

There is no field-specific check of any kind — no head assertion, no base re-read, no state re-check. The key changed, or
it did not.

**What coherence proves:** `K0` held at the first and the last read of the pass. A change made and then reverted between
them is invisible (§12). A confirming second pass (§4) narrows that window.

## 4. Retry and instability (frozen)

- **One bounded retry.** If the first pass is incoherent, exactly one more pass is made. If that pass is also incoherent →
  `UNKNOWN(pr_key_moved)`.
- **A confirming pass gets no retry.** A consumer that confirms the snapshot with a second pass — ARCH-01's bounded full
  re-read — runs it once. It must be coherent, and its key must equal the first coherent pass's key; otherwise
  `UNKNOWN(pr_key_moved)`. Whether the rest of its evidence matches is the consumer's rule (ARCH-01:
  `UNKNOWN(unstable_snapshot)`).
- **One closed reason.** `pr_key_moved` replaces every field-specific "moved" reason, including ARCH-01's `head_moved`.
- **A failed key read is not a key change.** A read or parse failure gives `UNKNOWN(read_failed)` or
  `UNKNOWN(malformed)`, never a retry.

## 5. Open passes (frozen)

When `K0.state` is `OPEN`, every other read in the pass is keyed by `K0`'s values — never by a moving name or a "latest"
relation:

| Evidence | Bound to |
|---|---|
| production drift | `compare/{K0.baseSha}...{K0.headSha}`. When `K0.baseRef` is the configured production ref, `K0.baseSha` **is** the production head, so there is no separate production-head read. |
| CI candidates | workflow runs with `head_sha` = `K0.headSha` |
| CI-ATTEST-01 comparison | the attestation's identity against `K0` (§6) |
| trusted review head binding | each review's `commit_id` and Reviewed-commit marker against `K0.headSha` |
| external contexts | the status-check rollup of the commit `K0.headSha`, read by that SHA |
| reviews, review threads, comments | PR-number-scoped; any head relation is compared with `K0.headSha` |

- **Evidence binding receives `K0` as a value.** Code that binds evidence — CI candidates, the CI-ATTEST-01
  comparison, review binding, drift, contexts — is given `K0` and binds to its values.
- **No read may be relative to the PR's current head or base** — for example its latest commit, or a head or base
  branch name used as a ref. Such a read would re-derive identity outside the key.
- **A non-production base** is the consumer's wrong-base rule (ARCH-01: `UNKNOWN(wrong_base)`). It is evaluated on `K0`,
  and on open passes only.

## 6. The CI-ATTEST-01 comparison

- **Ownership.** CI-ATTEST-01 owns immutable run-side execution identity — what a CI run actually ran for — and its
  binding classes. This record owns what the PR is for this snapshot. *Designated* means the two identities agree under
  CI-ATTEST-01's policy.
- **Compare with `K0` only.** CI-ATTEST-01 compares its attestation's `prNumber`, `headSha`, `headRef`,
  `headRepositoryId`, `baseRef`, `baseRepositoryId` and `baseSha` with `K0`'s corresponding fields (`prNumber`,
  `headSha`, `headRef`, `headRepoId`, `baseRef`, `baseRepoId`, `baseSha`). `baseSha` is compared with `K0.baseSha`, the
  live base tip.
- **No PR reads of its own.** CI-ATTEST-01 must not read the PR's head, base, repositories or state itself. That removes
  #802's open P1 by construction: the base it compares with is `K0`'s, and the pass is discarded if the key moved.

## 7. Terminal passes (frozen)

When `K0.state` is not `OPEN`:
- **The pass reads nothing else.** `K1` is read; `K1 == K0` is required; the terminal Evidence is the key itself; 05B
  returns `NOT_OPEN`.
- **No other read happens:** no CI candidate, artifact, attestation, trust anchor, compare, review or context. Expired
  artifacts or emptied GitHub associations therefore cannot make a terminal PR `UNKNOWN`.
- **The base plays no part** in a terminal decision; the wrong-base rule applies to open passes only.
- **No mixed terminal snapshot.** A concurrent reopen, retarget or head change changes the key, so the pass is rejected
  (§3, §4).
- **Confirming pass.** A consumer's confirming pass is another terminal pass, whose key must be equal.

## 8. Relation to ARCH-01's bounded full re-read

| | PR-SNAPSHOT-01 | ARCH-01's bounded full re-read |
|---|---|---|
| **Proves** | one pass used one coherent key | non-key evidence did not change between passes |
| **Covers** | identity and lifecycle | reviews, threads, CI status, external contexts, `isDraft` |
| **Mechanism** | `K1 == K0` within a pass | identical normalized Evidence across two passes |

Both stay. The key is part of the normalized Evidence, so it also takes part in ARCH-01's equality. A key difference
between the two passes is `pr_key_moved` (§4), not `unstable_snapshot`.

## 9. Dependency on CAP-01 (normative)

- **Ownership.** This record owns **one coherent `PrSnapshotKey` per pass** (§2–§8). Merged CAP-01,
  `docs/decisions/cap-01-github-capability-boundary.md`, owns the **declared, static GitHub capability architecture
  lint**: which modules may read GitHub, and how that is checked. This record does not restate CAP-01 and adds no guard
  of its own.
- **The key reader.** `readKey()` (§3) is CAP-01's reader `readPrKey`. The key is the eight fields of §2 from its one
  request. The draft flag returned with them is not part of the key. The pass's draft evidence is the flag returned with
  `K0`, the read that every other piece of evidence in the pass is bound to (§2, §8).
- **No access claim.** This record does not by itself prevent any read of GitHub. Its correctness laws assume the
  collection code follows CAP-01's architecture, which CAP-01 checks as static architectural lint, not as a sandbox.
- **05B** receives only normalized Evidence.

## 10. Required fixtures

| # | Fixture | Required result |
|---|---|---|
| 1 | no mutation during the pass | coherent; `K1 == K0` |
| 2 | the head changes mid-pass | pass rejected |
| 3 | the base ref changes mid-pass | pass rejected |
| 4 | the base branch advances mid-pass, so the live `baseSha` changes | pass rejected |
| 5 | the head repository changes mid-pass; an open PR with no head repository; a fork PR | rejected; `UNKNOWN(malformed)`; a valid key (its trust is the consumer's rule — CI-ATTEST-01: untrusted) |
| 6 | the state goes `OPEN` → `CLOSED` mid-pass | pass rejected |
| 7 | the state goes `CLOSED` → `OPEN` mid-pass | pass rejected |
| 8 | a stable closed or merged PR | `NOT_OPEN`, with no CI read |
| 9 | a stable open PR with an attestation for a prior base | CI-ATTEST-01 classifies it STALE, never designated |
| 10 | a stable open PR with a correct attestation | designated membership may proceed |
| 11 | the first pass changes; the retry is stable | the retry's coherent pass is used |
| 12 | both passes unstable | `UNKNOWN(pr_key_moved)`, never a candidate |
| 13 | the recorded base SHA (`baseRefOid`, REST `base.sha`) is stale while the base branch has advanced | the key reads the live tip, so drift sees the advance (live: #800) |
| 14 | a closed or merged PR whose head repository was deleted | a valid terminal key, with `null` allowed → `NOT_OPEN` |

## 11. Re-entry sequence

1. **CAP-01** (PR #804) merged as production `f0ba03b4`. It owns GitHub-access architectural lint.
2. **This record re-enters by removal.** Its field and query guard, and that guard's fixture, are removed; the lint is
   delegated to CAP-01 (§9). It converges on exact-head review and merges.
3. **#802 re-enters by removal.** Remove its own reads and checks of the PR's base, head and state, and compare
   attestations with `K0` (§6). Keep the immutable attestation contract and the binding classes. Its open P1 resolves
   through this dependency. Then a fresh exact-head review.
4. **#800 re-enters by removal.** Replace ARCH-01 §15's head assertion and head re-read, and `head_moved`, with this
   record. Take the production head from `K0.baseSha`, apply wrong-base to open passes only, keep the bounded full
   re-read, and consume CI-ATTEST-01 for designated CI membership. Then a fresh exact-head review.
5. **Only after the architecture records merge:** the minimal `ci.yml` attestation step.
6. **Only after that step is live:** 05A, then 05B. ARCH-02 remains separate and later.

## 12. Known limitations (non-normative)

- `K1 == K0` cannot see a change made and reverted within the pass. A confirming second pass narrows that window.
- GitHub documents no atomicity even within one GraphQL response. The key's fields come from one request, the strongest
  unit available.
- A base branch rewritten backwards changes `baseSha` like any other move, so the pass is rejected.

## 13. Review budget

One semantic repair round is allowed. A second fresh, legitimate semantic P0–P2 in the **same** family → **stop**: no
field-specific patch, and a return to architecture discussion.

Families: the key's fields and sources; the boundary and retry; open-pass binding; terminal passes. The former
mechanical-boundary family is gone: CAP-01 owns that lint (§9).

Pure prose, formatting or non-normative feedback does not consume the budget.

**Round 1** (Codex review of `3fe8b09b84`): the **mechanical boundary** family. P2 `4195064808` found that the guard
banned the identifier `baseRef`, which the key's own normalized property shares, so required consumers would fail it.
Repaired in `ac77c16deb` by defining the guard over reads of GitHub instead of property names.

**Round 2** (Codex review of `ac77c16deb`): a second **mechanical boundary** finding. P2 `4195119994` showed that
alternate GraphQL selections and a REST route recover the current head outside the guard's field list. The stop law
fired, and no patch was made.

**Re-entry by removal** (operator decision after CAP-01 merged; not a repair round). The field and query guard, its REST
route list and its fixture were **removed rather than expanded**, and GitHub-access architectural lint is delegated to
CAP-01 (§9). No guard or other enforcement mechanism was added. A fresh semantic P0–P2 affecting this record's
correctness → **stop**, with no automatic patch.

## 14. Non-goals

This record adds no edit to #800 or #802, no `ci.yml` change, no 05A, no 05B, no ARCH-02, no per-field retry, no
history reconstruction, and no GitHub-access guard — CAP-01 owns that lint. The key never uses `baseRefOid` or REST
`base.sha` (§2).

---

## Appendix — API evidence (2026-10-06)

| Pull request | `state` | `baseRefOid` | `baseRef.target.oid` | REST `base.sha` |
|---|---|---|---|---|
| #800 | `OPEN` | `7134239097` | `4eccefd2ff` | `7134239097` |
| #802 | `OPEN` | `4eccefd2ff` (after an update) | `4eccefd2ff` | — |
| #788 | `MERGED` | `083b11c42e` | `4eccefd2ff` | — |

Production (`claude/build-hone-saas-hOex7`) was `4eccefd2ff` at the time of reading. For these same-repository PRs,
`headRepository.databaseId` = `baseRepository.databaseId` = the repository's `databaseId`, `1240764106`.
