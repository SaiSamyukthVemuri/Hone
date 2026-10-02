---
type: architecture overview
title: System overview and write-authority model
description: Hone's runtime architecture — Next.js App Router surfaces, the request pipeline in middleware, the three Supabase clients, how the acting studio is resolved, and the two database command patterns that own nearly every write.
tags: [architecture, nextjs, supabase, write-authority, middleware, service-role]
verified:
  - by: openwiki/0.6.1
    at: 2026-10-02T20:08:11.217Z
sources:
  - id: openwiki-source-68534ef1d0ceac2d37e269ce
    resource: repo://app/(app)/layout.tsx
  - id: openwiki-source-501a6ab6bea6a01eaabf9afb
    resource: repo://app/(auth)/login/actions.ts
  - id: openwiki-source-88f734cd106bb34dfb2bb671
    resource: repo://app/admin/layout.tsx
  - id: openwiki-source-9028e95b2ca986c308731fe7
    resource: repo://docs/01_ARCHITECTURE.md
  - id: openwiki-source-074418188d433d183a2d2a90
    resource: repo://lib/admin.ts
  - id: openwiki-source-feb08883a831a8ecfab8898d
    resource: repo://lib/supabase/admin-server.ts
  - id: openwiki-source-f29532dcda137c4bfc1a8b8c
    resource: repo://lib/supabase/middleware.ts
  - id: openwiki-source-bf4a03832f84ac176dc48f73
    resource: repo://lib/supabase/queries.ts
  - id: openwiki-source-2b1c860a5d2152bb5a097349
    resource: repo://lib/supabase/selected-studio.ts
  - id: openwiki-source-9166d99273c429f447e8e564
    resource: repo://middleware.ts
  - id: openwiki-source-50a18d054b596a7ed0eeffb0
    resource: repo://next.config.ts
  - id: openwiki-source-5b54a58d1b51cd490b0e7162
    resource: repo://package.json
  - id: openwiki-source-8b8be5b28e40991c64830be0
    resource: repo://supabase/migrations/0173_appointment_repair_commands.sql
  - id: openwiki-source-f12a840b2f4a93ce89828ca9
    resource: repo://supabase/migrations/0204_new_client_admission_mode.sql
  - id: openwiki-source-21736b3c0410191d83269329
    resource: repo://tests/security/service-role-allowlist.test.ts
  - id: openwiki-source-833044c4d4591cb2eabb5a7e
    resource: repo://tests/security/service-role-allowlist.ts
  - id: openwiki-source-55831e92f29f8b3e9d43f58b
    resource: repo://vercel.json
generated: { by: "claude-code", at: "2026-10-02T20:08:11.217Z" }
---

# System overview and write-authority model

