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

## Pending production migration: 0095 (PR #279, charting numbing + probe-lot confirm)

- Migration **0095** (`session_blocks.numbing_status` + `probe_lot_confirmed`) is in-tree and CI-verified but **NOT applied to production** until explicitly approved.
- **Ordering matters (different from 0094):** the PR #279 app **writes** these two columns on every charting save, so the columns must exist in prod **before** the new app serves traffic. 0095 is **additive and backward-compatible** — the *current* (pre-#279) app never references the new columns, so 0095 is safe to apply to prod **ahead of merging #279**. **Recommended sequence: apply 0095 to prod first (approved), then merge PR #279.** Merging #279 before 0095 is applied would make charting saves fail in prod (writing to a non-existent column).
- Apply path (when approved): run the read-only preflight in the migration header (both counts 0 before apply) → `supabase db push --linked` for 0095 only → read-only verify both columns + the `session_blocks_numbing_status_check` exist. Legacy rows read as Not recorded / not confirmed.

## Storage / treatment images (PR #271, migration 0092)

- One **private** Supabase Storage bucket: **`treatment-images`** (`public = false`). There are no public buckets and no public URLs.
- Migration 0092 creates the bucket (`insert into storage.buckets (... public=false)`) + the `treatment_images` metadata table + RLS + studio-scoped `storage.objects` policies. The storage statements are wrapped so a platform-permission edge cannot fail the table migration.
  - **Production setup:** apply 0092 with `supabase db push --linked` (migration-first, explicit approval). **Manual fallback** — if the apply emits a notice that the `storage.buckets`/`storage.objects` statements were permission-skipped, create a **private** bucket named `treatment-images` (public OFF) in the Supabase dashboard; the metadata table + RLS apply unconditionally.
