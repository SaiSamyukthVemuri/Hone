---
type: product workflow
title: Client records and profile
description: How a practitioner creates, edits, archives and restores a client; the studio-scoped duplicate-email rule; the RLS posture that forbids hard deletes; tags, per-client pricing, birthday and the one-row-per-client budget context with its database-verified attribution and least-privilege grants; and how the client profile loads each tab's data only on that tab without ever showing an unread absence.
tags: [clients, profile, rls, archive, budget-context, tags, pii, tenancy]
verified:
  - by: openwiki/0.6.1
    at: 2026-10-02T23:09:08.246Z
sources:
  - id: openwiki-source-4b52e45d5796f3bdcf32b71a
    resource: repo://app/(app)/clients/%5Bid%5D/actions.ts
  - id: openwiki-source-e329b114b874972b15da35ab
    resource: repo://app/(app)/clients/%5Bid%5D/birthday-actions.ts
  - id: openwiki-source-a926d75fe8cbe36c54d5d382
    resource: repo://app/(app)/clients/%5Bid%5D/budget-context-actions.ts
  - id: openwiki-source-9d71aadf12fb246f73daea5b
    resource: repo://app/(app)/clients/%5Bid%5D/deferred-reads.ts
  - id: openwiki-source-b91feedc2bc2eb37cb8d10ac
    resource: repo://app/(app)/clients/new/actions.ts
  - id: openwiki-source-5e7461121f66dc301f87fcf7
    resource: repo://app/(app)/clients/page.tsx
  - id: openwiki-source-d317a8e7b5f60b4cf7143622
    resource: repo://components/profile-tab.ts
  - id: openwiki-source-ca9eabc24825e6ff0edc2967
    resource: repo://DESIGN.md
  - id: openwiki-source-d1bb41b0b82502d6cb461491
    resource: repo://lib/clients/birthday-queries.ts
  - id: openwiki-source-bf4a03832f84ac176dc48f73
    resource: repo://lib/supabase/queries.ts
  - id: openwiki-source-0479c4d807cfcaf49b8df86a
    resource: repo://supabase/migrations/0001_init.sql
  - id: openwiki-source-d8691c0fb64fa3927eac8c42
    resource: repo://supabase/migrations/0018_client_tags.sql
  - id: openwiki-source-c31e501b9d73297328118a68
    resource: repo://supabase/migrations/0032_stripe_connect_phase_1.sql
  - id: openwiki-source-145850af6530c7b69c614f99
    resource: repo://supabase/migrations/0087_clinical_rls_delete_hardening.sql
  - id: openwiki-source-9b751842bffb09fc45fbe260
    resource: repo://supabase/migrations/0183_client_budget_context.sql
  - id: openwiki-source-d8b9ac1fc0e05cae084a4a6f
    resource: repo://supabase/migrations/0184_client_budget_context_least_privilege.sql
  - id: openwiki-source-5eca4f466d3723514ceef3d2
    resource: repo://tests/app/clients/client-budget-context.test.ts
  - id: openwiki-source-7a84227cf0dee7e806f4e932
    resource: repo://tests/db/client-budget-context.db.test.ts
  - id: openwiki-source-afcb96435ef49b984d68196d
    resource: repo://tests/db/client-profile-read-failure-containment.db.test.ts
  - id: openwiki-source-839d2cb13015b5498e3aa574
    resource: repo://tests/db/client-profile-tab-behaviour.db.test.ts
  - id: openwiki-source-52f28e8aaa3e15e09967fd9f
    resource: repo://tests/db/client-profile-tab-queries.db.test.ts
generated: { by: "claude-code", at: "2026-10-02T22:34:57.394Z" }
---

# Client records and profile

A **client** row (`public.clients`) is the hub of a studio's records. Appointments, sessions, intake,
consent, notes, treatment plans, payments and portal access all reference it. It holds personal data:
name, pronouns, contact details, date of birth, address, Fitzpatrick type, allergies and emergency
contact. Every surface below is practitioner-only.

Related pages:

- [Clinical, pinned and personal notes](../treatment-memory/clinical-notes-and-client-notes.md) and
  [Treatment plans and treatment time](../treatment-memory/treatment-plans-and-treatment-time.md) for the
  profile's clinical tabs;
- [Intake forms and review](../portal/intake-forms-review-and-assisted-intake.md) for Health & Forms;
- [Client portal](../portal/client-portal-intake-and-consent.md) for portal access and messages.

