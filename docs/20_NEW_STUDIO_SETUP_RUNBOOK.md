# 20 New Studio Setup Runbook (internal)

**Audience: operator (Sam). This is an INTERNAL operator checklist for safely creating Studio #2 (Laura's studio) and any studio after it. It is NOT user-facing documentation, NOT an onboarding feature, and it adds no app surface.** The practitioner-facing guidance stays where it is: /getting-started in the app and docs/12 smokes.

Last reconciled 2026-07-09 against **production migration max 0113**. **Payment posture:** supervised live owner-run **session** payments are already live for approved studios (Willow + Sam's controlled studio); a **new** studio starts in **test mode** and is enabled for live payments per-studio only after supervised onboarding + approval — do not flip live as part of basic setup. Public booking card collection, deposits/packages/partial, and live manual fees remain off/held (see [docs/production/current-state.md](./production/current-state.md)). Always re-verify the current migration max against `supabase migration list --linked` before using this — do not trust a hardcoded number. (Originally written for the post-PR #223 / migration-0088 state; that reference is superseded.)

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
| Services to seed | e.g. "Electrolysis 30 min" | created in-app via Settings -> Services after first login; collect names, durations, prices |
| Default appointment duration | 60 (default) | studios.default_appointment_duration_minutes; in-app later |
| Buffer minutes | 15 (default) | studios.buffer_minutes; snapshotted into every appointment's blocked range |
| Default machine frequency | 13.56 MHz / 27.12 MHz / unknown | practitioners.default_machine_frequency is STICKY-LEARNED from charting (PR #203); do not set by SQL; it seeds itself after her first charted treatment area |
| Booking policy assumptions | cancellation / no-show text | studio-authored free text in Settings; optional at setup; fees stay NULL (no fee charging without card-on-file consent chain) |
| Payment status | **new studio starts test mode; live enabled per-studio only after supervised approval** | see section 7; live session payments are already live for approved studios |
| Practitioner count | ONE | multi-practitioner needs the exposure-incident access review first (section 7) |

## 2. Setup checklist

> New Studio Wizard (PR #254): the operator-only `/admin/studios/new` page now performs the two writes in §2.1 + §2.2 for you — `isAdmin`-gated (the `ADMIN_EMAILS` allowlist, fail-closed in production), via the service-role client, validating slug uniqueness + a non-duplicate pending invite, inserting a `studios` row (name/owner_email/slug/timezone only — fees NULL, no Stripe) and an `owner` `pending_invitations` row, and showing the booking URL + this setup checklist on success. It does NOT insert a practitioner (the owner is still created by `handle_new_user()` on first sign-in, §2.3), send any email, or touch payments. The wizard is the convenient path; the SQL below remains the source of truth for exactly what it writes and the approval discipline still applies to anything outside it. Wizard quirk: a studio-less operator reaches `/admin` via the PR #254 isAdmin middleware carve-out, so after first sign-in they may land on `/no-access` and must navigate to `/admin` (or `/admin/studios/new`) directly. Discoverability (PR #255): the wizard now has a **Create new studio** card + nav link on the `/admin` Admin Console, which also shows a payment-status banner (now **mode-aware**; older builds showed a flat "Live payments are disabled." string — superseded, see [current-state](./production/current-state.md)), studio counts, and a per-studio setup-health table (owner invite status, Owner/Services/Availability flags) — operational metadata only, no client data — so you can see at a glance which studios are set up or still need services/availability before go-live. Per-studio detail (PR #256): `/admin/studios/[id]` shows that studio's metadata + aggregate counts (practitioners/clients/services/appointments/imported-memory) + setup-health flags ONLY — no client names or client/clinical/payment details — so verifying a studio's setup never exposes its clients. For client-level verification use the in-app studio surfaces (signed in as the studio's own practitioner) or the read-only SQL probes in §3, not the admin console.

### 2.1 Create the studio row (production write: show SQL, get approval first)

```sql
insert into public.studios (name, owner_email, slug, timezone)
values ('<STUDIO NAME>', '<OWNER EMAIL>', '<SLUG>', '<IANA TZ>')
returning id, name, slug, timezone;
```

Record the returned `id` as `<STUDIO_ID>`. Every other column has a safe default (60 min default duration, 15 min buffer, confirmation/24h/2h emails on, SMS off, no-show followup off, horizon 3 months, fees NULL). Do not set fee columns. Do not set legal_entity_name unless provided.

### 2.2 Create the owner invitation (production write: show SQL, get approval first)

The ONLY supported account-linking path is the invite flow: `public.handle_new_user()` (migration 0081, invite-only) looks up `pending_invitations` by email on first sign-in and creates the practitioner row with the invited role, terms/privacy acceptance stamps, and studio link. **Never insert a practitioners row by hand for a real person** (it would bypass terms acceptance and fight the trigger when she signs in).

```sql
insert into public.pending_invitations (studio_id, email, role, display_name)
values ('<STUDIO_ID>', '<OWNER EMAIL>', 'owner', '<OWNER DISPLAY NAME>')
returning id, studio_id, email, role, status;
```

### 2.3 Owner first sign-in

Laura signs in at hone.care/login with the invited email (magic link or Google with the same address). The trigger creates her owner practitioner row. Verify (read-only):

> Invite-only posture (PR #253): Hone is invite-only. Self-serve signup and public studio creation do NOT exist (no `/signup` route, no signup CTA; `studios` has no INSERT policy; `handle_new_user` only provisions a practitioner from a matching `pending_invitations` row). The owner's first sign-in MUST use the exact invited email — an uninvited sign-in creates an `auth.users` row but no studio/practitioner and is gated to `/no-access` (a friendly "No studio access yet" page with Sign out + Contact Hone), never the app shell or any studio data. So the §2.2 invitation row is a prerequisite for §2.3; if Laura lands on `/no-access`, the email she used does not match a pending invitation.

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
3. **Settings -> Availability**: set her weekly open days/hours. Until this is set the booking page shows no slots, which is correct, not broken.
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

## 5. Do-not-touch list

- **Do not enable live payments as part of adding a studio.** Adding a studio is separate from live-payment enablement: a new studio starts test-mode. Live owner-run session payments are already live for approved studios, but enabling a NEW studio for live is its own supervised step (Stripe onboarding + approval + the docs/18 checks) — not part of basic setup.
- **Do not use the production service role casually.** Approved, pasted-first SQL through the documented path only; no ad-hoc admin scripts.
- **Do not alter RLS policies.** Studio isolation comes from the existing policies; a new studio needs zero policy work.
- **Do not touch Willow data.** No UPDATE/DELETE against any Willow row during setup; even reads should be the listed isolation probes.
- **Do not invite a second practitioner into ANY studio without the exposure-incident access review.** The PR #222 owner tier protects incident history, but multi-practitioner operation has open questions (charge permissions, records visibility expectations) recorded in docs/13; review before sending a non-owner invitation from Settings -> Team.
- **Do not create public/self-serve onboarding, billing automation, or admin tooling as a side effect.** If a step feels like it wants tooling, write it down in docs/13 instead.
- **Do not run migrations** unless a setup step genuinely requires one, and then only through the normal approval + migration-first process.

## 6. Known limitations (accepted for Studio #2)

- Setup is operator-driven: the two writes are either the approved SQL inserts below or the operator-only New Studio Wizard (PR #254, `/admin/studios/new`) that performs the same two writes; in-app configuration (services/availability/booking/consent) stays manual. No public self-serve studio creation.
- No browser E2E; verification above is manual plus the CI DB/RLS lane.
- New studio starts test-mode (card-on-file only if explicitly scoped); the legal/accounting + Stripe onboarding checklist (docs/18 section 16) apply before THIS studio goes live. Live owner-run session payments are already live for approved studios; going live is per-studio and supervised.
- No Hone billing automation (nobody is charged for using Hone; that whole area is future).
- Existing-client booking identity hardening and public appointment token hardening remain deferred backlog items (docs/13).
- Storage policy tests remain deferred; photos/export flows have app-level scoping but no dedicated storage-policy test lane yet.
- Intake is code-defined and identical for every studio; no per-studio intake builder.

## 7. Payments posture (explicit)

A new studio starts with: no Stripe Connect account, fee columns NULL, no card-on-file, no charges possible. This is correct and requires no action — a new studio is test-mode until it completes its own supervised live-enablement. Onboarding Laura to TEST-MODE payments (Connect onboarding, card-on-file, test charges) is its own decision with its own consent-template review; it is NOT part of studio setup. (Product-wide, supervised live owner-run session payments ARE live for approved studios — Willow + Sam's controlled studio; enabling live for a new studio is a separate supervised step.)
