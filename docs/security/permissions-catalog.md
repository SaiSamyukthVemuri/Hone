# Studio permission catalog (R0)

Status: **proposal for review. Nothing here is enforced.** `lib/permissions/catalog.ts` is pure data that no code imports yet, so
this change alters no behaviour, no policy and no database object. Sam's specification (Roles and permissions, 2 Nov 2026)
is binding; where an earlier proposal disagreed, this catalog follows Sam.

## One source

`lib/permissions/catalog.ts` is the single map. The Roles page (R2), the server helper (`requirePermission`, R1) and the
database (`has_studio_permission` and its seed rows, migration 0287, R1) all read it, and R1 pins the seed rows to this file
with a test, so there is never a second copy of a default. The table below is **generated** from the file and compared by
`tests/lib/permissions/catalog.test.ts`; do not edit it by hand.

## Vocabulary

- **Roles:** Owner, Practitioner, Receptionist. The owner always has every permission and is not configurable. No custom
  roles and no per-person exceptions in this version.
- **Scope:** Off, Own, Studio. A capability that has no meaningful "own" is a plain On/Off switch ("Studio" means On). "Own"
  is defined per key, usually the appointment whose assigned practitioner is the actor.
- **New:** the shipped default for a NEW studio. **Existing studio:** the snapshot an existing studio keeps until its owner
  reviews a before/after summary and explicitly adopts the new defaults or saves a custom configuration. The snapshot is
  today's **approved** policy, never a database hole. Where code and an approved decision disagree, the snapshot takes the
  approved, narrower value (basis `approved_policy`).
- **Basis:** how well the snapshot value is known: `verified` (proved at runtime), `source` (read from source only),
  `approved_policy`, or `not_built` (the capability does not exist yet, so nothing can be preserved).
- **Gate:** the key may not be enforced or offered for that role until the named condition holds in production.

## Prerequisites: never silently enable another permission

1. The prerequisite graph is acyclic and checked by test.
2. A dependent can never be set above what its prerequisites currently allow. The attempt is **refused with the
   prerequisite named** ("Turn on X first"). No other key is ever changed as a side effect.
3. Turning a prerequisite OFF makes its dependents **effectively** OFF and greys them out. Their **stored** values are kept, so
   turning the prerequisite back ON restores exactly what the owner had set.
4. An unknown key, a key not offered to the role, or a cycle fails **closed** (effective Off).
5. `effectiveScope` and `checkChange` in the catalog file define this behaviour once; the database function must match it.

## Catalog

<!-- catalog:begin -->
### Appointments

| Key | Scopes | Requires | New: Prac / Recep | Existing studio: Prac / Recep | Basis | Gate |
|---|---|---|---|---|---|---|
| `appt.view_calendar` (fixed) | Off / Studio | – | Studio / Studio | Studio / Studio | source | – |
| `appt.book` | Off / Own / Studio | `appt.view_calendar` | Own / Studio | Own / Off | source | – |
| `appt.move` | Off / Own / Studio | `appt.view_calendar` | Own / Studio | Own / Off | source | – |
| `appt.reassign` | Off / Own / Studio | `appt.move` | Off / Studio | Off / Off | source | – |
| `appt.cancel` | Off / Own / Studio | `appt.view_calendar` | Studio / Studio | Studio / Off | source | – |
| `appt.mark_no_show` | Off / Own / Studio | `appt.view_calendar` | Studio / Studio | Studio / Off | source | – |
| `appt.edit_notes` | Off / Own / Studio | `appt.view_calendar` | Studio / Studio | Studio / Off | source | – |
| `appt.complete` (receptionist not offered) | Off / Own / Studio | `appt.view_calendar`, `clin.view_records` | Own / Off | Own / Off | approved_policy | practitioner: #1315 and the 0277 apply (the assigned-only completion rule) are in production |
| `appt.aftercare_send` | Off / Own / Studio | `appt.view_calendar` | Studio / Off | Studio / Off | source | – |

### Clients and identity

