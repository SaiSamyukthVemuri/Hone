# Internal Product-Truth Register — Hone marketing rebuild

**Status:** internal working document. **Not served** (`docs/` is never routed). The public
site must never expose the internal classification labels, migration numbers, worker
flags, controlled-studio names, phases, or rollout gates named here.

**Purpose.** Before any public copy is written, every candidate marketing claim is
classified against code, tests, and current production documentation, and given a
truthful public phrasing plus a market/omit decision. This register governs the copy in
every page and in `lib/marketing/content.ts`.

Built for `feat/marketing-site-category-seo-pricing` off production head
`325b124` (migration max 0133, no 0134). Single live customer: **Willow (Chloe)**;
one controlled test studio (Sam). Sources: read-only inspection of `app/`, `lib/`,
`supabase/migrations/`, `tests/`, `e2e/`, `docs/production/current-state.md` (reconciled
2026-07-17), privacy policy, terms.

## Classification labels (internal only)

| Label | Meaning |
|---|---|
| `LIVE_FOR_ALL_ONBOARDED` | Live for all onboarded studios. |
| `LIVE_WITH_GUIDED_SETUP` | Live, but needs guided/approved-studio setup to reach the customer. |
| `DEPLOYED_DEFAULT_OFF` | Deployed but default-OFF; a studio opts in. |
| `DORMANT_CONTROLLED` | Dormant / controlled-validation only. Never marketed. |
| `PLANNED` | Referenced/scaffolded but not built. |
| `NOT_BUILT` | Not built. |
| `RETIRED` | **Terminal.** A product decision permanently removed it as a capability and the database enforces that it cannot be enabled. Never marketed, and never as "coming soon" — it is not coming. |

## Market-decision key

- **MARKET** — market plainly.
- **QUALIFIER** — market only with a truthful qualifier (e.g. guided onboarding).
- **OMIT** — do not mention (no "coming soon" filler).
- **NEVER** — actively must-not-market (would be false or is dormant/controlled).

## Standing rules (prompt §3, §7, §23)

1. Market verified, customer-usable capability. Use a truthful guided-onboarding
   qualifier where necessary. Omit anything not public-ready. No "coming soon."
2. Never publish internal labels, migrations, worker flags, controlled studios, phases,
   or rollout gates. Never use the words *partial, pilot, beta, dormant, default off,
   controlled validation, planned, under development* publicly.
3. **Google Calendar rule.** The dedicated outbound-create lifecycle was
   production-validated once on Sam's controlled studio; it remains OFF and is not
   approved for Willow or general use. Therefore: do **not** market Google Calendar
   sync, show it in pricing, put it in metadata, make a feature card, add it to FAQ as
   available, or market inbound busy import or two-way edits.
4. **Payment rule.** Card on file, owner-run session payments, receipts, refunds, and
   Stripe handling may be described **with** the qualifier "Payments are enabled during
   guided onboarding." Never imply self-service live-payment activation.
5. **"No AI training" must be true across every vendor that receives data** — not
   inferred from the absence of an AI feature. See the Privacy domain note.
6. Do not publish Chloe's identity, studio, image, quote, or endorsement without her
   explicit approval.
7. **Clinical-record rule (added 2026-07-29).** Signed / cryptographically finalized clinical
   records are **RETIRED** — not a Hone capability, and permanently rejected. Therefore: never
   market *finalize & sign*, *lock the chart*, *immutable / tamper-proof treatment record*,
   *signed snapshot*, *cryptographic hash of the record*, or a *correction / amendment workflow*.
   Never present it as coming soon. The truthful story is the opposite and is fully marketable:
   **treatment records stay editable, and every change is attributed and time-stamped.**
   *This rule is narrow.* It does **not** touch these existing, still-true claims: append-only
   **clinical notes** (a correction is a new row), the **record-keeping audit trail**, **session
   edit history**, **intake terminal immutability**, and **consent record
   integrity/immutability (SHA-256, no delete)**. Those are unrelated to the retired system and
   remain marketable exactly as written. See `../decisions/clinical-finalization-retired.md`.

---

## 1. Booking & Calendar

