# 01 Architecture

## Runtime stack

- **Next.js 15** App Router on Node 24 (Vercel default). Server Components by default; `"use client"` only where state, refs, or browser APIs are needed.
- **Supabase Postgres** with Row Level Security on every studio-scoped table. Supabase Auth provides magic-link practitioner login. Three Supabase client flavors:
  - `lib/supabase/server.ts`; user-scoped, reads the session cookie. Used by Server Components and most Server Actions.
  - `lib/supabase/admin-server.ts`; service-role. Used by webhook routes, action paths that need to read across RLS for eligibility, and `SECURITY DEFINER` RPCs.
  - Browser client; only used inside `"use client"` components that need real-time or anon reads (rare).
- **Vercel** hosts the app at `https://hone.care`. Production deploys on push to `claude/build-hone-saas-hOex7`. Each PR gets a preview deploy.
- **Stripe Connect** Express. Studios onboard via the connected-account flow; cards are saved through SetupIntents on the connected account. Charges are direct charges on the connected account. **Live-mode charges have been taken in production** (Willow Electrolysis: 6 succeeded, most recent 2026-07-26) — the earlier "test mode only" qualifier is superseded.
- **Resend** for transactional email.
- **Twilio** for SMS (off by default per studio + per client).
- **Upstash Redis** for rate-limiting public surfaces (fails open if unset).
- **External cron** (cron-job.org) calls `/api/cron/*` with `Authorization: Bearer $CRON_SECRET`.

## Folder structure

```
app/
  layout.tsx                  Root layout. NO Analytics here (PR #142).
  page.tsx, pricing/, demo/   Marketing pages.
  privacy/, terms/            Policy pages.
  _components/                Shared UI atoms (footer, OG card, SafeAnalytics, ...).

  (app)/                      AUTHENTICATED practitioner app. Header + footer.
    layout.tsx                Mounts SafeAnalytics (safe tree).
    dashboard/                Today + needs-attention.
    calendar/                 Day/week view, appointment detail, drag chooser.
    clients/                  Client list, profile, intake, sessions.
    settings/                 Profile, studio, services, availability,
                              booking, consent, intake, payments, team, data, launch.
    admin/                    Owner-only read-only admin shell (allowlist-gated).

  (auth)/                     Auth shell (login, callback).
  actions/                    Stand-alone server actions if any.

  book/[slug]/                Public booking by studio slug.
  cancel/[token]/             Public token route. noindex + no-referrer.
  reschedule/[token]/         Public token route. noindex + no-referrer.
  manage/[token]/             Public token route. noindex + no-referrer.
  intake/[token]/             Public token route. noindex + no-referrer.
  portal/                     Client portal (magic-link + session cookie).
    layout.tsx                Two-zone shell.
    login/                    Magic-link request.
    verify/[token]/           Token verify (non-consuming GET, POST consumes).
  calendar-feed/[token]/      Read-only ICS. noindex + no-referrer.
  opengraph-image.tsx         OG card (no analytics).

  api/
    stripe/webhook/           Connected-account webhook (account.updated,
                              capability.updated, setup_intent.succeeded,
                              setup_intent.setup_failed).
    twilio/inbound-sms/       STOP webhook + signature verify.
    cron/                     Cron routes (reminders, etc.).

lib/
  supabase/                   server / admin-server / queries / types.
  stripe/                     server (key gate + getStripe), setup-intent,
                              account, customer.
  booking/                    tokens, queries, tz, policy ack helpers,
                              cancellation reasons.
  billing/                    manual-fee types, eligibility (server-only),
                              charge (server-only).
  portal/                     queries, tokens (raw + hashFingerprint),
                              session.
  email/                      templates + send helpers.
  sms/                        Twilio client + send helpers.
  intake/                     queries.
  treatment-plans/            queries.
  rate-limit/                 public token-bucket via Upstash.
  app-origin.ts               getRequiredAppOrigin (PR #143).
  admin.ts                    isAdmin allowlist (PR #143 fail-closed).

supabase/
  migrations/00NN_*.sql       Schema. Idempotent. Strictly additive.

middleware.ts                 Auth gate for /dashboard, /calendar, /clients,
                              /settings, /admin, /portal/messages.
next.config.ts                Token-route privacy headers (PR #142).
.github/pull_request_template.md   PR checklist (PR #147).
```

## Route group conventions

- `app/(app)/`; every page requires a practitioner session resolved via `getCurrentPractitionerWithStudio()`. Header / footer / SafeAnalytics mounted in the route-group layout.
- `app/(auth)/`; magic-link login, callback.
- `app/book/[slug]/`; public; slug is the studio's public booking identifier (not a bearer token). SafeAnalytics mounted in `app/book/layout.tsx`.
- `app/cancel/[token]/`, `app/reschedule/[token]/`, `app/manage/[token]/`, `app/intake/[token]/`, `app/portal/verify/[token]/`, `app/calendar-feed/[token]/`; public **token routes**. The token IS the credential. SafeAnalytics NOT mounted. `next.config.ts` adds `X-Robots-Tag: noindex, nofollow` and `Referrer-Policy: no-referrer`. Each page also sets `metadata.robots = { index: false, follow: false }`.
- `app/portal/` (other than verify); public landing for magic-link request; the rest of the portal requires a `hone_portal_session` cookie issued by `app/portal/verify/[token]/page.tsx`'s POST.

