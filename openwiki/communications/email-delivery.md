---
type: integration subsystem
title: Email delivery (Resend)
description: How Hone sends transactional email through Resend — the shared timeout-bounded transport, the idempotent waitlist transport and its three-way outcome, studio-branded sender identity, the per-family claim/attempt mechanisms, what can still double-send, and the fake transport used in E2E.
tags: [email, resend, idempotency, sender-identity, waitlist, ops-alerts, e2e-fakes]
verified:
  - by: openwiki/0.6.1
    at: 2026-10-02T20:08:11.217Z
sources:
  - id: openwiki-source-2839b99018288867e9b2b1b6
    resource: repo://app/(app)/calendar/actions.ts
  - id: openwiki-source-032982430374c85e558f9e28
    resource: repo://app/(app)/settings/team/actions.ts
  - id: openwiki-source-bf5a2621b9e8be808f7c47ed
    resource: repo://app/book/%5Bslug%5D/actions.ts
  - id: openwiki-source-e22186a801086b80b0b0eae0
    resource: repo://docs/10_DEPLOYMENT_AND_ENV.md
  - id: openwiki-source-0c99578f8e5bb59cb894065b
    resource: repo://lib/email/client.ts
  - id: openwiki-source-3e7b32a3d061ff902b408f90
    resource: repo://lib/email/e2e-fake-resend.ts
  - id: openwiki-source-a4d8d0bf18fa9cb4c31063ef
    resource: repo://lib/email/new-client-waitlist-send.ts
  - id: openwiki-source-764c003db91b96a7dad3a729
    resource: repo://lib/email/send-appointment.ts
  - id: openwiki-source-b85b20322d9a6fdcbb52b2f6
    resource: repo://lib/email/send-refusals.ts
  - id: openwiki-source-b90ea8d9b946a7ce3d1c214b
    resource: repo://lib/email/send-welcome.ts
  - id: openwiki-source-b17f7f234ba5fd14eb80f465
    resource: repo://lib/email/studio-identity.ts
  - id: openwiki-source-be736c68cca5445e1f222acf
    resource: repo://lib/ops/alert-email.ts
  - id: openwiki-source-8c6df6258eb9ed2effadb50d
    resource: repo://lib/waitlist/delivery/send.ts
  - id: openwiki-source-c5aec7f439d23f3d3990f696
    resource: repo://supabase/migrations/0033_pre_stripe_operational_hardening.sql
  - id: openwiki-source-ad2f08a2d8b1c6274859d2c7
    resource: repo://tests/db/welcome-email-claim.db.test.ts
  - id: openwiki-source-ebe7fa1cf3266063612132b7
    resource: repo://tests/source-guards/client-facing-email-identity.test.ts
  - id: openwiki-source-29bfe99243de7778cb244d6b
    resource: repo://tests/source-guards/studio-email-identity-guards.test.ts
generated: { by: "claude-code", at: "2026-10-02T20:08:11.217Z" }
---

# Email delivery (Resend)