| Capability | Class | Decision | Public phrasing / note |
|---|---|---|---|
| Public online booking page (`/book/[slug]`) — service menu, slot picker, next-available, new/existing split, consultation gate, double-booking protection | LIVE_FOR_ALL_ONBOARDED | MARKET | Give clients a booking page where they browse services, see real open times, and book online, with built-in double-booking protection. |
| Service management (create/edit, show/hide, drag-order menu) | LIVE_FOR_ALL_ONBOARDED | MARKET | Set up services and control exactly which ones clients see and in what order. |
| Availability & hours (weekly hours, overrides, blockouts, breaks, one-off blocks) | LIVE_FOR_ALL_ONBOARDED | MARKET | Define weekly hours, date overrides, vacations, breaks, and one-off blocks; clients book only the time you make available. |
| Practitioner calendar (day/week/month, mobile, quick-book, quick-block) | LIVE_FOR_ALL_ONBOARDED | MARKET | See your whole schedule in day, week, or month on any device; book or block time in seconds. |
| Client self-serve cancel (email links, reason, policy ack) + practitioner cancel | LIVE_FOR_ALL_ONBOARDED | MARKET | Clients cancel from their confirmation/reminder email, with your policy shown; you're notified automatically. |
| Client self-serve reschedule (email links, horizon + policy guarded) | LIVE_FOR_ALL_ONBOARDED | MARKET | Clients reschedule themselves to another open time from their email. |
| Move appointment (atomic same-record, id/relationships preserved, conflict-safe) — migration 0133 | LIVE_FOR_ALL_ONBOARDED | MARKET | Move a booking to a new time in one step — same client, notes, and history, protected from double-booking. |
| Move appointment — owner custom-time override (outside hours, owner-only, ack-gated) | LIVE_FOR_ALL_ONBOARDED | QUALIFIER | As the owner, move an appointment to a custom time outside your regular hours when you need to. |
| Automatic email booking confirmations + owner notifications (default ON) | LIVE_FOR_ALL_ONBOARDED | MARKET | Every booking emails the client a confirmation and notifies you. |
| Automatic 24h/2h email reminders (default ON; external scheduler) | LIVE_WITH_GUIDED_SETUP | MARKET | Automatic 24-hour and 2-hour email reminders help cut no-shows. |
| SMS booking confirmations (opt-in) | DEPLOYED_DEFAULT_OFF | QUALIFIER | Optional text-message confirmations — available when you enable SMS and the client opts in. |
| SMS 24h/2h reminders (opt-in) | DEPLOYED_DEFAULT_OFF | QUALIFIER | Optional text-message reminders — available when you enable SMS and the client opts in. |
| **Google Calendar sync (outbound/two-way)** | DORMANT_CONTROLLED | **NEVER** | **OMIT everywhere.** Dormant, worker OFF, all flags OFF, Willow unconnected. |

---

## 2. Charting & Records

