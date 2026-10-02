---
type: operational reference
title: Environment, feature flags and observability
description: The five layers of runtime configuration in Hone (environment variables, build-time production gates, per-studio flags, singleton database switches and explicit arming flags), how Sentry, PostHog, ops alerts and conversion tracking are wired and scrubbed, and which controls fail open versus closed.
tags: [environment, feature-flags, production-gates, sentry, posthog, ops-alerts, fail-open]
sources:
  - id: openwiki-source-742d27f08cbeaa9bde84b50c
    resource: repo://.env.local.example
  - id: openwiki-source-723c675bbe2438236148b868
    resource: repo://docs/production/current-state.md
  - id: openwiki-source-72e0e60a94ee9fdc1aea5900
    resource: repo://instrumentation-client.ts
  - id: openwiki-source-08ed42d9f7dabee8e311184f
    resource: repo://lib/analytics/client-boundary.ts
  - id: openwiki-source-5bf9c9b55c669c7a83a29098
    resource: repo://lib/analytics/server.ts
  - id: openwiki-source-f84881648f02ddfcc5db9c53
    resource: repo://lib/conversion/dispatch.ts
  - id: openwiki-source-1a3393d5b86b0fccb573ab62
    resource: repo://lib/google-calendar/token-crypto.ts
  - id: openwiki-source-db5d1e2ed4ead0cd5a19a5d7
    resource: repo://lib/observability/sentry-scrub.ts
  - id: openwiki-source-58f8bb02c69d54c902b72ae3
    resource: repo://lib/rate-limit/public.ts
  - id: openwiki-source-74b3385bf8bca6d43e5d3c56
    resource: repo://lib/sms/provider/index.ts
  - id: openwiki-source-2b13b1e617f9a51af221237a
    resource: repo://lib/types/database.ts
  - id: openwiki-source-c59e6c33e2d7373a9eff1bce
    resource: repo://lib/waitlist/mobile-verification/arming.ts
  - id: openwiki-source-5b54a58d1b51cd490b0e7162
    resource: repo://package.json
  - id: openwiki-source-11833aea63c259e543e18703
    resource: repo://scripts/check-production-env-gates.mjs
  - id: openwiki-source-479c81b7b82cda7e56624c81
    resource: repo://sentry.server.config.ts
generated: { by: "claude-code", at: "2026-10-02T22:34:57.394Z" }
verified:
  - by: openwiki/0.6.1
    at: 2026-10-02T22:34:57.394Z
---

# Environment, feature flags and observability

> This page names variables and flags only. It never records a value, and code defaults are
> **not** evidence of what production sets. Whether a variable is set in a given Vercel
> environment is a production fact that needs a dated authority.

## 1. Five layers of configuration

