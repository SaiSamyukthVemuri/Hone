---
type: data model
title: Clinical notes, pinned notes and personal notes
description: The three practitioner note stores on a client and how each is guarded — append-only dated clinical notes (consultation and skin/hair analysis) with revision-by-supersession, author-bound RLS and a no-update trigger; short pinned safety notes edited through a scoped service-role update with optimistic concurrency; and one-row practitioner-only personal notes and private warnings — plus where they surface, how they are proved, and the open edges.
tags: [treatment-memory, clinical-notes, pinned-notes, personal-notes, append-only, rls, privacy]
verified:
  - by: openwiki/0.6.1
    at: 2026-10-02T22:34:57.394Z
sources:
  - id: openwiki-source-3756b26543e238d254da3bc1
    resource: repo://app/(app)/clients/%5Bid%5D/clinical-notes-actions.ts
  - id: openwiki-source-e9a5c5af1259f0ea2251d740
    resource: repo://app/(app)/clients/%5Bid%5D/personal-notes-actions.ts
  - id: openwiki-source-95f0e21090260281abf1f20e
    resource: repo://app/(app)/clients/%5Bid%5D/pinned-notes-actions.ts
  - id: openwiki-source-c26a7361bdb939bbbbd365bd
    resource: repo://docs/clinical-notes-append-only-contract.md
  - id: openwiki-source-3dbaeb70d9c4055c7035bdd7
    resource: repo://lib/clinical-notes/queries.ts
  - id: openwiki-source-9b527d3f0c7d17cbc55e4265
    resource: repo://supabase/migrations/0022_client_pinned_notes.sql
  - id: openwiki-source-4b6d6aec2b9198ba459d6034
    resource: repo://supabase/migrations/0035_client_personal_notes.sql
  - id: openwiki-source-f9c8faef3c4a1b8df2f26d0b
    resource: repo://supabase/migrations/0126_client_clinical_notes.sql
  - id: openwiki-source-7edf6b0c10fe95ead4a9b25d
    resource: repo://supabase/migrations/0127_fix_client_clinical_notes_author_insert_policy.sql
  - id: openwiki-source-ea326e020fbfc98cf4b6e985
    resource: repo://supabase/migrations/0179_actor_fk_integrity.sql
  - id: openwiki-source-d8b9ac1fc0e05cae084a4a6f
    resource: repo://supabase/migrations/0184_client_budget_context_least_privilege.sql
  - id: openwiki-source-ad9afb78fefb7755c49a84f9
    resource: repo://tests/db/client-clinical-notes.db.test.ts
  - id: openwiki-source-3ea2b4cb44bae516b82dfe9d
    resource: repo://tests/source-guards/clinical-notes-guards.test.ts
generated: { by: "claude-code", at: "2026-10-02T22:34:57.394Z" }
---

# Clinical notes, pinned notes and personal notes

A client carries three kinds of practitioner-written notes. They have **different integrity contracts**,
and the difference is deliberate:

| Store | What it is | Mutability | Write path |
|---|---|---|---|
| `client_clinical_notes` (`0126`, `0127`) | dated **consultation** and **skin/hair analysis** clinical records | **append-only**: a correction is a new row that supersedes the old one | RLS-scoped user client only |
| `client_pinned_notes` (`0022`) | short (≤ 200 characters) safety or operational reminders shown on profile, appointment and dashboard | add, edit in place, remove | add/remove through RLS; **edit through a scoped service-role update** |
| `client_personal_notes` (`0035`) | one row per client: `personal_notes` and `private_warnings` (relationship memory, boundary notes), each ≤ 20,000 characters | mutable in place (upsert) | RLS-scoped user client |

None of them is read by public booking, the portal, email, SMS, cron or Stripe paths. The profile tabs
that render them are described on [Client records and profile](../clients/client-records-and-profile.md).

## 1. Clinical notes: append-only by construction