## Server actions vs RPCs vs RLS

Most mutation logic flows through server actions in `app/.../actions.ts` files. The pattern:

1. `"use server"` at the top of the file.
2. Resolve the actor identity from session cookie at the top of the function. **Never read identity from `formData`.**
3. Validate inputs. Cap text lengths. Reject unknown enum values.
4. Either call Supabase user-scoped client (RLS enforces studio scoping) OR call a `SECURITY DEFINER` RPC through the admin client (RPC enforces its own scoping).
5. Return a typed result the UI can branch on.

Service-role RPCs are reserved for:

- Atomic claim-then-act patterns where a row lock + conditional update + status flip + audit insert must happen in one transaction. Examples: `public_cancel_appointment_with_token`, `practitioner_cancel_appointment`, `claim_stripe_event`, `claim_manual_fee_charge_attempt`.
- Cross-RLS reads where the page-level studio-membership check has already happened.

## End-to-end flow examples

### Public booking creates an appointment

```
client opens /book/<slug>
  -> PublicBookForm renders availability via fetchPublicAvailableSlotsAction
  -> client fills name/email/phone + picks slot
  -> POST -> publicBookAppointmentAction
       resolve studio by slug
       resolve client (find-or-create with email match) via RPC
       generate column-based cancellation_token (random)
       insert appointment via RPC with terminal-safe guards
       insert appointment_audit row
       send confirmation email via Resend (cancel/reschedule/manage links)
       send confirmation SMS via Twilio if studio + client opted in
  -> redirect to thank-you page
```

### Client portal magic-link sign-in

```
visitor opens /portal/login?studio=<slug>
  -> enters email -> requestPortalMagicLinkAction
       email-syntax + rate-limit checks
       resolve studio by slug (or fall through to no-match generic)
       look up active client by normalized email
       single-match only (multi-match returns generic success)
       generate raw token (32-byte URL-safe base64)
       hash with SHA-256, store on client_portal_magic_links
       email magic link via Resend
       return generic success regardless of match (no enumeration)
  -> visitor opens email, clicks link
  -> GET /portal/verify/<token> renders ContinueForm (NON-consuming GET)
  -> POST -> consumes token via conditional UPDATE on consumed_at IS NULL
       creates hone_portal_session cookie (httpOnly, secure)
       redirects to /portal
```

### Test-mode manual fee charge

```
practitioner opens /calendar/<appointment-id>
  -> ManualFeeChargeCard renders if status in {cancelled, no_show}
  -> loads two eligibility snapshots (late_cancel + no_show)
  -> if attempt exists and is 'ready':
       practitioner clicks "Run test charge"
       -> chargeManualFeeAttemptAction
            inferStripeLivemode() must be false
            getManualFeeChargeEligibility re-runs all evidence
            loadCardAndVerifyLineage confirms card/customer/account
            claim_manual_fee_charge_attempt RPC:
              FOR UPDATE row lock
              ready -> pending_stripe
              stamp stripe_idempotency_key = "hone:manual-fee:<id>:v1"
            stripe.paymentIntents.create({
              amount, currency, customer, payment_method,
              confirm: true, off_session: true,
              metadata: { hone_* identity tuple, environment: "test" },
            }, { stripeAccount, idempotencyKey });
            on succeeded:
              UPDATE attempt -> succeeded, charged_at, PI id, charge id
            on StripeCardError:
              UPDATE attempt -> failed, sanitized code + message
            on unknown error AFTER claim:
              leave pending_stripe, return needs_manual_review
```

## Why the architecture chose what it chose

- **Server Components first.** Hone reads a lot of joined data (appointment + client + service + practitioner). Doing the read on the server keeps the page render single-shot and the client bundle small.
- **Service role inside RPCs, not in client code.** Concentrating the powerful client surface in `SECURITY DEFINER` RPCs with explicit grants makes "who can do what" easier to audit. Migration 0033 (pre-Stripe operational hardening) was specifically about moving direct UPDATEs into RPCs.
- **Token routes are physically separated from analytics.** A pathname denylist would not have been safe because the analytics script can already have loaded on a prior page in the same SPA session. PR #142 removed the import from the root layout entirely; safe trees opt in.
- **0032 backend is dormant but installed.** The Stripe Connect schema (charge attempts, refund attempts, audit RPCs) ships idle. Future charge work plugs into the existing structure rather than rebuilding it.
- **Manual fee charge is a parallel narrow table.** The 0032 charge schema is bound to `appointment_payments` (the require-card public-booking flow). For portal-collected cards there is no `appointment_payments` row, so `manual_fee_charge_attempts` (PR #145 + #146) sits parallel and references PR #135's `client_payment_methods` directly. See [docs/06](./06_PAYMENTS_AND_STRIPE.md).
