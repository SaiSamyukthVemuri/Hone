---
title: Hone Canonical Product and SaaS Launch Roadmap
version: 1.1
status: CANONICAL PLANNING BASELINE - expanded platform architecture; subject to Phase 0 exact-head audit
owner: Sam Vemuri
as_of: 2026-07-18
repository: SaiSamyukthVemuri/Hone
production_branch: claude/build-hone-saas-hOex7
---

# Hone Canonical Product and SaaS Launch Roadmap

## Executive decision

Hone's next chapter is not another feature sprint. The product must become a safe, repeatable, self-service multi-studio SaaS without disrupting Willow.

The program objective is:

> A studio owner who has never spoken to Sam can discover Hone, create a verified account, accept the current legal terms, pay for a plan, atomically provision a studio, complete onboarding, launch booking, invite practitioners, operate treatment workflows, receive support, manage billing, export data, cancel, reactivate, and leave without Sam using SQL, Supabase, Stripe, Twilio, Google Cloud, Vercel, provider dashboards, environment variables, code changes, or repair scripts.

The product north star remains treatment memory. The scale program exists to make that core workflow safe, repeatable, commercially operable, and supportable across unrelated studios.

**Architecture decision:** Hone will evolve in the existing production codebase. Willow/Chloe stays on the same codebase behind a protected behavioral contract and default-off capability gates. Hone will not be cloned into a separate long-lived `v2` product or branch. Scale work uses branch-by-abstraction, additive migrations, synthetic tenants, shadow mode, tenant-level flags, and expand/verify/contract cutovers so fixes and security improvements benefit every tenant without forcing Willow onto unproven behavior.

This document is the canonical product and delivery roadmap. Future work must map to a roadmap ID, a confirmed production incident, an unresolved P0/P1, a legal requirement, or reviewed Chloe feedback.

## 1. Canonical governance

### 1.1 Source-of-truth hierarchy

When sources disagree, use this order:

1. Running production behavior and hosted provider/database state.
2. Exact production source commit, hosted migration list, and live verification evidence.
3. The master findings register and machine-readable capability manifest created in Phase 0.
4. This canonical roadmap.
5. Approved architecture decisions and implementation specifications.
6. Current product, security, privacy, support, and operations documentation.
7. PR titles, changelogs, assistant summaries, and historical notes.

No document may claim that a capability is live merely because code, a migration, a route, or a feature flag exists.

### 1.2 Status vocabulary

Every capability must use one of these states:

- **IDEA** - desired but not designed.
- **DESIGNED** - architecture and acceptance criteria approved.
- **CODE COMPLETE** - implementation and local tests complete.
- **DEPLOYED DORMANT** - deployed, but disabled and not customer-usable.
- **CONTROLLED VERIFIED** - exercised on an approved synthetic or controlled tenant.
- **LIMITED RELEASE** - enabled for a named cohort with monitoring and rollback.
- **GENERALLY AVAILABLE** - self-service, supported, documented, measured, and approved for the target market.
- **RETIRED** - no longer available; migration/offboarding complete. **RETIRED is terminal**, and applies equally to a capability that was never released: a deployed-dormant capability can be retired directly without ever reaching LIMITED RELEASE, in which case retirement means the product decision is recorded and the database enforces that it cannot be enabled. A RETIRED item is not DEPLOYED DORMANT, not parked, and not a gate anyone can grant.

### 1.3 Change control

- Store the repository version at `docs/roadmap/CANONICAL_ROADMAP.md`.
- Update it only through a reviewed roadmap PR.
- Every implementation PR must cite one or more roadmap IDs.
- Every PR must state Willow impact, tenant impact, migrations, feature flags, provider calls, rollback, test evidence, and production proof required.
- P0/P1 incidents can interrupt the roadmap. After stabilization, update the roadmap and findings register before normal work resumes.
- Chloe feedback can refine priorities and acceptance criteria, but cannot bypass tenant isolation, clinical integrity, consent, payment, privacy, or production-safety gates.
- No item is marked complete until code, tests, deployment, production verification, documentation, and rollout state agree.

### 1.4 Review cadence

Refresh this roadmap:

- after the Phase 0 audit;
- after each major phase exit;
- after any production P0/P1;
- after a material legal/provider change;
- after a controlled-studio rollout reveals a new systemic blocker;
- when reviewed Chloe feedback changes the product contract.

## 2. Current state at adoption

### 2.1 Production and marketing

- Production branch: `claude/build-hone-saas-hOex7`.
- Production source baseline at adoption: `325b124724760615fd2e55242a85f94cbea0d17c`.
- Repository/hosted migration max: **`0159`** (both), as of 2026-07-30. `0158` is deliberately skipped and will never be applied; `0160` is **not** applied. *(This line previously read "expected: `0133`; no `0134`", then `0157` — both superseded; 0134–0157 plus 0159 exist in-tree and are all applied in production.)*
- Marketing PR #439 is open, unmerged, and has progressed to a broad public-site implementation. It must finish exact-head review, resolve review threads, pass all gates, merge, deploy, and receive live verification before the marketing overhaul is considered complete.
- Once PR #439 ships, freeze major marketing redesign. Future marketing work should be correctness, support content, measured SEO growth, and product-proof updates rather than repeated visual rebuilds.

### 2.2 Product strengths

- Strong electrologist-specific treatment-memory workflow.
- Public booking, intake/consent, calendar, client portal, charting, treatment photos, procedure records, reminders/postcare, and guided payment capabilities exist in meaningful form.
- Before Today / Last Visit is the defining product advantage.
- The application has substantial RLS, idempotency, audit, provider, and production-verification work already completed.

### 2.3 Scale gaps

- Studio provisioning is founder/admin operated.
- Hone does not yet have complete public signup, subscription billing, entitlements, dunning, billing portal, cancellation/reactivation, or self-service offboarding.
- Prior P1 registers include identity, legal-evidence, intake, booking, payment, retention, clinical-integrity, tenant, audit, storage, support, and calendar-capacity findings. Their exact current status must be reconciled against today's production head; historical findings must not be assumed open or closed.
- Multi-studio tenant safety has not yet been proven through a complete executed Studio A/B matrix across every boundary.
- Multi-location is not a complete domain model.
- Support is founder-centric and lacks a tenant-scoped case system and documentation-grounded bot.
- Twilio is implemented as a controlled pilot using deployment-level credentials and a direct send path, not a tenant-isolated communications platform.
- Google Calendar initial outbound create was proven once on Sam's controlled studio; update, delete, recovery, self-service connection, and controlled multi-studio rollout remain.
- Export, retention, legal hold, verified purge, cancellation, and offboarding are not yet one complete self-service lifecycle.

### 2.4 Google Calendar checkpoint

B2.3-c4a proved one controlled lifecycle:

`one synthetic appointment -> one outbox operation -> one worker claim -> one bound link -> one private Google event`

The worker and every studio sync flag returned to OFF. Willow remained unconnected and untouched. The evidence object should be preserved. Calendar is not generally available.

### 2.5 Twilio checkpoint

The current code includes:

- E.164 normalization;
- consent and studio-toggle gates;
- claim-send-record behavior;
- bounded retry attempts;
- signature-validated inbound webhook;
- STOP handling;
- safe phone masking.

The scale design still needs:

- tenant-specific provider accounts/senders;
- durable provider-independent outbox;
- delivery callbacks and reconciliation;
- indexed tenant-scoped phone routing;
- tenant-scoped suppression;
- compliance onboarding;
- usage, spend, health, and suspension controls;
- queue fairness and dead-letter recovery.

### 2.6 Platform services and growth checkpoint

- **Resend is already the transactional email provider in the current codebase.** The roadmap is to harden it with a durable email outbox, provider idempotency, signed delivery webhooks, bounce/suppression handling, tenant attribution, and delivery health. Do not add a second transactional email provider without an approved migration reason.
- **A prior Meta/provider-selector implementation has been reported, but its exact current production state is not yet established.** Phase 0 must audit it before any reuse or claim. The target is a provider-agnostic studio integration layer. Hone's corporate marketing analytics and each studio's advertising integrations remain separate. Willow's Meta Business/Dataset/Pixel belongs to Willow, not Hone.
- **Sentry, Better Stack, PostHog, Supabase PITR, public status, MFA enforcement, owner-facing audit UI, trust center, and accounting export are roadmap requirements unless Phase 0 proves they are already complete.**
- **Session replay is not permitted on authenticated clinical, intake, portal, payment, token, or treatment-record routes at launch.** Product analytics may use privacy-safe events; replay begins only on public marketing/demo surfaces with full masking and a reviewed privacy configuration.
- **Claude API use begins with a documentation-grounded support assistant that receives no clinical data.** Treatment-memory summaries or other clinical-data AI uses are a later controlled program requiring privacy/legal review, explicit product boundaries, evaluation, human review, and a separate activation gate.

