---
type: security boundary
title: Public token routes and privacy controls
description: The anonymous, token-addressed routes (cancel, reschedule, manage, intake, invitation, portal verify, calendar feed) — how each token is generated and stored, the canonical token-route registry and the privacy headers, Sentry and PostHog scrubbing it drives, generic error collapsing, and the Upstash rate limiters, with fail-open versus fail-closed behaviour stated for every control.
tags: [tokens, privacy, security-headers, rate-limiting, sentry, posthog, public-routes, security]
sources:
  - id: openwiki-source-2cb1f993558f06c74257613f
    resource: repo://app/calendar-feed/%5Btoken%5D/route.ts
  - id: openwiki-source-a70e3f51f72442ad8b8e64bd
    resource: repo://app/cancel/%5Btoken%5D/actions.ts
  - id: openwiki-source-3cd8b2452ec5b6ab26f550db
    resource: repo://app/invitation/%5Btoken%5D/actions.ts
  - id: openwiki-source-d68aea357c28f0ac202cb2f2
    resource: repo://app/manage/%5Btoken%5D/actions.ts
  - id: openwiki-source-428f7e71a4b573a67a7647da
    resource: repo://docs/03_SECURITY_AND_PRIVACY.md
  - id: openwiki-source-72e0e60a94ee9fdc1aea5900
    resource: repo://instrumentation-client.ts
  - id: openwiki-source-08ed42d9f7dabee8e311184f
    resource: repo://lib/analytics/client-boundary.ts
  - id: openwiki-source-8af040e0cb8ee82901db531b
    resource: repo://lib/booking/tokens.ts
  - id: openwiki-source-d451d8591a5b7e9cd2484c48
    resource: repo://lib/calendar-feed/token.ts
  - id: openwiki-source-66ac403a533e942bc169ae26
    resource: repo://lib/intake/tokens.ts
  - id: openwiki-source-db5d1e2ed4ead0cd5a19a5d7
    resource: repo://lib/observability/sentry-scrub.ts
  - id: openwiki-source-58f8bb02c69d54c902b72ae3
    resource: repo://lib/rate-limit/public.ts
  - id: openwiki-source-b69a7904ea9001c13036fec4
    resource: repo://lib/security/headers.ts
  - id: openwiki-source-5ab28d179f0bb68799577796
    resource: repo://lib/security/token-routes.ts
  - id: openwiki-source-9da7d137b9e02e25ab89016d
    resource: repo://lib/waitlist/invite-to-book-contract.ts
  - id: openwiki-source-50a18d054b596a7ed0eeffb0
    resource: repo://next.config.ts
  - id: openwiki-source-479c81b7b82cda7e56624c81
    resource: repo://sentry.server.config.ts
  - id: openwiki-source-45223630631c31978a184106
    resource: repo://supabase/migrations/0116_drop_calendar_feed_raw_token.sql
  - id: openwiki-source-156cccd16ed735df690bfbf3
    resource: repo://supabase/migrations/0192_waitlist_recipient_proof_authority.sql
  - id: openwiki-source-a19286901a6369a24bd2933c
    resource: repo://tests/db/calendar-feed-hash-only.db.test.ts
  - id: openwiki-source-9fed2eddecca1be417ab59d1
    resource: repo://tests/lib/security/token-route-parity.test.ts
  - id: openwiki-source-368da29387b3f22f3051f8b5
    resource: repo://tests/security/waitlist-invitation-route-privacy.test.ts
generated: { by: "claude-code", at: "2026-10-02T22:34:57.394Z" }
verified:
  - by: openwiki/0.6.1
    at: 2026-10-02T22:34:57.394Z
---

# Public token routes and privacy controls

On the routes below, the URL path segment **is** the credential: whoever holds the link holds the authority.
That makes the path itself secret material. It must not:

- leave the browser in a `Referer` header;
- be indexed by a crawler;
- appear in telemetry.

The controls on this page exist for that reason.

Not covered here:

- `/book/<slug>` is **not** a token route; the slug is a public identifier.
- Route behaviour is on [Public booking, reschedule and cancellation](../scheduling/public-booking-reschedule-and-cancellation.md)
  and [Waitlist recipient journey and booking conversion](../waitlist/recipient-journey-and-booking-conversion.md).