| Capability | Class | Decision | Public phrasing / note |
|---|---|---|---|
| Session charting at point of care (electrolysis + laser) | LIVE_FOR_ALL_ONBOARDED | MARKET | Chart electrolysis and laser sessions at the point of care, settings and readings on one page. |
| Multi-area under one settings block + per-area laterality (0128/0129) | LIVE_FOR_ALL_ONBOARDED | MARKET | Record several treatment areas under one machine-settings block, each with its own laterality. |
| Machine settings/modality (mode, Apilus modality, energy, frequency, split readings, pulse) | LIVE_FOR_ALL_ONBOARDED | QUALIFIER | Capture electrolysis machine settings — mode, modality, energy, frequency, per-pass readings. (Apilus-specific; keep the term precise.) |
| Structured probe selection + probe lot capture w/ active-lot selector | LIVE_FOR_ALL_ONBOARDED | MARKET | Select a validated probe and record the lot/batch, with a searchable active-lot picker; manual entry always available. |
| Minutes performed per area | LIVE_FOR_ALL_ONBOARDED | MARKET | Record minutes per area for treatment-time tracking. |
| Structured observation chips + free-text notes | LIVE_FOR_ALL_ONBOARDED | MARKET | Tag what you saw with quick observation chips, stored as structured data alongside notes. |
| Client tolerance + skin/reaction per area (with numbing record) | LIVE_FOR_ALL_ONBOARDED | MARKET | Capture how each area was tolerated and any reaction, plus whether numbing was used — as factual records. |
| Next-session note surfaced as "from last visit" | LIVE_FOR_ALL_ONBOARDED | MARKET | Write a plan for next visit while charting; it resurfaces when the client returns. |
| Procedure records ("Client Record for Invasive Procedures") | LIVE_FOR_ALL_ONBOARDED | QUALIFIER | Generate per-client procedure records from charted sessions, filterable, showing items/probe lot/aftercare. (Not a legal-compliance guarantee.) |
| Print / inspector-friendly record views | LIVE_FOR_ALL_ONBOARDED | QUALIFIER | Open clean, print-friendly record and procedure views for inspections. (No CSV/PDF file export of charting exists — "print/export" = print views + the studio data export.) |
| Record-keeping audit trail (append-only, trigger-enforced) | LIVE_FOR_ALL_ONBOARDED | QUALIFIER | Every change to a sterile-item/disinfectant/incident/probe-lot record is captured in an append-only edit history app users can't alter. |
| Session edit history | LIVE_FOR_ALL_ONBOARDED | MARKET | See who changed a session and when. |
| Probe lot traceability (exact match, log → areas) | LIVE_FOR_ALL_ONBOARDED | QUALIFIER | Trace a probe lot from your records to the areas that recorded it (traceability only, never causation). |
| Sterile-items + disinfectant records (expiry, replace-by) | LIVE_FOR_ALL_ONBOARDED | MARKET | Keep sterile-item and disinfectant logs with lot numbers, expiry, and replace-by dates; add/edit-only. |
| Exposure-incident records (owner-scoped) | LIVE_FOR_ALL_ONBOARDED | QUALIFIER | Log blood/body-fluid exposure incidents, with history restricted to the owner. |
| In-app disinfectant/supply due & overdue flags (read-time) | LIVE_FOR_ALL_ONBOARDED | QUALIFIER | At-a-glance due/overdue flags for replace-by and supply expiry while you work. |
| Disinfectant proactive reminder (cron/email/SMS) | NOT_BUILT | OMIT | Computed read-time only; no cron/email/SMS. |
| Clinical finalization / "finalize & sign" (Phase 1) | RETIRED | **NEVER** | **RETIRED 2026-07-29** — signed/finalized clinical records are not a Hone product capability. Both flags pinned false by DB constraint (migration 0159); no role can enable them. **OMIT everywhere, and never as "coming soon" — it is not coming.** Do not use *finalize*, *sign the chart*, *locked*, *immutable record*, *tamper-proof*, *signed snapshot* or *cryptographic hash* of treatment records in any public copy. See `../decisions/clinical-finalization-retired.md`. |
| Clinical corrections & amendments + audit ledger (Phase 2) | RETIRED | **NEVER** | **RETIRED 2026-07-29** — no signed-record correction/amendment workflow exists or will; no production amendment was ever created. `clinical_audit_events` is retired with it and is **not** Hone's audit trail. **OMIT everywhere.** |
| Correcting a charting mistake | LIVE_FOR_ALL_ONBOARDED | MARKET | Fix a mis-charted session by editing it — records stay editable, and every change is captured in the session edit history. (This is the truthful replacement for any "finalize/amend" story. Do not imply signing, locking or immutability.) |

---

## 3. Treatment Memory (the category-defining differentiator)

| Capability | Class | Decision | Public phrasing / note |
|---|---|---|---|
| "Before Today" pre-treatment briefing (last treatment, response, watch/plan, reminders) | LIVE_FOR_ALL_ONBOARDED | MARKET | Before a returning client sits down, Hone shows a briefing — last treatment's areas, settings, probe lot, and how the client responded — assembled from what you charted. |
| "Last visit / what we did last time" recap card | LIVE_FOR_ALL_ONBOARDED | MARKET | Open a client and see exactly what you did last time — date, method, time, aftercare, every treated area. |
| Per-area summaries + area treatment intelligence | LIVE_FOR_ALL_ONBOARDED | QUALIFIER | Memory is kept per treatment area, so multi-area sessions stay legible. |
| "From last visit, for today" caution/watch + plan band | LIVE_FOR_ALL_ONBOARDED | MARKET | Cautions you flag and the plan you leave resurface automatically next time. |
| Next-session note capture + surfacing | LIVE_FOR_ALL_ONBOARDED | MARKET | Leave a "for next visit" note; Hone puts it in front of you before the next appointment. |
| Imported treatment memory (paper/Jane/Fresha/spreadsheet, read-only, provenance-labelled) | LIVE_WITH_GUIDED_SETUP | QUALIFIER | Bring history over with Quick Import; it appears clearly labelled as imported, never mixed with Hone charting. Owner-only ingestion. |
| Record-gap reminders (per-client + studio-wide follow-up assistant; rules-based, no AI) | LIVE_FOR_ALL_ONBOARDED | QUALIFIER | Hone points out incomplete records — missing probe lot, aftercare not marked, uncharted appointment — on the client card and a dashboard list. |

