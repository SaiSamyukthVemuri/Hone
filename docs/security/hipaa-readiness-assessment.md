# HIPAA readiness assessment (HIPAA-READY-01, issue #828)

> **Hone is not verified HIPAA compliant.** This document is an evidence
> inventory and gap matrix. It is not a compliance determination, a legal
> opinion, an HHS certification, or a launch date. Green CI, encryption,
> SOC 2, US hosting, or a vendor's general HIPAA eligibility do not
> establish compliance.
> **Do not quote this document to a studio or prospect as a compliance claim.**

- **Assessed tree:** production branch `claude/build-hone-saas-hOex7` at
  `6c5eac80`.
- **Assessed on:** 2026-10-11.
- **Method:** source reading plus current public vendor and regulator
  pages. It used no hosted writes, no provider settings, no vendor
  contact, and no real patient data.
- **Companion:** the agreement, configuration and cost decisions live in
  [hipaa-decision-packet.md](./hipaa-decision-packet.md).
- **Owner:** Sam (operator) until a named security/privacy official is
  appointed. Appointing that person is gap G-01.

## 0. How to read the statuses

| Status | Meaning |
|---|---|
| **READY** | Evidence exists in source or a dated read-only check, and it covers the control for the scoped workflow. |
| **PARTIAL** | Some of the control exists; the named remainder does not. |
| **MISSING** | Source or configuration evidence shows the control is absent. |
| **UNKNOWN** | Not yet observed. Unknown is **not** missing and **not** clean. It needs the named check. |

Rules for maintaining the statuses:
- A historical finding is not automatically a current vulnerability; re-check it before acting.
- A source fix is not an executed agreement.
- An agreement is not a configuration.
- Update a row only with a new dated check, and keep the old evidence in history (git).

## 1. Threshold question: is HIPAA triggered for a given studio?

