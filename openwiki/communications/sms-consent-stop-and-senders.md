---
type: integration
title: SMS delivery, consent, STOP and senders (Twilio)
description: How Hone sends appointment SMS through Twilio's REST API from one platform sender, the consent gate and per-type claim columns, how consent is captured on public booking, how STOP is authenticated and enforced phone-wide for clients and waitlist prospects, and the per-studio sender lifecycle that exists as tested library code with only a read-only owner status card as its product surface.
tags: [sms, twilio, consent, stop, suppression, studio-senders]
verified:
  - by: openwiki/0.6.1
    at: 2026-10-04T01:59:59.625Z
sources:
  - id: openwiki-source-0529e4397b0facf213381bdf
    resource: repo://app/(app)/settings/integrations/page.tsx
  - id: openwiki-source-08abff96c852db46fe5155e9
    resource: repo://app/api/twilio/inbound-sms/route.ts
  - id: openwiki-source-bf5a2621b9e8be808f7c47ed
    resource: repo://app/book/%5Bslug%5D/actions.ts
  - id: openwiki-source-723c675bbe2438236148b868
    resource: repo://docs/production/current-state.md
  - id: openwiki-source-0a7f1727d82c9ac5dce569e4
    resource: repo://docs/production/known-limitations.md
  - id: openwiki-source-f79f369ce2044c952565dcb9
    resource: repo://docs/production/migration-ledger.md
  - id: openwiki-source-74b3385bf8bca6d43e5d3c56
    resource: repo://lib/sms/provider/index.ts
  - id: openwiki-source-c526a88b9c15bb2964ba71a7
    resource: repo://lib/sms/send-appointment.ts
  - id: openwiki-source-1def3dfd92b1171ef1ac7e2e
    resource: repo://lib/sms/studio-sender.ts
  - id: openwiki-source-5b8203ce3d69de1f312bc0cb
    resource: repo://lib/sms/suppression.ts
  - id: openwiki-source-44eb9f12fec06381981c6372
    resource: repo://lib/sms/twilio.ts
  - id: openwiki-source-d81538d8891efe37053aeccb
    resource: repo://supabase/config.toml
  - id: openwiki-source-6977272b5c74606f5d8f93b3
    resource: repo://supabase/migrations/0049_sms_foundation.sql
  - id: openwiki-source-d6e1ff8ced0de582d0abf485
    resource: repo://supabase/migrations/0062_harden_sms_rpc_grants.sql
  - id: openwiki-source-ea2efac098bcbb7fd7e1d484
    resource: repo://supabase/migrations/0191_studio_sms_sender_provisioning.sql
  - id: openwiki-source-0845aa65893e3661c44fe1cf
    resource: repo://supabase/migrations/0194_studio_sms_sender_outbound_lookup.sql
  - id: openwiki-source-b34eea9e5fa2a5bfe2e56d48
    resource: repo://tests/source-guards/sms-adoption-boundary.test.ts
  - id: openwiki-source-66d9b60c75ce514b7597944b
    resource: repo://tests/source-guards/sms-provider-guards.test.ts
  - id: openwiki-source-23bb7784a2907a10cf3f8739
    resource: repo://tests/source-guards/sms-status-readonly-boundary.test.ts
generated: { by: "claude-code", at: "2026-10-04T01:59:59.625Z" }
---

# SMS delivery, consent, STOP and senders (Twilio)

SMS has two very different halves in this repository:

1. **Live appointment SMS**: booking confirmation and ~24h / ~2h reminders, sent from **one platform-wide
   Twilio sender**, gated by a per-studio toggle and per-client consent, with STOP handled by an inbound
   webhook.
2. **Per-studio senders**: a provisioning, adoption and resolution lifecycle with its own table, lease
   protocol and provider abstraction, **implemented and tested but with no product caller** apart from a
   read-only owner status card.

Keep them apart when reading or changing anything here.

## 1. Transport (`lib/sms/twilio.ts`)

