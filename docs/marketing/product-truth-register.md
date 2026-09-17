# Internal Product-Truth Register — Hone marketing

**Status:** internal working document. **Not served** (`docs/` is never routed). The public
site must never expose the internal classification labels, migration numbers, worker
flags, controlled-studio names, phases, or rollout gates named here.

**Purpose.** Before any public copy is written, every candidate marketing claim is
classified against code, tests, and current production documentation, and given a
truthful public phrasing plus a market/omit decision. This register governs the copy in
every page and in `lib/marketing/content.ts`.

## Provenance of this revision

| | |
|---|---|
| Built against production head | `a946a983ac9b8da379bc869e21b32a5a3d50e548` |
| Head resolved | `git rev-parse origin/claude/build-hone-saas-hOex7`, 2026-09-17 |
| Repository migration max | **0198** (derived — `npm run migration:state -- --json`) |
| Hosted migration max | **0198** (declared — `docs/production/migration-state.json`) |
| Repo/hosted parity | yes |
| Copy deck classified | `hone-marketing-copy-deck-v2-2.md`, sha256 `ad9127e8…d78f6c` |
| Previous revision | head `325b124`, migration max 0133 — **superseded**, it was ~65 migrations stale |

**Read §0 first.** §0 is the operative classification for the v2.2 copy deck and is the
authority for what may ship. §§1-8 below are the earlier capability survey, retained
because their structure and their standing rules are still useful; where §0 and a later
section disagree, **§0 wins**, and where §0 and code disagree, **code wins**.

**A database capability is not a public product capability.** Every row in §0 was
re-derived from application code at the head above, not from a table definition and not
from this register's own earlier revision.

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

## 0. v2.2 copy-deck claim classification — OPERATIVE

Classification of every claim the v2.2 copy deck makes, against application code at
`a946a983`. This section is the gate: a line that is not `VERIFIED_CURRENT` or
`VERIFIED_WITH_QUALIFIER` here does not ship in public copy.

| Status | Meaning |
|---|---|
| `VERIFIED_CURRENT` | True as written, at this head, in application code. Ships as-is. |
| `VERIFIED_WITH_QUALIFIER` | True only with the stated qualifier attached. The qualifier is part of the claim, not a footnote. |
| `NOT_CURRENTLY_SUPPORTABLE` | The code does not support the claim as the deck words it. Cut or re-word; never soften. |
| `NEEDS_EXTERNAL_DECISION` | Code is not the blocker. An operator decision is. |
| `NEEDS_CUSTOMER_EVIDENCE` | Cannot be settled by reading code at all. |

### 0.1 Roll-up

| Status | Count |
|---|---|
| `VERIFIED_CURRENT` | 15 |
| `VERIFIED_WITH_QUALIFIER` | 9 |
| `NOT_CURRENTLY_SUPPORTABLE` | 2 (one is a surface-split: see N1) |
| `NEEDS_EXTERNAL_DECISION` | 4 |
| `NEEDS_CUSTOMER_EVIDENCE` | 2 |

### 0.2 VERIFIED_CURRENT

