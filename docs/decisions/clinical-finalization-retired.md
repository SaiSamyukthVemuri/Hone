# Decision — signed / finalized clinical records are RETIRED

| Field | Value |
|---|---|
| **Decision** | Hone will **not** offer signed or cryptographically finalized clinical records. |
| **Date** | 2026-07-29 |
| **Status** | **ACCEPTED** |
| **Decided by** | Sam (product owner) |
| **Scope** | The signed/finalized clinical-record system built by migrations **0119** (finalization boundary) and **0120** (corrections & amendments backend), plus the practitioner-facing Finalize and signed-record Correction surfaces. |
| **Enforced by** | Migration **0159** (`supabase/migrations/0159_retire_signed_clinical_records.sql`) — additive, non-destructive, zero data operations. |
| **Supersedes** | Every prior document that described this capability as *parked*, *dormant pending customer approval*, *held*, *a later phase*, or gated behind "separate authorization". It is none of those. It is retired. |

---

## 1. The decision, plainly

**Signed and cryptographically finalized clinical records are not a Hone product capability.**
The following are **permanently rejected**, not deferred:

- practitioner-signed clinical snapshots;
- immutable finalized clinical records;
- a "snapshot v2" or any successor snapshot format;
- cryptographic clinical-record hashes **as a product feature**;
- a correction / amendment workflow built around signed snapshots;
- enabling `studios.clinical_finalization_enabled` or `studios.clinical_corrections_enabled`;
- practitioner-facing **Finalize** controls;
- practitioner-facing signed-record **Correction** controls.

**Treatment sessions remain ordinary, editable operational records.** A practitioner who
mis-charts a session fixes it by **editing the record through the normal charting commands** —
there is no signing step, no freeze, no version-lineage ceremony and no amendment workflow to
learn. The database now enforces that no session can enter the retired lifecycle at all, so
there is no state in which ordinary charting becomes read-only.

## 2. What is explicitly NOT given up

This decision retires **one specific system**. It is not a licence to weaken anything else, and
must never be cited as one. The following are **RETAINED** and remain in force:

- **Ordinary operational audit trails.** These tables are **ACTIVE, untouched and must not be
  weakened or removed**:

  | Table | What it records |
  |---|---|
  | `public.session_audit` (0008) | Ordinary session edit history — who changed a session and when. |
  | `public.record_keeping_audit_events` (0086) | Append-only edit history for sterile items, disinfectants, probe lots and exposure incidents. |
  | `public.session_copy_operations` (0157) | Whole-session-copy provenance — one row per committed copy operation. |
  | `public.admin_action_events` (0113) | Platform-admin action log (`/admin/audit`), service-role only. |
  | `public.client_portal_access_events` (0111) | Append-only client-portal access events (no tokens, IPs or clinical data). |

- **The one audit-named table that is NOT ordinary audit:** `public.clinical_audit_events`
  (0120). Despite its name it is **part of the retired system**: its CHECK constraint permits
  only `operation_type in ('correction', 'amendment')`, i.e. it exists solely to record
  signed-record corrections and amendments. It holds **0 rows**, is now fully immutable, and is
  retired along with the rest of 0119/0120. Do not treat it as Hone's operational audit trail,
  and do not "replace" it — the five tables above already are that trail.
- **Actor attribution and timestamps** on every write path.
- **Treatment-history integrity** — the treatment-memory record (Before Today / Last Visit /
  per-area history) stays complete and truthful.
- **Whole-session-copy provenance** (0157): source locking, stale-source rejection, the
  `(target_session_id, idempotency_key)` uniqueness guarantee and the provenance ledger.
- **Tenant isolation** — `is_studio_member` RLS plus composite same-studio foreign keys.

Correspondingly, this decision does **not** permit any of the following, and 0159 moves in the
opposite direction on several of them:

- cross-studio change of any kind;
- assigning one client's session to another client;
- browser users bypassing application commands to write clinical tables directly;
- `TRUNCATE` by `authenticated`, or arbitrary mutation of clinical tables;
- removing, rewriting or pruning audit data.

## 3. How the retirement is enforced (five mechanisms in migration 0159)