| Key | Scopes | Requires | New: Prac / Recep | Existing studio: Prac / Recep | Basis | Gate |
|---|---|---|---|---|---|---|
| `client.create` | Off / Studio | – | Studio / Studio | Studio / Off | source | – |
| `client.edit_contact` | Off / Studio | – | Studio / Studio | Studio / Off | source | – |
| `client.view_legal_name` | Off / Studio | – | Studio / Off | Studio / Off | source | receptionist: 0280/0290 receptionist name privacy and a read audit are in production (open point R0-Q4) |
| `client.edit_legal_name` | Off / Studio | `client.view_legal_name` | Studio / Off | Studio / Off | source | practitioner: stale-write protection and versions for legal-name edits (#1328 / M1) are in production; receptionist: 0280/0290 receptionist name privacy and a read audit are in production (open point R0-Q4) |
| `client.merge` | Off / Studio | `client.edit_contact` | Off / Off | Off / Off | not_built | – |
| `client.import` | Off / Studio | `client.create` | Off / Off | Off / Off | source | – |

### Clinical and records

| Key | Scopes | Requires | New: Prac / Recep | Existing studio: Prac / Recep | Basis | Gate |
|---|---|---|---|---|---|---|
| `clin.view_records` | Off / Studio | `appt.view_calendar` | Studio / Off | Studio / Off | source | – |
| `clin.edit_records` (receptionist not offered) | Off / Studio | `clin.view_records` | Studio / Off | Studio / Off | source | – |
| `clin.view_photos` | Off / Studio | `clin.view_records` | Studio / Off | Studio / Off | source | – |
| `clin.upload_photos` (receptionist not offered) | Off / Studio | `clin.view_photos` | Studio / Off | Studio / Off | source | – |
| `clin.view_intake` | Off / Studio | `clin.view_records` | Studio / Off | Studio / Off | source | – |
| `clin.edit_intake` (receptionist not offered) | Off / Studio | `clin.view_intake` | Studio / Off | Studio / Off | source | – |
| `clin.print_record` | Off / Studio | `clin.view_records` | Studio / Off | Studio / Off | source | – |
| `clin.edit_consent_templates` | Off / Studio | – | Off / Off | Off / Off | approved_policy | – |

### Communications

| Key | Scopes | Requires | New: Prac / Recep | Existing studio: Prac / Recep | Basis | Gate |
|---|---|---|---|---|---|---|
| `comm.send_routine` | Off / Own / Studio | `appt.view_calendar` | Own / Studio | Own / Off | source | – |
| `comm.bulk_message` | Off / Studio | `comm.send_routine` | Off / Off | Off / Off | not_built | – |

### Payments

| Key | Scopes | Requires | New: Prac / Recep | Existing studio: Prac / Recep | Basis | Gate |
|---|---|---|---|---|---|---|
| `pay.view_appointment` | Off / Own / Studio | `appt.view_calendar` | Own / Studio | Off / Off | approved_policy | receptionist: Receptionist removal live in production (#1303) AND the direct receptionist-invitation path (R-1) closed |
| `pay.record_external` | Off / Own / Studio | `pay.view_appointment` | Own / Studio | Off / Off | verified | receptionist: Receptionist removal live in production (#1303) AND the direct receptionist-invitation path (R-1) closed |
| `pay.charge_saved_card` | Off / Own / Studio | `pay.view_appointment` | Own / Studio | Off / Off | source | receptionist: Receptionist removal live in production (#1303) AND the direct receptionist-invitation path (R-1) closed |
| `pay.refund` | Off / Own / Studio | `pay.view_appointment` | Own / Studio | Off / Off | source | receptionist: Receptionist removal live in production (#1303) AND the direct receptionist-invitation path (R-1) closed |
| `pay.void` | Off / Own / Studio | `pay.view_appointment` | Own / Studio | Off / Off | source | receptionist: Receptionist removal live in production (#1303) AND the direct receptionist-invitation path (R-1) closed |
| `pay.correct_or_waive` | Off / Own / Studio | `pay.view_appointment` | Own / Studio | Off / Off | verified | receptionist: Receptionist removal live in production (#1303) AND the direct receptionist-invitation path (R-1) closed |

### Pricing

| Key | Scopes | Requires | New: Prac / Recep | Existing studio: Prac / Recep | Basis | Gate |
|---|---|---|---|---|---|---|
| `price.appointment` | Off / Own / Studio | `pay.view_appointment` | Own / Studio | Off / Off | source | receptionist: Receptionist removal live in production (#1303) AND the direct receptionist-invitation path (R-1) closed |
| `price.service_list` | Off / Studio | – | Studio / Studio | Off / Off | approved_policy | receptionist: Receptionist removal live in production (#1303) AND the direct receptionist-invitation path (R-1) closed |
| `price.fee_amounts` | Off / Studio | – | Studio / Studio | Off / Off | source | receptionist: Receptionist removal live in production (#1303) AND the direct receptionist-invitation path (R-1) closed |

### Availability

| Key | Scopes | Requires | New: Prac / Recep | Existing studio: Prac / Recep | Basis | Gate |
|---|---|---|---|---|---|---|
| `avail.manage_own` (receptionist not offered) | Off / Studio | – | Studio / Off | Off / Off | source | – |
| `avail.manage_others` | Off / Studio | – | Off / Off | Off / Off | source | – |

### Reports

| Key | Scopes | Requires | New: Prac / Recep | Existing studio: Prac / Recep | Basis | Gate |
|---|---|---|---|---|---|---|
| `rep.studio_totals` | Off / Studio | `pay.view_appointment` | Off / Off | Off / Off | source | – |
| `rep.financial_reports` | Off / Studio | `pay.view_appointment` | Off / Off | Off / Off | source | – |
| `rep.lifetime_spend` | Off / Studio | `pay.view_appointment` | Off / Off | Off / Off | approved_policy | – |
| `rep.bulk_export` | Off / Studio | – | Off / Off | Off / Off | source | – |
| `rep.audit_log_view` | Off / Studio | – | Off / Off | Off / Off | source | – |
<!-- catalog:end -->

## Never configurable (no key exists)

| Item | Source | Effect when an existing studio adopts |
|---|---|---|
| Managing roles, permissions or ownership | Sam C.5 | none |
| Payment-provider credentials, bank accounts and payouts | Sam C.5 | none |
| Studio or account deletion | Sam C.5 | none |
| Permanent deletion and bulk destructive actions | Sam C.5 | none |
| Deleting or altering audit history | Sam C.5 | none |
| Deleting treatment records and photos | Sam C.5, this version | **narrows**: practitioners can soft-delete today. Notice required. |
| Archiving clients | Sam C.5, this version | **narrows**: any practitioner can archive today. Notice required. |
| Restoring deleted records | Sam C.5, this version | **narrows** (unverified today). Notice required. |

**Not offered as toggles** (not in Sam's list, so no key; they stay owner-only because nothing can grant them; flagged for
reviewers to confirm): studio settings (booking rules, integrations, payment settings policy, machine registry); staff
invitations and removal; Hone subscription and billing portal, tax and currency, receipt branding, business name.

## Mandatory whatever the owner configures

Studio isolation on every path; consent requirements; payment authorization (saved-card authorisation evidence, server-derived
amounts); truthful clinical attribution ("risks explained" records the person who explained; acting for a colleague never
attributes their attestation); the owner has every permission, a studio keeps at least one active owner, nobody promotes
themselves; refunds never exceed the remaining refundable amount, card refunds return to the original card, reasons are
required and originals are preserved; revocation is immediate (current membership, studio, key and scope are checked on every
protected operation, nothing is cached in a token); role and permission changes are audited append-only.

## Where this supersedes the earlier proposal

The earlier matrix (`PROPOSED-MATRIX.md`) assumed finance would be owner-only in the future. That is retired as a future
requirement; it remains the preserved **existing-studio snapshot** until an owner adopts. Specifically:

- Finance keys are separate switches, default ON for both staff roles in NEW studios; practitioners default to own assigned
  appointments, receptionists to the studio. Service price list and fee amounts default ON and are labelled "affects future
  studio business" (the reviewers had recommended OFF).
- The "not on your own record" refusal is retired. Reasons are required and originals preserved; the owner activity feed can
  flag the pattern but must not block the action.
- Receptionists: clinical content is OFF by default and owner-enableable for the **supported** keys, with separate read and
  write keys (it was "never"). Receptionist no-show and scheduling notes are ON. Colleagues' availability is OFF and
  configurable (not owner-only).
- Bulk export is a configurable key, OFF by default (it was owner-only).
- "Risks explained" is an attribution rule, not a performer-only restriction.

## Open points for review (R0-Q)

- **Q1 completion snapshot:** today's code lets any practitioner complete any started appointment. The snapshot is `own`
  (Sam's assigned-only rule, which #1315 and 0277 deliver); R4 may not ship before them.
- **Q2 supported clinical keys for receptionists:** offered: view records, view photos, view intake answers, aftercare, legal
  name view and edit (gated). Not offered this version: edit records, upload photos, edit intake answers, print, complete.
- **Q3 reassigning your own appointment** to a colleague: not stated by Sam; defaulted OFF for practitioners.
- **Q4 receptionist legal name:** both reviewers earlier wanted these keys unavailable this release. Sam's spec makes them
  enableable. They are gated on 0280/0290 name privacy and a read audit, and practitioner legal-name edit on stale-write
  protection (#1328 / M1). Decision needed.
- **Q5 items not in Sam's list** (booking rules, integrations, billing, branding): no key, owner-only by absence.
- **Q6 the receptionist snapshot is Off almost everywhere:** the desk is behind a flag that is OFF and a receptionist cannot be
  created through the product today (R-1 is an API-only path), so there is nothing approved to preserve.
- **Q7 narrowing notices:** the three fixed owner-only items narrow what existing practitioners can do. Confirm they apply on
  adoption with a notice, not silently.
