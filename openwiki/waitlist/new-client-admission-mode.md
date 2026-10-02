---
type: authority and rollout
title: New-client admission mode (WAIT)
description: How Hone decides whether a NEW client may book, must join the waitlist, or is refused — the persisted studios.new_client_admission_mode from migration 0204, the exact precedence against the legacy env-list bridges, the commit-time database authority, the owner's setting and its cutover rule, the public join path's durable-versus-email commit point, and the activation plan kept separate from the dated execution record.
tags: [waitlist, admission-mode, rollout, env-bridge, public-booking, production-truth]
sources:
  - id: openwiki-source-49c684e8a4483aac1952fc22
    resource: repo://app/(app)/settings/booking/actions.ts
  - id: openwiki-source-0363482ccbf717d247012eaf
    resource: repo://app/book/%5Bslug%5D/waitlist-actions.ts
  - id: openwiki-source-e2ff2d5ec8ce9ed68fec4e72
    resource: repo://docs/production/migration-state.json
  - id: openwiki-source-cd8194c7c1be9b4a3a2f6273
    resource: repo://docs/production/new-client-admission-activation.md
  - id: openwiki-source-bab23e2e6097e90f4694626b
    resource: repo://docs/production/new-client-admission-execution-record.md
  - id: openwiki-source-38e459872237174e0fdc0fca
    resource: repo://lib/booking/new-client-admission.ts
  - id: openwiki-source-ddc23a742207481bbbc9d05c
    resource: repo://lib/booking/new-client-waitlist-durability-bridge.ts
  - id: openwiki-source-54e15b7982e477c094cc77f4
    resource: repo://supabase/migrations/0193_waitlist_admission_authority.sql
  - id: openwiki-source-f12a840b2f4a93ce89828ca9
    resource: repo://supabase/migrations/0204_new_client_admission_mode.sql
  - id: openwiki-source-b037985cdab5a0d739ca0a36
    resource: repo://tests/migrations/0204-new-client-admission-mode.test.ts
generated: { by: "claude-code", at: "2026-10-02T22:34:57.394Z" }
verified:
  - by: openwiki/0.6.1
    at: 2026-10-02T22:34:57.394Z
---

# New-client admission mode (WAIT)

