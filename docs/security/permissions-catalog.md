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
- **Policy basis.** Every studio carries a basis: `existing_snapshot` until its owner reviews the before/after summary and adopts
  (or saves a custom configuration), `new_studio` for studios created under the shipped defaults. A key with **no stored value
  resolves to the studio's basis**, never to the new-studio default, so a missing row, a key added in a later catalog version
  or a failed write can never widen an existing studio. A studio whose basis is unknown or unreadable resolves every key to Off.
  Reset to defaults sets the basis to `new_studio` only after the preview and the owner's confirmation.
- **New:** the shipped default for a NEW studio. **Existing studio:** the snapshot an existing studio keeps until its owner
  reviews a before/after summary and explicitly adopts the new defaults or saves a custom configuration. The snapshot is
  today's **approved** policy, never a database hole. Where code and an approved decision disagree, the snapshot takes the
  approved, narrower value (basis `approved_policy`).
- **Basis:** how well the snapshot value is known: `verified` (proved at runtime), `source` (read from source only),
  `approved_policy`, or `not_built` (the capability does not exist yet, so nothing can be preserved).
- **Gate:** operator-controlled release data (the owner cannot change it) that defaults to NOT satisfied. While a role-key's gate
  is unmet it is **unavailable**: its effective scope is capped at the existing-studio snapshot, so a capability that is new
  for the role (receptionist finance, receptionist legal name) is Off, while behaviour a studio has today is neither widened nor
  silently narrowed. The page shows "not yet available" and the owner cannot enable it; `has_studio_permission` reads the same
  fact.

## Prerequisites: never silently enable another permission

1. The prerequisite graph is acyclic and checked by test.
2. A dependent can never be set above what its prerequisites currently allow. The attempt is **refused with the
   prerequisite named** ("Turn on X first"). No other key is ever changed as a side effect.
3. Turning a prerequisite OFF makes its dependents **effectively** OFF and greys them out. Their **stored** values are kept, so
   turning the prerequisite back ON restores exactly what the owner had set.
4. An unknown key, a key not offered to the role, a cycle, or an unknown policy basis fails **closed** (effective Off).
   A capped result the key does not allow becomes Off: a boolean key whose prerequisite is only at Own is Off, never "own".
   A studio-wide report needs the payment view at Whole studio.
   "Own assigned appointments" is not offered to receptionists (they are never the assigned practitioner). For an
   unassigned appointment "own" matches nobody (owner or Whole studio only); scope is evaluated on the CURRENT assignee inside
   the action's transaction, so an appointment reassigned after the action started is re-checked; for overlapping memberships or
   dual roles the most restrictive of the actor's current active rows applies.
5. `effectiveScope` and `checkChange` in the catalog file define this behaviour once; the database function must match it.

## Catalog

<!-- catalog:begin -->
### Appointments

| Key | Scopes | Requires | New: Prac / Recep | Existing studio: Prac / Recep | Basis | Gate | Decision pending |
|---|---|---|---|---|---|---|---|
| `appt.view_calendar` (fixed) | Off / Studio | – | Studio / Studio | Studio / Studio | source | – | – |
| `appt.book` | Off / Own / Studio | `appt.view_calendar` | Own / Studio | Own / Off | source | – | – |
| `appt.move` | Off / Own / Studio | `appt.view_calendar` | Own / Studio | Own / Off | source | – | – |
| `appt.reassign` | Off / Studio | `appt.move` | Off / Studio | Off / Off | source | – | – |
| `appt.handoff_own` (receptionist not offered) | Off / Studio | `appt.view_calendar` | Off / Off | Off / Off | not_built | – | – |
| `appt.cancel` | Off / Own / Studio | `appt.view_calendar` | Studio / Studio | Studio / Off | source | – | – |
| `appt.mark_no_show` | Off / Own / Studio | `appt.view_calendar` | Studio / Studio | Studio / Off | source | – | – |
| `appt.edit_notes` | Off / Own / Studio | `appt.view_calendar` | Studio / Studio | Studio / Off | source | receptionist: R4 has confirmed from source that scheduling notes are a different field from clinical notes, or limited the receptionist view to a scheduling-only field (Privacy F6) | – |
| `appt.complete` (receptionist not offered) | Off / Own / Studio | `appt.view_calendar`, `clin.view_records` | Own / Off | Own / Off | approved_policy | practitioner: #1315 and the 0277 apply (the assigned-only completion rule) are in production | – |
| `appt.aftercare_send` | Off / Own / Studio | `appt.view_calendar` | Studio / Off | Studio / Off | source | – | – |