## 3. Product north star and launch outcomes

### 3.1 Product thesis

Hone is electrolysis practice software whose category-defining advantage is treatment memory: restoring the clinically relevant context from the previous visit before the next treatment begins, then making today's charting fast enough to improve the following appointment.

### 3.2 Activation metric

The primary activation event is not “studio created.” It is:

> The second appointment is opened with useful prior treatment memory visible in Before Today.

### 3.3 Self-service success definition

A stranger can:

1. discover Hone;
2. create and verify an owner identity;
3. accept current terms/privacy through server-enforced versioned evidence;
4. select and pay for a CAD plan;
5. atomically provision an organization, default location, and owner membership;
6. configure services, practitioners, availability, booking, intake, consent, communications, and import;
7. launch only after health checks pass;
8. complete first booking, intake, chart, and returning appointment;
9. obtain useful support without exposing sensitive records;
10. manage subscription billing;
11. export data;
12. cancel, reactivate, or offboard.

### 3.4 Multi-studio launch definition

Multi-studio launch means many unrelated one-location customers safely share Hone. It does not require full multi-location functionality at first launch. The data model must, however, create each independent studio as an organization with a default location so multi-location can be added without reinterpreting “studio” again.

### 3.5 What is not a public-launch blocker

The following can remain post-GA when clearly omitted from public claims:

- Google inbound busy-time import;
- Google-to-Hone edits or two-way synchronization;
- full multi-location operations;
- autonomous AI or clinical recommendations;
- broad public API/integration platform;
- enterprise reporting;
- advanced referral analytics;
- large-practice migration automation beyond the launch import scope.

## 4. Non-negotiable operating principles

1. Willow is a protected production tenant, not a test tenant.
2. Every new external-effect capability is default OFF globally and per tenant.
3. Deployment and activation are separate approvals.
4. Use additive migrations and expand/verify/contract patterns.
5. No production data mutation during planning/audit without explicit authorization.
6. No customer sends provider credentials to Sam.
7. No PHI, treatment content, intake answers, tokens, full phone numbers, or payment secrets in Slack or email.
8. The support bot never receives unrestricted service-role access.
9. Public signup stays closed until applicable P1, tenant, billing, support, and offboarding gates pass.
10. Provider jobs must be durable, idempotent, tenant-fair, observable, and recoverable.
11. Existing users retain behavior unless a separately approved migration changes it.
12. The fastest path is controlled proof, not broad activation.
13. No feature is marketed before its public availability state is true.
14. One canonical capability manifest drives docs, checks, and marketing truth.

### 4.1 Architecture decision - one evolving codebase, not a cloned v2

**Decision:** Continue in the existing Hone repository and production application. Do not create a second cloned product called `v2`, and do not create a long-lived fork for Chloe/Willow.

Why:

- A clone would immediately duplicate security fixes, migrations, provider integrations, CI, documentation, support, and incident response.
- Willow would become trapped on a legacy branch while the scalable product diverges.
- Every P1 would need to be fixed and verified twice.
- Data migration from the old product into the clone would become a second high-risk launch.
- Operational evidence, billing, Calendar, Twilio, email, support, and analytics would split across two control planes.

The required pattern is:

`add -> deploy dormant -> dual-write/shadow -> backfill -> verify -> switch reads/commands per tenant -> monitor -> retire old path later`

Separate repositories are allowed only for independently deployable infrastructure with a clear trust boundary, such as a future worker service or documentation-indexing pipeline. They must consume versioned contracts from Hone and must not become a second product implementation.

**Willow rule:** existing Willow behavior remains the compatibility baseline. New architecture lands additive and default OFF; synthetic Studio A/B/C proves it first; activation occurs tenant by tenant.

## 5. Willow protection program — SAFE

### SAFE-01: Freeze Willow's behavioral contract

Create a permanent E2E contract for:

- public booking;
- intake and consent;
- appointment reminders and postcare;
- calendar and move appointment;
- client portal;
- charting and treatment memory;
- treatment photos;
- payments/refunds where currently approved;
- records/export;
- practitioner access.

**Exit:** the suite is green on the exact production artifact and runs on every relevant PR.

### SAFE-02: Pin Willow's feature state

- No Google connection or sync enablement.
- No Twilio architecture migration until separately approved.
- No Hone subscription migration applied to Willow without a commercial migration plan.
- No self-service provisioning changes Willow's existing tenant identity.
- No new worker claims Willow work by default.
- No destructive test data.

**Exit:** a verifier proves Willow's flags, connections, claimable jobs, billing mode, and provider state before and after each rollout.

### SAFE-03: Synthetic tenant fleet

Maintain:

- Studio A: synthetic solo studio.
- Studio B: synthetic three-practitioner studio.
- Studio C: failure/recovery studio.

Studio C is used for provisioning failure, failed billing, revoked OAuth, Twilio rejection, export failure, cancellation, and purge rehearsals.

### SAFE-04: Release controls

Every provider subsystem has:

- global kill switch;
- per-organization enablement;
- per-location enablement where relevant;
- shadow mode;
- cohort allowlist;
- rollback/runbook;
- PHI-safe heartbeat;
- unresolved-alert gate.

### SAFE-05: Shadow and canary behavior

Before provider execution, calculate and persist what would happen without calling the provider. Prove the tenant, resource, consent, payload, idempotency key, and exclusion of Willow.

## 6. Phase 0 — exact-head audit and canonical baseline

No new self-service or multi-studio architecture implementation begins until this audit is complete.

### AUD-01: Source establishment

- Fetch exact production branch and deployment.
- Confirm current source, Vercel deployment, hosted migrations, environment gates, feature flags, provider configuration, and open PRs.
- Confirm current counts and dormant controls without changing them.
- Record the audit artifact hashes and exact timestamp.

### AUD-02: Prior findings reconciliation

Ingest:

- `Hone_Findings.csv`;
- `Hone_Findings_Register_2026-07-10.csv`;
- `Hone_Full_Production_Readiness_Audit_2026-07-10.md`;
- current production code and migrations;
- hosted production evidence;
- merged work since the audits;
- current Chloe feedback.

For each finding preserve the original ID and classify:

- OPEN;
- PARTIALLY FIXED;
- FIXED IN CODE;
- DEPLOYED;
- PRODUCTION VERIFIED;
- SUPERSEDED;
- FALSE POSITIVE.

Never close a finding from a PR title, changelog, or source-string test alone.

### AUD-03: Feature and capability manifest

Create a machine-readable register containing:

- capability ID;
- audience;
- designed/code/deployed/enabled/exercised/GA states;
- migration;
- routes;
- flags;
- provider dependency;
- production evidence;
- owner;
- rollback;
- last verified date;
- public marketing status.

Generate human documentation and truth guards from this manifest.

### AUD-04: Full SaaS lifecycle walk

Attempt the complete journey with no founder/admin shortcut:

`discover -> signup -> verify -> accept -> pay -> provision -> configure -> import -> launch -> operate -> support -> bill -> export -> cancel -> reactivate -> delete`

Every manual dependency becomes a finding or roadmap item.

### AUD-05: Studio A/B boundary matrix

Execute negative tests across:

- direct database access and RLS;
- RPCs and server actions;
- Storage paths, metadata, and signed URLs;
- selected-studio cookies and stale tabs;
- portal, intake, cancel, reschedule, manage, and feed tokens;
- queues, schedulers, outboxes, and alerts;
- email and SMS;
- Stripe customers, accounts, modes, cards, charges, refunds, disputes;
- Google credentials, calendars, event links, and operations;
- imports, exports, and deletion;
- support access.

### AUD-06: Provider and operations audit

Review Stripe, Twilio, Google, Resend/email, Upstash, Vercel, Supabase, storage, scheduler, backup, alerts, and incident workflows.

### Phase 0 outputs

1. Current-state report.
2. Master findings register.
3. Capability manifest.
4. Willow contract baseline.
5. Studio A/B matrix and results.
6. Architecture decisions.
7. Updated dependency-ordered PR plan.
8. First implementation PR specification.
9. Updated version 1.1 of this roadmap.

## 7. Phase 1 — P1 closure and trustworthy treatment memory

The exact open list is determined by Phase 0. The historical P1-01 to P1-13 set must be reconciled, not blindly reimplemented.

### SEC-01: Public booking identity

Do not attach a public booking to an existing clinical identity from typed email alone. Use pending identity plus OTP/magic-link proof, or an authenticated portal rebooking path. Provide reviewed duplicate-merge tooling.

### SEC-02: Legal acceptance evidence

