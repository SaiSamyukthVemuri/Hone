---
type: architecture
title: System overview and write-authority model
description: Hone's runtime architecture — the Next.js App Router surfaces and who may reach them, the default-deny middleware pipeline, how the acting practitioner and studio are resolved once per request, the three Supabase clients and the service-role allowlist, the two SECURITY DEFINER command patterns that own nearly every write, cross-cutting runtime configuration, and a lib/ module map.
tags: [architecture, nextjs, middleware, supabase, write-authority, security-definer]
verified:
  - by: openwiki/0.6.1
    at: 2026-10-04T01:59:59.625Z
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
generated: { by: "claude-code", at: "2026-10-04T01:59:59.625Z" }
---

# System overview and write-authority model

Hone is one Next.js 15 App Router application (React 19) deployed on Vercel and backed by one Supabase
Postgres project. Tenancy is enforced by Row Level Security and, increasingly, by `SECURITY DEFINER`
**commands** that own each write. Email goes through Resend, SMS through Twilio's REST API, payments
through Stripe Connect, error telemetry through Sentry and product analytics through PostHog
([`package.json` L35-L57](../../package.json#L35-L57)).

Every domain page assumes the shape described here.

## 1. Surfaces and who may reach them

| Surface | Location | Identity |
|---|---|---|
| Practitioner app | `app/(app)/**` (dashboard, calendar, clients, records, financials, settings) | Supabase Auth session plus an active practitioner membership; the shell layout calls `requirePractitionerWithStudio()` before rendering (`app/(app)/layout.tsx` L23-L40) |
| Auth | `app/(auth)/**` (login, callback, accept-invitation, no-access) | anonymous to session; magic link, sign-up only for a pending invitation |
| Operator admin | `app/admin/**`, **outside** the `(app)` group | session plus the `ADMIN_EMAILS` allowlist ([`app/admin/layout.tsx` L17-L18](../../app/admin/layout.tsx#L17-L18)) |
| Public booking | `app/book/<slug>` | anonymous; the slug is a public identifier ([Public booking](../scheduling/public-booking-reschedule-and-cancellation.md)) |
| Token routes | `cancel/`, `reschedule/`, `manage/`, `intake/`, `invitation/`, `portal/verify/`, `calendar-feed/` | the URL token is the credential ([Public token routes](../security/public-token-routes-and-privacy.md)) |
| Client portal | `app/portal/**` | a separate realm: magic link plus an httpOnly portal session cookie ([Client portal](../portal/client-portal-intake-and-consent.md)) |
| Machine endpoints | `app/api/cron/*`, `app/api/stripe/webhook`, `app/api/twilio/inbound-sms`, `app/api/google-calendar/*` | a bearer secret or provider signature checked inside the handler ([Cron](../communications/cron-reminders-and-idempotency.md)) |
| Marketing | `/`, `/pricing`, `/demo`, `/privacy`, `/terms`, `/features/*`, `/resources/*` | anonymous, by exact-path allowlist |

## 2. Request pipeline

[`middleware.ts`](../../middleware.ts) hands every matched request to `updateSession()`. Its matcher excludes
static assets and a few **exact** public files (font licences, one marketing film), never a directory
prefix, because a prefix exclusion would be an auth hole ([L1-L58](../../middleware.ts#L1-L58)).

`updateSession()` in [`lib/supabase/middleware.ts`](../../lib/supabase/middleware.ts):

1. builds an SSR Supabase client on the **anon key** with cookie plumbing and calls `auth.getUser()`, a
   real auth round trip that also refreshes the session cookie
   ([L5-L33](../../lib/supabase/middleware.ts#L5-L33));
2. **defaults to deny**: an anonymous request for any path not on the explicit public list is redirected
   to `/login`. The list holds marketing pages, crawler files, the Sentry tunnel `/monitoring`, the
   PostHog proxy `/ingest`, the token-route prefixes, three exact portal paths, `/api/cron/`, and only
   the exact Stripe and Twilio webhook paths ([L35-L157](../../lib/supabase/middleware.ts#L35-L157));
3. **enforces invite-only membership**: an authenticated user on a non-public path with no active
   practitioner row goes to `/no-access`; with two or more rows they need a `hone_selected_studio`
   cookie naming one of them, otherwise they go to the chooser and a stale or forged cookie is deleted.
   `/admin` is exempt from the membership gate only for an `isAdmin` email
   ([L159-L235](../../lib/supabase/middleware.ts#L159-L235)).

Reaching a public path is never authorization: token routes, webhooks and cron handlers authenticate
inside the handler.

## 3. Identity and the acting studio

Server code never takes the actor or studio from form data. The resolver lives in
[`lib/supabase/queries.ts`](../../lib/supabase/queries.ts):

- `loadRequestIdentity()` is wrapped in React `cache()`: **one** `getUser()` and one RLS-scoped select of
  the user's active practitioner rows per server request. A failed membership read is thrown, never
  turned into "no memberships" ([L80-L142](../../lib/supabase/queries.ts#L80-L142)).
- Membership resolution returns `none`, `one`, `selected` or `choose`. With two or more memberships the
  selected-studio cookie is honoured only when it matches an active row, and a studio is never picked
  automatically ([L144-L165](../../lib/supabase/queries.ts#L144-L165)). The cookie holds only a studio
  id, is httpOnly, and is re-validated on every call
  ([`selected-studio.ts` L4-L38](../../lib/supabase/selected-studio.ts#L4-L38)).
- `requirePractitionerWithStudio()` **redirects** and guards the app shell;
  `getCurrentPractitionerWithStudio()` is the variant server actions call, and their callers turn its
  failure into a generic denial ([L184-L259](../../lib/supabase/queries.ts#L184-L259)).

Multi-studio authority on the database side is covered in
[Authentication, sessions and tenancy](../security/authentication-sessions-and-tenancy.md).

## 4. The three Supabase clients

| Client | Factory | Runs as | Used for |
|---|---|---|---|
| Browser | [`lib/supabase/client.ts`](../../lib/supabase/client.ts) | `anon` / `authenticated` under RLS | rare client components |
| Server, user-scoped | [`lib/supabase/server.ts`](../../lib/supabase/server.ts) | `authenticated` under RLS, from session cookies | Server Components, reads, authenticated-callable commands |
| Admin | [`lib/supabase/admin-server.ts`](../../lib/supabase/admin-server.ts) | `service_role`, **bypassing RLS** | service-role-only commands, webhooks, cron, token routes, cross-RLS reads after an explicit scope check |

The admin factory imports `server-only`, so a client-bundle import is a build error, and it throws when
the URL or `SUPABASE_SERVICE_ROLE_KEY` is missing ([L1-L27](../../lib/supabase/admin-server.ts#L1-L27)).

Every runtime `createAdminClient()` call site under `app/` and `lib/` must be listed in
[`tests/security/service-role-allowlist.ts`](../../tests/security/service-role-allowlist.ts) with a purpose,
an RLS-bypass justification and a scope-guard string that appears in the file. The companion test fails on
a new, stale or unjustified entry ([test L49-L116](../../tests/security/service-role-allowlist.test.ts#L49-L116)).
It is an **inventory** gate: it proves a guard symbol is present, not that every query is correctly scoped
([allowlist L1-L11](../../tests/security/service-role-allowlist.ts#L1-L11)).

## 5. Write authority

Reads mostly use the user-scoped client and RLS. **Writes increasingly do not.** Since migration `0142`
the database has revoked direct DML from browser roles on the clinical, appointment and waitlist tables
and moved each write into a named command. Two shapes dominate.

**Pattern A: service-role-only command with a server-asserted actor.** The server action resolves the
studio and acting user with `getCurrentPractitionerWithStudio()` and calls the command through the admin
client. `EXECUTE` is revoked from `public`, `anon` and `authenticated` and granted to `service_role` only,
so no browser role can call it; the command then re-derives membership and role from
`(studio_id, user_id)` and scopes every lookup by both. Examples: the appointment repair commands of
`0173` ([`0173` L588-L604](../../supabase/migrations/0173_appointment_repair_commands.sql#L588-L604)), whose
allowlist entry states the contract ([allowlist L69-L83](../../tests/security/service-role-allowlist.ts#L69-L83)),
and the public waitlist-join and new-client booking commands of `0204`
([`0204` L785-L792](../../supabase/migrations/0204_new_client_admission_mode.sql#L785-L792)).

**Pattern B: authenticated-callable command that reads `auth.uid()` itself.** The command is
`SECURITY DEFINER` with a pinned `search_path`; `EXECUTE` is revoked from every role and re-granted to
`authenticated` only; and the function derives the caller from `auth.uid()` (for example through
`is_studio_owner`), so nothing the caller passes can change who it is. Example:
`set_new_client_admission_mode` ([`0204` L146-L176](../../supabase/migrations/0204_new_client_admission_mode.sql#L146-L176),
[L326-L330](../../supabase/migrations/0204_new_client_admission_mode.sql#L326-L330)). The charting commands
of `0166`/`0167`, the multi-studio commands of `0181` and settlement in `0187` also grant to
`authenticated`.

For a change, this means:

- **Adding a write:** extend the owning command in a **new** migration. Do not add a direct
  `.from(table).update(...)`; the guards in `tests/security/` fail on direct DML to protected tables
  (see [RLS, grants and SECURITY DEFINER commands](../security/rls-grants-and-security-definer.md)).
- **Adding a service-role call site:** add its allowlist entry with a real scope guard.
- **Adding a function:** Supabase's default privileges grant `EXECUTE` to `anon`, `authenticated` and
  `service_role`, so revoke from all three by name before re-granting
  ([`CLAUDE.md` § 5. Production safety](../../CLAUDE.md#5-production-safety)).

## 6. Cross-cutting runtime configuration

[`next.config.ts`](../../next.config.ts):

- **Security headers.** A global block (CSP, HSTS, frame options) comes first, then a stricter
  token-route block (`Referrer-Policy: no-referrer`, `X-Robots-Tag`) for every pattern in the shared
  `TOKEN_ROUTE_PATTERNS` registry. Order matters, because the later block overrides
  ([L1-L45](../../next.config.ts#L1-L45), [L87-L104](../../next.config.ts#L87-L104)).
- **Same-origin telemetry.** PostHog is reverse-proxied under `/ingest/*`
  ([L67-L85](../../next.config.ts#L67-L85)); Sentry's browser envelope goes through the `/monitoring`
  tunnel, source maps are deleted after upload, and Vercel cron monitors are auto-instrumented
  ([L107-L146](../../next.config.ts#L107-L146)).
- **Uploads and traces.** The server-action body limit is 16 MB for treatment-image uploads, and the
  receipt PDF fonts are force-included in the serverless trace ([L48-L66](../../next.config.ts#L48-L66)).

[`vercel.json`](../../vercel.json) registers three Vercel crons: recurring-break materialization, calendar
reconcile and calendar sync ([L1-L16](../../vercel.json#L1-L16)). The appointment-reminder and no-show
routes exist under `app/api/cron/` but are not registered there; see
[Cron jobs, reminders and idempotency](../communications/cron-reminders-and-idempotency.md).

The production build runs `scripts/check-production-env-gates.mjs` before `next build`
([`package.json` L7](../../package.json#L7)); see
[Environment, feature flags and observability](../operations/environment-flags-and-observability.md).

## 7. Module map

| Domain | Modules under `lib/` | Wiki page |
|---|---|---|
| Identity and tenancy | `supabase/`, `admin.ts`, `portal/session.ts` | [Auth and tenancy](../security/authentication-sessions-and-tenancy.md) |
| Booking and availability | `booking/` (slots, tz, buffers, horizon, tokens, admission) | [Availability](../scheduling/availability-slots-buffers-and-timezones.md), [Public booking](../scheduling/public-booking-reschedule-and-cancellation.md) |
| Waitlist | `booking/new-client-*`, `booking/waitlist-*`, `waitlist/` | [Admission mode](../waitlist/new-client-admission-mode.md), [Invitation lifecycle](../waitlist/entries-and-invitation-lifecycle.md), [Recipient journey](../waitlist/recipient-journey-and-booking-conversion.md) |
| Treatment memory | `sessions/`, `record-keeping/`, `probes.ts`, `observation-chips.ts`, `imported-treatment-memory.ts`, `search/`, `clinical-notes/`, `client-pinned-notes/`, `notes/`, `treatment-plans/`, `treatment-time/` | [Sessions and entries](../treatment-memory/sessions-blocks-and-entries.md), [Memory reads](../treatment-memory/memory-reads-and-point-of-care.md), [Probes and record keeping](../treatment-memory/probes-settings-and-record-keeping.md), [Notes](../treatment-memory/clinical-notes-and-client-notes.md), [Plans and time](../treatment-memory/treatment-plans-and-treatment-time.md) |
| Clients | `clients/`, `client-tags/`, `budget/` | [Client records](../clients/client-records-and-profile.md) |
| Messaging | `email/`, `sms/`, `cron/`, `notifications/`, `ops/` | [Email](../communications/email-delivery.md), [SMS](../communications/sms-consent-stop-and-senders.md), [Cron](../communications/cron-reminders-and-idempotency.md) |
| Payments | `stripe/`, `billing/`, `payments/`, `payment-methods/` | [Payments](../payments/stripe-payments-and-settlement.md), [Card on file and checkout](../payments/card-on-file-checkout-and-payment-proof.md) |
| Google Calendar | `google-calendar/` | [Google Calendar](../integrations/google-calendar-sync.md) |
| Portal, intake, consent | `portal/`, `portal-messages/`, `intake/`, `consent/` | [Portal](../portal/client-portal-intake-and-consent.md), [Intake forms](../portal/intake-forms-review-and-assisted-intake.md) |
| Owner surfaces | `dashboard/`, `finance/` | [Dashboard and financials](../owner/dashboard-financials-and-capacity.md) |
| Studio lifecycle and data | `studios/`, `onboarding/`, `export/`, `import/`, `images/` | [Onboarding and data](../studio/onboarding-settings-and-data-portability.md) |
| Security and telemetry | `security/`, `observability/`, `analytics/`, `rate-limit/` | [Token routes](../security/public-token-routes-and-privacy.md), [Environment](../operations/environment-flags-and-observability.md) |
| Marketing and conversion | `conversion/`, `booking/marketing-consent.ts` | [Conversion tracking](../integrations/marketing-consent-and-conversion-tracking.md) |
| Generated types | `types/database.ts` | [Migrations](../operations/migrations-and-hosted-state.md) |

Shared React components live in `components/`; see
[UI components and interaction standards](ui-components-and-interaction-standards.md).

## 8. Contradictions and open questions

1. **`docs/01_ARCHITECTURE.md` describes middleware as a gate for a list of protected paths**
   ("/dashboard, /calendar, /clients, /settings, /admin, /portal/messages")
   ([§ Folder structure](../../docs/01_ARCHITECTURE.md#folder-structure)). The code has the opposite shape:
   default-deny with an explicit public allowlist.
2. **The same document places the operator admin shell at `app/(app)/admin/`**, while the routes live at
   `app/admin/**`, outside the practitioner route group, behind their own `isAdmin` layout guard.
3. **Scheduler ownership is described two ways.** The document says an external cron service calls
   `/api/cron/*` with the bearer secret ([§ Runtime stack](../../docs/01_ARCHITECTURE.md#runtime-stack)),
   while `vercel.json` registers three cron routes with Vercel Cron. Repository code does not establish
   which scheduler drives the reminder and no-show routes.
4. **The document's rule for service-role RPCs** ("reserved for atomic claim-then-act and cross-RLS
   reads", [§ Server actions vs RPCs vs RLS](../../docs/01_ARCHITECTURE.md#server-actions-vs-rpcs-vs-rls))
   undersells current practice: most practitioner write commands added since `0142` are service-role-only
   and called through the admin client (Pattern A).