- **No Twilio SDK**: one `fetch` to the Messages API with Basic auth
  ([L1-L21](../../lib/sms/twilio.ts#L1-L21)). A guard enforces that the SDK is not a dependency and that only
  allowlisted adapters name a Twilio host
  ([`sms-provider-guards.test.ts` L126-L198](../../tests/source-guards/sms-provider-guards.test.ts#L126-L198)).
- **Sender**: `TWILIO_MESSAGING_SERVICE_SID` if set, else `TWILIO_FROM_NUMBER`. Missing account credentials
  give `twilio_not_configured` and missing both senders give `twilio_missing_sender`, both non-retryable
  ([L110-L177](../../lib/sms/twilio.ts#L110-L177)). Every studio's appointment SMS leaves from the same
  platform identity.
- A 15-second `AbortController` timeout aborts the request client-side (Twilio may still have accepted it);
  the response is reduced to a message SID, and the auth token and full phone numbers are never logged
  ([L130-L248](../../lib/sms/twilio.ts#L130-L248); `maskedPhone` at [L316-L326](../../lib/sms/twilio.ts#L316-L326)).
- **Phone normalization**: `normalizePhoneForSms` accepts `+` with 8–15 digits, promotes 10-digit numbers to
  `+1…` and 11-digit `1…` to `+1…`, and returns `null` ("do not send") otherwise; `normalizePhoneForMatch`
  canonicalizes through it so consent and STOP compare the same digits
  ([L43-L95](../../lib/sms/twilio.ts#L43-L95)).

## 2. The send law for appointment SMS

`sendOne` in `lib/sms/send-appointment.ts` runs the **consent gate**, then `claim_sms_send`, then the Twilio
post, then `record_sms_result` in `finally` ([L369-L459](../../lib/sms/send-appointment.ts#L369-L459)).

The consent gate refuses, as a skip rather than an error, when the studio's toggle for that message type is
off, the client has `sms_opted_out_at`, the client has no `sms_consent_at`, or the phone does not normalize
([L198-L220](../../lib/sms/send-appointment.ts#L198-L220)). The studio toggles `send_confirmation_sms`,
`send_24h_sms_reminders` and `send_2h_sms_reminders` default to **false**, and each message type has its own
sent, attempts and claimed columns ([`0049` L77-L133](../../supabase/migrations/0049_sms_foundation.sql#L77-L133)).

`claim_sms_send` / `record_sms_result` mirror the email claim: a conditional update that wins at most once per
slot, a three-attempt cap and a stale-claim window. `0049` granted them to `authenticated`; `0062` revoked every
browser role and left `service_role` only
([`0062` L48-L70](../../supabase/migrations/0062_harden_sms_rpc_grants.sql#L48-L70)). Retry and crash-window
semantics match email; see [Cron jobs, reminders and idempotency](cron-reminders-and-idempotency.md).

**Consent capture.** `clients.sms_consent_source` is `public_booking`, `practitioner` or `import`. On the public
booking form an **existing** client's consent is stamped only if they are not opted out, have no earlier
consent, and the submitted phone normalizes to the **stored** phone, so knowing someone's email is not enough to
opt their number in. A failure to stamp never blocks the booking (public booking action, `app/book/<slug>/actions.ts`
L996-L1030).

## 3. STOP: the inbound webhook

[`app/api/twilio/inbound-sms/route.ts`](../../app/api/twilio/inbound-sms/route.ts) is the only opt-out entry point.

1. **Authenticate before any read.** No `TWILIO_AUTH_TOKEN` gives 500 and no `X-Twilio-Signature` gives 403. The
   raw body is read before parsing and validated with HMAC-SHA1 over the canonical URL (`TWILIO_WEBHOOK_BASE_URL`
   plus the path when set) and the sorted form fields, in constant time; an invalid signature gives 403 with
   **zero writes** ([L87-L153](../../app/api/twilio/inbound-sms/route.ts#L87-L153),
   [`twilio.ts` L250-L282](../../lib/sms/twilio.ts#L250-L282)).
2. **Keyword match.** The whole trimmed, upper-cased body must be `STOP`, `STOPALL`, `UNSUBSCRIBE`, `CANCEL`,
   `END` or `QUIT` ([`twilio.ts` L284-L304](../../lib/sms/twilio.ts#L284-L304)). Anything else gets an empty
   TwiML response and the body is neither stored nor logged
   ([route L164-L174](../../app/api/twilio/inbound-sms/route.ts#L164-L174)).
3. **Phone-wide suppression across two record types.** Every `clients` row whose phone matches the sender, **in
   every studio**, is stamped `sms_opted_out_at` / `sms_opt_out_source = 'twilio_stop'` behind an `is null`
   guard. Waitlist prospects are then found through `waitlist_prospect_suppression_candidates` and stamped
   through `suppress_waitlist_prospects`, because `0185` gives the route no DML on waitlist entries
   ([L176-L375](../../app/api/twilio/inbound-sms/route.ts#L176-L375)).
4. **Audit, then decide the status.** One `audit_logs` row per stamped record, with masked numbers only; an
   audit failure never un-suppresses. If **any** scan or stamp failed the route returns 500 so Twilio retries,
   and the retry touches only rows still not opted out ([L378-L483](../../app/api/twilio/inbound-sms/route.ts#L378-L483)).

[`lib/sms/suppression.ts`](../../lib/sms/suppression.ts#L1-L95) names the rule: **carrier** suppression is
sender-scoped and outside Hone's control, **Hone** suppression is phone-wide across studios, and
`selectHoneSuppressionTargets` deliberately takes no studio and no inbound `To`, so a per-studio sender can never
narrow it.

There is **no re-subscribe path** in application code (`START`/`UNSTOP` are not handled), and the consent paths
above refuse opted-out clients, so a studio-side change cannot clear an opt-out.

## 4. Per-studio senders: implemented, not reachable

| Component | What it does | Product caller? |
|---|---|---|
| `studio_sms_senders` (`0191`) | one row per sender with a guarded status machine `off → selecting → provisioning → active ↔ suspended → releasing → released` (plus `error`), lease generation and claim key; at most one live row per studio | the table is closed to every role including `service_role`, with a column-level select for owners ([`0191` L106-L376](../../supabase/migrations/0191_studio_sms_sender_provisioning.sql#L106-L376), [L411-L560](../../supabase/migrations/0191_studio_sms_sender_provisioning.sql#L411-L560), [L1088-L1131](../../supabase/migrations/0191_studio_sms_sender_provisioning.sql#L1088-L1131)) |
| lease commands (`claim_`/`finalize_`/`fail_studio_sms_provisioning`, `renew_studio_sms_lease`, `resolve_studio_by_sms_messaging_service`) | the only write path to the table | `service_role` only; called only from the library |
| `resolve_active_studio_sms_sender` (`0194`) | returns the **set** of active senders' messaging-service ids for a studio | `service_role` only ([`0194` L68-L101](../../supabase/migrations/0194_studio_sms_sender_outbound_lookup.sql#L68-L101)) |
| `resolveStudioSmsSender` | fails closed with `no_active_sender`, `ambiguous_active_sender` or `read_failed`; **no env fallback** ([`studio-sender.ts`](../../lib/sms/studio-sender.ts#L1-L133)) | **none** |
| `provisionStudioSmsSender`, `searchAvailableSenderNumbers` ([`provisioning.ts`](../../lib/sms/provisioning.ts)) | purchase a number and build a sender under a fenced lease | **none** |
| `adoptExistingStudioSmsSender` ([`adoption.ts`](../../lib/sms/adoption.ts)) | adopt an existing studio-owned number: prove ownership, compare configuration, send a provider test; never purchases, creates or attaches | **none** |
| `readOwnStudioSmsSender` + `SmsSenderStatusCard` | owner-only, read-only status in Settings → Integrations | **yes** (`app/(app)/settings/integrations/page.tsx` L45-L91) |

Safety rails around the unreachable half:

- **The provisioning provider is fake by default.** The real Twilio adapter is selected only when
  `HONE_SMS_PROVISIONING_LIVE=true` *and* credentials are present; credentials alone never arm it
  ([`provider/index.ts` L6-L48](../../lib/sms/provider/index.ts#L6-L48)), and a guard asserts the flag is set
  nowhere in the repository ([`sms-provider-guards.test.ts` L317-L340](../../tests/source-guards/sms-provider-guards.test.ts#L317-L340)).
- **Adoption cannot spend money.** A source guard forbids purchase, service creation, number attachment and
  configuration writes in `adoption.ts`, requires the fenced wrapper, and requires the ownership → configuration →
  test order ([`sms-adoption-boundary.test.ts` L30-L66](../../tests/source-guards/sms-adoption-boundary.test.ts#L30-L66)).
- **The status card is read-only by construction**: no provider, RPC, write, service-role client or pressable
  control ([`sms-status-readonly-boundary.test.ts` L55-L156](../../tests/source-guards/sms-status-readonly-boundary.test.ts#L55-L156)).

## 5. Lifecycle state, with the record that holds it

| Fact | State | Record |
|---|---|---|
| Appointment SMS | **pilot scale only**: env-gated, per-studio toggle, per-client consent; broad-SaaS SMS (A2P/10DLC, sender strategy, rate limiting) not built | [`current-state.md` § 8. Communications](../../docs/production/current-state.md#8-communications) |
| Per-studio sender provisioning | **implemented, not production-exercised**: the post-`0199` apply record says no provider was contacted and no sender was provisioned | [migration ledger, post-0199 block](../../docs/production/migration-ledger.md#previous-state-verified-2026-09-18-post-0199-apply-0199-applied) |
| Owner sender visibility (#749) | **shipped** read-only card; no provisioning, purchase, adoption, release or routing cutover | [`current-state.md` § Level 3 WAIT checkpoint](../../docs/production/current-state.md#2026-09-20-level-3-wait-checkpoint--top-product-priority) |
| Studio-sender routing cutover (PR #716) | **not merged**; WAIT invitations remain email-only and broader SMS rollout is blocked | [`known-limitations.md` § L14](../../docs/production/known-limitations.md#l14--broad-saas-sms-and-wait-dual-channel-delivery-are-not-complete) |

## 6. Change checklist

- Never add a fallback from a studio sender to the platform env sender inside the studio-sender path; a refusal
  means "do not send".
- Never scope a STOP by studio or by the number it arrived on.
- Any new SMS type needs its own claim columns, a studio toggle that defaults off, and the consent gate.
- Never log a full number, a message body, the auth token or a provider SID; use `maskedPhone`.

## 7. Contradictions and open questions

1. **"STOP/HELP handled" versus the code.** The canonical record says SMS has "STOP/HELP handled"
   ([`current-state.md` § 8. Communications](../../docs/production/current-state.md#8-communications)), while the
   application recognises only the six opt-out keywords and answers every other inbound body, including `HELP`,
   with an empty response. Any HELP behaviour would have to be provider-side configuration, which the repository
   cannot show.
2. **The STOP client scan is unpaginated.** It reads every `clients` row with a phone in one PostgREST select and
   filters in application code ([L209-L230](../../app/api/twilio/inbound-sms/route.ts#L209-L230)). The local API
   configuration caps responses at 1,000 rows ([`supabase/config.toml` L7-L18](../../supabase/config.toml#L7-L18));
   the hosted cap is not recorded in the repository. Above that cap a matching client could be missed without an
   error. The generated column `clients.sms_phone` (`0199`) is not used by this route.
3. **`0199`'s header describes a studio-sender-resolving `sendOne`** that this tree does not contain; the merged
   `sendOne` posts through the platform sender. See
   [Cron jobs, reminders and idempotency](cron-reminders-and-idempotency.md#7-contradictions-and-open-questions).