| # | Claim (deck wording) | Where in deck | Evidence at `a946a983` |
|---|---|---|---|
| V1 | Before Today assembles last areas, settings, probe lot, response, plan left, cautions | hero, home 1, TM, SEO | `lib/sessions/before-today.ts` carries per-area `blockLots` / `blockMinutes` / `blockReactionNotes`; rendered by `components/before-today-card.tsx` |
| V2 | Every treated area keeps its own history; multi-area sessions do not collapse | home 3, TM, charting | `session_block_areas` is a real per-area table; `app/(app)/clients/[id]/page.tsx:604,640` selects `primary_area, side, mode, apilus_modality, energy_level, probe_label, probe_lot_number, tolerance_rating, reaction_type, caution_for_next_session` per area |
| V3 | Structured fields: mode, modality, energy, frequency, probe + lot, laterality, tolerance, skin response | home 4, TM, charting | typed columns, not prose. `machine_frequency` accepts exactly two values (13.56 / 27.12 MHz); `apilus_modality` is an 11-value enum (`APILUS_MODALITY_VALUES`) |
| V4 | Next-treatment notes and cautions resurface automatically | TM, home 5 | `caution_for_next_session` / `caution_note` selected into the Before Today assembly on every returning client |
| V5 | Record gaps flagged: missing probe lot, aftercare not marked, completed appointment not yet charted | home 6, charting | `lib/dashboard/missing-records-assistant.ts` — all three named gaps exist, plus two the deck does not claim (intake incomplete; for-next-visit note with no upcoming appointment) |
| V6 | The checks that flag record gaps are rules, not AI | home 7 | same module, stated in source: *"deliberately RULES-BASED ONLY: no AI, no model call, no provider integration, no chatbot, no autonomous action"* |
| V7 | Probe lots recorded on the treatment and linked to your inventory | home 6, charting | `lib/record-keeping/probe-lot-autofill.ts` states a five-level precedence and refuses to auto-fill a lot that is expired or discarded; `probe_lots` is a real studio-owned table |
| V8 | Sterile-item and disinfectant expiry logged | home 6, charting | `lib/record-keeping/expiry.ts` (30-day window, four states) and `lib/record-keeping/disinfectant-status.ts` (7-day window, six states) |
| V9 | Imported history is always marked as imported | home 1/2/7, TM, FAQ | `components/before-today-card.tsx:218-290` renders a distinct amber section headed "Imported treatment memory", read-only, `IMPORTED_PROVENANCE_NOTE` on every row |
| V10 | Consent shows the exact text signed, with signature and timestamp | home 5 | `ClientConsentSignature` stores `template_body_snapshot` + `template_title_snapshot` + `template_version` + `template_hash` + `signature_name` + `signed_at`. The body itself is snapshotted, not referenced |
| V11 | Per-studio record isolation | home 2/7, SEO | 100 `enable row level security` statements across 53 migration files, plus a dedicated `tests/security/**` suite proving the boundary from the other side |
| V12 | Photos stored privately, camera metadata stripped, short-lived links | home 7, charting | `lib/images/treatment-image-sanitize.ts` re-encodes without metadata so EXIF/GPS/XMP/ICC are stripped before storage; signed-link TTL is **60 s** (`TREATMENT_IMAGE_SIGNED_URL_TTL_SECONDS`), capped at 300 s by test |
| V13 | Hone does not train AI models on practitioner or client records | home 7, FAQ | no `anthropic` / `openai` / `@ai-sdk` / `langchain` dependency in `package.json`; no AI env var in `.env.local.example`. See Q1 for the disclosure qualifier that must travel with it |
| V14 | Print-friendly record view | charting, SEO | two real protected routes — `app/(app)/records/print/page.tsx` and `app/(app)/clients/[id]/clinical-notes/print/page.tsx`; chrome is `print:hidden`, `window.print()` driven |
| V15 | Full treatment workflow on every plan; no client caps; no appointment caps (`noCapsLine`) | pricing, home 8, SEO | no `plan` / `tier` / `subscription` / `seat` / `entitlement` column on `studios`, and no migration adds one. The only `CLIENT_CAP` / `APPOINTMENT_CAP` identifiers in the tree are global-search result limits (`app/(app)/global-search-actions.ts:44-45`) with no plan or billing relationship |

**V15 resolves the deck's `[VERIFY: nothing in code caps clients or appointments]`.** Nothing does.

### 0.3 VERIFIED_WITH_QUALIFIER

The qualifier is part of the claim. Dropping it makes the line false.

