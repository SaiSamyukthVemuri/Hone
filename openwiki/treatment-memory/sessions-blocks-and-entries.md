---
type: write authority
title: "Sessions, blocks and entries: charting write authority"
description: The charting data model — sessions, settings blocks with multi-area laterality, electrolysis and laser entries, treatment images — and how every clinical write now goes through narrow authenticated SECURITY DEFINER commands after direct browser DML was revoked; immutable lineage, soft delete and audit; and the permanently retired signed/finalized record system and what the database enforces about it.
tags: [charting, sessions, write-authority, security-definer, lineage, retired-capability, treatment-memory]
verified:
  - by: openwiki/0.6.1
    at: 2026-10-04T01:59:59.625Z
sources:
  - id: openwiki-source-293e361099157076c0158b5d
    resource: repo://docs/decisions/clinical-finalization-retired.md
  - id: openwiki-source-bfba408becb24a991aa5465b
    resource: repo://lib/sessions/block-areas.ts
  - id: openwiki-source-643a4b7c29a04cd5444e6b93
    resource: repo://lib/sessions/session-command-errors.ts
  - id: openwiki-source-aa8c861bd11932a3bea26091
    resource: repo://supabase/migrations/0008_session_audit.sql
  - id: openwiki-source-5bb8e2602fc26e7e6730c8bd
    resource: repo://supabase/migrations/0111_client_portal_access_events.sql
  - id: openwiki-source-9105c90f434bdbe6bf56f8f0
    resource: repo://supabase/migrations/0113_admin_action_events.sql
  - id: openwiki-source-762c97c6c9dc12e43fa89d5c
    resource: repo://supabase/migrations/0128_session_block_areas.sql
  - id: openwiki-source-8b879c6068994f8c93119d0d
    resource: repo://supabase/migrations/0129_atomic_session_block_area_writes.sql
  - id: openwiki-source-bc3bc1424cb3a62d2723dbf3
    resource: repo://supabase/migrations/0157_whole_session_copy_setup.sql
  - id: openwiki-source-8c3262662e762dc5ed158150
    resource: repo://supabase/migrations/0159_retire_signed_clinical_records.sql
  - id: openwiki-source-30635851be7bee2a1954485c
    resource: repo://supabase/migrations/0160_immutable_clinical_lineage.sql
  - id: openwiki-source-2df2dc8be36a29f6df725e3d
    resource: repo://supabase/migrations/0166_session_block_electrolysis_commands.sql
  - id: openwiki-source-5770b58d79a1bb8d44cf83b5
    resource: repo://supabase/migrations/0169_revoke_authenticated_clinical_direct_dml.sql
  - id: openwiki-source-cf30cf78074c56edc357b806
    resource: repo://supabase/migrations/0178_practitioner_identity_boundary.sql
  - id: openwiki-source-f05b4e7cd8d0ec9beaf8ddc5
    resource: repo://tests/db/immutable-clinical-lineage.db.test.ts
  - id: openwiki-source-00dbf77641fc5a104589e4dc
    resource: repo://tests/db/session-write-commands.db.test.ts
generated: { by: "claude-code", at: "2026-10-04T01:59:59.625Z" }
---

# Sessions, blocks and entries: charting write authority

## 1. The model