- Practitioner and portal sessions are on [Authentication, sessions and tenancy](authentication-sessions-and-tenancy.md).

## 1. The token families

| Route | Credential | Stored as | Lifetime |
|---|---|---|---|
| `/cancel`, `/reschedule`, `/manage` | either a random token (24 bytes) or a stateless HMAC token (see below) | random: only SHA-256 in `appointments.cancellation_token_hash` (`0090`; raw column dropped in `0091`). HMAC: nothing stored | random: until the appointment is no longer eligible. HMAC: its signed `expires_at` |
| `/intake` | HMAC-SHA256 over `{intake_id, expires_at}` | nothing (stateless) | signed `expires_at` |
| `/portal/verify` | 256-bit random token | SHA-256 only | 60 minutes, single use |
| `/calendar-feed` | 32 random bytes, base64url | SHA-256 hex only (`practitioners.calendar_feed_token_hash`) | until rotated |
| `/invitation` | 32 random bytes as 64 hex characters | SHA-256 only (`token_hash`) | the invitation window |

**Appointment tokens.**

- *Random token:* 24 random bytes, base64url, given to the client in the confirmation; only its SHA-256 is
  stored ([`lib/booking/appointment-token.ts` L1-L47](../../lib/booking/appointment-token.ts#L1-L47)).
- *Stateless HMAC token:* `{appointment_id, expires_at}` signed under `APPOINTMENT_SIGNING_SECRET`
  ([`lib/booking/tokens.ts` L1-L60](../../lib/booking/tokens.ts#L1-L60)).
- History: `0090` replaced raw-token lookup with hash lookup, and a compatibility trigger covered the
  deploy window ([`0090` L1-L38](../../supabase/migrations/0090_appointment_token_hash.sql#L1-L38)).

**Intake tokens** use a dedicated `INTAKE_SIGNING_SECRET`. The old fallbacks to the appointment secret and
the service-role key were removed. Verification is timing-safe and rejects an expired payload
([`lib/intake/tokens.ts` L16-L43](../../lib/intake/tokens.ts#L16-L43),
[L64-L116](../../lib/intake/tokens.ts#L64-L116)).

**Calendar-feed tokens** ([`lib/calendar-feed/token.ts` L32-L40](../../lib/calendar-feed/token.ts#L32-L40)):

- `0116` dropped the raw column, so a same-studio peer can no longer read a usable feed URL. Existing
  subscriptions keep working because the route hashes the token in the URL
  ([`0116` L1-L32](../../supabase/migrations/0116_drop_calendar_feed_raw_token.sql#L1-L32)).
- Proved on the migrated schema by
  [`calendar-feed-hash-only.db.test.ts` L14-L49](../../tests/db/calendar-feed-hash-only.db.test.ts#L14-L49).
- The feed itself ([`route.ts` L7-L47](../../app/calendar-feed/[token]/route.ts#L7-L47),
  [L64-L176](../../app/calendar-feed/[token]/route.ts#L64-L176)):
  - shows only busy times — every event is titled "Hone appointment" with a generic description, and the
    route never selects client or service data;
  - excludes cancelled appointments;
  - returns 404 for a short token, an unknown token, an inactive practitioner or any lookup error;
  - is served `private, no-store`.

**Invitation tokens** are minted in SQL and only their SHA-256 is stored
([`0192` L484-L485](../../supabase/migrations/0192_waitlist_recipient_proof_authority.sql#L484-L485)). The raw
token is returned once, so a "resend" must mint a new link
([`invite-to-book-contract.ts` L59-L70](../../lib/waitlist/invite-to-book-contract.ts#L59-L70)).

To book or decline, an invitation holder also needs a **recipient-proof capability**. It is kept in an httpOnly
cookie of the form `<capability>.<expiry>.<hmac>`; the HMAC binds it to the hash of this invitation's token and
to the database's own expiry
([`app/invitation/[token]/actions.ts` L96-L167](../../app/invitation/[token]/actions.ts#L96-L167)).

## 2. One registry, several consumers

`lib/security/token-routes.ts` is the canonical list of token-bearing prefixes
([L26-L56](../../lib/security/token-routes.ts#L26-L56)):

```
/portal/verify  /cancel  /reschedule  /manage  /intake  /calendar-feed  /invitation
```

It also exports:

- **`TOKEN_ROUTE_PATTERNS`** — `prefix/:token*` catch-alls, so suffix segments such as `/intake/<t>/step/2`
  are covered too;
- **a fixed `[Redacted]` placeholder** — deliberately not a hash, fingerprint or truncation, any of which would
  make tokens correlatable or easier to brute-force;
- **`canonicalizeTokenPaths`** ([L58-L107](../../lib/security/token-routes.ts#L58-L107)), which
  matches on the **route**, not the shape of the credential. It also:
  - consumes the query string and fragment;
  - leaves unrelated ids such as `/clients/<id>` intact;
  - never throws and never decodes percent-encoding.

Two consumers import the registry:

- `next.config.ts` builds the privacy-header blocks from it
  ([L87-L104](../../next.config.ts#L87-L104));
- the Sentry scrubber canonicalizes with it before any other redaction
  ([`sentry-scrub.ts` L101-L120](../../lib/observability/sentry-scrub.ts#L101-L120)).

Two tests guard the registry:

- [`token-route-parity.test.ts` L25-L120](../../tests/lib/security/token-route-parity.test.ts#L25-L120) pins
  registry ↔ consumers: both consumers import the registry, all seven families are present and canonicalized,
  and all three Sentry runtimes keep their hooks.
- [`waitlist-invitation-route-privacy.test.ts` L317-L438](../../tests/security/waitlist-invitation-route-privacy.test.ts#L317-L438)
  pins route ↔ registry. It enumerates **every** dynamic route under `app/` and fails unless each one is
  either registered or explicitly classified as non-bearer with a written reason
  ([L54-L70](../../tests/security/waitlist-invitation-route-privacy.test.ts#L54-L70)). A new bearer route
  therefore fails by default instead of slipping past a name filter.

## 3. HTTP headers

**Every route** ([`lib/security/headers.ts` L94-L234](../../lib/security/headers.ts#L94-L234)):

- HSTS for one year with `includeSubDomains` and no `preload`;
- `X-Frame-Options: DENY` and `X-Content-Type-Options: nosniff`;
- `Referrer-Policy: strict-origin-when-cross-origin`;
- a Permissions-Policy that empties every unused capability;
- an **enforced** CSP:
  - `frame-ancestors 'none'` and `object-src 'none'`;
  - `'unsafe-inline'` kept for Next hydration and Tailwind, and `'unsafe-eval'` in development only;
  - `connect-src` limited to `'self'`, the one Supabase host, Stripe and Vercel. PostHog and Sentry go through
    same-origin proxies (`/ingest`, `/monitoring`), so neither host appears in the policy.

**Token routes** add `X-Robots-Tag: noindex, nofollow` and `Referrer-Policy: no-referrer`
([L236-L245](../../lib/security/headers.ts#L236-L245)). That block is declared **after** the global block,
because Next lets the later block's same key win.

## 4. Telemetry scrubbing

**Sentry.** All three runtimes set `sendDefaultPii: false` and install `beforeSend`, `beforeSendTransaction` and
`beforeBreadcrumb` ([`sentry.server.config.ts` L19-L25](../../sentry.server.config.ts#L19-L25)). The scrubber is
deny-by-default:

- **Sensitive keys** — auth and session material, direct identifiers and clinical fields — have their values
  dropped wherever they appear ([`sentry-scrub.ts` L24-L88](../../lib/observability/sentry-scrub.ts#L24-L88)).
- **Every string** first has token paths canonicalized, then emails, JWTs, bearer tokens, Supabase token
  shapes and phone-number runs redacted.
- **Request data** ([L206-L227](../../lib/observability/sentry-scrub.ts#L206-L227)): cookies, headers and the
  query string are deleted, and the URL is canonicalized and stripped of its query and fragment.
- **Console breadcrumbs** are dropped entirely ([L231-L260](../../lib/observability/sentry-scrub.ts#L231-L260)).
- **The user object** loses its email, username and IP address.
- **Sampling:** production performance traces are sampled at 10%; error events are not sampled
  ([L360-L365](../../lib/observability/sentry-scrub.ts#L360-L365)).

**PostHog (browser).** `guardBrowserEvent` is the `before_send` hook and **fails closed by surface and event**
([`lib/analytics/client-boundary.ts` L1-L30](../../lib/analytics/client-boundary.ts#L1-L30),
[L196-L230](../../lib/analytics/client-boundary.ts#L196-L230)):

- An event survives only if `$current_url` is an exact canonical marketing route **and** the event name is on
  the marketing allowlist.
- App, booking, portal, token, login, payment, unknown-route and unparsable-URL events are dropped, not
  redacted.
- Surviving events keep only `utm_*` query parameters and have token segments replaced.

Initialization ([`instrumentation-client.ts` L56-L82](../../instrumentation-client.ts#L56-L82)):

- session recording is disabled;
- exception capture is off (Sentry owns errors);
- autocapture is armed only on marketing URLs.

## 5. Generic errors

Each token surface returns **one** generic message for every non-success, so error shapes cannot be compared to
learn whether an appointment exists or a token is merely expired. Details go only to structured server logs.

Examples:

- `/cancel` collapses malformed, unknown and expired tokens to the same string. A distinct "expired" message was
  removed because it signalled that a structurally valid token existed
  ([`cancel/[token]/actions.ts` L173-L182](../../app/cancel/[token]/actions.ts#L173-L182)).
- `/manage` uses a single message for any failure
  ([`manage/[token]/actions.ts` L15-L21](../../app/manage/[token]/actions.ts#L15-L21)).

## 6. Public rate limiting (Upstash)

`lib/rate-limit/public.ts` has one contract ([L9-L28](../../lib/rate-limit/public.ts#L9-L28)):

- **Fail open.** If the Upstash variables are missing, or the backend throws, the request is allowed. The limiter
  is a cost and abuse dampener, not an authorization control.
- **Missing configuration is logged once per instance** — as an error in production, a warning elsewhere
  ([L70-L100](../../lib/rate-limit/public.ts#L70-L100)).
- **Identifiers are SHA-256 hashed** (truncated) before they reach a Redis key or a log line.
- **Client IP** comes from `x-real-ip`, then the first `x-forwarded-for` hop. Without either, all callers share
  one `unknown_ip` bucket ([L39-L58](../../lib/rate-limit/public.ts#L39-L58)).

| Limiter | Used by | Key | Window |
|---|---|---|---|
| `limitPublicSlots` | slot fetches, invitation slot ranges | `(IP, slug)` | 60 / 60 s ([L206-L225](../../lib/rate-limit/public.ts#L206-L225)) |
| `limitPublicBooking` | `/book` submit | `(IP, slug)`, then `(email, slug)` | 5 / 10 min; 3 / h ([L121-L147](../../lib/rate-limit/public.ts#L121-L147)) |
| `limitTokenRoute` | `/cancel`, `/reschedule`, `/intake` actions; `/manage` reuses the `cancel_view` class | `hash(token):hash(IP)` | 5–60 per class ([L265-L329](../../lib/rate-limit/public.ts#L265-L329)) |
| `limitPortalMagicLink` | `/portal/login` | IP, then email | 5 / 10 min per IP; 3 / h per email |
| marketing form limiters | waitlist and demo forms | IP, email | 5 / h; 2 / day |
| `limitNewClientBookingWaitlist` | new-client waitlist join | studio-scoped IP, email | 5 / h; 3 / day |
| `limitWaitlistProofRequest`, mobile-verification limiters | invitation proof and mobile verification | invitation and studio-scoped IP | from `lib/waitlist/delivery/policy.ts` |

For token routes the limiter runs **before** token verification, so a 429 reveals nothing about the token
([L265-L274](../../lib/rate-limit/public.ts#L265-L274);
[`cancel/[token]/actions.ts` L162-L171](../../app/cancel/[token]/actions.ts#L162-L171)).

The waitlist proof limiter fails open by a written decision, not by habit: failing closed would leave a
prospect unable to get the code their booking needs ([L640-L662](../../lib/rate-limit/public.ts#L640-L662)).

**Not rate-limited:**

- the intake page load, cron routes and the Stripe webhook (listed as deferred);
- the calendar-feed route and the portal verify POST, which import no limiter.

## 7. Fail-open versus fail-closed, per control

| Control | On failure or missing configuration |
|---|---|
| Upstash rate limiters | **open** — the request is allowed and the gap is logged |
| Appointment HMAC token secret | **closed** — `getSecret()` throws, with no fallback to another key ([`tokens.ts` L13-L30](../../lib/booking/tokens.ts#L13-L30)) |
| Intake token secret | **closed** — throws when an intake token is minted or verified |
| Invitation proof cookie secret | **closed** — nothing counts as proven ([`invitation actions` L142-L146](../../app/invitation/[token]/actions.ts#L142-L146)) |
| Calendar-feed lookup error | **closed** — generic 404 |
| Portal session lookup error | **closed** — treated as anonymous |
| PostHog guard: unknown or unparsable URL | **closed** — event dropped |
| Sentry scrubber | **deny by default** — over-redaction is the accepted direction |
| CSP when `NEXT_PUBLIC_SUPABASE_URL` is missing or malformed at build | **wider** — `connect-src` falls back to `*.supabase.co`, still enforced ([`headers.ts` L109-L133](../../lib/security/headers.ts#L109-L133)) |

## 8. Contradictions and open questions

1. **The analytics boundary keeps its own six-prefix token list.**
   - `client-boundary.ts` declares `TOKEN_PATH_PREFIXES` without `/invitation/` and does not import the
     registry ([L40-L49](../../lib/analytics/client-boundary.ts#L40-L49)).
   - The parity test covers only `next.config.ts` and the Sentry scrubber.
   - Invitation-page events are still dropped by the marketing-route gate. The gap is in the defence-in-depth
     token replacement applied to surviving marketing events, which the `no-referrer` header largely covers.
2. **Counts of token families disagree.**
   - The registry header says "six route families"
     ([`token-routes.ts` L3](../../lib/security/token-routes.ts#L3-L3)).
   - `docs/03_SECURITY_AND_PRIVACY.md` lists six families without `/invitation`
     ([§ Token paths are canonicalized before Sentry transmission](../../docs/03_SECURITY_AND_PRIVACY.md#token-paths-are-canonicalized-before-sentry-transmission-f-priv-001)).
   - The code registers seven, and the parity test asserts seven.
3. **The invitation privacy test's header says the route does not exist.** It states "THE ROUTE DOES NOT EXIST
   YET … no prefix is added here"
   ([L17-L20](../../tests/security/waitlist-invitation-route-privacy.test.ts#L17-L20)), but `/invitation` is
   registered and `app/invitation/[token]` exists.
4. **Calendar-feed hashing is described as unfinished.**
   - `docs/03` calls hashed feed-token storage "partially resolved" and says the raw column is kept until a phase
     2 that "is not started" ([§ 8. Known risks and deferred hardening](../../docs/03_SECURITY_AND_PRIVACY.md#8-known-risks-and-deferred-hardening)).
   - `token.ts` still says the settings UI reads and writes the raw token
     ([L21-L26](../../lib/calendar-feed/token.ts#L21-L26)).
   - `0116` dropped the raw column. It sits within the declared hosted migration range, so the feed is hash-only.
5. **"Fail fast at startup" is not what the intake secret does.** The comment says apps without
   `INTAKE_SIGNING_SECRET` fail fast at startup ([L29-L31](../../lib/intake/tokens.ts#L29-L31)), but
   `getSecret()` throws only when a token is minted or verified. A missing secret surfaces on the first intake
   link, not at boot.
6. **Feed tokens and random appointment tokens do not expire on a clock.** A leaked link keeps working until it
   is rotated (feed) or the appointment leaves an eligible state (appointment). Rate limiting does not cover the
   feed.
