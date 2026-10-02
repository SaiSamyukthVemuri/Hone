---
type: state machine
title: Waitlist entries and invitation lifecycle
description: The durable new-client waitlist as the database defines it — the entry status vocabulary and the exact legal transition matrix, the append-only invitation child row with hashed tokens, a bounded TTL and one terminal outcome, server-clock expiry, owner admission rounds and the one-action admit command, the delivery-outcome record, the consumed-count gateway, the redeemed-but-unbooked exit and its contraction — with the commands' authority and the DB tests behind each rule.
tags: [waitlist, state-machine, invitations, admission, security-definer, concurrency]
verified:
  - by: openwiki/0.6.1
    at: 2026-10-02T20:08:11.217Z
sources:
  - id: openwiki-source-c20fe11e1b993d9a2a165fbd
    resource: repo://app/(app)/settings/waitlist/invite-actions.ts
  - id: openwiki-source-ed9ea36b9695d07178f640a2
    resource: repo://lib/booking/waitlist-invitation.ts
  - id: openwiki-source-59512e3b4bfb39bbf972c43c
    resource: repo://supabase/migrations/0185_new_client_waitlist_entries.sql
  - id: openwiki-source-d328e12fb329e5c5fa4cd164
    resource: repo://supabase/migrations/0188_new_client_waitlist_invitations.sql
  - id: openwiki-source-28fa43e2d5e0782119e68abc
    resource: repo://supabase/migrations/0189_waitlist_invitation_wall_clock_expiry.sql
  - id: openwiki-source-ee261df47f295c74b36b6847
    resource: repo://supabase/migrations/0190_waitlist_invitation_ttl_anchor.sql
  - id: openwiki-source-156cccd16ed735df690bfbf3
    resource: repo://supabase/migrations/0192_waitlist_recipient_proof_authority.sql
  - id: openwiki-source-54e15b7982e477c094cc77f4
    resource: repo://supabase/migrations/0193_waitlist_admission_authority.sql
  - id: openwiki-source-cd5faabac37d7bac0e27d14e
    resource: repo://supabase/migrations/0196_waitlist_invitation_delivery_outcome.sql
  - id: openwiki-source-101cd4b2c9723ad6be9d1062
    resource: repo://supabase/migrations/0197_waitlist_consumed_count_gateway.sql
  - id: openwiki-source-cd788b1f18368587215a214d
    resource: repo://supabase/migrations/0200_waitlist_redeemed_unbooked_exit.sql
  - id: openwiki-source-98aa3f9cc9783911901e81ee
    resource: repo://supabase/migrations/0201_waitlist_exit_authority_contraction.sql
  - id: openwiki-source-07bdcb79c54bb791aa3d8cc8
    resource: repo://supabase/migrations/0203_waitlist_mobile_verification_authority.sql
  - id: openwiki-source-71204baad3480e98c3f9b3b9
    resource: repo://tests/db/waitlist-admission-command.db.test.ts
  - id: openwiki-source-0732441966bad8b10d415f6e
    resource: repo://tests/db/waitlist-consumed-gateway.db.test.ts
  - id: openwiki-source-bf1a102b8439b16bc3cb4fe7
    resource: repo://tests/db/waitlist-exit-authority-contraction.db.test.ts
  - id: openwiki-source-7e1df4c918a90c8de2b78ada
    resource: repo://tests/db/waitlist-invitation-wall-clock.db.test.ts
  - id: openwiki-source-a54d524a85e2ab28b17aa073
    resource: repo://tests/db/waitlist-redeemed-unbooked-exit.db.test.ts
generated: { by: "claude-code", at: "2026-10-02T20:08:11.217Z" }
---

# Waitlist entries and invitation lifecycle

The new-client waitlist (WAIT) lets a studio whose treatment calendar is full stop taking new consultations
directly, keep prospects in a durable queue, and invite them deliberately.

