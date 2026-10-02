---
type: write-authority contract
title: Appointment write authority and lifecycle commands
description: The appointment boundary as it stands after migrations 0170–0177 — no role may write appointments or appointment_audit directly, every mutation goes through a reviewed SECURITY DEFINER command that emits exactly one audit event, the shared lock protocol, the status-transition guard, attribution columns, repair commands, and which application files call which command.
tags: [appointments, write-authority, security-definer, audit, status-transitions, scheduling]
verified:
  - by: openwiki/0.6.1
    at: 2026-10-02T20:08:11.217Z
sources:
  - id: openwiki-source-e9162711763ff32ea530713a
    resource: repo://supabase/migrations/0170_public_appointment_command.sql
  - id: openwiki-source-8bd6e27557ff3f9370c10d38
    resource: repo://supabase/migrations/0172_revoke_authenticated_appointment_dml.sql
  - id: openwiki-source-8b8be5b28e40991c64830be0
    resource: repo://supabase/migrations/0173_appointment_repair_commands.sql
  - id: openwiki-source-a5b14bd2ac4cc9c166ea04b5
    resource: repo://supabase/migrations/0174_appointment_attribution_and_audit_integrity.sql
  - id: openwiki-source-282ef9a6314da1dc97cc53f2
    resource: repo://supabase/migrations/0175_appointment_transition_integrity.sql
  - id: openwiki-source-1ced3f474605611d4f5c4420
    resource: repo://supabase/migrations/0177_postcare_write_boundary.sql
  - id: openwiki-source-4dfecfd03b5b8d11602a352b
    resource: repo://supabase/migrations/0195_waitlist_atomic_booking_conversion.sql
  - id: openwiki-source-f12a840b2f4a93ce89828ca9
    resource: repo://supabase/migrations/0204_new_client_admission_mode.sql
  - id: openwiki-source-3e56d4e8e5365832648fbd87
    resource: repo://tests/db/appointment-attribution-audit-integrity.db.test.ts
  - id: openwiki-source-9188492d2f9df2742267514c
    resource: repo://tests/db/appointment-audit-invariant.db.test.ts
  - id: openwiki-source-791f40bb8bb6506691a7ab77
    resource: repo://tests/db/appointment-transition-integrity.db.test.ts
  - id: openwiki-source-11648a9666718de27ec6edcf
    resource: repo://tests/db/internal-booking-command.db.test.ts
  - id: openwiki-source-746caa4127e2db9c4b34e509
    resource: repo://tests/security/appointment-direct-dml-guard.test.ts
  - id: openwiki-source-833044c4d4591cb2eabb5a7e
    resource: repo://tests/security/service-role-allowlist.ts
generated: { by: "claude-code", at: "2026-10-02T20:08:11.217Z" }
---

# Appointment write authority and lifecycle commands

## 1. The rule