Require a server-enforced, versioned post-auth acceptance screen. Persist version/hash, user, event ID, timestamp, source, and privacy-safe request metadata. Remove fabricated acceptance from user-creation triggers.

### SEC-03: Intake token lifecycle

Use row-backed hashed tokens or token versions/nonces. Reissue revokes prior links. Track issuance, use, expiry, supersession, and revocation. Submitted/reviewed links must not expose sensitive answers.

### SEC-04: Intake concurrency and schema

Use transactional patch merge or revision compare-and-swap. Validate exact types, enums, dates, lengths, arrays, per-step ownership, and total bytes. Preserve immutable assertions and surface conflicts for practitioner review.

### SEC-05: Transactional booking and evidence

Create one authoritative booking command covering identity/pending identity, slot claim, appointment, policy/consent evidence, audit, and outbox intents. After commit, provider delivery may degrade but the user receives stable committed success.

### SEC-06: Cancellation and reschedule evidence

Policy acknowledgement and appointment-state transition must commit atomically. Historical policy snapshots remain immutable. Replays are idempotent.

### SEC-07: Payment-method and webhook integrity

Make active-card replacement transactional. Use typed processed/retryable/terminal webhook outcomes. Terminal lineage rejection creates a critical reconciliation case. Portal success depends on Hone's persisted state, not only Stripe confirmation.

### SEC-08: Marketing consent dispatch

Persist consent and provider outbox atomically. Dispatch only from current durable consent. Withdrawal before execution cancels delivery. Replays cannot duplicate provider events.

### SEC-09: Clinical finalization, amendments, and chart contract — **RETIRED (2026-07-29)**

**Status: RETIRED.** The ID is kept so nothing silently disappears from a canonical document, but
**no work maps to it and none may be opened against it.**

*Original instruction, superseded:* "Reconcile the already-deployed clinical finalization/correction work. Close any remaining gaps in immutable snapshots, amendment attribution, version conflicts, audit mandates, and customer-visible record provenance. Resolve the observation-chip/narrative contract across save, reload, history, print/export, copy-previous, finalization, and correction."

*Why retired:* signed and cryptographically finalized clinical records are **not a Hone product
capability**. Practitioner-signed snapshots, immutable finalized records, "snapshot v2",
cryptographic clinical-record hashes as a product feature, and any correction/amendment workflow
built around signed snapshots are permanently rejected. Treatment sessions remain **ordinary,
editable operational records**, and practitioners correct charting mistakes by editing them.
Migration **0159** enforces this in the database: both studio flags are pinned `false` by CHECK
constraint, `EXECUTE` on the finalize/correct/amend/snapshot RPCs is revoked from every runtime
role, transitions into `finalized`/`void` are refused, and `INSERT` is refused on all three
signed-record ledgers. Decision record:
**`docs/decisions/clinical-finalization-retired.md`**.

*What this does NOT retire.* Ordinary operational audit trails (`session_audit`,
`record_keeping_audit_events`, `session_copy_operations`, `admin_action_events`,
`client_portal_access_events`), actor attribution, timestamps, treatment-history integrity,
whole-session-copy provenance and tenant isolation are all **retained and must not be weakened**.
`clinical_audit_events` is **not** one of them — its CHECK admits only
`correction`/`amendment`, so it is part of the retired system despite its name. The
observation-chip / narrative chart-note contract (**P1-13**) was already closed on its own
evidence and is unaffected; it now covers save, reload, history, print/export and copy-previous
only, because there is no finalization or signed-correction state left to reconcile.

*Reintroduction is not a backlog item.* It would require a new explicit product decision, an
architecture review, a legal/privacy review, a migration plan and fresh acceptance — see §7 of the
decision record. Do not cite SEC-09 in any future PR.

### SEC-10: Retention, legal hold, export, and purge

With legal review, define data-class and jurisdiction schedules. Add legal hold, retention due dates, purge state, attempts, object deletion, verification, immutable deletion manifest, backup exceptions, and DSAR/offboarding workflow.

### SEC-11: Admin and support security

Require strong platform-admin identity, step-up/AAL2 where supported, scoped roles, time-bound support access, reason/approval, audit, safe diagnostics, and immediate revocation. Email allowlisting alone is insufficient.

### SEC-12: Storage and photo lifecycle

Prove hosted bucket policies, same-parent relationships, signed URL behavior, metadata stripping, archive/restore, export, retention, purge, and backup lifecycle on production-like artifacts.

### SEC-13: MFA and high-risk reauthentication

- Require Supabase MFA for Hone platform administrators before public self-service.
- Require MFA for organization owners before Gate C unless Phase 0 records a temporary, risk-accepted staged rollout with an expiry and compensating controls.
- Support factor enrollment, factor replacement, account recovery, device/session revocation, and audited break-glass recovery.
- Require fresh reauthentication for ownership transfer, billing changes, provider connections, full export, retention/legal-hold changes, and destructive offboarding actions.
- Test factor downgrade, stale sessions, recovery abuse, ownership loss, former-owner access, and tenant switching.

### SEC-14: Owner-facing audit log UI

Expose a tenant-scoped, privacy-minimized audit timeline for organization owners. Include identity/access changes, practitioner invitations and removals, booking-policy changes, subscription/billing state, provider connections, exports, ordinary session edit history, support access, and destructive actions.

*(Amended 2026-07-29: this item previously read "clinical finalization/amendment status". That is retired — see SEC-09 — so the clinical slice of this timeline is ordinary session edit history (`session_audit`) plus the other retained operational audit tables, never signed-record status.)*

Do not duplicate treatment notes, intake answers, photos, tokens, full contact details, payment secrets, or provider credentials into the audit UI. Audit events must be server-authored, immutable, consistently attributable, and linked to a stable command/event ID.

### Phase 1 exit

- No unresolved applicable P0/P1 launch blockers.
- Every closed finding has regression, migration, deployment, and production evidence.
- Willow contract remains green.
- Studio A/B matrix has no cross-tenant success.
- Treatment memory is backed by trustworthy **ordinary editable** records with actor attribution, timestamps, session edit history and whole-session-copy provenance. *(Amended 2026-07-29: previously "trustworthy immutable/versioned records" — signed/finalized/versioned clinical records are RETIRED, see SEC-09. Trustworthiness is delivered by audit trails and tenant isolation, not by freezing the record.)*

## 8. Phase 2 — multi-studio tenant foundation

### TEN-01: Organization and default location

Target model:

`Organization -> Subscription/Entitlements -> Locations -> Practitioners/Resources -> Operational data`

Every existing studio becomes one organization plus one default location. First GA supports independent one-location organizations; multi-location UI and central operations can follow.

### TEN-02: Tenant ownership

Every operational row has an unambiguous organization owner. Location-sensitive rows have a location owner. Foreign keys and RPCs enforce same-parent relationships. Service-role commands verify parentage rather than trusting caller-provided IDs.

### TEN-03: Roles and capabilities

Launch-minimum capabilities:

- Owner: commercial, settings, team, billing, launch, data requests.
- Practitioner: clinical records and assigned operational workflows.
- Front desk/coordinator: booking/client administration without unrestricted clinical access.
- Billing: payment operations without clinical access, when needed.
- Platform support: external, time-bound, case-linked; never a normal tenant member.

Capabilities must be centralized and enforced in database/RPC/server tests, not only hidden in UI.

### TEN-04: Ownership and membership lifecycle

- multiple-owner policy;
- ownership transfer;
- lost-owner recovery;
- invite/resend/revoke/expire;
- tenant-scoped invitation uniqueness;
- former-member session revocation;
- stale-tab and selected-tenant synchronization;
- reauthentication for destructive cross-tenant actions.

### TEN-05: Tenant suspension and feature rollout

Support active, configuring, degraded, suspended, cancelling, and offboarded states. Suspending a tenant stops public booking and external effects without destroying records.

### TEN-06: Team calendar capacity

Replace whole-studio collision semantics with explicit practitioner/resource reservations. Same practitioner or shared resource conflicts are denied; different practitioners can operate concurrently.

### TEN-07: Public practitioner assignment

Support specific practitioner and “any eligible practitioner” rules, service eligibility, removed practitioners, parallel capacity, and fair assignment. Do not silently assign the owner.

### Phase 2 exit

- Existing Willow data maps to one organization/default location without behavior change.
- Synthetic Studio A/B isolation passes every boundary.
- Three-practitioner synthetic studio can book concurrent legitimate appointments.
- Owner transfer and former-member revocation are proven.
- Tenant suspension stops external operations safely.

## 9. Phase 3 — self-service identity, provisioning, and billing

### SAA-01: Public owner signup

Build `/signup` with verified email, secure return paths, abuse controls, server-enforced legal acceptance, and resumable state.

### SAA-02: Plan catalog

Canonical CAD plans:

- Founding Solo: CAD $29/month for 12 months, then CAD $39 while continuously subscribed.
- Solo: CAD $49/month.
- Studio: CAD $99/month for up to three practitioners.

Plan versions and commercial rules live in Hone's database/config and map explicitly to Stripe Price IDs. Public copy, Checkout, invoices, entitlements, and tests must agree.

### SAA-03: Stripe Checkout

Use Hone platform Stripe Billing, separate from studio-to-client Stripe Connect. Create/reuse Stripe customer safely, start Checkout, handle abandoned/replayed sessions, and bind verified owner/organization intent.

### SAA-04: Canonical subscription reducer

Use a verified webhook inbox and idempotent reducer. Handle out-of-order and replayed events. Persist customer, subscription, price version, status, current period, cancellation, trial/discount, invoice, tax, and provider event lineage.

### SAA-05: Atomic provisioning command

Provision:

- organization;
- default location;
- owner membership;
- safe defaults;
- plan/entitlement state;
- onboarding record;
- audit/command ID.

No half-created tenant. Failures are resumable or rolled back. No orphan Stripe customer, owner, organization, or entitlement.

### SAA-06: Entitlements

Entitlements are evaluated from Hone's canonical subscription state, not real-time provider calls. Avoid artificial restrictions: core treatment memory, charting, intake, consent, and records stay complete. Seats and explicitly commercial features can be enforced.

### SAA-07: Dunning and access states

Implement past due, grace, suspended, recovered, cancelled-at-period-end, cancelled, and reactivated states. Preserve customer access/export rules and stop new external effects safely.

### SAA-08: Billing portal and invoices

Provide self-service payment method, invoices, tax details, cancellation, and reactivation. Do not expose studio-client Stripe Connect state as Hone subscription billing.

### Phase 3 exit

A new synthetic owner can sign up, pay in Stripe test mode, provision atomically, access the correct tenant, see entitlements, experience failed payment/grace/suspension, use the billing portal, cancel, and reactivate without founder intervention.

## 10. Phase 4 — dependency-aware onboarding and first value

### ONB-01: Onboarding state machine

Steps:

1. Practice identity.
2. Default location/timezone.
3. Services, price, duration, modality.
4. Practitioners and capabilities.
5. Availability and resources.
6. Booking policies and horizon.
7. Intake and consent.
8. Communications.
9. Client import.
10. Booking-page preview.
11. Optional studio-to-client payments.
12. Optional Google Calendar.
13. Launch health.
14. Test booking.
15. First real appointment.
16. First chart.
17. Second appointment with Before Today.

Each step is saved, resumable, validated, documented, and linked to support.

### ONB-02: Launch health

Evaluate actual dependencies, not checkbox completion:

- verified owner and current legal acceptance;
- active Hone entitlement;
- valid timezone/location;
- service and eligible practitioner;
- availability/resources;
- booking policies;
- intake/consent;
- email health;
- SMS approved or explicitly disabled;
- Google ready or explicitly skipped;
- client payments approved or disabled;
- public booking smoke test;
- no unresolved critical alert.

States:

`Draft -> Configuring -> Ready for test -> Ready to launch -> Active -> Degraded -> Suspended`

### ONB-03: Client import

Launch scope includes a safe guided self-service import with preview, validation, deterministic matching, row-level errors, source lineage, idempotent commit, and signed report. Larger resumable migration engine can follow after launch.

### ONB-04: In-product guidance

Use checklist, empty states, contextual help, fictional sample data, test booking, guide/video links, and an Ask Hone entry point. Do not use tooltips as the only instruction.

### Phase 4 exit

A first-time owner can configure and launch a synthetic studio without founder action, complete the treatment-memory activation loop, and recover from every intentionally injected onboarding failure.

## 11. Phase 5 — Google Calendar outbound v1

### CAL-01: c4b controlled update

On Sam's synthetic studio:

- move one synthetic appointment;
- prove exactly one `event.update` operation;
- run worker exactly once;
- disable worker before inspection;
- verify same provider event ID, new time, new ETag, no duplicate, minimal private payload;
- restore all controls OFF.

### CAL-02: c4c controlled delete

Use a separate synthetic appointment:

- cancel through the real Hone path;
- prove one delete operation;
- run worker once;
- disable worker first;
- verify provider deletion/tombstone, no duplicate, no residue;
- restore controls OFF.

### CAL-03: Recovery matrix

Prove:

- duplicate/ambiguous create replay;
- deterministic provider event ID;
- provider success with DB-record failure;
- stale ETag / conditional update failure;
- provider 404/already deleted;
- multiple Hone changes before claim;
- token expiry and transient refresh failure;
- revoked OAuth consent;
- rate limit and provider 5xx;
- worker crash and stale claim;
- dead-letter and reconciliation;
- disconnect with queued work;
- noisy-tenant fairness.

### CAL-04: Self-service connection

Owner flow:

`Connect Google -> OAuth -> verify owner -> create Hone Appointments -> verify write access -> synthetic health check -> show ready -> explicit outbound enable`

Show identity, destination, scope, last success, pending work, last error, reconnect, disconnect, and exact behavior. No hidden founder step.

### CAL-05: Queue and quota operations

Tenant-fair claiming, exponential backoff with jitter, per-user/project quota awareness, queue age, dead-letter state, provider reconciliation, connection suspension, and safe support diagnostics.

### CAL-06: Controlled rollout

1. Sam synthetic solo.
2. Sam synthetic team studio.
3. One consenting non-Willow external studio.
4. Three studios.
5. Ten studios.
6. General outbound availability.

### Calendar v1 boundary

Outbound-only dedicated Hone calendar. No primary-calendar reading, inbound busy import, Google-to-Hone edits, two-way sync, broad scope, or Willow activation.

## 12. Phase 6 — multi-tenant Twilio and communications platform

### COM-01: Provider-independent communication domain

Create durable message intent, attempt, delivery event, consent, suppression, template/version, provider account, quota, and dead-letter records.

Lifecycle:

`planned -> ready -> claimed -> provider accepted -> queued -> sent -> delivered`

Failure states:

`retryable -> failed/undelivered/expired/suppressed/dead`

### COM-02: Transactional outbox

Booking, reminder, postcare, cancellation, reschedule, and portal actions write durable intents in the same transaction as the core command. Request paths do not wait for Twilio or email providers.

### COM-03: Tenant-fair worker

- bounded batches;
- per-tenant fairness;
- current consent/suppression recheck;
- send-after and expiry;
- per-tenant enablement;
- segment and spend limits;
- idempotency;
- retry/backoff;
- dead-letter;
- queue-age SLO;
- global and tenant kill switches.

### COM-04: Twilio ISV architecture

Preferred target:

- Hone parent account;
- one Twilio subaccount per Hone organization;
- Messaging Service per studio/use case;
- sender and compliance status isolated per customer;
- provider credentials stored encrypted/server-only;
- no customer-supplied Twilio credentials.

This matches Twilio's preferred ISV A2P architecture: customer-mapped subaccounts plus Messaging Services, which separates traffic, analytics, and compliance impact.

### COM-05: Sender/compliance onboarding

Select sender strategy by market and use case. For US traffic, support A2P 10DLC or verified toll-free as appropriate. Capture legal business and messaging-use-case information, create provider registrations, consume status events, and keep SMS disabled until approved.

### COM-06: Delivery callbacks and reconciliation

Validate signed callbacks and persist accepted, queued, sent, delivered, undelivered, and failed states. Reconcile provider and Hone state. A provider acceptance is not “delivered.”

### COM-07: Indexed tenant-scoped inbound routing

Use provider account + Messaging Service + destination sender to identify the organization, then indexed E.164 source to identify the client/channel. Eliminate full-client scans.

### COM-08: STOP/START/HELP

Persist opt-out/opt-in/help events per organization and channel. Use Twilio opt-out behavior where appropriate and preserve Hone's durable suppression ledger. Do not opt a client out of unrelated businesses merely because the phone number matches.

### COM-09: Messaging health and cost

Per organization:

- approval/sender status;
- enabled state;
- monthly segments and spend;
- delivery/undelivered/opt-out rates;
- queue age;
- last success;
- webhook health;
- suspension reason.

Platform:

- global budget and alerts;
- per-country restrictions;
- segment limits;
- anomaly detection;
- synthetic canary;
- provider incident mode.

### Phase 6 exit

Three unrelated synthetic/controlled studios can send compliant messages through isolated provider state, receive callbacks, opt out independently, observe usage, survive provider failures, and prove no cross-tenant routing or billing.

## 13. Phase 7 — support platform and documentation bot

### SUP-01: Tenant-scoped support cases

A case contains:

- organization/location/user;
- product area and page;
- severity/status/owner;
- user question;
- bot answer and citations;
- safe command/trace/provider IDs;
- redacted diagnostics;
- customer-visible updates;
- resolution and documentation candidate.

The case is the source of truth. Slack/email are notifications only.

### SUP-02: Safe diagnostics

Build tenant-scoped health summaries for subscription, provisioning, booking, queues, email/SMS, Google, Stripe Connect, Storage, imports, exports, and alerts. Start with metadata; record-level access is exceptional and audited.

### SUP-03: Time-bound human support access

Reason, case, scope, approval, expiry, actions, and revocation are mandatory. No unrestricted service-role browsing.

### SUP-04: Documentation knowledge base

Separate:

- public help;
- owner guides;
- practitioner guides;
- billing guides;
- troubleshooting;
- internal runbooks;
- incident procedures.

Every source has owner, audience, version, last reviewed date, product capability, public/internal classification, and source evidence.

### SUP-05: Ask Hone bot

The bot:

- answers only from approved documentation;
- cites exact sources;
- distinguishes public/authenticated/internal answers;
- says it does not know;
- resists prompt injection;
- has no direct service-role access;
- avoids PHI and secrets;
- rate-limits abuse;
- logs safe metadata;
- supports feedback and corrections.

### SUP-06: Automatic escalation

On low confidence, no source, risk keywords, repeated failure, or human request:

1. create support case;
2. redact sensitive content;
3. attach safe context and citations;
4. email Sam;
5. post a PHI-safe Slack notification;
6. link to the case;
7. allow a human answer to return to the user;
8. create a reviewed documentation candidate.

Never include treatment notes, intake responses, photos, card data, tokens, or full phone numbers in notifications.

### SUP-07: Bot evaluation

Maintain a versioned test set covering onboarding, billing, Calendar, Twilio, booking, charting, privacy, and common failure modes. Measure grounded answer rate, citation correctness, refusal/unknown quality, escalation accuracy, sensitive-data leakage, and stale-doc detection.

## 14. Phase 8 — onboarding academy, content, trust, and growth attribution

### EDU-01: Written guides

- Create your account and secure it with MFA;
- Set up organization/location;
- Add services, practitioners, hours, and booking policies;
- Configure intake, consent, communications, and payments;
- Connect Google Calendar;
- Configure studio advertising integrations;
- Import clients;
- Publish booking;
- Complete first chart;
- Use Before Today;
- Add photos;
- Manage billing;
- Export;
- Cancel/reactivate/offboard.

### EDU-02: Task videos

- 60-180 seconds;
- one task per video;
- fictional seeded data only;
- captions and transcript;
- linked to written guide;
- versioned and replaced when UI changes;
- embedded in onboarding/contextual help.

### EDU-03: Documentation lifecycle

Support case -> documentation candidate -> human review -> publish -> re-index -> bot evaluation. The bot never learns directly from unreviewed conversations.

### EDU-04: Marketing/content stream

Use Search Console data, sales objections, onboarding drop-off, repeated support questions, and practitioner feedback. Keep help content and acquisition content separate but linked. No automated unreviewed publishing.

### EDU-05: About Hone and company trust narrative

Ship and maintain a truthful About Hone page covering the founder story, why treatment memory matters, the product philosophy, the company/contact path, and the distinction between product ambition and currently available capabilities. Do not publish customer identity, endorsement, logos, or practitioner quotations without explicit permission.

### TRUST-01: Public trust center

Publish a plain-language trust center that links to:

- privacy notice and terms;
- DPA/request process when ready;
- subprocessors;
- data-residency and backup explanation;
- access control and MFA posture;
- encryption and secret-management summary;
- incident reporting/contact;
- status page;
- export, retention, cancellation, and deletion process;
- AI-use statement;
- security contact and disclosure process.

Do not claim HIPAA, PHIPA, PIPEDA, SOC 2, ISO, or other compliance certification without counsel and evidence.

### GROW-01: Provider-agnostic marketing integration domain

Create a typed studio integration model for Meta, Google Ads/GA4, TikTok, Pinterest, LinkedIn, Microsoft Ads, and a narrowly controlled custom destination. Each studio owns its own provider account, destination, credentials, consent settings, and enablement. Credentials/tokens are encrypted and unreadable by browser roles. Hone's corporate analytics is a separate tenant/context.

### GROW-02: Finish Meta Pixel and Conversions API

- Exact-head audit the existing Meta/provider-selector implementation before changing it.
- Client Pixel loads only on approved public marketing/booking surfaces and only under the applicable consent decision.
- Server-side Conversions API events come from a durable provider outbox written atomically with versioned marketing-consent evidence.
- Browser and server events share a deterministic `event_id` for deduplication.
- Never send treatment areas, service/clinical details, intake data, notes, photos, payment data, portal/token values, or raw sensitive records.
- Use only approved minimum event fields; hash identifiers only where legally and contractually permitted.
- Withdrawal before worker execution cancels dispatch.
- Provider errors, retries, responses, test mode, and reconciliation are visible to the studio without exposing secrets.
- Willow uses Willow's Meta Business/Dataset/Pixel and token, never Hone's corporate destination.

### GROW-03: Corporate marketing analytics

Hone's public marketing site may use privacy-safe analytics for page views, CTA clicks, pricing interactions, demo starts/submissions, and resource engagement. It must not send names, emails, studios, free text, tokenized URLs, or clinical/client data. Consent/cookieless behavior and retention must match the privacy notice.

## 15. Phase 9 — data portability, cancellation, and offboarding

### DATA-01: Canonical data inventory

Every table/object/provider data class is classified for owner, export, retention, legal hold, deletion, and audit.

### DATA-02: Asynchronous export

- versioned manifest;
- database records;
- images/objects;
- communications;
- consent/evidence;
- relevant payment metadata;
- hashes and schemas;
- explicit exclusions/retained exceptions;
- progress/retry;
- encrypted storage;
- short-lived signed download;
- expiration/purge;
- audit.

### DATA-03: Self-service cancellation

Owner can stop renewal, understand effective date/grace, reactivate, and see post-cancel access. Cancellation disables new external effects according to policy without destroying records.

### DATA-04: Offboarding orchestration

- disable public booking;
- revoke invitations, memberships, sessions, feeds, and client action links as policy requires;
- stop queued reminders/postcare/export jobs;
- handle Stripe Connect and outstanding money issues;
- generate export;
- apply retention/legal hold;
- purge eligible rows and objects;
- preserve required audit/financial evidence;
- show progress, exceptions, and completion.

### DATA-05: Accounting export

Provide a documented, privacy-minimized bookkeeping export for studio owners. Launch with clean CSVs covering charges, refunds, taxes, tips/fees where applicable, payouts/reconciliation identifiers, dates, and client-safe references. QuickBooks/Xero direct integrations are post-launch unless audit evidence shows they are necessary; do not imply direct integrations from a CSV export.

### Phase 9 exit

A synthetic and one controlled real studio complete export, accounting export, cancellation, reactivation, and offboarding without engineering intervention. Deletion evidence and retained exceptions are defensible.

## 16. Phase 10 — operations, reliability, analytics, abuse, and scale

### OPS-01: SLOs and synthetic journeys

Define SLOs for:

- signup/provisioning;
- public booking;
- portal login;
- chart save/edit; *(amended 2026-07-29: was "chart save/finalize" — finalization is retired, SEC-09)*
- payment charge/refund;
- subscription webhook lag;
- email/SMS queue and delivery;
- Google sync;
- export;
- support response.

Synthetic journeys cover the complete owner/client/practitioner loop without using Willow or real client data.

### OPS-02: Sentry error tracking and safe tracing

Implement Sentry for Next.js client, server, edge, route handlers, workers, and cron jobs with release/source-map correlation.

Required privacy controls:

- SDK-side `beforeSend`/event-processor redaction before data leaves Hone;
- no request bodies from clinical, intake, portal, payment, token, support, or booking routes;
- strip cookies, authorization headers, bearer tokens, query tokens, raw SQL/provider bodies, client names, email, phone, notes, and treatment/intake fields;
- pseudonymous organization/user identifiers only where required for triage;
- session replay OFF for authenticated clinical and client-facing sensitive routes;
- no attachments/profiles/logs until separately privacy-reviewed;
- alert routes, ownership, severity policy, release markers, and regression tests for redaction.

### OPS-03: Abuse and cost controls

Per tenant:

- signup/login/booking limits;
- email bombing protection;
- SMS/email quotas and budgets;
- storage/photo limits;
- import/export concurrency;
- bot limits;
- queue fairness.

Global:

- provider circuit breakers;
- kill switches;
- cost anomaly alerts;
- incident mode.

### OPS-04: Supabase PITR, backup, and disaster recovery

