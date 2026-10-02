---
type: product surface
title: Client portal, intake and consent
description: The client-facing realm — magic-link portal sessions kept separate from practitioner auth, portal rebook through the public appointment command, HMAC-signed intake links with database-enforced review and immutability rules, the single consent-signing ceremony with render-time integrity, and a code-level redirect loop for archived clients.
tags: [client-portal, magic-link, intake, consent, signatures, clinical-integrity]
sources:
  - id: openwiki-source-4b52e45d5796f3bdcf32b71a
    resource: repo://app/(app)/clients/%5Bid%5D/actions.ts
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
generated: { by: "claude-code", at: "2026-10-02T22:34:57.394Z" }
verified:
  - by: openwiki/0.6.1
    at: 2026-10-02T22:34:57.394Z
---

# Client portal, intake and consent

Clients never hold a Supabase Auth account. They reach Hone through **bearer links** (intake,
cancel/reschedule/manage, invitation) and through the **client portal**, a separate realm with its own
session cookie. Every client surface resolves `(studio_id, client_id)` server-side and acts through
the service-role client with explicit scoping.

## 1. Portal sign-in and session

- **Magic link:** a 256-bit random token, stored only as a SHA-256 hash, single-use, **60-minute**
  TTL, bound to one studio's one client; the raw token appears only in the emailed URL
  ([`lib/portal/magic-link.ts` L5-L30](../../lib/portal/magic-link.ts#L5-L30)). The public request
  form does not reveal whether an address has an account.
- **Verify:** `GET /portal/verify/<token>` is non-consuming (email scanners prefetch links); only
  the form `POST` consumes the token with a conditional `UPDATE … where consumed_at is null`, so
  concurrent posts resolve to one session ([`verify/[token]/actions.ts` L9-L30](../../app/portal/verify/[token]/actions.ts#L9-L30)).
- **Session:** an httpOnly, `sameSite=lax`, secure-in-production `hone_portal_session` cookie holding
  a raw token whose SHA-256 is stored in `client_portal_sessions` (migration `0052`); **7-day** TTL;
  every portal page resolves it server-side by hash, rejecting expired or revoked rows; a lookup
  failure is treated as anonymous ([`lib/portal/session.ts` L1-L90](../../lib/portal/session.ts#L1-L90)).
  Portal sessions never grant practitioner access and vice versa.
- Middleware lets exactly `/portal`, `/portal/login` and `/portal/verify/*` through; any other portal
  route must do its own session check (see [System overview](../architecture/system-overview.md)).
- Access is logged append-only (`client_portal_access_events`, migration `0111`).

## 2. What a client can do in the portal

Messages and replies to the studio (`0053`–`0055`), consent signing, card-on-file setup through a
Stripe SetupIntent (see [Card on file, checkout and payment proof](../payments/card-on-file-checkout-and-payment-proof.md)),
and **rebook**.
Rebook calls the same locked `create_public_appointment` command as public booking
([`rebook-actions.ts` L73](../../app/portal/rebook-actions.ts#L73-L73),
[L574-L580](../../app/portal/rebook-actions.ts#L574-L580)); the DB suite proves the appointment is
bound to the exact client and studio passed, the audit row is written in the same transaction,
duration comes from the service row, and cross-studio combinations are refused
([`portal-rebook-booking.db.test.ts` L168-L262](../../tests/db/portal-rebook-booking.db.test.ts#L168-L262)).
See [Appointment write authority](../scheduling/appointment-write-authority.md).

## 3. Intake forms

The public `/intake/<token>` flow, the question and answer model, review flags, practitioner-assisted
intake and link resend/reissue are on
[Intake forms, review and assisted intake](intake-forms-review-and-assisted-intake.md). The integrity
boundaries are summarised here:

- **Links** are HMAC-SHA256-signed `{intake_id, expires_at}` payloads under a dedicated
  `INTAKE_SIGNING_SECRET` with **no fallback** to other secrets (the previous fallback to the
  service-role key was removed) ([`lib/intake/tokens.ts` L1-L45](../../lib/intake/tokens.ts#L1-L45)).
  Reminder emails mint a fresh link per send for the same intake row (see
  [Cron jobs and reminders](../communications/cron-reminders-and-idempotency.md)).
- **Terminal immutability (`0118`):** once an intake is submitted or reviewed, an authenticated
  member can no longer change its answers or status; corrections create a new intake. The trigger
  exempts `service_role` writes, so the server paths enforce `in_progress` in code
  ([`0118` L1-L25](../../supabase/migrations/0118_intake_terminal_immutability.sql#L1-L25)).
- **Review transition (`0162`):** `reviewed` is reachable only from a genuinely submitted row, by the
  caller's own active practitioner in that studio, at a database-stamped time
  ([`0162` L1-L25](../../supabase/migrations/0162_intake_review_transition_integrity.sql#L1-L25);
  proved in [`intake-review-db-boundary.db.test.ts` L130-L270](../../tests/db/intake-review-db-boundary.db.test.ts#L130-L270)).
- **No authenticated INSERT (`0163`):** closes the residual where a member could insert a row that
  was already `reviewed` with a forged timestamp
  ([`0163` L1-L25](../../supabase/migrations/0163_revoke_authenticated_intake_insert.sql#L1-L25)).
- Practitioner-assisted intake and intake answers flagged for review live in `lib/intake/`
  (`review-flags.ts`, `entry-provenance.ts`).

## 4. Consent and signatures

- **One ceremony:** [`lib/consent/sign-consent-form.ts`](../../lib/consent/sign-consent-form.ts#L1-L50)
  is the only signing implementation. It looks the template up by id + studio + `is_live` + `status`,
  compares what the client was shown with the current template (a studio editing a live template
  mid-signing must not get a signature for text the client never saw), re-checks that the client is
  not archived, validates the typed name, builds a server-derived snapshot with a canonical hash,
  and inserts. The caller supplies an already-trusted `(studio_id, client_id)` and its own client.
- **Inside intake**, [`lib/intake/consent-gate.ts`](../../lib/intake/consent-gate.ts#L1-L40) resolves
  which live treatment/photo templates apply and re-validates the client's claims against a fresh
  read at submit time.
- **Launch readiness** requires at least one active, live `treatment_consent` form, so a new studio
  cannot read "ready" while intake presents no consent
  ([`current-state.md` § 6. Client portal and intake](../../docs/production/current-state.md#6-client-portal-and-intake)).

## 5. Production status (dated)

Deployed · enabled · in use, with per-studio counts recorded on 2026-08-23 (not restated here);
consent wording is **draft** and not lawyer-reviewed, and Hone does not claim signatures are legally
binding ([`current-state.md` § 6. Client portal and intake](../../docs/production/current-state.md#6-client-portal-and-intake)).

## 6. Contradictions and open questions

1. **Archived client + live portal session = redirect loop (code-derived).** `/portal` redirects to
   `/portal/login` when `getPortalIdentity` returns null, which it does for an archived client
   ([`app/portal/page.tsx` L61-L73](../../app/portal/page.tsx#L61-L73);
   [`lib/portal/queries.ts` L72-L88](../../lib/portal/queries.ts#L72-L88)); `/portal/login` redirects to
   `/portal` whenever a session exists ([`login/page.tsx` L25-L34](../../app/portal/login/page.tsx#L25-L34));
   and archiving a client does not revoke its portal sessions
   (`app/(app)/clients/[id]/actions.ts` L290-L320) — only the
   logout action revokes one ([`session.ts` L160-L175](../../lib/portal/session.ts#L160-L175)). The two
   pages therefore bounce until the 7-day session expires. The tests that reference the portal home
   and login pages (searched under `tests/` and `e2e/`) do not exercise this archived-client path.
2. **Intake immutability is not a database guarantee for service-role writers.** `0118` exempts
   `service_role`, and the public intake and reminder paths use the service-role client; their
   correctness rests on application checks of `status`.