Every studio has one **new-client** admission mode. **Existing clients are never governed by it**: their
booking, portal access and rebooking sit outside this authority in every mode
([`lib/booking/new-client-admission.ts` L5-L34](../../lib/booking/new-client-admission.ts#L5-L34)).

| Mode | New client may |
|---|---|
| `open` | book normally |
| `waitlist` | not book; join the waitlist |
| `closed` | neither book nor join; the page says so |
| *unknown* (the read failed) | nothing — **unknown is not open**. Every new-client mutation refuses it |

What happens after someone joins is on [Waitlist entries and invitation lifecycle](entries-and-invitation-lifecycle.md).
The public booking flow is on [Public booking, reschedule and cancellation](../scheduling/public-booking-reschedule-and-cancellation.md).

## 1. The persisted mode (`0204`)

**Columns** ([`0204` L1-L128](../../supabase/migrations/0204_new_client_admission_mode.sql#L1-L128)):

- `studios.new_client_admission_mode` is `text not null default 'open'`, checked to be `open`, `waitlist` or
  `closed`. The default reproduces the behaviour of any studio absent from the legacy env list.
- `new_client_admission_mode_set_at` and `set_by` record **who chose it and when**. There is deliberately no
  foreign key, because a second studios–practitioners relationship would make every existing PostgREST embed
  ambiguous.

**One writer: `set_new_client_admission_mode(studio, mode)`**
([L130-L256](../../supabase/migrations/0204_new_client_admission_mode.sql#L130-L256)):

- It is authenticated-callable, and the browser supplies only the mode.
- Owner role comes from `is_studio_owner` reading `auth.uid()`; the actor and the timestamp come from the session
  and the database clock.
- Outcomes: `ok`, `not_authorized`, `studio_not_found`, `invalid_mode` and `legacy_waitlist_cutover_required`.
- **An unstamped studio (`set_at IS NULL`) cannot move to `open` or `closed`.** It must choose `waitlist` once.
  That stamps the row, completes its cutover and makes its joins durable. The rule is read from the row under
  the command's own lock, so no caller-supplied argument can get around it.
- A `BEFORE UPDATE` guard trigger rejects any change to the three admission fields unless a transaction-local
  permit names **this** studio. That makes the command the only writer, even though `studios` is otherwise
  owner-updatable ([L258-L313](../../supabase/migrations/0204_new_client_admission_mode.sql#L258-L313)).

**Commit-time authority.**

- `effective_new_client_admission` takes `studios FOR NO KEY UPDATE`, then resolves the mode inside the
  mutation's own transaction. A booking or join and an owner's change are therefore **serially ordered**, never
  interleaved ([L333-L445](../../supabase/migrations/0204_new_client_admission_mode.sql#L333-L445)).
- `create_public_appointment_for_new_client` and `join_new_client_waitlist_guarded` carry this check and are
  `service_role`-only. `create_public_appointment` is untouched, so existing-client booking is unaffected.

## 2. Precedence: persisted mode versus the env bridges

`resolveAdmission` is the single resolver and every surface goes through it
([L100-L168](../../lib/booking/new-client-admission.ts#L100-L168)). It decides in this order:

| # | Condition | Effective mode | Source |
|---|---|---|---|
| 1 | the studios read failed, or the stored value is outside the closed set | *unknown* (refuse) | — |
| 2 | nothing stored (only before `0204`, signalled by a missing-column error) | `waitlist` if the slug is in `NEW_CLIENT_WAITLIST_STUDIO_SLUGS`, else `open` | `legacy_bridge` |
| 3 | `set_at` is not null (an owner chose) | **the stored mode, including `open`** | `persisted` |
| 4 | unstamped, stored `open`, slug listed | `waitlist` | `legacy_bridge` |
| 5 | unstamped, otherwise | the stored mode | `legacy_bridge` |

**The bridge escalates one way only.** It can make an **unchosen** `open` into `waitlist`, and it can never
relax anything. A stale env value can therefore only keep a studio on a waitlist it already had.

The application read uses the **service-role** client for exactly two columns
([L177-L260](../../lib/booking/new-client-admission.ts#L177-L260)). The RLS client returns no `studios` row to a
public visitor, and that once let paused or closed studios keep taking bookings. Read failures are handled like
this:

- **Missing column** — migration skew before `0204` applied; falls through to the bridge.
- **Missing row** — fails closed.
- **Any other error** — fails closed.

The database side applies the same one-way rule. The service-role caller passes the bridge fact only for an
**unstamped** row; once the row is stamped, persisted authority wins and the argument is ignored.

### The second env list decides where a permitted join commits

`NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS` is read from exactly one deletable file
([`new-client-waitlist-durability-bridge.ts` L1-L67](../../lib/booking/new-client-waitlist-durability-bridge.ts#L1-L67)):

- **Cut over (persisted waitlist):** always **durable** — a `new_client_waitlist_entries` row is written.
- **On the bridge:** durable only if the slug is on the durable list. Otherwise the join commits through the
  legacy **email-acceptance** path, so a deploy does not move a studio's commit point.

## 3. Surfaces

- **Owner setting.** `updateNewClientAdmissionModeAction` resolves the studio on the server, requires the owner
  role, sends only the intent, and maps `legacy_waitlist_cutover_required` to copy that names the one action that
  unlocks Open and Closed
  (`app/(app)/settings/booking/actions.ts` L190-L255).
- **Public join** (`submitNewClientBookingWaitlistAction`)
  ([`book/[slug]/waitlist-actions.ts` L575-L622](../../app/book/[slug]/waitlist-actions.ts#L575-L622)):
  1. resolves the mode from the server-resolved studio; only `waitlist` admits a join, and this check runs
     *before* the rate limiter so a refused studio spends no quota;
  2. applies the studio-scoped limiter;
  3. commits durably or by email according to §2. The durable path re-checks admission at commit inside the
     guarded command.

## 4. Activation: plan, record, unknowns

**Status: migration-applied, deployed, partially cut over.** `0204` is within the declared hosted range
([`migration-state.json` L16](../../docs/production/migration-state.json#L16-L16)), and its migration test asserts
hosted equals repository at `0204`
([`0204-new-client-admission-mode.test.ts` L35-L65](../../tests/migrations/0204-new-client-admission-mode.test.ts#L35-L65)).

**The plan (designed)** is the frozen contract
([`new-client-admission-activation.md` § Steps, in order](../../docs/production/new-client-admission-activation.md#steps-in-order)).
It is migration-first:

| Step | Plan |
|---|---|
| A | verify the baseline |
| B | apply `0204` |
| C | verify columns, the single FK and the exact grants |
| D | deploy the application |
| E | **read both live env lists** and record the slug sets |
| F | cut each **listed** studio over by an owner writing `waitlist` |
| G | verify a durable join |
| H | retire the bridge code, then the durable env variable — last |

`NEW_CLIENT_WAITLIST_STUDIO_SLUGS` itself must stay, because the free-consult reschedule policy reads it as its
own authority. The plan also states that env values are **Vercel secrets** and that no studio's mode may be
inferred from rows or documents ([§ What must NOT be inferred](../../docs/production/new-client-admission-activation.md#what-must-not-be-inferred)).

**The record (production-exercised, dated 2026-10-01)** is the append-only execution record
([`new-client-admission-execution-record.md` § EXECUTION RECORD — 2026-10-01](../../docs/production/new-client-admission-execution-record.md#execution-record--2026-10-01)):

| Step | Recorded state |
|---|---|
| A–D | done |
| **E** | **never performed** — no slug set is recorded |
| **F** | **one** studio's owner wrote `waitlist`; **completeness unknown** until E is done |
| G | passed with a synthetic prospect through the public form, which committed an entry row |
| H | not started; both bridges remain in the deployed tree |

**What remains unknown.** Which other studios, if any, are listed in either env variable. **Unstamped does not
mean listed**: stamping an unlisted studio `waitlist` would close a currently open studio to new clients.

## 5. Contradictions and open questions

1. **`0204` says it was not applied.** Its header reads "CANDIDATE, NOT APPLIED" and claims the number from a
   hosted maximum of `0203` ([L5-L7](../../supabase/migrations/0204_new_client_admission_mode.sql#L5-L7)). The
   file is frozen, while the canonical record and the migration test say it is applied. The header is a
   historical statement and the record is the authority.
2. **The column comment overstates the privilege boundary.** `0204` documents the column as "Set exclusively
   through public.set_new_client_admission_mode(); no role holds direct UPDATE on this table"
   ([L69-L74](../../supabase/migrations/0204_new_client_admission_mode.sql#L69-L74)). But `0193` records that the
   default grants and the `owners update` policy leave UPDATE on `studios` for browser roles
   ([`0193` L28-L43](../../supabase/migrations/0193_waitlist_admission_authority.sql#L28-L43)). The one-writer
   rule is enforced by the guard trigger's permit, not by the absence of an UPDATE privilege.
3. **The guard trigger function is not revoked.** `studios_admission_mode_guard()` was created without the
   revokes its sibling functions received (known limitation L33, P3, not exploitable). The `0204` migration
   test's grant section checks the commands, not this function.
4. **The plan's preamble and its frozen body come from different moments.** The preamble scopes "nothing has
   been executed" to the time of writing and points to the record. The body still says, for example, "Leave
   [the pilot studio] in WAITLIST" as a future step, while the record shows it done. By the file's own rule the
   plan is the contract and the record is evidence, so read the steps as procedure, not status.
