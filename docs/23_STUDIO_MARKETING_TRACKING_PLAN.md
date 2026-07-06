# Studio Marketing and Conversion Tracking Plan

Status (2026-07-06): **Privacy / docs / UI-copy preparation only.** No tracking is enabled, no sender is wired, no browser pixel is added, no provider receives data, no env var is added, and no migration ships in this PR. Meta is the first *provider foundation* (the inert, un-wired payload builder in `lib/conversion/meta-capi.ts`, see docs/22), but the model below is **provider-agnostic**.

## Principles
- **Off by default.** Hone does not enable advertising/behavioral tracking. A studio may opt in per provider.
- **Studio-owned.** Each studio configures its own provider, ad account, dataset/pixel, and tokens. Hone may process events on the studio's behalf but does not own the account.
- **No cross-studio mixing.** One studio's conversion data is never used for another studio's advertising.
- **Consent-gated.** Server-side conversion events are only sent where the studio has enabled the provider AND applicable marketing/analytics consent is satisfied.
- **Clinic-safe data minimization.** Only minimal, non-clinical conversion data is ever sent (see the allowed/forbidden lists).
- **Cautious wording.** All user-facing copy uses "may", "where enabled", "subject to applicable consent and configuration" — no overclaiming of legal compliance.

## Provider model (generic; per studio)
A studio's marketing config is per-provider, not a shared Hone-wide pixel:

- `provider`: one of `meta` | `google_ads` | `ga4` | `tiktok` | `pinterest` | `linkedin` | `microsoft_ads` | `custom`
- studio-owned account / dataset / pixel id
- `enabled` flag (default false)
- `consent_mode` (how consent is required/recorded)
- browser tag id where applicable (e.g. Meta Pixel id, GA4 measurement id, TikTok pixel code)
- server-side token secret reference where applicable (token itself is a server-only secret, not stored in plaintext in the DB)
- test/debug code where applicable (e.g. Meta test_event_code, GA4 debug mode)

## Internal Hone events (canonical, provider-neutral)
- `page_view`
- `lead_submitted`
- `booking_started`
- `booking_confirmed`
- `appointment_completed`
- `client_converted`

## Provider mappings (booking_confirmed is the primary conversion)
- `booking_confirmed` → **Meta** `Schedule`
- `booking_confirmed` → **Google Ads** conversion action (Enhanced/Offline Conversions)
- `booking_confirmed` → **GA4** custom event / `generate_lead` or `appointment_booked` (Measurement Protocol)
- `booking_confirmed` → **TikTok** `CompleteRegistration` / `Schedule`-equivalent where supported (Events API)
- `booking_confirmed` → **Pinterest** conversion event (Conversions API)
- `booking_confirmed` → **LinkedIn** conversion event (Conversions API)
- `booking_confirmed` → **Microsoft Ads** offline conversion (UET)

## Data minimization (applies to EVERY provider)
**Allowed (minimal conversion data only):**
- `event_name`
- `event_time`
- `event_id` (deterministic, booking-derived)
- `event_source_url`
- hashed email / phone — only if consent and configuration permit
- generic `service_category` only (e.g. `consultation` / `electrolysis` / `laser` / `other`)

**Forbidden (never send to any provider):**
- client name
- raw email / phone in logs
- treatment notes
- intake / health data
- contraindications
- allergies
- body areas
- treatment photos
- appointment notes
- cancellation reasons
- exact, sensitive service names
- portal tokens or portal links
- payment card data
- Stripe ids (unless absolutely necessary and redacted)

## Booking-page consent copy (DRAFT — not wired)
Provider-agnostic. Separates necessary booking/service communications from optional marketing/analytics tracking. The checkbox and its storage are **not** implemented here (that needs a separate approved migration).

> **Optional marketing and analytics tracking.** This studio may use advertising
> or analytics tools to understand whether people book after visiting its
> website or ads. If you agree, limited booking event information may be shared
> with the studio's configured marketing providers. Clinical information,
> treatment notes, intake answers, photos, and body-area details are not shared
> for advertising.

Must communicate:
- **Declining marketing tracking does not stop your booking** — it is optional and non-essential.
- Service and transactional emails/SMS (confirmations, reminders) are **separate** from marketing tracking and are not controlled by this choice.
- This marketing consent can be **recorded separately** from treatment and payment consents.

## Studio website cookie/banner copy (DRAFT — generic, for a studio's own site)
A studio (e.g. Willow) can adapt this on its own website; Hone does not edit studio websites here.

**Cookie banner:**
> We use necessary cookies to run this site. With your permission, we also use
> marketing and analytics tools to understand visits, form submissions, and
> bookings.

Buttons: **Accept marketing cookies** · **Reject non-essential cookies** · *Manage preferences* (optional).

**Privacy section (studio website):**
- We may use browser pixels/tags and server-side conversion APIs.
- Examples of providers: Meta, Google, TikTok, Pinterest, LinkedIn, Microsoft Ads.
- Events we may measure: PageView, Lead (form submitted), booking-started, booking-confirmed.
- Booking-confirmed events may be sent from Hone (our booking provider) to this studio's configured marketing provider.
- Clinical, intake, and treatment information is never sent for advertising.
- Provider opt-out / ad-preferences links are provided as examples (e.g. Meta ad preferences, Google Ads settings, and your browser/OS ad controls) — not limited to any single provider.

## What later phases need (each gated on approval)
- **Migration (separate PR, approval required):** per-studio provider config table/columns + `appointments` dedup markers + a claim RPC. Not in this PR.
- **Booking consent capture (separate PR + migration):** the checkbox + a consent record, ideally separable from clinical/payment consents.
- **Sender wiring (separate PR):** provider adapters mapping internal events → provider payloads, non-blocking, timed out, redacted, consent-gated.
- **Studio settings UI:** per-provider config editor.
- **Studio website changes:** applied in the studio's own repo (not Hone).

## Confirmation
Provider-agnostic (not Meta-only); no tracking enabled; no sender/pixel/token/env; no data can be sent to any provider from this PR. The Meta foundation (docs/22, `lib/conversion/meta-capi.ts`) remains inert and imported nowhere.
