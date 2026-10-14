---
type: product rule
title: New-client admission mode (WAIT)
description: How Hone decides whether a NEW client may book, must join the waitlist, or is refused — the persisted studios.new_client_admission_mode from migration 0204 and the 0205 creation-time default that makes a new studio born initialized, the exact precedence against the legacy env-list bridges, the commit-time database authority, the owner's setting and its cutover rule, the public join path's durable-versus-email commit point, and the activation plan kept separate from the dated execution record.
tags: [waitlist, admission, new-clients, studios, migrations, booking]
verified:
  - by: openwiki/0.6.1
    at: 2026-10-04T01:59:59.625Z
sources:
  - id: openwiki-source-49c684e8a4483aac1952fc22
    resource: repo://app/(app)/settings/booking/actions.ts
  - id: openwiki-source-0363482ccbf717d247012eaf
    resource: repo://app/book/%5Bslug%5D/waitlist-actions.ts
  - id: openwiki-source-f79f369ce2044c952565dcb9
    resource: repo://docs/production/migration-ledger.md
  - id: openwiki-source-cd8194c7c1be9b4a3a2f6273
    resource: repo://docs/production/new-client-admission-activation.md
  - id: openwiki-source-bab23e2e6097e90f4694626b
    resource: repo://docs/production/new-client-admission-execution-record.md
  - id: openwiki-source-7429c4c43fb7560dad86e03b
    resource: repo://e2e/new-client-waitlist.spec.ts
  - id: openwiki-source-38e459872237174e0fdc0fca
    resource: repo://lib/booking/new-client-admission.ts
  - id: openwiki-source-ddc23a742207481bbbc9d05c
    resource: repo://lib/booking/new-client-waitlist-durability-bridge.ts
  - id: openwiki-source-54e15b7982e477c094cc77f4
    resource: repo://supabase/migrations/0193_waitlist_admission_authority.sql
  - id: openwiki-source-f12a840b2f4a93ce89828ca9
    resource: repo://supabase/migrations/0204_new_client_admission_mode.sql
  - id: openwiki-source-3db2567b429ae2564d61afad
    resource: repo://supabase/migrations/0205_new_studio_admission_default.sql
  - id: openwiki-source-a87a68844b5095cca3dacebe
    resource: repo://tests/db/new-client-admission-commit-authority.db.test.ts
  - id: openwiki-source-a122c291bea87f78ace90c43
    resource: repo://tests/db/new-studio-admission-default.db.test.ts
  - id: openwiki-source-84ee60a98182dfa16e1f3603
    resource: repo://tests/docs/canonical-production-facts.test.ts
  - id: openwiki-source-b037985cdab5a0d739ca0a36
    resource: repo://tests/migrations/0204-new-client-admission-mode.test.ts
generated: { by: "claude-code", at: "2026-10-04T01:59:59.625Z" }
---

# New-client admission mode (WAIT)

