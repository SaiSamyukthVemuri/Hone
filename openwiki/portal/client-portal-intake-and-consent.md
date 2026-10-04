---
type: product surface
title: Client portal, intake and consent
description: The client-facing realm — magic-link portal sessions kept separate from practitioner auth, what a client can do in the portal (messages, consent, card on file, rebook through the locked public appointment command), the intake integrity boundaries enforced in the database, the single consent-signing ceremony with render-time integrity, treatment-consent launch readiness, and the archived-client redirect loop.
tags: [portal, intake, consent, magic-link, sessions, client-facing]
verified:
  - by: openwiki/0.6.1
    at: 2026-10-04T01:59:59.625Z
sources:
  - id: openwiki-source-4b52e45d5796f3bdcf32b71a
    resource: repo://app/(app)/clients/%5Bid%5D/actions.ts
  - id: openwiki-source-97a31c4c4661ae8c903844ee
    resource: repo://app/portal/login/actions.ts
  - id: openwiki-source-e4f7d4f9b1e935f7878e2338
    resource: repo://app/portal/login/page.tsx
  - id: openwiki-source-91ff83de371c7a543a54f652
    resource: repo://app/portal/page.tsx
  - id: openwiki-source-41d43091b364ff179c35cd0e
    resource: repo://app/portal/rebook-actions.ts
  - id: openwiki-source-f9116f0674b76f2685a840b3
    resource: repo://app/portal/verify/%5Btoken%5D/actions.ts
  - id: openwiki-source-723c675bbe2438236148b868
    resource: repo://docs/production/current-state.md
  - id: openwiki-source-038c6c17ac5c506386a2469a
    resource: repo://e2e/portal-rebook.spec.ts
  - id: openwiki-source-1d5420d07b8aa9776897cd4b
    resource: repo://lib/consent/launch-readiness.ts
  - id: openwiki-source-ab231e2e85afb96c583b0e54
    resource: repo://lib/consent/sign-consent-form.ts
  - id: openwiki-source-893c9604c5912af64b07a822
    resource: repo://lib/intake/consent-gate.ts
  - id: openwiki-source-66ac403a533e942bc169ae26
    resource: repo://lib/intake/tokens.ts
  - id: openwiki-source-e65da206b9c2f6871acfa78c
    resource: repo://lib/portal/magic-link.ts
  - id: openwiki-source-c81dac9e66fd3d508722e963
    resource: repo://lib/portal/queries.ts
  - id: openwiki-source-098ed071339a3e574b25fc7a
    resource: repo://lib/portal/session.ts
  - id: openwiki-source-f29532dcda137c4bfc1a8b8c
    resource: repo://lib/supabase/middleware.ts
  - id: openwiki-source-5bb8e2602fc26e7e6730c8bd
    resource: repo://supabase/migrations/0111_client_portal_access_events.sql
  - id: openwiki-source-6c94cd2cd0093a464a56c749
    resource: repo://supabase/migrations/0118_intake_terminal_immutability.sql
  - id: openwiki-source-debfc88787526297ebd849a2
    resource: repo://supabase/migrations/0162_intake_review_transition_integrity.sql
  - id: openwiki-source-4add6efc429e6572565d3953
    resource: repo://supabase/migrations/0163_revoke_authenticated_intake_insert.sql
  - id: openwiki-source-3950fa52e945b1a52c5c92c2
    resource: repo://tests/db/intake-review-db-boundary.db.test.ts
  - id: openwiki-source-ae09df3b0cc01b9410bed044
    resource: repo://tests/db/portal-rebook-booking.db.test.ts
  - id: openwiki-source-90604b03722f75eefc23a600
    resource: repo://tests/lib/consent/launch-readiness.test.ts
generated: { by: "claude-code", at: "2026-10-04T01:59:59.625Z" }
---

# Client portal, intake and consent

Clients never hold a Supabase Auth account. They reach Hone through **bearer links** (intake, cancel/reschedule/manage,
waitlist invitation) and through the **client portal**, a separate realm with its own session cookie. Every client
surface resolves `(studio_id, client_id)` server-side and acts through the service-role client with explicit scoping.