All outbound email goes through the Resend SDK. There is **no** delivery webhook, bounce or
complaint tracking, or suppression list: Hone learns only that Resend *accepted* a message
<!-- openwiki: broken internal link [../../docs/10_DEPLOYMENT_AND_ENV.md#L75-L77] heading anchor "L75-L77" does not exist in "../../docs/10_DEPLOYMENT_AND_ENV.md". Fix the href or restore the target, then delete this comment. -->
([`docs/10_DEPLOYMENT_AND_ENV.md` L75-L77](../../docs/10_DEPLOYMENT_AND_ENV.md#L75-L77), pinned by
[`studio-email-identity-guards.test.ts` L107-L111](../../tests/source-guards/studio-email-identity-guards.test.ts#L107-L111)).
"Sent" anywhere in the product therefore means "provider accepted", never "delivered".

## 1. The client and its configuration

[`lib/email/client.ts`](../../lib/email/client.ts#L9-L35):

- Runs the fake-transport deployment assertion **at module load**, then constructs a Resend
  client only when `RESEND_API_KEY` is set; otherwise it warns once and exports `resend = null`.
  A missing key never crashes the app — every send path turns it into a "not configured"
  outcome.
- Exports the platform `FROM_ADDRESS` (Hone on the single verified sender domain) and
  `getResendTransport()`, which returns the E2E fake when explicitly enabled and the real client
  otherwise.

## 2. Send paths

There are five call sites of `emails.send(...)`. Each was built for a different failure model.

| Path | Used for | Idempotency / recording | Outcome shape |
|---|---|---|---|
| **`sendEmailSafely`** ([`send-appointment.ts` L82-L195](../../lib/email/send-appointment.ts#L82-L195)) | booking confirmation, practitioner notification, cancellation, reminders, no-show follow-up, postcare, intake requests, portal magic links and messages, receipts, move notifications | none inside the transport; each caller records against a durable row (see §4) | `{ok:true,messageId}` or `{ok:false,error,retryable}` |
| **`sendWaitlistEmailIdempotent`** ([`new-client-waitlist-send.ts` L330-L452](../../lib/email/new-client-waitlist-send.ts#L330-L452)) | waitlist join notifications, invitation emails, recipient-proof codes | provider `Idempotency-Key` | `accepted` / `rejected` / `ambiguous` |
| **`deliverWelcomeEmail`** ([`send-welcome.ts` L10-L84](../../lib/email/send-welcome.ts#L10-L84)) | new-studio owner welcome/invitation | attempt-id single-flight state machine | `sent` / `failed` / `not_configured` / `already_in_progress` |
<!-- openwiki: broken internal link [../../app/(app] file "../../app/(app" does not exist. Fix the href or restore the target, then delete this comment. -->
| Team invitation ([`settings/team/actions.ts` L50-L79](../../app/(app)/settings/team/actions.ts#L50-L79)) | inviting a practitioner | none; the pending-invitation row and share UI are the record | fire-and-log |
| Critical ops alert ([`lib/ops/alert-email.ts`](../../lib/ops/alert-email.ts#L1-L27)) | operator email for **critical** `ops_alerts` only | none; the `ops_alerts` row is the source of truth | never throws |

### 2.1 `sendEmailSafely` — the shared transport

- Refuses without a client (`retryable: false`) or without an `@` in the recipient.
- Builds `From` from server-resolved studio identity when supplied, else `FROM_ADDRESS`; attaches
  `Reply-To` only when one was resolved; accumulates `.ics` and other attachments in one array.
- Races the provider promise against a **15 s timer**. The timer does **not** cancel the
  request, so a send can be reported as a retryable timeout and still be accepted afterwards.
- Classifies provider errors: 429 and 5xx retryable, other 4xx and validation names terminal,
  unknown shapes retryable ([L45-L80](../../lib/email/send-appointment.ts#L45-L80)).

### 2.2 `sendWaitlistEmailIdempotent` — when the email *is* the record

The waitlist flows have no durable row a duplicate could be reconciled against, so this
transport sends a provider idempotency key and keeps the provider's error name
([rationale L24-L122](../../lib/email/new-client-waitlist-send.ts#L24-L122)):

- **Key** = `<namespace>/<server-resolved studio id>/[<event scope>/]sha256(exact payload)`
  ([L175-L228](../../lib/email/new-client-waitlist-send.ts#L175-L228)). The tenant component exists
  because studio names and owner emails are not unique, so two studios could otherwise render
  byte-identical mail and share a key. The **event scope** (entry, invitation or challenge id)
  makes a re-join or a second invitation cycle a new send rather than a replay.
- When the payload carries a credential (a proof code), `payloadCarriesSecret` switches to an
  **event-only** key so the secret never reaches a provider header, and the send fails closed
  with `missing_event_scope` if no event scope was given.
- **Local refusals** (`not_configured`, `invalid_recipient`, `missing_tenant_scope`,
  `missing_event_scope`) happen before any request and are typed separately from provider
  refusals so a consumer cannot mistake "we never called anyone" for "the provider said no"
  ([`send-refusals.ts` L1-L60](../../lib/email/send-refusals.ts#L1-L60)).
- **Outcomes:** a timeout, a network throw, a missing message id, or
  `concurrent_idempotent_requests` is `ambiguous`; any other error — including
  `invalid_idempotent_request` (same key, different bytes) — is `rejected`
  ([L265-L311](../../lib/email/new-client-waitlist-send.ts#L265-L311)).
- **One bounded retry** on ambiguity, with the same key and payload. Only an *acceptance* on the
  retry resolves it; a rejection on the retry keeps the outcome `ambiguous`, because the first
  request was never cancelled ([L424-L452](../../lib/email/new-client-waitlist-send.ts#L424-L452)).
- It uses `getResendTransport()`, so the E2E fake reaches this path.

Invitation and proof delivery wrap this transport in `lib/waitlist/delivery/send.ts`: the
recipient is always the address stored on the entry (never request input), an expired invitation
is never mailed, and the invitation id / challenge id is the event scope
([`delivery/send.ts` L21-L60](../../lib/waitlist/delivery/send.ts#L21-L60),
[L161-L200](../../lib/waitlist/delivery/send.ts#L161-L200)). How dispositions are persisted is on
[Waitlist entries and invitation lifecycle](../waitlist/entries-and-invitation-lifecycle.md).

### 2.3 `deliverWelcomeEmail` — single-flight per studio

`claim_welcome_email_attempt` mints an attempt id and moves the studio's welcome state
`not_sent → sending`; a concurrent caller gets no attempt id and returns `already_in_progress`
without sending. The result is written with a compare-and-set on the attempt id
(`record_welcome_email_result`), so a stale attempt cannot overwrite a newer one; an
unconfigured transport reverts to `not_sent`. The DB tests prove one attempt under concurrency,
a 15-minute fence before a stuck `sending` is recoverable, and that neither `anon` nor
`authenticated` can execute the commands
([`welcome-email-claim.db.test.ts` L47-L200](../../tests/db/welcome-email-claim.db.test.ts#L47-L200)).

## 3. Sender identity (COMMS-01A)

[`lib/email/studio-identity.ts`](../../lib/email/studio-identity.ts) is the only place a branded
identity is built:

- **One envelope address, never per studio** ([L28-L35](../../lib/email/studio-identity.ts#L28-L35)).
  A studio name is display text only: `"<studio> via Hone <sender>"`, or the plain platform
  value when the name sanitises to nothing.
- The sanitiser **removes** C0/C1 control characters (header injection) and RFC 5322 specials,
  collapses whitespace and caps at 60 characters ([L37-L76](../../lib/email/studio-identity.ts#L37-L76)).
- **Reply-To** is the studio's postcare contact address if valid, else the owner address if valid,
  else **omitted** — never invented, never the client's own address
  ([L99-L170](../../lib/email/studio-identity.ts#L99-L170)).
- Hone-facing mail (ops alerts, team invitations) deliberately stays unbranded.

Guards: [`studio-email-identity-guards.test.ts`](../../tests/source-guards/studio-email-identity-guards.test.ts#L17-L90)
forbids hand-assembled `From` headers in the send modules and pins the Reply-To guard;
[`client-facing-email-identity.test.ts`](../../tests/source-guards/client-facing-email-identity.test.ts#L186-L300)
discovers every `sendEmailSafely` caller and requires each to be either studio-branded or
explicitly declared Hone-facing, with identity resolved server-side.

## 4. What protects each message family from duplicates

| Family | Mechanism | Duplicate risk that remains |
|---|---|---|
| ~24h / ~2h reminders | `claim_email_send` → send → `record_email_result` (0080, last redefined 0098); 3 attempts; 5-minute stale claim | crash after acceptance and before the result write; see [Cron jobs and reminders](cron-reminders-and-idempotency.md) |
| Booking confirmation | one-shot inside the booking request; `record_email_attempt` increments attempts and stamps `confirmation_sent_at` only on success ([`app/book/[slug]/actions.ts` L1707-L1772](../../app/book/[slug]/actions.ts#L1707-L1772)); function is `service_role`-only ([`0033` L111-L114](../../supabase/migrations/0033_pre_stripe_operational_hardening.sql#L111-L114)) | a user retry of the same request; a timeout reported as failure that was accepted |
<!-- openwiki: broken internal link [../../app/(app] file "../../app/(app" does not exist. Fix the href or restore the target, then delete this comment. -->
| Postcare | `claim_postcare_send` → provider → `settle_postcare_send`, with SQL owning the completed-only gate, attempts and the stale window ([`calendar/actions.ts` L1000-L1010](../../app/(app)/calendar/actions.ts#L1000-L1010)) | crash window, as above |
| Welcome email | attempt-id state machine (§2.3) | provider accepted but result write failed |
| Waitlist mail | provider idempotency key (§2.2) | none from Hone retries inside the provider's key-retention window; `ambiguous` is surfaced, not hidden |
| Team invitation, ops alert email | none | caller retries |

Failure reporting: `logEmailFailure` always writes a structured log line and records an
`email_send_gave_up` warning ops alert only on the final attempt or a terminal error
([`send-appointment.ts` L313-L382](../../lib/email/send-appointment.ts#L313-L382)). A failed claim
RPC is treated as "claim not won", so an RPC outage cannot cause a duplicate
([L240-L282](../../lib/email/send-appointment.ts#L240-L282)).

## 5. The fake transport (E2E only)

[`lib/email/e2e-fake-resend.ts`](../../lib/email/e2e-fake-resend.ts) is `server-only`, off unless
`HONE_E2E_FAKE_RESEND=1`, and **throws** when that flag is set in a deployed runtime (any of
`VERCEL=1`, `VERCEL_ENV`, AWS or Kubernetes markers) ([L1-L39](../../lib/email/e2e-fake-resend.ts#L1-L39)).
It supports `success`, `reject`, `throw`, `failonce` and `hold` modes, chosen by an env override
or a recipient-address prefix ([L41-L80](../../lib/email/e2e-fake-resend.ts#L41-L80)).

Only `getResendTransport()` callers — the welcome email and the idempotent waitlist transport —
reach the fake. `sendEmailSafely` uses the real client, which is `null` in a keyless E2E
environment, so those sends return "not configured" rather than a fake success. See
[Browser E2E suites and provider fakes](../testing/browser-e2e-suites-and-fakes.md).

## 6. Change checklist

- Use `sendEmailSafely` and pass `studioIdentity` for client-facing mail; record the outcome
  against the durable row the email is about.
- If the email *is* the record (no row to reconcile), use the idempotent transport with a server
  resolved studio id and a durable event scope.
- Never put a credential into a payload that is hashed into an idempotency key; set
  `payloadCarriesSecret`.
- Never derive display name, From or Reply-To from request input; never log recipient addresses.

## 7. Contradictions and open questions

1. **"Exactly ONE Resend path" is not true of the code.** `sendEmailSafely`'s own documentation
   says "There is exactly ONE Resend path in this codebase"
   ([L88-L95](../../lib/email/send-appointment.ts#L88-L95)), but `emails.send(` is called from five
   modules: `send-appointment.ts`, `new-client-waitlist-send.ts`, `send-welcome.ts`,
   `lib/ops/alert-email.ts` and `app/(app)/settings/team/actions.ts`.
2. **The guard named "there is still exactly ONE transport, not two"** only asserts that
   `FROM_ADDRESS` exists with its historical fallback value
   ([L42-L46](../../tests/source-guards/studio-email-identity-guards.test.ts#L42-L46)); it does not
   detect a second transport.
3. **The missing-key warning understates the blast radius.** `client.ts` warns that "Invitation
   emails will not send" when `RESEND_API_KEY` is absent
   ([L15-L18](../../lib/email/client.ts#L15-L18)), but every send path returns "not configured" in
   that state.
