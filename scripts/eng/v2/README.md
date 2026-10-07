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
| Live production drift | Not started |
| Applicable CI evidence | Not started; it depends on the V1 CI profile proof below |
| Trusted Codex review provenance | Not started; it will reuse `scripts/eng/evidence.mjs` and `github-facts.mjs` projections |
| Unresolved trusted review threads | Not started |
| Completeness and read failures | Row 1's reads are complete-or-UNKNOWN; the other rows follow as they land |

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
   - required validation actually executed;
   - production drift;
   - base-change events;
   - the head's associated-PR count;
   - the production branch's force-push setting.

   This is a **hypothesis**. CI evidence stays fail-closed until an independent verifier proves the combination is
   sufficient for the PR/base execution identity it claims.
3. **Reason names from the V1 profile:**
   - `base_ref` is used where ARCH-01 says `wrong_base`;
   - `base_ref_changed`, `shared_head` and `base_history_unverified` are V1-only.
4. **Base edits.** V1 treats any `BASE_REF_CHANGED_EVENT` on the PR as `base_ref_changed`, so recovery needs a new
   PR. That is stricter than CI-ATTEST-01's STALE classification, which needs the attestation V1 does not have.

## Credential

Live collection uses a **separate, read-only, fine-grained GitHub token**, never the operator's interactive
write-scoped `gh` session. Its minimum permissions are derived from the exact operations the readers use and recorded
here as each reader lands. A read the token cannot perform is an UNKNOWN that names the missing capability. A
separate read-only token limits write authority. It does not make the collector the only reader of GitHub, and it
does not make CAP-01 a sandbox.