| # | Claim | Qualifier that must travel with it | Evidence |
|---|---|---|---|
| Q1 | No AI models trained on records | Keep the claim narrow to **training**. The privacy policy and terms **pre-list an AI sub-processor** (`/privacy:291`, `/terms:188,473`), so a widened "no AI anywhere" line contradicts Hone's own disclosure | negative claim true today; disclosure exists |
| Q2 | CSV export on every plan | State the scope. 20 resources export; **22 are studio-owned and do not**, including `session_blocks` and `session_block_areas` — **the per-area structure that is the differentiator does not leave in the export today** | `lib/export/resource-registry.ts` |
| Q3 | Client portal exists | Portal is real (magic-link login, consent review + e-signature, two-way messaging, card-on-file form, pending tasks, access log). **Treatment photos are never shown in the portal** and no copy may imply otherwise | `app/portal/**`, `lib/portal/**` |
| Q4 | Appointment reminders by email | Email 24h + 2h is **live and default ON**; SMS is **live but opt-in and consent-gated**; intake reminders are live and unmentioned. Reminders run on an **external scheduler**, not an internal timer | `app/api/cron/appointment-reminders/route.ts`; `studios.send_24h_reminders` / `send_2h_reminders` (0025); `send_intake_reminders` (0186) |
| Q5 | Sterile-item / disinfectant expiry | It is a **computed display**, not a notification. Stated in source: *"a computed display, never a stored or sent reminder. NO cron / notification / email here"*. Never write "reminds you" / "alerts you" — appointment reminders **are** sent, so mixed vocabulary reads as a promise | `lib/record-keeping/disinfectant-status.ts` |
| Q6 | Probe lots linked to inventory | Traceability only, **never causation**, and **never stock counts**. `probe_lots` has no quantity and no reorder concept — columns are `probe_size`, `lot_number`, `expiry_date`, `active`, `notes` | `lib/types/database.ts` |
| Q7 | Intake: a pacemaker or an EpiPen is flagged before the appointment | True, but by **two different mechanisms**, and a reader of one module alone will wrongly conclude the claim is false. Pacemaker is an intake **review flag** (`lib/intake/review-flags.ts` → galvanic + authorization). EpiPen is deliberately **excluded** from review flags and surfaced instead as its own banner (`app/(app)/clients/[id]/intake/page.tsx:330-336`), because it "already ha[s] dedicated cards on the review page" | both verified |
| Q8 | Studio plan: up to three practitioners | A **packaging promise honoured during onboarding**, never enforced in code — there is no seat column and no automatic seat billing. Separately: the public booking page attributes bookings **studio-wide** and availability is a **single studio-wide schedule**, so copy must not claim clients pick a specific practitioner or that each practitioner has independent online availability | `lib/marketing/content.ts:98-110` records the boundary; no enforcing column exists |
| Q9 | Append-only edit history (as shipped on `/features/charting-records`) | Only where **scoped to traceability and logs**. Migration 0086 covers sterile items, disinfectants, exposure incidents, the aftercare mark, and `session_blocks.probe_lot_number` — that column only. It does **not** cover other charted clinical values. See N1 for the surface-split ruling | `supabase/migrations/0086_record_keeping_audit_events.sql` |

### 0.4 NOT_CURRENTLY_SUPPORTABLE

Two deck lines the code does not support as worded. Both are classified `REPO_FACT` /
`SAFE_NOW` in the deck's own ledger, and both are wrong there.

#### N1 — the UNSCOPED homepage line "Edits kept as history, not written over"

*Deck homepage section 6, line 3. The deck's §11 ledger row "Append-only edit history |
home 6, charting | REPO_FACT | SAFE_NOW" is correct for **charting** and over-broad for
**home 6**.*