---

## 4. Client Intake & Consent

| Capability | Class | Decision | Public phrasing / note |
|---|---|---|---|
| Fixed 5-step health intake (tokenized mobile wizard) | LIVE_FOR_ALL_ONBOARDED | QUALIFIER | Send clients a secure, mobile-friendly health intake before their appointment. (Fixed form — see builder below.) |
| **Intake FORM BUILDER** (custom questions, drag-drop) | NOT_BUILT | **NEVER** | Intake is a fixed form. Do not imply a customizable builder. |
| Intake preview in Settings (read-only) | LIVE_FOR_ALL_ONBOARDED | QUALIFIER | Preview the exact intake clients receive, step by step. |
| Intake status lifecycle (in_progress → submitted → reviewed, notes) | LIVE_FOR_ALL_ONBOARDED | MARKET | Track each intake from in-progress to reviewed and add practitioner notes. |
| Intake terminal immutability (locked after submit; corrections = new intake) | LIVE_FOR_ALL_ONBOARDED | QUALIFIER | Once submitted, answers lock; corrections issue a fresh intake so the original is preserved. |
| Intake link lifecycle (14-day expiry, resend/reissue, copy) | LIVE_FOR_ALL_ONBOARDED | MARKET | Request, resend, or copy secure intake links with automatic expiry tracking. |
| Intake → profile sync (fill-if-null; allergies appended) | LIVE_FOR_ALL_ONBOARDED | QUALIFIER | Submitted answers populate the profile without overwriting; allergies are appended, not replaced. |
| Fitzpatrick self-report + computed estimate (not auto-written) | LIVE_FOR_ALL_ONBOARDED | QUALIFIER | Clients complete a skin-typing questionnaire; Hone shows an estimate to review — self-reported, not a diagnosis. |
| Client health/skin fields (practitioner-set Fitzpatrick, allergies) | LIVE_FOR_ALL_ONBOARDED | MARKET | Record each client's Fitzpatrick type and allergies on their profile. |
| Practitioner-only intake review flags + EpiPen banner | LIVE_FOR_ALL_ONBOARDED | QUALIFIER | Hone highlights what a client reported (e.g. pacemaker, EpiPen) to review before treatment — a surfacing aid, not clinical advice. |
| Consent template authoring (versioned, archive) | LIVE_FOR_ALL_ONBOARDED | QUALIFIER | Write your own versioned consent forms; editing creates a new version while past signatures keep the text signed. |
| Consent capture / e-signature in portal (append-only, hashed) | LIVE_WITH_GUIDED_SETUP | QUALIFIER | Clients e-sign your consent forms in a secure portal; each signature stores the exact text, version, typed name, and timestamp. |
| Consent Draft → Active → Live visibility gate | LIVE_FOR_ALL_ONBOARDED | MARKET | Decide exactly which consent forms appear in the portal with a deliberate publish workflow. |
| Signed-consent visibility for practitioners | LIVE_FOR_ALL_ONBOARDED | QUALIFIER | Open a client's signed record and see the exact text they agreed to, signature, and timestamp. |
| Photo consent as explicit accept/deny signature | LIVE_FOR_ALL_ONBOARDED | QUALIFIER | Capture explicit photo-use consent and see the choice next to the client's photos; a deny is a real signed record. |
| Consent record integrity/immutability (SHA-256, no delete) | LIVE_FOR_ALL_ONBOARDED | QUALIFIER | Signed consent is append-only and can't be edited or deleted; each stores a hash of the exact version. |
| **"Legally binding" consent** | NOT_BUILT | **NEVER** | Not counsel-reviewed; never claim legally binding/enforceable. |
| Consent audience targeting (per-modality/service) | PLANNED | OMIT | Deferred. |
| Card-on-file authorization consent type | LIVE_WITH_GUIDED_SETUP | OMIT (here) | Belongs to Payments; requires guided setup. |

