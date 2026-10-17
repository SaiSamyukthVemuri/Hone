---
type: integration
title: Marketing consent and conversion tracking
description: How public booking records an opt-in marketing/analytics consent separately from clinical and payment consent, the three tables and the atomic dedup claim behind conversion delivery, the four gates a hashed Meta Conversions API "Schedule" event must pass, what is and is not sent, how an owner stores an encrypted per-studio provider token, and why the capability is deployed but inert.
tags: [marketing-consent, conversion-tracking, meta-capi, encryption, privacy]
verified:
  - by: openwiki/0.6.1
    at: 2026-10-04T01:59:59.625Z
sources:
  - id: openwiki-source-742d27f08cbeaa9bde84b50c
    resource: repo://.env.local.example
  - id: openwiki-source-f921b37aeed8645503835fd4
    resource: repo://app/(app)/settings/tracking/actions.ts
  - id: openwiki-source-bf5a2621b9e8be808f7c47ed
    resource: repo://app/book/%5Bslug%5D/actions.ts
  - id: openwiki-source-3934c2f87cfed2d7e74c8303
    resource: repo://docs/production/capability-register.md
  - id: openwiki-source-723c675bbe2438236148b868
    resource: repo://docs/production/current-state.md
  - id: openwiki-source-279dfc2f7fb43354286b4c35
    resource: repo://lib/booking/marketing-consent.ts
  - id: openwiki-source-de4bff3842a15f6ccecfea59
    resource: repo://lib/conversion/adapters/meta.ts
  - id: openwiki-source-f84881648f02ddfcc5db9c53
    resource: repo://lib/conversion/dispatch.ts
  - id: openwiki-source-1ac86d1a3493261c63d56f90
    resource: repo://lib/conversion/meta-capi.ts
  - id: openwiki-source-dee23e3f8e5e25f5e59b8d10
    resource: repo://lib/conversion/token-crypto.ts
  - id: openwiki-source-e05e1f7c175fa2f59e07f1fa
    resource: repo://supabase/migrations/0106_studio_marketing_tracking.sql
  - id: openwiki-source-0ef3f7e44e294d01808149ad
    resource: repo://supabase/migrations/0107_studio_tracking_encrypted_token.sql
  - id: openwiki-source-124488a86eda2feff32b3ffc
    resource: repo://tests/db/booking-marketing-consent.db.test.ts
  - id: openwiki-source-9403d431aeaa7706a6244434
    resource: repo://tests/db/studio-marketing-tracking.db.test.ts
  - id: openwiki-source-6e1f25e1651ef228a30a969e
    resource: repo://tests/db/tracking-encrypted-token.db.test.ts
  - id: openwiki-source-ee7fbb4f08416ef5150f66a8
    resource: repo://tests/lib/conversion/dispatch.test.ts
  - id: openwiki-source-5109d3f04b9e134e80e03d78
    resource: repo://tests/lib/conversion/meta-capi.test.ts
generated: { by: "claude-code", at: "2026-10-04T01:59:59.625Z" }
---

# Marketing consent and conversion tracking

A studio may optionally send a **booking-confirmed conversion** to its own ad provider; only a Meta Conversions API
adapter exists. The feature is built so that a booking can never depend on it. Nothing leaves Hone unless:

- the client opted in;
- the studio enabled a provider;
- the event wins an atomic dedup claim;
- the studio's own encrypted token decrypts.

The modules live in `lib/conversion/`; the public booking action calls them after the appointment is committed
(see [Public booking](../scheduling/public-booking-reschedule-and-cancellation.md)).

## 1. Data model (`0106`, `0107`)

| Table | Holds | Who writes | Who reads |
|---|---|---|---|
| `booking_tracking_consents` | one consent record per booking: a boolean, `consent_text_version`, a checked `consent_source` | the service role only (no anon or authenticated insert policy) | studio members |
| `studio_tracking_providers` | per-studio provider config (`provider`, `enabled`, `browser_tag_id`, `consent_mode`) and, since `0107`, `encrypted_server_token`, `server_token_last4`, `token_status` | **owners** only through RLS (`0107` replaced the member insert and update policies) | studio members |
| `conversion_event_deliveries` | the dedup and delivery log, unique on `(studio_id, provider, event_id)`, status `claimed` / `sent` / `failed` / `skipped` | the service role and the claim function | studio members |