Before Gate C, evaluate and enable an appropriate production PITR retention window, fund it as a mandatory data-safety cost, and document ownership. PITR does not replace object-storage backup, provider recovery, or restore testing.

Exercise:

- restore to an isolated project/environment;
- verify schema, RLS, hashes, audit, clinical records, and tenant boundaries;
- test accidental deletion and bad-migration recovery;
- document RPO/RTO;
- verify Storage/object recovery separately;
- run scheduled restore drills and record evidence.

### OPS-05: Release attestation

Before merge and rollout:

- exact head;
- migration parity;
- capability manifest consistency;
- zero unresolved launch P0/P1;
- Willow contract;
- Studio A/B matrix lane;
- provider gates;
- rollback;
- merge CI;
- production deployment;
- post-deploy verification.

### OPS-06: Better Stack uptime, cron monitoring, and public status

Monitor at minimum:

- `hone.care`;
- public pricing/demo/resources;
- a synthetic Studio A booking journey;
- login/auth callback health without consuming live magic links;
- API/health endpoints designed to reveal no PHI;
- reminder, Calendar, communications, export, and cleanup worker heartbeats;
- SSL/domain expiry and critical provider dependencies where supported.

Create `status.hone.care` with components for application, booking, email, SMS, payments, Google Calendar, and support. Incident updates must be truthful and privacy-safe. Willow is not used as the synthetic monitor target.

### OPS-07: PostHog product analytics

Use a reviewed event taxonomy and data contract.

- Public marketing/demo analytics may run in consented or approved cookieless mode.
- Authenticated product analytics uses pseudonymous IDs and event names/properties that contain no client identity, appointment details, treatment/intake content, photos, notes, tokenized paths, payment data, or free text.
- Session replay is allowed initially only on public marketing/demo pages with all inputs and text masked/blocked and no request bodies.
- Session replay remains OFF on authenticated app, intake, portal, booking management, payment, treatment, photo, and token routes.
- Build dashboards for signup/onboarding/activation, not surveillance.
- Retention, region, access, deletion, consent, and vendor DPA decisions are documented before production activation.

### OPS-08: Resend email reliability

Resend already exists. Finish it rather than adding a second provider:

- durable email outbox and tenant-fair worker;
- deterministic provider idempotency keys;
- signed webhook verification;
- idempotent, out-of-order delivery event ingestion;
- delivered/bounced/complained/suppressed state;
- per-tenant sender/domain readiness and templates;
- bounce/suppression handling;
- queue age, retry, dead-letter, provider health, and synthetic canary;
- no email provider call inside a transaction-dependent user request after core commit.

### OPS-09: Operational dashboard and owner health

Create one tenant-safe operational view for platform operators and a narrower owner view covering subscription, onboarding, email/SMS, Calendar, payments, booking launch health, imports/exports, support cases, and unresolved errors. No dashboard should require broad manual provider-console correlation for routine support.

## 17. Chloe feedback integration

Chloe remains the primary practitioner feedback source for workflow quality. Feedback is essential but must enter a controlled register.

### 17.1 Feedback classes

- **Production-critical defect:** incorrect, missing, or misleading saved clinical/booking/payment state. May interrupt the roadmap.
- **Activation blocker:** prevents a new studio from completing setup or first value. Prioritized within the current phase.
- **Daily workflow friction:** harms calendar/charting speed or confidence. Scheduled alongside platform work when isolated.
- **Enhancement:** valuable but not a launch gate.

### 17.2 Known feedback to reconcile in Phase 0

- consultation notes and skin/hair analysis as distinct note types;
- observation chips and visible chart-note contract;
- multiple treatment areas under one settings block;
- left/right/bilateral laterality;
- simpler payments screen and faster checkout;
- probe lot/batch selection and auto-population;
- disinfectant replacement alerts in Notification Centre;
- intake-before-consultation and automatic intake delivery;
- signed photo consent and treatment consent;
- waitlist / closed to new clients;
- vacation mode;
- calendar-first workflow, month view, drag-to-create, mobile behavior;
- rebook last service;
- personal notes and birthday reminders;
- machine-frequency sticky default and reaction-chip vocabulary;
- referral tracking and inquiry-to-consult/client/referral conversion;
- treatment-plan phases/cadence/budget notes;
- client import from existing systems;
- onboarding-guide/video clarity;
- support-bot usefulness and escalation quality;
- owner-facing audit/trust information;
- analytics must never slow or expose the clinical workflow.

For each item, Phase 0 must record current implementation state, production proof, user validation, roadmap home, launch impact, and acceptance test. Items already shipped are verified and closed rather than rebuilt.

### 17.3 Feedback acceptance

A Chloe item is complete only when:

- the product contract is explicit;
- automated tests cover persistence and reload;
- relevant history/export/print surfaces agree;
- mobile/touch behavior works;
- Chloe completes a human validation script;
- no tenant/privacy/clinical invariant is weakened.

## 18. Dependency-ordered delivery train

This is an indicative sequence. Phase 0 may split or merge slices, but cannot reorder the safety dependencies without a roadmap update. The program remains one evolving codebase; no separate `v2` product fork is created.

1. **MKT-439** - finish, review, merge, deploy, and verify the marketing overhaul.
2. **ROADMAP-1.1** - commit this canonical roadmap and architecture decision.
3. **AUD-BASE** - exact-head audit, master findings register, capability manifest.
4. **SAFE-WILLOW** - Willow contract suite and release verifier.
5. **SAFE-SYNTH** - Studio A/B/C synthetic tenant fixtures.
6. **OPS-SENTRY** - Sentry with deny-by-default data scrubbing and release correlation.
7. **OPS-UPTIME** - Better Stack monitors, cron heartbeats, and `status.hone.care`.
8. **OPS-PITR** - PITR decision/enablement and isolated restore drill.
9. **SEC-IDENTITY** - booking identity and legal acceptance.
10. **SEC-MFA** - platform-admin/owner MFA and high-risk reauthentication.
11. **SEC-INTAKE** - intake tokens, concurrency, schema, promotion conflicts.
12. **SEC-BOOKING** - atomic booking, policy evidence, durable side effects.
13. **SEC-PAYMENT** - card replacement and webhook reconciliation.
14. **SEC-CONSENT** - marketing consent and provider outbox.
15. **SEC-CLINICAL** - **RETIRED (2026-07-29).** Was "finalization/amendment/chart-note contract". Finalization and signed amendments are retired (SEC-09); the chart-note contract (P1-13) is already closed. Nothing remains in the delivery train under this ID.
16. **SEC-DATA** - retention, Storage, export/purge foundations.
17. **SEC-AUDIT-UI** - owner-facing tenant audit history.
18. **TEN-MATRIX** - executed full Studio A/B boundary suite.
19. **TEN-ORG** - organization/default-location foundation and migration.
20. **TEN-ROLES** - capability model, ownership, invitation/session lifecycle.
21. **TEN-RESOURCE** - practitioner/resource calendar constraints and public assignment.
22. **SAA-SIGNUP** - verified owner signup and legal flow.
23. **SAA-PROVISION** - resumable atomic tenant provisioning.
24. **SAA-CHECKOUT** - plan catalog and Stripe Checkout.
25. **SAA-REDUCER** - subscription webhook inbox and canonical reducer.
26. **SAA-ENTITLE** - entitlements, dunning, suspension, billing portal.
27. **ONB-STATE** - onboarding state machine and progress.
28. **ONB-HEALTH** - dependency-aware launch health and test booking.
29. **ONB-IMPORT** - launch-safe import preview/commit/report.
30. **CAL-C4B** - controlled provider update.
31. **CAL-C4C** - controlled provider delete.
32. **CAL-RECOVERY** - recovery matrix, queue/quota hardening.
33. **CAL-SELF** - self-service connect/reconnect/disconnect/enable.
34. **COM-DOMAIN** - communications outbox, attempts, callbacks, suppression.
35. **COM-EMAIL** - Resend outbox, webhooks, delivery/suppression, canary.
36. **COM-WORKER** - tenant-fair worker, retries, quotas, health.
37. **COM-INBOUND** - indexed routing and STOP/START/HELP.
38. **COM-ISV** - Twilio subaccounts, Messaging Services, compliance onboarding.
39. **ATTR-CORE** - provider-agnostic marketing integration domain.
40. **ATTR-META** - Meta Pixel + Conversions API with durable consent/deduplication.
41. **OPS-POSTHOG** - privacy-safe event analytics; public-only masked replay.
42. **SUP-CASES** - tenant-scoped cases and diagnostics.
43. **SUP-BOT** - Claude-grounded support bot, evaluation, and escalation.
44. **EDU-ACADEMY** - guides, videos, in-app help, content workflow.
45. **TRUST-CENTER** - About Hone, trust center, subprocessors, status, AI-use statement.
46. **DATA-EXPORT** - canonical async export and manifest.
47. **FIN-EXPORT** - accounting CSV and reconciliation export.
48. **DATA-OFFBOARD** - cancellation, reactivation, retention, purge orchestration.
49. **OPS-SCALE** - SLOs, tracing, cost/abuse, restore evidence, operations dashboard, attestation.
50. **ROLL-1** - one consenting non-Willow external studio.
51. **ROLL-3** - three-studio cohort.
52. **ROLL-10** - ten-studio cohort and public-GA decision.

