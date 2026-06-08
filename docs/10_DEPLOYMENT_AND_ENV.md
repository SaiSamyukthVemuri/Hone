# 10 Deployment and environment

## Hosts and domains

- **Hosting:** Vercel.
- **Production domain:** `https://hone.care` (also `https://www.hone.care`).
- **Production branch:** `claude/build-hone-saas-hOex7` (the default branch on GitHub). Every push to this branch triggers a production deploy.
- **Preview deploys:** every PR gets a per-deploy URL like `hone-z2uf-<hash>-samyukthssv-4841s-projects.vercel.app`.

## Supabase

- Project hosts `auth` (magic-link practitioner login), `postgres` (the application database), and `storage` if used.
- The CLI is linked to the project via `supabase link`. Use:
  - `supabase migration list --linked`; diff local vs remote migrations.
  - `supabase db push --linked`; apply locally-staged migrations to prod.
  - `supabase db query --linked "<sql>"`; read-only verification queries. **Do NOT use `db execute`; use `db query`.** See the [Supabase CLI prod-migration path](../README.md) memory.
- Supabase Auth redirect URLs must include:
  - `http://localhost:3000/auth/callback` (dev).
  - `https://hone.care/auth/callback` (prod).

## Stripe

- Connect Express. Pilot studio onboards via the in-app flow from `/settings/payments`.
- Connected-account webhook endpoint: `https://hone.care/api/stripe/webhook`. **Use the connected-account webhook, not the platform webhook.** Earlier confusion between the two caused signature-mismatch failures; the consolidated connected-account webhook is the only correct configuration today.
- Events to enable on the webhook: `account.updated`, `capability.updated`, `setup_intent.succeeded`, `setup_intent.setup_failed`. Other events are received and recorded with `ignoredInPhase1: true` summary.
- API version pinned to `2026-04-22.dahlia` in `lib/stripe/server.ts:STRIPE_API_VERSION`.
- **Live mode is structurally blocked** (`STRIPE_ALLOW_LIVE_MODE` unset / `false` in production). The full readiness review and go/no-go checklist live in [docs/16](./16_LIVE_PAYMENTS_READINESS.md) (PR #168). Until every box in that checklist is checked, do not flip `STRIPE_ALLOW_LIVE_MODE=true` and do not rotate keys to `sk_live_*`. See also [docs/06 §3](./06_PAYMENTS_AND_STRIPE.md#3-live-mode-guards).

## Resend

- Transactional email provider. The from-address pattern is `<Studio name> via Hone <hello@hone.care>` for client mail. Required env var: `RESEND_API_KEY`.

## Twilio

- Off by default per `studios.send_*_sms`. Per-client gated by `sms_consent_at` / `sms_opted_out_at`. STOP webhook at `/api/twilio/inbound-sms` signature-verifies via Twilio's standard validator.
- Either `TWILIO_MESSAGING_SERVICE_SID` (preferred) or `TWILIO_FROM_NUMBER` (E.164) must be set. `TWILIO_WEBHOOK_BASE_URL` should be the public origin Twilio POSTs to (`https://hone.care` in production).

## Upstash Redis

- Optional. Provides the rate-limit token bucket for public surfaces (booking slot fetch + booking submit + magic-link request + token-route fetches).
- **Fails open** when unset or down. A real outage of the limiter must not block a real booking.
- Identifiers are hashed before use; no raw IPs or emails are stored.

## Cron

External scheduler (`cron-job.org`) or Vercel cron. Every cron route validates `Authorization: Bearer $CRON_SECRET`. Active route:

- `/api/cron/appointment-reminders`; every 5 minutes, picks confirmed appointments due in ~24h or ~2h.

## Environment variables

Authoritative source: [`.env.local.example`](../.env.local.example). The summary below mirrors that file.

| Variable | Required? | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Required | Supabase project URL. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Required | Supabase anon key. |
| `SUPABASE_SERVICE_ROLE_KEY` | Required (server) | Service-role key. Never exposed to the client. |
| `NEXT_PUBLIC_APP_ORIGIN` | **Required in production** | Used to build cancel/reschedule/manage/intake/portal URLs in outgoing email + SMS. No silent fallback. See [docs/03 §7](./03_SECURITY_AND_PRIVACY.md#7-production-config-fail-closed-pr-143). |
| `RESEND_API_KEY` | Required for email features | |
| `CRON_SECRET` | Required for `/api/cron/*` | Generate via `openssl rand -hex 32`. |
| `APPOINTMENT_SIGNING_SECRET` | Required | HMAC for legacy cancel/reschedule tokens (column-based tokens are the primary path; HMAC remains the fallback). |
| `INTAKE_SIGNING_SECRET` | Required | HMAC for `/intake/<token>`. |
| `ADMIN_EMAILS` | **Required in production** | Comma-separated allowlist for `/admin`. Production with no/empty value makes `isAdmin()` return false for everyone (PR #143 fail-closed). |
| `PORTAL_FINGERPRINT_SALT` | **Required in production for diagnostics** | Salts SHA-256 of IP / UA / email hashes on `client_portal_magic_links` and `client_consent_signatures`. Missing in production → `hashFingerprint()` returns null; portal login still works (diagnostic-only). |
| `OPS_ALERT_EMAILS` | **Reserved (not read today)** | Reserved for a future PR that adds a standalone `lib/ops/alert-email.ts` using Resend directly with no path back into the appointment email helper. PR #153 ships ops alerting as durable `ops_alerts` rows + structured stderr logs ONLY; operator email dispatch was deferred to avoid a dependency cycle (ops alerts module observing the same email subsystem that would deliver them). Leave unset. SQL against `ops_alerts` (see [docs/11_RUNBOOK.md](./11_RUNBOOK.md)) is the operator surface today. |
| `STRIPE_SECRET_KEY` | Required for any Stripe surface | `sk_test_*` everywhere; `sk_live_*` only when `STRIPE_ALLOW_LIVE_MODE=true` AND not Preview/Development. |
| `STRIPE_ALLOW_LIVE_MODE` | Default `false` | Live-mode gate. Leave unset / `false` until a deliberate live-mode PR. |
| `STRIPE_WEBHOOK_SECRET` | Required | Signing secret from the connected-account webhook in the Stripe dashboard. |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | Required for portal Add-card surface | `pk_test_*` mirrors the secret-key gate; portal renders calm unavailable surface if missing. |
| `STRIPE_CONNECT_COUNTRY` | Default `CA` | Hardcoded for Canadian rollout. |
| `UPSTASH_REDIS_REST_URL` | Optional | Rate limit. Fails open if unset. |
| `UPSTASH_REDIS_REST_TOKEN` | Optional | Same. |
| `TWILIO_ACCOUNT_SID` | Optional | SMS subsystem gated on this. |
| `TWILIO_AUTH_TOKEN` | Optional | Same. |
| `TWILIO_FROM_NUMBER` | Optional | E.164 number. Either this or `TWILIO_MESSAGING_SERVICE_SID` must be set if SMS is in use. |
| `TWILIO_MESSAGING_SERVICE_SID` | Optional | Preferred over `TWILIO_FROM_NUMBER` when both are set. |
| `TWILIO_WEBHOOK_BASE_URL` | Recommended | Public origin Twilio POSTs to. Falls back to `request.url`. |

## Environment behavior matrix

| `NODE_ENV` / `VERCEL_ENV` | Origin resolution | Stripe key allowed |
|---|---|---|
| production / production | `NEXT_PUBLIC_APP_ORIGIN` required (throws if missing) | `sk_test_*` always; `sk_live_*` only with `STRIPE_ALLOW_LIVE_MODE=true` |
| production / preview | `NEXT_PUBLIC_APP_ORIGIN` → `VERCEL_URL` → throw | `sk_test_*` only (live blocked regardless of flag) |
| development | `NEXT_PUBLIC_APP_ORIGIN` → `http://localhost:3000` | `sk_test_*` only |

## Production fail-closed summary

| Variable | Missing in prod → |
|---|---|
| `NEXT_PUBLIC_APP_ORIGIN` | `getRequiredAppOrigin()` throws; any link-generation action 500s. **Visible failure**, not silent wrong-domain. |
| `ADMIN_EMAILS` | `isAdmin()` returns `false` for every caller; `/admin` redirects to `/dashboard`. One-shot sanitized log fires. |
| `PORTAL_FINGERPRINT_SALT` | `hashFingerprint()` returns null; diagnostic columns store null; portal login still works. One-shot sanitized log fires. |
| `CRON_SECRET` | All `/api/cron/*` routes return 401. Cron is effectively disabled. |
| `STRIPE_SECRET_KEY` | `getStripe()` throws when any Stripe surface is hit. |
| `STRIPE_WEBHOOK_SECRET` | Webhook signature verification fails; webhook returns 400. |

## Browser security headers (PR #150)

`next.config.ts` ships a global enforced CSP plus HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, and Permissions-Policy on every route. Token-bearing routes additionally override Referrer-Policy back to `no-referrer` and carry `X-Robots-Tag: noindex, nofollow` (PR #142, preserved).

What the headers depend on for correctness:

- `NEXT_PUBLIC_SUPABASE_URL` must be set at build time. The CSP `connect-src` is scoped to that specific Supabase host BOTH as `https://<host>` AND as `wss://<host>` (the realtime websocket origin). A missing value falls back to `https://*.supabase.co` + `wss://*.supabase.co` (wider than ideal); set the env in every environment.
- If you add a third-party browser integration (Sentry, an analytics provider, a CDN), you must extend the CSP in the same PR. See `lib/security/headers.ts` and [docs/03 § Global browser security headers](./03_SECURITY_AND_PRIVACY.md).
- Local dev over HTTP ignores HSTS. The same enforced CSP applies in dev with one extra source: `'unsafe-eval'` in `script-src` for Next HMR. Production builds do not need it.

## Stripe warnings

- **Test vs live keys.** Vercel Preview and Development environments **MUST** use `sk_test_*` regardless of `STRIPE_ALLOW_LIVE_MODE`. The key-gate enforces this and throws if a live key is presented in those environments.
- **Webhook secret.** The signing secret in `STRIPE_WEBHOOK_SECRET` must match the connected-account webhook (not the platform webhook). A mismatch causes every webhook to return 400 and Stripe will retry until the operator fixes it.
- **Live-mode opt-in.** `STRIPE_ALLOW_LIVE_MODE=true` is the only way `sk_live_*` is accepted. The current production deployment leaves this unset; a live-mode PR is the only place that flips it, and only with the [docs/06 §9](./06_PAYMENTS_AND_STRIPE.md#9-live-charging-requirements) checklist satisfied.

## Deployment verification (per-PR)

After every merge to the default branch:

1. Poll the Vercel commit status until `state=success`.
2. Confirm the deployment `target=production` and `state=READY` via the Vercel MCP `get_deployment`.
3. Confirm the deployment is aliased to `hone.care` and `www.hone.care`.
4. Run the anonymous smoke checks in [docs/12 §10](./12_SMOKE_TESTS.md#10-security-route-smoke).

If anything looks off, the rollback path is to push the previous commit's SHA forward (revert merge commit + force-deploy). The [docs/11 Runbook](./11_RUNBOOK.md) has the steps.