---

## 5. Photos, Client Portal & Follow-up

| Capability | Class | Decision | Public phrasing / note |
|---|---|---|---|
| Private treatment photos — private bucket, RLS, practitioner-only, soft-delete | LIVE_FOR_ALL_ONBOARDED | MARKET | Treatment photos are stored in a private, per-studio bucket protected by row-level security — never public URLs, never shown in the portal; deletion is a reversible archive. |
| Automatic EXIF/GPS/metadata stripping on upload | LIVE_FOR_ALL_ONBOARDED | MARKET | Every photo is re-encoded on our servers before storage, stripping EXIF, GPS, and embedded metadata. |
| Per-file true-type validation (rejects spoofed/SVG/HEIC/PDF) | LIVE_FOR_ALL_ONBOARDED | MARKET | Uploads are validated by decoding actual bytes; only genuine JPEG/PNG/WebP are accepted, with per-file status. |
| Short-lived signed-URL access (60s, path-bound) | LIVE_FOR_ALL_ONBOARDED | MARKET | Photos are served through short-lived signed links bound to the requesting studio and client. |
| Portal passwordless magic-link login | LIVE_FOR_ALL_ONBOARDED | MARKET | Clients sign in with a passwordless, single-use magic link that expires in 60 minutes. |
| Portal access events (append-only, no tokens/PII) | LIVE_FOR_ALL_ONBOARDED | MARKET | An append-only log of portal events (link sent, sign-in) that stores no tokens, IPs, emails, or clinical data. |
| Portal "tasks" summary (derived, read-only) | LIVE_FOR_ALL_ONBOARDED | QUALIFIER | The profile surfaces outstanding portal items — incomplete intake, consent to sign, unread messages. |
| Postcare/aftercare email — manual (studio content only, idempotent) | LIVE_FOR_ALL_ONBOARDED | MARKET | Send studio-branded postcare emails; content is your own saved text (Hone never invents medical advice). |
| Postcare automation on complete (opt-in, default OFF) | DEPLOYED_DEFAULT_OFF | QUALIFIER | Optionally auto-send postcare when an appointment is marked complete — off by default, per studio. |
| Portal two-way messaging (bodies never in emails) | LIVE_FOR_ALL_ONBOARDED | MARKET | Secure two-way messaging in the portal; message content stays in the portal, never in notification emails. |
| Client tags (studio-scoped) | LIVE_FOR_ALL_ONBOARDED | MARKET | Organize clients with custom tags. |
| Client pinned notes (profile + dashboard roster) | LIVE_FOR_ALL_ONBOARDED | MARKET | Pin short, always-visible notes to a client; the latest also shows on your dashboard. |

---

## 6. Payments — always with the guided-onboarding qualifier

Standing qualifier everywhere: **"Payments are enabled during guided onboarding."** Never
imply self-service live activation.

| Capability | Class | Decision | Public phrasing / note |
|---|---|---|---|
| Owner-run session payments (prepare + charge saved card) | LIVE_WITH_GUIDED_SETUP | QUALIFIER | Charge a client's saved card for a completed session, run by the studio. Payments are enabled during guided onboarding. |
| Card on file (SetupIntent; PAN/CVC never touch Hone) | LIVE_WITH_GUIDED_SETUP | QUALIFIER | Let clients securely save a card — details go straight to Stripe. Payments are enabled during guided onboarding. |
| Stripe Connect Express onboarding (studio-owned, direct payouts) | LIVE_WITH_GUIDED_SETUP | QUALIFIER | Studios connect their own Stripe account so payments and payouts go directly to them. |
| Payment receipts (email) | LIVE_WITH_GUIDED_SETUP | QUALIFIER | Email a receipt for each card payment. |
| Refunds (full-amount, owner-only) | LIVE_WITH_GUIDED_SETUP | QUALIFIER | Issue a full refund on a card payment (owner only). |
| Quick checkout (reduced-click modal) | LIVE_WITH_GUIDED_SETUP | QUALIFIER | Take payment in a couple of clicks while the client is with you. |
| Adjust the final charge at checkout (owner-only, reason required) | LIVE_WITH_GUIDED_SETUP | QUALIFIER | The booked price fills in the total; as the owner you can change it for a discount or an add-on, with a short reason recorded on the payment. |
| Manual cancellation/no-show fee | DEPLOYED_DEFAULT_OFF | OMIT | Live charging HARD-HELD to `session_payment` only. |
| Card-required-at-booking | DORMANT_CONTROLLED | **NEVER** | Never flipped; no runtime path. |
| Deposits / packages / partial payments / partial refunds | NOT_BUILT | OMIT | Not built. |
| Product catalog / inventory / itemized receipts / tax engine | NOT_BUILT | OMIT | Adjusting the final charge records ONE total and a free-text reason. It is not line-item accounting; nothing infers a product, a discount rate or a tax treatment from it. |
| Zero-dollar / fully-comped session as a financial event | NOT_BUILT | OMIT | A $0.00 checkout prepares nothing and says so; no comped-visit record is written. |
| Automatic live cancel/no-show charges | NOT_BUILT | **NEVER** | Every charge is an explicit manual action; never auto-charge. |
| Self-service live-payment activation | NOT_BUILT | **NEVER** | Supervised, env/approval-gated operator process — not a product feature. |