## 19. Rollout gates

### Gate A — Willow protected, synthetic only

- Willow behavior/flags unchanged.
- P1 register reconciled.
- synthetic A/B/C ready.
- provider work in shadow or disabled mode.
- no public signup;
- Sentry/Better Stack/PITR changes remain synthetic, privacy-reviewed, and Willow-safe.

### Gate B — Sam-controlled production tenants

- self-service test-mode signup/billing/provisioning;
- Calendar create/update/delete/recovery proven;
- Twilio test/controlled sender architecture proven;
- export/cancel/recovery rehearsed;
- all controls can return OFF;
- Sentry redaction tests, uptime/status, and restore rehearsal pass.

### Gate C — one consenting external studio, not Willow

- real CAD Hone subscription;
- self-service setup with no database/provider intervention;
- controlled SMS and Calendar;
- support cases and bot escalation;
- complete export;
- cancellation/reactivation rehearsal;
- no P0/P1;
- PostHog event analytics contains no sensitive data; Meta is per-studio and consent-gated; Resend delivery state is observable.

### Gate D — three studios

- queue fairness;
- no cross-tenant access;
- team-calendar concurrency;
- billing/dunning;
- support load and documentation coverage;
- provider cost/limits;
- incident exercise;
- owner MFA, audit UI, trust center, and accounting export are usable.

### Gate E — ten studios

- routine signup/onboarding requires no founder action;
- support bot resolves common questions and escalates safely;
- operations dashboards/SLOs work;
- one real export and offboarding;
- one reactivation;
- restore drill complete;
- no unresolved launch P0/P1.

### Gate F — public self-service

Change marketing CTA from walkthrough request to direct start only when the full lifecycle is generally available and supported.

### Gate G — multi-location

Add organization-wide clients/policies/reporting and location-local services, resources, taxes, roles, booking pages, and permissions. This is a separate launch after multi-studio GA.

## 20. Success metrics

### Product and activation

- signup to verified owner;
- verified owner to paid Checkout;
- paid to provisioned;
- provisioned to launch-ready;
- launch-ready to first booking;
- first booking to first chart;
- first chart to second appointment with useful Before Today;
- time to first value;
- onboarding step drop-off.

### Self-service

- percentage of studios provisioned without founder intervention;
- percentage launched without support intervention;
- founder/provider-dashboard interventions per studio;
- provisioning failure and recovery rate;
- billing self-service completion;
- export/cancellation self-service completion.

### Safety and trust

- open P0/P1 count;
- tenant-boundary negative test pass rate;
- cross-tenant incidents;
- clinical save/edit conflicts; *(amended 2026-07-29: was "clinical save/finalization conflicts" — finalization is retired, SEC-09)*
- audit completeness;
- deletion/export manifest completeness;
- Willow regression count.

### Providers

- SMS queued/sent/delivered/undelivered;
- opt-out rate;
- SMS spend and segments per tenant;
- email queue age/delivery;
- Calendar queue age/success/reconciliation/dead rows;
- Stripe webhook lag and reconciliation;
- provider incident duration.

### Support

- bot grounded answer rate;
- citation correctness;
- escalation accuracy;
- first response and resolution;
- repeat-ticket rate;
- documentation gap creation/closure;
- sensitive-data leakage: zero.

## 21. Launch decision checklist

Public self-service is GO only when:

- marketing claims match actual GA capability;
- exact production source and migration parity are attested;
- zero unresolved launch P0/P1;
- Willow contract is green and Willow is unchanged;
- full Studio A/B matrix passes;
- organization/default-location and roles are proven;
- signup, acceptance, Checkout, provisioning, entitlements, dunning, portal, cancellation, and reactivation work;
- onboarding and launch health work without founder action;
- treatment-memory activation loop is proven;
- Calendar outbound v1 is customer-ready or clearly optional/omitted;
- SMS is tenant-isolated and compliant or clearly optional/disabled;
- support cases, bot escalation, and safe human access work;
- export, retention, cancellation, and offboarding are defensible;
- SLOs, alerts, cost controls, incident runbooks, and restore evidence exist;
- one-, three-, and ten-studio gates have passed;
- no provider, database, environment, or code intervention is normal onboarding.

## 22. Immediate next actions

1. Adopt this document as version 1.1 and commit the Markdown source.
2. Keep Willow and future SaaS work in the existing Hone codebase; create no separate `v2` clone or long-lived fork.
3. Finish PR #439: exact-head review, thread resolution, full tests, merge, deploy, live verification.
4. Freeze major marketing redesign after #439.
5. Run the read-only Phase 0 audit and produce the master findings register/capability manifest.
6. Build the Willow contract and synthetic A/B/C fixtures.
7. Implement Sentry first with deny-by-default SDK redaction and no sensitive-route replay.
8. Add Better Stack monitors, cron heartbeats, and `status.hone.care`.
9. Decide/enable production PITR and run an isolated restore drill before adding an external non-Willow studio.
10. Audit current Resend, Meta/provider-selector, analytics, MFA, audit, export, and trust capabilities instead of assuming they are absent or complete.
11. Finish Calendar c4b/c4c/recovery under Sam-only controls.
12. Reconcile and close the applicable P1/security/clinical/tenant gates. **SEC-09 is excluded — it is RETIRED, not a gate to close.**
13. Build organization, RBAC, signup, billing, provisioning, onboarding, support, and offboarding in dependency order.
14. Finish Resend as the email platform and Twilio as a tenant-isolated ISV communications platform.
15. Build provider-agnostic attribution, then Meta Pixel/CAPI with durable consent and per-studio credentials.
16. Add PostHog privacy-safe events; keep replay limited to fully masked public marketing/demo surfaces.
17. Build the Claude documentation support bot, safe escalation, guides, videos, About Hone, and trust center.
18. Add canonical data export, accounting export, cancellation, reactivation, retention, and purge.
19. Roll out to one non-Willow studio, then three, then ten before public self-service.

# Appendix A — historical explicit P1 register to reconcile

- **P1-01:** Public booking identity can bind from typed email without proof.
- **P1-02:** Terms/privacy acceptance is UI-only and acceptance evidence can be fabricated.
- **P1-03:** Intake bearer links cannot be revoked/superseded.
- **P1-04:** Concurrent intake saves can lose answers.
- **P1-05:** Intake validation lacks strict values, lengths, cardinality, and total size.
- **P1-06:** Intake submission can overwrite a concurrent practitioner profile edit.
- **P1-07:** Cancellation/reschedule policy evidence is outside the state transaction.
- **P1-08:** Card replacement can retire the current card before replacement insert.
- **P1-09:** SetupIntent lineage rejection can be marked processed without usable local state.
- **P1-10:** Public booking can partially commit and later report failure.
- **P1-11:** Marketing consent persistence and provider dispatch are not atomic.
- **P1-12:** Retention, legal hold, export, erasure, and verified purge are incomplete.
- **P1-13:** Observation chips and visible narrative do not satisfy the chart-note contract.

# Appendix B — broader launch-critical categories to reconcile

- ~~immutable finalized treatment history and attributable amendments~~ — **RETIRED 2026-07-29** (SEC-09). Replaced by: **attributable ordinary treatment history** — actor attribution, timestamps, `session_audit` edit history, whole-session-copy provenance and tenant isolation on records that stay editable;
- submitted/reviewed intake immutability;
- non-forgeable transaction-mandatory audit evidence;
- hosted storage/photo policy and lifecycle proof;
- platform admin identity and scoped support;
- complete multi-tenant boundary execution;
- practitioner/resource-aware calendar capacity;
- per-tenant payment/provider approval;
- durable jobs, observability, and restore proof;
- support, export, cancellation, retention, and offboarding;
- public signup, SaaS billing, entitlements, onboarding, and lifecycle automation.

# Appendix C — official provider design references

The implementation ADR for each provider must pin the exact official documentation reviewed, access date, account/region assumptions, data classification, retention, and contract/DPA decision. Provider documentation changes do not automatically change Hone behavior; a reviewed capability update is required.