The capability was reachable from the browser **today, with no UI at all**: `authenticated`
held `EXECUTE` on the finalize/correct/amend RPCs, and a studio owner could `PATCH`
`clinical_finalization_enabled = true` straight through PostgREST via the
`studios: owners update` policy. Deleting the React components alone would have left that path
open, so the decision is enforced in the database:

1. **The flags can never be turned on again.** CHECK constraints
   `studios_clinical_finalization_retired` and `studios_clinical_corrections_retired` pin
   `studios.clinical_finalization_enabled` and `studios.clinical_corrections_enabled` to
   `false`. A CHECK is declarative and consults no policy, so **no role** can set them — not a
   studio owner through the owners-update policy, not `service_role`, not a future settings
   screen.
2. **No runtime role can invoke the retired RPCs.** `EXECUTE` is revoked from
   `public`, `anon`, `authenticated` and `service_role` on `finalize_session`,
   `correct_finalized_session`, `amend_finalized_session`,
   `amend_finalized_session_with_image` and `build_session_snapshot`.
3. **No session may enter the retired lifecycle.** The trigger
   `sessions_guard_retired_finalization` refuses any transition of `sessions.record_status`
   **into** `finalized` or `void`, and any `INSERT` that is not `draft`. It is a *transition*
   guard, so the one legacy row is untouched.
4. **No new signed artifact can be produced.** `INSERT` is refused on
   `clinical_record_snapshots`, `clinical_record_amendments` and `clinical_audit_events`. With
   the 0119/0120 append-only guards already blocking `UPDATE`/`DELETE` for every role, those
   three tables are now **fully immutable legacy evidence**.
5. **Privilege hardening that breaks nothing today.** Every remaining `anon` write privilege on
   the six clinical tables is removed; `TRUNCATE`, `REFERENCES` and `TRIGGER` are removed from
   `anon` **and** `authenticated` on all six; `public.session_block_areas` becomes read-only to
   browser roles (it has **zero** direct application writes — every write already goes through
   `create_session_block_with_areas` / `update_session_block_with_areas` / `copy_session_setup`)
   with its `FOR ALL` policy narrowed to `SELECT`; and the 0128 studio-derive trigger is widened
   to cover `studio_id`, closing an anti-spoof gap.

**0159 drops nothing.** The 0119/0120 tables, columns, functions and triggers stay in place so
those migrations remain replayable, and the guards that *protect* the legacy artifact
(`guard_finalized_clinical_write` and its five triggers, `guard_snapshot_append_only`,
`guard_practitioner_finalized_refs`) are deliberately kept switched on. `sessions.record_status`
is kept because migration 0157 (whole-session copy) and 0123 (`soft_delete_session_area`) both
read it on live paths.

**Migration 0158 is intentionally skipped.** DRAFT PR #481 carries a different, superseded
migration under that number on a branch retained for audit evidence, and two artifacts must
never share a migration number.

## 4. No snapshot v2 is planned — and none was ever promised

There is **no** snapshot v2, no structured-area signed-correction framework, and no successor
format. These are retired, not deferred.

For the record: **no Hone document ever promised a "snapshot v2".** The phrase existed only in
inline comments inside a database test file, which has since been deleted along with the rest of
the finalization test surface. Nothing was walked back publicly, because nothing was ever
published.

## 5. The one legacy artifact

Production holds **exactly one** finalized session, verified read-only on 2026-07-29:

| Fact | Value |
|---|---|
| Finalized sessions | **1** of 76 (`void`: **0**) |
| Studio | `9d37c51a-6237-42ef-b9d3-28a567c2bfa8` — a **non-Willow controlled-test studio** |
| Finalized at | 2026-07-11T00:42:12Z |
| `clinical_record_snapshots` | **1 row**; its `content_hash` still re-derives to a **MATCH** |
| `clinical_record_amendments` | **0 rows** |
| `clinical_audit_events` | **0 rows** |
| Willow Electrolysis | **0** non-draft sessions — Willow never finalized anything |

