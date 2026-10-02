---
type: product subsystem
title: Studio onboarding, settings and data portability
description: How a studio comes into existence and is set up — the operator-only New Studio Wizard, owner invitations and team management, onboarding v2 and the getting-started checklist, the settings surfaces and the operator-controlled studio flags, treatment-image storage hardening, the export resource registry behind the studio data export, Quick Import, and the admin audit trail — with the recorded gaps in export, import atomicity, retention and image lifecycle.
tags: [onboarding, studio-setup, team, invitations, data-export, quick-import, treatment-images, admin]
verified:
  - by: openwiki/0.6.1
    at: 2026-10-02T20:08:11.217Z
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
  - id: openwiki-source-5621c90c322da5e0c1a68a8b
    resource: repo://tests/db/export-resource-registry.db.test.ts
  - id: openwiki-source-fe4a22f4a0e3b3d561d283f4
    resource: repo://tests/db/new-studio-wizard.db.test.ts
generated: { by: "claude-code", at: "2026-10-02T20:08:11.217Z" }
---

# Studio onboarding, settings and data portability

There is **no self-serve studio creation**. An operator creates the studio and its owner invitation; the
owner becomes a practitioner only by signing in with the invited email and accepting the current terms (see
[Authentication, sessions and tenancy](../security/authentication-sessions-and-tenancy.md)).

