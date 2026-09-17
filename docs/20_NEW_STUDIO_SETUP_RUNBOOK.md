# 20 New Studio Setup Runbook (internal)

> **Guided onboarding v2 (PR #459 — MERGED; flag `onboarding_v2_enabled`, default OFF; migrations 0140–0141 APPLIED in production, *not* repo-only as earlier revisions said; per-studio, and a studio owner cannot set it — it is operator-only):** when enabled per studio, this manual runbook is supplemented by a welcome email + an in-app guided wizard + existing-account invitation reconciliation. See **[docs/24_ONBOARDING_V2.md](./24_ONBOARDING_V2.md)** for the flag, migrations/rollback, admin welcome/resend, reconciliation, chooser, `/no-access` reasons, analytics, and the manual test checklist. Until that flag is on, this runbook is unchanged.

**Audience: operator (Sam). This is an INTERNAL operator checklist for safely creating Studio #2 (Laura's studio) and any studio after it. It is NOT user-facing documentation, NOT an onboarding feature, and it adds no app surface.** The practitioner-facing guidance stays where it is: /getting-started in the app and docs/12 smokes.

**Migration state is DERIVED, never quoted here.** Earlier revisions pinned a
number in this sentence (0113, then 0157); every one of them went stale, and a
stale number in a setup runbook reads as fact. Immediately before onboarding a
studio, derive the current state from the canonical tooling instead:
`npm run migration:state` for the repository chain, and
`docs/production/migration-state.json` for what production has actually applied. **Payment posture:** supervised live owner-run **session** payments are already live for approved studios (Willow + Sam's controlled studio); a **new** studio starts in **test mode** and is enabled for live payments per-studio only after supervised onboarding + approval — do not flip live as part of basic setup. Public booking card collection, deposits/packages/partial, and live manual fees remain off/held (see [docs/production/current-state.md](./production/current-state.md)). Re-verify hosted state against `docs/production/migration-state.json` (or `supabase migration list --linked`) before using this — never trust a number written into prose. (Originally written for the post-PR #223 / migration-0088 state; that reference is superseded.)

> Schema note (PR #252, migration 0089): the Imported Treatment Memory tables (`import_batches`, `imported_treatment_memories`, `imported_treatment_memory_audit_events`) are studio-scoped, RLS-backed (member SELECT, owner-only INSERT/UPDATE, no delete), and need NO per-studio setup — nothing to configure. There is no UI surface yet (schema + read-model only); imported history is written by the future Quick Import flow (PR #253), not during new-studio setup.

Standing discipline applies to every step here: **production WRITES require the exact SQL to be shown and explicitly approved before execution** (docs/14 workflow); read-only verification uses `supabase db query --linked`. Nothing in this runbook may be run casually with the service role.

---

## 1. Required inputs (collect before touching anything)

| Input | Example | Notes |
|---|---|---|
| Studio name | Laura's Electrolysis Studio | studios.name; shows on booking page, emails, portal |
| Owner display name | Laura <Lastname> | pending_invitations.display_name |
| Owner email | laura@example.com | studios.owner_email AND the invitation email; must be the address she will sign in with (magic link or the Google account email) |
| Timezone | America/Toronto | IANA name; drives booking slots, reminders, dashboard weeks, procedure-record date filters. Default is America/Toronto; set explicitly anyway |
| Booking slug | lauraelectrolysis | studios.slug, UNIQUE; becomes hone.care/book/<slug>; lowercase, no spaces; cannot collide with willow's |
| Address / contact basics | optional | studios.address, booking_description; can be filled in-app later (Settings -> Studio / Booking) |
| Services to seed | e.g. "New Client Consultation" + "Electrolysis 30 min" | created in-app via Settings -> Services after first login; collect names, durations, prices. **Include a consultation** — a new client cannot book publicly without one (§1a) |
| Default appointment duration | 60 (default) | studios.default_appointment_duration_minutes; in-app later |
| Buffer minutes | 15 (default) | studios.buffer_minutes; snapshotted into every appointment's blocked range |
| Default machine frequency | 13.56 MHz / 27.12 MHz / unknown | practitioners.default_machine_frequency is STICKY-LEARNED from charting (PR #203); do not set by SQL; it seeds itself after her first charted treatment area |
| Booking policy assumptions | cancellation / no-show text | studio-authored free text in Settings; optional at setup; fees stay NULL (no fee charging without card-on-file consent chain) |
| Payment status | **new studio starts test mode; live enabled per-studio only after supervised approval** | see section 7; live session payments are already live for approved studios |
| Practitioner count | ONE | multi-practitioner needs the exposure-incident access review first (section 7) |

## 1a. The launch sequence at a glance

Two operator writes, then everything else is the owner's. Rehearsed end to end
(see §8).

**SAM — operator-only. Laura cannot do either of these; both are refused at the
database with `42501 insufficient_privilege`.**

1. Create the **studio row** (§2.1, or the `/admin/studios/new` wizard).
2. Create Laura's **owner `pending_invitations` row** (§2.2).

**No feature flag is part of this.** `practitioner_capacity_enabled`,
`practitioner_capacity_booking_enabled` and `onboarding_v2_enabled` all default
to **false**, are operator-only, and **none of them is required for an ordinary
launch.** Do not enable any of them to "make onboarding work".

**LAURA — self-service, in the app, after acceptance.**

3. **Accept the invitation** (§2.3) — mandatory; nothing below is reachable
   until she does.
4. Create **at least one active service** — and, for public booking, at least
   one active **consultation** service (see below).
5. Configure **weekly availability**.
6. Then ordinary operation: create clients, book internally and publicly, chart
   and reopen sessions, complete appointments, and edit studio settings.

**Minimum first-booking readiness: one active service + valid availability.**
Both are hers to set; neither needs the operator.

**A new client booking PUBLICLY needs one thing more: an active CONSULTATION
service.** `isBookableByNewClient` (`lib/booking/consultation.ts`) admits a
service only when it is this studio's, `active`, **and** a consultation —
`services.modality = 'consultation'`, or, where modality was never set, a
service *name* containing "consultation". The public action enforces it
server-side, so the rule cannot be dressed around in the UI.

A studio whose catalogue is ordinary treatments therefore books normally
**internally** while its public page tells every new visitor *"Online
consultation booking is not set up yet. Please contact <studio>."* On day one
every visitor is a new client, so this presents as a broken booking page rather
than as missing configuration. Note that the §1 example service
("Electrolysis 30 min") does **not** satisfy the rule on its own — collect a
consultation service alongside it.

## 2. Setup checklist

> New Studio Wizard (PR #254): the operator-only `/admin/studios/new` page now performs the two writes in §2.1 + §2.2 for you — `isAdmin`-gated (the `ADMIN_EMAILS` allowlist, fail-closed in production), via the service-role client, validating slug uniqueness + a non-duplicate pending invite, inserting a `studios` row (name/owner_email/slug/timezone only — fees NULL, no Stripe) and an `owner` `pending_invitations` row, and showing the booking URL + this setup checklist on success. It does NOT insert a practitioner (the owner is provisioned at first sign-in, §2.3 — by the application under migration 0141, **not** by `handle_new_user()`, which 0141 made a NO-OP), send any email, or touch payments. The wizard is the convenient path; the SQL below remains the source of truth for exactly what it writes and the approval discipline still applies to anything outside it. Wizard quirk: a studio-less operator reaches `/admin` via the PR #254 isAdmin middleware carve-out, so after first sign-in they may land on `/no-access` and must navigate to `/admin` (or `/admin/studios/new`) directly. Discoverability (PR #255): the wizard now has a **Create new studio** card + nav link on the `/admin` Admin Console, which also shows a payment-status banner (now **mode-aware**; older builds showed a flat "Live payments are disabled." string — superseded, see [current-state](./production/current-state.md)), studio counts, and a per-studio setup-health table (owner invite status, Owner/Services/Availability flags) — operational metadata only, no client data — so you can see at a glance which studios are set up or still need services/availability before go-live. Per-studio detail (PR #256): `/admin/studios/[id]` shows that studio's metadata + aggregate counts (practitioners/clients/services/appointments/imported-memory) + setup-health flags ONLY — no client names or client/clinical/payment details — so verifying a studio's setup never exposes its clients. For client-level verification use the in-app studio surfaces (signed in as the studio's own practitioner) or the read-only SQL probes in §3, not the admin console.

### 2.1 Create the studio row (production write: show SQL, get approval first)

```sql
insert into public.studios (name, owner_email, slug, timezone)
values ('<STUDIO NAME>', '<OWNER EMAIL>', '<SLUG>', '<IANA TZ>')
returning id, name, slug, timezone;
```

Record the returned `id` as `<STUDIO_ID>`. Every other column has a safe default (60 min default duration, 15 min buffer, confirmation/24h/2h emails on, SMS off, no-show followup off, horizon 3 months, fees NULL). Do not set fee columns. Do not set legal_entity_name unless provided.

### 2.2 Create the owner invitation (production write: show SQL, get approval first)

The ONLY supported account-linking path is the invite flow: create a `pending_invitations` row, and the owner is provisioned on first sign-in. **Never insert a practitioners row by hand for a real person** — it would bypass terms acceptance and fight the provisioning path when they sign in.

> **⚠️ UPDATED for migration 0141 (applied in production).** Earlier revisions of this
> paragraph said `public.handle_new_user()` (migration 0081) creates the practitioner row on
> first sign-in. **That is no longer how it works.** Migration **0141** redefines
> `handle_new_user()` as a **NO-OP**: it creates no membership and stamps no acceptance.
>
> Provisioning **and legal acceptance** now happen at **sign-in time**, in the application,
> with **exactly one authoritative acceptance event** — covering both brand-new and
> pre-existing Auth accounts. **Nothing fabricates consent, and no membership activates merely
> because an Auth user row was created.**
>
> Operationally the step below is unchanged (still create the invitation, still have the owner
> sign in with the exact invited email), but **do not expect a database trigger to have done
> the work**, and do not debug a missing practitioner row by inspecting `handle_new_user()`.

```sql
insert into public.pending_invitations (studio_id, email, role, display_name)
values ('<STUDIO_ID>', '<OWNER EMAIL>', 'owner', '<OWNER DISPLAY NAME>')
returning id, studio_id, email, role, status;
```

### 2.3 Owner first sign-in, then **ACCEPT THE INVITATION** (two steps, both mandatory)

**Signing in does NOT create ownership.** Earlier revisions of this section said
the practitioner row "is created by the application at sign-in" and then asked
you to verify exactly one practitioner row. That is incomplete, and following it
literally produces a verification failure that looks like a bug: after sign-in
alone there is **no practitioner row at all** and the invitation is still
`pending`.

Rehearsed on an isolated local stack against production source
`67023c60`:

    sign in  ->  reconcile_my_pending_invitation()  ->  "acceptance_required"
                 practitioners = 0
                 pending_invitations.status = 'pending'

    accept   ->  /accept-invitation  ->  "linked"
                 practitioners = 1  (role=owner, active=true, terms accepted)
                 pending_invitations.status = 'accepted', accepted_at set

This is correct, deliberate behaviour, not a defect: **nothing fabricates
consent.** Membership and legal acceptance are one explicit act by the owner, so
no membership can activate merely because an Auth account exists.

**Step 1 — sign in.** The new owner signs in at hone.care/login with the exact
invited email (magic link, or Google with the same address). `/auth/callback`
reconciles the pending invitation.

**Step 2 — accept.** If reconciliation returns `acceptance_required`, the owner
is routed to **`/accept-invitation`** and must accept. Until she does, she has no
studio access and **cannot begin any of the §2.4 configuration.** If she stops
here, this is the first thing to check — not the invitation row, and not
`handle_new_user()`.

Only after acceptance, verify (read-only):

> Invite-only posture (PR #253): Hone is invite-only. Self-serve signup and public studio creation do NOT exist (no `/signup` route, no signup CTA; `studios` has no INSERT policy; a practitioner is only provisioned from a matching `pending_invitations` row — at sign-in, by the application under migration 0141; `handle_new_user` itself is now a NO-OP). The owner's first sign-in MUST use the exact invited email — an uninvited sign-in creates an `auth.users` row but no studio/practitioner and is gated to `/no-access` (a friendly "No studio access yet" page with Sign out + Contact Hone), never the app shell or any studio data. So the §2.2 invitation row is a prerequisite for §2.3; if Laura lands on `/no-access`, the email she used does not match a pending invitation.

```sql
select p.id, p.studio_id, p.role, p.active, p.display_name,
       p.terms_accepted_at is not null as terms_ok
from public.practitioners p
where p.studio_id = '<STUDIO_ID>';
-- expect exactly one row: role='owner', active=true, terms_ok=true

select status, accepted_at from public.pending_invitations
where studio_id = '<STUDIO_ID>';
-- expect status='accepted', accepted_at set
```

### 2.4 In-app configuration (no SQL; Laura or operator-with-Laura)

1. **Settings -> Studio**: confirm name, timezone; add address/booking description if desired.
2. **Settings -> Services**: create the collected services (name, duration, price; pre-care instructions optional).
   **At least one must be a consultation** (`modality = 'consultation'`, or a
   name containing "consultation") or the public page cannot take a new-client
   booking at all — see §1a.
3. **Settings -> Availability**: set her weekly open days/hours. Until this is set the booking page shows no slots, which is correct, not broken.
   **Shape matters.** In ordinary (non-capacity) mode, availability is
   **studio-wide**: `studio_availability_default.practitioner_id IS NULL`. A
   **per-practitioner** row is only valid where practitioner capacity is
   enabled — inserting one otherwise is refused by
   `guard_availability_practitioner_scope`: *"per-practitioner availability
   requires practitioner capacity to be enabled for this studio"*. That error
   means the availability was written with the wrong scope, **not** that Laura
   needs capacity mode turned on.
4. **Settings -> Booking**: review confirmation/reminder toggles (defaults are sensible); cancellation/no-show policy text optional now, required before she relies on fee workflows.
5. **Settings -> Consent / Intake**: review the consent templates and intake; intake schema is code-defined (no per-studio builder yet, known limitation).
6. **Machine frequency**: nothing to configure; it learns from her first charted treatment area.
7. **Settings -> Import (Quick Import V1, PR #257)**: optional — the owner can bring existing clients + basic historical treatment memory over from a CSV/TSV paste or file (Google Sheets/Excel/Jane/Fresha export, or paper cards typed into a sheet — one row per client or treatment area). It is preview-first and **create-only**: confident duplicates are skipped, nothing is overwritten or merged, multi-area rows group into one client, and imported rows are stored as imported memory ("Imported history, not charted live in Hone."), never as live charting. No OCR/AI/API sync. This is the supported "don't retype your practice" path; it is owner-only and does not need operator SQL.

### 2.5 Surface verification (each loads, empty but not broken)

- [ ] hone.care/book/<SLUG> loads, shows her studio only; no slots until availability is set, then slots appear.
- [ ] Dashboard loads: zeroed practice snapshot, Getting Started card, empty Today list. Before Today previews and Treatment Intelligence simply do not render content for clients with no history; confirm no error states.
- [ ] Clients page loads (empty), client creation works.
- [ ] /records loads: all four sections render their empty states; Client Procedure Records shows the filter bar with an empty client list.
- [ ] /records/print?section=procedures renders the printable empty state.
- [ ] Exposure Incidents: as the owner she sees the (empty) history and the Add form. The owner-only posture (PR #222 / migration 0088) is studio-agnostic and needs no per-studio setup; nothing to configure.
- [ ] Settings -> Payments: shows Stripe Connect NOT onboarded; leave it that way unless test-mode card-on-file is explicitly in scope for her pilot. **This new studio stays test-mode; live payments are enabled per-studio only after supervised onboarding + approval (section 7) — do not flip live during basic setup.**

## 3. Isolation checks (run all; read-only)

App-level:

- [ ] Laura's client list, calendar, dashboard, and records show ZERO Willow data.
- [ ] Sign in as Chloe (or ask her): Willow surfaces show ZERO Laura data.
- [ ] hone.care/book/willow-slug and /book/<SLUG> render different studios; a booking made on Laura's page appears only in Laura's calendar.
- [ ] Records print/export for each studio contains only that studio's rows.

DB-level (read-only; both counts must be 0):

```sql
-- cross-studio leakage probes: every row must carry exactly one studio_id
select count(*) from public.clients
where studio_id not in ('<WILLOW_STUDIO_ID>', '<STUDIO_ID>');

select 'appointments', count(*) from public.appointments where studio_id = '<STUDIO_ID>'
union all select 'clients', count(*) from public.clients where studio_id = '<STUDIO_ID>'
union all select 'audit', count(*) from public.record_keeping_audit_events where studio_id = '<STUDIO_ID>';
-- expect counts that match only what was created during this setup
```

RLS is the enforcement layer for all of this (is_studio_member / is_studio_owner; verified continuously by the tests/db/ lane in CI), so these checks are confirming configuration, not creating safety.

## 4. Smoke test workflow (use an unmistakable test client)

Create the test client as **"ZZ TEST Setup (delete me)"** so it can never be confused with a real person.

1. Create the test client (Clients -> New).
2. Book a test appointment for her (calendar quick-book or the public booking page with a real inbox you control).
3. Complete the intake for the test client.
4. Chart one small session: add a session, add ONE treatment area (session block).
5. On the treatment area: record a probe lot/batch number; record tolerance, a reaction type, a caution-for-next-session note; add a next-session note on the session.
6. Mark "risks explained and aftercare information provided" (Records -> Client Procedure Records row, or the session surface).
7. Book a SECOND test appointment for the same client; open it and confirm **Before Today** shows the recorded memory (watch/plan note, last treatment) and Treatment Intelligence reflects the single recorded session. Recorded-data wording only; nothing invented.
8. /records -> Client Procedure Records: the charted session appears with lot number and aftercare stamp; the audit History panel shows the trigger-written events.
9. Filter by the test client and print: the filtered print renders with the client named in the header.
10. Confirm the confirmation email arrived (if a real inbox was used) and that its links resolve to Laura's studio, not Willow.

Cleanup, WITHOUT violating the clinical delete hardening (0087: clients/sessions/blocks are not hard-deletable, by design):

- Cancel the test appointments (practitioner cancel).
- Delete the test session via the app's session delete (soft delete: deleted_at; allowed surface).
- **Archive** the ZZ TEST client (client page -> Archive). Archived clients leave every active list but history stays, which is the intended posture.
- Record-keeping audit rows for the smoke REMAIN (append-only, by design); they are clearly attributable to the ZZ TEST records and are acceptable residue.
- Do NOT hand-delete anything by SQL.

## 4a. Booking and capacity: what the flags actually do

Verified behaviour of `create_internal_appointment_v2`, rehearsed on three
isolated fixtures:

| `practitioner_capacity_enabled` | `practitioner_capacity_booking_enabled` | Result |
|---|---|---|
| **false** | **false** | **booking created** ← fresh-studio default |
| true | false | **`booking_paused`** |
| true | true | booking created, but only where **scoped practitioner availability** permits it |

`booking_paused` is returned on exactly one condition: capacity enabled **and**
capacity booking disabled. It is a deliberate, operator-configured pause.

**Sam's `booking_paused` test-studio configuration is NOT Laura's default.** A
new studio is created with both flags `false`, and that default was proved
behaviourally to book normally — internally and through the public booking page.
If a new studio ever reports `booking_paused`, someone enabled capacity; that is
a configuration to undo, not a bug to work around, and it is not reachable by
the studio owner.

## 5. Do-not-touch list

- **Do not enable live payments as part of adding a studio.** Adding a studio is separate from live-payment enablement: a new studio starts test-mode. Live owner-run session payments are already live for approved studios, but enabling a NEW studio for live is its own supervised step (Stripe onboarding + approval + the docs/18 checks) — not part of basic setup.
- **Do not use the production service role casually.** Approved, pasted-first SQL through the documented path only; no ad-hoc admin scripts.
- **Do not alter RLS policies.** Studio isolation comes from the existing policies; a new studio needs zero policy work.
- **Do not touch Willow data.** No UPDATE/DELETE against any Willow row during setup; even reads should be the listed isolation probes.
- **Do not invite a second practitioner into ANY studio without the exposure-incident access review.** The PR #222 owner tier protects incident history, but multi-practitioner operation has open questions (charge permissions, records visibility expectations) recorded in docs/13; review before sending a non-owner invitation from Settings -> Team.
- **Do not create public/self-serve onboarding, billing automation, or admin tooling as a side effect.** If a step feels like it wants tooling, write it down in docs/13 instead.
- **Do not run migrations** unless a setup step genuinely requires one, and then only through the normal approval + migration-first process.

## 5a. Rehearsal evidence (2026-09-15)

The full sequence above was rehearsed on an **isolated local Supabase stack**
against production source `67023c603b78327c2fab2687b64fdac5c68a0029`, on a
brand-new synthetic studio created only through the two operator writes in §2.1
and §2.2, with **no convenience flags seeded**. Hosted production, Willow and
the controlled test studio were not touched.

Proved end to end:

- invitation acceptance (including that sign-in alone provisions nothing, and
  that an uninvited account sees no studio and gains no membership);
- service creation;
- weekly availability (studio-wide shape);
- client creation;
- internal booking — `created`, correctly studio/client/practitioner/service
  scoped, with **no `booking_paused`** on the default flags;
- public booking — slug resolved to one studio, configured availability exposed
  slots, booking succeeded, no cross-studio leakage;
- the booking-pause / capacity matrix in §4a, across all three configurations;
- chart creation, reopening that same chart, and appointment completion via the
  supported path with the session still editable afterwards;
- confirmation-email identity — studio name and contact drive the copy, with no
  Willow or test-studio identity leaking.

**Result: no onboarding P0 or P1, and no product blocker.** Every stop
encountered during the rehearsal was a fixture error, with the product behaving
correctly each time.

**Scope limit, stated plainly.** The rehearsal used **fake providers only** — no
real Stripe, Resend or Twilio call was made. It therefore proves the *onboarding
and booking* path, and says **nothing** about real-provider or live-payment
readiness. Payment posture was verified only as *absence*: a new studio has no
Stripe settings row, no card on file, no charge attempts, and NULL fee columns.
Live enablement remains the separate supervised step in §7.

## 6. Known limitations (accepted for Studio #2)

- Setup is operator-driven: the two writes are either the approved SQL inserts below or the operator-only New Studio Wizard (PR #254, `/admin/studios/new`) that performs the same two writes; in-app configuration (services/availability/booking/consent) stays manual. No public self-serve studio creation.
- **Browser E2E DOES exist for this flow** (corrected 2026-07-27): `e2e/new-studio-wizard.spec.ts` covers the operator-only wizard gate and studio creation, and `e2e/onboarding.spec.ts` covers the owner onboarding path. Verification above is manual **in addition to** the CI DB/RLS lane and the `browser-e2e` Playwright lane.
- New studio starts test-mode (card-on-file only if explicitly scoped); the legal/accounting + Stripe onboarding checklist (docs/18 section 16) apply before THIS studio goes live. Live owner-run session payments are already live for approved studios; going live is per-studio and supervised.
- No Hone billing automation (nobody is charged for using Hone; that whole area is future).
- Existing-client booking identity hardening and public appointment token hardening remain deferred backlog items (docs/13).
- Storage policy tests remain deferred; photos/export flows have app-level scoping but no dedicated storage-policy test lane yet.
- Intake is code-defined and identical for every studio; no per-studio intake builder.

## 7. Payments posture (explicit)

A new studio starts with: no Stripe Connect account, fee columns NULL, no card-on-file, no charges possible. This is correct and requires no action — a new studio is test-mode until it completes its own supervised live-enablement. Onboarding Laura to TEST-MODE payments (Connect onboarding, card-on-file, test charges) is its own decision with its own consent-template review; it is NOT part of studio setup. (Product-wide, supervised live owner-run session payments ARE live for approved studios — Willow + Sam's controlled studio; enabling live for a new studio is a separate supervised step.)