That artifact is **retained, readable and unchanged**. It is deliberately **not deleted** and
its hash is deliberately **not regenerated**. It is legacy evidence of what was built and
exercised once under control; deleting it would destroy audit history, and regenerating it would
fabricate one. The owner keeps `EXECUTE` on `build_session_snapshot` purely so an operator can
still re-derive that hash for a read-only integrity check.

## 6. What was built, and why it is being retired

Migrations **0119** and **0120** built a genuine signed-record system: a finalization boundary
that froze a session and its attachments, a `build_session_snapshot` document builder, a
SHA-256 `content_hash` over that document, `clinical_record_snapshots` with version lineage,
`clinical_record_amendments`, a `clinical_audit_events` ledger scoped to
corrections/amendments, append-only RLS on all three, a narrow session-scoped correction
permit, and reliability/observability work on the amendment path (PR #402). Both studio flags
shipped **off**. Phase 1 was exercised exactly once, on a controlled test studio. Phase 2 was
never exercised at all.

It is being retired because it solves a problem Hone does not have, at a cost practitioners
should not pay. Electrologists in a one-location practice need to **correct a mis-charted
session quickly and truthfully**, not to sign it and then file a formal amendment against a
frozen snapshot. The Phase 2 workflow that would have made corrections usable was never
approved, and designing a full-chart correction workspace would have meant building a second,
heavier editing system on top of the one practitioners already use — while the finalize step
itself introduced a state in which ordinary charting silently stopped being editable. No
customer asked for signing, no regulator was cited as requiring it, and no legal review ever
established it as an obligation. Ordinary editable records with real audit trails, actor
attribution and timestamps meet the actual requirement.

The migrations stay in history, unreverted and replayable, so this paragraph and the artifact in
§5 remain legible to a future reader. Read 0119 and 0120 as **historical**: they record what was
built and once worked, not what Hone offers.

## 7. Reintroducing this would be a new decision, not a backlog item

Signed / finalized clinical records are **not on the backlog, not in any queue, and not gated
behind an authorization step someone can simply grant.** There is no roadmap ID to pick up.
Roadmap item **SEC-09** has been retired in place for exactly this reason.

Bringing any part of it back would require **all** of the following, in order:

1. a **new explicit product decision** by the product owner, recorded as its own decision
   record that supersedes this one;
2. an **architecture review** of the practitioner editing model as a whole — not a flag flip;
3. a **legal / privacy review** establishing an actual obligation or customer requirement;
4. a **migration plan** that drops the 0159 constraints and guards deliberately and states its
   effect on the retained legacy artifact;
5. **fresh acceptance** by the operator who would have to use it.

Nobody should read a `false` flag, an intact 0119/0120 object, or the retained legacy row as an
invitation. They are retirement artifacts.

---

## Related documents

- `supabase/migrations/0159_retire_signed_clinical_records.sql` — the enforcing migration.
- `tests/db/clinical-finalization-retired.db.test.ts` — the drift guard for every mechanism above.
- [`../production/current-state.md`](../production/current-state.md) §3 ·
  [`../production/capability-register.md`](../production/capability-register.md) §3 ·
  [`../production/known-limitations.md`](../production/known-limitations.md) L9/L10.
- [`../roadmap/CANONICAL_ROADMAP.md`](../roadmap/CANONICAL_ROADMAP.md) SEC-09 (retired in place) ·
  [`../roadmap/CAPABILITY_MANIFEST.json`](../roadmap/CAPABILITY_MANIFEST.json)
  (`clinical_finalization_amendments`, `retired: true`) ·
  [`../roadmap/WAVE1_DESIGN.md`](../roadmap/WAVE1_DESIGN.md) SAFE-WILLOW slice 7.
- [`../marketing/product-truth-register.md`](../marketing/product-truth-register.md) §2.
- **Unrelated, and deliberately untouched:**
  [`../clinical-notes-append-only-contract.md`](../clinical-notes-append-only-contract.md) —
  append-only clinical **notes** (`client_clinical_notes`, 0126/0127), where a
  correction/revision is a **new row**. That capability is live for all studios, has nothing to
  do with 0119/0120, and is not retired. Likewise untouched: append-only consent-signature
  immutability, database backups/snapshots, and Stripe webhook idempotency.
