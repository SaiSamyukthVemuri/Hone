---
type: integration
title: Marketing consent and conversion tracking
description: How public booking records an opt-in marketing/analytics consent separately from clinical and payment consent, how a studio owner stores an encrypted per-studio provider token, the four gates and the atomic dedup claim that run before a hashed Meta Conversions API "Schedule" event can leave Hone, what is and is not sent, how failures are recorded, and why production is deployed but inert.
tags: [marketing, conversion-tracking, consent, meta-capi, encryption, privacy, public-booking]
verified:
  - by: openwiki/0.6.1
    at: 2026-10-02T22:34:57.394Z
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
generated: { by: "claude-code", at: "2026-10-02T22:34:57.394Z" }
---

# Marketing consent and conversion tracking

A studio may optionally send a **booking-confirmed conversion** to its own ad provider. Only a Meta
Conversions API adapter exists today. The feature is built so that a booking can never depend on it.
Nothing leaves Hone unless all of these hold:

- the client opted in;
- the studio enabled a provider;
- the event wins an atomic dedup claim;
- the studio's own encrypted token decrypts.

The modules live in `lib/conversion/`. The public booking action calls them after the appointment is
committed (see [Public booking](../scheduling/public-booking-reschedule-and-cancellation.md)).

## 1. Data model (`0106`, `0107`)

| Table | Holds | Who writes | Who reads |
|---|---|---|---|
| `booking_tracking_consents` | one consent record per booking: boolean, `consent_text_version`, `consent_source` (`public_booking`, `portal`, `studio_website`, `admin_import`) | service role only (no anon or authenticated INSERT policy) | studio members |
| `studio_tracking_providers` | per-studio provider config: `provider` (8-value check), `enabled`, `browser_tag_id`, `consent_mode`, and since `0107` `encrypted_server_token`, `server_token_last4`, `token_status` | **owners** only via RLS (`0107` replaced the member insert/update policies) | studio members |
| `conversion_event_deliveries` | dedup and delivery log, unique `(studio_id, provider, event_id)`, status `claimed` / `sent` / `failed` / `skipped` | service role and the claim RPC (no authenticated write policy) | studio members |