Every studio has one **new-client** admission mode. **Existing clients are never governed by it**: their booking,
portal access and rebooking sit outside this authority in every mode
([`lib/booking/new-client-admission.ts` L5-L34](../../lib/booking/new-client-admission.ts#L5-L34)).

| Mode | New client may |
|---|---|
| `open` | book normally |
| `waitlist` | not book; join the waitlist |
| `closed` | neither book nor join; the page says so |
| *unknown* (the read failed) | nothing: **unknown is not open**, and every new-client mutation refuses it |

What happens after someone joins is on [Waitlist entries and invitation lifecycle](entries-and-invitation-lifecycle.md).
The public booking flow is on
[Public booking, reschedule and cancellation flows](../scheduling/public-booking-reschedule-and-cancellation.md).

## 1. The persisted mode (`0204`)

**Columns** ([`0204` L1-L128](../../supabase/migrations/0204_new_client_admission_mode.sql#L1-L128)):

- `studios.new_client_admission_mode` is `text not null default 'open'`, checked to be `open`, `waitlist` or `closed`.
  The default reproduces the behaviour of any studio absent from the legacy env list.
- `new_client_admission_mode_set_at` and `set_by` record when the authority was initialized or changed and by whom.
  There is deliberately no foreign key, because a second studios–practitioners relationship would make every existing
  PostgREST embed ambiguous.

**One writer: `set_new_client_admission_mode(studio, mode)`**
([L130-L256](../../supabase/migrations/0204_new_client_admission_mode.sql#L130-L256)):

- It is authenticated-callable, and the browser supplies only the mode.
- Owner role comes from `is_studio_owner` reading `auth.uid()`; the actor and the timestamp come from the session and
  the database clock.
- Outcomes: `ok`, `not_authorized`, `studio_not_found`, `invalid_mode` and `legacy_waitlist_cutover_required`.
- **An unstamped studio (`set_at IS NULL`) cannot move to `open` or `closed`.** It must choose `waitlist` once, which
  stamps the row, completes its cutover and makes its joins durable. The rule is read from the row under the command's
  own lock, so no caller-supplied argument can get around it.
- A `BEFORE UPDATE` guard trigger rejects any change to the three admission fields unless a transaction-local permit
  names **this** studio. That makes the command the only writer, even though `studios` is otherwise owner-updatable
  ([L258-L313](../../supabase/migrations/0204_new_client_admission_mode.sql#L258-L313);
  [`0204` test L135-L166](../../tests/migrations/0204-new-client-admission-mode.test.ts#L135-L166)).

**Commit-time authority.** `effective_new_client_admission` takes `studios FOR NO KEY UPDATE`, then resolves the mode
inside the mutation's own transaction, so a booking or join and an owner's change are **serially ordered**, never
interleaved ([L333-L445](../../supabase/migrations/0204_new_client_admission_mode.sql#L333-L445)).
`create_public_appointment_for_new_client` and `join_new_client_waitlist_guarded` carry this check and are
`service_role`-only; `create_public_appointment` is untouched, so existing-client booking is unaffected.

## 2. A new studio is born initialized (`0205`)

`0204` left `set_at` without a default and reads `set_at IS NULL` as the marker of an unstamped pre-`0204` legacy row,
so a studio created after `0204` looked exactly like a legacy row and its new owner was sent through the cutover
ceremony. `0205` gives `set_at` a `now()` default and changes no logic
([`0205` L1-L32](../../supabase/migrations/0205_new_studio_admission_default.sql#L1-L32),
[L283-L297](../../supabase/migrations/0205_new_studio_admission_default.sql#L283-L297)). Since `0205`, **a non-null
`set_at` means the persisted authority is initialized, not that an owner chose**. Under the current product paths:

| `set_at` | `set_by` | What the row is |
|---|---|---|
| NULL | NULL | never initialized: a **pre-`0204` legacy row**, with unstamped transition semantics |
| non-null | NULL | **system-initialized at studio creation** by the `0205` default: persisted `open`, no cutover ceremony |
| non-null | set | an **owner changed the mode** through `set_new_client_admission_mode` |

This is a reading of what the product paths produce, not a partition the schema enforces: `set_by` has no foreign key
and `studios` has no INSERT trigger, so an explicit INSERT could write either column
([`new-client-admission-activation.md` § The transition rule](../../docs/production/new-client-admission-activation.md#the-transition-rule)).
Resolution asks only "initialized or not", so both initialized states resolve the same way; nothing in the resolver
reads `set_by` ([L101-L144](../../lib/booking/new-client-admission.ts#L101-L144)). A fresh owner can therefore choose
Open, Waitlist or Closed immediately, and the legacy guard still refuses genuinely unstamped rows
([`new-studio-admission-default.db.test.ts` L502-L637](../../tests/db/new-studio-admission-default.db.test.ts#L502-L637)).
How the studio is created is on
[Studio onboarding, settings and data portability](../studio/onboarding-settings-and-data-portability.md).

**Consequence for tests of the legacy bridge.** Seeded studios are now born stamped, so the commit-authority database
suite and the new-client waitlist browser spec explicitly **unstamp** a studio, through the same transaction-local
permit the command uses, before exercising bridge behaviour; the browser spec fails at setup if the unstamp did not
take ([`new-client-admission-commit-authority.db.test.ts` L144-L175](../../tests/db/new-client-admission-commit-authority.db.test.ts#L144-L175);
[`e2e/new-client-waitlist.spec.ts` L57-L112](../../e2e/new-client-waitlist.spec.ts#L57-L112)).

## 3. Precedence: persisted mode versus the env bridges

`resolveAdmission` is the single resolver, and every surface goes through it
([L101-L193](../../lib/booking/new-client-admission.ts#L101-L193)). It decides in this order:

| # | Condition | Effective mode | Source |
|---|---|---|---|
| 1 | the studios read failed, or the stored value is outside the closed set | *unknown* (refuse) | — |
| 2 | nothing stored (only before `0204`, signalled by a missing-column error) | `waitlist` if the slug is in `NEW_CLIENT_WAITLIST_STUDIO_SLUGS`, else `open` | `legacy_bridge` |
| 3 | `set_at` is not null (initialized: by the system at creation since `0205`, or by an owner) | **the stored mode, including `open`** | `persisted` |
| 4 | unstamped, stored `open`, slug listed | `waitlist` | `legacy_bridge` |
| 5 | unstamped, otherwise | the stored mode | `legacy_bridge` |

**The bridge escalates one way only.** It can turn a never-initialized `open` into `waitlist`, and it can never relax
anything, so a stale env value can only keep a studio on a waitlist it already had. Since `0205` the bridge no longer
decides admission for any studio created after that migration, because such studios take row 3 from birth.

The application read uses the **service-role** client for exactly the admission columns
([L202-L287](../../lib/booking/new-client-admission.ts#L202-L287)). The RLS client returns no `studios` row to a public
visitor, and that once let paused or closed studios keep taking bookings. A missing column (migration skew before
`0204`) falls through to the bridge; a missing row or any other error fails closed. The database side applies the same
one-way rule: the service-role caller passes the bridge fact only for an **unstamped** row, and once the row is stamped,
persisted authority wins and the argument is ignored.

### The second env list decides where a permitted join commits

`NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS` is read from exactly one deletable file
([`new-client-waitlist-durability-bridge.ts` L1-L67](../../lib/booking/new-client-waitlist-durability-bridge.ts#L1-L67)):

- **Persisted waitlist:** always **durable**; a `new_client_waitlist_entries` row is written.
- **On the bridge:** durable only if the slug is on the durable list. Otherwise the join commits through the legacy
  **email-acceptance** path, so a deploy does not move a studio's commit point.

## 4. Surfaces

- **Owner setting.** `updateNewClientAdmissionModeAction` resolves the studio on the server, requires the owner role,
  sends only the intent, and maps `legacy_waitlist_cutover_required` to copy that names the one action that unlocks
  Open and Closed (`app/(app)/settings/booking/actions.ts` L190-L255).
- **Public join** (`submitNewClientBookingWaitlistAction`,
  [public waitlist action L575-L622](../../app/book/[slug]/waitlist-actions.ts#L575-L622)):
  1. resolves the mode from the server-resolved studio; only `waitlist` admits a join, and this check runs *before* the
     rate limiter so a refused studio spends no quota;
  2. applies the studio-scoped limiter;
  3. commits durably or by email according to section 3. The durable path re-checks admission at commit inside the
     guarded command.

## 5. Activation: plan, record, unknowns

**Lifecycle state.** The migration ledger records `0204` and `0205` as applied
([`migration-ledger.md`](../../docs/production/migration-ledger.md), current and previous blocks). `0204`'s own test now
holds only a **floor** (hosted at or above `0204`, nothing at or below it pending); the hosted equality is proved
centrally ([`0204` test L35-L62](../../tests/migrations/0204-new-client-admission-mode.test.ts#L35-L62); see
[Migrations and hosted state](../operations/migrations-and-hosted-state.md)).

**The plan (designed)** is the frozen contract
([`new-client-admission-activation.md` § Steps, in order](../../docs/production/new-client-admission-activation.md#steps-in-order)).
It is migration-first:

| Step | Plan |
|---|---|
| A | verify the baseline |
| B | apply `0204` |
| C | verify columns, the single foreign key and the exact grants |
| D | deploy the application |
| E | **read both live env lists** and record the slug sets |
| F | cut each **listed** studio over by an owner writing `waitlist` |
| G | verify a durable join |
| H | retire the bridge code, then the durable env variable, last |

`NEW_CLIENT_WAITLIST_STUDIO_SLUGS` itself must stay, because the free-consult reschedule policy reads it as its own
authority. The plan also states that the env values are deployment secrets and that no studio's mode may be inferred
from rows or documents
([§ What must NOT be inferred](../../docs/production/new-client-admission-activation.md#what-must-not-be-inferred)).
Its rollback table now separates a **system-initialized** studio, which only an explicit command can change and which
has passed no commit point, from one **stamped by an owner**, whose commit point cannot be undone
([§ Rollback](../../docs/production/new-client-admission-activation.md#rollback)).

**The record (production-exercised)** is the append-only, dated execution record in
[`new-client-admission-execution-record.md`](../../docs/production/new-client-admission-execution-record.md):

| Step | Recorded state |
|---|---|
| A–D | done |
| **E** | **never performed**; no slug set is recorded |
| **F** | an owner wrote `waitlist` for the studio the record names; **completeness unknown** until E is done |
| G | passed with a synthetic prospect through the public form, which committed an entry row |
| H | not started, with **eligibility unknown** until E is done; both bridges remain in the deployed tree |

The record deliberately carries **no "partial" verdict** for F: because E never read the list, the studio written may
have been its only member. **What remains unknown** is which other studios, if any, are listed in either env variable.
**Unstamped does not mean listed**: stamping an unlisted studio `waitlist` would close a currently open studio to new
clients.

## 6. Contradictions and open questions

1. **`0204`'s file still speaks from before its apply.** Its header reads "CANDIDATE, NOT APPLIED"
   ([L1-L7](../../supabase/migrations/0204_new_client_admission_mode.sql#L1-L7)) while the migration ledger records it
   applied, and its `set_at` column comment still says NULL means "no owner has chosen" and non-null means a mode was
   set ([L117-L120](../../supabase/migrations/0204_new_client_admission_mode.sql#L117-L120)). The file is frozen;
   `0205` replaced the database comments forward
   ([`0205` L300-L340](../../supabase/migrations/0205_new_studio_admission_default.sql#L300-L340)). Read status from the
   ledger and meaning from the live comments, not from the `0204` text.
2. **The mode column comment overstates the privilege boundary.** `0204` documents the column as "Set exclusively
   through public.set_new_client_admission_mode(); no role holds direct UPDATE on this table"
   ([L69-L74](../../supabase/migrations/0204_new_client_admission_mode.sql#L69-L74)), but `0193` records that the default
   grants and the `owners update` policy leave UPDATE on `studios` for browser roles
   ([`0193` L28-L43](../../supabase/migrations/0193_waitlist_admission_authority.sql#L28-L43)). The one-writer rule is
   enforced by the guard trigger's permit, not by the absence of an UPDATE privilege; `0205` did not replace this
   comment.
3. **The guard trigger function is still not revoked, and the number earmarked for it was used elsewhere.**
   `studios_admission_mode_guard()` was created without the revokes its sibling functions received (known limitation
   L33, P3, not exploitable). The execution record's outstanding list still assigns `0205` to that fix
   ([L92](../../docs/production/new-client-admission-execution-record.md)), while the migration ledger records that
   `0205` was used for the admission default, contains no grant statements, and that the record is historical and not
   rewritten; a new migration is still required
   ([`migration-ledger.md`](../../docs/production/migration-ledger.md), current block).
4. **The plan's preamble and its frozen body come from different moments.** The preamble scopes "nothing has been
   executed" to the time of writing and points to the record; the body still describes leaving the pilot studio in
   WAITLIST as a future step, while the record shows it done. By the file's own rule the plan is the contract and the
   record is evidence, so read the steps as procedure, not status.