HIPAA applies to a **covered entity**: a health plan, a clearinghouse, or a
health care provider that electronically transmits health information in an
HHS standard transaction, such as insurance claims or eligibility checks
([CMS, "Are You a Covered Entity?"](https://www.cms.gov/priorities/key-initiatives/burden-reduction/administrative-simplification/hipaa/covered-entities)).
It also applies to that entity's **business associates**. Many electrolysis
studios are cash-pay and may not be covered entities. Some are, for example
a studio inside a medical practice, or one that bills insurance for
gender-affirming hair removal.

- **Decision D-0 (legal/compliance, not engineering):** for each prospective
  studio, including the Los Angeles studio that asked, confirm whether it is a
  covered entity and which workflows are in scope.
  - If it is not a covered entity, Hone is not its business associate under
    HIPAA.
  - State privacy law still applies, for example California's CMIA and CCPA.
    So does Hone's own privacy policy.
  - This assessment treats every flow **as if** HIPAA applied, so that the
    answer to D-0 does not change the engineering work.
- Until D-0 is answered, every workflow is treated as HIPAA-scoped.

## 2. What counts as PHI in Hone

In a covered studio's hands, nearly all client-linked data is PHI. That
includes:
- identity and contact details;
- appointment dates and times tied to a person, and the person's relationship
  to a named studio;
- intake answers, which include medical history flags (`lib/intake/review-flags.ts`);
- treatment notes and charting;
- consent signatures;
- photos;
- payment records tied to a treatment.

Opaque client and appointment UUIDs are **record identifiers**: they are PHI
when they sit next to any health or appointment context. A bare studio slug
in a URL a patient visits can still reveal a care relationship.

PHI-bearing tables (from `supabase/migrations`, at minimum):
- **Clients and records:** `clients`, `client_intake_forms`, `client_clinical_notes`, `client_personal_notes`, `client_pinned_notes`, `client_consent_signatures`.
- **Treatment:** `sessions`, `session_blocks`, `session_block_areas`, `electrolysis_entries`, `laser_entries`, `treatment_images`, `photos`, `treatment_plans`, `treatment_plan_stages`, `treatment_goals`.
- **Record history and imports:** `clinical_record_snapshots`, `clinical_record_amendments`, `imported_treatment_memories`.
- **Appointments and waitlist:** `appointments`, `new_client_waitlist_entries`, `waitlist`.
- **Portal:** `client_portal_messages`, `client_portal_message_replies`.
- **Payments:** `appointment_payments` and the Stripe attempt tables, which carry client and session ids.
- **SMS:** `sms_outbound_messages`, which has no body and no phone number but still links an id to a send.
- **Audit tables** that carry client or record ids.

## 3. PHI flow inventory (source-traced)

Each row is a path PHI can take out of the database. "Provider-visible"
means bytes the provider can read.

| # | Flow | Source evidence | Provider-visible PHI | Status |
|---|---|---|---|---|
| F1 | App rendering, server actions, API and cron | Next.js on Vercel (`app/**`, `vercel.json` crons) | Everything the app reads passes through Vercel functions; runtime logs are whatever code logs | **UNKNOWN** — the Vercel BAA (team-specific) and a log-payload audit are both unverified |
| F2 | Database, auth, backups | Supabase Postgres and Auth (`lib/supabase/**`) | All PHI at rest | **PARTIAL** — Pro plan observed (issue #828 baseline); no BAA, no HIPAA add-on, Team plan not held |
| F3 | Treatment photos | Private bucket `treatment-images` (migrations 0092/0093); service-role upload; signed URLs with a 60 s TTL (`lib/images/treatment-images.ts`) | Image bytes in Supabase Storage | **PARTIAL** — the private bucket and short URLs are good; database backups do **not** cover Storage object bytes (G-12) |
| F4 | Patient email | Resend via `lib/email/client.ts`; 14 templates in `lib/email/templates/` | Subjects alone carry PHI: "Appointment confirmed: {service} with {studio} on {day}", "Reminder: {service} today at {time}", "Aftercare for your appointment with {studio}", and "New booking: {clientName} – {service}" to practitioners. Bodies carry aftercare text, times, and manage/intake/portal tokens. Recipients are patient addresses | **MISSING (blocker)** — Resend states it "is not HIPAA compliant and cannot sign a Business Associate Agreement" ([resend.com/security](https://resend.com/security), read 2026-10-11) |
| F5 | Patient SMS | Twilio (`lib/sms/twilio.ts`, `lib/sms/templates.ts`, `lib/waitlist/delivery/*`); status and inbound webhooks under `app/api/twilio/*` | "{studio}: confirmed for {time}", reminders, intake and manage links, waitlist invitations; the patient's phone number | **UNKNOWN** — Twilio offers a BAA for eligible products; the account, products (Messaging Service, Verify), BAA execution and retention are unverified |
| F6 | Phone verification | Twilio Verify (`lib/waitlist/mobile-verification/twilio-verify-provider.ts`) | Phone number plus the studio context of a waitlist | **UNKNOWN** — is Verify on Twilio's HIPAA-eligible list for this account? |
| F7 | Calendar mirror | Google Calendar (`lib/google-calendar/sync/serializer.ts`) | Start and end time with a constant summary; "ZERO client identity / clinical / payment / location / description" | **READY (minimized)** — still sends appointment *times* into a studio-owned Google account; a Workspace BAA is the studio's own concern (G-15) |
| F8 | Calendar feed | `app/calendar-feed/[token]` (bearer token) | Constant summary "Hone appointment" plus times | **READY (minimized)** |
| F9 | Payments | Stripe Connect on the studio's own account (`lib/stripe/setup-intent.ts`, `lib/billing/session-payment-charge.ts`) | New Customer and SetupIntent writes carry opaque ids only (`hone_studio_id`, `hone_client_id`, `hone_source`) since #857 (merged `ce133c18`); **historical** Customers created before it still hold **`hone_client_name`**. Session and appointment ids appear on charges; the charge description is built per reason | **PARTIAL**. Payment processing has a HIPAA exemption. New writes are minimized, but historical Customers still carry the name (G-09) |
| F10 | Error tracking | Sentry (`instrumentation-client.ts`, `sentry.*.config.ts`) | `sendDefaultPii: false`, deny-by-default scrubbers (`lib/observability/sentry-scrub.ts`), Replay and Logs disabled | **PARTIAL** — strong minimization, no BAA. Local and CI runs also report to the production project (hard-coded DSN) |
| F11 | Product analytics (browser) | PostHog (`instrumentation-client.ts`, `lib/analytics/client-boundary.ts`) | Fail-closed to marketing routes; `disable_session_recording: true`; `mask_all_text` | **READY (minimized)** — subject to the G-08 payload capture |
| F12 | Product analytics (server) | PostHog node (`lib/analytics/server.ts`) | Practitioner UUID or `studio:<id>`; allowlisted props `studio_id`, `modality`, `is_new_session`, `source`, `provider`, `livemode` | **PARTIAL** — no patient identifier by design; verify with synthetic events (G-08) |
| F13 | Web Analytics and Speed Insights | Vercel, mounted in the authenticated `app/(app)/layout.tsx` and `app/book/layout.tsx` | Page URLs such as `/clients/<uuid>/sessions/<uuid>` and `/book/<studio-slug>` | **MISSING (decision)** — record identifiers in URLs go to an analytics product whose BAA coverage is unverified (G-07) |
| F14 | Rate limiting | Upstash Redis (`lib/rate-limit/public.ts`) | Keys are a **hash** of IP or email plus the studio slug | **PARTIAL** — hashed, but email plus studio is still a relationship; the Upstash BAA and plan are unverified |
| F15 | Ops alerts | `ops_alerts` table plus "[Hone CRITICAL]" email via Resend | Designed to be PHI-free (tests under `tests/source-guards`, `tests/app/*privacy*`) | **PARTIAL** — re-audit payloads; they still go through Resend |
| F16 | Supabase Auth email | Practitioner invite and password reset | Workforce email addresses (not patients) | **PARTIAL** — **verified 2026-10-12: no custom SMTP is configured** (`smtp_host` null), so auth email goes through Supabase's built-in sender; workforce-only, but production auth email should move to a configured sender as part of D-2/D-4 |
| F17 | Patient portal | Magic links (Resend), portal messages (`client_portal_messages`), "New secure message from {studio}" notifications | Message bodies stay in the database; notifications reveal the studio relationship | **MISSING** — same Resend dependency as F4 |
| F18 | Exports | `app/(app)/settings/data/actions.ts`, `lib/export/*` (JSZip and PDF) | A **named subset** of the studio's records, downloaded as a ZIP to the practitioner's device. `lib/export/resource-registry.ts` marks other studio-owned records as `pending` (TRUTH-01B). These include client intake forms, treatment images and legacy photos (metadata and binaries), and payment records (for example `appointment_payments`, `payment_charge_attempts`, `stripe_refunds`) | **PARTIAL**. The export is audited (`audit_logs`), but it is **incomplete** for patient access and offboarding (G-21). Device handling is a policy control (G-20) |
| F19 | Demo and early-access forms | `app/_components/DemoForm.tsx`, `demo_requests` (#826) | Free text could carry patient detail | **PARTIAL** — business-only by design; a free-text field can become a PHI channel (G-17) |
| F20 | Developer, CI, preview and test paths | GitHub, CI local Supabase stacks, Vercel previews, Playwright fixtures | Synthetic fixtures by convention, but **verified 2026-10-13: Vercel previews share the production Supabase URL and service-role key, plus live Twilio and Resend credentials** (G-16) | **MISSING, HIGH.** Previews have production-data access, and there is no written "no real PHI in dev tools" rule (G-16) |
| F21 | AI/OCR | `lib/intake/review-flags.ts`: "NO AI/OCR" | None | **READY** — no AI processor in the tree |

## 4. Processor register

None of these rows is evidence of an executed agreement. Each "BAA
available" fact comes from the vendor's public page, read 2026-10-11.

| Processor | Product(s) used | PHI today | BAA availability (public) | Hone account status |
|---|---|---|---|---|
| Supabase | Postgres, Auth, Storage | Yes, all | BAA on **Team or higher** with the HIPAA add-on; the project must be marked HIPAA; customer duties include org MFA, PITR, SSL enforcement, network restrictions and connection logging ([shared responsibility](https://supabase.com/docs/guides/deployment/shared-responsibility-model), [HIPAA projects](https://supabase.com/docs/guides/platform/hipaa-projects)) | Pro plan (issue baseline); BAA, add-on and High Compliance **not held** |
| Vercel | Functions, CDN, cron, runtime logs, Web Analytics, Speed Insights | Yes, in transit and logs | BAA for **Pro and Enterprise**; Pro buys a HIPAA add-on in Billing ([compliance](https://vercel.com/docs/security/compliance), [guide](https://vercel.com/kb/guide/hipaa-compliance-guide-vercel)); Secure Compute is optional and Enterprise-only | Team plan, add-on and BAA **UNKNOWN** (connector access blocked) |
| Resend | Transactional email | Yes, subjects and bodies | **Cannot sign a BAA** ([security FAQ](https://resend.com/security)) | Active; **blocker for PHI** |
| Twilio | Programmable Messaging, Verify | Yes, phone and appointment context | BAA for listed HIPAA-eligible products, and only on **Security or Enterprise Edition** ([twilio.com/hipaa](https://www.twilio.com/en-us/hipaa), FAQ, read 2026-10-12) | Account, products and BAA **UNKNOWN** |
| Stripe | Connect (studio accounts), SetupIntents, charges | Opaque ids in new metadata; the client name remains on historical Customers | Payment-processing context; the Services Agreement defines PHI ([stripe.com/legal/ssa](https://stripe.com/legal/ssa)); applicability to Hone is **UNKNOWN** | Live; minimize (G-09) |
| Sentry | Error tracking | Designed out (scrubbed) | Publishes a Business Associate Amendment v1.0.1 (2026-01-15) ([sentry.io/legal/baa](https://sentry.io/legal/baa/)); plan eligibility unverified | No BAA known |
| PostHog | Analytics (browser, marketing only; server, practitioner) | Designed out | BAA "contact us" ([PostHog HIPAA](https://posthog.com/docs/privacy/hipaa-compliance)) | No BAA known; keep PHI out |
| Upstash | Redis rate limiting | Hashed identifiers | States Redis is HIPAA compliant ([compliance](https://upstash.com/docs/common/help/compliance)); BAA and plan terms unverified | **UNKNOWN** |
| Google | Calendar API (the studio's own calendar) | Times only | Workspace BAA covers "Included Functionality" only, not consumer accounts or add-ons ([Google](https://support.google.com/a/answer/3407054)) | Studio-side; Hone sends minimized events |
| GitHub | Source and CI | Must be none | Not a PHI processor; **must stay that way** | Enforce via G-16 |

## 5. Gap matrix

The owner is Sam unless a lane is named. Gate: every row whose status is
**not READY** (MISSING, PARTIAL or UNKNOWN) blocks both **P**,
HIPAA-dependent patient onboarding, and **C**, any public HIPAA claim. A
**READY** row blocks neither, though its evidence must stay current. There is
no separate Gate column: the status column is the gate.

| ID | Area | Status | Evidence (2026-10-11) | Remediation | Lane |
|---|---|---|---|---|---|
| G-01 | Security/privacy official, risk analysis, risk management plan (§164.308(a)(1)–(2)) | **MISSING** | No such record in the repo | Appoint the official; run and document a risk analysis that uses this inventory | Sam + qualified advisor |
| G-02 | Supabase BAA, Team plan, HIPAA add-on, HIPAA project, High Compliance | **MISSING** | **Verified 2026-10-12 (Management API, read-only):** the project's organization is on plan `pro`; project `ACTIVE_HEALTHY`, region `us-east-1`, Postgres 17.6. No BAA or HIPAA add-on is possible on Pro | Packet §2.1; **no purchase or toggle from this task** | Sam |
| G-03 | Supabase org MFA, PITR, SSL enforcement, network restrictions, connection logging | **MISSING (mostly)** | **Verified 2026-10-12, read-only (CLI `get` and Management API):** **SSL not enforced**; **network restrictions allow `0.0.0.0/0` and `::/0`** (no restriction); **PITR disabled** (`pitr_enabled: false`; daily physical backups, 8 listed); **no custom Postgres config** (`log_connections` therefore at the platform default, which Supabase documents as off for new projects; confirm with a read-only `show log_connections`); the org's **single member (Owner) has MFA enabled**, but whether the org *enforces* MFA is not in the response | Packet §2.1, each a separate authorized change; network restrictions need a Vercel-egress compatibility check first | Sam |
| G-04 | Vercel BAA and covered features | **UNKNOWN** | The team plan could not be read | Confirm plan and add-on; list which features are in BAA scope (Web Analytics? Speed Insights? log drains?) | Sam |
| G-05 | Patient email through a BAA-eligible route | **MISSING** | Resend cannot sign a BAA. Previews minimized: subjects in #859, hidden preheader in #870. The provider still receives recipient, From, full bodies and the ICS attachment (`docs/security/email-provider-visible-inventory.md`). **Neither PR clears G-05.** Delivery ledger is provider-neutral; a second provider is additive after D-4 | Packet §3.1; decision D-4 | Delivery lane after D-4 |
| G-06 | SMS under a Twilio BAA | **UNKNOWN** | F5/F6 | Confirm products are on the eligible list; execute the BAA; sort out A2P separately | Sender lane (#824) |
| G-07 | Vercel Web Analytics and Speed Insights on authenticated and booking routes | **PARTIAL — fix in draft #842** (CI green at `14f2a6dc`; not merged or deployed) | `app/(app)/layout.tsx:256`, `app/book/layout.tsx` mount `SafeAnalytics` | Either confirm BAA coverage or unmount from `(app)` and `/book`, or add a `beforeSend` that strips ids | Small PR after D-3 |
| G-08 | Analytics and error payloads verified at the wire | **PARTIAL** | Strong source boundaries (F10–F12) | Capture outgoing payloads with synthetic data across key journeys; pin with tests | Small PR |
| G-09 | Stripe metadata minimization | **PARTIAL.** New writes are fixed by #857 (merged `ce133c18`; its test rejects client-name metadata). Historical Customers keep `hone_client_name`, and there is no reader of it anywhere | `hone_client_name` on Customers created before #857 | New writes: done. Historical Customers: a backfill only with Sam's authorization (Audit lane) | Payment lane |
| G-10 | MFA for practitioner and owner accounts | **MISSING** | Project Auth has TOTP **enroll and verify enabled** (verified 2026-10-12), phone MFA off; the app checks no `aal2` anywhere in `app/`, `lib/`, `middleware.ts`, so MFA is available but never required | Require TOTP (aal2) for owners first; coordinate with #824 RBAC / WorkOS | #824 |
| G-11 | Session timeout and revocation | **MISSING** | **Verified 2026-10-12:** `sessions_timebox = 0` and `sessions_inactivity_timeout = 0` (no limit), single session per user off, `jwt_exp = 3600`, refresh-token rotation on. Also: leaked-password protection **off**, minimum password length **6** | Decide timebox and inactivity limits and password policy (some are paid features; check against the plan decision) | Sam |
| G-12 | Backup coverage of Storage objects, plus a restore drill | **PARTIAL — local synthetic drill passes in draft #848** (no scheduled object export; hosted backup config unverified) | "Database backups do not include objects you store via the Storage API" ([Supabase backups](https://supabase.com/docs/guides/platform/backups)); no drill on record | Document RPO/RTO; add a Storage backup route; run one isolated synthetic restore drill | Ops |
| G-13 | Audit of clinical **reads** and exports | **PARTIAL** | `clinical_audit_events` records only `correction` and `amendment`; `audit_logs` covers export and archive; portal access is evented | Decide read-audit scope (record open, photo view, export, support access); a small append-only event table | #824-adjacent PR |
| G-14 | Role-based least privilege (owner, practitioner, receptionist, support) | **PARTIAL** | Tenant RLS exists; role capabilities pending | Do not build competing RBAC; track in #824 | #824 |
| G-15 | Google Calendar destinations | **READY (minimized)** | Serializer exports times only | Studio guidance: use a Workspace account under its own BAA if it wants times there | Docs |
| G-16 | No real PHI in dev, CI, preview, screenshots or GitHub | **MISSING — HIGH** | **Verified 2026-10-13 from Vercel env metadata (names and targets only, no values read):** `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` and **`SUPABASE_SERVICE_ROLE_KEY`** are single variables targeting **both preview and production**, as are the Twilio credentials, `RESEND_API_KEY`, the Upstash credentials, `CRON_SECRET`, the signing secrets and `OPS_ALERT_EMAILS`. Only the Stripe secret, webhook and live-mode variables are production-only. So **every preview deployment, built from any pushed branch including unreviewed code, runs with service-role access to the production database (all PHI)** and live messaging credentials. Mitigations that exist: Vercel SSO protection on previews; the SMS-00 fence refuses non-production Twilio sends. Resend in previews is not fenced as far as source shows. The local/CI Sentry gate is deferred (Sentry lane) | Give previews their own Supabase project with synthetic data and re-scope every shared secret to production only. This is a **per-change hosted authorization** plus B2 spend. Until then, the ops01 containment rule stands: no mutation or demo tests on any preview | Sam (authorization); ENG (plan) |
| G-17 | Free-text business forms | **PARTIAL** | DemoForm and `demo_requests` (#826) | Field copy "do not include patient information"; keep it a business-only flow | #826 |
| G-18 | Security Advisor findings disposition | **UNKNOWN** | Issue baseline: no ERROR; WARN/INFO unclassified | Classify each against callers and grants (§6); **no blanket fixes** | DB lane |
| G-19 | Incident response, breach assessment and notification (§164.308(a)(6), Part 164 Subpart D) | **MISSING** | No procedure document | Write the procedure; include vendor notice paths | Sam + advisor |
| G-20 | Workforce training, device and access practice, contingency plan, periodic review | **MISSING** | None on record | Policies proportionate to a small team | Sam + advisor |
| G-21 | Retention, export, correction and offboarding policy | **PARTIAL** | Clinical amendments are append-only. The export is a **named subset** (F18): intake forms, treatment images and photos, and payment records are still `pending` (TRUTH-01B) | Complete the export for the pending studio-owned records (TRUTH-01B) before relying on it for patient access or offboarding. Separate legal retention decisions from the software's immutable history | Sam + advisor; export completeness: TRUTH-01B owner |
| G-22 | Studio-to-Hone BAA template | **MISSING** | None | Have counsel draft it; packet §1 lists its required content | Counsel |

## 6. Security Advisor findings: classification method

Classify each finding against current source, effective grants, and the
inventory of legitimate callers. Never make a change just to turn the list
green.

| Lint | Default disposition | Check before any fix |
|---|---|---|
| `0011_function_search_path_mutable` | Fix candidate (`set search_path = ''` or pinned) | That the function body is schema-qualified; one migration per batch, never edit applied ones |
| `0028`/`0029` SECURITY DEFINER executable by anon/authenticated | Often **intentional** (membership helpers, named booking/clinical/payment RPCs) | `tests/security/clinical-rpc-grant-guard.test.ts` and caller inventory; revoke only where no legitimate caller exists |
| `0008_rls_enabled_no_policy` | Often **intentional** default-deny or service-only tables | Confirm there is no client read path; document it as intended |
| `0014_extension_in_public` | Usually accept | Scheduling extensions must not be moved casually |

Any resulting migration needs a fresh migration census
(`npm run migration:state`) at the time. Applied migrations, including
0209 and 0210, are frozen.

## 7. Open questions

1. D-0, per studio: covered entity or not; which workflows are in scope.
2. Which Vercel features does the HIPAA add-on cover? Is the Hone team on Pro?
3. Supabase HIPAA add-on price and High Compliance prerequisites (compute size, PITR).
4. Twilio: are the Messaging Service and Verify both on the eligible list for this account? Which subaccount sends?
5. Upstash: BAA availability and plan prerequisites.
6. Sentry: plan eligibility for the BAA, or keep PHI out entirely.
7. Is Stripe metadata needed beyond opaque ids?
8. The hosted Supabase Auth SMTP provider.

## 8. Change log

| Date | Change |
|---|---|
| 2026-10-11 | First assessment (HIPAA-READY-01), source at `6c5eac80`. |
| 2026-10-15 | Codex review of `0504724a`. F18 and G-21 now describe the export as a named subset (intake forms, treatment images and photos, and payment records are pending, TRUTH-01B). The gate rule is stated: only non-READY rows block P and C. |
| 2026-10-15 | Codex review of `2931821f`. G-09 now records #857 as merged (new writes minimized; historical Customers remain). F20 now matches the verified G-16 exposure (MISSING, HIGH). The decision packet's option M now includes the Vercel HIPAA BAA at $350/mo (public price). |
| 2026-10-13 | **G-16 raised to MISSING, HIGH:** preview deployments share the production Supabase service-role key and URL, plus live Twilio and Resend credentials (Vercel env metadata, read-only; reported by ops01 and verified). |
| 2026-10-12 | Packet §0: the open questions reduced to four business decisions (B1 to B4); routine items adopted as engineering defaults under the delegation; hosted changes listed as per-change authorizations. |
| 2026-10-12 | #870 green (CI 38272759445) and Codex-clean at `a334c5f3`. Waitlist preheader **owner unassigned** (SMS and DB/WAIT both declined; packet D-9 lists two fix options). |
| 2026-10-12 | Preheader draft #870 (stacked on #859) and the provider-visible email inventory. Receipt subject deferred by Audit to Sam (D-7). Waitlist preheader handed to the WAIT lane. Supabase change sequence added (packet §2.1). |
| 2026-10-12 | Codex exact-head reviews: #857 clean at `20dda7a6`. Findings fixed on new heads (threads left for human disposition): #842 → `aedaa35e` (registry-derived token routes; 32+ char opaque segments), #848 → `5e34dcf2` (every Auth table incl. `auth.identities`; runtime token expiry; drill PASS 120/120 tables, 3/3 objects), #859 → `f7b68c87` (no-show and postcare subjects). New #869 (`28488f18`): PostHog token-path list derived from the canonical registry (it lacked `/invitation`). |
| 2026-10-12 | Read-only Supabase account checks (Management API and pinned CLI `get` commands): plan, SSL, network restrictions, PITR, Postgres config, auth MFA/session/SMTP settings, org member MFA (G-02, G-03, G-10, G-11, F16). |
| 2026-10-12 | G-09 draft #857; subject minimization draft #859; G-13 contract agreed in principle with the RBAC lane; G-16 Sentry gate taken by the Sentry lane; SMS readiness will state that registration is not HIPAA coverage. |
| 2026-10-12 | G-07 fix draft #842 (CI run 38187266136 green at `14f2a6dc`); G-12 restore drill draft #848 (run 1 a true-positive FAIL, run 2 PASS: 99/99 tables, 3/3 objects). |
| 2026-10-12 | Twilio edition prerequisite; Amazon SES verified as a HIPAA-eligible email candidate (packet §3.1); Monday decision sheet (packet §6). G-07 fix opened as a separate draft PR. |