- **Twilio:** ISV A2P 10DLC onboarding, account/subaccount architecture, Messaging Services, Advanced Opt-Out, status callbacks/Event Streams, sender registration, throughput, and compliance lifecycle.
- **Google Calendar:** event creation/update/delete, ETags and conditional requests, deterministic event IDs, OAuth scopes, quota management, exponential backoff with jitter, invalid-sync-token recovery where applicable, and production quota testing.
- **Supabase:** MFA, Auth session/recovery controls, RLS, Storage policies, database backups, Point-in-Time Recovery retention/pricing, and isolated restore procedures.
- **Sentry:** Next.js client/server/edge setup, releases/source maps, SDK-side data scrubbing, `beforeSend`, replay privacy controls, retention, regions, and deletion. Hone must scrub before ingestion because post-ingestion scrubbing cannot be relied upon as the primary control.
- **Better Stack:** uptime monitors, heartbeat/cron monitors, incident escalation, status pages, component status, subscriber updates, API automation, and custom-domain requirements.
- **Resend:** sending idempotency keys, signed webhooks, at-least-once/out-of-order delivery, `svix-id` deduplication, bounce/complaint/suppression events, domains, and delivery-state reconciliation.
- **PostHog:** event taxonomy, pseudonymous identity, property allowlists, masking/blocking, replay exclusions, data regions, retention, deletion, DPA, and role access. Public-only replay remains the launch default.
- **Meta:** Pixel and Conversions API setup, consent requirements, restricted-data rules, event matching, deterministic `event_id` deduplication, test events, dataset/business ownership, token security, deletion, and regional/legal requirements. Exact current official documentation must be re-verified before implementation because Phase 0 has not yet proven the existing integration state.
- **Anthropic:** API security/privacy, data handling and retention, regional availability, model/version policy, rate limits, evaluation guidance, and enterprise terms. The launch support assistant is documentation-only and receives no clinical data.

# Appendix D — definition of program completion

The roadmap program is complete when Hone is a safe, self-service, supportable multi-studio SaaS for independent one-location practices; Willow remains stable; ten unrelated studios operate without routine founder intervention; the treatment-memory loop drives activation; provider systems are tenant-isolated and recoverable; customers can obtain support and leave with their data; and every public claim matches a generally available capability.

---

# Annex A — Exact-head status reconciliation (2026-07-18, head 0a5741f)

This annex records where exact-head evidence CHANGES the status assumed by the v1.1 baseline
above. Strategic decisions are untouched. Full evidence: `P1_MASTER_REGISTER_2026-07-18.csv`
and `P1_RECONCILIATION_REPORT_2026-07-18.md` (same directory); capability axes:
`CAPABILITY_MANIFEST.json`.

- **Phase 0 exact-head reconciliation: DONE** (this annex + register). 34 source P1s → **3
  PRODUCTION VERIFIED (analytics trio, PR #450 merged `32b6eef` + real-browser verified) / 5
  DEPLOYED / 16 PARTIALLY FIXED / 10 OPEN** (0 FIXED IN CODE).
- **Closed since the 2026-07-10 audit** (evidence-verified): HNE-SEC-001 (migration 0115),
  HNE-SEC-002 (0116), HNE-REC-002 (0118), P1-13 (chips contract). HNE-REC-001 enforcement is
  deployed via 0119/0120 but **flag-OFF** (protects nothing yet; enablement needs separate
  authorization + Chloe validation).
- **New P1 class since v1.1:** analytics (PostHog #447/#449). P1-ANALYTICS-01/-02/-03 contained
  by PR #450 — **MERGED (`32b6eef`) + DEPLOYED (Vercel `8iDB4Je`, 2026-07-19) + PRODUCTION
  VERIFIED (session 3)**. The deployed boundary is fail-closed by (event, surface): only the 12
  canonical marketing routes emit browser events; the authenticated app, booking, portal, all
  token routes, login/auth and payment send nothing. Opaque IDs runtime-validated; server
  analytics decoupled from request paths. Real-browser evidence: one sanitized `/ingest/e/`
  capture on `/pricing`; zero capture on every sensitive surface (only the SDK `config.js` load,
  not an event). No migration; worker off; Willow untouched.
- **Historical P1 set correction:** the roadmap's P1-01..13 list remains accurate for the 9
  still-open/partial items; P1-13 is closed; P1-03..08/10/11 are PARTIALLY FIXED with specific
  remaining criteria (see register).
- **Program-level P1s** (HNE-SAA-001 self-service, HNE-LOC-001 multi-location): confirmed
  absent at head; remain OPEN as roadmap Waves — not compressible into patches.
- **Job registry correction:** `vercel.json` now registers 3 crons (materialize-breaks active;
  calendar-reconcile + calendar-sync deployed dormant behind `worker_enabled=false`). The
  HNE-JOB-001 gap narrows to: no canonical registry/health model and no scheduled reminder
  dispatch attestation.
- **Wave 1 test foundation — in progress (does NOT close a P1):** SAFE-SYNTH synthetic Studio
  A/B/C fixtures + cross-tenant isolation + cleanup **merged** (PR #452, `409021b`), *partially
  delivered* (Studio C failure injection still inert vocabulary). SAFE-WILLOW **treatment-memory
  activation slice merged** (PR #454, `c58b785`) — the activation loop is now continuously tested
  (DB + browser, synthetic tenant, never Willow). SAFE-WILLOW remains partially delivered
  (appointment-lifecycle/portal, communications, payments, photos/records, clinical finalization,
  practitioner/provider gates still to come). **Chloe human validation stays separate from this
  automated evidence.** No P1 aggregate classification changed; **Gate A still does not pass**;
  no external studio onboarded.

---

# Annex B — Clinical finalization retirement (2026-07-29)

Annex A above is a **dated 2026-07-18 record** and is retained verbatim as history. Two of its
lines are **superseded** by the product decision recorded below; the decision, not Annex A, is
current.

**Decision (2026-07-29, ACCEPTED, Sam):** Hone will **not** offer signed or cryptographically
finalized clinical records. Practitioner-signed snapshots, immutable finalized records, "snapshot
v2", cryptographic clinical-record hashes as a product feature, and any correction/amendment
workflow built around signed snapshots are **permanently rejected**. Treatment sessions remain
**ordinary, editable operational records**; practitioners correct charting mistakes by editing
them. Enforced in the database by migration **0159** (five mechanisms: both flags pinned `false`
by CHECK constraint; `EXECUTE` revoked from every runtime role on the finalize/correct/amend/
snapshot RPCs; transitions of `sessions.record_status` into `finalized`/`void` refused; `INSERT`
refused on `clinical_record_snapshots` / `clinical_record_amendments` / `clinical_audit_events`;
plus privilege hardening that breaks nothing today). 0159 **drops nothing** and performs **zero
data operations**. `0158` is intentionally skipped — DRAFT PR #481 carries a different,
superseded migration under that number on a branch retained for audit evidence.

Full decision record, including the retained legacy artifact and the reintroduction bar:
**`docs/decisions/clinical-finalization-retired.md`**.

**Superseded Annex A lines:**

- *"HNE-REC-001 enforcement is deployed via 0119/0120 but **flag-OFF** (protects nothing yet;
  enablement needs separate authorization + Chloe validation)."* — **Superseded.** There is no
  authorization to seek and no Chloe validation to schedule. The flags cannot be turned on by any
  role. HNE-REC-001 is closed as **RETIRED — will not be enforced by signed snapshots.** The
  record-integrity requirement it represented is met instead by retained ordinary audit:
  `session_audit`, `record_keeping_audit_events`, `session_copy_operations`,
  `admin_action_events`, `client_portal_access_events`, with actor attribution and timestamps.
- *SAFE-WILLOW remaining scope listing "clinical finalization" among the slices "still to come."*
  — **Superseded.** That slice is **cancelled**, not pending; see `WAVE1_DESIGN.md` slice 7. Its
  replacement is the retirement drift guard `tests/db/clinical-finalization-retired.db.test.ts`.
  The remaining SAFE-WILLOW slices (appointment-lifecycle/portal, communications, payments,
  photos/records, practitioner/provider gates) are unaffected and still outstanding.

**Roadmap items retired or amended by this decision:** **SEC-09** (retired in place, ID kept) ·
**SEC-CLINICAL** in the delivery train (§18 item 15) · **SEC-14** clinical slice · Phase 1 exit
criterion on "immutable/versioned records" · Appendix B first bullet · the OPS-01 SLO and the
Safety-and-trust metric that named "finalize"/"finalization". Nothing else in this roadmap changes.

**What this decision explicitly does NOT license.** It is not permission to weaken tenant
isolation, remove audit data, allow cross-studio change, assign one client's session to another
client, let browser users bypass application commands, or permit `authenticated` `TRUNCATE` or
arbitrary mutation of clinical tables. Migration 0159 moves in the opposite direction on several
of those.
