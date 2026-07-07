# Studio Marketing & Conversion Tracking Plan (platform-agnostic)

Status (2026-07-06): **Architecture + docs only.** No tracking enabled, no sender wired, no browser pixel, no data sent to any provider, no env var, and **no migration in this PR** (proposed below, approval-gated). Meta is the **first provider adapter**, not the design — the layer is provider-agnostic.

> This supersedes the earlier Meta-only framing. The inert Meta payload primitives from PR #345 (`lib/conversion/meta-capi.ts`) are now consumed by a generic adapter.

## What shipped in this PR (inert)
- `lib/conversion/types.ts` — provider-agnostic types: `TrackingProvider`, `ConversionEventName`, `ConversionEvent`, `ProviderConfig`, `ProviderPayload`, `SendResult`, `ConversionProviderAdapter`, `DeliveryRecord`, `MarketingConsent`.
- `lib/conversion/service.ts` (server-only) — `deliverConversionEvent(event, ctx)`: gates on config + consent, dedupes by `(eventId, provider)`, dispatches to injected adapters, **never throws**, emits only safe `DeliveryRecord` status. Does no network itself; **called from nothing in the app**.
- `lib/conversion/adapters/meta.ts` (server-only) — first adapter. `buildPayload` maps `booking_confirmed → Meta "Schedule"` reusing #345's tested hashing/minimization; **`send()` is a not-wired skip** (no network, no token).
- Tests proving gating, dedup, per-studio isolation, redaction, booking-safety, and payload minimization.

## Architecture

### 1. Internal Hone conversion events (provider-neutral)
`lead_submitted` · `booking_started` · `booking_confirmed` · `appointment_completed` · `client_converted` · `referral_created`

### 2. Generic conversion event service
Accepts a provider-agnostic `ConversionEvent`; checks studio tracking config; checks marketing consent; loads the studio's enabled providers; sends only to enabled providers; failure never blocks booking; logs safe `skipped | sent | failed` status; never logs raw email/phone/tokens/clinical data.

### 3. Provider adapter interface
```ts
type ConversionProviderAdapter = {
  provider: TrackingProvider;
  buildPayload(event: ConversionEvent, config: ProviderConfig): ProviderPayload | null;
  send(payload: ProviderPayload, config: ProviderConfig): Promise<SendResult>;
};
```
- **Meta (implemented, inert):** `booking_confirmed → Schedule`, generic `service_category` only, hashed email/phone, no clinical data, `send()` not wired.
- **Future adapters:** Google Ads (Enhanced/Offline), GA4 (Measurement Protocol), TikTok (Events API), Pinterest (CAPI), LinkedIn (CAPI), Microsoft Ads (UET/offline).

### 4. Schema proposal (MIGRATION — NOT applied; approve first)
```sql
-- Per-studio provider config. Token is NOT stored here — only a server-side
-- secret REFERENCE; the raw token lives in server env and is resolved by the
-- sender. RLS: studio members only (is_studio_member).
create table if not exists public.studio_tracking_providers (
  id                       uuid primary key default gen_random_uuid(),
  studio_id                uuid not null references public.studios(id) on delete cascade,
  provider                 text not null check (provider in
                             ('meta','google_ads','ga4','tiktok','pinterest','linkedin','microsoft_ads','custom')),
  enabled                  boolean not null default false,
  browser_tag_id           text,
  server_token_secret_ref  text,
  conversion_action_id     text,
  test_event_code          text,
  consent_mode             text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  unique (studio_id, provider)
);

-- Delivery log for dedup + observability. No PII: hashed/none only.
create table if not exists public.conversion_event_deliveries (
  id                  uuid primary key default gen_random_uuid(),
  studio_id           uuid not null references public.studios(id) on delete cascade,
  provider            text not null,
  internal_event_name text not null,
  event_id            text not null,
  status              text not null check (status in ('skipped','sent','failed')),
  skipped_reason      text,
  provider_event_id   text,          -- redacted/opaque
  last_error_safe     text,
  attempted_at        timestamptz,
  created_at          timestamptz not null default now(),
  unique (studio_id, provider, event_id)   -- deterministic dedup
);

-- Booking marketing consent (separable from clinical/payment consent). Booking
-- MUST continue if declined. Either these columns on appointments, or a table:
create table if not exists public.booking_tracking_consents (
  id             uuid primary key default gen_random_uuid(),
  studio_id      uuid not null references public.studios(id) on delete cascade,
  appointment_id uuid references public.appointments(id) on delete cascade,
  granted        boolean not null,
  source         text,               -- e.g. 'public_booking_form'
  policy_version text,
  created_at     timestamptz not null default now()
);
```

### 5. Data minimization
**Allowed:** event name · event time · deterministic event id · source URL · hashed email/phone (if consented) · IP/user-agent (only if lawful/available) · generic service category.
**Forbidden:** raw email/phone in logs · names · treatment notes · intake answers · contraindications · body areas · photos · appointment notes · cancellation reasons · exact sensitive service names · payment/card data · Stripe ids (unless redacted and necessary).

## Phased PR sequence
1. **#345 (merged)** — inert Meta payload/hashing primitives.
2. **#346 (open)** — provider-agnostic privacy/consent/terms copy.
3. **THIS PR** — provider-agnostic types + service + Meta adapter (inert, not wired, no migration).
4. **Migration PR (approval-gated)** — the 3 tables above + a `claim`/dedup RPC.
5. **Consent-capture PR (+ migration)** — booking-form marketing-consent checkbox + record.
6. **Sender-wiring PR** — implement `metaAdapter.send()` (timeout, redaction, ops-alert), and call `deliverConversionEvent` as a fire-and-forget side effect at the booking-confirmed point (`app/book/[slug]/actions.ts`), gated on config + consent.
7. **Studio settings UI PR** — per-provider config editor.
8. **Studio website PR** — Pixel + cookie banner in the studio's own repo (not Hone).

## Confirmation
Provider-agnostic (Meta is one adapter). No tracking enabled; no sender wired; no data can be sent to any provider from this PR. Provider tokens are server-side only (config stores a reference, never the token). Per-studio isolation enforced by caller-scoped configs + the proposed `unique (studio_id, provider)` constraints.

> **Secret model update (0107 / self-serve):** provider tokens are now stored **AES-256-GCM-encrypted per studio** in `studio_tracking_providers.encrypted_server_token` (one server-side master key `TRACKING_TOKEN_ENCRYPTION_KEY`); studio owners add/rotate/delete their own token in Settings → Marketing & analytics tracking. No global shared token, no per-studio Vercel env var, no raw token in the DB/client/logs. The dispatcher decrypts server-side and passes the plaintext to the adapter's `send()` via `SendContext`.