Hone is a single Next.js 15 App Router application (`next` 15.5, React 19) deployed on Vercel,
backed by one Supabase Postgres project that enforces tenancy with Row Level Security and,
increasingly, with `SECURITY DEFINER` *commands* that own each write. Email goes through
Resend, SMS through Twilio's REST API, payments through Stripe Connect, error telemetry
through Sentry and product analytics through PostHog
([`package.json` L35-L57](../../package.json#L35-L57)).

This page explains the shape every subsystem shares. Domain pages
([scheduling](../scheduling/appointment-write-authority.md),
[waitlist](../waitlist/new-client-admission-mode.md),
[treatment memory](../treatment-memory/sessions-blocks-and-entries.md)) assume it.

## 1. Surfaces and who may reach them

| Surface | Location | Identity | Notes |
|---|---|---|---|
<!-- openwiki: broken internal link [../../app/(app] file "../../app/(app" does not exist. Fix the href or restore the target, then delete this comment. -->
| Practitioner app | `app/(app)/**` (dashboard, calendar, clients, records, financials, settings, getting-started) | Supabase Auth session + active practitioner membership | Shell layout calls `requirePractitionerWithStudio()` before rendering anything ([layout L23-L40](../../app/(app)/layout.tsx#L23-L40)) |
| Auth | `app/(auth)/**` (login, callback, accept-invitation, no-access) | anonymous → session | Magic link via `signInWithOtp`; sign-up only for a pending invitation |
| Operator admin | `app/admin/**` (**not** inside the `(app)` group) | Supabase session + `ADMIN_EMAILS` allowlist | Layout redirects non-admins ([`app/admin/layout.tsx` L17-L18](../../app/admin/layout.tsx#L17-L18)) |
| Public booking | `app/book/[slug]` | anonymous; slug is a public identifier | See [public booking](../scheduling/public-booking-reschedule-and-cancellation.md) |
| Token routes | `cancel/`, `reschedule/`, `manage/`, `intake/`, `invitation/`, `portal/verify/`, `calendar-feed/` | the URL token *is* the credential | See [public token routes](../security/public-token-routes-and-privacy.md) |
| Client portal | `app/portal/**` | separate realm: magic link + httpOnly portal session cookie | See [client portal](../portal/client-portal-intake-and-consent.md) |
| Machine endpoints | `app/api/cron/*`, `app/api/stripe/webhook`, `app/api/twilio/inbound-sms`, `app/api/google-calendar/*` | bearer secret / provider signature checked inside the handler | See [cron](../communications/cron-reminders-and-idempotency.md) |
| Marketing | `/`, `/pricing`, `/demo`, `/privacy`, `/terms`, `/features/*`, `/resources/*`, `/electrolysis-software` | anonymous | Exact-path public allowlist |

## 2. Request pipeline (`middleware.ts`)

`middleware.ts` delegates every matched request to `updateSession()`
([middleware L4-L6](../../middleware.ts#L4-L6)). The matcher excludes static assets plus a few
**exact** public files (font licences, the marketing film); the comments explain why a
directory-prefix exclusion would be an auth hole
([L8-L58](../../middleware.ts#L8-L58)).

`updateSession()` in [`lib/supabase/middleware.ts`](../../lib/supabase/middleware.ts):

1. Builds an SSR Supabase client on the **anon key** with request/response cookie plumbing, and
   calls `auth.getUser()` — a real GoTrue round trip that also refreshes the session cookie
   ([L5-L33](../../lib/supabase/middleware.ts#L5-L33)).
2. **Default-deny:** any path not in the explicit public list redirects an anonymous visitor
   to `/login`. The public list is exact paths or narrow prefixes: marketing pages, crawler
   files, the Sentry tunnel `/monitoring`, the PostHog proxy `/ingest`, the token-route
   prefixes, three exact portal paths, `/api/cron/`, and the exact Stripe and Twilio webhook
   paths ([L35-L157](../../lib/supabase/middleware.ts#L35-L157)).
3. **Invite-only gate:** an authenticated user on a non-public path with **zero** active
   practitioner rows goes to `/no-access`; with **2+** rows they must hold a
   `hone_selected_studio` cookie naming one of them, otherwise they go to the studio chooser
   and a stale/forged cookie is deleted. `/admin` paths are exempt from the membership gate
   only for an `isAdmin` email ([L159-L235](../../lib/supabase/middleware.ts#L159-L235)).

Reaching a public path is never authorization: token routes, webhooks and cron handlers each
authenticate inside the handler.

## 3. Identity and the acting studio

Server code never reads the actor or studio from form data. The single resolver lives in
[`lib/supabase/queries.ts`](../../lib/supabase/queries.ts):

- `loadRequestIdentity()` is wrapped in React `cache()` — **one** `getUser()` plus one
  RLS-scoped select of the user's active `practitioners` rows (joined to `studios`) per server
  request; a failed membership read is thrown, never swallowed into "no memberships"
  ([L80-L142](../../lib/supabase/queries.ts#L80-L142)).
- `resolveActivePractitionerMembership()` returns `none` / `one` / `selected` / `choose`; for
  2+ memberships it honours the selected-studio cookie only if it matches an active row and
  never auto-picks a studio ([L144-L165](../../lib/supabase/queries.ts#L144-L165)).
- `requirePractitionerWithStudio()` is the **redirecting** variant used by the app shell;
  `getCurrentPractitionerWithStudio()` is the **throwing** variant used inside server actions,
  whose callers wrap it in try/catch and return a generic denial
  ([L184-L259](../../lib/supabase/queries.ts#L184-L259)).
- The selected-studio cookie stores only a studio id, is httpOnly, and is re-validated against
  live memberships on every call ([`selected-studio.ts` L4-L38](../../lib/supabase/selected-studio.ts#L4-L38)).

Details, including the database side of multi-studio authority, are in
[Authentication, sessions and tenant scoping](../security/authentication-sessions-and-tenancy.md).

## 4. The three Supabase clients

| Client | Factory | Key | Runs as | Used for |
|---|---|---|---|---|
| Browser | [`lib/supabase/client.ts`](../../lib/supabase/client.ts) | anon | `anon`/`authenticated` under RLS | rare client components |
| Server (user-scoped) | [`lib/supabase/server.ts`](../../lib/supabase/server.ts) | anon + session cookies | `authenticated` under RLS | Server Components, reads, authenticated-callable commands |
| Admin (service role) | [`lib/supabase/admin-server.ts`](../../lib/supabase/admin-server.ts) | `SUPABASE_SERVICE_ROLE_KEY` | `service_role`, **bypasses RLS** | service-role-only commands, webhooks, cron, token routes, cross-RLS reads after an explicit scope check |

The admin factory imports `server-only` so any client-bundle import is a build error, and
throws when either env var is missing ([admin-server L1-L27](../../lib/supabase/admin-server.ts#L1-L27)).
Every runtime `createAdminClient()` call site under `app/` and `lib/` must be listed, with a
purpose, an RLS-bypass justification and a scope-guard string that appears in the file, in
[`tests/security/service-role-allowlist.ts`](../../tests/security/service-role-allowlist.ts);
the companion test fails on any new, stale or unjustified entry
([test L49-L116](../../tests/security/service-role-allowlist.test.ts#L49-L116)). That is an
*inventory* gate — it proves a guard symbol is present, not that each query is correctly
scoped ([allowlist L1-L11](../../tests/security/service-role-allowlist.ts#L1-L11)).

## 5. Write authority: who is allowed to change a row

Read paths mostly use the user-scoped client and rely on RLS. **Writes increasingly do not.**
Over migrations `0142`–`0204` the database revoked direct DML from browser roles on the
clinical, appointment and waitlist tables and moved each write into a named command. Two
command shapes dominate:

### Pattern A — service-role-only command with server-asserted actor

The server action resolves `studio.id` and the acting `user_id` with
`getCurrentPractitionerWithStudio()`, then calls the command through the **admin** client.
`EXECUTE` is revoked from `public`, `anon` and `authenticated` and granted to `service_role`
alone, so no browser role can call it; the command then **re-derives** membership and role
from `(studio_id, user_id)` and scopes every row lookup by both id and studio. Example:
the appointment repair commands in migration `0173`
([`0173` L588-L604](../../supabase/migrations/0173_appointment_repair_commands.sql#L588-L604)),
whose allowlist justification spells the contract out
([allowlist entry](../../tests/security/service-role-allowlist.ts#L69-L83)). Waitlist owner
commands, booking commands and the public booking/waitlist commands of `0204` follow the same
shape ([`0204` L785-L792](../../supabase/migrations/0204_new_client_admission_mode.sql#L785-L792)).

### Pattern B — authenticated-callable command that reads `auth.uid()` itself

The command is `SECURITY DEFINER` with a pinned `search_path`, `EXECUTE` is revoked from every
role and re-granted to `authenticated` only, and the function derives the caller's identity
from `auth.uid()` (e.g. via `is_studio_owner`) so nothing the caller passes can influence it.
Example: `set_new_client_admission_mode`
([`0204` L146-L176](../../supabase/migrations/0204_new_client_admission_mode.sql#L146-L176),
[L326-L330](../../supabase/migrations/0204_new_client_admission_mode.sql#L326-L330)). The charting
commands of `0166`/`0167`, the multi-studio commands of `0181` and settlement in `0187` also
grant to `authenticated`.

### What this means for a change

- Adding a write: find the owning command and extend it in a **new** migration; do not add a
  direct `.from(table).update(...)` — guards in `tests/security/` fail on direct DML to
  protected tables (see [RLS, grants and SECURITY DEFINER commands](../security/rls-grants-and-security-definer.md)).
- Adding a service-role call site: add the allowlist entry with a real scope guard.
- Supabase's default privileges grant `EXECUTE` on new functions to `anon`, `authenticated`
  **and** `service_role`; a command must revoke from all three by name before re-granting
<!-- openwiki: broken internal link [../../CLAUDE.md#L284-L288] heading anchor "L284-L288" does not exist in "../../CLAUDE.md". Fix the href or restore the target, then delete this comment. -->
  ([`CLAUDE.md` L284-L288](../../CLAUDE.md#L284-L288)).

## 6. Cross-cutting runtime configuration

[`next.config.ts`](../../next.config.ts):

- **Security headers.** A global header block (CSP, HSTS, frame options) is declared first and a
  stricter token-route block (`Referrer-Policy: no-referrer`, `X-Robots-Tag`) is layered after
  it for every pattern in the shared `TOKEN_ROUTE_PATTERNS` registry; order matters because the
  later block overrides ([L1-L45](../../next.config.ts#L1-L45), [L87-L104](../../next.config.ts#L87-L104)).
- **Same-origin telemetry.** PostHog is reverse-proxied under `/ingest/*`
  ([L67-L85](../../next.config.ts#L67-L85)); Sentry's browser envelope goes through the
  `/monitoring` tunnel, source maps are deleted after upload, and Vercel cron monitors are
  auto-instrumented ([L107-L146](../../next.config.ts#L107-L146)). Both paths are in the
  middleware public list.
- **Server action body limit** raised to 16 MB for treatment-image uploads, and receipt PDF
  fonts force-included in the serverless trace ([L48-L66](../../next.config.ts#L48-L66)).

[`instrumentation.ts`](../../instrumentation.ts) loads the Node or Edge Sentry config and
exports `onRequestError` ([L1-L13](../../instrumentation.ts#L1-L13)). The shell layout
identifies the practitioner to analytics server-side with an opaque id and coarse role only
<!-- openwiki: broken internal link [../../app/(app] file "../../app/(app" does not exist. Fix the href or restore the target, then delete this comment. -->
([layout L42-L45](../../app/(app)/layout.tsx#L42-L45)).

[`vercel.json`](../../vercel.json) registers three Vercel crons — recurring-break
materialization, calendar reconcile and calendar sync ([L1-L16](../../vercel.json#L1-L16)).
The appointment-reminder and no-show routes exist under `app/api/cron/` but are **not** in
`vercel.json`; see [Cron jobs, reminders and idempotency](../communications/cron-reminders-and-idempotency.md).

The production build runs `scripts/check-production-env-gates.mjs` before `next build`
([`package.json` L7](../../package.json#L7)); see
[Environment, feature flags and observability](../operations/environment-flags-and-observability.md).

## 7. Module map (`lib/`)

| Domain | Modules | Wiki page |
|---|---|---|
| Identity / tenancy | `supabase/`, `admin.ts`, `portal/session.ts` | [Auth & tenancy](../security/authentication-sessions-and-tenancy.md) |
| Booking & availability | `booking/` (slots, tz, buffers, horizon, tokens, queries, admission) | [Availability](../scheduling/availability-slots-buffers-and-timezones.md), [Public booking](../scheduling/public-booking-reschedule-and-cancellation.md) |
| Waitlist (WAIT) | `booking/new-client-*`, `booking/waitlist-*`, `waitlist/` | [Admission mode](../waitlist/new-client-admission-mode.md), [Invitation lifecycle](../waitlist/entries-and-invitation-lifecycle.md), [Recipient journey](../waitlist/recipient-journey-and-booking-conversion.md) |
| Treatment memory | `sessions/`, `record-keeping/`, `probes.ts`, `observation-chips.ts`, `imported-treatment-memory.ts`, `search/` | [Sessions & entries](../treatment-memory/sessions-blocks-and-entries.md), [Memory reads](../treatment-memory/memory-reads-and-point-of-care.md), [Probes & record keeping](../treatment-memory/probes-settings-and-record-keeping.md) |
| Messaging | `email/`, `sms/`, `cron/`, `notifications/`, `ops/` | [Email](../communications/email-delivery.md), [SMS](../communications/sms-consent-stop-and-senders.md), [Cron](../communications/cron-reminders-and-idempotency.md) |
| Payments | `stripe/`, `billing/`, `payments/`, `payment-methods/` | [Payments](../payments/stripe-payments-and-settlement.md) |
| Google Calendar | `google-calendar/` | [Google Calendar](../integrations/google-calendar-sync.md) |
| Portal / intake / consent | `portal/`, `portal-messages/`, `intake/`, `consent/` | [Portal & intake](../portal/client-portal-intake-and-consent.md) |
| Owner surfaces | `dashboard/`, `finance/`, `treatment-plans/`, `treatment-time/`, `budget/` | [Dashboard & financials](../owner/dashboard-financials-and-capacity.md) |
| Studio lifecycle / data | `studios/`, `onboarding/`, `export/`, `import/`, `images/` | [Onboarding & data](../studio/onboarding-settings-and-data-portability.md) |
| Security & telemetry | `security/`, `observability/`, `analytics/`, `rate-limit/`, `conversion/` | [Token routes](../security/public-token-routes-and-privacy.md), [Environment](../operations/environment-flags-and-observability.md) |
| Generated types | `types/database.ts` | [Migrations](../operations/migrations-and-hosted-state.md) |

## 8. Contradictions and open questions

1. **`docs/01_ARCHITECTURE.md` describes the middleware as a gate for a list of protected
   paths** ("/dashboard, /calendar, /clients, /settings, /admin, /portal/messages")
<!-- openwiki: broken internal link [../../docs/01_ARCHITECTURE.md#L78-L79] heading anchor "L78-L79" does not exist in "../../docs/01_ARCHITECTURE.md". Fix the href or restore the target, then delete this comment. -->
   ([L78-L79](../../docs/01_ARCHITECTURE.md#L78-L79)). The code is the opposite shape:
   default-deny with an explicit public allowlist
   ([`lib/supabase/middleware.ts` L35-L157](../../lib/supabase/middleware.ts#L35-L157)).
2. **The same doc places the operator admin shell at `app/(app)/admin/`**
<!-- openwiki: broken internal link [../../docs/01_ARCHITECTURE.md#L33] heading anchor "L33" does not exist in "../../docs/01_ARCHITECTURE.md". Fix the href or restore the target, then delete this comment. -->
   ([L33](../../docs/01_ARCHITECTURE.md#L33)); the routes live at `app/admin/**`, outside the
   practitioner route group, with their own `isAdmin` layout guard.
3. **Scheduler ownership is described two ways.** The doc says an external cron service calls
<!-- openwiki: broken internal link [../../docs/01_ARCHITECTURE.md#L15] heading anchor "L15" does not exist in "../../docs/01_ARCHITECTURE.md". Fix the href or restore the target, then delete this comment. -->
   `/api/cron/*` with the bearer secret ([L15](../../docs/01_ARCHITECTURE.md#L15)), while
   `vercel.json` registers three of the cron routes with Vercel Cron. Which scheduler drives the
   reminder and no-show routes is not established by repository code.
4. **The doc's stated rule for service-role RPCs** ("reserved for atomic claim-then-act and
<!-- openwiki: broken internal link [../../docs/01_ARCHITECTURE.md#L92-L105] heading anchor "L92-L105" does not exist in "../../docs/01_ARCHITECTURE.md". Fix the href or restore the target, then delete this comment. -->
   cross-RLS reads", [L92-L105](../../docs/01_ARCHITECTURE.md#L92-L105)) undersells current
   practice: most practitioner write commands added since `0142` are service-role-only and
   called through the admin client (Pattern A above).
