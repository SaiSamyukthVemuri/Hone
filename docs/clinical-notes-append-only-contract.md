# Clinical notes — append-only + access contract

Scope: `public.client_clinical_notes` (migration 0126; author-INSERT policy
corrected in migration 0127). Dedicated dated **consultation** and **skin/hair
analysis** clinical records. Practitioner-facing, studio-scoped, append-only.

## Append-only

- Saved notes are **never overwritten in place**. A correction/revision is a
  **new row** linked to the prior note via `supersedes_note_id`; the original
  row is preserved.
- In-place `UPDATE` is blocked for **every** role by the `BEFORE UPDATE`
  trigger `client_clinical_notes_no_update` (an unconditional `RAISE`). It is a
  plain `SECURITY INVOKER` trigger, so it fires for `service_role` and
  `postgres` too — there is **no service-role bypass of the no-overwrite rule**.
- At most one direct successor per note is allowed (partial-unique index on
  `supersedes_note_id`), so a concurrent duplicate revision is rejected as a
  stale-revision conflict rather than silently forking history.

## Deletion (accepted teardown contract)

- **Authenticated application users cannot `DELETE`** (no `DELETE` grant to
  `authenticated`; `anon` has no grant at all).
- `service_role`/`postgres` **retain hard-delete capability**. This is
  deliberate and required so a parent `clients` / `studios` / `practitioners`
  removal can `CASCADE` these rows during controlled administrative or
  tenant-teardown operations. No delete-blocking trigger is added, because that
  would also break the required parent-cascade teardown path.
- The **application clinical-note actions never use the service-role/admin
  client** — they run under the RLS-scoped authenticated client
  (`@/lib/supabase/server`), so no application code path can delete or overwrite
  a note. This is enforced by a source guard
  (`tests/source-guards/clinical-notes-guards.test.ts`).

## Tenant isolation (RLS + structural)

- **Read:** `client_clinical_notes_member_select` — studio members read only
  their own studio's notes (`is_studio_member(studio_id)`).
- **Insert:** `client_clinical_notes_author_insert` (0127) — the caller must be
  a member of the note's studio **and** the note must be attributed to *their
  own active practitioner in that same studio*. Migration 0127 fixed a 0126
  defect where an unqualified `studio_id` inside the practitioner subquery
  shadow-bound to `practitioners.studio_id` (a tautology); the clause is now the
  fully-qualified `p.studio_id = client_clinical_notes.studio_id`, so the
  same-studio-practitioner boundary is enforced **at the RLS layer**, not only
  by the composite FK.
- **Structural backstops:** `studio_id` is trigger-derived from the parent
  client (anti-spoof); composite FKs `(client_id, studio_id) → clients` and
  `(practitioner_id, studio_id) → practitioners` enforce same-studio integrity;
  a revision must match the superseded note's client, studio, and kind
  (trigger-validated).

## Exposure

- No `portal` / public-booking / email / SMS / receipt / Google-Calendar path
  reads or writes this table (import audit + grants). It is authenticated
  practitioner UI + a print/export view only.