The migration's data-minimisation contract is explicit: no clinical fields, no raw email or phone, no
token values in any of these tables
([`0106` L1-L218](../../supabase/migrations/0106_studio_marketing_tracking.sql#L1-L218),
[`0107` L1-L56](../../supabase/migrations/0107_studio_tracking_encrypted_token.sql#L1-L56)).

`claim_conversion_delivery` is a `SECURITY DEFINER` function, EXECUTE `service_role` only. It inserts a
`claimed` row with `on conflict do nothing` and returns whether *this* caller created it, the same
pattern as the email send claim. The database tests prove:

- RLS isolation and uniqueness;
- the claim returns true once, then false;
- owner-only provider writes;
- that no raw-token column exists.

(`tests/db/studio-marketing-tracking.db.test.ts`, `tests/db/tracking-encrypted-token.db.test.ts`,
`tests/db/booking-marketing-consent.db.test.ts`.)

## 2. Consent capture on public booking

The public booking form carries an optional checkbox. `parseMarketingConsent` treats only an explicit
`"true"`/`"on"` as consent, so the default is opt-out. The row stores only bookkeeping: studio,
appointment, client, the boolean, `marketing_analytics_v1` and `public_booking`
([`marketing-consent.ts`](../../lib/booking/marketing-consent.ts)).

After the appointment commits, the booking action inserts the consent row **fire-and-forget**. A
failure logs a PII-free event and never affects the booking. It then calls `dispatchBookingConversion`,
also fire-and-forget
([public booking action L1614-L1666](../../app/book/[slug]/actions.ts#L1614-L1666)). The call passes:

- the normalised email and phone;
- the service **modality** (not its name);
- the event source URL.

It does **not** pass client IP or user agent, although the adapter would accept them.

## 3. The dispatcher's gates

[`dispatchBookingConversion`](../../lib/conversion/dispatch.ts#L56-L164) never throws. The whole body
is in a `try` whose `catch` swallows everything, because the booking is already committed.

1. **Consent.** `consentGranted` false → return before any database query.
2. **Enabled provider.** It reads this studio's `enabled` rows only, and returns if there are none
   (inert). A provider with no adapter (anything but `meta`) is skipped before any claim.
3. **Dedup claim.** It calls `claim_conversion_delivery` with the deterministic event id
   `hone_booking_<appointmentId>`. A lost claim means the event was already handled.
4. **Token.** It decrypts **this studio's** ciphertext. No key, no token, a malformed blob or a tampered
   blob marks the delivery `skipped` with a reason and sends nothing.

Then it builds the payload and sends it. Success records `sent` with a redacted provider id. Failure
records `failed` with a safe error string and raises a **warning** ops alert, not a critical one.
`tests/lib/conversion/dispatch.test.ts` proves each gate. It also proves that delivery rows never
contain a raw token, email or phone.

## 4. What reaches Meta

The Meta adapter ([`adapters/meta.ts`](../../lib/conversion/adapters/meta.ts#L30-L99)) builds a
`Schedule` event (`action_source: "website"`) and POSTs it to the Graph API `/{pixel}/events` with the
decrypted token:

- **Email and phone** are normalised and **SHA-256 hashed (unsalted, per Meta's spec)**. They are
  never sent raw. A bare 10-digit phone number is given country code `1`.
- **The service** is reduced by an allowlist to `electrolysis`, `laser`, `consultation` or `other`.
  A free-text service name can name an intimate body area, so it never leaves
  ([`meta-capi.ts` L1-L59](../../lib/conversion/meta-capi.ts#L1-L59)).
- **Not sent:** client name, notes, intake answers, contraindications, allergies, body areas, photos,
  cancellation reasons. The builder has no parameter for any of them.

`tests/lib/conversion/meta-capi.test.ts` pins the hashing and the body-area leak guard.

## 5. Token storage and the owner surface

- **Encryption.** Tokens are encrypted with **AES-256-GCM** under one server master key,
  `TRACKING_TOKEN_ENCRYPTION_KEY` (64-char hex or base64 of 32 bytes). The stored form is
  `iv:tag:ciphertext`, so tampering fails the GCM tag. Only the ciphertext and the last four characters
  are persisted. Decrypt failures never surface the raw error
  ([`token-crypto.ts`](../../lib/conversion/token-crypto.ts#L1-L79)).
- **Owner actions.** `saveTrackingProviderConfigAction` and `clearTrackingTokenAction` live in
  `app/(app)/settings/tracking/actions.ts`. They require an **active owner** in application code, then
  write through the **service-role** client, so the 0107 owner-only RLS policies are mirrored rather
  than exercised. A blank token field keeps the existing token. A key-less deployment refuses to store
  anything. Clearing sets `token_status = 'absent'`, so the sender skips.

## 6. Production status (dated, with authority)

- [`capability-register.md`](../../docs/production/capability-register.md) and
  [`current-state.md` § 8. Communications](../../docs/production/current-state.md#8-communications)
  record conversion tracking as **merged, DB applied (0106/0107), deployed, inert per studio**: no
  studio has configured a provider token, and configuring one is an enablement step.
- The register marks it **not production-exercised**, because no studio has a configured token.
- Whether the master key is set in any deployment is not recorded in the repository.

## 7. Contradictions and open questions

1. **Stale "not wired" header.** `meta-capi.ts` says it "is not wired into the booking flow yet". Today
   the public booking action imports and calls `dispatchBookingConversion`. The gates keep it inert;
   the comment describes an earlier state.
2. **Frozen migration header.** `0107` says "NOT applied to production in this PR". The capability
   register records it as applied, and `0107` is inside the declared hosted range. Treat the header as
   history.
3. **Undocumented key.** `TRACKING_TOKEN_ENCRYPTION_KEY` appears in the code and the planning docs but
   not in `.env.local.example`.
4. **Members can read ciphertext.** The member SELECT policy on `studio_tracking_providers` returns
   every column, including `encrypted_server_token`. It is unusable without the server key, but it is
   more than an "owner-managed secret" needs to expose.