| Table | Holds | Notes |
|---|---|---|
| `sessions` | one encounter for one client: modality (`electrolysis` or `laser`), started and ended, performer, price, next-visit note, aftercare stamp, `record_status`, soft-delete columns | created by `start_session`, which may coalesce into an existing row |
| `session_blocks` | one **settings block**: machine and probe setup, area, numbing, tolerance and response, caution | soft-deleted, never hard-deleted by the app |
| `session_block_areas` (`0128`) | several treated **areas per block, each with its own laterality** | authoritative when present; otherwise the legacy `primary_area` + `side` |
| `electrolysis_entries` | individual **passes**: readings, hairs, chips, comments | composite FK `(session_id, block_id)` |
| `laser_entries` | laser zones and observations | — |
| `treatment_images` | photo metadata; the bytes live in private storage | see [Studio onboarding, settings and data portability](../studio/onboarding-settings-and-data-portability.md#5-treatment-image-storage) |

**Area contract** ([`lib/sessions/block-areas.ts` L1-L40](../../lib/sessions/block-areas.ts#L1-L40);
[`0128` L1-L24](../../supabase/migrations/0128_session_block_areas.sql#L1-L24)):

- **Read:** child rows win over the legacy single area.
- **Write:** writes the child rows **and** a legacy projection — `primary_area` is the first area, and `side`
  is set only when every area shares one side.
- **Tenancy:** `studio_id` on area rows is trigger-derived from the parent block, so it cannot be spoofed.

How this history is read back is on [Treatment memory reads and point-of-care memory](memory-reads-and-point-of-care.md).
Settings fields and probe lots are on [Probes, settings and record keeping](probes-settings-and-record-keeping.md).

## 2. Write authority: commands only

Known limitation **L18** recorded that a member's browser JWT could INSERT, UPDATE or DELETE the clinical tables
directly through PostgREST, outside every application command. It was closed in two stages:

1. **`0164`–`0168` (additive).** Every runtime writer moved behind narrow `SECURITY DEFINER` commands:

   | Migration | Commands |
   |---|---|
   | `0164` | `create_laser_entry` |
   | `0166` | `create_block_with_entry`, `update_block_with_entry`, `add_electrolysis_pass`, `soft_delete_session_block` |
   | `0167` | `start_session`, `set_session_price`, `set_next_session_note`, `set_session_performer`, `edit_session_started_at`, `soft_delete_session`, `set_session_treatment_plan`, `set_session_aftercare_explained` |
   | `0168` | `create_treatment_image_metadata`, `set_treatment_image_note`, `archive_treatment_image` |

   ([`0166` L60-L78](../../supabase/migrations/0166_session_block_electrolysis_commands.sql#L60-L78))
2. **`0169` (cutover).** Revoked INSERT, UPDATE and DELETE from `authenticated` on all six clinical tables and
   kept SELECT. It changed no function grant
   ([`0169` L1-L83](../../supabase/migrations/0169_revoke_authenticated_clinical_direct_dml.sql#L1-L83)).

**Command properties:**

- **Authenticated-callable and bound to `auth.uid()`.** The actor is resolved inside the database
  (`session_actor_practitioner`, `assert_session_studio_for_actor`, `assert_session_writable`), so the browser
  supplies no identity to forge.
- **Composed, not duplicated.** The block commands call the `0129` block-with-areas RPCs internally, so there is
  one area-write path, and a block, its areas, its first entry, the probe link and the chips commit or roll back
  together.
- **Safe errors.** Known raised sentences map to fixed practitioner copy, and anything else becomes one generic
  message ([`session-command-errors.ts` L1-L50](../../lib/sessions/session-command-errors.ts#L1-L50)).
- **Explicit studio for multi-studio users.** `start_session` takes an explicit, re-proved studio since `0181`; see
  [Authentication, sessions and tenancy](../security/authentication-sessions-and-tenancy.md#4-where-a-studio-id-crosses-into-the-database).

DB proof ([`session-write-commands.db.test.ts` L84-L500](../../tests/db/session-write-commands.db.test.ts#L84-L500)):

- authorized writes succeed, and `edit_session_started_at` writes its audit row in the same transaction;
- cross-studio sessions, mismatched clients, other studios' performers, plans and appointments are refused;
- unauthenticated and inactive callers are refused, and soft delete derives `deleted_by` from the actor;
- EXECUTE is held by `authenticated` **only**, with helpers ungranted, `SECURITY DEFINER` and an empty
  `search_path`;
- direct table DML is revoked.

The static census keeps runtime direct DML on these tables at zero (`tests/security/entry-direct-dml-guard.test.ts`;
see [Source, docs and security guards](../testing/source-docs-and-security-guards.md)).

## 3. Immutable lineage (`0160`)

Within one studio, RLS cannot stop a member re-pointing a session at a different client, or a block at another
client's encounter, because the studio predicate still holds. `0160` adds UPDATE guards that make **lineage**
immutable for every role:

- `sessions.client_id` and `studio_id`;
- `session_blocks.session_id` and `studio_id`;
- each entry's session and block;
- the image parents (already guarded by `0093`).

Notes, settings, areas, passes and timings stay editable. A mis-filed session is corrected by **soft-delete and
re-chart**, which leaves an actor-attributed trail
([`0160` L1-L46](../../supabase/migrations/0160_immutable_clinical_lineage.sql#L1-L46)).

[`immutable-clinical-lineage.db.test.ts` L54-L447](../../tests/db/immutable-clinical-lineage.db.test.ts#L54-L447)
proves:

- refusals for the browser role, `service_role` and an owner, including the block case with no entries;
- that INSERT still establishes lineage;
- that soft-delete plus re-chart works;
- that `ON DELETE SET NULL` cascades still run, while a cleared `block_id` cannot be re-pointed.

`0160` also records why migrations now open their own transaction. `supabase db push` does not wrap a file, so a
bare `SET LOCAL lock_timeout` never arms and the file is not atomic
([L49-L70](../../supabase/migrations/0160_immutable_clinical_lineage.sql#L49-L70)).

## 4. The retired signed/finalized record system

**Decision (accepted):** Hone will **not** offer signed or cryptographically finalized clinical
records. That rules out:

- practitioner-signed snapshots;
- immutable finalized records;
- a successor snapshot format;
- product clinical hashes;
- signed-record corrections and amendments.

This is **terminal**, not deferred. Sessions are ordinary, editable records
([`docs/decisions/clinical-finalization-retired.md`](../../docs/decisions/clinical-finalization-retired.md)).

What `0159` makes the **database** enforce ([`0159` L1-L66](../../supabase/migrations/0159_retire_signed_clinical_records.sql#L1-L66)):

1. **Both flags pinned false.** `CHECK` constraints force `studios.clinical_finalization_enabled` and
   `clinical_corrections_enabled` false. Without them an owner could switch the feature on through the
   `owners update` policy.
2. **Retired RPCs unreachable.** EXECUTE is revoked on the four retired RPCs (finalize, correct, amend, and amend
   with image) from every runtime role, along with the snapshot builder and the five correction appliers.
3. **No entry into the retired lifecycle.** A transition guard refuses any change of `sessions.record_status`
   *into* `finalized` or `void`. Existing rows are untouched.
4. **No new signed artifact.** INSERT is blocked on the three signed-record ledgers, which were already immutable
   to UPDATE and DELETE. `TRUNCATE`, `REFERENCES` and `TRIGGER` are revoked on them.
5. **Browser privileges hardened.** `anon` loses every write on the six clinical tables, `authenticated` loses
   `TRUNCATE`, `REFERENCES` and `TRIGGER`, and `session_block_areas` becomes SELECT-only to browser roles.

The objects of `0119` and `0120` are **kept**, not dropped, so history replays and any legacy artifact stays
protected by its guards. `record_status` is kept because live features read it: the whole-session copy needs a
`draft` target and excludes `void` sources, and area soft-delete checks it.

**Retained:** ordinary audit trails, actor attribution, timestamps and treatment-history integrity. The decision
document lists the active audit tables — `session_audit`, `record_keeping_audit_events`, `session_copy_operations`,
`admin_action_events` and `client_portal_access_events`. `clinical_audit_events`, despite its name, belongs to the
retired system ([§ 2. What is explicitly NOT given up](../../docs/decisions/clinical-finalization-retired.md#2-what-is-explicitly-not-given-up)).

## 5. Contradictions and open questions

1. **The old block-with-areas RPCs are still directly callable.**
   - `create_session_block_with_areas` and `update_session_block_with_areas` (`0129`, latest bodies `0156`) are
     still EXECUTE-granted to `authenticated` **and** `service_role`
     ([`0129` L164-L171](../../supabase/migrations/0129_atomic_session_block_area_writes.sql#L164-L171)), and no later
     migration revokes them.
   - The application now calls only the `0166` commands, which compose them.
   - `0169`'s header says every clinical write command is authenticated-only with `service_role` denied
     ([L25-L26](../../supabase/migrations/0169_revoke_authenticated_clinical_direct_dml.sql#L25-L26)). These two
     remain a second, older browser-reachable path that writes blocks and areas without an entry.
2. **The migrations disagree on how to revoke.** `0169` deliberately avoids `REVOKE ALL` because it "would
   silently absorb any future privilege type" ([L61-L63](../../supabase/migrations/0169_revoke_authenticated_clinical_direct_dml.sql#L61-L63)).
   `0178` and known limitation L19 prescribe the opposite — revoke all, then grant back — so that a new privilege
   such as PostgreSQL 17's `MAINTAIN` cannot survive. See
   [RLS, grants and SECURITY DEFINER commands](../security/rls-grants-and-security-definer.md).
3. **`service_role` keeps full DML and `TRIGGER` on the clinical tables.** `0169` changed only `authenticated`.
   Known limitation L20, recorded open, notes that `service_role` could attach a trigger that defeats the `0160`
   guards. It is not reachable from the application.