**An append-only trail genuinely exists, and it is good.** Migration 0086 ("append-only
audit trail for Record Keeping") writes `record_keeping_audit_events` from **database
triggers**, not application code, so a normal authenticated client cannot skip or forge an
event. The table has a single studio-scoped SELECT policy and **no insert, update, delete
or for-all policy** for authenticated users, and rows are inserted only by `SECURITY
DEFINER` trigger functions. It is append-only and tamper-proof for every normal app user.

It covers:

| Covered by the trigger trail | Event |
|---|---|
| `record_keeping_sterile_items` | created / updated |
| `record_keeping_disinfectants` | created / updated |
| `record_keeping_exposure_incidents` | created / updated |
| `sessions.aftercare_and_risks_explained_at` | aftercare marked / cleared |
| `session_blocks.probe_lot_number` | `probe_lot_updated` |

0086 is explicit that the last one is **that column only** — *"unrelated block edits never
write an event"*.

**What is therefore NOT covered.** Every other charted clinical value — energy, minutes,
mode, modality, probe label, laterality, tolerance, reaction, area. Editing any of those
runs through `update_block_with_entry` (migration 0166), which issues plain `UPDATE`
statements against `electrolysis_entries` and `session_blocks`, writes no audit row, and
retains no prior value.

Two further trails exist and are real, but narrow: `session_audit` carries exactly **two**
live event kinds — a session start-time change (field `started_at`, migration 0167) and a
treatment-area removal with its reason (field `area_removed`, migration 0123). A third
writer in migration 0119 is **not reachable**: migration 0159 revoked EXECUTE on those RPCs
from every runtime role and pinned the flags false with CHECK constraints. Separately,
removing a treatment pass is an audited soft delete — `deleted_at` / `deleted_by` /
`delete_reason` (migration 0114) — so the row is never hard-deleted, and a clinical note is
revised by adding a new version that supersedes the old one, which is retained.

**Ruling, split by surface:**

| Surface | Verdict |
|---|---|
| `/features/charting-records` — *"…sterile-item and disinfectant logs with lot numbers, expiry, and replace-by dates, with an append-only edit history"* (shipped today, line 58) | **`VERIFIED_WITH_QUALIFIER` — KEEP.** The sentence is scoped to traceability and logs, which is exactly what 0086 covers. It is true as written |
| Deck homepage section 6 — *"Edits kept as history, not written over"* | **`NOT_CURRENTLY_SUPPORTABLE` as worded.** Unscoped, on the homepage, in a list a reader will apply to the treatment record. It is false for the most common edit a practitioner makes: correcting a charted value |

Do not ship the unscoped form, and do not ship "every change is tracked" or "complete audit
trail" anywhere. Scoped lines that **are** supportable: *"Sterile-item, disinfectant and
probe-lot changes are recorded as a history you cannot edit"*; *"Removing a treatment or an
area is recorded with who did it and why"*; *"Clinical notes are amended by adding a new
version, and the earlier one is kept"*.

*Why the product is shaped this way, for the record: treatment sessions are ordinary
editable operational records by an explicit product decision, and practitioners fix ordinary
charting mistakes by editing them. That decision is recorded in
`docs/decisions/clinical-finalization-retired.md` and is not under review here.*

#### N2 — "All screenshots, and the film, from the sanctioned synthetic-twin tenant"

*Deck §12 opening line, and the §12b `[VERIFY]`.*

The film was **not** captured from that tenant. It was captured from a locally-seeded,
disposable lab fixture — see §0.7. The deck's assertion is factually wrong, though wrong in
the safe direction: a local fixture never touched production at all.

**Ruling.** Correct the deck's provenance sentence. The public-facing label *"Demo data.
Actual Hone application."* is **true** and ships; the internal sentence about which tenant
supplied the data is what must change.

#### The rulings above, in machine-readable form

`tests/docs/marketing-truth-register.test.ts` enforces §0.4 by reading **this block** — it
holds no second copy of the list. That is deliberate. The first version of the guard kept
its own hard-coded patterns, claimed to enforce §0.4, and did not match the canonical
sentence §0.4 rejects: *"Edits kept as history, not written over"* could have shipped with
every assertion green. A ruling and its enforcement cannot live in two documents that are
free to disagree. **Add a wording here and the guard enforces it on the next run; there is
nowhere else to add it.**

Each rule is `<ruling id> | <JavaScript regular expression>`, split at the **first** pipe
(so a rule's own alternation pipes need no escaping), matched **case-insensitively** against
every sentence the public site renders and against every string literal it ships. `#` opens
a comment line.

```forbidden-public-wording
# N1 — the UNSCOPED edit-history claim. The scoped form is true and ships; what
# must never appear is a promise that reads as covering the treatment record.
N1 | edits kept as history
N1 | not written over
N1 | changes are preserved rather than replaced
N1 | every change is (tracked|recorded|kept|preserved)
N1 | complete audit trail
N1 | full (edit )?history of every (change|edit)
N1 | nothing is ever overwritten
N1 | never overwritten
N1 | (corrections|edits|changes) are (recorded|kept|preserved|retained),? (not|never) (written over|overwritten|replaced)
N1 | (treatment|clinical|session) records? (keeps?|retains?|holds?|preserves?|has|have) (its|their|an|a|the )?(own )?(?:[\w-]+ ){0,3}(edit|change|revision) history
# N2 — which tenant supplied the film's data. The public label "Demo data.
# Actual Hone application." is true and ships; naming a source tenant does not.
N2 | synthetic[- ]twin
N2 | captured from (our|the) (production|live) (tenant|studio)
```

The last two N1 rules exist because the copy deck states the claim more strongly than the
homepage line this register was first written against — *"Corrections are recorded, not
written over. A treatment record keeps its edit history."* Every clause of that is rejected:
`update_block_with_entry` (0166) issues plain `UPDATE`s that retain no prior value, so a
treatment record does **not** keep its edit history, and a correction to a charted value
**is** written over.

### 0.5 NEEDS_EXTERNAL_DECISION

Code is not the blocker on any of these.

| # | Decision | Evidence prepared |
|---|---|---|
| D1 | **Billing wording.** `/pricing` renders a monthly cadence and an automatic month-13 step against a product with no billing mechanism | Zero calls to `subscriptions.*`, `billingPortal`, `checkout.sessions`, `prices.*`, `products.*`, `invoices.*` across `app/` + `lib/`. All of `lib/billing/**` and `lib/stripe/**` is Stripe **Connect**, studio→client, a different product from Hone→studio revenue. `/terms` §8 states in bold that no automated Hone subscription billing exists. A live guard re-proves it every run (`tests/app/settings/data-truthfulness.test.ts:170-179`) |
| D2 | **Apilus trademark use.** Deck marks it `DECIDE trademark use` | The field is real and shipped: `apilus_modality`, 11 constrained values, per-entry since migration 0011. It is a third-party mark (Dectro). It **already renders today** at `app/features/charting-records/page.tsx:38`, so "omit" is a change to shipped copy, not a hold. No trademark or nominative-use line exists anywhere on the marketing surface |
| D3 | **Laser field placement.** Deck marks it `DECIDE placement` | Not parity with electrolysis. `LaserEntry` is `zone`, `session_number`, `equipment_params` (an untyped JSONB blob), `observation_notes`, `ejection_results`. The form offers `fluence` / `pulse_width` / `spot_size` as **free-text strings** written into that blob. The export registry records the consequence: the blob is flattened to those three columns and *"Any key the blob holds beyond these three does not reach the CSV"* |
| D4 | **"Most popular" badge on Solo.** Deck retires it | Rendered on two surfaces, where it also drives the featured border and promotes that card's CTA to primary. Pinned **twice** — `tests/lib/marketing/content.test.ts:84` and `e2e/marketing-homepage.spec.ts:58` — so retiring it is a two-lane edit |

### 0.6 NEEDS_CUSTOMER_EVIDENCE

| # | Claim | Why code cannot settle it |
|---|---|---|
| C1 | "The person who built Hone answers support" | An operational fact about who answers, not a code fact. The deck classifies it `AUDIT`. It is safe **as stated** because it asserts who answers, not that the answer is better or faster — that distinction must survive any re-word |
| C2 | Hosting-location line | The deck marks it `VERIFY or omit`. There is a live tension: the footer says "Operated from Canada" and prices are CAD, while `/privacy:258-276` discloses **AWS US-East-1** and possible US legal access. Neither statement is false; together they permit a wrong inference. The deck's own instruction — no data-residency claims anywhere — resolves it: **omit** |

### 0.7 Film V1 provenance — mechanically established

The film is intended as real product proof, so its provenance is a truth-register concern,
not a production note.

| | |
|---|---|
| `FILM_CAPTURE_TENANT` | A locally-seeded disposable lab fixture. **Not** the sanctioned synthetic production tenant, **not** the pilot studio, not a production tenant of any kind |
| `FILM_CAPTURE_TENANT_ID` | A `randomUUID()` minted at seed time inside the local stack. Not recorded in any artifact, not a production id, and meaningless outside that disposable database |
| `SYNTHETIC_TENANT_PROVEN` | The **capture is proven synthetic**; the deck's specific claim that it came from the sanctioned synthetic *production* tenant is **disproven** (see N2) |
| `REAL_CUSTOMER_DATA_PRESENT` | no |
| `MARKETING_SAFE` | **yes** |

**How it was established, without relying on appearance.**

- Every endpoint the capture scripts touch is loopback: Postgres, auth/API and the mail
  catcher all on `127.0.0.1`, with the default local development credential.
- The application under capture ran against a loopback Supabase URL.
- The lab's `supabase/.temp/project-ref` is **absent**. Without it the Supabase CLI cannot
  reach a hosted project at all, so `db query --linked` and `db push` were not available.
  This is the decisive artifact: the lab was never linked to anything.
- Negative controls across the capture scripts: zero references to the pilot studio, zero
  hosted Supabase host, zero project ref, zero hosted credential.
- The fixture's own identifiers are synthetic by construction — a fictional studio and
  practitioner, and a client roster whose addresses all use an RFC 6761 reserved TLD, which
  can never resolve or be assigned to a real person.

**One trap, recorded so it is not re-derived.** The capture lab contains a vendored
read-only checkout of the application, whose README and docs discuss the pilot studio at
length. A grep across the lab hits that documentation, not captured data. Scope any
re-verification to the capture scripts themselves.

**Currency.** The film was captured at application revision `f73ba414…`. 242 commits
separate that from `a946a983`, but across the surfaces the film actually shows —
calendar, client profile, session detail, the Before Today card — exactly **one** file
changed, and it is a server action, not a rendered surface. Shared chrome, global CSS and
the Tailwind config are unchanged, and every `components/**` change in that range is a new
waitlist file. The film still matches the shipped UI.

**Format, verified from the file.** 25.000 s · 1920x1080 · 30 fps · H.264 High · yuv420p ·
750 frames · **no audio stream** · 3,647,564 bytes. This matches the deck §12b contract
exactly. The poster is 1920x1080 PNG and is a **pixel-exact frame of this film** — its raw
RGB24 decode is byte-identical to the frame at t≈12 s, which is the setup beat the deck
names as S11.

### 0.8 Claims the deck makes that this register does NOT yet cover

Recorded so the gap is visible rather than assumed closed.

- **Lead-data handling on `/demo`.** The deck ledger row reads "Lead-data use line | demo |
  privacy policy | VERIFY". The privacy policy's scope section covers practitioners, their
  clients, and a *studio's* prospective clients. It does **not** cover a prospective **Hone**
  customer who requests a walkthrough, and neither the policy nor the terms mentions the
  walkthrough form. The retention section has no rule for that data. Nothing false is said
  today, because nothing is said at all — but any reassurance placed beside that form
  becomes a claim with no policy behind it. **A public reassurance line is blocked until the
  policy covers the population.** This is the one classification in this register with a
  legal dimension, and it is flagged rather than resolved here.
- **Marketing visuals that disagree with the product.** Two shipped illustrations contradict
  the schema this register verifies: `TreatmentMemoryPanel` shows "27 MHz" where
  `machine_frequency` accepts only 13.56 and 27.12, and `CalendarPreview` carries the string
  "Day view" where the calendar offers exactly Week and Month. Both were found during film
  production and both still ship.
- **A guard that reads `lib/marketing/content.ts` must strip LINE comments before
  BLOCK comments.** `content.ts` contains `next/*` inside an ordinary line comment. That
  is a block-comment opener to a regex, and stripping blocks first swallows everything
  up to the next `*/` — measured at **1,403 characters** of real code, including
  `CANONICAL_HOST`, all of `POSITIONING`, `WALKTHROUGH` and the pricing block. A scan
  that does this reports the file clean because it can no longer see the file. The
  shipped marketing guards are not affected: none of them reads `content.ts`. The
  register's own guard does, deliberately, and strips in the safe order. Recorded because
  the failure is silent and looks like a pass.

- **Conversion instrumentation.** All three pricing plan CTAs emit the same analytics event,
  so a Studio click is recorded as a Founding click; `pricingPlanViewed` is attached to two
  navigation links and therefore measures clicks, not views. Neither is a truth claim, but
  both make the deck's own measurement plan unanswerable.

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