## 1. Portal sign-in and session

- **Magic link.** A 256-bit random token, stored only as a SHA-256 hash, single-use, with a **60-minute** TTL and bound
  to one studio's one client; the raw token appears only in the emailed URL
  ([`lib/portal/magic-link.ts` L10-L26](../../lib/portal/magic-link.ts#L10-L26)).
- **No enumeration.** The public request form returns the same generic success whether the address belongs to an
  active client, an archived client or nobody, and pads every branch to a uniform response-time floor
  ([`app/portal/login/actions.ts` L56-L80](../../app/portal/login/actions.ts#L56-L80)).
- **Verify.** `GET /portal/verify/<token>` is non-consuming, because email scanners and link-preview bots prefetch
  links; only the form `POST` consumes the token, with a conditional update on `consumed_at` being null, so concurrent
  posts resolve to one session ([portal verify action L9-L30](../../app/portal/verify/[token]/actions.ts#L9-L30)).
- **Session.** An httpOnly, `sameSite=lax`, secure-in-production `hone_portal_session` cookie holds a raw token whose
  SHA-256 is stored in `client_portal_sessions` (migration `0052`), with a **7-day** TTL. Every portal page resolves it
  server-side by hash, rejecting expired or revoked rows, and a lookup failure is treated as anonymous
  ([`lib/portal/session.ts` L1-L90](../../lib/portal/session.ts#L1-L90)). Portal sessions never grant practitioner
  access, and practitioner sessions never grant portal access.
- **Middleware.** Exactly `/portal`, `/portal/login` and `/portal/verify/*` pass the practitioner-auth middleware as
  portal routes; any new portal route must add its own portal-session check and its own entry, and a forgotten entry
  falls back to the practitioner login redirect
  ([`lib/supabase/middleware.ts` L108-L128](../../lib/supabase/middleware.ts#L108-L128); see
  [System overview](../architecture/system-overview.md)).
- **Access log.** `client_portal_access_events` (migration `0111`) is append-only for app users: a single studio-scoped
  SELECT policy, inserts only from the service-role send and verify paths, a composite same-studio foreign key, and no
  column for tokens, URLs, IP addresses, user agents or email addresses
  ([`0111` L1-L24](../../supabase/migrations/0111_client_portal_access_events.sql#L1-L24)).

## 2. What a client can do in the portal

Messages and replies to the studio (migrations `0053`–`0055`), consent signing, card-on-file setup through a Stripe
SetupIntent (see [Card on file, checkout and payment proof](../payments/card-on-file-checkout-and-payment-proof.md)),
and **rebook**.

Rebook calls the same locked `create_public_appointment` command as public booking, with studio and client both taken
from the portal session, never from the request body
([`rebook-actions.ts` L73](../../app/portal/rebook-actions.ts#L73-L73),
[L574-L580](../../app/portal/rebook-actions.ts#L574-L580)). The database suite proves the appointment is bound to the
exact client and studio passed, the audit row is written in the same transaction, duration comes from the service row,
and cross-studio combinations are refused
([`portal-rebook-booking.db.test.ts` L168-L262](../../tests/db/portal-rebook-booking.db.test.ts#L168-L262)). See
[Appointment write authority](../scheduling/appointment-write-authority.md).

## 3. Intake integrity boundaries

The public `/intake/<token>` flow, the question and answer model, review flags, practitioner-assisted intake and link
resend/reissue are on [Intake forms, review and assisted intake](intake-forms-review-and-assisted-intake.md). The
integrity boundaries:

- **Links** are HMAC-SHA256-signed `{intake_id, expires_at}` payloads under a dedicated `INTAKE_SIGNING_SECRET` with
  **no fallback** to other secrets ([`lib/intake/tokens.ts` L1-L45](../../lib/intake/tokens.ts#L1-L45)). Reminder emails
  mint a fresh link per send for the same intake row (see
  [Cron jobs and reminders](../communications/cron-reminders-and-idempotency.md)).
- **Terminal immutability (`0118`).** Once an intake is submitted or reviewed, an authenticated member can no longer
  change its answers or status; corrections create a new intake. The trigger exempts `service_role` writes, so the
  server paths enforce `in_progress` in code
  ([`0118` L1-L25](../../supabase/migrations/0118_intake_terminal_immutability.sql#L1-L25)).
- **Review transition (`0162`).** `reviewed` is reachable only from a genuinely submitted row, by the caller's own
  active practitioner in that studio, at a database-stamped time
  ([`0162` L1-L25](../../supabase/migrations/0162_intake_review_transition_integrity.sql#L1-L25); proved in
  [`intake-review-db-boundary.db.test.ts` L130-L270](../../tests/db/intake-review-db-boundary.db.test.ts#L130-L270)).
- **No authenticated INSERT (`0163`).** This closes the residual in which a member could insert a row that was already
  `reviewed` with a forged timestamp
  ([`0163` L1-L25](../../supabase/migrations/0163_revoke_authenticated_intake_insert.sql#L1-L25)).

## 4. Consent and signatures

- **One ceremony.** [`lib/consent/sign-consent-form.ts`](../../lib/consent/sign-consent-form.ts#L1-L50) is the only
  signing implementation. It looks the template up by id, studio, `is_live` and `status`; compares the canonical hash of
  what the client was shown with the current template (a studio editing a live template mid-signing must not get a
  signature for text the client never saw); re-checks that the client is not archived; validates the typed name; builds
  a server-derived snapshot with a canonical hash; and inserts. The caller supplies an already-trusted
  `(studio_id, client_id)` and its own database client.
- **Inside intake**, [`lib/intake/consent-gate.ts`](../../lib/intake/consent-gate.ts#L1-L40) resolves which live
  treatment and photo templates apply and re-validates the client's consent claims against a fresh read at submit time.
  It never writes a signature.
- **Launch readiness requires a live treatment consent.**
  [`lib/consent/launch-readiness.ts`](../../lib/consent/launch-readiness.ts#L1-L60) is the one authority for the launch
  and getting-started checklists: at least one `treatment_consent` template of the caller's own studio with
  `status = 'active'` **and** `is_live = true`. Draft, archived and active-but-not-live forms do not count, and a failed
  read is its own third state, never "ready" or "not ready"
  ([`launch-readiness.test.ts` L110-L253](../../tests/lib/consent/launch-readiness.test.ts#L110-L253)). It is
  presentation only: it gates no booking, intake, charting or payment.

## 5. Lifecycle state

The canonical record lists the portal, portal messages, intake forms with reminders and terminal-state immutability,
and versioned consent with e-signatures as **deployed, enabled and in use**; the measured values behind that state are
in [`current-state.md` § 6. Client portal and intake](../../docs/production/current-state.md#6-client-portal-and-intake).
Consent template wording is **draft** and needs lawyer review before enforceability is relied on; Hone's documentation
does not claim signatures are legally binding (same section).

## 6. Contradictions and open questions

1. **Archived client with a live portal session is a redirect loop (code-derived, still open).** `/portal` redirects to
   `/portal/login` when `getPortalIdentity` returns null, which it does for an archived client
   ([`app/portal/page.tsx` L61-L73](../../app/portal/page.tsx#L61-L73);
   [`lib/portal/queries.ts` L72-L88](../../lib/portal/queries.ts#L72-L88)); `/portal/login` redirects to `/portal`
   whenever a session exists ([`login/page.tsx` L25-L34](../../app/portal/login/page.tsx#L25-L34)); and archiving a
   client (`archiveClientAction` in `app/(app)/clients/[id]/actions.ts`, L290-L320) does not revoke its portal sessions —
   only the logout action does ([`session.ts` L160-L175](../../lib/portal/session.ts#L160-L175)). The two pages
   therefore bounce until the 7-day session expires. The portal rebook browser spec documents the loop as a
   pre-existing defect and deliberately asserts only the first redirect, so no test pins the loop either way
   ([`portal-rebook.spec.ts` L282-L315](../../e2e/portal-rebook.spec.ts#L282-L315)).
2. **Intake immutability is not a database guarantee for service-role writers.** `0118` exempts `service_role`, and the
   public intake and reminder paths use the service-role client; their correctness rests on application checks of
   `status`.
