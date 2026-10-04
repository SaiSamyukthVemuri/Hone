---
type: product surface
title: Studio onboarding, settings and data portability
description: How a studio comes into existence and is set up — the operator-only New Studio Wizard (a new studio is born with its new-client admission authority initialized since 0205), owner invitations and team management, onboarding v2 and the getting-started checklist, the settings surfaces and the operator-controlled studio flags, treatment-image storage hardening, the export resource registry behind the studio data export, Quick Import, and the admin audit trail — with the recorded gaps in export, import atomicity, retention and image lifecycle.
tags: [studio, onboarding, settings, export, import, admin]
verified:
  - by: openwiki/0.6.1
    at: 2026-10-04T01:59:59.625Z
sources:
  - id: openwiki-source-ce3025c5d69ee786a5131976
    resource: repo://app/(app)/settings/data/actions.ts
  - id: openwiki-source-21101eb14ffbb4d64ac2d2db
    resource: repo://app/(app)/settings/import/actions.ts
  - id: openwiki-source-032982430374c85e558f9e28
    resource: repo://app/(app)/settings/team/actions.ts
  - id: openwiki-source-f26275dc8ebca94d5b1e6bd7
    resource: repo://app/admin/studios/new/actions.ts
  - id: openwiki-source-0a7f1727d82c9ac5dce569e4
    resource: repo://docs/production/known-limitations.md
  - id: openwiki-source-f79f369ce2044c952565dcb9
    resource: repo://docs/production/migration-ledger.md
  - id: openwiki-source-61fe720b788f1271e2851f73
    resource: repo://lib/audit/admin-actions.ts
  - id: openwiki-source-42990f8f33dbeb405bfb38a5
    resource: repo://lib/export/resource-registry.ts
  - id: openwiki-source-29e5fd2585f9eab92498041b
    resource: repo://lib/images/treatment-images.ts
  - id: openwiki-source-feb62495d9bbffb81b33420d
    resource: repo://lib/import/quick-import.ts
  - id: openwiki-source-fb8cf6186cb0e0ffa03f94dc
    resource: repo://lib/onboarding/state.ts
  - id: openwiki-source-01a21219f18228c7d4bc055d
    resource: repo://lib/studios/new-studio.ts
  - id: openwiki-source-cfb5ed29a9d135edce5fb027
    resource: repo://supabase/migrations/0007_pending_invitations.sql
  - id: openwiki-source-ac4e5c8f83094af104b922dd
    resource: repo://supabase/migrations/0093_harden_treatment_image_storage.sql
  - id: openwiki-source-87f9ee8798ff987eda6ce2de
    resource: repo://supabase/migrations/0136_practitioner_capacity_booking_flag.sql
  - id: openwiki-source-0f08b4c039851b1242896370
    resource: repo://supabase/migrations/0140_studio_onboarding.sql
  - id: openwiki-source-3db2567b429ae2564d61afad
    resource: repo://supabase/migrations/0205_new_studio_admission_default.sql
  - id: openwiki-source-bdc2db4ab677e7af8740782f
    resource: repo://tests/app/admin/new-studio-wizard.test.ts
  - id: openwiki-source-5621c90c322da5e0c1a68a8b
    resource: repo://tests/db/export-resource-registry.db.test.ts
  - id: openwiki-source-a122c291bea87f78ace90c43
    resource: repo://tests/db/new-studio-admission-default.db.test.ts
  - id: openwiki-source-fe4a22f4a0e3b3d561d283f4
    resource: repo://tests/db/new-studio-wizard.db.test.ts
generated: { by: "claude-code", at: "2026-10-04T01:59:59.625Z" }
---

# Studio onboarding, settings and data portability

There is **no self-serve studio creation**. An operator creates the studio and its owner invitation; the owner becomes a
practitioner only by signing in with the invited email and accepting the current terms (see
[Authentication, sessions and tenancy](../security/authentication-sessions-and-tenancy.md)).

