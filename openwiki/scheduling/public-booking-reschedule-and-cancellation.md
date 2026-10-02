---
type: product workflow
title: Public booking, reschedule and cancellation flows
description: The anonymous client surfaces — /book/[slug] and the /cancel, /reschedule and /manage token routes — traced from the server action to the command each one calls, including rate limiting, the new/existing client split and admission gate, hash-only and HMAC appointment tokens, policy-acknowledgement freshness, the post-commit law for confirmations, and the no-enumeration error stance.
tags: [public-booking, reschedule, cancellation, tokens, policy-acknowledgement, scheduling]
verified:
  - by: openwiki/0.6.1
    at: 2026-10-02T20:08:11.217Z
sources:
  - id: openwiki-source-bf5a2621b9e8be808f7c47ed
    resource: repo://app/book/%5Bslug%5D/actions.ts
  - id: openwiki-source-a70e3f51f72442ad8b8e64bd
    resource: repo://app/cancel/%5Btoken%5D/actions.ts
  - id: openwiki-source-d68aea357c28f0ac202cb2f2
    resource: repo://app/manage/%5Btoken%5D/actions.ts
  - id: openwiki-source-9028e95b2ca986c308731fe7
    resource: repo://docs/01_ARCHITECTURE.md
  - id: openwiki-source-a9a4b60bd7523871136ac947
    resource: repo://lib/booking/appointment-token.ts
  - id: openwiki-source-8af040e0cb8ee82901db531b
    resource: repo://lib/booking/tokens.ts
  - id: openwiki-source-e9162711763ff32ea530713a
    resource: repo://supabase/migrations/0170_public_appointment_command.sql
  - id: openwiki-source-9e4d094bd8ae363bc8629e0f
    resource: repo://supabase/migrations/0171_public_reschedule_command_v2.sql
  - id: openwiki-source-8dd4f475b8eb39ebe7e46c57
    resource: repo://tests/db/public-appointment-command.db.test.ts
  - id: openwiki-source-edee6d6e9aea1480d8a92a43
    resource: repo://tests/db/public-cancellation-atomicity.db.test.ts
  - id: openwiki-source-bd57267a953bfcdfbe166446
    resource: repo://tests/db/public-reschedule-command.db.test.ts
generated: { by: "claude-code", at: "2026-10-02T20:08:11.217Z" }
---

# Public booking, reschedule and cancellation flows

| Route | Action file | Command | Credential |
|---|---|---|---|
| `/book/[slug]` | `app/book/[slug]/actions.ts` (`publicBookAppointmentAction`) | `create_public_appointment`, or `create_public_appointment_for_new_client` / `create_waitlist_public_appointment` | none — the slug is a public identifier |
| `/cancel/[token]` | `app/cancel/[token]/actions.ts` | `public_cancel_appointment_with_token` | appointment token |
| `/reschedule/[token]` | `app/reschedule/[token]/actions.ts` | `reschedule_appointment_v2` | appointment token |
| `/manage/[token]` | `app/manage/[token]/actions.ts` | none — read-only landing that links to cancel/reschedule | appointment token |

All four run through the service-role client after their own validation; the commands are described on
[Appointment write authority](appointment-write-authority.md) and the slot rules on
[Availability, slots, buffers and timezones](availability-slots-buffers-and-timezones.md).

## 1. Booking (`publicBookAppointmentAction`)