Known limitation L8 records this posture: invite-only, operator-provisioned, onboarding v2 enabled only on the
<!-- openwiki: broken internal link [../../docs/production/known-limitations.md#L178-L187] heading anchor "L178-L187" does not exist in "../../docs/production/known-limitations.md". Fix the href or restore the target, then delete this comment. -->
controlled test studio ([`known-limitations.md` L178-L187](../../docs/production/known-limitations.md#L178-L187)).

## 1. Creating a studio (operator only)

`createStudioWithOwnerInvite` ([`app/admin/studios/new/actions.ts` L30-L229](../../app/admin/studios/new/actions.ts#L30-L229))
runs these steps:

1. **Re-checks `isAdmin`.** A non-admin caller is recorded as a `blocked` admin action and refused.
2. **Validates the input** with `parseNewStudioInput`
   ([`lib/studios/new-studio.ts` L20-L123](../../lib/studios/new-studio.ts#L20-L123)):
   - the slug is lowercase alphanumeric plus hyphens, at most 64 characters, and not a reserved route name;
   - the timezone must be a real IANA zone, defaulting to `America/Toronto`.
3. **Logs a `started` admin action.** The metadata holds the public slug only.
4. **Writes with the service-role client.** `studios` has no INSERT policy, and `pending_invitations` INSERT is
   owner-only, so the operator cannot do this through RLS.
   1. It pre-checks that the slug and the owner email are free.
   2. It inserts the `studios` row with safe defaults.
   3. It inserts a `pending_invitations` row with role `owner`. If that fails, it **deletes the new studio** to
      compensate, and logs the studio id if the cleanup fails too.
5. **Records the result.** It logs `succeeded` and emits a `studio_created` analytics event keyed only by
   studio id.
6. **Onboarding v2 only:** sets `onboarding_v2_enabled` and sends the welcome invitation email. Sending is
   best-effort; studio creation does not depend on it.

The two writes are **not one transaction**. Atomicity relies on the compensating delete.

The DB test proves two things
([`new-studio-wizard.db.test.ts` L31-L156](../../tests/db/new-studio-wizard.db.test.ts#L31-L156)):

- an ordinary authenticated user cannot insert a studio or an owner invitation;
- the service-role path leaves **no** practitioner until `admin_accept_pending_invitation` runs, which then
  provisions exactly one active owner with terms and privacy stamped.

## 2. Team: invitations and removal

Every team action resolves its context with `getCurrentPractitionerWithStudio()` and requires
`role === "owner"`.

<!-- openwiki: broken internal link [../../app/(app] file "../../app/(app" does not exist. Fix the href or restore the target, then delete this comment. -->
**Invitations** ([`app/(app)/settings/team/actions.ts` L81-L176](../../app/(app)/settings/team/actions.ts#L81-L176)):

- The invited role is `owner` or `practitioner`. The action refuses an email that is already an active
  practitioner or already has a pending invitation in the studio.
- It inserts through the RLS client.
- Only **one pending invitation per email can exist across all studios**: a partial unique index on
  `lower(email) where status = 'pending'` ([`0007` L20-L24](../../supabase/migrations/0007_pending_invitations.sql#L20-L24)).
  A collision is reported as "pending invite at another studio".
- The invitation email goes straight through the Resend client. A failure is logged and never fails the
  invitation; the row and the share-message UI are the source of truth.
- Revoking flips a pending row to `revoked`, scoped by id and studio.

**Removal** calls `set_practitioner_active_locked` through the service-role client
<!-- openwiki: broken internal link [../../app/(app] file "../../app/(app" does not exist. Fix the href or restore the target, then delete this comment. -->
([L198-L232](../../app/(app)/settings/team/actions.ts#L198-L232)). The call takes the studio row and then the
advisory lock, refuses to deactivate the owner, and preserves the practitioner's appointments. An owner cannot
remove themselves.

## 3. Onboarding v2 and the getting-started checklist

`0140` added two things ([`0140` L1-L36](../../supabase/migrations/0140_studio_onboarding.sql#L1-L36)):

- `studios.onboarding_v2_enabled`, **default false**;
- a per-studio `studio_onboarding` row holding resumable wizard state, the celebration stamps and the
  welcome-email status.

**The flag is operator-controlled.** The `studios: owners update` policy lets an owner update any `studios`
column, so a `SECURITY INVOKER` guard trigger rejects any change to the flag from `anon` or `authenticated`
([L48-L70](../../supabase/migrations/0140_studio_onboarding.sql#L48-L70)). The same column-guard pattern protects
the practitioner-capacity flags (`0134`, `0136`) and the new-client admission mode (`0204`).

**Progress** (dismiss, skip, resume, complete) is written by the owner to their own `studio_onboarding` row under
owner RLS ([`lib/onboarding/state.ts` L10-L77](../../lib/onboarding/state.ts#L10-L77)).

**`/getting-started`** is a mostly auto-detected readiness checklist with no manual mark-as-done persistence
<!-- openwiki: broken internal link [../../app/(app] file "../../app/(app" does not exist. Fix the href or restore the target, then delete this comment. -->
([`page.tsx` L11-L19](../../app/(app)/getting-started/page.tsx#L11-L19)). Studios with v2 off see only this
checklist and the dashboard step counter.

## 4. Settings surfaces

`app/(app)/settings/` holds:

| Area | Subpages |
|---|---|
| Scheduling | `availability`, `booking`, `calendar`, `services` |
| Clinical and forms | `consent`, `intake` |
| Integrations and money | `integrations`, `payments`, `tracking` |
| Studio and people | `profile`, `studio`, `team`, `waitlist`, `launch` |
| Data | `data` (export), `import` (Quick Import) |

Each mutating action resolves the studio on the server. Owner-only actions check the live role. The
service-role ones are inventoried on [RLS, grants and SECURITY DEFINER commands](../security/rls-grants-and-security-definer.md).

Behaviour is documented on the pages for each area:

- [Practitioner calendar, move/reassign and capacity](../scheduling/practitioner-calendar-move-and-capacity.md)
  for availability;
- [Stripe payments and settlement](../payments/stripe-payments-and-settlement.md);
- [Google Calendar sync](../integrations/google-calendar-sync.md);
- [Client portal, intake and consent](../portal/client-portal-intake-and-consent.md);
- [New-client admission mode](../waitlist/new-client-admission-mode.md).

## 5. Treatment-image storage

Pure helpers in [`lib/images/treatment-images.ts` L1-L110](../../lib/images/treatment-images.ts#L1-L110):

- private bucket `treatment-images`;
- **60-second** signed URLs, minted per view and never stored;
- 15 MB cap and a JPEG/PNG/WebP allowlist (no SVG);
- the client filename is used for display only;
- the storage path is built on the server as `<studio_id>/<client_id>/<server uuid>.<ext>` and is checked again
  against the caller's studio and the row's client **before** the service-role signer mints a URL.

`0093` hardened the trust boundary ([`0093` L1-L34](../../supabase/migrations/0093_harden_treatment_image_storage.sql#L1-L34)):

- objects are service-role-only, with direct `authenticated` storage policies dropped;
- `CHECK` constraints bind the bucket and path to the row's studio and client;
- a trigger enforces parent consistency and freezes identity columns after insert;
- step 1 forces the bucket private, but if the migration role lacks the privilege it only raises a notice and
  asks the operator to confirm privacy in the dashboard
  ([L36-L43](../../supabase/migrations/0093_harden_treatment_image_storage.sql#L36-L43)).

Image write commands are covered on [Sessions, blocks and entries](../treatment-memory/sessions-blocks-and-entries.md).

## 6. The studio data export

`exportStudioDataAction` is **owner-only**; an inactive practitioner is refused. It reads through the RLS
client and returns a ZIP of CSVs (JSZip, base64)
<!-- openwiki: broken internal link [../../app/(app] file "../../app/(app" does not exist. Fix the href or restore the target, then delete this comment. -->
([`app/(app)/settings/data/actions.ts` L70-L83](../../app/(app)/settings/data/actions.ts#L70-L83)). The files come
from the **export resource registry**
([`lib/export/resource-registry.ts` L6-L67](../../lib/export/resource-registry.ts#L6-L67)).

**Every resource has exactly one disposition.** Resources are base tables in `public` plus storage buckets
(namespaced `storage:<id>`):

| Disposition | Meaning |
|---|---|
| `exported` | in the ZIP; the file, headers, included and excluded columns and row scope are declared |
| `excluded` | withheld on the record, with a reason |
| `pending` | studio-owned but **not yet exported**; carries a ticket and a tier, and is rendered on the Data settings page and in the in-ZIP manifest |

**Four views must agree:** the declared disposition, the SELECT actually sent, the CSV header and cells, and the
manifest counts. A disagreement fails a test.

**The schema authority is the database.**
[`export-resource-registry.db.test.ts` L156-L400](../../tests/db/export-resource-registry.db.test.ts#L156-L400)
introspects the migrated local schema and fails when:

- a live table or bucket has no disposition, or a registry entry no longer exists;
- the included and excluded columns of an exported table do not exactly equal its live columns;
- a credential-bearing table is marked anything other than permanently excluded.

The registry deliberately states no payload size; its entries are the count.

**Recorded status — L29, P2, open:** the export is still partial. Roughly fifty-nine studio-owned resources are
pending. TRUTH-01A closed the *misrepresentation*, and TRUTH-01B, which changes the payload, has no merged PR
<!-- openwiki: broken internal link [../../docs/production/known-limitations.md#L570-L582] heading anchor "L570-L582" does not exist in "../../docs/production/known-limitations.md". Fix the href or restore the target, then delete this comment. -->
([`known-limitations.md` L570-L582](../../docs/production/known-limitations.md#L570-L582)).

## 7. Quick Import

The pipeline is pure ([`lib/import/quick-import.ts` L1-L26](../../lib/import/quick-import.ts#L1-L26)):

- it parses, normalizes, groups and plans CSV/TSV into **history only** (`imported_treatment_memories`, never
  sessions or appointments);
- it creates only — duplicate clients are skipped, never merged;
- it never false-merges;
- it caps an import at 2,000 rows;
- it never stores the raw pasted text.

Both server actions first require an active **owner who also has platform-operator standing**
<!-- openwiki: broken internal link [../../app/(app] file "../../app/(app" does not exist. Fix the href or restore the target, then delete this comment. -->
([`settings/import/actions.ts` L92-L119](../../app/(app)/settings/import/actions.ts#L92-L119)).

**Recorded status — L24:** confirmation is three independent writes with no transaction:

1. the `import_batches` row;
2. the clients;
3. the memories.

A failure on the third leaves the clients committed. Execution is **mitigated** to operator-assisted runs, not
<!-- openwiki: broken internal link [../../docs/production/known-limitations.md#L439-L449] heading anchor "L439-L449" does not exist in "../../docs/production/known-limitations.md". Fix the href or restore the target, then delete this comment. -->
fixed ([`known-limitations.md` L439-L449](../../docs/production/known-limitations.md#L439-L449)).

## 8. Admin and ops tooling

`/admin` (operator allowlist; see the auth page) provides:

- the New Studio Wizard;
- per-studio views, including a welcome-email resend;
- ops alerts, including resolve and a test critical alert;
- the admin audit view;
- the payments manual-review page.

Every admin action writes `admin_action_events` (`0113`) through `logAdminAction`, the only writer and reader
([`lib/audit/admin-actions.ts` L1-L30](../../lib/audit/admin-actions.ts#L1-L30)). Before storage it:

- drops credential- or PII-shaped metadata keys;
- keeps only primitive values;
- runs the ops-alert redactor over what remains.

## 9. Related recorded limitations

| ID | Status as recorded |
|---|---|
<!-- openwiki: broken internal link [../../docs/production/known-limitations.md#L531-L555] heading anchor "L531-L555" does not exist in "../../docs/production/known-limitations.md". Fix the href or restore the target, then delete this comment. -->
| L27 | **P2 open** — no automated retention or permanent-deletion lifecycle. The published policy no longer promises timed deletion; sequenced after a complete export ([L531-L555](../../docs/production/known-limitations.md#L531-L555)) |
<!-- openwiki: broken internal link [../../docs/production/known-limitations.md#L557-L568] heading anchor "L557-L568" does not exist in "../../docs/production/known-limitations.md". Fix the href or restore the target, then delete this comment. -->
| L28 | **P2 open, partially mitigated** — upload compensates when its metadata insert fails; image archive is soft-only and no storage reconciler exists ([L557-L568](../../docs/production/known-limitations.md#L557-L568)) |
<!-- openwiki: broken internal link [../../docs/production/known-limitations.md#L625-L639] heading anchor "L625-L639" does not exist in "../../docs/production/known-limitations.md". Fix the href or restore the target, then delete this comment. -->
| L31 | open, cosmetic — the onboarding celebration state is not scoped to the selected studio for a multi-studio owner ([L625-L639](../../docs/production/known-limitations.md#L625-L639)) |

## 10. Contradictions and open questions

1. **The wizard's comments describe the retired trigger path.**
   - The action header says the owner row "is created by the existing handle_new_user() trigger (migration
     0081) on the owner's first invited sign-in, which stamps terms/privacy acceptance", and that there is "no
     email automation" ([`actions.ts` L22-L29](../../app/admin/studios/new/actions.ts#L22-L29),
     [L203-L204](../../app/admin/studios/new/actions.ts#L203-L204)).
   - Since `0141` that trigger is a no-op, and the same action sends the onboarding-v2 welcome email
     ([L213-L226](../../app/admin/studios/new/actions.ts#L213-L226)).
   - The wizard DB test's header and `describe` title still say "the trigger links the owner"
     ([L9-L15](../../tests/db/new-studio-wizard.db.test.ts#L9-L15),
     [L63](../../tests/db/new-studio-wizard.db.test.ts#L63-L63)), while its body asserts the opposite and
     provisions through explicit acceptance.
2. **Raw database messages reach the wizard's redirect URL.** Failure paths put `error.message` text into the
   `?error=` query string ([L97](../../app/admin/studios/new/actions.ts#L97-L97),
   [L149](../../app/admin/studios/new/actions.ts#L149-L149),
   [L189](../../app/admin/studios/new/actions.ts#L189-L189)). The duplicate-invitation message also embeds the
   owner email. The surface is operator-only, but those values land in browser history.
3. **Team invitation email bypasses the shared send path.** It calls the Resend client directly, with no
   idempotency key and no bounded timeout
<!-- openwiki: broken internal link [../../app/(app] file "../../app/(app" does not exist. Fix the href or restore the target, then delete this comment. -->
   ([`team/actions.ts` L48-L79](../../app/(app)/settings/team/actions.ts#L48-L79)), unlike the wrappers on
   [Email delivery](../communications/email-delivery.md). Whether this is intentional is not recorded.
4. **The studio row is protected per column, not by a column grant.** An owner may update any `studios` column
   that no guard trigger protects. Whether every operator-only column has a guard is not pinned by a single
   test located for this page.