Contract: [`docs/clinical-notes-append-only-contract.md`](../../docs/clinical-notes-append-only-contract.md).
Mechanism: [`0126`](../../supabase/migrations/0126_client_clinical_notes.sql#L26-L171).

- **Shape.**
  - `kind` is `consultation` or `skin_hair_analysis`, and the body must be non-blank.
  - `occurred_at` is the clinical date, separate from `created_at`.
  - `areas` are optional tags.
- **No overwrite, for any role.** `client_clinical_notes_no_update` is a plain `BEFORE UPDATE` trigger
  that always raises, so even `service_role` and `postgres` cannot edit a saved note.
  `authenticated` also lacks UPDATE, DELETE and TRUNCATE privileges, and `anon` has nothing.
- **Revision = supersession.**
  - A correction is a new row with `supersedes_note_id`.
  - The insert trigger requires the superseded note to have the same client, studio and kind.
  - A partial unique index allows **one** direct successor per note, so a concurrent second revision
    fails with `23505` instead of forking history.
- **Tenancy is structural.**
  - The insert trigger derives `studio_id` from the parent client, overwriting whatever the caller sent.
  - Composite foreign keys tie `(client_id, studio_id)` and `(practitioner_id, studio_id)` to the same
    studio.
- **Authorship is enforced by RLS.** The insert policy requires `practitioner_id` to be the caller's
  *own active* practitioner in the note's studio. `0127` fixed a `0126` defect where an unqualified
  `studio_id` in that subquery bound to `practitioners.studio_id`, which made the check a tautology
  ([`0127`](../../supabase/migrations/0127_fix_client_clinical_notes_author_insert_policy.sql#L33-L51)).
- **Author deletion.** `0179` changed the author foreign key from `ON DELETE CASCADE` to `RESTRICT`, so
  deleting a practitioner can no longer destroy their notes
  ([`0179` L496-L520](../../supabase/migrations/0179_actor_fk_integrity.sql#L496-L520)).

**Writers.** `addClinicalNoteAction` and `reviseClinicalNoteAction` in
`app/(app)/clients/[id]/clinical-notes-actions.ts` are the only authenticated write surfaces. They:

- run under the user client, never the admin client;
- force `practitioner_id` to the signed-in practitioner;
- confirm the stored row with a **separate read-back** before reporting success;
- map `23505` on the supersession index to a distinct `stale_revision` conflict, with no silent retry.

**Reads.** `lib/clinical-notes/queries.ts` is server-only and RLS-scoped. "Current" is the newest
**non-superseded** row of a kind, and history marks superseded rows. The print view
(`/clients/[id]/clinical-notes/print`) is a read-only authenticated route.

**Proof:**

- `tests/db/client-clinical-notes.db.test.ts`:
  - UPDATE is refused even on the bypass-RLS admin path, and DELETE is refused;
  - revision semantics and concurrent stale revisions;
  - cross-studio reads and inserts are refused, and a spoofed `studio_id` is overridden;
  - authors cannot be impersonated;
  - the `0127` cases (inactive practitioner, multi-studio attribution).
- `tests/source-guards/clinical-notes-guards.test.ts` pins the trust boundary and an import audit:
  no email, SMS, Stripe, portal or booking module imports clinical notes.
- `e2e/clinical-notes.spec.ts` covers add, revise and export on mobile. It also checks that the legacy
  `clients.skin_notes` text is read-only and outranked by the canonical record.

## 2. Pinned notes: mutable reminders, guarded in the action

`0022` gave `client_pinned_notes` SELECT, INSERT and DELETE policies keyed on the caller's active
practitioner studios, and **no UPDATE policy**. Its header says notes are changed by "remove and re-add"
([`0022`](../../supabase/migrations/0022_client_pinned_notes.sql)).

Editing exists now (`editClientPinnedNoteAction` in `app/(app)/clients/[id]/pinned-notes-actions.ts`).
Because RLS cannot update, it uses the **service-role** client and enforces the boundary explicitly:

- the update matches `(id, studio_id = the session's studio, client_id)`;
- it also matches `text = original_text`, an optimistic-concurrency guard, so a concurrent edit or a
  foreign note matches zero rows and is refused;
- `text` is the only column written.

Add and remove use the RLS-scoped client. The dashboard bulk-loads pinned notes for the selected day's
clients (see [Dashboard](../owner/dashboard-financials-and-capacity.md)).
`tests/source-guards/pinned-note-edit-guards.test.ts` and `e2e/pinned-note-edit-mobile.spec.ts` pin the
edit contract.

## 3. Personal notes and private warnings

`client_personal_notes` holds one row per client, enforced by a unique `client_id`
([`0035`](../../supabase/migrations/0035_client_personal_notes.sql#L1-L75)):

- the row is created lazily;
- `studio_id` is trigger-derived from the parent client;
- RLS is studio membership;
- since `0087` there is no DELETE policy.

`updateClientPersonalNotesAction` upserts both fields under the user client with a 20,000-character
cap. It does not trim, because leading whitespace is structure. `lib/notes/bullets.ts` adds plain-text
bullet editing to the textarea, with no HTML or Markdown, and never auto-converts saved notes. It is pinned by `personal-notes-bullets-guards.test.ts` and `e2e/personal-notes-bullets-mobile.spec.ts`.

## 4. Contradictions and open questions

1. **Pinned notes: design intent vs current path.** `0022` says "no edit-in-place … remove and re-add".
   The application now edits in place through the service role, because no UPDATE policy was ever
   added. The scoping is explicit and tested, but the database does not express it.
2. **The contract document predates `0179`.** It says `service_role` keeps hard-delete so that removing
   a parent `practitioners` row can cascade these notes. `0179` made the author foreign key
   `ON DELETE RESTRICT`, so deleting a practitioner who authored notes is now refused. Client and studio
   teardown still cascade.
3. **Name-and-revoke grants.** `0126` grants SELECT/INSERT to `authenticated` and revokes only UPDATE,
   DELETE and TRUNCATE. `0184` later showed that this pattern leaves REFERENCES, TRIGGER and MAINTAIN
   in place under Supabase's default privileges, and repaired it for `client_budget_context` only.
   Nothing in the repository re-checks `client_clinical_notes` for those privileges.