In order ([`app/book/[slug]/actions.ts` L456-L1883](../../app/book/[slug]/actions.ts#L456-L1883)):

1. **Parse and validate** client type (`new` / `existing`), name, email, phone, service and time; read the
   optional SMS consent, marketing consent and referral source ([L456-L531](../../app/book/[slug]/actions.ts#L456-L531)).
2. **Rate limit** with `limitPublicBooking` keyed on request headers, slug and email; nothing is created or
   sent when limited ([L533-L545](../../app/book/[slug]/actions.ts#L533-L545)). Limiters fail open when Upstash
   is unavailable (see [Public token routes and privacy](../security/public-token-routes-and-privacy.md)).
3. **New-client admission**: for a new client the studio's admission mode decides between booking,
   joining the waitlist, or refusal, and a presented waitlist invitation is handled separately
   ([L556-L680](../../app/book/[slug]/actions.ts#L556-L680)); see
   [New-client admission mode](../waitlist/new-client-admission-mode.md).
4. **Time, horizon and service** checks with neutral error copy ([L681-L760](../../app/book/[slug]/actions.ts#L681-L760)).
5. **Existing-client resolution** by exact normalized email among **non-archived** clients; an unknown or
   archived email for `existing` returns the same generic error, so the form cannot be used to discover who
   is a client ([L781-L967](../../app/book/[slug]/actions.ts#L781-L967)). Submitted demographics never
   overwrite a stored client; an existing client's SMS consent is stamped only if the submitted phone matches
   the stored one ([L969-L1040](../../app/book/[slug]/actions.ts#L969-L1040)).
6. **One command commits the booking** — the new-client, waitlist-invitation or ordinary command
   ([L1140-L1170](../../app/book/[slug]/actions.ts#L1140-L1170)); `not_a_public_slot` and the `23P01` /
   `HB001` collisions map to "time no longer available" copy ([L1310-L1380](../../app/book/[slug]/actions.ts#L1310-L1380)).
7. **The post-commit law**: once the command returns `created`, everything else — confirmation email
   (recorded with `record_email_attempt`), confirmation SMS, practitioner notification and email, cache
   revalidation, analytics/conversion — is a secondary effect that may not turn the committed booking into
   a failure; each runs inside a `postCommit` wrapper and the response carries the management link
   ([L1405-L1450](../../app/book/[slug]/actions.ts#L1405-L1450), [L1600-L1870](../../app/book/[slug]/actions.ts#L1600-L1870)).

DB proof of the command contract — server-derived values, exactly one audit row, duration from the current
service, the shadow reservation, tenant isolation without enumeration, and availability rules enforced with
capacity off (past, horizon, closed days, override closures, blockouts, timed blocks):
[`public-appointment-command.db.test.ts` L111-L300](../../tests/db/public-appointment-command.db.test.ts#L111-L300).

## 2. Appointment tokens

Two token kinds open the token routes, and the routes accept either:

- **Random bearer token** — 24 random bytes, base64url, given to the client in the confirmation; only its
  **SHA-256** is stored (`appointments.cancellation_token_hash`, migration `0090`; the raw column was dropped
  in `0091`) ([`lib/booking/appointment-token.ts` L1-L47](../../lib/booking/appointment-token.ts#L1-L47)).
- **Stateless HMAC token** — `{appointment_id, expires_at}` signed with HMAC-SHA256 under a dedicated
  `APPOINTMENT_SIGNING_SECRET` with **no fallback** to the service-role key; minted by reminders and the
  portal so a link can be rebuilt without the raw token ([`lib/booking/tokens.ts` L1-L60](../../lib/booking/tokens.ts#L1-L60)).

There is deliberately no single-use table: replay after a successful cancel or reschedule is stopped by the
appointment state machine and row locks, and reschedule issues the successor its own token
([`appointment-token.ts` L1-L24](../../lib/booking/appointment-token.ts#L1-L24)). A leaked but still-eligible
link is usable by whoever holds it — an accepted bearer-link property.

## 3. Cancellation

`app/cancel/[token]/actions.ts` resolves the token (hash lookup, then HMAC verification), rate-limits with
`limitTokenRoute`, validates the optional reason against an allowlist and the note length, and requires a
**policy acknowledgement** when the studio has policy text
([L1-L100](../../app/cancel/[token]/actions.ts#L1-L100), [L120-L245](../../app/cancel/[token]/actions.ts#L120-L245)).
`public_cancel_appointment_with_token` (`0176`) then commits the status change, the audit row and the
acknowledgement **together** — with the presented policy hash compared against the live policy so an edit,
addition or removal after the page rendered fails closed as `policy_changed`, a missing hash is never treated
as consent, at-or-after-start and terminal appointments cannot be cancelled, concurrent double submits
produce exactly one success, and a failing acknowledgement rolls back the appointment, audit, reservation
and calendar outbox ([`public-cancellation-atomicity.db.test.ts` L220-L820](../../tests/db/public-cancellation-atomicity.db.test.ts#L220-L820)).
The calendar reservation is released in the same transaction.

## 4. Reschedule

`reschedule_appointment_v2` (`0171`) replaced a caller-trusting RPC
([`0171` L1-L60](../../supabase/migrations/0171_public_reschedule_command_v2.sql#L1-L60)). It cancels the original
and creates the successor in one transaction with full lineage (`rescheduled_from/to_appointment_id`,
`cancellation_kind = 'rescheduled'`, which lets the Google outbox rebind rather than delete-and-recreate),
**preserves the original duration** even if the service default changed, requires **exact membership** in
the SQL replacement-slot set (excluding the original's own reservation; no millisecond tolerance; the same
time is a no-op refusal), enforces policy freshness like cancellation, and returns authoritative state so the
route needs no post-commit re-read ([`public-reschedule-command.db.test.ts` L187-L580](../../tests/db/public-reschedule-command.db.test.ts#L187-L580)).
Concurrency is covered on [Scheduling concurrency and lock order](concurrency-and-lock-order.md). A
free-consultation booking may be restricted to waitlist-only rescheduling; `/cancel` and `/manage` only
*warn* about that restriction, they do not impose it ([cancel L15-L18](../../app/cancel/[token]/actions.ts#L15-L18)).

## 5. `/manage`

The neutral landing page for SMS links mutates nothing; it resolves the same tokens, applies the same
rate limit and the same reschedule-eligibility decision so it never offers a reschedule the next screen
would refuse, and collapses every failure to one generic message
([`app/manage/[token]/actions.ts` L1-L25](../../app/manage/[token]/actions.ts#L1-L25)).

## 6. Error stance

Every public token surface returns one generic message per surface for any non-success so the existence of
an appointment cannot be probed by comparing error shapes; details go only to structured server logs with
fingerprints, never raw database messages.

## 7. Contradictions and open questions

1. **The architecture doc's public-booking walkthrough predates the command boundary.** It describes
   generating a "column-based cancellation_token", inserting the appointment and the audit row as separate
   steps, a `fetchPublicAvailableSlotsAction` and a redirect to a thank-you page
<!-- openwiki: broken internal link [../../docs/01_ARCHITECTURE.md#L107-L124] heading anchor "L107-L124" does not exist in "../../docs/01_ARCHITECTURE.md". Fix the href or restore the target, then delete this comment. -->
   ([`docs/01_ARCHITECTURE.md` L107-L124](../../docs/01_ARCHITECTURE.md#L107-L124)); the code stores only token
   hashes, commits appointment + audit in one command, exposes `fetchPublicSlotsAction`, and returns a result
   carrying the management link.
2. **Bearer links have no expiry beyond appointment eligibility for the random token.** The HMAC token carries
   `expires_at`, but the hash-stored random token is valid until the appointment leaves an eligible state; the
   token module records this as an accepted property rather than a control
   ([`appointment-token.ts` L18-L24](../../lib/booking/appointment-token.ts#L18-L24)).
