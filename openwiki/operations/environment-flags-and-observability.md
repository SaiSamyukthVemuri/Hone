---
type: operations
title: Environment, feature flags and observability
description: The five layers of runtime configuration in Hone (deployment env vars, studio-naming env allowlists, per-studio columns, singleton database switches and explicit arming flags), the build-time production env gates, the variables the code reads (names only), how Sentry, PostHog, ops alerts and conversion tracking are wired and scrubbed, and which controls fail open versus closed.
tags: [configuration, environment, feature-flags, observability, sentry, posthog]
verified:
  - by: openwiki/0.6.1
    at: 2026-10-04T01:59:59.625Z
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
generated: { by: "claude-code", at: "2026-10-04T01:59:59.625Z" }
---

# Environment, feature flags and observability

> This page names variables and flags only. It never records a value, and code defaults are **not** evidence of
> what production sets: whether a variable is set in a given deployment is a production fact that needs a dated
> authority.

## 1. Five layers of configuration

| Layer | Examples | Who changes it | Where it is checked |
|---|---|---|---|
| **Deployment env vars** | Supabase URL and keys, Resend, Twilio, Stripe, Upstash, the cron secret, signing secrets | the deployment environment | read at runtime; some enforced at build (§2) |
| **Env allowlists naming studios** | `NEW_CLIENT_WAITLIST_STUDIO_SLUGS`, `NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS` | the deployment environment | runtime exact membership, superseded per studio by the persisted admission mode (see [New-client admission mode](../waitlist/new-client-admission-mode.md)) |
| **Per-studio columns** | Google Calendar flags, practitioner capacity flags, `onboarding_v2_enabled`, `new_client_admission_mode`, email/SMS/intake reminder toggles, `postcare_delivery_mode`, the retired clinical finalization and corrections flags | owner settings or operator SQL, depending on the flag | the code or SQL command that consumes it ([`lib/types/database.ts` L39-L168](../../lib/types/database.ts#L39-L168)) |
| **Singleton DB switches** | `calendar_sync_control.worker_enabled` | `service_role` only | the claim RPC (see [Google Calendar](../integrations/google-calendar-sync.md)) |
| **Arming flags** (fail closed) | `STRIPE_ALLOW_LIVE_MODE`, `HONE_SMS_PROVISIONING_LIVE`, `HONE_MOBILE_VERIFICATION_LIVE`, the `HONE_E2E_FAKE_*` flags, `HONE_PERF_TIMING` | the deployment environment or the test harness | the module that would otherwise spend money or fake a provider |

Live-provider arming always needs an **explicit** flag in addition to credentials: SMS provisioning
([`lib/sms/provider/index.ts` L23-L48](../../lib/sms/provider/index.ts#L23-L48)) and prospect mobile verification
([`arming.ts` L30-L31](../../lib/waitlist/mobile-verification/arming.ts#L30-L31)) each key on a dedicated `*_LIVE`
flag, and the E2E fakes throw if their flag is set in a deployed runtime.

## 2. Build-time production gates

`npm run build` runs [`scripts/check-production-env-gates.mjs`](../../scripts/check-production-env-gates.mjs) before
`next build` ([`package.json` L7](../../package.json#L7-L7)). It acts **only when `VERCEL_ENV === "production"`** (not
`NODE_ENV`, which every `next build` sets); everywhere else it prints SKIP and exits 0
([L193-L195](../../scripts/check-production-env-gates.mjs#L193-L195), [L360-L372](../../scripts/check-production-env-gates.mjs#L360-L372)).
Every gate prints names, never values, and there is deliberately **no bypass**.

| Gate | Fails the production build when | Lines |
|---|---|---|
| 1 — public rate limiting | the Upstash variables are missing, because runtime limiting fails open and missing config would silently remove abuse protection | [L10-L46](../../scripts/check-production-env-gates.mjs#L10-L46) |
| 2 — critical alert delivery | `OPS_ALERT_EMAILS` does not parse to at least one recipient | [L48-L57](../../scripts/check-production-env-gates.mjs#L48-L57) |
| 3 — Google Calendar config shape | some but not all Google variables are set, the encryption key does not decode to 32 bytes, or the key version is not a positive integer; **all absent passes as dormant** | [L313-L358](../../scripts/check-production-env-gates.mjs#L313-L358) |
| 4 — durable waitlist report | **never**: it reports the durable allowlist as an upper bound only | contract [L59-L82](../../scripts/check-production-env-gates.mjs#L59-L82) |

The gate-4 contract is pinned verbatim by `tests/scripts/check-production-env-gates.test.ts`. Its key sentence for
agents: naming a studio in the durable allowlist activates nothing unless the studio is also in the admission
allowlist, and the report proves neither existence nor activation.

## 3. Variables the code reads (names only)

| Area | Variables |
|---|---|
| Supabase | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` |
| Origin and tokens | `NEXT_PUBLIC_APP_ORIGIN` (falls back to `VERCEL_URL`), `APPOINTMENT_SIGNING_SECRET`, `INTAKE_SIGNING_SECRET`, `PORTAL_FINGERPRINT_SALT`, `CRON_SECRET` |
| Operators | `ADMIN_EMAILS` (fail closed in production), `OPS_ALERT_EMAILS` |
| Email | `RESEND_API_KEY` |
| SMS and verification | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_MESSAGING_SERVICE_SID`, `TWILIO_FROM_NUMBER`, `TWILIO_WEBHOOK_BASE_URL`, `TWILIO_VERIFY_SERVICE_SID`, `HONE_SMS_PROVISIONING_LIVE`, `HONE_MOBILE_VERIFICATION_LIVE` |
| Payments | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, `STRIPE_ALLOW_LIVE_MODE`, `STRIPE_CONNECT_COUNTRY` |
| Google Calendar | `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_TOKEN_ENCRYPTION_KEY`, `GOOGLE_TOKEN_ENCRYPTION_KEY_VERSION` |
| Rate limiting, locks, heartbeat | `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` |
| Analytics and tracking | `NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN`, `NEXT_PUBLIC_POSTHOG_HOST`, `TRACKING_TOKEN_ENCRYPTION_KEY` |
| Waitlist bridges | `NEW_CLIENT_WAITLIST_STUDIO_SLUGS`, `NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS` |
| Diagnostics and harness | `HONE_PERF_TIMING`, `HONE_E2E_*`, `HONE_LOCAL_DB_URL`, `HONE_BASE_BRANCH` |

## 4. Observability

**Sentry.** The server, edge and browser configs initialize with `sendDefaultPii: false` and the deny-by-default
scrubbers from `lib/observability/sentry-scrub.ts` on errors, transactions and breadcrumbs
([`sentry.server.config.ts` L1-L26](../../sentry.server.config.ts#L1-L26)). Session Replay and Sentry Logs are disabled
in the browser, events go through the same-origin `/monitoring` tunnel
([`instrumentation-client.ts` L14-L33](../../instrumentation-client.ts#L14-L33)), and traces are sampled at 0.1 in
production and 1 elsewhere ([`sentry-scrub.ts` L363-L365](../../lib/observability/sentry-scrub.ts#L363-L365)).
Token-bearing paths are canonicalised before transmission (see [Public token routes](../security/public-token-routes-and-privacy.md)).

**PostHog.** The browser client proxies through `/ingest`, disables recording, surveys, exception capture, heatmaps
and web vitals, masks all text, and routes **every** event through `guardBrowserEvent`, which lets out only pageview,
pageleave, autocapture and `marketing:*` events, and only on canonical marketing routes
([`instrumentation-client.ts` L39-L83](../../instrumentation-client.ts#L39-L83),
[`client-boundary.ts` L95-L230](../../lib/analytics/client-boundary.ts#L95-L230)). Authenticated identification is
server-side only, with an opaque id and a coarse role ([`lib/analytics/server.ts` L152-L171](../../lib/analytics/server.ts#L152-L171)).

**Ops alerts.** `recordOpsAlert` writes a structured stderr line and a redacted `ops_alerts` row and emails critical
alerts; it never throws. See [Cron jobs, reminders and idempotency](../communications/cron-reminders-and-idempotency.md#3-failure-visibility).

**Marketing conversion tracking.** `lib/conversion/dispatch.ts` sends a confirmed-booking conversion only with
marketing consent for that booking, an enabled tracking provider, a won dedup claim and the studio's own decrypted
server token; it never throws and sends only a hashed identity and a generic category
([L1-L30](../../lib/conversion/dispatch.ts#L1-L30)). The canonical record says it is deployed but **inert per studio**
([`current-state.md` § 8. Communications](../../docs/production/current-state.md#8-communications)); details are on
[Marketing consent and conversion tracking](../integrations/marketing-consent-and-conversion-tracking.md).

## 5. Fail open versus fail closed

| Control | Posture | Evidence |
|---|---|---|
| Public rate limiting at runtime | **fail open** on missing config or a backend outage | [`lib/rate-limit/public.ts` L16-L24](../../lib/rate-limit/public.ts#L16-L24), [L213-L261](../../lib/rate-limit/public.ts#L213-L261) |
| …the same, at production build | **fail closed** (gate 1) | §2 |
| Critical alert email | a no-op when unset at runtime; the production build fails (gate 2) | §2 |
| Reminder heartbeat, reconcile observability | fail open | the cron and Google Calendar pages |
| `ADMIN_EMAILS` | fail closed in production, with no fallback admin | [`lib/admin.ts` L42-L72](../../lib/admin.ts#L42-L72) |
| Cron secret, Twilio and Stripe webhook secrets | fail closed before any write | the cron, SMS and payments pages |
| E2E provider fakes | refused (they throw) in any deployed runtime | the email, Google and browser-E2E pages |
| Live provisioning and mobile verification | off unless explicitly armed | §1 |

## 6. Contradictions and open questions

1. **`.env.local.example` and `docs/10` omit several variables the runtime reads.** The Google OAuth and
   token-encryption variables, the PostHog project token and host, `TRACKING_TOKEN_ENCRYPTION_KEY`,
   `TWILIO_VERIFY_SERVICE_SID` and the two `*_LIVE` arming flags appear in neither
   [`.env.local.example`](../../.env.local.example) nor [`docs/10_DEPLOYMENT_AND_ENV.md`](../../docs/10_DEPLOYMENT_AND_ENV.md).
2. **The gate-4 contract says "these eight sentences" but numbers nine**
   ([L59-L82](../../scripts/check-production-env-gates.mjs#L59-L82)); the ninth was appended without updating the
   count.
3. **Whether Sentry and PostHog receive events, and whether the PostHog variables are set in the deployment, is
   recorded as unknown** pending verification
   ([`current-state.md` § 13. Operations, alerts and observability](../../docs/production/current-state.md#13-operations-alerts-and-observability));
   nothing in the repository can settle it.