Migration `0174` states the architecture the whole boundary program (B1–B8, migrations
`0170`–`0177`) converged on ([`0174` L31-L50](../../supabase/migrations/0174_appointment_attribution_and_audit_integrity.sql#L31-L50)):

```
legitimate appointment business mutation
  → reviewed SECURITY DEFINER command
  → mutation
  → exactly ONE semantic appointment_audit event

raw lifecycle DML (any role)  → DENIED
```

Triggers on `appointments` protect **fields and edges**; they never invent an audit event — the
commands are the only writers of audit *actions*.

## 2. Privilege boundary (who can touch the tables)

| Step | Effect | Evidence |
|---|---|---|
| `0172` (B3) | `anon` and `authenticated` lose `INSERT/UPDATE/DELETE` (and `TRUNCATE/REFERENCES/TRIGGER/MAINTAIN`) on `appointments` **and** `appointment_audit`; the header records that a static census had already proven zero authenticated writers | [`0172` L1-L45](../../supabase/migrations/0172_revoke_authenticated_appointment_dml.sql#L1-L45), [L265-L287](../../supabase/migrations/0172_revoke_authenticated_appointment_dml.sql#L265-L287) |
| `0174` (B5) | `service_role` loses lifecycle DML except a temporary column-level UPDATE on six postcare bookkeeping columns | [`0174` L1-L80](../../supabase/migrations/0174_appointment_attribution_and_audit_integrity.sql#L1-L80) |
| `0177` (B8) | the last direct writers (postcare) move to `claim_postcare_send` → provider → `settle_postcare_send`; **`service_role` on `appointments`: SELECT only, zero column UPDATE** | [`0177` L1-L28](../../supabase/migrations/0177_postcare_write_boundary.sql#L1-L28) |

The application census is enforced by
[`tests/security/appointment-direct-dml-guard.test.ts`](../../tests/security/appointment-direct-dml-guard.test.ts#L518-L740):
a TypeScript-compiler-based analyzer (alias-resistant, with a non-vacuity proof) must find **zero**
direct `appointments` writers and zero `appointment_audit` runtime writers.

## 3. The commands

Every command below is `SECURITY DEFINER` with a pinned `search_path` and is executable by
**`service_role` only** (browser roles revoked by name); the calling server action resolves
`studio.id` and the acting practitioner with `getCurrentPractitionerWithStudio()` and the command
re-derives membership and role (Pattern A in [System overview](../architecture/system-overview.md)).

| Command | Latest definition | Called from | Audit action |
|---|---|---|---|
| `create_public_appointment` | [`0170` L636-L923](../../supabase/migrations/0170_public_appointment_command.sql#L636-L923) | `app/book/[slug]/actions.ts`, `app/portal/rebook-actions.ts`; wrapped by the two below | `created` (client actor) |
| `create_public_appointment_for_new_client` | [`0204` L558-L748](../../supabase/migrations/0204_new_client_admission_mode.sql#L558-L748) (delegates to `create_public_appointment`, [L730](../../supabase/migrations/0204_new_client_admission_mode.sql#L730-L730)) | `app/book/[slug]/actions.ts` | via the inner command |
| `create_waitlist_public_appointment` | [`0195` L263-L540](../../supabase/migrations/0195_waitlist_atomic_booking_conversion.sql#L263-L540) (delegates, [L528](../../supabase/migrations/0195_waitlist_atomic_booking_conversion.sql#L528-L528)) | `app/book/[slug]/actions.ts` | via the inner command; conversion recorded on the waitlist entry |
| `create_internal_appointment_v2` | [`0174` L693](../../supabase/migrations/0174_appointment_attribution_and_audit_integrity.sql#L693-L693) (first `0146`, then `0152`) | `app/(app)/calendar/actions.ts` | `created` (practitioner actor) |
| `move_or_reassign_appointment` | [`0174` L936](../../supabase/migrations/0174_appointment_attribution_and_audit_integrity.sql#L936-L936) | `app/(app)/calendar/move-appointment-actions.ts` | `moved` (no status change) |
| `reschedule_appointment_v2` | [`0171` L797](../../supabase/migrations/0171_public_reschedule_command_v2.sql#L797-L797) | `app/reschedule/[token]/actions.ts` | `cancelled` on the original + `created` on the successor |
| `public_cancel_appointment_with_token` | [`0176` L312](../../supabase/migrations/0176_public_cancellation_atomicity.sql#L312-L312) | `app/cancel/[token]/actions.ts` | `cancelled` (client actor) |
| `practitioner_cancel_appointment` | [`0174` L855](../../supabase/migrations/0174_appointment_attribution_and_audit_integrity.sql#L855-L855) | `app/(app)/calendar/actions.ts` | `cancelled` (practitioner) |
| `mark_appointment_complete` | [`0175` L59-L114](../../supabase/migrations/0175_appointment_transition_integrity.sql#L59-L114) | calendar actions; session start | `completed` |
| `mark_appointment_no_show` | [`0033` L334-L396](../../supabase/migrations/0033_pre_stripe_operational_hardening.sql#L334-L396) | calendar actions | `no_show` |
| `revert_appointment_outcome`, `set_appointment_notes` | [`0173` L334](../../supabase/migrations/0173_appointment_repair_commands.sql#L334-L334), [L497](../../supabase/migrations/0173_appointment_repair_commands.sql#L497-L497) | `app/(app)/calendar/appointment-repair-actions.ts` | via `write_appointment_audit` |
| `claim_postcare_send`, `settle_postcare_send` | [`0177` L112](../../supabase/migrations/0177_postcare_write_boundary.sql#L112-L112), [L240](../../supabase/migrations/0177_postcare_write_boundary.sql#L240-L240) | calendar actions, `postcare-auto-send.ts` | bookkeeping only |

The installed set of functions that insert into `appointment_audit` is pinned by a DB test to exactly
`create_internal_appointment_v2`, `create_public_appointment`, `mark_appointment_complete`,
`mark_appointment_no_show`, `move_or_reassign_appointment`, `practitioner_cancel_appointment`,
`public_cancel_appointment_with_token`, `reschedule_appointment_v2` and `write_appointment_audit`,
with no trigger writing audit rows ([`appointment-audit-invariant.db.test.ts` L253-L300](../../tests/db/appointment-audit-invariant.db.test.ts#L253-L300)).

Legacy RPCs `reschedule_appointment`, `practitioner_move_appointment` and `create_internal_appointment`
were **dropped** in `0175` ([L236-L250](../../supabase/migrations/0175_appointment_transition_integrity.sql#L236-L250)).

### What `create_public_appointment` does, in order

Locks the studio row `FOR UPDATE`, takes the studio capacity advisory lock, refuses when public
booking is unavailable, validates the time and the **studio-local** booking horizon (months × 31
days, inclusive), validates the client and locks the service row, checks availability and conflicts,
inserts the appointment with server-derived duration/end/status/practitioner/capacity/buffer fields,
and inserts the `created` audit row **in the same transaction**
([`0170` L636-L923](../../supabase/migrations/0170_public_appointment_command.sql#L636-L923);
history of the two-transaction defect it replaced at [L1-L40](../../supabase/migrations/0170_public_appointment_command.sql#L1-L40)).
A `23P01` exclusion violation from the double-booking constraint is a legitimate outcome. Slot and
buffer semantics are on [Availability, slots, buffers and timezones](availability-slots-buffers-and-timezones.md);
the lock order on [Concurrency and lock order](concurrency-and-lock-order.md).

### Internal booking rules (proved in DB tests)

Owners may book for any eligible practitioner, members only for themselves; inactive, ineligible and
cross-studio targets, past times and non-positive durations are refused; with capacity on, two
bookings for one practitioner at one time yield one success and one `23P01`, while parallel
practitioners both succeed; a studio advisory lock serializes concurrent bookings
([`internal-booking-command.db.test.ts` L105-L180](../../tests/db/internal-booking-command.db.test.ts#L105-L180)).

## 4. Status lifecycle (`0175`)

- Allowed edges: `confirmed → completed | cancelled | no_show` and the repair-only
  `completed | cancelled | no_show → confirmed`; any other change, **and any same-status rewrite**,
  raises `23514` from a `BEFORE UPDATE OF status` trigger with no bypass
  ([`0175` L120-L184](../../supabase/migrations/0175_appointment_transition_integrity.sql#L120-L184)).
- `mark_appointment_complete` is allowed from `starts_at` (early completion); no-show stays gated on
  `ends_at`; completing early **does not release capacity** — the booked interval stays scheduling
  truth ([L1-L58](../../supabase/migrations/0175_appointment_transition_integrity.sql#L1-L58);
  proved in [`appointment-transition-integrity.db.test.ts` L73-L320](../../tests/db/appointment-transition-integrity.db.test.ts#L73-L320)).
- `updated_at` is database-authoritative, and the `capacity_enabled` snapshot is no longer re-derived
  by status changes.

## 5. Repair commands (`0173`)

`revert_appointment_outcome` (terminal → `confirmed`) is **owner-only**, limited to a **72-hour**
audit-anchored window, refused when blocking dependents exist (it reports `blocked_<class>`), and
can collide with a booking that took the slot (`23P01`); `set_appointment_notes` corrects notes for a
member. Both lock with the shared protocol — studio row `FOR UPDATE` → studio capacity advisory lock
→ appointment row `FOR UPDATE` ([`0173` L1-L80](../../supabase/migrations/0173_appointment_repair_commands.sql#L1-L80),
[L334-L410](../../supabase/migrations/0173_appointment_repair_commands.sql#L334-L410)). `0173` also
closed limitation L23 (FK actions writing appointments through parent deletes).

## 6. Attribution and audit durability (`0174`)

Adds `created_by_practitioner_id`, `cancelled_by_practitioner_id` and the
outside-availability-override authoriser columns (NULL meaning "no practitioner actor", the truth
for public bookings and client-token cancellations); audit rows gain their own `studio_id` and
survive the parent, `created_at` is server-derived, and an append-only guard protects them
([`0174` L1-L64](../../supabase/migrations/0174_appointment_attribution_and_audit_integrity.sql#L1-L64),
[L95-L110](../../supabase/migrations/0174_appointment_attribution_and_audit_integrity.sql#L95-L110),
[L1204](../../supabase/migrations/0174_appointment_attribution_and_audit_integrity.sql#L1204-L1204)).
Proof: [`appointment-attribution-audit-integrity.db.test.ts` L194-L380](../../tests/db/appointment-attribution-audit-integrity.db.test.ts#L194-L380).

## 7. Change checklist

- A new appointment mutation is a new or extended command in a **new** migration, with exactly one
  audit action, browser roles revoked by name, and a DB test; update the pinned audit-writer set.
- Never add `.from("appointments").insert/update/delete` in application code — the census guard
  fails.
- Do not re-emit `snapshot_appointment_buffer()` (see §8.1).

## 8. Contradictions and open questions

1. **Production differs from repository source for `snapshot_appointment_buffer()`.** `0173`, `0174`
   and `0175` each record a standing prohibition: production carries out-of-band GUC behaviour in that
   trigger function which exists in no migration in this repository, so re-emitting it from source
   could delete live behaviour
   ([`0173` L31-L36](../../supabase/migrations/0173_appointment_repair_commands.sql#L31-L36),
   [`0175` L18-L22](../../supabase/migrations/0175_appointment_transition_integrity.sql#L18-L22)).
   The repository therefore cannot fully describe that function's production behaviour.
2. **The service-role allowlist carries a stale lineage note.** Its entry for
   `move-appointment-actions.ts` says `move_or_reassign_appointment`'s effective definition is `0152`
   and that `practitioner_move_appointment` is a caller-less legacy delegate
   ([`service-role-allowlist.ts` L84-L92](../../tests/security/service-role-allowlist.ts#L84-L92));
   the latest definition is `0174` and `0175` dropped the legacy function.
