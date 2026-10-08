# ENG-LOOP V1 — `scripts/eng/v2/`

Implementation of the ENG-LOOP V2 pipeline's first version (V1): **05A** evidence collection and strict
normalization, **05B** the pure decision engine, **05C** the `shepherd` command. It extends the CP-005a tooling in
`scripts/eng/` (`status`), which stays as it is.

> **Authority status: NOT_NOW.** 05A (normalized validity) and 05B (readiness and finding disposition) are
> authority-bearing under CANONICAL_ROADMAP §16.5. Nothing here may be described as shipped readiness until the
> §16.5 proofs — mechanical completeness, an independent falsifier and fault injection — pass on the implementation
> heads. `CANDIDATE_READY_FOR_HUMAN_REVIEW` is advice to the human, never merge permission, and nothing in this
> directory writes to GitHub.

## Layout

The package layout follows CAP-01 §2:

| Path | Role |
|---|---|
| `contract/` | Normalized, immutable, capability-free types and their validating constructors |
| `adapter/internal/` | 05A: transport, collection passes and binders |
| `decision/` | 05B: the pure decision engine (not yet written) |

## Status by evidence row

| Evidence | Status |
|---|---|
| PR, head and draft identity | **Done at fixture level**: `contract/pr-key.mjs` (strict nine-field key) and `adapter/internal/coherence.mjs` (K0..K1, one retry, confirming pass). Live reading waits on the read-only credential. |
| Live production drift | **Done at fixture level**: `adapter/internal/github/parse-base.mjs` and `adapter/internal/bind/base.mjs` (SPEC-05A §2). |
| Applicable CI evidence | **Done at fixture level**: `adapter/internal/github/parse-ci.mjs` and `adapter/internal/bind/ci.mjs` (SPEC-05A §3). The independent verifier's first pass found one hole (A1, a rewrite between GitHub's test merge and the run record), now closed by SPEC-05A §3.4 step 8. Positive CI evidence still needs the production ruleset (Option A), independently verified. |
| Trusted Codex review provenance | **Done at fixture level**: `adapter/internal/github/parse-review.mjs` (one complete GraphQL response) and `adapter/internal/bind/review.mjs` (ARCH-01 §17-§21; channel B as the 10-hex V1 binding). |
| Unresolved trusted review threads | **Done at fixture level**: thread opener and resolver by numeric id and type, from the same complete response. 05B applies FINDINGS_OPEN. |
| External contexts | **Done at fixture level**: `adapter/internal/github/parse-rollup.mjs` and `adapter/internal/bind/external.mjs` (EXT-CONTEXT-01's closed tables). |
| Completeness and read failures | Every parser is complete-or-UNKNOWN with closed reasons, requires the request it answers, and never throws. |
| Collector | **Done at fixture level**: `adapter/internal/github/primitive.mjs` (the one transport, dedicated token only), `adapter/internal/github/index.mjs` (narrow readers), `adapter/local-ci.mjs` (the shepherd's own classifier proven to be production's) and `adapter/collect.mjs` (coherent pass, confirming pass, Evidence and its hash; SPEC-05A §5). Fault injection covers every request of both passes. Live collection waits on the read-only token. |

Independent verification (CANONICAL_ROADMAP §16.5) lives under `tests/eng/v2/verify/`, written from SPEC-05A and the
records alone, never from implementation source. Across six passes it covered rows 1–6 and the collector, and
converged at 992af0b5: 1,016 verifier rows and 262 builder rows, all passing, with no known-failure row left. Every
finding is either fixed (A1, R4-EDIT and the input, order, redaction and policy deviations) or recorded in SPEC-05A
§7, which lists what V1 does not prove.

Run the tests with `npx vitest run tests/eng/v2`.

## V1 rules that differ from the merged architecture records

The runtime does **not** claim to implement the records below unchanged. These are the selected V1 rules.

1. **UNKNOWN-reason precedence** (resolves #800 P2 `4211046602` in the implementation, not in ARCH-01's prose, which
   stays frozen):
   - a specialized typed reader or binder keeps the reason it specifies;
   - `readRunAttestation`'s *unavailable* or invalid artifact evidence maps to `ci_attestation_invalid` **when that
     subsystem is applicable**. V1 reads no attestation, so V1 never emits it;
   - the generic `read_failed` and `malformed` apply only where no specialized reader owns the failure.

   The V1 closed set is `contract/reasons.mjs`.
2. **CI evidence: V1 does not use CI-ATTEST-01.** No `ci.yml` change is in V1's scope, so there is no run-side
   attestation. V1 proposes a profile built from GitHub-computed evidence instead:
   - the authoritative workflow id, the exact head SHA and an explicitly accepted event, with `pull_request` and
     `push` kept separate;
   - required validation actually executed (for browser groups: the aggregator's own selection, SPEC-05A §7 A5);
   - production drift;
   - base-change events;
   - the head branch's PR list (`state=all`) and the head's associated-PR list, each exactly this PR;
   - the production rules in force now (force push and deletion blocked) — necessary, never treated as history;
   - production's **recorded history** from the repository activity log: no force push or branch deletion anywhere
     in the recorded year, and production created before every applicable run. A run's `created_at` cannot bound a
     rewrite, because GitHub fixes the run's base when it computes the test merge, before the record exists
     (SPEC-05A §3.4 step 8). Current settings and an operator-supplied activation date are never used as history.

   This is a **hypothesis**. CI evidence stays fail-closed until an independent verifier proves the combination is
   sufficient for the PR/base execution identity it claims.
3. **Reason names from the V1 profile:**
   - `base_ref` is used where ARCH-01 says `wrong_base`;
   - `base_ref_changed`, `shared_head` and `base_history_unverified` are V1-only.
4. **Base edits.** V1 treats any `BASE_REF_CHANGED_EVENT` on the PR as `base_ref_changed`, so recovery needs a new
   PR. That is stricter than CI-ATTEST-01's STALE classification, which needs the attestation V1 does not have.
5. **Counting base changes.** The count is the number of filtered `BaseRefChangedEvent` *nodes*, with
   `pageInfo.hasNextPage` false. A filtered `timelineItems` `totalCount` counts every timeline item (live: #720 reports
   36 for one base change), so it is never requested.
6. **Required lanes.**
   - They come from production's own `classify()` on the PR's changed files.
   - A PR that changes `ci.yml`, the classifier or the browser groups is `ci_definition_changed`.
   - A fork head is `fork_head`.
   - A changed-file list that cannot be proven complete is `diff_too_large`.
   - Every applicable run counts, as in the operator's V1 profile, rather than CI-ATTEST-01's `run_number` frontier.
7. **CAP-01 §4 readers.** V1's readers differ from CAP-01's frozen reader set, and this list is that difference;
   CAP-01 itself is not amended:
   - **Parameters.** Three readers take a branch or ref name, which CAP-01 forbids: the head-branch PR list
     (`pulls?head=<owner>:<headRef>`), the production rules (`rules/branches/<productionRef>`) and production
     history (`activity?ref=refs/heads/<productionRef>`). Each value comes from the coherent key (`K0.headRef`) or
     from fixed policy (`productionRef`), never from a caller. The pulls and activity answers echo it; the rules
     answer echoes nothing (SPEC-05A §7, R-ECHO).
   - **Added readers.** PR context (creation time, changed-file count, base-change events, associated PRs), the
     head-branch PR list, branch rules, activity (three types) and run jobs. The compare also returns its changed
     files. V1 uses `readFileBlob` for the CI-definition binding (SPEC-05A §5.2) but not `readRunAttestation`.
   - **No G1–G4.** V1 ships without CAP-01's static lints. The confinement they would check — one network primitive,
     reached only through the readers — is a code-review obligation in V1.

## Credential

Live collection uses a **separate, read-only, fine-grained GitHub token**, never the operator's interactive
write-scoped `gh` session. The token is read from `HONE_ENG_READ_TOKEN` and handed to `gh` as `GH_TOKEN` in a child
environment whose `HOME` and `GH_CONFIG_DIR` are a fresh empty directory, so the stored session cannot be reached;
without the variable, the collector makes no request (SPEC-05A §5.1). Its minimum permissions are derived from the exact operations the readers use and recorded
here as each reader lands. A read the token cannot perform is an UNKNOWN that names the missing capability. A
separate read-only token limits write authority. It does not make the collector the only reader of GitHub, and it
does not make CAP-01 a sandbox.

### Minimum permissions

These come from GitHub's per-endpoint table for fine-grained tokens (2026-10-07). The operator's current session is
a classic OAuth token, so its responses carry no fine-grained permission headers to read them from.

| Reader | GitHub operation | Read permission |
|---|---|---|
| PR key, PR context, reviews, threads | GraphQL `repository.pullRequest` | Pull requests |
| live base tip, head commit object | GraphQL `baseRef.target`, `object(oid:)` | Contents |
| drift and changed files | REST `compare/{base}...{head}` | Contents |
| head-branch PR list | REST `pulls?head=…&state=all` | Pull requests |
| workflow runs and jobs | REST `actions/workflows/{id}/runs`, `actions/runs/{id}/jobs` | Actions |
| production rules in force | REST `rules/branches/{branch}` | Metadata |
| production history | REST `activity` | Contents |
| production CI definition blobs | REST `contents/{path}?ref=` | Contents |
| commit statuses (external contexts) | GraphQL `statusCheckRollup` | Commit statuses |

**Token:** a fine-grained personal access token whose resource owner is `SaiSamyukthVemuri`, scoped only to
`SaiSamyukthVemuri/Hone`.
- **Read-only:** Metadata (required), Contents, Pull requests, Actions, Commit statuses.
- **Nothing else:** no write permission, and no Administration — the classic branch-protection endpoint is
  deliberately not used.

Two capabilities stay unproven until the first live run:
- **Check runs.** GitHub's table lists no fine-grained permission for them, so whether the GraphQL rollup returns
  check runs under this token is checked on the first live run. If it cannot, the rollup reader fails closed and names
  the capability.
- **Ruleset bypass actors.** GitHub returns them only to writers, so a read-only token can never see them. V1 relies on
  recorded history (the activity log) instead.