- Access is server-side only: uploads + short-TTL signed URLs are minted via the service-role client (`SUPABASE_SERVICE_ROLE_KEY`) inside server actions that first verify the caller's studio owns the row. No new env var is required (signed-URL TTL is a code constant). MIME allowlist: jpeg/png/webp; 15 MB cap; SVG/PDF rejected; server-generated `<studio_id>/<client_id>/<uuid>.<ext>` paths.
- **Hardening (PR #276, migration 0093 — NOT yet applied to production).** Objects are **service-role only**: 0093 drops the authenticated `storage.objects` select/insert policies for `treatment-images`, so members never access objects directly (no env change). 0093 also binds the metadata `storage_bucket`/`storage_path` to the row's own `<studio_id>/<client_id>/<file>.<ext>` shape (CHECK), enforces client/session/block same-studio + freezes identity columns (trigger), and the signer + page pre-signer reject any path they can't bind to the caller's studio+client before signing. **Apply 0093 with `supabase db push --linked` only after explicit approval** (same migration-first discipline as 0092; the same private-bucket manual fallback applies if the wrapped storage statements are permission-skipped). No public URLs; live payments remain disabled.
- **Content validation + EXIF stripping (PR #277, NO migration, NO env change).** Uploads are decoded + re-encoded server-side with **`sharp`** (`lib/images/treatment-image-sanitize.ts`, Node runtime): non-image / fake-MIME / SVG / HEIC / PDF / HTML / corrupt / oversized-pixel files are rejected, and EXIF/GPS/metadata is stripped before the sanitized bytes are stored. **Dependency note:** `sharp@^0.34.5` is now a **direct** dependency (it was already a transitive dep of `next`'s image optimizer and is built on Vercel, so no new native-build/optional-dependency risk; `package-lock.json` change is just the promotion, version unchanged). No new env var; the upload action runs in the Node runtime (no Edge).
- **Tenant consistency constraints (PR #278, migration 0094 — NOT yet applied to production, NO env change).** Adds composite same-studio FKs to clinical/import child tables (`sessions`, `session_blocks`, `client_intake_forms`, `imported_treatment_memories`, `treatment_plans`, `electrolysis_entries`) + parent unique keys. **Apply with `supabase db push --linked` only after explicit approval, and run the read-only preflight first** (the 8 mismatch-count queries embedded in the migration header — every count must be 0; a non-zero count means a real cross-tenant row → STOP). Composite FKs (no triggers); mirrors existing single-FK ON DELETE; non-destructive. No RLS/payment change.

## Stripe

- Connect Express. Pilot studio onboards via the in-app flow from `/settings/payments`.
- Connected-account webhook endpoint: `https://hone.care/api/stripe/webhook`. **Use the connected-account webhook, not the platform webhook.** Earlier confusion between the two caused signature-mismatch failures; the consolidated connected-account webhook is the only correct configuration today.
- Events to enable on the webhook: `account.updated`, `capability.updated`, `setup_intent.succeeded`, `setup_intent.setup_failed`. Other events are received and recorded with `ignoredInPhase1: true` summary.
- API version pinned to `2026-04-22.dahlia` in `lib/stripe/server.ts:STRIPE_API_VERSION`.
- **Live mode is structurally blocked** (`STRIPE_ALLOW_LIVE_MODE` unset / `false` in production). The full readiness review and go/no-go checklist live in [docs/16](./16_LIVE_PAYMENTS_READINESS.md) (PR #168); the **ordered enablement sequence — env flip LAST, after the DB CHECK / claim RPC / runtime guards / webhook are each relaxed** — is [docs/16 §17.12](./16_LIVE_PAYMENTS_READINESS.md#1712-controlled-enablement-sequence--the-ordered-checklist-pr-297-prep-only) (PR #297). **Flipping `STRIPE_ALLOW_LIVE_MODE=true` alone is NOT enough** and will not enable live charging. Until every box is checked, do not flip it and do not rotate keys to `sk_live_*`. See also [docs/06 §3](./06_PAYMENTS_AND_STRIPE.md#3-live-mode-guards).
  - **Payment manual-review queue (PR #290):** the read-only admin page `/admin/payments/manual-review` is **operator-only** (the existing `ADMIN_EMAILS` / `isAdmin` gate — no new env var, no migration) and read-only (no Stripe call, no payment mutation). It surfaces stuck `pending_stripe` attempts + unresolved critical payment alerts for review; it does **not** enable live payments. Reconciliation steps live in docs/16 §17 / docs/11.
  - **Controlled-enablement + reconciliation runbook (PR #282):** the authoritative pre/during/post first-live-payment checklist, the read-only reconciliation SQL queries, and the **rollback plan** live in [docs/16 §17](./16_LIVE_PAYMENTS_READINESS.md#17-payment-reconciliation--controlled-live-payment-readiness-runbook-pr-282). **Rollback if anything looks wrong: set `STRIPE_ALLOW_LIVE_MODE` back to unset/`false`, revert any `sk_live_*` key to `sk_test_*`, pause the charging path, then inspect the admin Ops alerts page + the Stripe dashboard and document the outcome.** PR #282 is readiness/reconciliation only — it does **not** enable live payments or change any Stripe key/env.

## Resend

- Transactional email provider. The from-address pattern is `<Studio name> via Hone <hello@hone.care>` for client mail. Required env var: `RESEND_API_KEY`.

## Twilio

- Off by default per `studios.send_*_sms`. Per-client gated by `sms_consent_at` / `sms_opted_out_at`. STOP webhook at `/api/twilio/inbound-sms` signature-verifies via Twilio's standard validator.
- Either `TWILIO_MESSAGING_SERVICE_SID` (preferred) or `TWILIO_FROM_NUMBER` (E.164) must be set. `TWILIO_WEBHOOK_BASE_URL` should be the public origin Twilio POSTs to (`https://hone.care` in production).

## Upstash Redis

- **Required in production.** Provides the rate-limit token bucket for public surfaces (booking slot fetch + booking submit + magic-link request + token-route fetches + marketing waitlist/demo).
- **Missing config in production = the deploy fails (PR #262, PR #291).** `scripts/check-production-env-gates.mjs` (wired into `npm run build`) fails the Vercel production build when required production env vars are missing, so a misconfigured deploy cannot silently ship. It runs two gates: **(1, PR #262)** `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` (public rate limiting must not be silently disabled); **(2, PR #291)** `OPS_ALERT_EMAILS` (critical ops-alert email delivery must not be silently disabled — the gate fails if it does not parse to ≥1 recipient). Each gate prints its own PASS/FAIL line (variable **NAMES only — never values/addresses**); the build aborts if any fails. Both enforce only when `VERCEL_ENV === "production"`; local/CI/preview builds are a no-op SKIP, so dev needs neither. There is **no emergency bypass**.
- **Transient outage still fails open** (deliberate): once configured, a runtime Upstash outage lets requests through with a throttled `ratelimit_backend_unavailable` alarm — a limiter outage must never block a real booking. The deploy gate is a presence check, so an outage does not trip it.
- Identifiers are hashed before use; no raw IPs or emails are stored, and neither the gate nor the limiter logs env values.

## Cron

**Cron (PR #258).** Every cron route validates `Authorization: Bearer $CRON_SECRET`. The production Vercel plan caps cron cadence at once-per-day, so:

- `/api/cron/materialize-recurring-breaks` — **Vercel Cron** (`vercel.json`, `0 8 * * *`, daily).
- `/api/cron/appointment-reminders` — **external scheduler** (`cron-job.org`), `GET` **every 15 minutes** with `Authorization: Bearer $CRON_SECRET`. A 2h-before reminder needs sub-daily checks and `*/15` exceeds the plan's cron cap, so it is not in `vercel.json`. The 30-min 2h window is covered by the 15-min cadence (see docs/08 for the schedule/window invariant). If the project moves to Vercel Pro, move this into `vercel.json` as `*/15 * * * *` and retire the external job.
- `/api/cron/no-show-check` — intentionally **not** scheduled (disabled stub).

**Reminder scheduler health (PR #265).** Because the every-15-min `/api/cron/appointment-reminders` job runs on the EXTERNAL scheduler (cron-job.org), Vercel's Cron tab gives no visibility into it. Each authorized successful run writes a non-sensitive "last successful run" heartbeat to Upstash (`reminder_cron:last_success`; ISO timestamp + aggregate counts; 24h TTL; best-effort/fail-open). The operator-only **/admin** console shows a **"Reminder scheduler"** card: **healthy** when the last success is within ~45 minutes (3 missed `*/15` cycles), **stale** when older, **missing** when none. If stale/missing: confirm the external scheduler is enabled and calling the route every 15 min with `Authorization: Bearer $CRON_SECRET` (the secret value is never displayed or logged), then check `/admin/ops-alerts` for `cron_route_failed` / `reminder_send_exhausted`.

**Reminder scheduler alerting (PR #283).** The PR #265 card was passive (only seen if an operator opened `/admin`). The **existing daily** `materialize-recurring-breaks` cron now runs a best-effort `recordReminderSchedulerHealthAlert()` that records a **deduped** ops alert when the heartbeat is **stale** (`reminder_scheduler_stale`, warning) or **missing** (`reminder_scheduler_missing`, critical → emails `OPS_ALERT_EMAILS`). No new scheduler/cron/migration; the check never sends reminders and never calls the reminder route. Detection latency is up to ~24h (daily cron); the admin card stays the real-time view. Operators resolve the alert manually after the scheduler is confirmed healthy. Full runbook (failure meanings + operator steps): **docs/08 §"Reminder scheduler alerting + runbook (PR #283)"**.

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
| `OPS_ALERT_EMAILS` | **REQUIRED in production** (comma-separated recipient list) | Read by `lib/ops/alert-email.ts` (since PR #193): every **critical** ops alert (payment / storage / cron / webhook failure) emails these recipients via a bare Resend client, AFTER the durable `ops_alerts` row, never throwing. When unset/empty the email is a silent no-op (once-per-instance warning) and the alert exists only as a DB row + `/admin/ops-alerts`. **PR #291: the production env gate (`scripts/check-production-env-gates.mjs`) fails the production build if `OPS_ALERT_EMAILS` does not list ≥1 recipient** (whitespace-only / comma-only counts as none), so a production deploy cannot silently ship with critical-alert email disabled. **Outside production (local / CI / preview) it is optional** — the gate SKIPs (it keys on `VERCEL_ENV === "production"`). The gate prints variable NAMES only — never the configured addresses. |
| `STRIPE_SECRET_KEY` | Required for any Stripe surface | `sk_test_*` everywhere; `sk_live_*` only when `STRIPE_ALLOW_LIVE_MODE=true` AND not Preview/Development. |
| `STRIPE_ALLOW_LIVE_MODE` | Default `false` | Live-mode gate. Leave unset / `false` until a deliberate live-mode PR. |
| `STRIPE_WEBHOOK_SECRET` | Required | Signing secret from the connected-account webhook in the Stripe dashboard. |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | Required for portal Add-card surface | `pk_test_*` mirrors the secret-key gate; portal renders calm unavailable surface if missing. |
| `STRIPE_CONNECT_COUNTRY` | Default `CA` | Hardcoded for Canadian rollout. |
| `UPSTASH_REDIS_REST_URL` | **Required in production** | Public rate limit. Missing in prod → the production build fails (PR #262 gate). Runtime still fails open on a transient outage. |
| `UPSTASH_REDIS_REST_TOKEN` | **Required in production** | Same. |
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
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | Production **build fails** (PR #262 gate `scripts/check-production-env-gates.mjs`, wired into `npm run build`); a misconfigured deploy cannot ship with public rate limiting silently disabled. Runtime still **fails open** on a transient outage (throttled `ratelimit_backend_unavailable` alarm); the gate is a presence check with no bypass. |

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
- **Stripe-write source gate.** `scripts/check-stripe-gates.mjs` (run in CI + by `scripts/verify-production.mjs`) is a **source-gate/read-only** inventory of every Stripe mutating call: money movement stays **1/1/0/0**, the six non-money writes (`customers.create`, `setupIntents.create`, `accounts.create`, `accountLinks.create`, `accounts.createLoginLink`, browser `confirmSetup`) are exactly-count pinned to their one file each, and any **unknown/unclassified** Stripe write hard-fails. It changes no runtime behavior. Full inventory: [docs/06 §3b](./06_PAYMENTS_AND_STRIPE.md#3b-complete-stripe-write-source-inventory-pr-309).

## Deployment verification (per-PR)

After every merge to the default branch:

1. Poll the Vercel commit status until `state=success`.
2. Confirm the deployment `target=production` and `state=READY` via the Vercel MCP `get_deployment`.
3. Confirm the deployment is aliased to `hone.care` and `www.hone.care`.
4. Run the anonymous smoke checks in [docs/12 §10](./12_SMOKE_TESTS.md#10-security-route-smoke).

If anything looks off, the rollback path is to push the previous commit's SHA forward (revert merge commit + force-deploy). The [docs/11 Runbook](./11_RUNBOOK.md) has the steps.

## Read-only production verification (before live payments)

Before enabling live payments or broadening sensitive-data use, run the **operator-only, read-only** production verification from the production-linked Mac:

```
node --env-file=.env.local scripts/verify-production.mjs
```

It proves remote production matches the repo's required state — migration max **0099** + the 0093/0097/0098/0099 effects, private treatment-image bucket, RLS on the critical tables, zero unresolved critical payment ops alerts, Stripe gates 1/1/0/0, and a fresh reminder heartbeat — printing only PASS/FAIL/INCOMPLETE (no secrets/PII) and exiting non-zero if anything is unverified. It performs **no writes, no migration, no cron, no email, no Stripe writes**, and is **not** a CI gate or a live-payment enablement step. Full runbook + the remaining manual dashboard checks: [docs/16 §17.13](./16_LIVE_PAYMENTS_READINESS.md#1713-read-only-production-verification-pr-308).