| Layer | Examples | Who changes it | Where it is checked |
|---|---|---|---|
| **Deployment env vars** | Supabase URL/keys, Resend, Twilio, Stripe, Upstash, cron secret, signing secrets | Vercel environment | read at runtime; some enforced at build (§2) |
| **Env allowlists naming studios** | `NEW_CLIENT_WAITLIST_STUDIO_SLUGS`, `NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS` | Vercel environment | runtime exact-membership ([`lib/booking/new-client-waitlist.ts` L45-L200](../../lib/booking/new-client-waitlist.ts#L45-L200)); superseded per studio by the persisted admission mode — see [New-client admission mode](../waitlist/new-client-admission-mode.md) |
| **Per-studio columns** | Google Calendar flags, `practitioner_capacity_enabled` / `_booking_enabled`, `onboarding_v2_enabled`, `new_client_admission_mode`, email/SMS/intake reminder toggles, `postcare_delivery_mode`, retired `clinical_finalization_enabled` / `clinical_corrections_enabled` | owner settings or operator SQL, depending on the flag | the code or SQL command that consumes it ([`lib/types/database.ts` L39-L168](../../lib/types/database.ts#L39-L168)) |
| **Singleton DB switches** | `calendar_sync_control.worker_enabled` | `service_role` only | the claim RPC (see [Google Calendar](../integrations/google-calendar-sync.md)) |
| **Arming flags** (fail-closed) | `STRIPE_ALLOW_LIVE_MODE`, `HONE_SMS_PROVISIONING_LIVE`, `HONE_MOBILE_VERIFICATION_LIVE`, `HONE_E2E_FAKE_RESEND` / `_GOOGLE` / Stripe fake, `HONE_PERF_TIMING` | Vercel environment / test harness | the module that would otherwise spend money or fake a provider |

Live-provider arming always requires an **explicit** flag in addition to credentials: SMS
provisioning ([`lib/sms/provider/index.ts` L23-L48](../../lib/sms/provider/index.ts#L23-L48)) and
prospect mobile verification ([`lib/waitlist/mobile-verification/arming.ts` L30-L31](../../lib/waitlist/mobile-verification/arming.ts#L30-L31))
both key on a dedicated `*_LIVE` flag; E2E fakes throw if their flag is set in a deployed runtime.

## 2. Build-time production gates

`npm run build` runs [`scripts/check-production-env-gates.mjs`](../../scripts/check-production-env-gates.mjs)
before `next build` ([`package.json` L7](../../package.json#L7-L7)). It acts **only when
`VERCEL_ENV === "production"`** (not `NODE_ENV`, which every `next build` sets); everywhere else it
prints SKIP and exits 0 ([L193-L195](../../scripts/check-production-env-gates.mjs#L193-L195),
[L360-L372](../../scripts/check-production-env-gates.mjs#L360-L372)). Every gate prints names, never
values, and there is deliberately **no bypass**.

| Gate | Fails the production build when | Lines |
|---|---|---|
| 1 — public rate limiting | `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` missing (runtime limiting fails open, so missing config would silently remove abuse protection) | [L10-L46](../../scripts/check-production-env-gates.mjs#L10-L46) |
| 2 — critical alert delivery | `OPS_ALERT_EMAILS` does not parse to ≥ 1 recipient | [L48-L57](../../scripts/check-production-env-gates.mjs#L48-L57) |
| 3 — Google Calendar config shape | some but not all Google vars are set, the encryption key does not decode to 32 bytes, or the key version is not a positive integer; **all absent passes as dormant** | [L313-L358](../../scripts/check-production-env-gates.mjs#L313-L358) |
| 4 — durable waitlist report | **never** fails on the durable allowlist; reports normalised configured entries as an upper bound only | contract [L59-L82](../../scripts/check-production-env-gates.mjs#L59-L82) |

The gate-4 contract is pinned verbatim by
[`tests/scripts/check-production-env-gates.test.ts`](../../tests/scripts/check-production-env-gates.test.ts);
its key sentence for agents: naming a studio in the durable allowlist activates nothing unless the
studio is also in the admission allowlist, and the report proves neither existence nor activation.

## 3. Variables the code reads (names only)

| Area | Variables |
|---|---|
| Supabase | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` |
| Origin / tokens | `NEXT_PUBLIC_APP_ORIGIN` (falls back to `VERCEL_URL`), `APPOINTMENT_SIGNING_SECRET`, `INTAKE_SIGNING_SECRET`, `PORTAL_FINGERPRINT_SALT`, `CRON_SECRET` |
| Operators | `ADMIN_EMAILS` (fail-closed in production), `OPS_ALERT_EMAILS` |
| Email | `RESEND_API_KEY` |
| SMS / verification | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_MESSAGING_SERVICE_SID`, `TWILIO_FROM_NUMBER`, `TWILIO_WEBHOOK_BASE_URL`, `TWILIO_VERIFY_SERVICE_SID`, `HONE_SMS_PROVISIONING_LIVE`, `HONE_MOBILE_VERIFICATION_LIVE` |
| Payments | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, `STRIPE_ALLOW_LIVE_MODE`, `STRIPE_CONNECT_COUNTRY` |
| Google Calendar | `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_TOKEN_ENCRYPTION_KEY`, `GOOGLE_TOKEN_ENCRYPTION_KEY_VERSION` |
| Rate limiting / locks / heartbeat | `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` |
| Analytics / tracking | `NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN`, `NEXT_PUBLIC_POSTHOG_HOST`, `TRACKING_TOKEN_ENCRYPTION_KEY` |
| Waitlist bridges | `NEW_CLIENT_WAITLIST_STUDIO_SLUGS`, `NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS` |
| Diagnostics / harness | `HONE_PERF_TIMING`, `HONE_E2E_*`, `HONE_LOCAL_DB_URL`, `HONE_BASE_BRANCH` |

(Derived by scanning `process.env` reads in `app/`, `lib/`, `scripts/` and root config files, plus
the constant-named reads listed in §1.)

## 4. Observability

### Sentry

Server, edge and browser configs initialise with `sendDefaultPii: false` and the deny-by-default
scrubbers from `lib/observability/sentry-scrub.ts` on errors, transactions and breadcrumbs
([`sentry.server.config.ts` L1-L26](../../sentry.server.config.ts#L1-L26)). Session Replay and
Sentry Logs are disabled in the browser, events go through the same-origin `/monitoring` tunnel
([`instrumentation-client.ts` L14-L33](../../instrumentation-client.ts#L14-L33)), and the traces
sample rate is 0.1 in production and 1 elsewhere
([`sentry-scrub.ts` L363-L365](../../lib/observability/sentry-scrub.ts#L363-L365)). The DSN is
written in the config files rather than read from the environment. Token-bearing paths are
canonicalised before transmission (see [Public token routes](../security/public-token-routes-and-privacy.md)).

### PostHog

The browser client proxies through `/ingest`, disables session recording, surveys, exception
capture, heatmaps and web-vitals, masks all text, and routes **every** event through
`guardBrowserEvent`, which lets only pageview/pageleave/autocapture and `marketing:*` events out,
and only on canonical marketing routes; the app, booking, portal, token, auth and payment surfaces
send nothing from the browser ([`instrumentation-client.ts` L39-L83](../../instrumentation-client.ts#L39-L83);
[`lib/analytics/client-boundary.ts` L95-L230](../../lib/analytics/client-boundary.ts#L95-L230)).
Authenticated identification is server-side only, with an opaque id and coarse role
([`lib/analytics/server.ts` L152-L171](../../lib/analytics/server.ts#L152-L171)).

### Ops alerts

`recordOpsAlert` → structured stderr line + redacted `ops_alerts` row + email for **critical**
severity; it never throws. See [Cron jobs, reminders and idempotency](../communications/cron-reminders-and-idempotency.md#3-failure-visibility-ops-alerts-and-the-scheduler-heartbeat).

### Marketing conversion tracking

`lib/conversion/dispatch.ts` sends a confirmed-booking conversion only when **all** hold: marketing
consent for that booking, an enabled `studio_tracking_providers` row, a won
`(studio, provider, event_id)` dedup claim, and the studio's **own** encrypted server token
decrypting; it never throws and sends only a hashed identity and a generic category
([L1-L30](../../lib/conversion/dispatch.ts#L1-L30)). Per-studio tokens are AES-256-GCM encrypted
under `TRACKING_TOKEN_ENCRYPTION_KEY` (migration `0107`). The canonical record says it is deployed
but **inert per studio** — no studio has configured a provider token
([`current-state.md` § 8. Communications](../../docs/production/current-state.md#8-communications)).
Gates, payload and token handling are detailed in
[Marketing consent and conversion tracking](../integrations/marketing-consent-and-conversion-tracking.md).

## 5. Fail-open vs fail-closed

| Control | Posture | Evidence |
|---|---|---|
| Public rate limiting (runtime) | **fail open** on missing config or backend outage | [`lib/rate-limit/public.ts` L16-L24](../../lib/rate-limit/public.ts#L16-L24), [L213-L261](../../lib/rate-limit/public.ts#L213-L261); [`current-state.md` § 13. Operations, alerts and observability](../../docs/production/current-state.md#13-operations-alerts-and-observability) |
| …same, production build | **fail closed** (gate 1) | §2 |
| Critical alert email | no-op when unset at runtime; build fails in production (gate 2) | §2 |
| Reminder heartbeat, reconcile observability | fail open | cron / Google pages |
| `ADMIN_EMAILS` | fail closed in production (no fallback admin) | [`lib/admin.ts` L42-L72](../../lib/admin.ts#L42-L72) |
| Cron secret, Twilio and Stripe webhook secrets | fail closed (401/403/500 before any write) | cron / SMS / payments pages |
| E2E provider fakes | refused (throw) in any deployed runtime | email / Google / browser-E2E pages |
| Live provisioning / mobile verification | off unless explicitly armed | §1 |

## 6. Contradictions and open questions

1. **`.env.local.example` and `docs/10` omit several variables the runtime reads.**
   `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_TOKEN_ENCRYPTION_KEY`(+`_VERSION`),
   `NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN`, `NEXT_PUBLIC_POSTHOG_HOST`, `TRACKING_TOKEN_ENCRYPTION_KEY`,
   `TWILIO_VERIFY_SERVICE_SID`, `HONE_MOBILE_VERIFICATION_LIVE` and `HONE_SMS_PROVISIONING_LIVE`
   appear in neither [`.env.local.example`](../../.env.local.example) nor
   [`docs/10_DEPLOYMENT_AND_ENV.md`](../../docs/10_DEPLOYMENT_AND_ENV.md); the durable waitlist
   allowlist appears in `docs/10` but not in the example file.
2. **The gate-4 contract says "these eight sentences" but numbers nine**
   ([L59-L82](../../scripts/check-production-env-gates.mjs#L59-L82)); the ninth (durable allowlist
   is subordinate to the admission allowlist) was appended without updating the count.
3. **Whether Sentry and PostHog are receiving events, and whether the PostHog variables are set in
   Vercel, is recorded as unknown** pending verification
   ([`current-state.md` § 13. Operations, alerts and observability](../../docs/production/current-state.md#13-operations-alerts-and-observability)); nothing in
   the repository can settle it.