The migrations state a data-minimisation contract: no clinical fields, no raw email or phone and no token values
in these tables ([`0106` L100-L218](../../supabase/migrations/0106_studio_marketing_tracking.sql#L100-L218),
[`0107` L12-L56](../../supabase/migrations/0107_studio_tracking_encrypted_token.sql#L12-L56)).

`claim_conversion_delivery` is `SECURITY DEFINER` and executable by `service_role` only. It inserts a `claimed` row
with `on conflict do nothing` and returns whether *this* caller created it, the same pattern as the email send
claim. The DB tests prove RLS isolation and uniqueness, that the claim returns true once and then false, owner-only
provider writes, and that no raw-token column exists (`tests/db/studio-marketing-tracking.db.test.ts`,
`tests/db/tracking-encrypted-token.db.test.ts`, `tests/db/booking-marketing-consent.db.test.ts`).

## 2. Consent capture on public booking

The public booking form carries an optional checkbox. `parseMarketingConsent` treats only an explicit `"true"` or
`"on"` as consent, so the default is opt-out, and the row stores only bookkeeping: studio, appointment, client, the
boolean, the text version `marketing_analytics_v1` and the source `public_booking`
([`marketing-consent.ts`](../../lib/booking/marketing-consent.ts#L1-L44)).

After the appointment commits, the booking action inserts the consent row **fire-and-forget** (a failure logs a
PII-free event and never affects the booking) and then calls `dispatchBookingConversion`, also fire-and-forget
([public booking action L1614-L1666](../../app/book/[slug]/actions.ts#L1614-L1666)). It passes the normalised email
and phone, the service **modality** (not its name) and the event source URL, and **not** the client IP or user
agent, although the adapter would accept them.

## 3. The dispatcher's gates

[`dispatchBookingConversion`](../../lib/conversion/dispatch.ts#L56-L164) never throws: the whole body is in a `try`
whose `catch` swallows everything, because the booking is already committed.

1. **Consent.** `consentGranted` false returns before any database query.
2. **Enabled provider.** Only this studio's enabled rows are read; none means inert. A provider without an adapter
   is skipped before any claim.
3. **Dedup claim** with the deterministic event id `hone_booking_<appointmentId>`; a lost claim means the event was
   already handled.
4. **Token.** This studio's ciphertext is decrypted; no key, no token, or a malformed or tampered blob marks the
   delivery `skipped` with a reason and sends nothing.

Success records `sent` with a redacted provider id. Failure records `failed` with a safe error string and raises a
**warning** ops alert ([L139-L190](../../lib/conversion/dispatch.ts#L139-L190)). `tests/lib/conversion/dispatch.test.ts`
proves each gate and that delivery rows never carry a raw token, email or phone.

## 4. What reaches Meta

The Meta adapter ([`adapters/meta.ts` L30-L99](../../lib/conversion/adapters/meta.ts#L30-L99)) builds a `Schedule`
event and posts it to the Graph API events endpoint for the configured pixel with the decrypted token:

- **email and phone** are normalised and **SHA-256 hashed** (unsalted, per Meta's specification), never sent raw;
- **the service** is reduced by an allowlist to `electrolysis`, `laser`, `consultation` or `other`, because a
  free-text service name can name an intimate body area ([`meta-capi.ts` L20-L59](../../lib/conversion/meta-capi.ts#L20-L59));
- **not sent**: client name, notes, intake answers, contraindications, allergies, body areas, photos or cancellation
  reasons; the builder has no parameter for any of them.

`tests/lib/conversion/meta-capi.test.ts` pins the hashing and the body-area leak guard.

## 5. Token storage and the owner surface

- **Encryption.** Tokens are encrypted with **AES-256-GCM** under one server master key,
  `TRACKING_TOKEN_ENCRYPTION_KEY`, stored as `iv:tag:ciphertext` plus the last four characters; tampering fails the
  GCM tag, and a decrypt failure never surfaces the raw error ([`token-crypto.ts`](../../lib/conversion/token-crypto.ts#L1-L79)).
- **Owner actions.** `saveTrackingProviderConfigAction` and `clearTrackingTokenAction`
  (`app/(app)/settings/tracking/actions.ts` L9-L120) require an **active owner** in application code and then write
  through the **service-role** client, so the `0107` owner-only RLS policies are mirrored rather than exercised. A blank
  token field keeps the existing token, a key-less deployment refuses to store anything, and clearing sets
  `token_status = 'absent'` so the sender skips.

## 6. Lifecycle state

[`capability-register.md`](../../docs/production/capability-register.md) and
[`current-state.md` § 8. Communications](../../docs/production/current-state.md#8-communications) record conversion
tracking as **merged, DB applied (`0106`/`0107`), deployed and inert per studio**: no provider token is configured,
so it is not enabled anywhere and not production-exercised, and configuring one is an enablement step. Whether the
master key is set in any deployment is not recorded in the repository.

## 7. Contradictions and open questions

1. **A stale "not wired" header.** `meta-capi.ts` says it "is not wired into the booking flow yet"
   ([L4-L9](../../lib/conversion/meta-capi.ts#L4-L9)), while the public booking action imports and calls
   `dispatchBookingConversion`. The gates keep it inert; the comment describes an earlier state.
2. **A frozen migration header.** `0107` says it is "NOT applied to production in this PR"
   ([L9-L10](../../supabase/migrations/0107_studio_tracking_encrypted_token.sql#L9-L10)); the capability register
   records it as applied. Treat the header as history.
3. **An undocumented key.** `TRACKING_TOKEN_ENCRYPTION_KEY` is read by the code but is not listed in
   `.env.local.example`.
4. **Members can read ciphertext.** The member select policy on `studio_tracking_providers` is row-scoped only
   ([`0106` L73-L80](../../supabase/migrations/0106_studio_marketing_tracking.sql#L73-L80)), so it returns
   `encrypted_server_token` too. It is unusable without the server key, but it exposes more than an owner-managed
   secret needs to.