---

## 7. Practice Operations

| Capability | Class | Decision | Public phrasing / note |
|---|---|---|---|
| Practice dashboard (worklist home) | LIVE_FOR_ALL_ONBOARDED | MARKET | A daily dashboard that opens on today's schedule with a practice snapshot. |
| Today worklist (per-appointment "before today" recap) | LIVE_FOR_ALL_ONBOARDED | MARKET | Today's appointments with a quick recap of each client's last visit and what to remember. |
| Daily prep brief (rules-based, no AI) | LIVE_FOR_ALL_ONBOARDED | QUALIFIER | A prioritized daily prep brief built from your own recorded notes. |
| Record-keeping (sterile/probe/disinfectant, expiry/replace-by) | LIVE_FOR_ALL_ONBOARDED | QUALIFIER | Log sterile items, probe lots, and disinfectants with lot numbers, expiry, and replace-by. (Log with expiry tracking — NO stock-quantity/reorder concept; don't imply inventory counts.) |
| Overdue/expiring supply notifications (computed, in-app) | LIVE_FOR_ALL_ONBOARDED | QUALIFIER | In-app reminders when a disinfectant is overdue or supplies expire. (In-app only; no email/SMS/push.) |
| Multi-practitioner studio (own name, colour-coded shared calendar) | LIVE_FOR_ALL_ONBOARDED | MARKET | Add multiple practitioners to one studio — each charts under their own name and gets a calendar colour. |
| **"Up to three practitioners" seat cap** | NOT_BUILT (as *enforcement*) | QUALIFIER | Supported operationally (works for 3+), honoured via guided onboarding; **no code enforces the count**. Publishable as packaging (see Studio decision). |
| Additional-practitioner handling (invite/manage/remove) | LIVE_FOR_ALL_ONBOARDED | MARKET | Owners invite, manage, and remove practitioners; teammates join by signing in. |
| **Per-practitioner online booking / client chooses practitioner / per-practitioner availability** | NOT_BUILT | **NEVER** | Public booking is studio-wide (attributed to owner; single studio-wide schedule). Never claim clients pick a practitioner or that practitioners have independent online availability. |
| Records print/export | LIVE_FOR_ALL_ONBOARDED | QUALIFIER | Print or export your record-keeping for your own files. |

---

## 8. Privacy, Security & Data-Use

| Capability | Class | Decision | Public phrasing / note |
|---|---|---|---|
| Tenant/studio isolation via RLS | LIVE_FOR_ALL_ONBOARDED | MARKET | Each studio's data is isolated with database row-level security. |
| Private treatment photos (private bucket, short-TTL signed URLs) | LIVE_FOR_ALL_ONBOARDED | MARKET | Photos in a private bucket, shown only to authorized practitioners via short-lived signed links. |
| Exportable records (full studio export) | LIVE_FOR_ALL_ONBOARDED | MARKET | Export your full studio history any time; if you cancel, your data goes with you. (Self-serve export is owner-only.) |
| Secure sign-in (Google OAuth / email magic links, TLS) | LIVE_FOR_ALL_ONBOARDED | MARKET | Secure sign-in via Google or email magic links — Hone doesn't store your password. (Reconcile privacy §3/§10 doc wording before leaning on it.) |
| Stripe handling — Hone never stores full card data | LIVE_FOR_ALL_ONBOARDED | MARKET | Payments are processed by Stripe; Hone never stores full card numbers or security codes. |
| No advertising use of health records | LIVE_FOR_ALL_ONBOARDED | MARKET | Client health records are never used for advertising. |
| **No AI training on practitioner/client records (every vendor)** | LIVE_FOR_ALL_ONBOARDED | MARKET | Hone does not train AI models on practitioner or client records. **See note below.** |
| AI-assisted/agentic features (Anthropic) | PLANNED | OMIT | Not built; no Anthropic dependency/env. Rules-based helpers only. |
| HIPAA/PHIPA/SOC2/ISO/HITRUST/PIPEDA "certified" badge | NOT_BUILT | **NEVER** | No certification exists. May factually state "operated from Canada; we honour PIPEDA access/correction rights" but never a certified badge. |
| Breach-notification / DPA commitments (72h, 30-day sub-processor notice) | LIVE_FOR_ALL_ONBOARDED | QUALIFIER | Our DPA commits to breach notification without undue delay and advance notice before changing sub-processors (see Terms). |

**"No AI training" — vendor coverage (addendum §4 / prompt §23).** This claim is
supported by **written policy AND operating reality**, not inferred from the absence of an
AI feature:
- Written: privacy §4 and terms §6 both state Hone does not train ML models on
  practitioner/client data.
- Reality: **no AI vendor receives data today.** Anthropic is not a dependency or env
  var; the "intelligent" helpers (daily prep brief, missing-records assistant, intake
  review flags, follow-up assistant) are explicitly rules-based ("no AI, no model call").
  Other sub-processors (Supabase, Vercel, Resend, Twilio, Stripe) are infra/processors
  that do not train models on Hone records under their commercial terms.
- **WATCH-ITEM:** privacy §6 and terms §7.4 pre-list "Anthropic (AI features, when
  enabled)" as a sub-processor. If any AI feature ships, keep it on Anthropic's
  no-training commercial terms + data minimization so this public claim stays true.