**Every transition is an explicit command.** There is no timer, sweep or automatic release
([`0188` L1-L35](../../supabase/migrations/0188_new_client_waitlist_invitations.sql#L1-L35)).

**An invitation is not an appointment.** It grants the *opportunity* to book a consultation. Booking still goes
through the canonical public command, and conversion is recorded by its own step. How a recipient proves
identity and books is on [Waitlist recipient journey and booking conversion](recipient-journey-and-booking-conversion.md).
Whether new clients reach the waitlist at all is on [New-client admission mode](new-client-admission-mode.md).

## 1. Authority and privileges

- **Entries** (`new_client_waitlist_entries`, `0185`):
  - browser roles hold SELECT only, and RLS shows rows to studio **owners** only;
  - `anon` and `service_role` hold nothing on the table;
  - every writer is a `SECURITY DEFINER` command
    ([`0185` L556-L575](../../supabase/migrations/0185_new_client_waitlist_entries.sql#L556-L575)).
- **Invitations** (`0188`): all privileges are revoked from all four roles. `authenticated` gets SELECT on a
  **column list** that excludes `token_hash`, the proof fields and the scope fields
  ([`0188` L1347-L1400](../../supabase/migrations/0188_new_client_waitlist_invitations.sql#L1347-L1400)).
- **Commands** are granted to `service_role` only and called from the server through
  `lib/booking/waitlist-invitation.ts`. That module calls the accepted commands, maps closed result codes to typed
  outcomes, never throws across the boundary, and reports a transport failure as **in doubt** rather than a
  refusal ([L1-L15](../../lib/booking/waitlist-invitation.ts#L1-L15)).
- **The practitioner's invite action** sends intent only: four product fields and the entry id. Studio and actor
<!-- openwiki: broken internal link [../../app/(app] file "../../app/(app" does not exist. Fix the href or restore the target, then delete this comment. -->
  come from the server ([`invite-actions.ts` L1-L20](../../app/(app)/settings/waitlist/invite-actions.ts#L1-L20)).
- **Owners only.** Owner role and membership are re-derived inside each command from `(studio_id, user_id)`.

## 2. The entry state machine

Vocabulary ([`0188` L67-L81](../../supabase/migrations/0188_new_client_waitlist_invitations.sql#L67-L81)):

| Status | Meaning |
|---|---|
| `waiting` | in the pool, not spoken for |
| `claimed` | held by one operator for invitation |
| `invited` | a live token exists |
| `converted` | became a client through the canonical booking authority |
| `expired` | the invitation's TTL lapsed; recorded explicitly |
| `released` | the claim or invitation was invalidated |
| `removed` | terminal operator removal |

**Legal transitions.** The latest guard trigger refuses everything else
([`0203` L130-L170](../../supabase/migrations/0203_waitlist_mobile_verification_authority.sql#L130-L170)):

```
waiting  -> claimed | removed
claimed  -> invited | released
invited  -> converted | expired | released
expired  -> released | waiting | removed
released -> waiting  | removed
```

- `converted` and `removed` are terminal.
- **There is no `invited → removed` edge**: an invited entry must be released or expire first.
- **Each edge may write only the columns it owns.** For example, `waiting → claimed` may set only `claimed_at`
  and `claimed_by_practitioner_id`, so a legal status change cannot rewrite other evidence (`0190`).
- **Requeueing** (`expired` or `released` → `waiting`) clears the cycle fields.

The same guard makes some fields **immutable**:

- `id`, `studio_id`, `joined_at` and `source`;
- `name` and `email` — there is no correction command;
- a stored mobile number, an opt-out and its evidence, and a proved `mobile_verified_at`, which has exactly one
  writer ([L43-L128](../../supabase/migrations/0203_waitlist_mobile_verification_authority.sql#L43-L128)).

Each status change writes an append-only lifecycle event through a trigger.

## 3. The invitation row

`new_client_waitlist_invitations` keeps **all** cycles, so a re-invite never overwrites earlier evidence
([`0188` L187-L256](../../supabase/migrations/0188_new_client_waitlist_invitations.sql#L187-L256)):

- **Token:** only the **SHA-256 hex** is stored, checked to be 64 lowercase hex characters and globally unique.
  The raw token is returned once by the issuing command.
- **Lifetime:** `issued_at` and `expires_at` are **server-owned**, set by a trigger rather than a default. A check
  enforces `expires_at ≤ issued_at + 7 days`, so an expiry cannot be quietly extended; the product default TTL is
  72 hours.
- **Tenancy:** composite same-studio FKs to the entry, the issuer and, since `0192`, the admission round and the
  scoped service.
- **Exactly one terminal outcome:** `redeemed_at`, `expired_at`, `released_at` or `declined_at` (the decline was
  added in `0192`) ([`0192` L164-L264](../../supabase/migrations/0192_waitlist_recipient_proof_authority.sql#L164-L264)).
- **Scope:** service, date range and allowed weekdays, all-or-nothing. It is stored server-side so a substituted
  URL cannot widen it.
- **Append-only:** direct deletes are refused, and the studio cascade still works.

### Time is the wall clock after the lock

- **`0189`:** `now()` is the transaction start. A redeem that began while the invitation was live but waited on a
  lock past the deadline used to succeed. Every TTL decision now uses the **post-lock wall clock**
  ([`0189` L1-L45](../../supabase/migrations/0189_waitlist_invitation_wall_clock_expiry.sql#L1-L45)).
- **`0190`:** the issued window had also been anchored to transaction start, which shortened it. It is now
  anchored at issuance. The same migration stops a legal transition from rewriting evidence it does not own
  ([`0190` L1-L45](../../supabase/migrations/0190_waitlist_invitation_ttl_anchor.sql#L1-L45)).

[`waitlist-invitation-wall-clock.db.test.ts`](../../tests/db/waitlist-invitation-wall-clock.db.test.ts#L253-L541)
proves the load-bearing case: a transaction that begins before the deadline, blocks, and is released after it.

## 4. Admission: rounds, admit and issue

**Rounds — the owner's "invitation capacity".**

- `open_` and `close_new_client_waitlist_admission_round` (`0192`) keep a durable ledger with at most one open
  round per studio.
- An invitation is stamped with the round that authorised it.
- `waitlist_admission_round_consumed` counts a seat for every **outstanding** invitation (unanswered and inside
  its window) and every **redeemed** one. Declined, expired or released invitations, and windows that lapse,
  free their seat. A redeemed seat is never recycled, even if the appointment is later cancelled
  ([`0192` L335-L380](../../supabase/migrations/0192_waitlist_recipient_proof_authority.sql#L335-L380)).
- `lib/waitlist/invitation-capacity.ts` is only a view model: it hides a control the database would refuse and
  decides nothing ([L1-L15](../../lib/waitlist/invitation-capacity.ts#L1-L15)).

**Standing policy (`0193`).** Batch defaults and bounds live in their own owner-only table. They are not a
`studios` column, because the default `studios` grants cannot be narrowed per column
([`0193` L1-L48](../../supabase/migrations/0193_waitlist_admission_authority.sql#L1-L48)). Prospect preference and
admission policy are separate tables with separate commands.

**`admit_new_client_waitlist_entry` is one action** ([`0193` L1544-L1660](../../supabase/migrations/0193_waitlist_admission_authority.sql#L1544-L1660)):

1. re-derives owner authority;
2. takes `studios FOR NO KEY UPDATE`;
3. takes `FOR UPDATE` on the **open** round;
4. locks the entry;
5. claims the entry and issues a scoped invitation (`0192`'s issuer) in one transaction.

A downstream refusal, such as `no_round_open` or `round_full`, unwinds the claim. The command returns the raw
token once, plus the database's own `issued_at` and `expires_at`.

[`waitlist-admission-command.db.test.ts`](../../tests/db/waitlist-admission-command.db.test.ts#L1058-L1378) proves:

- the happy path is one action;
- a refusal leaves no claimed residue;
- members, cross-studio entries, an exhausted allowance, a foreign service and invalid scopes admit nobody;
- **concurrent invites yield at most one invitation**;
- terminal and non-admissible entries are refused.

## 5. Delivery outcome and the consumed-count gateway

**Delivery outcome (`0196`).** `delivery_disposition` (`accepted`, `refused` or `unknown`) and
`delivery_recorded_at` are all-or-nothing, and **NULL means never recorded**, which differs from `unknown`.
`record_waitlist_invitation_delivery` behaves as follows
([`0196` L1-L104](../../supabase/migrations/0196_waitlist_invitation_delivery_outcome.sql#L1-L104)):

| Situation | Result |
|---|---|
| nothing recorded yet | the first observation is written: `recorded` |
| the same disposition again | `unchanged` |
| a different disposition | `conflict`, and nothing is written |

It cannot un-invite, resend or reissue anything. The practitioner surface reads this persisted value instead of
transient React state, so a retry that would burn another seat is not invited.

**Consumed-count gateway (`0197`).** The canonical count function is `SECURITY INVOKER`, and `service_role`
deliberately has no SELECT on invitations. The server's call therefore failed. That failure surfaced as
"capacity unknown", which **withheld sends** even when an owner had opened a round, and every DB test missed it
because the tests ran as `postgres`. `0197` adds a gateway that validates the studio and round pair and delegates
to the single canonical count ([`0197` L1-L38](../../supabase/migrations/0197_waitlist_consumed_count_gateway.sql#L1-L38);
[`waitlist-consumed-gateway.db.test.ts`](../../tests/db/waitlist-consumed-gateway.db.test.ts#L45-L210)).

## 6. Exits

| Command | Accepts | Effect |
|---|---|---|
| `release_new_client_waitlist_entry` | a `claimed`, `invited` or `expired` entry with **no** redeemed invitation | → `released` |
| `expire_new_client_waitlist_invitation` | an elapsed, unredeemed invitation (post-lock clock) | stamps `expired_at`; entry → `expired` |
| `decline_new_client_waitlist_invitation` (recipient) | a live invitation | stamps `declined_at`; entry `invited → released` |
| `requeue_new_client_waitlist_entry` | `released` or `expired`, **and** never holding a redeemed invitation (`0200`) | → `waiting` |
| `remove_new_client_waitlist_entry` | `waiting`, `expired` or `released` | → `removed` (terminal) |
| `close_unbooked_new_client_waitlist_invitation` (`0200`, contracted by `0201`) | `invited` with a **redeemed, unbooked** invitation | stamps `closed_at`; entry → `released` |

**The redeemed-but-unbooked dead end.** Redemption stamps the invitation but leaves the entry at `invited`, and
only a recorded conversion moves it. A prospect who redeems and never books was therefore **immovable**: release,
expire, remove and requeue all refused, and no new invitation could be issued
([`0200` L1-L68](../../supabase/migrations/0200_waitlist_redeemed_unbooked_exit.sql#L1-L68)).

`0200` added a sixth command:

- it moves `invited → released` and stamps `closed_at`, which is not a terminal outcome and appears in no
  liveness predicate;
- it keeps the round seat consumed;
- it redefines requeue to refuse an entry holding a redeemed invitation, so one entry can never carry two
  redeemed invitations.

**`0201`** removed `0200`'s scan of `appointments` from the close decision. Appointments carry no link to a
waitlist cycle — `create_waitlist_public_appointment` receives the entry id but does not pass it on — and since
`0195` a cycle booking converts in the same transaction. The scan could only ever match an unrelated booking, and
it raced appointment writers ([`0201` L82-L137](../../supabase/migrations/0201_waitlist_exit_authority_contraction.sql#L82-L137)).

Tests:

- [`waitlist-redeemed-unbooked-exit.db.test.ts`](../../tests/db/waitlist-redeemed-unbooked-exit.db.test.ts#L192-L869)
  — the dead end is real; the exit's refusals; double-submit safety; a booking race cannot produce both a booking
  and an exit; the seat is not recycled;
- [`waitlist-exit-authority-contraction.db.test.ts`](../../tests/db/waitlist-exit-authority-contraction.db.test.ts#L337-L880)
  — the exit no longer depends on appointments, plus tenancy and invariants.

## 7. Contradictions and open questions

1. **No appointment records which waitlist cycle produced it.** Conversion stores `converted_client_id`, never
   the appointment, and the booking command drops the entry id at the boundary to `create_public_appointment`
   ([`0201` L86-L94](../../supabase/migrations/0201_waitlist_exit_authority_contraction.sql#L86-L94)). Any later
   question about which appointment came from an invitation is unanswerable from data.
2. **The exit is one-way.** After a redeemed cycle is closed, the entry can be removed but never re-offered on the
   same entry; the person must rejoin as a new entry. This is a recorded design consequence that protects five
   consumers of "has any invitation been redeemed", not an accident
   ([`0200` L70-L123](../../supabase/migrations/0200_waitlist_redeemed_unbooked_exit.sql#L70-L123)).
3. **Owner-only access.** Entries and invitations are owner-only to read, and admission is owner-only. A non-owner
   practitioner cannot see the queue. This is consistent across `0185`, `0188` and `0193`, but nothing in the
   repository records it as a product decision for multi-practitioner studios.