Known limitation L8 records this posture: a studio cannot onboard itself, practitioner signup is invite-only, new
studios are provisioned through the operator runbook, and onboarding v2 is not broadly enabled
([`known-limitations.md` § L8](../../docs/production/known-limitations.md#l8--onboarding-and-self-service-gaps)).

## 1. Creating a studio (operator only)

`createStudioWithOwnerInvite` ([`app/admin/studios/new/actions.ts` L30-L229](../../app/admin/studios/new/actions.ts#L30-L229))
runs these steps:

1. **Re-checks `isAdmin`.** A non-admin caller is recorded as a `blocked` admin action and refused.
2. **Validates the input** with `parseNewStudioInput` ([`lib/studios/new-studio.ts` L20-L123](../../lib/studios/new-studio.ts#L20-L123)):
   the slug is lowercase alphanumeric plus hyphens, at most 64 characters, and not a reserved route name; the timezone
   must be a real IANA zone, defaulting to `America/Toronto`.
3. **Logs a `started` admin action.** The metadata holds the public slug only.
4. **Writes with the service-role client.** `studios` has no INSERT policy, and `pending_invitations` INSERT is
   owner-only, so the operator cannot do this through RLS.
   1. It pre-checks that the slug and the owner email are free.
   2. It inserts the `studios` row with safe defaults.
   3. It inserts a `pending_invitations` row with role `owner`. If that fails, it **deletes the new studio** to
      compensate, and logs the studio id if the cleanup fails too.
5. **Records the result.** It logs `succeeded` and emits a `studio_created` analytics event keyed only by studio id.
6. **Onboarding v2 only:** sets `onboarding_v2_enabled` and sends the welcome invitation email. Sending is best-effort;
   studio creation does not depend on it.

The two writes are **not one transaction**; atomicity relies on the compensating delete. The database test proves that
an ordinary authenticated user cannot insert a studio or an owner invitation, and that the service-role path leaves
**no** practitioner until `admin_accept_pending_invitation` runs, which then provisions exactly one active owner with
terms and privacy stamped ([`new-studio-wizard.db.test.ts` L31-L156](../../tests/db/new-studio-wizard.db.test.ts#L31-L156)).

### A new studio is born with its admission authority initialized (`0205`)

`0204` gave `new_client_admission_mode` a `not null default 'open'` but left `new_client_admission_mode_set_at` without
a default, and it reads `set_at IS NULL` as the marker of an unstamped pre-`0204` legacy row, which must cut over
through Waitlist before Open or Closed. A studio created after `0204` was therefore indistinguishable from a legacy row
([`0205` L1-L32](../../supabase/migrations/0205_new_studio_admission_default.sql#L1-L32)). `0205` fixes this with one
default and no logic change:

- `studios.new_client_admission_mode_set_at` now defaults to `now()`, so a studio inserted without the admission
  columns is born `open`, stamped, with `set_by` NULL: **system-initialized**, and its owner may choose any mode
  immediately ([L283-L297](../../supabase/migrations/0205_new_studio_admission_default.sql#L283-L297)). No function,
  trigger, policy or grant changes; the legacy transition guard still refuses genuinely unstamped rows, and an insert
  that explicitly writes `set_at = NULL` still reads as legacy.
- The column comments `0204` can no longer carry are replaced forward
  ([L300-L340](../../supabase/migrations/0205_new_studio_admission_default.sql#L300-L340)).
- **The wizard implements nothing.** It names none of the three admission fields and does not call
  `set_new_client_admission_mode`, so every future creation path that omits those columns inherits the same semantics;
  a source test pins the absence, with a non-vacuity check that the studio insert still exists
  ([`new-studio-wizard.test.ts` L149-L179](../../tests/app/admin/new-studio-wizard.test.ts#L149-L179)).
- **`set_by` NULL at creation is a convention, not an invariant.** The column has no foreign key and `studios` has no
  INSERT trigger, so a path that writes the admission columns explicitly is not refused
  ([L64-L111](../../supabase/migrations/0205_new_studio_admission_default.sql#L64-L111)).
- **A bounded apply-time repair** stamps only studios provably created between the `0204` and `0205` applies,
  identified by census membership rather than by the owner-mutable `created_at`, arming the admission guard's permit
  per row; it is idempotent ([L344-L380](../../supabase/migrations/0205_new_studio_admission_default.sql#L344-L380)).

Proof against the migrated database: a bare insert yields `open` / stamped / `set_by` NULL from the database clock; a
fresh owner can move straight to Open or Closed, and Waitlist records the owner; the legacy guard is unchanged for
unstamped rows; and the repair closes only its window
([`new-studio-admission-default.db.test.ts` L72-L107](../../tests/db/new-studio-admission-default.db.test.ts#L72-L107),
[L502-L637](../../tests/db/new-studio-admission-default.db.test.ts#L502-L637),
[L858-L972](../../tests/db/new-studio-admission-default.db.test.ts#L858-L972)). The migration ledger's current block
records `0205` as applied ([`migration-ledger.md`](../../docs/production/migration-ledger.md)). Admission behaviour
itself is on [New-client admission mode](../waitlist/new-client-admission-mode.md).

## 2. Team: invitations and removal

Every team action resolves its context with `getCurrentPractitionerWithStudio()` and requires `role === "owner"`.

**Invitations** (`app/(app)/settings/team/actions.ts` L81-L176):

- The invited role is `owner` or `practitioner`. The action refuses an email that is already an active practitioner or
  already has a pending invitation in the studio.
- It inserts through the RLS client.
- Only **one pending invitation per email can exist across all studios**: a partial unique index on `lower(email)
  where status = 'pending'` ([`0007` L20-L24](../../supabase/migrations/0007_pending_invitations.sql#L20-L24)). A
  collision is reported as "pending invite at another studio".
- The invitation email goes straight through the Resend client. A failure is logged and never fails the invitation; the
  row and the share-message UI are the source of truth.
- Revoking flips a pending row to `revoked`, scoped by id and studio.

**Removal** calls `set_practitioner_active_locked` through the service-role client
(`app/(app)/settings/team/actions.ts` L198-L232). The call takes the studio row and then the advisory lock, refuses to
deactivate the owner, and preserves the practitioner's appointments. An owner cannot remove themselves.

## 3. Onboarding v2 and the getting-started checklist

`0140` added `studios.onboarding_v2_enabled` (**default false**) and a per-studio `studio_onboarding` row holding
resumable wizard state, the celebration stamps and the welcome-email status
([`0140` L1-L36](../../supabase/migrations/0140_studio_onboarding.sql#L1-L36)).

**The flag is operator-controlled.** The `studios: owners update` policy lets an owner update any `studios` column, so a
`SECURITY INVOKER` guard trigger rejects any change to the flag from `anon` or `authenticated`
([L48-L70](../../supabase/migrations/0140_studio_onboarding.sql#L48-L70)). The same column-guard pattern protects the
practitioner-capacity flags (`0134`, `0136`) and the new-client admission mode (`0204`).

**Progress** (dismiss, skip, resume, complete) is written by the owner to their own `studio_onboarding` row under owner
RLS ([`lib/onboarding/state.ts` L10-L77](../../lib/onboarding/state.ts#L10-L77)). **`/getting-started`** is a mostly
auto-detected readiness checklist with no manual mark-as-done persistence (`app/(app)/getting-started/page.tsx`
L11-L19); studios with v2 off see only this checklist and the dashboard step counter.

## 4. Settings surfaces

`app/(app)/settings/` holds:

| Area | Subpages |
|---|---|
| Scheduling | `availability`, `booking`, `calendar`, `services` |
| Clinical and forms | `consent`, `intake` |
| Integrations and money | `integrations`, `payments`, `tracking` |
| Studio and people | `profile`, `studio`, `team`, `waitlist`, `launch` |
| Data | `data` (export), `import` (Quick Import) |

Each mutating action resolves the studio on the server, owner-only actions check the live role, and the service-role
ones are inventoried on [RLS, grants and SECURITY DEFINER commands](../security/rls-grants-and-security-definer.md).
Behaviour is documented on the page for each area:
[Practitioner calendar, move/reassign and capacity](../scheduling/practitioner-calendar-move-and-capacity.md) for
availability, [Payments, Stripe and appointment settlement](../payments/stripe-payments-and-settlement.md),
[Google Calendar sync](../integrations/google-calendar-sync.md),
[Client portal, intake and consent](../portal/client-portal-intake-and-consent.md) and
[New-client admission mode](../waitlist/new-client-admission-mode.md).

## 5. Treatment-image storage

Pure helpers in [`lib/images/treatment-images.ts` L1-L110](../../lib/images/treatment-images.ts#L1-L110):

- private bucket `treatment-images`;
- **60-second** signed URLs, minted per view and never stored;
- a 15 MB cap and a JPEG/PNG/WebP allowlist (no SVG);
- the client filename is used for display only;
- the storage path is built on the server as `<studio_id>/<client_id>/<server uuid>.<ext>` and is checked again against
  the caller's studio and the row's client **before** the service-role signer mints a URL.

`0093` hardened the trust boundary ([`0093` L1-L34](../../supabase/migrations/0093_harden_treatment_image_storage.sql#L1-L34)):
objects are service-role-only, with direct `authenticated` storage policies dropped; `CHECK` constraints bind the bucket
and path to the row's studio and client; a trigger enforces parent consistency and freezes identity columns after
insert; and step 1 forces the bucket private, but if the migration role lacks the privilege it only raises a notice
and asks the operator to confirm privacy in the dashboard
([L36-L43](../../supabase/migrations/0093_harden_treatment_image_storage.sql#L36-L43)). Image write commands are covered
on [Sessions, blocks and entries](../treatment-memory/sessions-blocks-and-entries.md).

## 6. The studio data export

`exportStudioDataAction` is **owner-only**; an inactive practitioner is refused. It reads through the RLS client and
returns a ZIP of CSVs (JSZip, base64) (`app/(app)/settings/data/actions.ts` L70-L83). The files come from the **export
resource registry** ([`lib/export/resource-registry.ts` L6-L67](../../lib/export/resource-registry.ts#L6-L67)).

**Every resource has exactly one disposition.** Resources are base tables in `public` plus storage buckets (namespaced
`storage:<id>`):

| Disposition | Meaning |
|---|---|
| `exported` | in the ZIP; the file, headers, included and excluded columns and row scope are declared |
| `excluded` | withheld on the record, with a reason |
| `pending` | studio-owned but **not yet exported**; carries a ticket and a tier, and is rendered on the Data settings page and in the in-ZIP manifest |

**Four views must agree**: the declared disposition, the SELECT actually sent, the CSV header and cells, and the
manifest counts; a disagreement fails a test. **The schema authority is the database**:
[`export-resource-registry.db.test.ts` L156-L400](../../tests/db/export-resource-registry.db.test.ts#L156-L400)
introspects the migrated local schema and fails when a live table or bucket has no disposition or a registry entry no
longer exists, when the included and excluded columns of an exported table do not exactly equal its live columns, or
when a credential-bearing table is marked anything other than permanently excluded. The registry deliberately states
no payload size; its entries are the count.

**Recorded status, L29 (P2, open):** the export is still partial; a large set of studio-owned resources is pending.
TRUTH-01A closed the *misrepresentation*, and TRUTH-01B, which changes the payload, has no merged PR
([`known-limitations.md` § L29](../../docs/production/known-limitations.md#l29--truth-01b-the-studio-data-export-is-still-partial-only-its-incompleteness-is-now-declared)).

## 7. Quick Import

The pipeline is pure ([`lib/import/quick-import.ts` L1-L26](../../lib/import/quick-import.ts#L1-L26)): it parses,
normalizes, groups and plans CSV/TSV into **history only** (`imported_treatment_memories`, never sessions or
appointments); it creates only, skipping duplicate clients and never false-merging; it caps an import at 2,000 rows; and
it never stores the raw pasted text. Both server actions first require an active **owner who also has platform-operator
standing** (`app/(app)/settings/import/actions.ts` L92-L119).

**Recorded status, L24:** confirmation is three independent writes with no transaction (the `import_batches` row, the
clients, the memories). The memory insert is retried once; if it still fails, the clients stay committed (`0087` forbids
deleting them), the batch is soft-voided, and the action reports the partial result honestly
(`app/(app)/settings/import/actions.ts` L229-L341). Execution is **mitigated** to operator-assisted runs, not fixed
([`known-limitations.md` § L24](../../docs/production/known-limitations.md#l24--quick-import-is-not-atomic-execution-is-mitigated-to-operator-assisted-only-not-fixed)).

## 8. Admin and ops tooling

`/admin` (operator allowlist; see the authentication page) provides the New Studio Wizard; per-studio views, including
a welcome-email resend; ops alerts, including resolve and a test critical alert; the admin audit view; and the payments
manual-review page.

Every admin action writes `admin_action_events` (`0113`) through `logAdminAction`, the only writer and reader
([`lib/audit/admin-actions.ts` L1-L30](../../lib/audit/admin-actions.ts#L1-L30)). Before storage it drops credential- or
PII-shaped metadata keys, keeps only primitive values, and runs the ops-alert redactor over what remains.

## 9. Related recorded limitations

| ID | Status as recorded |
|---|---|
| L27 | **P2 open**: no automated retention or permanent-deletion lifecycle. The published policy no longer promises timed deletion; sequenced after a complete export ([§ L27](../../docs/production/known-limitations.md#l27--f-ret-001-no-automated-retention-or-permanent-deletion-lifecycle-exists)) |
| L28 | **P2 open, partially mitigated**: upload compensates when its metadata insert fails; image archive is soft-only and no storage reconciler exists ([§ L28](../../docs/production/known-limitations.md#l28--treatment-image-archive-is-soft-only-and-no-storage-reconciler-exists)) |
| L31 | open, cosmetic: the onboarding celebration state is not scoped to the selected studio for a multi-studio owner ([§ L31](../../docs/production/known-limitations.md#l31--the-onboarding-celebrations-client-state-is-not-scoped-to-the-selected-studio)) |

## 10. Contradictions and open questions

1. **The wizard's comments describe the retired trigger path.**
   - The action header says the owner row "is created by the existing handle_new_user() trigger (migration 0081) on
     the owner's first invited sign-in, which stamps terms/privacy acceptance", and that there is "no email
     automation" ([`actions.ts` L22-L29](../../app/admin/studios/new/actions.ts#L22-L29),
     [L203-L204](../../app/admin/studios/new/actions.ts#L203-L204)).
   - Since `0141` that trigger is a no-op, and the same action sends the onboarding-v2 welcome email
     ([L213-L226](../../app/admin/studios/new/actions.ts#L213-L226)). `0205`'s header records that this stale
     attribution still exists elsewhere in the repository, outside its own change
     ([`0205` L117-L124](../../supabase/migrations/0205_new_studio_admission_default.sql#L117-L124)), and the wizard's
     source test title was corrected to "owner is provisioned at sign-in".
   - The wizard **database** test's header and `describe` title still say "the trigger links the owner"
     ([L9-L15](../../tests/db/new-studio-wizard.db.test.ts#L9-L15),
     [L63](../../tests/db/new-studio-wizard.db.test.ts#L63-L63)), while its body asserts the opposite and provisions
     through explicit acceptance.
2. **Raw database messages reach the wizard's redirect URL.** Failure paths put `error.message` text into the `?error=`
   query string ([L97](../../app/admin/studios/new/actions.ts#L97-L97),
   [L149](../../app/admin/studios/new/actions.ts#L149-L149),
   [L189](../../app/admin/studios/new/actions.ts#L189-L189)). The duplicate-invitation message also embeds the owner
   email. The surface is operator-only, but those values land in browser history.
3. **Team invitation email bypasses the shared send path.** It calls the Resend client directly, with no idempotency key
   and no bounded timeout (`app/(app)/settings/team/actions.ts` L48-L79), unlike the wrappers on
   [Email delivery](../communications/email-delivery.md). Whether this is intentional is not recorded.
4. **The studio row is protected per column, not by a column grant.** An owner may update any `studios` column that no
   guard trigger protects. Whether every operator-only column has a guard is not pinned by a single test located for
   this page; `0205` adds that `studios` has no INSERT trigger at all, so creation-time values are unvalidated.
