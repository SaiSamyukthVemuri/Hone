# 03 Security and privacy

## 1. Tenant isolation model

Hone is multi-tenant per studio. The unit of isolation is `studio_id`.

- Every studio-scoped table carries a `studio_id` column.
- Every studio-scoped table has RLS enabled.
- The default SELECT policy on those tables is `using (public.is_studio_member(studio_id))`. The helper is `SECURITY DEFINER` and reads from `public.practitioners` to check that the calling auth user is an active practitioner in the row's studio.
- INSERT / UPDATE / DELETE policies are stricter and table-specific. Most are owner-only or service-role-only.
- Cross-studio data sharing does not exist. The same email can be a client of two studios; each studio gets its own `clients` row.

Practitioners belong to exactly one studio. Clients are studio-scoped (`(client_id, studio_id)` unique). Services, appointments, sessions, treatment plans, intake forms, consent templates, signatures, card payment methods, policy acknowledgements, fee attempts; all studio-scoped, all RLS-gated.

## 2. Public route model

| Surface | Public? | What protects it |
|---|---|---|
| `/`, `/pricing`, `/demo`, `/privacy`, `/terms` | Yes | Static marketing content. The waitlist and demo-request forms on these pages submit anonymous server actions that are rate-limited per IP (5/hour) and per normalized email (2/day) via the shared Upstash module, with SHA-256-hashed identifiers and a generic refusal message (PR #187). |
| `/book/<slug>` | Yes | Slug is the studio's public booking identifier (not a token). Rate-limited via Upstash if configured (fails open). Server resolves studio by slug; client is find-or-created with normalized email. |
| `/portal/login` | Yes | Generic-success response regardless of email match (no enumeration). Rate-limited per email + per IP. |
| `/cancel/<token>` | Yes via token | Token IS the credential. See §4. |
| `/reschedule/<token>` | Yes via token | Same. |
| `/manage/<token>` | Yes via token | Same. |
| `/intake/<token>` | Yes via token | Same. |
| `/portal/verify/<token>` | Yes via token | Same. |
| `/calendar-feed/<token>.ics` | Yes via token | Same; carries privacy-collapsed iCal feed for the practitioner's own calendar app. |

### Token routes do not get analytics (PR #142)

Vercel Analytics + Speed Insights are removed from the root layout. Safe trees opt in via `app/_components/SafeAnalytics.tsx`. Token subtrees never opt in. Reason: an analytics script that already loaded on an earlier safe page can capture the URL of a later token page in the same SPA session; a runtime pathname denylist cannot prevent this. The only safe fix is structural absence.

### Token routes carry privacy headers (PR #142)

`next.config.ts` adds these to every token URL prefix:

- `X-Robots-Tag: noindex, nofollow`; keeps the URL out of search indexes even if a link leaks.
- `Referrer-Policy: no-referrer`; strips the token URL from the `Referer` header on any outbound navigation initiated from the page.

Each React-tree token page also exports `metadata.robots = { index: false, follow: false }` as a redundant meta-tag signal. The route handler `/calendar-feed/[token]/route.ts` relies on the header alone (no HTML head).

### Ops alert observability (PR #153)

A new `ops_alerts` table (migration 0067) records durable, append-only rows for operator-facing silent-failure states: manual fee charge needs_manual_review, Stripe webhook processing failures, card-on-file setup failures, email/SMS give-up, cron route failures. The `lib/ops/alerts.ts:recordOpsAlert` helper is the single entry point.

Redaction rules (enforced before any DB insert OR stderr log):

- Keys matching `token`, `raw_token`, `client_secret`, `secret`, `password`, `cookie`, `authorization`, `auth`, `api_key`, `apikey`, `stripe_secret_key`, `private_key`, `card_number`, `pan`, `cvc`, `cvv`, `ssn`, `bearer` are replaced with `[redacted]`.
- Values matching the Stripe secret-key shape (`sk_test_*` / `sk_live_*`), a JWT shape, or a long bearer-token shape (>= 32 alnum/underscore/hyphen, excluding UUIDs) are replaced with `[redacted]` regardless of key name.
- String values longer than 500 chars are truncated with a `...[truncated]` sentinel so a paste-bomb cannot fill the column.
- The helper itself never throws to the caller; DB insert failures are swallowed and surface only as additional structured stderr logs. (Operator email is deferred in PR #153, so there is no email path here to fail.)

RLS posture for `ops_alerts`:

- Studio members read alerts scoped to their studio via `is_studio_member(studio_id)`.
- NULL-studio rows (failures that arrived before lineage was resolved) are visible to service-role queries only.
- No INSERT/UPDATE policy is granted to anon/authenticated; the helper writes via the service-role admin client only.
- No DELETE policy; resolve via `resolved_at` + `resolution_note`.

Operator notification channel: **SQL against `ops_alerts` + Vercel logs** for this PR. Operator email dispatch is deferred to a future PR (the helper deliberately does NOT import `lib/email/send-appointment.ts` to avoid a dependency cycle with the same email subsystem the helper observes). `OPS_ALERT_EMAILS` is reserved in env docs but not read today. See [docs/11_RUNBOOK.md](./11_RUNBOOK.md) for the full SQL recipes and incident workflow.

### Token routes collapse error states

Token resolution failure (malformed / unknown / expired) always returns the same generic message. Comparing response strings cannot reveal whether the token is structurally valid or only expired. The cancel page and the reschedule page both collapse `invalid_token / already_cancelled / not_cancelable` into one public error.

### Global browser security headers (PR #150)

Every route (`/:path*`) now carries an enforced baseline of cross-cutting browser security headers. The token-route privacy block from PR #142 is layered AFTER the global block so it overrides the global `Referrer-Policy` back to `no-referrer` for token subtrees. The header builder is `lib/security/headers.ts` and is unit-tested.

Globally:

- `Strict-Transport-Security: max-age=31536000; includeSubDomains` (the `preload` directive is intentionally omitted from this first baseline; submitting to hstspreload.org is a longer-term commitment and a separate decision)
- `X-Frame-Options: DENY` (and `Content-Security-Policy: frame-ancestors 'none'` for the same reason): no Hone page may be framed by third-party sites. This is the clickjacking protection around portal consent signing, photo-consent allow/deny, card-on-file Stripe Elements, and the manual fee test-charge button.
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: strict-origin-when-cross-origin` (token routes override to `no-referrer`)
- `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), accelerometer=(), gyroscope=(), magnetometer=(), interest-cohort=()`: every browser capability Hone does not currently use is explicitly empty. A future feature that needs camera (e.g. portal photo capture) must deliberately loosen this entry.
- `Content-Security-Policy`: first enforced baseline. Keeps `'unsafe-inline'` for now (Next inline RSC hydration, Tailwind inline styles, Stripe Elements styling). Production excludes `'unsafe-eval'`; development includes it for Next HMR. Allowlisted sources by directive: `script-src https://js.stripe.com https://va.vercel-scripts.com`; `frame-src https://js.stripe.com https://hooks.stripe.com https://m.stripe.network`; `connect-src` carries the specific Supabase project host BOTH as `https://<host>` AND as `wss://<host>` for the realtime websocket (from `NEXT_PUBLIC_SUPABASE_URL` at build), Stripe API surfaces (`api.stripe.com`, `r.stripe.com`, `q.stripe.com`, `m.stripe.network`), and Vercel Analytics + Speed Insights beacons (`va.vercel-scripts.com`, `vitals.vercel-insights.com`); `font-src 'self' data:` (next/font self-hosts the Google fonts at build, so the browser never fetches from `fonts.gstatic.com` at runtime); `frame-ancestors 'none'`; `form-action 'self'`; `object-src 'none'`; `base-uri 'self'`; `upgrade-insecure-requests`.
- No wildcard `*` source. No Sentry domains (Sentry is NOT installed). No `fonts.gstatic.com` / `fonts.googleapis.com`.

What this baseline is **not**:
- Not a nonce-based CSP. A future PR may convert `'unsafe-inline'` to per-request nonces.
- Not a report-only path. A future PR may add `Content-Security-Policy-Report-Only` with a report endpoint before tightening further.
- Not a Sentry-aware policy. CSP sources for Sentry are explicitly excluded; they will be added in the Sentry-install PR if that ships.

## 3. Portal session model

| Step | What happens |
|---|---|
| Client requests magic link at `/portal/login` | `requestPortalMagicLinkAction` rate-limits, generates a 32-byte URL-safe-base64 raw token, SHA-256-hashes it, stores the hash + email + studio binding on `client_portal_magic_links`. Returns the SAME generic success regardless of match. |
| Email arrives | The magic-link URL is `https://hone.care/portal/verify/<raw token>`. Token has a **60-minute TTL** (raised from 30 minutes in PR #166 to absorb real-world email-delivery + click-time latency; see [docs/13](./13_BACKLOG_AND_DECISIONS.md) "Secure-link expiry raised to 1 hour"). The TTL constant lives in `app/portal/login/actions.ts:MAGIC_LINK_TTL_MS` and is the single source of truth; the email body copy in `lib/email/templates/portal-magic-link.ts` is pinned by `tests/lib/email/portal-magic-link.test.ts` so the two cannot drift. |
| GET `/portal/verify/<token>` | **NON-consuming.** Validates the token shape + that the row exists + not consumed + not expired + linked to an active client. Renders Continue button or generic unavailable. Reason: email scanners and link-preview bots fetch the URL before the human clicks; the previous one-step verify burned the token against those bots. |
| POST `/portal/verify/<token>` | **Consuming.** Conditional UPDATE on `consumed_at IS NULL` stamps `consumed_at`. Creates the `hone_portal_session` cookie (httpOnly, secure, SameSite=Lax). Resolves to `(studio_id, client_id)`. |
| Subsequent `/portal/*` reads | Action resolves the session cookie via `getCurrentPortalSession()`. Archived clients are blocked. |

Token storage: the DB only ever holds `hashToken(rawToken)`. A DB compromise does not yield usable tokens. Comparison uses constant-time `crypto.timingSafeEqual` over the 64-char hex strings.

## 4. Stripe / payment safety

- **No raw card data ever lands on Hone.** Stripe Elements collects the card directly in the browser via `stripe.confirmCardSetup` (SetupIntent) for save-card and `stripe.paymentIntents.create({ confirm: true })` (server-side) for charge. Hone reads `brand`, `last4`, `exp_month`, `exp_year`, and the Stripe ids; the PAN and CVC never touch Hone's servers or DB.
- **`client_secret` is never persisted.** It is returned to the browser exactly once for the SetupIntent flow; the portal Stripe Elements form consumes it and discards it. Nothing else reads it.
- **Card is linked to a signed card authorization.** `client_payment_methods.card_authorization_signature_id` is the FK to `client_consent_signatures`. The portal flow refuses to save a card without that signature.
- **Manual fee charge is test-mode only today.** Three guards stack:
  1. `inferStripeLivemode()` short-circuits before any Stripe call.
  2. `assertStripeKeyAllowed()` refuses `sk_live_*` without `STRIPE_ALLOW_LIVE_MODE=true`.
  3. `manual_fee_charge_attempts.stripe_livemode` is CHECK-pinned to `false`. Live-mode requires a deliberate migration replacing this CHECK.
- **Atomic claim before any Stripe call.** `claim_manual_fee_charge_attempt` (PR #146) uses `FOR UPDATE` + conditional UPDATE + idempotency-key stamp in one transaction.
- **Deterministic idempotency key.** `hone:manual-fee:<attempt_id>:v1`. Same attempt always produces the same key. Stripe's 24-hour idempotency replays the response on retry within the window.
- **Pending recovery never blind-retries past safe window.** If a `pending_stripe` row has no PI id and the claim is older than 60 minutes, the action returns `needs_manual_review` rather than retrying. See [docs/06](./06_PAYMENTS_AND_STRIPE.md) §6 for the full state machine.
- **No platform customer / no platform payment method.** Every Stripe call carries `{ stripeAccount }`. Customers and PaymentMethods live on the connected account, not on the platform.

## 5. SMS safety

- **Studio toggle off by default.** `studios.send_*_sms` columns default `false`. SMS only goes out when the studio toggle is `true`.
- **Client consent required.** `clients.sms_consent_at` must be set and `clients.sms_opted_out_at` must be null.
- **STOP webhook handled.** `/api/twilio/inbound-sms` verifies the Twilio signature, idempotently stamps `sms_opted_out_at` on the matching client, and never reveals whether the number was known.
- **SMS RPC grants are service-role only.** PR #141 / migration 0062 revoked `claim_sms_send` and friends from `anon` and `authenticated`. The action layer always invokes them via `createAdminClient()`.
- **Twilio credentials gate the whole subsystem.** Missing `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` makes `sendBookingConfirmationSmsToClient` return `ok:false` cleanly; the booking continues.

## 6. Analytics privacy (PR #142)

- Vercel Analytics + Speed Insights are NOT mounted in `app/layout.tsx`.
- A new `app/_components/SafeAnalytics.tsx` wrapper mounts both together.
- Safe routes opt in: `app/(app)/layout.tsx`, `app/admin/layout.tsx`, `app/book/layout.tsx`, `app/_components/PolicyLayout.tsx` (covers privacy + terms), inline on `app/page.tsx`, `app/pricing/page.tsx`, `app/demo/page.tsx`.
- Token subtrees never opt in. The compiled production bundles confirm: the token-route page chunks (`/cancel/[token]`, `/reschedule/[token]`, `/manage/[token]`, `/intake/[token]`, `/portal/verify/[token]`) have zero matches for `vercel-scripts.com`, `vitals.vercel-insights`, `_vercel/insights`, or `_vercel/speed-insights`. The safe-only chunks (`/_next/static/chunks/3494-*.js`, `(app)/layout-*.js`, `book/layout-*.js`) each carry the analytics URL.
- **Why a pathname denylist is not enough:** the analytics script can already have loaded on a previous safe page in the same SPA navigation. By the time a runtime denylist runs, the script is already in the document and ready to observe the new URL.

## 7. Production config fail-closed (PR #143)

- **`ADMIN_EMAILS`**; production with no/empty `ADMIN_EMAILS` makes `isAdmin()` return `false` for everyone. The previous hardcoded `["samyukth.ssv@gmail.com"]` fallback was removed from the production path; dev still keeps it for convenience. A sanitized one-shot server-side log fires on the missing-env path in prod.
- **`PORTAL_FINGERPRINT_SALT`**; production with no salt makes `hashFingerprint()` return `null` (the diagnostic IP / UA / email-hash columns store null). No constant fallback salt in prod, so a leaked DB yields no usable reverse-lookup table. Portal login does NOT break because fingerprint hashing is diagnostic-only. Dev still has a stable fallback.
- **`NEXT_PUBLIC_APP_ORIGIN`**; `lib/app-origin.ts:getRequiredAppOrigin()` throws in production if neither this nor `VERCEL_URL` is set. No silent fallback to `https://hone.care`. Resolution order: explicit env → `VERCEL_URL` (Preview) → `localhost:3000` (dev only) → throw.

## 8. Known risks and deferred hardening

This is the honest list. Do not hide gaps.

| Risk | Status |
|---|---|
| Email reminder outbox / claim discipline | **Deferred.** The 24h / 2h cron currently dispatches reminders directly. A claim-then-send outbox would prevent double-sends in the rare race; the dispatch path already records attempts but does not lock the row. |
| Hashed `calendar_feed_token` storage | **Partially resolved (PR #182, phase 1).** Migration 0079 added `practitioners.calendar_feed_token_hash` (SHA-256 hex, backfilled); the feed route looks up by hash only and no longer SELECTs the raw column. The raw column is kept for rollout compatibility until phase 2 (settings UI shows the URL only at rotation time, then the raw value is nulled). Phase 2 is not started; do not proceed until real Google/Apple calendar subscriptions are confirmed still polling cleanly after phase 1. |
| Comprehensive automated coverage | **Partial but substantial.** Vitest suite (~1,480 tests as of PR #187) plus the GitHub Actions CI job (`.github/workflows/ci.yml`, PR #154) run typecheck, lint, build, `npm test`, `git diff --check`, and `npm run check:stripe-gates` on every PR. Full Supabase-local DB integration, an RLS policy suite, and browser E2E coverage remain deferred; manual smoke (docs/12) is still the production-readiness check. |
| Real legal review of consent / cancellation / card-authorization wording | **Required before live payment.** Drafts exist in code (`docs/05_CONSENT_AND_FORMS.md`). Enforceability under Ontario law depends on lawyer-reviewed wording. |
| Stripe metadata search for stale pending recovery | **Test mode acceptable today.** PR #146 reconciles within a 60-minute window with the deterministic idempotency key; older pending attempts surface "needs manual review." A live-mode PR must add `paymentIntents.search` by metadata before any blind retry. |
| Receipts / charge notice email | **Built in test mode (PR #175)** for session payments on `payment_charge_attempts`: a receipt email is sent on a successful test charge. Still open for live: content/legal review of the template and a charge notice for the legacy manual-fee path. |
| Refunds / disputes | **Refunds built in test mode (PR #178)**: full-amount, reason-agnostic refunds on `payment_charge_attempts`; the dormant 0032 refund tables remain unused. **Disputes are alert-only (PR #179)**: `charge.dispute.created` fires a critical ops_alert; no automated dispute response exists. |
| Practitioner-recovery card-add path | **Deferred.** `client_payment_methods.added_via` allows `practitioner` but no UI exists for that yet. |
| Two-practitioner studio support | **Not exercised.** Code paths are written studio-scoped, not owner-scoped, but the only pilot is single-practitioner. |