## 1. Write path and tenancy

Client create, edit, archive, tag and pricing writes are **plain server actions over the user-scoped
(RLS) Supabase client**. They are not `SECURITY DEFINER` commands.

- **Studio comes from the session.** Each action derives the studio from the session
  (`getCurrentPractitionerWithStudio`).
- **Ownership is re-proven before a write.** Every action that targets an existing client first
  re-selects it by `(id, studio_id)` (`assertClientVisible` / `isClientVisible`) and then filters the
  write by both columns.
- **RLS is the backstop.** `0001` created `clients` with a members-only `FOR ALL` policy. `0087`
  replaced it with explicit SELECT, INSERT and UPDATE policies on `is_studio_member(studio_id)` and
  **no DELETE policy**, so a member cannot hard-delete a client through the API
  ([`0087` L1-L66](../../supabase/migrations/0087_clinical_rls_delete_hardening.sql#L1-L66)).
  The same migration removed delete from `client_tags`, `client_personal_notes` and the clinical
  history tables.

**Duplicate emails.** `0032` added a stored, generated `normalized_email` (trimmed and lower-cased) and
the partial unique index `clients_studio_normalized_email_uniq` on `(studio_id, normalized_email)`. A
studio can therefore hold at most one client per normalized email, while clients without email stay
legal. The reason was payment identity: a near-duplicate email must not yield a second client and a
second Stripe customer ([`0032` L278-L346](../../supabase/migrations/0032_stripe_connect_phase_1.sql#L278-L346)).

Create and update handle duplicates like this
(`app/(app)/clients/new/actions.ts` L49-L172, `app/(app)/clients/[id]/actions.ts` L182-L272):

- A **pre-flight lookup** tells the practitioner whether the colliding client is **active or
  archived**.
- A **`23505` on that index** means a concurrent write won the race. The action re-reads it and returns
  the same curated copy instead of throwing.
- Other failures return a generic message and log a structured event.

**`skin_notes` is retired as an editor.** Create and update no longer write `clients.skin_notes`. The
legacy column and its data are untouched, and new skin/hair observations go to the append-only
`client_clinical_notes` (see the notes page).

## 2. Archive instead of delete

`archiveClientAction` stamps `archived_at` and `archived_by` only `where archived_at is null`.
`unarchiveClientAction` clears both only where they are set. Each writes an `audit_logs` row
(`client_archived` / `client_unarchived`). An audit failure is logged and does **not** undo the archive
(`app/(app)/clients/[id]/actions.ts` L274-L389). The row and every foreign-key reference survive.

| Surface | Archived clients |
|---|---|
| Active list (`getClientsForStudio`), calendar quick-book picker, dashboard birthday surface | hidden (`archived_at is null`) |
| Archived view (`/clients?view=archived`, `getArchivedClientsForStudio`) | shown, most recently archived first, with one-click unarchive |
| Profile `/clients/[id]` | still resolves, so history stays reachable |

`0050` added the columns and a partial index on active clients
([`0050`](../../supabase/migrations/0050_clients_archive.sql)). The queries are in
[`lib/supabase/queries.ts` L275-L323](../../lib/supabase/queries.ts#L275-L323).

## 3. Tags, pricing and birthday

- **Tags** (`client_tags`, `0018`) are short labels (≤ 60 characters) that travel with the client.
  Removing one is a soft delete (`deleted_at`, `deleted_by`), so re-adding a label never conflicts. Since
  `0087` members have no DELETE policy on the table
  ([`0018`](../../supabase/migrations/0018_client_tags.sql)).
- **Per-client pricing** rows (`client_pricing`) are added and deleted by the profile actions, scoped by
  studio and client.
- **Birthday** (`updateClientBirthdayAction`) stores month and day in `clients.date_of_birth`. A new
  value uses the sentinel year 1900, and an existing real year is preserved. Birthday reads ignore the
  year and skip archived clients. The source comments forbid importing these modules from public,
  email, cron or Stripe surfaces.

## 4. Budget context (one current row per client)

`0183` moved budget from treatment plans to the client:
[`0183` L1-L155](../../supabase/migrations/0183_client_budget_context.sql#L1-L155),
[L300-L401](../../supabase/migrations/0183_client_budget_context.sql#L300-L401).

**Shape**

- `client_budget_context` uses `client_id` as its **primary key**, so "which budget is current?" has
  exactly one answer.
- `budget_level` is NULL or one of `no_stated_limit`, `somewhat_limited`, `severely_limited`.
- `budget_notes` is free text up to 20,000 characters, independent of the level.
- It is **mutable in place**, unlike the append-only clinical notes.

**Integrity**

- **Tenancy is structural.** A composite foreign key `(client_id, studio_id) → clients(id, studio_id)`
  backs a trigger that overwrites the caller's `studio_id` from the parent client. A separate trigger
  makes `client_id` immutable, even for `service_role`.
- **Attribution is verified by the database.** The insert and update policies require
  `updated_by_practitioner_id` to be an *active* practitioner in the row's studio whose `user_id` is
  `auth.uid()`. A member cannot write under a colleague's name, a cross-studio identity, or NULL.
- **Least privilege.** `0183` granted SELECT/INSERT/UPDATE but revoked only DELETE and TRUNCATE. Under
  Supabase's default privileges that left REFERENCES, TRIGGER and MAINTAIN with `authenticated`.
  `0184` revokes **all** privileges from every role and grants back exactly SELECT, INSERT and UPDATE to
  `authenticated`. It also strips EXECUTE from the three trigger functions
  ([`0184` L1-L112](../../supabase/migrations/0184_client_budget_context_least_privilege.sql#L1-L112)).

**What it is not.** It is planning documentation, not an affordability score. Per `0183`, nothing
reads it to change price, charges, availability or plan cadence, and it never appears on public
booking, the portal, email, SMS or receipts.

**Writer and proof.** `updateClientBudgetContextAction` is the single writer. It:

- refuses a tampered level rather than coercing it to NULL;
- does not trim notes;
- re-proves the client against the session's studio;
- upserts on `client_id`.

Proof:

- `tests/db/client-budget-context.db.test.ts`: one-row semantics, derived studio, attribution forgery
  cases A–F, `client_id` immutability;
- `tests/app/clients/client-budget-context.test.ts`: action validation and the single-writer rule;
- `e2e/client-budget-context.spec.ts`: the mobile flow.

The treatment-plan editor no longer sends or writes `treatment_plans.budget_notes`. Legacy plan notes
stay readable and labelled as such.

## 5. The client profile (`/clients/[id]`)

**Tabs.** `overview`, `sessions`, `treatment`, `messages`, `health`, `consultation` and `personal`, as
deep-linkable `?tab=` values ([`components/profile-tab.ts`](../../components/profile-tab.ts)).

**Per-tab reads (#612).** A tab no longer loads every tab's data. A skipped read returns a neutral
value, which looks the same as "loaded and empty". So `requireLoadedForTab` throws in development and
test whenever a tab renders data whose gate did not run. It returns immediately in production
(`app/(app)/clients/[id]/deferred-reads.ts` L1-L72).

The proof of record runs the real page as a signed-in practitioner against the local stack:

- `tests/db/client-profile-tab-queries.db.test.ts` captures every PostgREST request per tab;
- `tests/db/client-profile-tab-behaviour.db.test.ts` asserts the practitioner-visible text per tab.

Both also prove that **no profile query is issued when the client does not resolve** for the caller.

**Failure containment.** The overview's independent clinical reads are each contained at their own
edge. One failing read shows an "unavailable" state on its card and never blanks a sibling or reports
a confident absence. A failing notes summary is the exception: it still fails the page loudly
(`tests/db/client-profile-read-failure-containment.db.test.ts`). The read semantics are on
[Treatment memory reads](../treatment-memory/memory-reads-and-point-of-care.md).

**Other entry points on the profile.**

- Booking from the profile calls the calendar's `bookAppointmentForClientAction`, the practitioner
  booking path (see [Practitioner calendar](../scheduling/practitioner-calendar-move-and-capacity.md)).
- Sending the portal link and portal messages are service-role actions documented on the portal page.

## 6. Contradictions and open questions

1. **Raw database text can reach the practitioner.** `updateClientBudgetContextAction` returns
   `clientErr.message` and `Failed to save budget: ${error.message}` in its result. DESIGN.md LAW 7
   forbids internal codes in user-facing refusals. Thrown errors from the other client actions are
   redacted by Next in production; returned strings are not.
2. **Archive audit is best-effort.** An archive can succeed with no `audit_logs` row if the audit
   insert fails. Only a structured log records that.