### Clients and identity

| Key | Scopes | Requires | New: Prac / Recep | Existing studio: Prac / Recep | Basis | Gate | Decision pending |
|---|---|---|---|---|---|---|---|
| `client.view_directory` (fixed) | Off / Studio | `appt.view_calendar` | Studio / Studio | Studio / Off | source | – | – |
| `client.create` | Off / Studio | – | Studio / Studio | Studio / Off | source | – | – |
| `client.edit_contact` | Off / Studio | – | Studio / Studio | Studio / Off | source | – | – |
| `client.view_legal_name` | Off / Studio | – | Studio / Off | Studio / Off | approved_policy | receptionist: privacy enforcement (0280/0290 receptionist name privacy) and legal-name access logging are deployed AND verified (Sam, 3 Nov, DN-26); until then the Roles page shows "Not available yet", not a switch | – |
| `client.edit_legal_name` | Off / Studio | `client.view_legal_name` | Studio / Off | Studio / Off | source | practitioner: Stale-write protection and versions for legal-name edits (#1328 / M1) are in production; receptionist: privacy enforcement (0280/0290 receptionist name privacy) and legal-name access logging are deployed AND verified (Sam, 3 Nov, DN-26); until then the Roles page shows "Not available yet", not a switch | – |
| `client.merge` | Off / Studio | `client.edit_contact`, `client.view_legal_name` | Off / Off | Off / Off | not_built | – | – |
| `client.import` | Off / Studio | `client.create` | Off / Off | Off / Off | source | – | – |
| `client.view_dob_address` | Off / Studio | `appt.view_calendar`, `client.view_directory` | Studio / Off | Studio / Off | source | – | – |
| `client.edit_dob_address` (receptionist not offered) | Off / Studio | `client.view_dob_address` | Studio / Off | Studio / Off | source | – | – |
| `client.view_allergies_cautions` | Off / Studio | `appt.view_calendar`, `client.view_directory` | Studio / Off | Studio / Off | source | – | – |
| `client.edit_allergies_cautions` (receptionist not offered) | Off / Studio | `client.view_allergies_cautions` | Studio / Off | Studio / Off | source | – | – |
| `client.view_budget` | Off / Studio | `appt.view_calendar`, `client.view_directory` | Studio / Off | Studio / Off | source | – | – |
| `client.edit_budget` (receptionist not offered) | Off / Studio | `client.view_budget` | Studio / Off | Studio / Off | source | – | – |
| `client.view_personal_notes` | Off / Studio | `appt.view_calendar`, `client.view_directory` | Studio / Off | Studio / Off | source | – | – |
| `client.edit_personal_notes` (receptionist not offered) | Off / Studio | `client.view_personal_notes` | Studio / Off | Studio / Off | source | – | – |
| `client.view_tags` | Off / Studio | `appt.view_calendar`, `client.view_directory` | Studio / Off | Studio / Off | source | – | – |
| `client.edit_tags` (receptionist not offered) | Off / Studio | `client.view_tags` | Studio / Off | Studio / Off | source | – | – |
| `client.view_health_fields` | Off / Studio | `appt.view_calendar`, `client.view_directory` | Studio / Off | Studio / Off | source | – | – |
| `client.edit_health_fields` (receptionist not offered) | Off / Studio | `client.view_health_fields` | Studio / Off | Studio / Off | source | – | – |

### Clinical records

| Key | Scopes | Requires | New: Prac / Recep | Existing studio: Prac / Recep | Basis | Gate | Decision pending |
|---|---|---|---|---|---|---|---|
| `clin.view_records` | Off / Studio | `appt.view_calendar` | Studio / Off | Studio / Off | source | – | – |
| `clin.edit_records` (receptionist not offered) | Off / Studio | `clin.view_records` | Studio / Off | Studio / Off | source | – | – |
| `clin.view_photos` | Off / Studio | `client.view_directory` | Studio / Off | Studio / Off | source | – | – |
| `clin.upload_photos` (receptionist not offered) | Off / Studio | `clin.view_photos` | Studio / Off | Studio / Off | source | – | – |
| `clin.view_intake` | Off / Studio | `client.view_directory` | Studio / Off | Studio / Off | source | – | – |
| `clin.view_aftercare` | Off / Studio | `client.view_directory` | Studio / Off | Studio / Off | source | – | – |
| `clin.view_intake_status` | Off / Studio | `client.view_directory` | Studio / Off | Studio / Off | source | – | – |
| `clin.edit_intake` (receptionist not offered) | Off / Studio | `clin.view_intake` | Studio / Off | Studio / Off | source | – | – |
| `clin.review_intake` (receptionist not offered) | Off / Studio | `clin.view_intake` | Studio / Off | Studio / Off | source | – | – |
| `clin.print_record` (receptionist not offered) | Off / Studio | `clin.view_records` | Studio / Off | Studio / Off | source | – | – |
| `clin.edit_consent_templates` | Off / Studio | – | Off / Off | Off / Off | approved_policy | – | – |

### Communications

| Key | Scopes | Requires | New: Prac / Recep | Existing studio: Prac / Recep | Basis | Gate | Decision pending |
|---|---|---|---|---|---|---|---|
| `comm.send_routine` | Off / Own / Studio | `appt.view_calendar` | Studio / Studio | Studio / Off | source | – | – |
| `comm.send_intake_link` | Off / Studio | `comm.send_routine`, `clin.view_intake_status` | Studio / Off | Studio / Off | source | – | – |
| `comm.send_portal_link` | Off / Studio | `comm.send_routine` | Studio / Off | Studio / Off | source | – | – |
| `comm.send_portal_reply` | Off / Own / Studio | `comm.send_routine`, `client.view_directory` | Studio / Off | Studio / Off | source | – | – |
| `comm.bulk_message` | Off / Studio | `comm.send_routine`, `client.view_directory` | Off / Off | Off / Off | not_built | – | – |

### Payments

| Key | Scopes | Requires | New: Prac / Recep | Existing studio: Prac / Recep | Basis | Gate | Decision pending |
|---|---|---|---|---|---|---|---|
| `pay.view_appointment` | Off / Own / Studio | `appt.view_calendar` | Own / Studio | Off / Off | approved_policy | receptionist: Receptionist removal live in production (#1303) AND the direct receptionist-invitation path (R-1) closed | – |
| `pay.record_external` | Off / Own / Studio | `pay.view_appointment` | Own / Studio | Off / Off | verified | receptionist: Receptionist removal live in production (#1303) AND the direct receptionist-invitation path (R-1) closed | – |
| `pay.charge_saved_card` | Off / Own / Studio | `pay.view_appointment` | Own / Studio | Off / Off | source | receptionist: Receptionist removal live in production (#1303) AND the direct receptionist-invitation path (R-1) closed | – |
| `pay.refund` | Off / Own / Studio | `pay.view_appointment` | Own / Studio | Off / Off | source | receptionist: Receptionist removal live in production (#1303) AND the direct receptionist-invitation path (R-1) closed | – |
| `pay.void` | Off / Own / Studio | `pay.view_appointment` | Own / Studio | Off / Off | source | receptionist: Receptionist removal live in production (#1303) AND the direct receptionist-invitation path (R-1) closed | – |
| `pay.correct_or_waive` | Off / Own / Studio | `pay.view_appointment` | Own / Studio | Off / Off | verified | receptionist: Receptionist removal live in production (#1303) AND the direct receptionist-invitation path (R-1) closed | – |

### Pricing

| Key | Scopes | Requires | New: Prac / Recep | Existing studio: Prac / Recep | Basis | Gate | Decision pending |
|---|---|---|---|---|---|---|---|
| `price.appointment` | Off / Own / Studio | `pay.view_appointment` | Own / Studio | Off / Off | source | receptionist: Receptionist removal live in production (#1303) AND the direct receptionist-invitation path (R-1) closed | – |
| `price.view_client_prices` | Off / Own / Studio | `pay.view_appointment` | Own / Studio | Off / Off | approved_policy | receptionist: Receptionist removal live in production (#1303) AND the direct receptionist-invitation path (R-1) closed | – |
| `price.service_list` | Off / Studio | – | Studio / Studio | Off / Off | approved_policy | receptionist: Receptionist removal live in production (#1303) AND the direct receptionist-invitation path (R-1) closed | – |
| `price.fee_amounts` | Off / Studio | – | Studio / Studio | Off / Off | source | receptionist: Receptionist removal live in production (#1303) AND the direct receptionist-invitation path (R-1) closed | – |
| `price.edit_client_prices` | Off / Studio | `price.view_client_prices` | Off / Off | Off / Off | source | – | – |

### Availability

| Key | Scopes | Requires | New: Prac / Recep | Existing studio: Prac / Recep | Basis | Gate | Decision pending |
|---|---|---|---|---|---|---|---|
| `avail.manage_own` (receptionist not offered) | Off / Studio | – | Studio / Off | Off / Off | source | – | – |
| `avail.manage_others` | Off / Studio | – | Off / Off | Off / Off | source | – | – |
| `avail.manage_studio_hours` | Off / Studio | – | Off / Off | Off / Off | source | – | – |

### Reports

| Key | Scopes | Requires | New: Prac / Recep | Existing studio: Prac / Recep | Basis | Gate | Decision pending |
|---|---|---|---|---|---|---|---|
| `rep.studio_totals` | Off / Studio | – | Off / Off | Off / Off | source | – | – |
| `rep.financial_reports` | Off / Studio | `pay.view_appointment` | Off / Off | Off / Off | source | – | – |
| `rep.lifetime_spend` | Off / Studio | `pay.view_appointment` | Off / Off | Off / Off | approved_policy | – | – |
| `rep.bulk_export` | Off / Studio | `client.view_directory` | Off / Off | Off / Off | source | – | – |
| `rep.audit_log_view` | Off / Studio | – | Off / Off | Off / Off | source | – | – |

### Waitlist operations

| Key | Scopes | Requires | New: Prac / Recep | Existing studio: Prac / Recep | Basis | Gate | Decision pending |
|---|---|---|---|---|---|---|---|
| `wl.view_queue` | Off / Studio | – | Off / Studio | Off / Off | source | receptionist: The receptionist waitlist screen AND its backend enforcement (R5 / 0286) are in production (Sam, 2 Nov, DN-15a) | – |
| `wl.add_entry` | Off / Studio | `wl.view_queue` | Off / Studio | Off / Off | source | receptionist: The receptionist waitlist screen AND its backend enforcement (R5 / 0286) are in production (Sam, 2 Nov, DN-15a) | – |
| `wl.import_entry` | Off / Studio | `wl.view_queue` | Off / Studio | Off / Off | source | receptionist: The receptionist waitlist screen AND its backend enforcement (R5 / 0286) are in production (Sam, 2 Nov, DN-15a) | – |
| `wl.withdraw_entry` | Off / Studio | `wl.view_queue` | Off / Studio | Off / Off | source | receptionist: The receptionist waitlist screen AND its backend enforcement (R5 / 0286) are in production (Sam, 2 Nov, DN-15a) | – |
| `wl.manage_queue` | Off / Studio | `wl.view_queue` | Off / Studio | Off / Off | source | receptionist: The receptionist waitlist screen AND its backend enforcement (R5 / 0286) are in production (Sam, 2 Nov, DN-15a) | – |
| `wl.expire_close` | Off / Studio | `wl.view_queue` | Off / Studio | Off / Off | source | receptionist: The receptionist waitlist screen AND its backend enforcement (R5 / 0286) are in production (Sam, 2 Nov, DN-15a) | – |
| `wl.offer_booking` | Off / Studio | `wl.view_queue` | Off / Studio | Off / Off | source | receptionist: The receptionist waitlist screen AND its backend enforcement (R5 / 0286) are in production (Sam, 2 Nov, DN-15a) | – |
| `wl.set_availability` | Off / Studio | `wl.view_queue` | Off / Studio | Off / Off | source | receptionist: The receptionist waitlist screen AND its backend enforcement (R5 / 0286) are in production (Sam, 2 Nov, DN-15a) | – |
| `wl.record_sms_consent` | Off / Studio | `wl.view_queue` | Off / Studio | Off / Off | source | receptionist: The receptionist waitlist screen AND its backend enforcement (R5 / 0286) are in production (Sam, 2 Nov, DN-15a) | – |

### Waitlist rules and automation

| Key | Scopes | Requires | New: Prac / Recep | Existing studio: Prac / Recep | Basis | Gate | Decision pending |
|---|---|---|---|---|---|---|---|
| `wlrules.invitation_rounds` | Off / Studio | – | Off / Off | Off / Off | source | – | – |
| `wlrules.policy_and_text` | Off / Studio | – | Off / Off | Off / Off | source | – | – |

### Accepting new clients

| Key | Scopes | Requires | New: Prac / Recep | Existing studio: Prac / Recep | Basis | Gate | Decision pending |
|---|---|---|---|---|---|---|---|
| `admit.change_policy` | Off / Studio | – | Off / Off | Off / Off | source | – | – |
| `admit.booking_rules` | Off / Studio | – | Off / Off | Off / Off | source | – | – |

### Safety records

| Key | Scopes | Requires | New: Prac / Recep | Existing studio: Prac / Recep | Basis | Gate | Decision pending |
|---|---|---|---|---|---|---|---|
| `records.view_sterilisation_disinfection` | Off / Studio | `appt.view_calendar` | Studio / Off | Studio / Off | source | – | – |
| `records.log_sterilisation_disinfection` | Off / Studio | `records.view_sterilisation_disinfection` | Studio / Off | Studio / Off | source | – | – |
<!-- catalog:end -->

## Decisions applied (Sam, 2 Nov) and the coverage map

Groups 1 to 7 of the audit decisions (`01-ops/ROLES-DECISIONS-LOG.md`) are in the catalog and in the MANDATORY list; nothing activates.

- **Navigation (DN-1, DN-2, DN-28):** staff never see Business; reports a studio permits appear under a separate Reports entry; Getting Started lists only tasks the viewer may perform.
- **Colleague data (DN-21, DN-27):** colleagues see display names and calendar colours only. Private email and account details, Google account emails, pending invitations and alerts are for the owner and that person; calendar-feed tokens and their hashes are secrets and never leave the server. Staff read the studio name, timezone and booking preferences; fee amounts need the relevant pay or price key.
- **Waitlist (DN-15):** eight separate operation keys (receptionist ON but gated until the screen and backend ship, practitioner OFF); two rules keys OFF for both. A permission never enables SMS, overrides consent or opt-out, and importing never records consent or sends a message.
- **Accepting new clients (DN-4a):** two keys, OFF for both roles. The permission to change the admission policy is separate from the studio's actual Open, Waitlist or Closed setting. Other administration is owner-only this release (DN-4b).
- **Opening hours (DN-13):** `avail.manage_studio_hours` is separate from `avail.manage_others`; both OFF.
- **Starting treatment (DN-6):** follows the completion scope; no receptionist clinical access; never completes anything automatically.
- **Client details (DN-5):** one view key and one edit key per data group: date of birth and address, allergies and pinned cautions, budget and goals, personal notes, tags, and the health fields on an appointment. Practitioners keep today's studio-wide access; receptionists are OFF and the owner may grant read-only per group (the edit keys are not offered to receptionists).
- **Removing a pass, block or area (DN-7):** editing under `clin.edit_records`; the original and its versions are kept. Deleting a whole session stays owner-only.
- **Changing a session's performer (DN-8):** the owner or the currently recorded performer, with a reason and audit; an eligible same-studio practitioner only; entries, signatures, attestations and payments are never rewritten; no permission bypass. No key.
- **Undoing a recorded outcome (DN-12):** owner-only, with a reason and history; never refunds, charges, erases records or reverses a message. No key.
- **Safety records (DN-3):** separate keys to view and to log sterilisation and disinfection (practitioner ON, receptionist OFF, owner-configurable). Exposure-incident history is for the owner and the reporter only.
- **ID photos and portraits (DN-24):** owner-only and not delegable until the separate ID-photo review is complete. Recorded as the fixed owner-only item `id_portraits_owner_only`, a narrowing for the adopt preview. The portrait feature is off everywhere (`HONE_CLIENT_PORTRAIT_ENABLED` unset) and the signer is observe-only until the review.
- **Messages and intake (group 4, 3 Nov):** requesting an intake update or resending the intake link is `comm.send_intake_link`, which needs the messaging permission plus the new `clin.view_intake_status` (never the answers or the chart). Portal replies are `comm.send_portal_reply` (practitioner ON, receptionist OFF, owner-configurable); the sender is recorded, history preserved and a client's original reply is immutable. Existing practitioners keep sending portal, intake and aftercare links and reviewing intake (`comm.send_portal_link`, `comm.send_intake_link`, `appt.aftercare_send`, `clin.review_intake`), each separately configurable. Notification read state is per person. All sending respects consent, opt-outs and channel activation.
- **Narrowings with no key (`NARROWINGS`):** performer change, exposure-incident history, colleague private fields, studio column reads, Getting Started, notification read state and portal reply immutability each name a stage, an enforcement point (some still "to confirm") and the notice the owner's review banner must carry.
- **Fee amounts:** staff may read the fee amounts clients see at booking; any other fee field needs `price.fee_amounts` or `pay.view_appointment` at any scope; otherwise staff read only studio name, timezone and booking preferences through a column-limited read (`FEE_AMOUNT_READ`).
- **Payments (group 5, 3 Nov):** card-authorisation consent is read-only through `pay.view_appointment` and its scope, only for that payment, with no intake or clinical access (DN-10). `price.edit_client_prices` is OFF for both roles and owner-configurable; reads follow `price.view_client_prices`; booked appointments keep their price (DN-11). Requiring a card to book is an owner-only setting (DN-23a). A late-cancellation fee needs an owner-configured window with no invented default, is never auto-activated, is decided on the server from the policy snapshot at booking, and also needs `pay.charge_saved_card`; the database part is held migration 0293, inside R3 (DN-23b).
- **Deletion, data rights, rollout (group 6, 3 Nov):** archive, delete and restore become owner-only only at the enforcement release, with advance notice, recoverable, nothing deleted by the rollout (DN-25). Permanent erasure: workflow designed below, execution unavailable (DN-18). Owner export is complete minus credentials, payment secrets, other studios' data and platform security, with short-lived owner-scoped links; staff exports stay OFF (DN-19). The portal is an owner-only setting, ON for existing studios; OFF blocks existing links and sessions and keeps records (DN-20). Receptionist legal-name keys show "Not available yet" until privacy enforcement and access logging are verified (DN-26).
- **Platform and operations (group 7, 3 Nov):** Google studio flags are operator-only behind a database guard; a removed or deactivated calendar owner gets no new sync and the owner is told to reconnect; when the rate limiter is down token and link operations refuse with a retry message and public booking uses a bounded fallback; anonymous waitlist and demo writes go through validated, rate-limited server endpoints; SMS STOP is unchanged pending a provider investigation. All of these are in `NARROWINGS` or the mandatory list.
- **Decisions:** DN-1 to DN-30 are all decided (`01-ops/ROLES-DECISIONS-LOG.md` is the authority).
- **Batch 1 (Sam, 3 Nov):** Q1 late-cancel window is whole hours 1-168, unset by default (unset = no late-cancel charging), set by the owner. Q3 limiter-outage fallback and the anonymous limits are OPERATOR configuration (`OPERATOR_CONFIG`), not catalog keys: 5 attempts per visitor per 10 minutes, 30 per studio per hour, failures counted, refuse safely if the shared fallback cannot enforce a bound. Q4 client-detail groups: safety (allergies + cautions), personal (date of birth, birthday, address), budget, personal notes, tags, appointment health notes; pronouns ride with contact identity, skin type, skin notes and treatment goals with the clinical record. Q6 portal replies are offered at whole-studio and assigned-client scope, existing studios keep today's access, and the assigned-client definition (proposed wording in `ASSIGNED_CLIENT`) must be shown to owners before that scope is enabled. Q7 client-price setting is Off/Studio only, OFF for both roles.
- **Batch 2 (Sam, 3 Nov):** Q10 / DN-3 view and log sterilisation and disinfection are separate keys, receptionist Off / Off, logging requires viewing; exposure incidents stay owner and reporter only. Q16 / R0-Q2 receptionist clinical access is VIEW-ONLY keys (records, photos, intake answers) offered and Off by default; edit, print and complete are not offered to receptionists, and ID photos and legal-identity restrictions are unchanged. Q25 studio totals have no prerequisite on the payment view and the payment view none on them; reports never reveal an individual payment detail. Q9 / DN-12 undoing a recorded outcome is owner-only, has no window, needs a reason, covers completion, no-show and cancellation, and never reverses money, erases records or resends messages (settlement goes through refund or correction). Q17 / R0-Q3 `appt.handoff_own` is OFF by default and owner-configurable; the recipient must be an eligible practitioner of the same studio and it is refused once the appointment has started or been treated. Q14 / DN-27 practitioners may read published service prices needed for booking, with no private financial setting or client-specific price exposed outside its scope; fee-amount reads stay as today until Q14b.
- **Batch 3 (Sam, 3 Nov):** Q8 expiring and closing unbooked waitlist entries is its own key `wl.expire_close`; claim, release, requeue and claim-next-N stay in `wl.manage_queue`; every `wl.*` key requires `wl.view_queue`; importing never creates consent or sends a message. Q12 `admit.booking_rules` covers booking windows and new-client rules only (studio identity and service duration and buffers stay under their own controls). Q14b staff may read the fee amounts clients see at booking; changing a fee stays `price.fee_amounts`. Q18 an erasure request is owner-only, tracked and audited; the UI says recording one deletes nothing and execution is unavailable (the tracked request needs a held table, number to be claimed). Q19 staff export needs `rep.bulk_export` (OFF by default) plus access to every included row and field, re-checked at generation and at download; credentials, payment secrets and other studios' data are always excluded. Q20 turning the portal off blocks existing links and sessions on their next request (messaging, rebooking and card saving too), keeps records, and intake and consent links must be verified not to bypass it. Q22 with no active owner left, calendar sync pauses, the operator is alerted without client data, and it resumes only when an active owner explicitly reconnects (enforcement stage R4). Q23 a removed reporter loses access to an exposure incident through that studio; the owner keeps it. A6 the recipient of `appt.handoff_own` is an active practitioner of the same studio configured for the service. Q13 and Q15 were settled from existing text (the Open/Waitlist/Closed setting is separate from the admission key; "Not available yet" is only on receptionist legal-name rows).
- **Batch 4 (Sam, 3 Nov):** an assigned client (the `own` scope of portal replies and of the client-price view) is a client of this studio with a non-cancelled appointment CURRENTLY assigned to the actor, past or upcoming; the server evaluates the current assignment, so after a reassignment the former practitioner is denied only when no other qualifying appointment still links them to the client and no studio-wide permission applies, and the relationship alone grants no clinical access; the definition is shown to owners beside the option. Waitlist rules and automation (`wlrules.*`) need no queue-view access; anything that reads or changes an individual entry still needs its `wl.*` key. `client.view_directory` is a fixed baseline for ACTIVE practitioners and receptionists (names and basic contact details, preferred-name privacy kept; no legal identity, clinical information, bulk export or other-studio access). The label "Affects future studio business" sits on service prices, fees, studio hours, waitlist rules and admission rules, each with its own specific effect line (`futureBusinessEffect`; the wording is Team-proposed for OPS to confirm). `clin.view_aftercare` is separate from sending aftercare.
- **Open:** no Q question and no Team-raised item (B-1 to B-3) remains open. A key flagged `pendingDecision` ships with the existing-studio snapshot for every studio; `touchedByDecision` keeps its value and is only marked.
- **Coverage map:** `lib/permissions/coverage.ts` maps all 258 rows of the audit's current-access matrix to a key or a fixed rule (key, safeguard, fixed owner-only, fixed baseline, not a staff permission, owner-only this release). Tests fail if a row is unmapped, a named key does not exist, or a key is unreachable (the exceptions are the four capabilities the product does not have yet: `client.merge`, `comm.bulk_message`, `rep.bulk_export`, `clin.view_id_portrait`). Rows marked `team` were mapped by this lane where the audit left them open, for reviewers to confirm.


## Never configurable (no key exists)

| Item | Source | Effect when an existing studio adopts |
|---|---|---|
| Managing roles, permissions or ownership | Sam C.5 | none |
| Inviting, removing and changing the role of staff; transferring ownership | Sam C.5 | none (R-1, a receptionist created outside the desk, is a hole in exactly this item) |
| Changing the catalog, overrides, operator kill switch or their audit tables | Sam C.5 | none (only through owner-only writer functions) |
| The whole-studio data export and backup | this version | none (`rep.bulk_export` never covers it) |
| Payment-provider credentials, bank accounts and payouts | Sam C.5 | none |
| Studio or account deletion | Sam C.5 | none |
| Permanent deletion and bulk destructive actions | Sam C.5 | none |
| Deleting or altering audit history | Sam C.5 | none |
| Deleting treatment records and photos | Sam C.5, this version | **narrows**: practitioners can soft-delete today. Notice required. |
| Archiving clients | Sam C.5, this version | **narrows**: any practitioner can archive today. Notice required. |
| Restoring deleted records | Sam C.5, this version | **narrows** (unverified today). Notice required. |

**Not offered as toggles** (not in Sam's list, so no key; they stay owner-only because nothing can grant them; flagged for
reviewers to confirm): studio settings (booking rules, integrations, machine registry); payment settings policy such as "card
required" (the settings page must split it from the fee amounts key); viewing signed consent contents and machine settings (ride
on clinical read); the ID-photo store and portrait (not built or feature-off); Hone subscription and billing portal, tax and
currency, receipt branding, business name.

## Mandatory whatever the owner configures

Studio isolation on every path; consent requirements; payment authorization (saved-card authorisation evidence, server-derived
amounts); truthful clinical attribution ("risks explained" records the person who explained; acting for a colleague never
attributes their attestation); the owner has every permission, a studio keeps at least one active owner, nobody promotes
themselves; refunds never exceed the remaining refundable amount, card refunds return to the original card, reasons are
required and originals are preserved; revocation is immediate (current membership, studio, key and scope are checked on every
protected operation, nothing is cached in a token); role and permission changes are audited append-only; the owner finance
activity feed cannot be hidden; service-role money paths verify the actual acting user; reasons are required for every refund,
correction and waiver; the kill switch fails closed; a missing or unreadable policy state is Off; every derived output (export,
print, report, message, audit view) carries only what the actor's own keys would show on screen; the catalog, overrides, kill
switch and audit tables change only through owner-only writer functions; reassigning to yourself cannot evade an own-scope
check (the owner feed flags it).

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
- **Q2 supported clinical keys for receptionists (decided 3 Nov, batch 2):** view-only keys offered and Off by default (records, photos, intake answers). Not offered: edit records, upload photos, edit intake answers, print, complete. The aftercare view-only switch is `clin.view_aftercare` (Sam accepted four receptionist view-only switches, each Off; the key name is Team's).
- **Q3 reassigning your own appointment (decided 3 Nov, batch 2):** the separate key `appt.handoff_own`, OFF by default, owner-configurable.
- **Q4 receptionist legal name:** both reviewers earlier wanted these keys unavailable this release. Sam's spec makes them
  enableable. They are gated on 0280/0290 name privacy and a read audit, and practitioner legal-name edit on stale-write
  protection (#1328 / M1). Decision needed.
- **Q5 items not in Sam's list** (booking rules, integrations, billing, branding): no key, owner-only by absence.
- **Q6 the receptionist snapshot is Off almost everywhere:** the desk is behind a flag that is OFF and a receptionist cannot be
  created through the product today (R-1 is an API-only path), so there is nothing approved to preserve.
- **Q7 narrowing notices:** the three fixed owner-only items narrow what existing practitioners can do and have no key to hold
  in a snapshot. Either (A) they apply on release with a notice in the owner's review banner, or (B) they narrow on adoption
  (tied to the policy basis). Needs Sam's decision. The database objects that enforce them are listed in the catalog
  (`enforcedBy`) as R4's checklist.
- **Q8 snapshot values still resting on a source reading:** a test pins the list; OPS verifies each before the seed migration
  is reviewed. Two that could widen if the reading were wrong (`clin.edit_intake`, `comm.send_routine` for practitioners) were
  narrowed to Off meanwhile.
- **Q9 receptionist legal-name snapshot** is Off for every studio (approved policy). Counting any studio whose per-studio switch
  is ON is a separate read-only step; such a studio is listed in the owner's review banner, not carried forward.


## Design: permanent client erasure (DN-18, design only)

Execution is **unavailable**. This is the owner-only workflow a later release builds, so the shape is agreed before any deletion code exists.

1. **Request.** Only the owner can open an erasure request for one client, with a stated reason and the basis (for example the client's own request). Opening a request changes nothing about the client's records.
2. **Review.** The request lists, per area (chart, photos, intake and consent, messages, payments and settlement, audit), what exists, what a retention requirement or exception may oblige the studio to keep, and what would remain in backups. The review is recorded.
3. **Confirmation.** A second, explicit owner confirmation naming the client and the scope, after the review is complete. Staff cannot request, review or confirm.
4. **Execution.** Not built and not callable in this release. It stays unavailable until retention requirements and exceptions have been reviewed. **No retention period is invented here.**
5. **Statements the product must never make:** that data is erased from backups, or that erasure is complete, before that is true.

Every step keeps a reason and history. Archiving (recoverable) remains the ordinary way to remove a client from view.


## Enforcement state per key (Privacy X3)

The `enforcement` field on each catalog key says which keys the code acts on in this release: `enforced`, `observe` (asked and logged, never blocks) or `not_yet` (default). The Roles page shows `not_yet` keys as "Not enforced yet" and not editable. The map is proved equal to the keys the app asks by the wiring test.

R5 slice 1 (stacked on R4): `client.create` (new-client page and the quick-book drawer) and `comm.send_routine` (booking confirmation, cancellation and move messages) are `enforced`. A denied message key withholds the MESSAGE and never fails the committed action. `client.edit_contact` stays `not_yet` on purpose: its masked audit needs a governed database command that ships with the held R5 migration, and the key is not gated before that audit exists.
