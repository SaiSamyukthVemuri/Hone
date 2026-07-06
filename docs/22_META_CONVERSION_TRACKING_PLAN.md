# Meta Pixel + Conversions API booking-conversion pipeline — Plan

Status (2026-07-06): **Audit complete. Foundation library shipped (pure, not wired, sends nothing). Everything else is BLOCKED pending approval.** This document is the source of truth for the phased rollout.

## What shipped in this PR (safe, migration-free, not enabled)
- `lib/conversion/meta-capi.ts` — server-only, PURE payload + hashing builder. No network I/O, no DB reads, not imported by the booking flow. It encodes the data-minimization boundary in code.
- `tests/lib/conversion/meta-capi.test.ts` — proves hashing (not raw), deterministic `event_id`, gating (disabled/missing config → skip), and a static guard that clinical/PII field names can never enter the payload.

Nothing in this PR sends data to Meta, changes any privacy claim, adds a DB column, or touches Willow's site.

## BLOCKERS (require approval / are not in this repo)
1. **Willow marketing-site repo is not on this machine.** Phase 2 (Pixel base script, PageView/Lead/InitiateCheckout, consent banner, privacy edits on willowelectrolysis.com) is **specced below** but must be applied in the Willow repo.
2. **Phase 3 needs a DB migration** (per-studio Meta config on `studios` + dedup columns on `appointments`). Per instruction: proposed below, **not created/applied** — needs approval.
3. **Privacy/legal blocker.** `app/privacy/page.tsx:243` currently states: *"We do not use third-party advertising cookies, behavioral tracking cookies, or analytics cookies that share data with advertising networks."* Enabling Meta contradicts a **published promise**. No cookie-consent banner or marketing-consent mechanism exists. This is a legal decision (Ontario PIPEDA/PHIPA) requiring **owner + counsel approval** before any production enablement.

## Phase 1 audit answers
1. **Pixel base script (Willow):** site-wide `<head>`/root layout of the Willow Next.js app — load only after cookie consent, no-op if `NEXT_PUBLIC_META_PIXEL_ID` is unset.
2. **Lead fires:** only after a **successful** contact-form submit (server-confirmed), never on click.
3. **InitiateCheckout fires:** on click of any booking link to Hone — "Book Consultation" / "Book a Free Consultation" / any `href` to `hone.care/book/willow-electrolysis`.
4. **Hone booking-confirmed point:** `app/book/[slug]/actions.ts:754–776` — the `appointments` insert with `status:"confirmed"`, returning `created.id`. Single, unambiguous point; there is no separate "pending" state. Mirror the fire-and-forget hook at `:818` (`recordPractitionerNotification`).
5. **CAPI direct from Hone? YES — preferred.** Hone owns the confirmed event and already has the client email/phone + reliability patterns. The Willow webhook (Phase 4) is a fallback only.
6. **Per-studio config needed:** `meta_pixel_id`, `meta_capi_enabled` (default false), `meta_test_event_code`. The **CAPI token is a GLOBAL server env** (`META_CAPI_TOKEN`) — Hone has no per-studio secret vault (matches `STRIPE_SECRET_KEY`/`RESEND_API_KEY`).
7. **Consent gating:** none exists (only an SMS-delivery checkbox). Must add marketing/tracking consent (booking-form checkbox and/or Willow cookie banner) + a per-studio `meta_capi_enabled` gate; skip + log a safe reason when consent/config absent.
8. **Privacy changes required:** remove the "no advertising cookies" claim, add Meta as a sub-processor (privacy + terms), disclose conversion tracking/retargeting + CAPI, add a booking-form disclosure/consent, counsel review.
9. **Data sent to Meta (minimal):** `event_name:"Schedule"`, `event_time`, `event_id:"hone_booking_{appointment_id}"`, `action_source:"website"`, `event_source_url` (public booking URL), `user_data`: **SHA-256** hashed email + hashed phone, client IP + user-agent (only if lawfully available), `custom_data.service_category`: **generic modality only** (`electrolysis`/`laser`/`consultation`/`other`).
10. **Never sent:** client name, raw email/phone, appointment/booking notes, intake answers, contraindications, allergies, skin notes, fitzpatrick type, body areas, photos, cancellation reasons, treatment parameters, tokens — and **never the free-text service NAME** (for electrolysis it encodes intimate body areas, e.g. "Brazilian"; it is reduced to a generic category).

## Proposed migration (NOT created — approve first)
```sql
-- studios: per-studio Meta config (token stays in global env, not DB)
alter table public.studios
  add column if not exists meta_pixel_id text,
  add column if not exists meta_capi_enabled boolean not null default false,
  add column if not exists meta_test_event_code text;

-- appointments: dedup/idempotency markers, mirroring the email-send-claim pattern
alter table public.appointments
  add column if not exists meta_capi_sent_at       timestamptz,
  add column if not exists meta_capi_send_attempts integer not null default 0,
  add column if not exists meta_capi_claimed_at    timestamptz;
-- + a claim_meta_capi_send(appointment_id) RPC mirroring claim_email_send (0080)
```

## Phase 3 wiring plan (after migration approval)
- `sendMetaScheduleEvent(...)`: claim → build (`lib/conversion/meta-capi.ts`) → POST to `graph.facebook.com/v.../{pixel_id}/events` with a 15s `AbortController` timeout → stamp `meta_capi_sent_at` on success; on failure clear claim + `recordOpsAlert` (warning, redacted). Read `META_CAPI_TOKEN` server-side; **never** to the client bundle/logs.
- Call it as a **fire-and-forget** IIFE right after the appointment insert (mirror `:818`) so ad tracking can never fail or delay a booking.
- Gate: only if `meta_capi_enabled && meta_pixel_id && consent satisfied && token present` — else skip + log a safe reason.

## Willow-site spec (apply in the Willow repo — not present here)
- `NEXT_PUBLIC_META_PIXEL_ID` (public, frontend-safe). No id → the loader no-ops (no script, no error).
- Base Pixel loaded **after cookie consent**; `PageView` on load.
- `Lead` after successful contact submit; `InitiateCheckout` on booking-link click, passing `eventID: "hone_booking_..."` is not possible pre-booking, so generate a client `event_id` for InitiateCheckout only (Schedule dedup happens server-side by appointment id).
- Add a minimal cookie-consent banner; load Pixel only post-consent, OR flag as owner/legal decision before production.
- Privacy page: disclose Meta Pixel + conversion tracking + that booking events may be measured; remove any "no tracking / zero cookies" claim; link to Meta ad-preferences opt-out.

## Env vars
- Hone (server-only): `META_CAPI_TOKEN` (never `NEXT_PUBLIC_`).
- Willow (public): `NEXT_PUBLIC_META_PIXEL_ID`.

## How to test in Meta Events Manager
- Set `meta_test_event_code` (studio) → events land in **Test Events**. Verify the `Schedule` event shows hashed `em`/`ph` (green "processed"), `action_source: website`, and the `event_id` matches `hone_booking_{appointment_id}`. Confirm no `custom_data` beyond `service_category`, and that it is one of `electrolysis`/`laser`/`consultation`/`other`.

## Rollout checklist
1. Owner + Ontario counsel approve the privacy/consent changes.
2. Approve + apply the migration.
3. Wire the sender behind the flag; verify with a test-event code (Test Events tab).
4. Update Hone privacy + terms; add booking-form disclosure/consent.
5. Apply the Willow-site Pixel + consent banner + privacy edits.
6. Enable per studio (`meta_capi_enabled=true`, set `meta_pixel_id`) once consent infra is live.
7. Confirm no clinical/PII fields ever appear in Events Manager payloads.