---

## Studio pricing decision (prompt §15, addendum §2)

**Decision: publish Studio at CAD $99/month for up to three practitioners.**

Rationale: multi-practitioner studios are `LIVE_FOR_ALL_ONBOARDED` — each practitioner
charts under their own name and is colour-coded on the shared calendar, and owners
invite/manage/remove practitioners — and this works for three (and more) practitioners
today. The "up to three" seat boundary is a **packaging promise honoured during guided
onboarding**; there is no automatic seat billing and no per-feature crippling. This is
fulfillable, so §15's condition ("only after verifying current product and onboarding can
support that promise") is met.

**Constraint this places on feature copy:** public booking is studio-wide (every booking
is attributed to the owner; availability is a single studio-wide schedule). So the Studio
tier and the booking feature page must **not** claim clients choose a practitioner, or
that practitioners have independent online availability. Multi-practitioner is a
charting/calendar-collaboration story, not a per-practitioner booking story.

---

## Stale/false claims on the CURRENT site that must change

Captured from the baseline (see `baseline-audit.md`) so the rebuild removes each:

1. **`$19` "founding pilot" price** (homepage + pricing) → replace with CAD $29→$39 /
   $49 / $99 structure. Remove "pilot / early access / limited pilot availability."
2. **"Book a walkthrough" / "Book the walkthrough"** on the lead-capture `/demo` form →
   the honest verb is **"Request …"** (the visitor never selects a real time). Fix the
   header CTA, hero, pricing CTA, demo heading, submit button, and success message.
3. **"$149 founding annual for the first 25 studios"** (pricing FAQ) → remove unless
   still approved and honourable (default: remove).
4. **Absolute "You do not need Calendly, Jane, or Square Appointments on top"** → replace
   with the conditional REPLACES_STATEMENT ("…for practices that fit Hone's current
   workflow").
5. **"more than five practitioners → contact us"** multi-location framing → replace with
   the Studio tier (up to three) + "Talk to us" for larger; no unsupported multi-location
   claim.
6. Eyebrow == H1 duplication ("Treatment memory for electrologists" used as both) →
   new hero per §5; keep the phrase in supporting copy/metadata/footer only.
