# 12 Smoke tests

> **⚠️ Payment posture — the trailing "live payments remain disabled" note that appears on
> EVERY smoke entry below is a HISTORICAL, point-in-time aside written when each entry was
> added. It is NOT current.**
>
> **Current posture (verified 2026-07-27):** live owner-run **session payments** are live for
> two approved studios and are genuinely in use — **Willow Electrolysis has 6 succeeded
> live-mode charges, most recent 2026-07-26.** Still off or held: public-booking card
> collection (off and unwired), deposits / packages / partial payments (not built), and live
> manual no-show / late-cancel fees (**hard-held server-side** — only `session_payment` charges
> live). Broad self-serve live payments are **not ready**.
>
> **Other point-in-time asides below may also be stale.** Hardcoded migration numbers in
> particular go stale on every migration — the current production max is **0157**.
>
> Canonical current state:
> [docs/production/current-state.md](./production/current-state.md) ·
> [capability-register.md](./production/capability-register.md) ·
> [known-limitations.md](./production/known-limitations.md).

This is the catalogue of manual smoke tests every operator and reviewer should know how to run. Some can be executed from a curl loop; many require an authenticated practitioner session and a real test appointment and cannot be done from CI or from an AI harness.

Use [docs/11 Runbook](./11_RUNBOOK.md) for the SQL recipes referenced below.

> Schema-only note (PR #252, migration 0089 — Imported Treatment Memory): there is NO manual smoke for this PR because it adds NO UI surface (schema + read-model only: `import_batches`, `imported_treatment_memories`, `imported_treatment_memory_audit_events`, plus the `lib/imported-treatment-memory.ts` read helper). Its proof is automated: the DB/RLS integration lane (`tests/db/imported-treatment-memory.db.test.ts`, 18 tests) verifies owner-only writes, member reads, cross-studio isolation, no hard delete, soft-void, and the append-only audit trail on the real migrated database; the generated-types drift check verifies the curated types match the new tables; `tests/migrations/0089-*` pins the migration shape. Post-migration production verification (run the read-only isolation probes in docs/20 §3 against the new tables) is part of the migration-first rule, not a UI smoke.

## Record Keeping print expiry marker + "expires today" smoke (PR #317, no migration)

Pilot QA polish on top of PR #316 (found 0 P0/P1). **Manual smoke** (authenticated practitioner): on `/records/print?section=sterile` (Print/Export), each item's **Expiry date** line now carries a plain-text, print-safe marker — a past date shows "(expired)", today shows "(expires today)", within 30 days "(expires soon)", otherwise no marker (studio-local via `todayInTz`; visible on the printed page/PDF without relying on color). In the interactive Records list + the dashboard "Supplies expiring" card, an item expiring **today** now shows an "Expires today" badge (amber), distinct from "Expired" (red) and "Expires soon" (amber); the summary banner still counts today within "M expiring within 30 days". The owner ZIP export README notes expiry is derivable from `expiry_date` (CSV schema unchanged). **No behavior change to create/edit/copy-last (still never copies the lot number) or the manufacturer dropdown (custom values still round-trip); no migration/RLS/payment/live change.** Pinned by `tests/lib/record-keeping/supply-expiry.test.ts` (state/label/marker + banner counts), `tests/app/records/probe-expiry-copy-last.test.ts` (print marker + export note + helper-driven badges), and `tests/db/expiring-sterile-items.db.test.ts` (RLS-scoped `getExpiringSterileItems`: expired+today+within-horizon incl. boundary; excludes null/future-beyond-horizon/other-studio).

## Probe/sterile expiry + copy-last + manufacturer dropdown smoke (PR #316, no migration)

UI-layer Record Keeping feature over the existing `record_keeping_sterile_items` (no migration; `expiry_date`, free-text `manufacturer_name`, `lot_number` already exist). **Manual smoke** (authenticated practitioner; no real writes needed beyond a test sterile record): on `/records?section=sterile` — (1) **Manufacturer** is a dropdown of Protec/Ballet/Sterex + "Other (type a name)"; adding with a listed brand saves it; editing a record whose manufacturer isn't one of the three shows "Other" with the value prefilled and saves unchanged (free-text preserved). (2) **"Copy last entry"** (shown when ≥1 record exists) prefills date/description/manufacturer/amount/expiry/notes from the most recent entry but leaves **Lot # blank**; submitting creates a distinct record. (3) A record with an expiry date in the past shows a **red** row + "Expired" badge; within 30 days shows **amber** + "Expires soon"; a summary banner reads "N expired · M expiring within 30 days". (4) On `/dashboard`, a **"Supplies expiring"** card lists the studio's expired/expiring sterile items (hidden when none), linking to Records; it shows only this studio's items. All studio-scoped (RLS + server-resolved studio); no lot number is ever copied or shown on the dashboard card; no email/SMS/push, no cron, no payment/live change. Pinned by `tests/lib/record-keeping/supply-expiry.test.ts` (pure expiry states + banner counts) + `tests/app/records/probe-expiry-copy-last.test.ts` (dropdown, copy-last-excludes-lot, styling, studio-scoped card, no DDL).

## 0. Marketing homepage smoke (PR #242, tightened PR #243, human rewrite PR #244, visual density follow-up, visual system PR #246, comparison + proof polish PR #247, mature-SaaS polish PR #248)

The public homepage (`/`) is positioned around treatment memory; after PR #244 the copy is plain, human, and practitioner-first, with the public category phrase **"Treatment memory for electrologists."** PR #246 added a visual system for vertical-SaaS polish (Jane as a benchmark, not copied): an app-window chrome frame on the **hero** ("Demo Studio · Today") and on the **Before Today** centerpiece ("Before Today · Maya R."); a "Review Before Today" action on the Daily prep mockup; and faint alternating band backgrounds for rhythm. PR #247 made the **proof strip** a contained, edge-faded **marquee ticker** ("Built with working electrologists" … "Founder-led setup", no fake testimonials/logos/usage numbers) that must NOT cause horizontal page overflow at any width and stops scrolling under reduced-motion, and rebuilt the **Calendar-vs-Hone** comparison into two product-style cards. PR #248 matured the page further: the proof-strip items are now white **pills** (slower marquee); the **Calendar-vs-Hone** cards now sit in `AppWindow` chrome ("Calendar-only" / "Hone" title bars) — a limited appointment card (Appointment data: 10:00 AM / Maya R. / Electrolysis / Confirmed) and a treatment-memory card (Treatment memory) echoing Before Today (Remember-today band, Last-recorded chips Upper lip · Sterex · Lot L-204, Tolerance 4/5 · Mild redness, "Aftercare not marked last session"); the band tones strictly alternate; and the **Privacy & Trust** section is now a two-column claim-plus-compact-checklist card (all five claims in ONE card + the privacy-policy link), replacing the old awkward five-card 3+2 grid (stacks cleanly on mobile, no empty card grid). The **Records** section shows a printable Procedure record mockup ("Print this client's procedure record") and the **Smarter prep** section shows a Daily prep "Tomorrow morning" mockup ("Based on recorded Hone data."). Confirm the hero app-window, Before Today centerpiece, proof-strip pill ticker, both comparison app-window cards, the privacy checklist + policy link, record, and prep visuals all render and fit (no horizontal overflow) at phone and desktop. It keeps an eight-section structure: hero, calendar-vs-Hone comparison, before/during/after the appointment, what Hone remembers (Before Today, charting, procedure record, Daily prep as compact cards), records and lot traceability, "Smarter prep, without autopilot.", privacy/trust, and pricing/walkthrough. Open `https://hone.care/` on a phone (~390px) and on desktop and confirm: the hero reads "Treatment memory for electrologists." within five seconds with the line "Your calendar knows who is coming. Hone helps you remember what matters." and ONE hero visual (not a stack of competing cards); the page does not scroll sideways at either width; the Book walkthrough CTA is visible and reachable (header button on desktop, menu on mobile) and lands on `/demo`; Sign in is reachable and lands on `/login`; the comparison ("Your calendar shows the appointment. Hone shows what to remember."), before/during/after, what-Hone-remembers, records (with the local public-health responsibility caveat), the "Smarter prep, without autopilot." section, privacy/trust ("Your client records should stay yours."), and pricing ($19/month founding pilot, "See if Hone fits your studio.") all render; the nav is short and human (Product, Records, Pricing, Sign in plus the CTA — no "Agentic support" item); the hero leads with NO AI/agentic wording; all product visuals use only anonymized demo data (Maya R., Demo Studio, lot L-204, Sterex), never a real client or studio; and there are no medical, compliance, or AI overclaims (no HIPAA/public-health-certified/medical-grade/guaranteed-compliance, no autonomous clinical decisions claimed as a feature) and no SaaS filler (operating memory layer, AI-powered, intelligent assistant, seamless, empower, optimize, unlock, transform your workflow). The Playwright lane (`e2e/marketing-homepage.spec.ts`) covers the overflow + CTA + sign-in checks at phone and desktop widths.

## 1. Public booking smoke

**Smart / packed scheduling (this PR, no migration):** public booking availability is no longer a fixed every-15-minute grid. `getAvailableSlots` (`lib/booking/slots.ts`) now anchors candidate starts to (1) the opening time and (2) immediately after each existing reservation's protected end (appointment end + its baked-in buffer; blocks/blockouts raw), with a **coarse hourly fallback** so an empty day still offers a few choices. Duration/buffer/overlap/DST and the conflict checks (appointments, timed blocks, recurring breaks, full-day blockouts) are unchanged, and public booking + re-verify share the same generator (a shown slot is bookable). **Manual smoke:** on `/book/<slug>` for an EMPTY open day (e.g. opens 10:00, closes 17:00) confirm the slot list reads 10:00, 11:00, 12:00 … (hourly) and **not** 10:00/10:15/10:30/10:45; with an existing appointment, confirm the first offered slot after it is **appointment-end + buffer** (e.g. a 10:00–11:00 appt with a 15-min buffer offers 11:15, not 11:00 or 11:30) and that no gappy mid-block 15-minute slots appear. Pinned by `tests/lib/booking/slots-smart-scheduling.test.ts`. No migration; no charge/refund/Stripe change; live payments remain disabled.

1. Open `https://hone.care/book/willow-electrolysis`. Expect `200`.
2. Pick "Next available day". Expect a date with at least one slot.
3. Fill the form as a new client. Verify the service picker only shows consultation modalities.
4. Submit. Expect a confirmation banner and a confirmation email in the inbox.
5. SQL:
   ```sql
   select id, status, starts_at, cancellation_token_hash,
          confirmation_send_attempts, confirmation_sent_at
     from public.appointments
    where studio_id = '<studio uuid>'
    order by created_at desc
    limit 5;
   ```
   Expected: new row, `status='confirmed'`, `confirmation_send_attempts >= 1`, `confirmation_sent_at` populated. **Tokens are hashed at rest — the new row has `cancellation_token_hash` non-null (64 lowercase hex).** The confirmation email's `/cancel/<token>` link still carries the raw token (generated in-memory at booking); clicking it resolves because the route hashes the URL token and matches `cancellation_token_hash`. **PR #264 (migration 0091): the legacy raw `cancellation_token` column has been dropped — selecting it now errors; every row (including older ones, via the 0090 backfill) is found by hash only.**

### Appointment token hashing smoke (PR #260, migration 0090)

End-to-end check that hashing at rest did not break the public cancel/reschedule/manage links:

1. Book a public appointment (smoke 1). Confirm the confirmation email's **Cancel** and **Reschedule** links open `/cancel/<token>` and `/reschedule/<token>` and resolve to the appointment (not the generic "link can't be used" page).
2. SQL on that row: `cancellation_token_hash` is non-null 64-hex. (PR #264 / migration 0091 dropped the raw `cancellation_token` column — it no longer exists.)
3. As that client, open the **Portal** (smoke 2): the upcoming appointment's **Manage** button lands on a working `/manage/<token>` page whose **Reschedule** and **Cancel** actions both resolve (the portal mints the HMAC token; `/reschedule` accepts it as of PR #260).
4. Trigger an appointment reminder (or wait for the 15-min scheduler): the reminder email's cancel/reschedule links and the SMS manage link all resolve.
5. Negative: `/cancel/not-a-real-token` shows the generic neutral error (no token-state leak), unchanged.

This is also pinned automatically by `tests/db/appointment-token-hash.db.test.ts`, `tests/lib/booking/appointment-token-hash.test.ts`, and `e2e/appointment-token-hash.spec.ts`.

### Public booking PII log minimization smoke (PR #261)

Confirms the unauthenticated public booking error logs never carry raw client PII:

1. Primary coverage is `tests/app/book/pii-log-minimization.test.ts` (source-grep) — run `npm test`.
2. Optional manual check (**no production writes**): in a NON-prod environment, force a public booking error path (e.g. an existing-client / archived-collision attempt) and inspect the function logs. Each `public_booking_*` line must contain only `code`, `studioId`, and `emailFingerprint` (a 64-char hex), plus `archivedClientCollision: true` on the collision path — never a raw email, `normalizedEmail`, `archivedClientId`, or a raw Postgres `message`.
3. Determinism: the same booker email always yields the same `emailFingerprint` (so repeated failures stay correlatable), and the fingerprint never equals the raw email.

Do NOT exercise this against production data.

## 2. Portal smoke

1. Request a magic link at `/portal/login?studio=willow-electrolysis` for a test client.
2. Confirm the email arrives and the link points to `https://hone.care/portal/verify/<token>`. Confirm the body text reads `"This link expires in 1 hour."` (PR #166).
3. Open the link in a fresh incognito window. Confirm GET is non-consuming (page renders the Continue form).
4. Click Continue. Confirm landing on `/portal` with the two-zone layout (Needs you / Your info), and confirm the top-right cluster shows the Email <studio> button and the Sign out link as horizontal peers (PR #166 flipped them from stacked to side-by-side).
5. Verify the cookie `hone_portal_session` is httpOnly + secure.
6. Sign out by clearing the cookie. Confirm `/portal/messages` redirects when anonymous.
7. To verify the new 60-minute window: issue a magic link, wait ~35 minutes (well past the old 30-minute TTL), then click. The Continue page must render. A regression to the 30-minute TTL would surface the generic "this secure link can't be used right now" error.

## 3. Consent smoke (treatment + photo)

1. As the studio owner in `/settings/consent`, create a `treatment_consent` template. PR #167: the new template lands as **Draft** with a **Draft** badge; it is NOT in the client portal yet. Verify the helper copy above the form reads `"New forms are saved as Draft. They are not shown to clients until you mark them Active and then Live in client portal."`
2. Click **Make active**. The badge stays **Draft** (the template is now in the practitioner's workflow but not yet exposed). Confirm a **Make live in client portal** button appears.
3. Click **Make live in client portal**. The badge flips to **Live**. The row moves into the **Live in client portal** group.
4. As a test client in `/portal`, sign the form (type your name + submit).
3. SQL:
   ```sql
   select id, template_title_snapshot, template_version, template_hash,
          signature_name, signed_at, response
     from public.client_consent_signatures
    where studio_id = '<studio uuid>' and client_id = '<client uuid>'
    order by signed_at desc;
   ```
   Expected: new row with the title/body/version snapshot, `signature_name` populated, `signed_at` recent.
4. Repeat for a `photo_consent` template.

### 3a. Stale-form smoke — the ONLY lane that exercises the render→submit wiring

No e2e spec drives `/portal`, so this is the only executable check that the
render surface still supplies its comparands. Run it whenever the signing
surface or `lib/consent/sign-consent-form.ts` changes.

1. As a test client, open a live consent form in `/portal` and **leave the
   drawer open** — type a name and tick the box, but do not submit.
2. In another session, as the studio owner in `/settings/consent`, **edit that
   same template** (change a word in the body) and save. `version` bumps;
   `status` stays `active` and `is_live` stays `true`.
3. Back in the client tab, submit. Expected: the sign is **refused** with
   exactly:
   `This form changed while you were reviewing it. Please refresh and review the current version before signing.`
4. SQL: confirm **no new row** landed for that (client, template) pair.
5. Reload the client tab. The new body renders and signing now succeeds.

A pass proves the page derives the hash, the form posts it back, and the
server compares it. If step 3 *succeeds* instead of refusing, the render→submit
wiring is broken even if every unit test is green.

## 4. Photo denial smoke (PR #137)

1. From a test client's `/portal`, find an active `photo_consent` form.
2. Click "Deny" (or the equivalent UI button).
3. SQL: the new `client_consent_signatures` row carries `response='denied'` and a `response_label_snapshot` describing the deny copy. The signature is real, not absent.

## Session payment prepare smoke (PR #172, test mode only)

Manual smoke (cannot be done from the harness because it requires an active card + a signed `signed_current` `card_authorization` for a real client). Steps:

1. As studio owner in `/settings/payments`, confirm Stripe Connect is `enabled` and `stripe_livemode=false`.
2. Pick a test client who has an active card on file (PR #135 SetupIntent smoke covers adding one) and a `signed_current` card authorization (PR #170).
3. Book and complete a test appointment for that client; chart a session linked to the appointment.
4. Open `/clients/<client-id>/sessions/<session-id>`. Confirm the `Session payment` card renders immediately after `SessionInfoCard`.
5. Confirm the disclaimer reads `"This prepares a test-mode payment record. It does not charge the client."`
6. Enter an amount (e.g. `$50.00`) and an internal note. Click `Prepare session payment (test mode)`.
7. Confirm the success state appears with an `Attempt id:` block.
8. SQL verify the row:
   ```sql
   select id, studio_id, client_id, appointment_id, session_id, charge_reason,
          amount_cents, currency, status, client_payment_method_id,
          card_authorization_signature_id, stripe_livemode,
          stripe_payment_intent_id, stripe_charge_id, created_at
   from public.payment_charge_attempts
   order by created_at desc
   limit 5;
   ```
   Expected: `charge_reason='session_payment'`, `status='ready'`, `stripe_livemode=false`, `stripe_payment_intent_id IS NULL`, `stripe_charge_id IS NULL`, `client_payment_method_id` populated, `card_authorization_signature_id` populated.
9. Click `Prepare session payment` again on the same session. Confirm the duplicate state appears (`A session payment attempt is already prepared for this session`).
10. Negative path: archive the active card row, refresh. Confirm the card surfaces the blocking reason `"Client must add a card on file..."`.

## Session completion to billing handoff + payment UI cleanup (PR #181)

After PR #181 ships, the calendar appointment detail and the session payment card both render a clearer current state. Run this between the appointment-completion smoke (PR #180) and the payment smoke chain.

1. Open a confirmed past test appointment.
2. Click Mark completed and confirm.
3. The appointment status flips. Below the lifecycle actions the calendar page now renders an "Appointment completed" card with the guidance line **"Next step: chart the session and bill the client."** and one primary CTA whose label depends on linked-session state:
   - No linked session: **Start session** (forwards to `/clients/<id>/sessions/new?appointment_id=<id>`).
   - Linked session but not started: **Open session** (forwards to the session page).
   - Linked started session: **Go to billing** (deep-links to the session page with `#session-payment`).
4. The previous bare `Completed` placeholder text must NOT appear. The previously-mounted ChartSessionCard ("+ Chart session" / "Session for this appointment") must NOT appear on the completed state (the NextStepCard supersedes it). ChartSessionCard continues to render for confirmed and no_show.
5. Click the CTA. You should land on the session page; if the CTA was "Go to billing" the URL ends in `#session-payment` and the payment card is in view.
6. On the session page the payment surface follows the cleaner state model:
   - When the row is in `status='succeeded'` with no successful refund the top heading reads **Test charge succeeded.**
   - When the row also carries `refund_status='succeeded'` the top heading reads **Test payment refunded.** with an amber palette + a Refund details block (Amount refunded / Refunded / Refund id) directly under the charge details.
   - No stale "Session payment prepared / Attempt id: ... No charge has been run" banner appears alongside a succeeded or refunded panel. The local prepare banner is gated on `!activeAttempt` and `router.refresh()` is called after a successful prepare so the persisted ReadyPanel takes over immediately.
7. SQL verify the row to confirm DB state matches the UI:
   ```sql
   select id, status, refund_status, refund_amount_cents, refunded_at, stripe_refund_id
   from public.payment_charge_attempts
   order by created_at desc limit 1;
   ```
8. Receipt sub-panel + Refund sub-panel still render their own per-section detail and stay reachable.

## Appointment completion + session-start smoke (PR #180)

After PR #180 ships, the workflow Chloe could not finish becomes reachable. Run this before the payment smoke chain below.

1. Find or create a confirmed past test appointment (any time before now).
2. Open it from `/calendar` or the calendar appointment detail.
3. Confirm two buttons are visible: `Mark completed` (primary / filled) and `Mark no-show` (outline). Both are enabled because the appointment has already ended.
4. Click `Mark completed`. A browser confirm appears with the exact copy: "Mark this appointment completed? This marks the appointment completed and allows the session to be charged after charting."
5. Confirm. Within a moment the appointment detail flips. The hint reads "Appointment marked completed."
6. SQL verify:
   ```sql
   select id, status, ends_at from public.appointments
   where id = '<appointment_id>';
   ```
   Expected: `status='completed'`.
7. (Optional, demonstrates auto-complete.) Skip step 5 and instead click "Chart session" from the appointment detail. After the session record is created, return to the calendar appointment detail. The appointment must now be `completed` (auto-marked by `maybeMarkAppointmentCompletedOnSessionStart`). SQL verify the same way.

Negative checks (each should leave the appointment status alone):
- Future confirmed appointment: both buttons are visible but disabled. Hover title for the Mark completed button reads "Appointment can be marked completed after the appointment has ended."
- Cancelled appointment: no Mark completed button rendered (the component early-returns null for any non-confirmed status).
- No-show appointment: no Mark completed button rendered.
- Already completed appointment: no Mark completed button rendered.

After step 6 (or 7) lands, proceed to the payment smoke chain below.

## Clinical lineage enforcement smoke (PR #286)

Confirms charting writes reject a same-studio **wrong-client** target. **Clinical data-integrity hardening only; no migration, no charting-feature/UI change.** Primary coverage: `tests/app/sessions/clinical-lineage.test.ts` (behavioral: `assertSessionForClient` resolves only when the session belongs to BOTH the studio AND the client — queries `sessions` by `id + studio_id + client_id + deleted_at null` — and rejects a wrong-client / missing / DB-error / missing-arg case with a generic "Treatment session not found." that never leaks the provider message; source-grep: all 6 `block-actions.ts` charting actions call `assertSessionForClient(studio.id, input.clientId, …)`, the studio-only `assertSessionInStudio` is gone, and block/entry writes stay scoped by the client-validated `session_id`) — run `npm test`. **Operator check (read-only, no production writes):** from Client A's session page, a stale/tampered charting submit carrying Client B's (same-studio) `sessionId`/`blockId` fails with "Treatment session not found." and writes nothing; a valid Client A charting save still succeeds. Backstopped by migration 0094 (block∈session / entry∈block∈session). Live payments remain disabled (unrelated).

## Calendar feed privacy smoke (PR #289, no migration)

Confirms the iCal subscription feed (`/calendar-feed/<token>.ics`) exposes **no client PII or treatment context by default** — important because the feed URL is a bearer secret stored by Google/Apple/Outlook along with the event contents. **Privacy hardening only; no schema/token/header change.** Primary coverage: `tests/app/calendar-feed/feed-privacy.test.ts` (behavioral — renders the route with a planted client name/email/phone/address/notes/modality/token and asserts NONE appear in the ICS; the feed is a valid importable VCALENDAR with `SUMMARY:Hone appointment`, the generic description, a PII-free `UID:<appt>@hone.care`, accurate DTSTART/DTEND, `no-store` cache; a too-short token still 404s; source-grep — the appointment SELECT no longer pulls `clients(name)`/`services(modality)` and the description is the generic constant, not a client/modality composition) + the existing `tests/app/calendar-feed/route-hash-lookup.test.ts` (hash-at-rest lookup + generic 404 + no raw token, all still green). **Operator check (read-only, no production writes — do NOT subscribe a real provider):** fetching a valid feed URL returns events titled "Hone appointment" with a generic "Open Hone for details" description and a `View in Hone: <origin>/calendar/<id>` link — no client name, no modality, no token; opening that link (auth-gated) shows the real details. Existing feed tokens keep working. No migration; live payments remain disabled.

## Notification helper test reliability (PR #288, test-only)

CI reliability checkpoint — **no operator-facing behavior, no production change.** A prior full-suite run flaked/timed out on `tests/lib/notifications/practitioner-notifications.test.ts > runtime: invalid event type … returns void synchronously` (it passed when rerun alone). Investigation found a **test-isolation** issue, not a code bug: `recordPractitionerNotification` is fire-and-forget by design (a notification miss must never roll back the committed booking/cancel/reschedule), so the invalid-event smoke left an unawaited `await import("@/lib/ops/alerts") + recordOpsAlert(...)` + `createAdminClient` chain running in the background past the test — the suspected timeout source under `pool: "forks"`. The runtime smoke now mocks the fire-and-forget targets, flushes microtasks so the chain settles inside the test, and asserts the invalid path logs exactly one warning ops alert and attempts no insert (valid path swallows the admin-client throw). **Reliability check (read-only, safe — vitest loads no `.env.local`, so the fire-and-forget `recordOpsAlert` can't reach prod):** `npx vitest run tests/lib/notifications/practitioner-notifications.test.ts` (10× green) and `npm test` (green). No `lib/notifications/*` / reminder / cron / ops-alert / payment behavior change; no migration; live payments remain disabled.

## Critical ops-alert delivery env gate (PR #291)

Confirms a production deploy **cannot silently ship with critical ops-alert email delivery disabled**. **Config verification only — no migration, no runtime change, no email sent, no Stripe/payment change.** Primary coverage: `tests/scripts/check-production-env-gates.test.ts` (spawns `scripts/check-production-env-gates.mjs` with a controlled env keyed on `VERCEL_ENV`): production + `OPS_ALERT_EMAILS` missing / empty / whitespace-or-comma-only → **exit 1, `FAIL ops-alert-delivery-env`**; production + Upstash + `OPS_ALERT_EMAILS` with ≥1 recipient → **exit 0, both PASS lines**; preview/unset (off-production) + missing → **SKIP, exit 0, no FAIL**; the configured address is **never printed** (sentinel asserted absent on PASS and FAIL paths); Upstash and the ops-alert gate are independent (each can fail alone); source-grep pins the `OPS_ALERT_EMAILS` requirement + `ops-alert-delivery-env` label + the `opsAlertRecipientCount` parser (mirrors `parseOpsAlertEmails`), and that the script adds **no** email send / external alert provider (Slack/PagerDuty/OpsGenie/webhook) / Stripe-gate change / fail-open bypass. **Operator check (read-only, no real send — do NOT trigger a production alert):** in the Vercel Production env, `OPS_ALERT_EMAILS` must list ≥1 recipient; a production build with it unset fails the `check-production-env-gates` step before `next build`. Live payments remain disabled.

## Ops-alert message redaction smoke (PR #285)

Confirms operator alerts are safe by default — the alert MESSAGE (not just `safe_details`) is centrally redacted before every sink (server log, `ops_alerts` row, admin page, critical email). **Privacy hardening only; no migration, no UI/notification-channel change, no payment/reminder/Treatment-Photos behavior change.** Primary coverage: `tests/lib/ops/redact.test.ts` (pure `redactOpsAlertMessage` scrubs email / phone / Bearer / CRON_SECRET / JWT / Supabase signed URL / URL token+signature params / appointment-cancel token / `treatment-images` + raw `<uuid>/<uuid>/` storage paths / Stripe `sk_`/`rk_`/`whsec_`/`pi_…_secret_` / high-entropy tokens / named `token`/`secret`/`password`/`client_secret` fields; PRESERVES non-secret `pi_`/`ch_`/`re_`/`cus_` ids + UUIDs; deterministic + idempotent; safe_details value redaction; central wiring in `recordOpsAlert` before log/DB/email) + the existing `tests/lib/ops/alerts.test.ts` (safe_details + never-throws) — run `npm test`. **Operator check (read-only):** on `/admin/ops-alerts`, an alert whose source error referenced an email/phone/token/signed URL shows `[redacted]` in place of the secret while keeping the event, severity, studio/client/PaymentIntent ids, and route. Live payments remain disabled (unrelated).

## Reminder scheduler alerting smoke (PR #283)

Confirms a stale/missing external reminder scheduler becomes a deduped ops alert (not just a passive admin card). **Do NOT trigger production reminders or call `/api/cron/appointment-reminders`.** Primarily verified by `tests/lib/cron/reminder-heartbeat.test.ts` (pure decision + safe_details) + `tests/app/cron/reminder-heartbeat-wiring.test.ts` (the daily-cron wiring) — run `npm test`.

Behavior to expect:
- **Healthy** heartbeat (last success ≤45 min) → admin **Reminder scheduler** card green; the daily check records **no** alert.
- **Stale** (>45 min) → daily `materialize-recurring-breaks` cron records one `reminder_scheduler_stale` (**warning**) ops alert.
- **Missing** (no recorded run) → one `reminder_scheduler_missing` (**critical**, emails `OPS_ALERT_EMAILS`).
- **Dedupe:** while an unresolved alert for that event exists, repeated daily runs record **nothing** (no spam).
- The alert `safe_details` carry only `status` / `last_success_at` / `age_minutes` / `cadence_minutes` / `stale_after_minutes` / `checked_at` — no `CRON_SECRET`, Authorization header, client PII, or reminder content.
- **Detection latency** ≤ ~24h (daily cron); the admin card is the real-time view.

Operator check (read-only): the alerts appear on `/admin/ops-alerts` (critical-first). Resolve manually after the external scheduler (cron-job.org) is confirmed healthy and the admin card returns to **Healthy**. Full runbook: docs/08 §"Reminder scheduler alerting + runbook (PR #283)". Live payments remain disabled (unrelated).

## Payment manual-review queue smoke (PR #290)

Confirms the admin-only, **read-only** payment manual-review queue at `/admin/payments/manual-review`. **Payment operations hardening before live payments; no migration, no payment runtime change, no Stripe call, Stripe gates unchanged.** Primary coverage: `tests/app/admin/payment-manual-review.test.ts` (behavioral pure helpers — `isPaymentManualReviewEvent` includes the critical `session_payment_*` / `payment_intent_*` / `payment_refund_*` / `charge_refunded_*` / `stripe_webhook_*` / `payment_charge_*` events and excludes warnings / card-on-file-setup / non-payment events; `selectPaymentReviewAlerts` keeps only **unresolved critical** payment alerts — a warning, a resolved alert, and a non-payment critical are all dropped; the view-models copy a fixed safe allowlist so a planted client name / notes / `failure_message_safe` / card fingerprint / `stripe_customer_id` never reach the view; 60-min threshold; conservative next-step text; source-grep — the page is under `app/admin` (inherits the `isAdmin` gate) + re-checks `isAdmin`/`notFound`, is `force-dynamic`, reads via the service-role client, queries `payment_charge_attempts status='pending_stripe'` + `ops_alerts severity='critical' resolved_at IS NULL`, renders no client names, makes **no** `.update/.insert/.delete/.upsert/.rpc`, imports no server action, makes **no** Stripe call, surfaces a read failure loudly (no false empty queue) without leaking the provider error, and links to `/admin/ops-alerts` for resolution) — run `npm test`. **Operator check (read-only, admin-only, no production writes):** open `/admin/payments/manual-review` as an admin — it lists stuck `pending_stripe` attempts + unresolved critical payment alerts with the PaymentIntent id / Hone status / amount / live-or-test flag / redacted message and a "do not retry/refund blindly, follow docs/16 §17" banner; there are NO resolve/retry/refund buttons (resolution is on `/admin/ops-alerts`); a non-admin / anonymous request cannot reach it. Live payments remain disabled.

## Payment reconciliation read-only checks (PR #282)

Operator/reviewer sweep for unreconciled payment state. **Read-only — every query is `SELECT`-only and never calls Stripe.** Run from the Supabase SQL editor (read-only role) or a read replica; the full snippets live in [docs/16 §17.7](./16_LIVE_PAYMENTS_READINESS.md#177-read-only-reconciliation-checks-select-only). Run before/after any controlled live payment and on a schedule once live. Expected (test-mode steady state): all six return clean.

1. **Stuck `pending_stripe` (> 60 min)** — `payment_charge_attempts` where `status='pending_stripe'` and `updated_at < now() - interval '60 minutes'`. Expect 0 rows.
2. **Stripe PI present, local not succeeded** — `payment_charge_attempts` with a `stripe_payment_intent_id` but `status` not in (`succeeded`,`failed`). Cross-check each PI in the Stripe dashboard. Expect 0 rows.
3. **#281 success-persistence criticals** — unresolved `ops_alerts` for `session_payment_succeeded_write_failed` / `session_payment_succeeded_write_zero_rows`. Expect 0 rows.
4. **Refund-review alerts** — unresolved `ops_alerts` `payment_refund_%` (warning/critical). Expect 0 rows.
5. **Unprocessed/unmapped webhook events** — `stripe_events` with `processed_at IS NULL` in the last 7 days. Expect 0 rows.
6. **Recent payment criticals** — `ops_alerts` severity `critical` for `session_payment_%` / `payment_intent_%` / `payment_refund_%` / `charge_%` / `stripe_webhook_%` in the last 7 days, unresolved first. Expect 0 unresolved.

These are also the §17.7 checks the operator runs **before** any live-mode change and **after** the first controlled live payment. Any non-empty result is a reconciliation item — investigate against the Stripe dashboard before any retry; never `UPDATE`/`DELETE` a payment row by hand. Critical alerts are also visible on the admin **Ops alerts** page (`/admin/ops-alerts`). **Live payments remain disabled; this PR does not start controlled live-payment enablement.**

## Payment success persistence smoke (PR #281, test mode only)

Verifies the authoritative-success rule: a charge returns a normal `succeeded` result ONLY when Stripe succeeded **and** Hone persisted the success on the local ledger. When Stripe succeeds but the local success write fails (DB error) or affects zero rows, the practitioner must see an indeterminate **manual-review** result (NOT a clean success) and a critical ops alert must exist.

Happy-path check (normal run):
1. Run a normal test charge (the payment smoke chain above) so a `status='succeeded'` row exists.
2. Confirm the UI shows **Test charge succeeded** and SQL shows `status='succeeded'` with `stripe_payment_intent_id`, `stripe_charge_id`, `charged_at` populated.
3. SQL verify NO `session_payment_succeeded_write_failed` / `session_payment_succeeded_write_zero_rows` alert for this attempt:
   ```sql
   select event, severity, created_at from public.ops_alerts
   where event in (
     'session_payment_succeeded_write_failed',
     'session_payment_succeeded_write_zero_rows'
   )
   order by created_at desc limit 5;
   ```

Persistence-failure behavior (primarily pinned by source-grep tests — the harness/operator cannot easily force a real DB-write error mid-charge):
- **Stripe success + DB write error** → critical ops alert `session_payment_succeeded_write_failed`; the practitioner-facing result is `needs_manual_review` with the message *"Stripe reported the payment as succeeded, but Hone could not confirm the local payment record. Review the payment in Stripe and Hone before retrying."* The attempt row stays `pending_stripe`.
- **Stripe success + zero-row update** → critical ops alert `session_payment_succeeded_write_zero_rows`; same `needs_manual_review` result.
- In neither case does the result report a normal `succeeded` outcome.
- **Backstop:** the `payment_intent.succeeded` webhook (below) later reconciles a `pending_stripe` row to `succeeded`, so a transient DB-error split self-heals even though the synchronous result was honestly indeterminate.
- Detect any indeterminate split that needs an operator: any critical `session_payment_succeeded_write_*` alert in `ops_alerts` is the wake-up signal; reconcile the named `attempt_id` against its Stripe PaymentIntent before retrying.

Source enforcement: `tests/lib/billing/payment-success-persistence.test.ts` and `tests/lib/billing/payment-outcome-zero-row.test.ts`. **Live payments remain disabled; controlled live-payment enablement has not started.**

## Webhook reconciliation smoke (PR #179, test mode only)

Run this after a full Prepare -> Run test charge -> Send receipt -> Refund chain has produced a `succeeded` row with `refund_status='succeeded'`.

### Required (no special tooling)

1. Open the session detail page after running the full chain.
2. SQL verify the row is fully reconciled by the action layer (no webhook needed for this baseline):
   ```sql
   select id, status, stripe_payment_intent_id, stripe_charge_id, charged_at,
          refund_status, stripe_refund_id, refunded_at, refund_amount_cents
   from public.payment_charge_attempts
   order by created_at desc limit 5;
   ```
   Expected: `status='succeeded'`, `refund_status='succeeded'`, both `stripe_*_id` populated, `charged_at` + `refunded_at` populated.
3. SQL verify NO critical ops_alert tied to the chain:
   ```sql
   select event, severity, message, created_at from public.ops_alerts
   where event in (
     'payment_intent_succeeded_local_terminal_mismatch',
     'payment_intent_failed_after_local_succeeded',
     'payment_intent_failed_local_terminal_mismatch',
     'charge_refunded_partial_out_of_band',
     'charge_refunded_out_of_band_reconciled',
     'payment_charge_dispute_created',
     'stripe_webhook_metadata_mismatch',
     'stripe_webhook_livemode_event_ignored'
   )
   order by created_at desc limit 10;
   ```
   Expected: no new critical alert tied to this chain (a `charge_refunded_out_of_band_reconciled` would be warning-severity and would only appear if a Stripe-Dashboard refund happened separately).

### Optional (Stripe CLI replay)

If the Stripe CLI is configured for the studio's connected account:

4. Replay a `payment_intent.succeeded` event for the prepared PaymentIntent. The webhook should:
   - return 200,
   - leave the row unchanged (it's already `succeeded`),
   - NOT fire a duplicate ops_alert.
5. Replay a `charge.refunded` event. The webhook should:
   - return 200,
   - leave the row unchanged (already refunded),
   - NOT fire a critical ops_alert.
6. Test the mismatch surface: issue a partial refund via the Stripe Dashboard (test mode) against a fully-refunded charge. The webhook should fire a critical `charge_refunded_partial_out_of_band` and leave the row alone.
7. Test the dispute surface: trigger a Stripe-test dispute (`charge.dispute.created`). The webhook should fire a critical `payment_charge_dispute_created` with charge / dispute / amount / reason in the safeDetails.

If Stripe CLI is not available, document what was tested via the application path only; the webhook handler correctness is proven by the source-grep test suite + the structural idempotency guarantees of the existing `stripe_events` ledger.

## Session payment test-mode refund smoke (PR #178, test mode only)

Run after a `succeeded` session_payment row exists. The row must NOT already be refunded (`refund_status IS NULL`).

1. Open the session detail page that produced the `succeeded` attempt.
2. Confirm the Succeeded panel renders with the green border.
3. Below the Receipt sub-panel, confirm the new Refund sub-panel is visible. It must say "This creates a Stripe test-mode refund for this charge. No live money is moved." and show a "Refund test charge" button.
4. Click `Refund test charge`. The button must flip to "Confirm: refund test charge ($X.XX)" alongside a Cancel button.
5. Click the confirm button.
6. Within a few seconds the sub-panel must flip to "Test refund succeeded." with `Amount refunded: $X.XX`, `Refunded: <date>`, and `Stripe refund: re_...`. The Refund test charge button must disappear.
7. Reload the page. Confirm the same "Test refund succeeded" state survives.
8. SQL verify the row:
   ```sql
   select id, charge_reason, status, refund_status, refunded_at,
          stripe_refund_id, refund_amount_cents, stripe_livemode
   from public.payment_charge_attempts
   order by created_at desc
   limit 5;
   ```
   Expected: `refund_status='succeeded'`, `refunded_at` populated ≈ now, `stripe_refund_id` starts with `re_`, `refund_amount_cents = amount_cents` (full refund), `stripe_livemode=false`.
9. Verify the Stripe Dashboard (TEST mode, the studio's connected account). The original test charge must show as Refunded; a Refund object with the matching `re_...` id must exist.
10. Confirm no critical ops_alert fired:
    ```sql
    select event, severity, message, created_at from public.ops_alerts
    where event in (
      'payment_refund_stripe_unknown_outcome',
      'payment_refund_succeeded_write_failed',
      'payment_refund_failed_write_failed'
    )
    order by created_at desc limit 5;
    ```
    Expected: no new alert tied to this smoke attempt.

Negative paths (manual variations):
- Click `Refund test charge` against a `pending_stripe` row: button must be absent (only succeeded rows show it).
- Click `Refund test charge` against an already-refunded row: button must be absent (the Test refund succeeded state holds).
- Run the action against a row whose `stripe_charge_id IS NULL`: helper returns `outcome:"missing_charge_id"`; the row's `refund_status` stays null. (This requires an in-DB scenario; not normally reachable from a clean prod row.)

## Session payment test-mode receipt smoke (PR #175 + PR #177, test mode only)

**PR #177 update (2026-06-08):** PR #177 unblocked this smoke by repairing the stale `client_payment_methods.card_authorization_signature_id` pointer in prod (migration 0077) and tightening the session payment prepare/execute gate so future drifts surface with the clear "Client must re-sign the current card authorization for the card on file." remedy at prepare time. The known prod row at `My Studio` is repaired; the helper auto-maintains the pointer on every future `card_authorization` re-sign. Run the steps below against any `succeeded` session_payment row.

Run after a `succeeded` session_payment row exists.

1. Open the session detail page that produced the `succeeded` attempt.
2. Confirm the green Succeeded panel renders. Confirm a new `Receipt` sub-panel is visible inside it.
3. Confirm the sub-panel shows the disclaimer "Sends a Stripe test-mode receipt to the client. No live card was charged." and the `Send test receipt` button.
4. Confirm a test client with an email on file is associated with the attempt.
5. Click `Send test receipt`. Wait for the network round-trip.
6. Confirm the sub-panel flips to "Receipt already sent to <email> on <date>." within the same render.
7. Reload the page. Confirm the same "already sent" state survives the refresh.
8. SQL verify the row:
   ```sql
   select id, charge_reason, status, receipt_status, receipt_sent_at,
          receipt_email_to, stripe_livemode, stripe_payment_intent_id,
          stripe_charge_id
   from public.payment_charge_attempts
   order by created_at desc
   limit 5;
   ```
   Expected: `receipt_status='sent'`, `receipt_sent_at` populated, `receipt_email_to` matches the test client's email, `stripe_livemode=false`, `stripe_payment_intent_id` populated.
9. Verify the actual email arrived at the test client's mailbox. Confirm the subject starts with "TEST MODE" + the studio name + the reason label + the amount. Confirm the body carries the three disclaimers: "This is a Stripe test-mode receipt. No live card was charged.", "No tax calculation is included on this receipt.", "If this test payment needs to be refunded, the practitioner can issue a test-mode refund in Hone." (PR #181 replaced the pre-PR-#178 "Refund handling is not enabled in Hone yet." wording.) Confirm the body does NOT say "tax receipt" / "official invoice" / "payment complete" / "live payment".
10. Click `Send test receipt` again (should not appear because state is now `sent`; if it does, that's a bug). Verify no new email is delivered and the SQL row remains untouched.

Negative path (no client email): use a test client whose `clients.email` is null or empty. Confirm the action returns the `client_email_missing` outcome and the row's `receipt_status` stays null.

## Session payment post-refresh state smoke (PR #174, test mode only)

Run after the PR #173 EXECUTE smoke has produced a `succeeded` row.

1. Open the session detail page that produced the `succeeded` attempt.
2. Confirm the green Succeeded panel appears with:
   - Heading: "Test charge succeeded."
   - Amount + charged-at timestamp.
   - PaymentIntent id (`pi_...`).
   - Charge id (`ch_...`) if available.
   - Explicit "This was a Stripe test-mode charge. No live card was charged. No receipt was sent in this PR."
3. Reload the page. Confirm the same Succeeded panel renders with all the Stripe ids still visible (no fallback to a bare "Succeeded" label).
4. Confirm the Run test charge button does NOT appear.
5. Confirm the Prepare form does NOT appear.
6. Confirm no "Pay now" / "Charge card" / "Collect payment" / "Payment complete" / "Live payment" / "Receipt sent" copy is anywhere on the page.

Negative path (failed row): use a Stripe test card that declines (e.g. `4000 0000 0000 0002`). After execute:
1. Confirm the red Failed panel appears with sanitised failure message + failure code + failed-at.
2. Confirm the "Prepare a new session payment attempt if you need to try again." guidance is present.
3. Confirm no Run button appears.
4. Refresh and confirm the same Failed panel survives.

## Session payment EXECUTE smoke (PR #173, test mode only)

Run after the PR #172 prepare smoke has produced a `ready` row. The execute action calls Stripe in test mode on the connected account.

1. From the same session detail page that produced the `ready` attempt in the PR #172 smoke, confirm the "Run test charge" button now appears (Stripe-test-mode amber panel under the existing-attempt block).
2. Click "Run test charge". Confirm the button label changes to "Confirm: run test charge ($X.XX)" (two-click pattern).
3. Click "Confirm: run test charge". Wait for the network round-trip.
4. Confirm the green success panel appears with a `PaymentIntent: pi_...` id (and a `Charge: ch_...` id if available).
5. SQL verify the row:
   ```sql
   select id, charge_reason, status, amount_cents, stripe_livemode,
          stripe_payment_intent_id, stripe_charge_id, charged_at,
          failed_at, failure_code, failure_message_safe, updated_at
   from public.payment_charge_attempts
   order by created_at desc
   limit 5;
   ```
   Expected: `status='succeeded'`, `stripe_livemode=false`, `stripe_payment_intent_id` populated (`pi_...`), `stripe_charge_id` populated, `charged_at` non-null, `failed_at` null, `failure_code` null.
6. Click "Run test charge" again. Confirm the action short-circuits (the `runSessionPaymentCharge` already-succeeded branch). No new PaymentIntent.
7. Verify Stripe Dashboard -> Payments on the connected account: exactly one PaymentIntent + Charge.
8. Negative path: archive the active card row in `client_payment_methods` then click "Run test charge" on a NEW ready attempt. The action should refuse with a `lineage_mismatch` outcome and a practitioner-facing message; the row should remain unchanged (status='ready', no Stripe call).

## Live payments dormancy verification (PR #168)

Before running any of the payment smokes below, confirm the dormancy posture is intact:

```bash
npm run check:stripe-gates
# Expect:
#   PASS paymentIntents.create -- 1 occurrence in lib/billing/session-payment-charge.ts
#   PASS refunds.create -- 1 occurrence in lib/billing/payment-refund.ts
#   PASS STRIPE_ALLOW_LIVE_MODE=true -- 1 occurrence in lib/stripe/server.ts
#   PASS charges.create / checkout.sessions -- 0 occurrences

supabase db query --linked "
  select stripe_livemode, count(*) from public.studio_payment_settings
  group by stripe_livemode;
"
# Expect: every row stripe_livemode=false.

supabase db query --linked "
  select count(*) from public.manual_fee_charge_attempts where stripe_livemode = true;
"
# Expect: 0.
```

Full readiness review + go/no-go checklist: [docs/16](./16_LIVE_PAYMENTS_READINESS.md). Conclusion (PR #168, 2026-06-08): **NOT READY FOR LIVE PAYMENTS.**

## 5. Card-on-file smoke (test mode)

See [docs/11 Stripe card-on-file smoke](./11_RUNBOOK.md#stripe-card-on-file-smoke-test-mode). Use Stripe test card `4242 4242 4242 4242`.

Expected end state:
- One `client_payment_methods` row with `status='active'`, `stripe_livemode=false`, valid Stripe ids, non-null `card_authorization_signature_id`.
- One `stripe_events` row for `setup_intent.succeeded` with `processed_at` set and no `processing_error`.
- The portal "Your info" zone shows `Visa ending in 4242`.

### 5b. Replace card smoke (PR #151)

1. Sign into the portal as a test client who already has an active card on file (Visa 4242 from §5).
2. Confirm the "Your info" zone shows `Card on file: visa ending in 4242, expires MM/YYYY` plus a **Replace card** button (and the test-mode disclaimer).
3. Click "Replace card". Confirm:
   - Read-only summary remains visible.
   - The replace-mode helper copy renders: "Your current card will be replaced after the new card is saved. No charge will be made."
   - A Stripe Elements `<PaymentElement />` form mounts under the connected-account context.
   - An inline Cancel link is present.
4. Enter a different Stripe test card if practical (e.g. `5555 5555 5555 4444` for Mastercard) or `4242 4242 4242 4242` again. Submit "Save new card".
5. On Elements success, the form replaces itself with the success copy "Card updated. The new card may take a moment to appear on the page."
6. Refresh the portal page. The "Your info" zone now shows the new brand + last4 + expiry.
7. SQL verify:
   ```sql
   select id, status, brand, last4, exp_month, exp_year,
          stripe_livemode, stripe_account_id, stripe_customer_id,
          stripe_payment_method_id, stripe_setup_intent_id,
          card_authorization_signature_id, added_via,
          added_at, removed_at
     from public.client_payment_methods
    where studio_id = '<studio uuid>'
      and client_id = '<client uuid>'
    order by added_at desc;
   ```
   Expected:
   - Exactly ONE row with `status='active'` (the new card).
   - The prior card row is `status='removed'` with `removed_at` populated.
   - The new active row carries a non-null `card_authorization_signature_id`.
   - `stripe_livemode = false` on both rows.
   - The new active row's `stripe_setup_intent_id` is different from the prior row's.
8. Stripe Dashboard → Customers → the connected-account customer for this `(studio, client)`. Confirm a NEW PaymentMethod attached. Confirm a NEW SetupIntent succeeded. Confirm **no PaymentIntent and no Charge were created** during the replace.
9. Click "Replace card" again, then click Cancel. Confirm the form unmounts and the card summary is restored unchanged.
10. (Optional safety) Cancel a Stripe test SetupIntent that has not yet succeeded. Confirm the prior active card row is NOT removed (the webhook only flips on `setup_intent.succeeded`).

## 6. Cancellation reason smoke (PR #144)

1. From a test booked appointment, open the cancel link `/cancel/<token>`.
2. Pick "Schedule changed" from the reason dropdown. Verify the reschedule nudge appears with a `Reschedule instead` button.
3. Click the button. Confirm `/reschedule/<token>` opens.
4. Return to the cancel link. Pick "Schedule changed" again. Add a note. Check the follow-up-allowed box. Submit.
5. SQL:
   ```sql
   select action, actor_type, details, created_at
     from public.appointment_audit
    where action = 'cancelled'
    order by created_at desc
    limit 5;
   ```
   Expected: top row has `details = {"source": "public_token", "reason": "schedule_changed", "reason_label": "Schedule changed", "note": "<your note>", "follow_up_allowed": true}`.
6. Open the appointment in `/calendar/<id>` (signed in as practitioner). Confirm:
   - "Cancellation reason: Schedule changed".
   - "Client note: <your note>".
   - "Follow-up okay" badge.
   - "Cancelled N minutes after booking" if `cancelled_at - created_at <= 15 minutes`.

## 7. Calendar block smoke (PR #139 + #140)

1. As an active non-owner practitioner (if available; otherwise the owner), open `/calendar`.
2. Drag to select a window. Pick "Block time" from the chooser.
3. Confirm the block renders with the warm-tan style (PR #138).
4. Open `/book/<slug>` and the studio's booking horizon date that overlaps the block. Confirm the blocked time is NOT offered as a bookable slot.
5. Repeat with an all-day block. Confirm the block synthesises `[utc(date 00:00), utc(date+1 00:00))` (no extra calendar day swept up).

### 7b. Calendar blocked-time visibility + open-hours clarity (Chloe pilot feedback, no migration)

Render-only. (1) **Month view shows blocked time:** `renderMonthView` now loads the same block sources as the week view (`getBlockouts` + `getTimedBlocksForRange` + `getRecurringBreakOccurrencesForRange`) and `groupMonthBlockedByDate` (`app/(app)/calendar/month-blocked.ts`) produces a per-day summary; each blocked day shows a compact muted chip (full-day blockout reason, or the first timed-block/break label `+N`). (2) **Week full-day blockout shows its reason** instead of the hard-coded "Blocked" (via `displayBlockoutLabel`, fallback "Blocked"); recurring-break + timed-block labels keep working unchanged. (3) **Open hours read clearer:** the out-of-hours tint in `DayColumn` is a clearer-but-calm gray (`bg-neutral-200/70` + a hairline edge) so the open working window stands out (was the too-subtle `bg-neutral-100/80`). **Manual smoke:** add a full-day blockout with a reason → open `/calendar` (week) and confirm the overlay shows the reason; switch to **month** view and confirm a muted blocked chip appears on that day; confirm a day with a recurring break/timed block shows its label in both views; confirm open hours are visually obvious at a glance (week) in light + dark mode. Pinned by `tests/app/calendar/block-visibility.test.ts`. No booking-slot logic changed, no settings IA change, no migration.

### 7e. Calendar appointment card visual refresh (Fresha readability inspiration, no migration)

Render-only appointment-card refresh (Fresha used only as a readability benchmark — no branding/assets/palette/layout copied). (1) **Stronger-but-calm fills:** `lib/calendar/service-colors.ts` bumps the per-service palette from the ultra-pale `bg-*-50` + `border-l-*-400` to **`bg-*-100` + a saturated `border-l-*-500`**; the appointment card's left accent goes `border-l-[3px]` → **`border-l-4`**. Deterministic hash + neutral fallback unchanged; the **rose/red family stays excluded** (reserved for allergy/EpiPen). (2) **Visible time range:** the card shows **"9:00–10:00"** via a new pure `timeRangeLabel` (`calendar-format.ts`), derived from the existing `starts_at`/`ends_at` (no data/query change). (3) **Hierarchy:** tall cards render three lines — **time range → bold client name → service/modality on its own line**; short blocks keep one dense line (bold name + range). Terminal/cancelled dim, click/link, and positioning math are unchanged. **Manual smoke:** on `/calendar` (week/day), confirm appointment blocks read as clearer colored blocks with a visible time range, bold name, and service on its own line, in light + dark mode; short (15-min) blocks stay legible; blocked-time cards + open-hours shading are unchanged. Pinned by `tests/app/calendar/appointment-card-refresh.test.ts`. Out of scope (deferred): open-hours band, gridline tuning, month-chip polish, mobile day-view. Live payments remain disabled.

### 7d. Postcare sent visibility (Chloe pilot feedback, no migration)

Read-only visibility over the **existing** postcare send timestamp — `appointments.postcare_email_sent_at` + `postcare_email_send_attempts` (migration 0043). **Not** a delivery/receipt confirmation or a compliance audit: the copy says "sent" (the recorded send), never "delivered"/"received". (1) **Appointment detail** (`PostcareSendButton`): a clear "✓ Postcare sent {date}" status when sent (+ "· N attempts" when >1) and an explicit **"Not sent yet."** when unsent — no more guessing. (2) **Client profile → appointment timeline**: `getAppointmentsForClientProfile` now also selects the two postcare columns (read-only) and each appointment row shows "Postcare sent {date}" when a send was recorded — a per-client postcare history. The `sendPostcareEmailAction` send path is unchanged; nothing is sent on render. **Manual smoke:** open an appointment with postcare already sent → confirm the "Postcare sent {date}" status; open one not yet sent → confirm "Not sent yet."; open the client profile → Sessions/appointments → confirm rows with a recorded send show "Postcare sent {date}". Pinned by `tests/app/calendar/postcare-sent-visibility.test.ts`. No migration; deferred to a later PR: `sent_by`, content snapshot, delivery receipt, precare-sent tracking, inspector export/audit table.

### 7c. Settings Availability / Breaks & Blocks consolidation (Chloe pilot feedback, no migration)

IA/render only. The separate "Breaks & blocks" settings tab (`/settings/calendar`) is folded into **Availability** (`/settings/availability`): recurring breaks + one-off timed blocks now render there alongside weekly hours and whole-day blockouts, and the page copy clarifies the four concepts (weekly hours, whole-day blocked dates, repeating breaks, one-off timed blocks). The `RecurringBreaksSection` + `TimedBlocksSection` components moved into `app/(app)/settings/availability/` and now import their actions from `./actions` (the same centralized `availability/actions.ts` — unchanged); the owner-only gate is preserved. The "Breaks & blocks" nav item is removed; `/settings/calendar` now `redirect()`s to `/settings/availability` (safe for bookmarks/deep links). **No DB table merge, no booking-slot change, no calendar rendering change, no migration.** **Manual smoke:** as owner open `/settings/availability` → confirm weekly hours, whole-day blocked time, **Repeating breaks**, and **Timed blocks** all render and save; confirm the settings nav no longer shows "Breaks & blocks"; open `/settings/calendar` → confirm it redirects to Availability. Pinned by `tests/app/settings/availability-consolidation.test.ts`.

### 7a. Calendar return-to-date navigation (Chloe pilot feedback, no migration)

When a practitioner returns from an appointment to the calendar, they should land back on the view/date they came from (not today). The week page now appends a safe return context (`?view=week&week=<anchor>`) to each appointment-detail link (`DayColumn`), and the detail page's back link is built from those params via `calendarReturnHref` (`app/(app)/calendar/calendar-return.ts`) — always internal to `/calendar`, falling back to bare `/calendar` when absent, and never an external URL (unknown view / malformed date anchors are dropped). **Manual smoke:** open `/calendar`, navigate to a non-current week (Next ›), open an appointment, then click "← Calendar" — confirm you return to that same week, not today. Confirm a direct `/calendar/<id>` link (no params) still back-links to `/calendar`. Pinned by `tests/app/calendar/return-nav.test.ts`. Render/routing-only: no schema/migration, no appointment mutation, no other calendar rendering changed.

## 8. Fee protection smoke (PR #145)

1. As owner in `/settings/payments`, set both `late_cancel_fee_cents` and `no_show_fee_cents` to non-zero values via the FeeAmountsCard.
2. Open a cancelled appointment with full evidence (active card, signed authorization, policy ack). The "Cancellation/no-show fee" card should show the eligible preview on the Late cancellation tab and block on the No-show tab with "No-show fee requires a no-show appointment."
3. Try Prepare with no internal note → blocked (client-side disable + server-side `NOTE_REQUIRED_ERROR`).
4. Add note + Prepare → success card "Manual charge prepared. No money has been charged yet."
5. SQL:
   ```sql
   select id, charge_type, status, amount_cents, currency,
          internal_note, timing_classification, created_at
     from public.manual_fee_charge_attempts
    order by created_at desc
    limit 5;
   ```
   Expected: new row with `status='ready'`, `timing_classification='practitioner_asserted'`, your note populated.
6. Set both fee amounts to NULL or 0. Confirm the eligible preview disappears and the blocked panel reads "Late cancellation fee amount is not configured."

## 9. Test-mode manual fee charge smoke (PR #146)

Critical money-adjacent path.

1. Pre-conditions: a `ready` attempt exists from §8 above. Stripe is in test mode (`STRIPE_SECRET_KEY` starts with `sk_test_`).
2. On the appointment detail page, click "Run test charge".
3. Wait for the success card to render.
4. SQL:
   ```sql
   select id, status, stripe_livemode,
          stripe_payment_intent_id, stripe_charge_id,
          stripe_idempotency_key, charged_at
     from public.manual_fee_charge_attempts
    where id = '<attempt uuid>';
   ```
   Expected: `status='succeeded'`, `stripe_livemode=false`, `stripe_payment_intent_id` populated, `stripe_charge_id` populated, `stripe_idempotency_key = 'hone:manual-fee:<attempt-id>:v1'`, `charged_at` set.
5. Stripe Dashboard → Payments under the connected account: exactly one PaymentIntent + Charge with metadata `hone_manual_fee_charge_attempt_id=<your id>`, `hone_environment=test`.
6. Click "Run test charge" again on the same now-succeeded row. The action short-circuits via `already_succeeded`. Stripe Dashboard shows still exactly one PaymentIntent.
7. Refresh the appointment detail page (simulating a network blip mid-action). Confirm the success panel reads the same `stripe_payment_intent_id`.
8. Prepare a separate `ready` attempt on a different appointment. Click "Cancel prepared fee" with a reason. Confirm:
   - Row flips to `status='cancelled'`.
   - `stripe_payment_intent_id` stays NULL.
   - No Stripe call (verify in dashboard).
9. Confirm no email/SMS receipt was sent (none should be; no receipt code exists today).
10. Confirm no live payment exists.

## 9b. Public reschedule safety smoke (PR #149)

Critical safety path. Public reschedule must match public booking on past-slot handling and must never expose raw DB or RPC errors.

1. Create a test appointment in the future. Open its `/reschedule/<token>` link.
2. Confirm the summary loads and slots render.
3. Pick **today** as the date. Confirm slots earlier than or equal to now are NOT offered.
4. Submit a forged form with `newStartsAt <= now()` (browser devtools edit the value attribute on a hidden field or POST directly). Confirm the response is the generic "This reschedule link can't be used right now." copy with no raw Postgres or function-name text.
5. Cancel the original appointment via `/cancel/<token>`. Re-open `/reschedule/<token>`. Confirm the page renders the generic unavailable surface and `/reschedule/<token>`'s read actions do not return the appointment summary.
6. Mark another future appointment `completed` and another `no_show` (via the practitioner calendar lifecycle). Re-open each one's reschedule link. Confirm the same generic behavior.
7. SQL check after a successful reschedule:
   ```sql
   select id, status, starts_at, cancellation_reason, cancelled_at,
          cancelled_by, cancellation_token_hash, updated_at
     from public.appointments
    where studio_id = '<studio uuid>'
      and (id = '<original id>' or starts_at = '<new starts_at>')
    order by updated_at desc;
   ```
   Expected: original row has `status='cancelled'`, `cancellation_reason='Rescheduled via email link'`. New row has `status='confirmed'` and a new `cancellation_token_hash` (64-hex). The raw `cancellation_token` column was dropped by migration 0091 (PR #264) — the raw token exists only in the outbound link at creation time, never at rest; links resolve by hashing the URL token and matching `cancellation_token_hash`.
8. SQL check the RPC source carries both guards:
   ```sql
   select pg_get_functiondef(p.oid)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname='public' and p.proname='reschedule_appointment';
   ```
   Expected substring matches:
   - `v_original.starts_at <= now()`
   - `p_new_starts_at <= now()`
9. Run the local automated test harness against the action's source file:
   ```bash
   npm test
   ```
   Expected: every test in `tests/app/reschedule/error-sanitization.test.ts`, `tests/app/reschedule/submitted-start-guard.test.ts`, and `tests/lib/booking/slots-filter-future.test.ts` passes. These pin down "no raw .message leak", "strict > now()" comparison, and the shared future-slot filter.

## 10. Security route smoke

```bash
echo "=== Anonymous routes ==="
curl -sI -o /dev/null -w "/book/willow-electrolysis %{http_code}\n" \
  "https://hone.care/book/willow-electrolysis"
curl -sI -o /dev/null -w "/calendar %{http_code} -> %{redirect_url}\n" \
  "https://hone.care/calendar"
curl -sI -o /dev/null -w "/settings/payments %{http_code} -> %{redirect_url}\n" \
  "https://hone.care/settings/payments"
curl -sI -o /dev/null -w "/portal %{http_code} -> %{redirect_url}\n" \
  "https://hone.care/portal"
curl -sI -o /dev/null -w "/portal/messages %{http_code} -> %{redirect_url}\n" \
  "https://hone.care/portal/messages"

echo "=== Token route privacy headers ==="
for p in /cancel /reschedule /manage /intake /portal/verify; do
  echo "${p}/fake:"
  curl -sI "https://hone.care${p}/fake" \
    | grep -iE '^(HTTP|x-robots-tag|referrer-policy)'
done

echo "=== /calendar-feed/fake.ics has the same headers ==="
curl -sI "https://hone.care/calendar-feed/fake.ics" \
  | grep -iE '^(HTTP|x-robots-tag|referrer-policy)'
```

Expected:

| Route | HTTP | Redirect / headers |
|---|---|---|
| `/book/willow-electrolysis` | `200` | n/a |
| `/calendar` | `307` | `/login` |
| `/settings/payments` | `307` | `/login` |
| `/portal` | `307` | `/portal/login` |
| `/portal/messages` | `307` | `/login` |
| `/cancel/fake` | `200` | `X-Robots-Tag: noindex, nofollow`, `Referrer-Policy: no-referrer` |
| `/reschedule/fake` | `200` | same |
| `/manage/fake` | `200` | same |
| `/intake/fake` | `200` | same |
| `/portal/verify/fake` | `200` | same |
| `/calendar-feed/fake.ics` | `404` (no real token) | same |

### 10b. Invite-only auth + no-studio gate (PR #253)

Hone is invite-only for supervised studios; there is no self-serve signup or public studio creation. Anonymous (no session): `/login` returns `200` and shows "Sign in to Hone" with the line "Invited users only. Use the email address your studio invitation was sent to." and NO "Create account / Sign up / Create studio" CTA; `/no-access` returns `307 -> /login`; and there is no `/signup` or `/register` route (`curl -sI https://hone.care/signup` and `/register` return `404`). No-studio authenticated user (an uninvited Google sign-in, or any account with no `pending_invitations` match — i.e. an `auth.users` row with no practitioner): after the auth callback they are redirected to `/no-access` (NOT the dashboard), which shows "No studio access yet", the invite-only explanation, a Sign out button (→ `/login`), and a Contact Hone link (`mailto:hello@hone.care`), and NO app navigation or studio data; hitting `/dashboard`, `/clients`, `/calendar`, `/records`, `/settings/*`, or `/admin` directly all redirect (`307`) to `/no-access` (the middleware gate runs before any app page renders, so no studio data loads and no server error is logged). Invited owner first sign-in still works (the supported `pending_invitations` → `handle_new_user` → owner practitioner path; the existing Chloe/Willow account is unaffected). Public booking (`/book/<slug>`) and the marketing site remain public. The e2e lane (`e2e/invite-only.spec.ts`) proves the no-studio gate end to end on the local stack; the RLS posture (no authenticated user can create a studio / membership / invitation or escalate a role) is pinned by `tests/db/invite-only-posture.db.test.ts`.

### 10c. Internal New Studio Wizard (PR #254)

The internal New Studio Wizard lives at the operator-only `/admin/studios/new` and automates the docs/20 §2.1/§2.2 writes (one `studios` row + one `owner` `pending_invitations` row, via the service-role client, after an `isAdmin` gate). **Access checks (non-destructive, safe to run anytime):** anonymous `curl -sI https://hone.care/admin/studios/new` returns `307 -> /login`; a signed-in no-studio NON-operator hitting `/admin/studios/new` lands on `/no-access` (the PR #254 carve-out is `isAdmin`-only); a signed-in operator (an `ADMIN_EMAILS` entry — note a studio-less operator first lands on `/no-access` after sign-in and must navigate to `/admin/studios/new` directly) sees the "New studio" form. **Actual creation is a real production action, not a throwaway smoke** — use the wizard to do real new-studio setup per docs/20 (it creates a real `studios` row, which has no DELETE policy). On success the wizard shows the booking URL (`/book/<slug>`), the owner email, the `owner · pending` invitation, and the setup checklist ("Live payments remain disabled"); the owner is then provisioned by the **application** at their invited first sign-in (`/auth/callback` reconcile → one authoritative acceptance) — **migration 0141 made `handle_new_user()` a NO-OP, so no trigger creates the row** (the wizard never inserts a practitioner either). The wizard never sends email, touches Stripe/payments, or seeds services/availability. The access matrix + create flow are proven by `e2e/new-studio-wizard.spec.ts`; the operator gate + two-write shape by `tests/app/admin/new-studio-wizard.test.ts`; the service-role capability + RLS denial for normal users by `tests/db/new-studio-wizard.db.test.ts`.

### 10d. Admin Console V1 (PR #255)

`/admin` is the operator-only Admin Console (gated by the same `app/admin/layout.tsx` `isAdmin` check as every `/admin` route). **Access checks (non-destructive):** anonymous `curl -sI https://hone.care/admin` returns `307 -> /login`; a signed-in no-studio NON-operator → `/no-access`; a normal (non-`ADMIN_EMAILS`) studio user → `/dashboard` (the layout redirect); only an `ADMIN_EMAILS` operator sees the console. **Console contents (operator session):** a header "Admin / Internal operator tools for invite-only studio setup.", a "Live payments are disabled." banner, a **Studio setup** card with a **Create new studio** CTA → `/admin/studios/new` (the wizard is discoverable here and from the nav — no remembered URLs), four overview count cards (total studios, pending/accepted owner invites, studios needing an owner), an enhanced studios table (name → `/admin/studios/[id]`, slug → `/book/<slug>`, owner email, timezone, owner-invite status, and Owner/Services/Availability setup-health flags), and operator quick links. The page must not scroll sideways at desktop width. **Privacy:** the console shows operational metadata + aggregate counts ONLY — confirm it never renders client names, treatment notes, exposure-incident details, imported-memory contents, payment internals, Stripe ids, tokens, or audit JSON. Reads are two cheap service-role queries (`studios` + embedded counts, owner `pending_invitations` status); no new schema or tracking. Pinned by `tests/app/admin/admin-console.test.ts` (surface + the NO-client-data negatives) and `e2e/new-studio-wizard.spec.ts` (operator sees the console, no overflow, CTA → the wizard).

### 10e. Admin studio detail privacy (PR #256)

`/admin/studios/[id]` is the operator-only studio detail page (same `app/admin/layout.tsx` `isAdmin` gate; anonymous `curl -sI https://hone.care/admin/studios/<id>` → `307 -> /login`). **As of PR #256 it shows operational metadata + aggregate counts + setup-health flags ONLY** — it no longer renders raw client names (the previous gap) or any client contact, treatment note, imported-memory content, exposure incident, payment internal, Stripe id, token, or audit JSON. **Operator session check:** open a studio from the console (name → `/admin/studios/[id]`) and confirm it shows a metadata grid (booking slug → `/book/<slug>`, timezone, owner email, owner-invite status), a counts grid (Practitioners / Clients / Services / Appointments / Imported memory) with an "Aggregate counts only" note, setup-health flags (Owner active / Services configured / Availability configured / Booking slug set / Live payments disabled), and links back to the console + wizard — and that **no client name appears anywhere**. The page must not scroll sideways. Reads are one explicit-column `studios` select with embedded counts + one owner `pending_invitations(status)` query (no row-level client/practitioner/invitation tables). Pinned by `tests/app/admin/admin-studio-detail.test.ts` (no client/clinical/payment/token/audit row reads; embedded counts) and `e2e/new-studio-wizard.spec.ts` (a seeded studio's detail page renders counts/setup and the seeded client name does NOT appear).

## 11. Global security header smoke (PR #150)

Run after every deploy. The global headers ship from `next.config.ts` via the builder in `lib/security/headers.ts`.

```bash
echo "=== Global headers on a safe route ==="
curl -sI https://hone.care/book/willow-electrolysis \
  | grep -iE '^(content-security-policy|strict-transport-security|x-frame-options|x-content-type-options|referrer-policy|permissions-policy)'

echo ""
echo "=== Token routes still carry the PR #142 privacy overrides ==="
for p in /cancel/fake /reschedule/fake /manage/fake /intake/fake /portal/verify/fake /calendar-feed/fake.ics; do
  echo "--- $p ---"
  curl -sI "https://hone.care$p" \
    | grep -iE '^(content-security-policy|x-robots-tag|referrer-policy|x-frame-options|x-content-type-options|permissions-policy)'
done
```

Expected on the safe route:

| Header | Value |
|---|---|
| `Content-Security-Policy` | starts with `default-src 'self'`, contains `frame-ancestors 'none'`, contains `https://js.stripe.com`, contains `https://m.stripe.network` in BOTH `frame-src` and `connect-src`, contains the specific Supabase project host BOTH as `https://<host>` AND as `wss://<host>`, no wildcard `*`, no `sentry.io` |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` (no `preload` for this baseline) |
| `X-Frame-Options` | `DENY` |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Permissions-Policy` | starts with `camera=(), microphone=(), geolocation=()`, ... |

Expected on token routes: all of the above EXCEPT `Referrer-Policy` flips to `no-referrer` and `X-Robots-Tag: noindex, nofollow` is added.

Manual browser smoke (still required for full verification):

1. Open `https://hone.care/book/<slug>` in a fresh tab. Confirm public booking renders, slot picker works, no console CSP violations break the flow.
2. Open `https://hone.care/portal/login`. Confirm the page renders.
3. As a test client, sign in via magic link. Confirm `/portal` renders the two-zone layout.
4. Open the portal Add card flow. **Confirm Stripe Elements iframes load**, the test card `4242 4242 4242 4242` can be entered, and `setup_intent.succeeded` arrives at the webhook. CSP-breaking changes typically show up as the Stripe iframes failing to render or `loadStripe` throwing.
5. Confirm browser console shows no CSP violations on any of the core flows.
6. Confirm no second PaymentIntent / Charge was created (this PR adds no money-moving code).

## 12. Ops alerts smoke (PR #153)

Run after any PR that touches `lib/ops/alerts.ts`, the webhook, the cron routes, or the email/SMS helpers.

1. Force a benign critical alert by setting `STRIPE_WEBHOOK_SECRET` to an obviously wrong value in a non-production env and hitting `/api/stripe/webhook` with a real Stripe test event. The route returns 400 (signature mismatch); no ops_alerts row is written for the signature-mismatch path because it's a normal protocol error. Restore the secret.
2. Force a benign `cron_route_failed` by temporarily setting `SUPABASE_SERVICE_ROLE_KEY` to garbage and hitting `/api/cron/appointment-reminders` with the right `CRON_SECRET`. The route's catch fires `cron_route_failed`. Restore the env.
3. Query the table:
   ```sql
   select created_at, severity, event, message, route, safe_details
     from public.ops_alerts
    order by created_at desc
    limit 10;
   ```
   Expected:
   - No raw tokens / `client_secret` / Stripe secrets / card numbers anywhere in `safe_details`.
   - Each row has an `event` matching one of the documented names.
   - Severity is `info`, `warning`, or `critical` (CHECK enforced).
4. Confirm normal flows do NOT spam alerts:
   - Open `/cancel/fake` (invalid token) → no alert.
   - Submit `/portal/login` with a non-matching email → no alert.
   - Trigger a 429 via the rate limiter → no alert.
5. Run the full test suite. The 23 new ops-alerts tests + the source-grep wiring tests guard the contract:
   ```bash
   npm test
   ```

## Fractional thermolysis duration (PR #165, migration 0071)

After deploy, the operator should confirm Chloe can enter a fractional value, the row stores it correctly, and the read view displays it.

1. Open a test electrolysis session as the practitioner.
2. Add or edit a thermolysis (or blend) block.
3. Under "Treatment readings" enter:
   - Thermolysis duration (s): `0.15`
   - Thermolysis intensity %: `61`
   - Pulse count: `1`
   - Hairs treated: `37`
4. Save. SQL verify the value persisted as a decimal:
   ```sql
   select id, thermolysis_duration_seconds
   from public.electrolysis_entries
   where session_id = '<session uuid>'
   order by created_at desc
   limit 5;
   -- expect: top row carries 0.15 (not 0).
   ```
5. Refresh the session view. The entry row should read `... 61%, 0.15 seconds, 1 pulse ...` (not `... 0s ...`).
6. Edit the same block again and confirm the input field still shows `0.15`.
7. Enter `0.2` instead and save. Refresh. Confirm the row reads `0.2 seconds` (not `0.20`, not `0`).
8. Enter `1` and save. Refresh. Confirm the row reads `1 second` (singular).
9. Enter `2` and save. Refresh. Confirm `2 seconds`.

## Practitioner notification center (PR #164, migration 0070)

After deploy, the operator should confirm the notification table is reachable, the three event sources fire the helper, and the practitioner-facing page renders the rows. Migration 0070 is applied to production before merge.

1. As Chloe, log into `https://hone.care` and confirm a new **Notifications** link appears in the header nav, between Calendar and Settings. Initial badge: zero (unless someone bookmarked the URL and visited; the unread count is from the live DB).
2. As a test public visitor in an incognito browser, book a new appointment at `/book/willow-electrolysis`. Complete the booking.
3. Refresh Chloe's `/notifications` page. Expect:
   - A new row at the top titled **New booking**.
   - Body: `<Client name> booked <Service> for <Day Mon DD> at <H:MM AM/PM>.`
   - href clicks through to `/calendar/<appointment_id>`.
   - Header badge shows 1 (or however many unread rows exist).
4. From the public token email, click the cancellation link and cancel the appointment with a reason (e.g. "Schedule changed"). Refresh `/notifications`. Expect a new row titled **Appointment cancelled** with body `<Client name> cancelled their appointment. Reason: Schedule changed.`
5. From a fresh public booking, follow the reschedule token to move the appointment to a different time. Refresh `/notifications`. Expect a new row titled **Appointment rescheduled** with body `<Client name> rescheduled from <Day Mon DD at H:MM AM/PM> to <Day Mon DD at H:MM AM/PM>.`
6. Click **Mark all read**. Expect the badge to drop to 0 and the unread tint to disappear from every row.
7. SQL backstop:
   ```sql
   select event_type, title, body, href, read_at, created_at
   from public.practitioner_notifications
   where studio_id = '<studio uuid>'
   order by created_at desc
   limit 10;
   ```
   Expected: three rows from the smoke flow (new_booking, appointment_cancelled, appointment_rescheduled). All `read_at` populated after step 6.
8. Cross-studio safety: sign into a different studio's practitioner account (or use the admin SQL to flip studio scope) and confirm none of the rows above appear. The RLS `is_studio_member(studio_id)` clause is the gate.
9. Never-throws safety: temporarily break the notification write path (e.g. revoke the service role's insert grant in a staging env) and book an appointment. The booking MUST succeed and the client confirmation email MUST go out, even though no notification row is created. The failure logs to `ops_alerts` with `event = 'practitioner_notification_insert_failed'`. This is the hard acceptance gate.

## Booking attribution / "How did you hear about us?" (PR #163, migration 0069)

After deploy, the operator should confirm the new dropdown captures + surfaces correctly end to end.

1. Open `/book/<studio-slug>` as a fresh client (incognito window).
2. Walk through the booking form. Confirm the new "How did you hear about us?" dropdown appears after "Anything else?" with the helper text "Optional. Helps the studio understand where new clients come from."
3. Confirm the options match the seven canonical labels: Google, Instagram, Friend or referral, Existing client, Studio website, Other, Prefer not to say. The default option is "Select an option (optional)".
4. Pick `Instagram` and submit. Confirm the booking succeeds.
5. SQL verify the new column:
   ```sql
   select column_name, data_type, is_nullable
   from information_schema.columns
   where table_schema = 'public'
     and table_name = 'appointments'
     and column_name = 'referral_source';
   -- expect: referral_source | text | YES
   ```
6. SQL verify the value landed on the new row:
   ```sql
   select id, starts_at, referral_source
   from public.appointments
   where studio_id = '<studio uuid>'
     and client_id = '<client uuid>'
   order by created_at desc
   limit 5;
   -- expect: the new row has referral_source = 'instagram'
   ```
7. As the studio practitioner, open the calendar appointment detail page for the new booking. Confirm a "How they heard about us" section renders below the appointment notes with the value `Instagram`.
8. Open the practitioner notification email Chloe received. Confirm the body contains `How they heard about us: Instagram` after the time/notes lines.
9. Open the client's confirmation email. Confirm it does NOT mention "How they heard about us" anywhere.
10. Open the client portal. Confirm `referral_source` is not surfaced anywhere on the portal page.
11. Book a second appointment without picking a referral option (leave the dropdown on "Select an option"). Confirm the row inserts with `referral_source = NULL` and the practitioner appointment detail page omits the "How they heard about us" section entirely.

## Charting terminology + thermolysis field order (PR #162)

Operator smoke after deploy:

1. As a practitioner, open any session detail page (`/clients/<id>/sessions/<sessionId>`) for a client with an existing electrolysis session.
2. Click into the treatment-area editor for an existing or new block.
3. **Side dropdown**: confirm the picker shows `Center / Left / Right / Both sides / n/a`. The prior `Bilateral` label must NOT appear.
4. Pick `Both sides` and save. Refresh. Confirm the block re-renders with the same selection.
5. In the read-only session blocks view (the area-title strip above each block), confirm a saved record with `side='bilateral'` prints as `... · Both sides · ...` (NOT lowercase `bilateral`).
6. **Thermolysis field order**: in the same editor, pick the Thermolysis or Blend mode. Confirm the rendered input order under "Treatment readings" is:
   1. Thermolysis duration (s)
   2. Thermolysis intensity %
   3. Pulse count
7. Save a value in each field and confirm the saved record on the read view shows the same values. Persisted column names are unchanged (`thermolysis_duration_seconds`, `thermolysis_intensity_percent`, `pulse_count`).
8. Backstop SQL (optional):
   ```sql
   select id, primary_area, side
   from public.session_blocks
   where studio_id = '<studio uuid>'
     and side = 'bilateral'
   limit 5;
   ```
   Expected: stored value is still the lowercase `bilateral`; only the rendered label changed.

## Charting feedback — numbing, body-map, probe-lot confirm, OmniBlend, tolerance, observation chips (PR #279, migration 0095)

Chloe real-charting feedback, charting-only. **Requires migration 0095 applied** to the environment (the form writes `numbing_status` + `probe_lot_confirmed`). Sign in, open a client, start/chart an electrolysis session, add a treatment area.

1. **Numbing (item 1):** the "Numbing" control shows three choices — **Not recorded** (default) / **No numbing used** / **Numbing used**. Pick "Numbing used", save, reopen: the saved block shows "Numbing used". A legacy block (charted before 0095) shows no numbing line (Not recorded). No advice/dosing wording anywhere.
2. **Body-map underarms (item 2):** open the body map, open **Arms**, pick **Underarms**. Confirm the broad Arms shape does **not** light up as if the whole arm is the treatment area (only a subtle "contains the selected area" tint); the **Underarms** chip is clearly selected and "Area being charted: Underarms" shows. Picking a Face area highlights Face, not Arms.
3. **Probe lot suggestion + confirm (item 3):** if the studio has a probe sterile-item record, the form shows **"Suggested from records: <lot>"** with **Use this lot** when the field is empty. Tapping "Use this lot" fills the field but it reads **not confirmed**. Tap **Confirm lot for this treatment** → it reads **Confirmed for this treatment ✓**. Typing a different lot **un-confirms** it. Save; the saved record shows "Lot #… (confirmed)" only when confirmed. With no probe record, manual entry still works (no suggestion shown).
4. **Energy under Treatment readings (item 4):** the **Energy level (EL)** input renders **under the "Treatment readings" heading** (not near Modality). There is exactly one energy field. Save/reopen: value round-trips.
5. **OmniBlend (item 5):** pick mode **Blend** + modality **OmniBlend**. Confirm under Treatment readings the **Galvanic** section renders **before Thermolysis** and there is **no Thermolysis duration** field. Switch to another blend modality (e.g. PicoBlend) and confirm thermolysis-first + the modality-specific fields return. **UPDATED for Phase A (PR #479):** *Galvanic intensity* is no longer a modality-specific absence — it is **retired for EVERY modality** and must not appear anywhere. **Galvanic mA** and **Galvanic duration** are still present and still expected.
6. **Tolerance labels (item 6):** the Client tolerance control shows **labels** (Comfortable / Mild discomfort / Moderate discomfort / High discomfort / Needed pause / stopped early), not a raw 1-5 grid. Pick one, save, reopen: the saved record shows "Tolerance: <label>". A legacy numeric value renders as its label.
7. **Treatment observations & skin response (item 7, mobile) — UPDATED for Phase A (PR #479):** the previously separate *Treatment observations* and *Client / skin response* boxes are now **ONE multi-select box headed "Treatment observations & skin response"**. On a phone, tap a chip (e.g. **Slight edema**) — it shows pressed; tap it again — it is removed (unselect works). Tap **No visible reaction** — it registers, and the UI prevents contradictory combinations (it is mutually exclusive with real reactions), but **other chips are multi-select and do NOT replace one another**. Manually typed notes are preserved through chip toggles. No duplicate tokens. Confirm a client with a prior reaction still surfaces on the dashboard *Clients needing attention* card — historical `reaction_type` values are folded into the unified set, so legacy records must still appear.
   - **Also confirm the rest of Phase A:** there is **no "Galvanic intensity" field anywhere** (it is retired — but **Galvanic mA** and **Galvanic duration** are still present and still work); a thermolysis duration of `0.733` renders as **`0.733 seconds`**, not `0.73`; the pulse control is labeled **"Thermolysis pulse count"** and sits inside the thermolysis section; the **Additional notes** field is the larger, resizable one.
8. Backstop SQL (optional, after 0095):
   ```sql
   select id, numbing_status, probe_lot_number, probe_lot_confirmed, tolerance_rating
   from public.session_blocks
   where studio_id = '<studio uuid>'
   order by created_at desc limit 5;
   ```
   Expected: `numbing_status` is NULL or `none`/`used`; `probe_lot_confirmed` true only when you confirmed; `tolerance_rating` is still the 1-5 smallint.

## Pre-appointment instructions (PR #160)

After deploy, the operator should confirm the editable per-service prep text feeds both the email and the portal end to end.

1. Sign in as the studio owner. Open `Settings → Services`. Pick any active service.
2. Confirm the textarea labelled "Pre-appointment instructions" exists. Set it to a recognisable string, for example: `"Smoke test: shave the area 24h before your visit. Avoid caffeine the morning of."`
3. Save. Confirm the success state. Refresh the page and confirm the value persisted.
4. As a test client, book that service. Open the booking confirmation email. Expect a `Before your appointment` block carrying the smoke-test string and NO "Please arrive 5 minutes early. Wear comfortable clothing. Avoid caffeine before your appointment." paragraph anywhere in the body or subject.
5. Trigger or wait for the 24h reminder. Expect the same `Before your appointment` block with the smoke-test string. Same for the 2h reminder.
6. Open the portal as the same client. Switch to the Care instructions section (PR #159; open by default). Expect the same smoke-test string under "Before your appointment".
7. Go back to `Settings → Services`. Clear the textarea (empty value). Save.
8. Book another appointment for the same service. The confirmation email should now omit the `Before your appointment` block entirely (no empty card, no leftover heading). The portal Care instructions section should also omit the pre-care entry for that service.

SQL backstop:

```sql
select id, name, modality, pre_care_instructions
from public.services
where studio_id = '<studio uuid>'
order by sort_order, name;
```

Expected: the value the studio owner typed in step 2 appears verbatim on the row for the smoke service.

## Portal layout cleanup (PR #159)

After deploy, the operator should confirm the portal's new structure renders end to end.

1. Open the portal as a test client. The top of the page should show: studio eyebrow, "Hello, <first name>.", a short intro line, and a top-right cluster containing an `Email <studio>` button (only when the studio has a postcare contact email on file) + Sign out.
2. If the client has any unsigned forms, unreviewed messages, intake, or unsigned card authorization, the "Needs you" section appears next, unchanged from PR #158.
3. The next four top-level sections appear in order:
   - **Appointments**: next appointment card + "View N more upcoming" disclosure.
   - **Care instructions**: open by default. Summary line reads `"Review these before and after your appointment."` Pre-care + postcare entries render below.
   - **Forms and records**: past messages (if any) + Completed forms (if any). Form rows are quiet (no border cards). Caption verb for non-photo rows reads `"Completed "`. Footnote: `"A viewable copy of signed forms is coming soon."`
   - **Payment method**: the four-state PR #158 surface (no template / authorization needed / signed but no card / active card).
4. Click the `Email <studio>` button in the header. A `mailto:` should open with the subject `Question about my <studio> appointment` pre-filled.
5. Confirm the legacy "Your info" wrapper heading is gone and the bottom "Need help?" section is gone.
6. Smoke the PR #158 guidance once more: for a client with unsigned card authorization, the "Card authorization needed before adding a card" placeholder still renders inside Needs you, and clicking "Review card authorization" still scrolls to the unsigned-forms block via `#forms-to-sign`.

## Card authorization guidance (PR #158)

After deploy, the operator should confirm the client portal and the matching practitioner card render the new explanatory copy.

### Portal (client view)

1. Log into a test client portal at `https://hone.care/portal` (use the magic-link flow) for a client whose studio has an active `card_authorization` template AND the client has NOT yet signed it AND has no card on file.
2. Expect "Needs you" to surface:
   - The `card_authorization` template inside the "Review and sign forms" block.
   - A second calm placeholder titled `"Card authorization needed before adding a card"` with the supporting copy (`"Before you can add a card on file, please review and sign the card authorization form above."` and `"Once that form is signed, the secure card form will appear here. No charge will be made when you add a card."`).
   - A dark `Review card authorization` button. Clicking it scrolls to the "Review and sign forms" block above.
3. Sign the form. The page revalidates; the placeholder disappears and the Add card form appears with supporting copy `"You have signed card authorization. You can now add a card on file."` and `"No charge will be made when you add a card."`.
4. Add a test card. The Add card surface goes away; the "Your info" zone now shows the card summary with a Replace card button.
5. As a separate check, open the portal for a studio with NO active `card_authorization` template at all. "Your info" shows the State A copy: `"Card setup is not available yet. This studio has not enabled online card setup. Please contact the studio if you have a question about payment."`

### Practitioner (client profile view)

1. Open `/clients/<id>` for the same test client. The "Payment method" card should mirror the portal state:
   - Before signing: yellow/amber block, heading `"Card authorization not signed"`, body explaining the Ask the client to open their portal step.
   - After signing, before adding the card: neutral block, heading `"Card authorization signed, but no card is on file yet."`
   - After the card is added: brand/last4/expiry summary with the authorization-signed timestamp.
   - If the studio has no template at all: amber block, heading `"Card authorization template not configured"`.
2. On a cancelled appointment for the same client (calendar detail), open the manual fee card. The blocked reasons should reflect the new wording: `"Card authorization not signed. The client must sign card authorization in the portal before a card can be added or a manual fee can be prepared."`

## Client profile appointment timeline (PR #157)

After deploy, the operator should confirm the new Sessions-tab timeline behaves correctly:

1. Open `/clients/<id>` for a client with at least one appointment in any status.
2. Switch to the **Sessions** tab.
3. Expect an **Appointments** section at the top with one or more of these groups visible (only non-empty groups render):
   - **Upcoming**: future confirmed appointments. Action: Open appointment.
   - **Needs charting**: past confirmed/completed appointments with no linked session yet. Action: Chart session (plus Open appointment).
   - **Charted**: appointments with a linked session via `appointment_id`. Action: View session (plus Open appointment).
   - **Cancelled**: status cancelled. Shows `cancelled_at` and `cancellation_reason` when present. Action: Open appointment (plus View session in the rare-case linked).
   - **No-show**: status `no_show`. Action: Open appointment (plus View session if linked).
4. Each row shows date/time with AM/PM in the user's browser timezone.
5. Click a **Needs charting** row's "Chart session" button. The destination page should show "Linking this session to the selected appointment." and the URL should carry `?appointment_id=<uuid>`.
6. After picking a modality, the new session row in DB should have `appointment_id` populated:
   ```sql
   select id, appointment_id from public.sessions
   where id = '<new session id>';
   ```
7. Return to the client profile Sessions tab. The same appointment now appears under **Charted**, not **Needs charting**. Click View session to confirm the link points at the new session.
8. The top-level **+ Log session** button still works for the client-scoped case and creates `appointment_id = NULL`.

## Migration 0068 verification (PR #156)

After `supabase db push --linked` lands `0068_sessions_appointment_link.sql`, run the following to confirm the column, FK, and indexes are in place. Do NOT run an UPDATE backfill from this recipe; ambiguous matches must stay null.

```sql
-- 1. Column shape
select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public'
  and table_name = 'sessions'
  and column_name = 'appointment_id';
-- expect: appointment_id | uuid | YES

-- 2. FK definition
select conname, pg_get_constraintdef(oid)
from pg_constraint
where conrelid = 'public.sessions'::regclass
  and conname ilike '%appointment%';
-- expect: a single row with "FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE SET NULL"

-- 3. Indexes
select indexname, indexdef
from pg_indexes
where schemaname = 'public'
  and tablename = 'sessions'
  and indexdef ilike '%appointment_id%';
-- expect: sessions_appointment_id_idx + sessions_studio_appointment_idx, both partial on (appointment_id is not null)

-- 4. Row counts (read-only)
select
  count(*) filter (where appointment_id is not null) as linked_sessions,
  count(*) filter (where appointment_id is null)     as unlinked_sessions
from public.sessions;
-- expect immediately after deploy:
--   linked_sessions = 0
--   unlinked_sessions = current total session row count
-- The linked count climbs only as new appointment-context "+ Chart session" runs.
```

## Quick Import smoke (PR #257)

Quick Import V1 lives at the owner-only `/settings/import` (Settings → Import; the tab shows only for owners). It brings clients + basic historical treatment memory over from CSV/TSV **paste or file**, **preview-first**, into the PR #252 `imported_treatment_memories` schema. It is NOT OCR, AI, API sync, merge, overwrite, or live charting. **Access (non-destructive):** anonymous `curl -sI https://hone.care/settings/import` → `307 -> /login`; a no-studio user → `/no-access`; a non-owner practitioner sees "Only studio owners can import." **Owner flow:** Copy template → paste rows (Google Sheets/Excel TSV or CSV; include the header) → pick a Source → **Preview import** (no writes: shows source rows, grouped clients, ready/review/duplicate counts, treatment areas detected, ignored columns, per-group status chips) → **Confirm import** → summary (clients created, memories created, duplicates skipped, links to created clients). Verify: two rows for the same client (e.g. Upper lip + Chin, same email) group into **one** client with two memory rows; a row whose email/phone/name+DOB matches an existing client is **skipped** (not overwritten/merged); a same-name-only match is created with a "Review" warning, not merged; an imported client appears in Clients and its history is labelled "Imported history, not charted live in Hone." (never as charted-live, no session/appointment created). The raw pasted text is never stored or logged; no email/SMS/payment is sent. **Real imports create real `clients` rows (no hard delete; correction is owner batch soft-void), so use it for genuine setup, not throwaway tests.** Pinned by `tests/lib/import/quick-import.test.ts`, `tests/app/settings/import/quick-import-action.test.ts`, `tests/db/quick-import.db.test.ts`, and `e2e/quick-import.spec.ts`.

## Cron and reminder reliability smoke (PR #258)

**Config check (repo):** `vercel.json` `"crons"` schedules `/api/cron/materialize-recurring-breaks` at `0 8 * * *` (daily). `/api/cron/appointment-reminders` is intentionally **not** in `vercel.json` — `*/15` exceeds the current Vercel plan's once-per-day cron cap, so it runs from an **external scheduler (cron-job.org) every 15 minutes** (`GET` with `Authorization: Bearer $CRON_SECRET`). `/api/cron/no-show-check` is absent (disabled stub). **Auth check (prod):** an unauthenticated `curl -sI https://hone.care/api/cron/appointment-reminders` returns `401` (the route requires `Authorization: Bearer $CRON_SECRET`; the env var must be set in the Vercel project AND the external scheduler must send the same bearer). **Reminder coverage:** the 2h reminder window is `now+105m … now+135m` (30 min); at the every-15-min cadence every appointment minute offset is covered and a single skipped fire still leaves a grid point in-window — proven deterministically by `tests/lib/cron/reminder-schedule.test.ts` (and that suite fails for the old hourly + 30-min combination). So the external scheduler MUST be set to ≤15-minute cadence. **Post-deploy (operator):** confirm the external scheduler is hitting `/api/cron/appointment-reminders` every 15 min (its run history shows `200` + `{ ok: true, reminder_24h, reminder_2h, ... }`) and the Vercel dashboard → Cron tab lists the daily materialize-recurring-breaks job with recent successful runs. If a reminder exhausts 3 attempts a `reminder_send_exhausted` ops alert (warning) is recorded with non-sensitive metadata only (no client email/phone/notes/token). Reminders are only sent for appointments still `status='confirmed'` at send time. Live payments remain disabled.

## Reminder cron status signal smoke (PR #265)

Confirms the external reminder scheduler is operator-visible. **Read-only; no app run, no real cron fire, no production writes.** Primary coverage: `tests/lib/cron/reminder-heartbeat.test.ts` (pure healthy/stale/missing classifier) + `tests/app/cron/reminder-heartbeat-wiring.test.ts` (heartbeat written only after the auth gate, non-sensitive payload, fail-open, admin surfacing) — run `npm test`. **Operator check (`/admin`, read-only):** open the admin console → the **"Reminder scheduler"** card shows **Healthy** with a recent "last successful run" when the external scheduler (cron-job.org) is firing every 15 min; it flips to **Stale** if the last success is over ~45 min old, and **Missing** if none is recorded. The heartbeat carries only a timestamp + aggregate counts — no client email/phone/name, notes, token, URL, or `CRON_SECRET`. If stale/missing: verify the external scheduler is enabled and the `Authorization: Bearer $CRON_SECRET` header matches, then check `/admin/ops-alerts` for `cron_route_failed` / `reminder_send_exhausted`. No reminder-send behavior changed; Stripe gates unchanged; live payments remain disabled.

## Before Today imported memory smoke (PR #259)

Imported (paper/Jane/spreadsheet) treatment memory from Quick Import now appears in the **Before Today** briefing on the client Overview (`/clients/<id>`), read-only and clearly labelled. **Manual (owner):** import a client with at least one treatment-memory row via Quick Import (Settings → Import; e.g. a row with `treatment_area`, `last_visit_date`, `probe_lot`, `tolerance`, `reaction`), then open that client. Confirm the Before Today card shows a distinct **"Imported treatment memory"** section (amber, separate from the blue Hone-charted "Remember today" / "Last treatment" sections) carrying the provenance line **"…not charted live in Hone."**, the source label (e.g. "Imported from paper card"), the date, the treatment area, and chips for modality/probe/lot/tolerance/reaction when present; if the client has more than 5 imported records it shows "Showing the latest 5 of N imported records." The section appears **even when the client has no live charted history** (the card still says "No charted treatment history yet" for the live part). Verify: voided imported rows do NOT appear; no edit/void/merge/convert controls exist; the page does not scroll sideways on a phone; other studios' imported memory never appears (studio+client-scoped RLS). The data behaviour (void-exclusion, newest-first order, cap, provenance labels) is proven by `tests/lib/imported-treatment-memory.test.ts`; the wiring + section by `tests/app/clients/before-today.test.ts`; the full chain by `e2e/before-today-imported.spec.ts`. Live payments remain disabled.

## Rate-limit production env gate smoke (PR #262)

**Config check (repo):** `package.json` `build` runs `node scripts/check-production-env-gates.mjs && next build`. The gate fails the build when `UPSTASH_REDIS_REST_URL` or `UPSTASH_REDIS_REST_TOKEN` is missing **and** `VERCEL_ENV === "production"`; it is a no-op SKIP for local/CI/preview builds (deliberately NOT keyed on `NODE_ENV`, which `next build` sets to `production` everywhere). Run it directly (non-destructive, no writes): `VERCEL_ENV=production node scripts/check-production-env-gates.mjs` with both vars unset → exits `1` and names the missing var(s); with both set → `PASS` exit `0`; without `VERCEL_ENV=production` → `SKIP` exit `0`. It prints variable **names only, never values**. **Deploy check (prod, operator):** the Vercel Production environment MUST have both Upstash vars set or the production build fails loudly (no silent fail-open). A transient Upstash **outage** does NOT trip the gate (the vars stay set) and is handled at runtime by the deliberate, logged fail-open (`ratelimit_backend_unavailable`). There is no emergency bypass. **Runtime (unchanged):** public limiter behavior is unchanged; missing config in production still logs `ratelimit_disabled_env_missing` once per cold start. Pinned by `tests/scripts/check-production-env-gates.test.ts`. Live payments remain disabled.

## Payment outcome zero-row detection smoke (PR #263)

Confirms payment-outcome writes never treat a zero-row update as success. **Test-mode only; do NOT run real charges or mutate production payment rows.** Primary coverage is `tests/lib/billing/payment-outcome-zero-row.test.ts` (source-grep) + the existing `tests/scripts/check-stripe-gates.test.ts` — run `npm test`. **What changed:** the charge executor (`writeSucceededOutcome`/`writeFailedOutcome`), the refund helper (success + terminal-failure writes), and the four webhook reconcilers (`payment-webhook-reconciliation.ts`) each append `.select("id")` to their status-conditional outcome UPDATE and, on zero rows, record a structured `*_zero_rows` / `*_write_failed` ops_alert (and the webhook handlers return `zeroRowNoMutation` instead of claiming a reconcile) rather than silently continuing. **Operator check (`ops_alerts`, read-only, no writes):** if a payment outcome ever fails to persist, a non-PII alert appears in `ops_alerts` (safe ids + status enums only — no raw Stripe payload, card data, secret, or customer email/phone) for manual reconciliation. No payment runtime behavior changed beyond stricter zero-row detection; exactly one `paymentIntents.create` remains; live payments remain disabled.

## Raw cancellation_token column removal smoke (PR #264, migration 0091)

Confirms the legacy raw appointment token is gone at rest and links still work. **Migration 0091 is applied in production — the raw `cancellation_token` column is already dropped (local == remote, none pending); verify read-only below.** Source coverage is `tests/migrations/0091-drop-raw-cancellation-token.test.ts` (migration shape), `tests/db/appointment-token-hash.db.test.ts` (DB lane: hash-only storage, the raw column is gone → INSERT errors `42703`, RPCs reject a raw token, hash lookup still cancels/reschedules), and `tests/app/book/no-raw-appointment-token.test.ts` (no app reads/writes the raw column) — run `npm test` + `npm run test:db` (local Supabase / CI only).

**Schema check (prod, after the migration, read-only):**
```sql
select column_name from information_schema.columns
 where table_schema='public' and table_name='appointments'
   and column_name in ('cancellation_token','cancellation_token_hash');
```
Expected: only `cancellation_token_hash` is returned; `cancellation_token` no longer exists.

**Behavior check (no production writes):** a previously-emailed `/cancel/<raw>`, `/reschedule/<raw>`, and `/manage/<raw>` link still resolves (the route hashes the URL token and matches the backfilled `cancellation_token_hash`); a fresh booking's confirmation links resolve; `/cancel/not-a-real-token` still shows the generic neutral error. No raw token is stored, and none is logged. Stripe gates unchanged; live payments remain disabled.

## Intake link resend / refresh smoke (PR #293, no migration)

Confirms the client Health & Forms tab exposes a prominent **"Resend intake link"** CTA for an in-progress intake — a **UX/discoverability fix over existing safe backend behaviour** (no token-model / TTL / route / submit change, no migration, no real email in tests). Primary coverage: `tests/app/clients/intake-resend.test.ts` (source-grep: the CTA calls the existing `resendIntakeEmailAction` on the same `intake.id` so the link is refreshed and saved answers are kept; it does **not** call `requestIntakeUpdateAction`; copy says answers are kept + "Links expire after 14 days"; generic success "Intake link sent." / error "Could not send the intake link. Please try again."; no-email state disables resend and points to the `getIntakeLinkAction` Copy-link fallback; the soft "previous link may have expired" hint uses the shared `INTAKE_LINK_TTL_DAYS`; the new-form card is relabeled "Send a new intake form"; no `console.`/ops-alert added) — run `npm test`. **Operator check (read-only — do NOT send a real production email):** on the client's **Health & Forms** tab (the inline `activeTab === "health"` "Health intake" card on `/clients/<id>`) for a client with an in-progress intake whose link expired, the card shows the primary **"Resend intake link"** CTA (with the may-have-expired hint when the intake is older than 14 days) and a "View intake →" link to the dedicated page; the dedicated `/clients/<id>/intake` page shows the same CTA above a clearly-secondary **"Send a new intake form"** card. Resending re-emails a fresh link for the *same* form, keeping any answers already entered; a client with no email on file sees the button disabled with "No email on file — use Copy link to share it manually." and a working Copy link. **#293 follow-up:** the `tests/app/clients/intake-resend.test.ts` source-grep also pins that the overview card (`/clients/[id]/page.tsx`) renders `IntakeResendCard` in the in_progress branch, so the CTA is on the surface practitioners actually use. Live payments remain disabled.

## Smart intake resend status / expiry visibility smoke (PR #303, migration 0097)

Adds accurate resend status to the in-progress intake card so a practitioner can see when the current link was sent/resent, when it expires, how many days are left, and whether to send a fresh link. **Migration 0097** adds three nullable/default-safe display-mirror columns to `client_intake_forms` (`intake_link_last_sent_at`, `intake_link_expires_at`, `intake_link_send_count`); the signed token stays the authoritative expiry (no token/raw-token storage, no RLS/status-enum change). A shared helper `stampIntakeLinkIssued` (`lib/intake/queries.ts`) stamps these at **every** mint path — booking/reschedule (`ensureIntakeForClient`, emailed), `resendIntakeEmailAction` (emailed), `getIntakeLinkAction` (Copy link — refreshes expiry + count but **not** last_sent_at, since it wasn't emailed), and `requestIntakeUpdateAction` (emailed only when it actually emailed). `computeIntakeLinkStatus` (`lib/intake/link-status.ts`) derives the status; the card shows **normal** ("Intake link emailed {date}", "Current link expires {date} · {N} days left", "Client has not submitted yet."), **close-to-expiry (≤3 days)** ("This intake link expires soon. Send a fresh link so the client can continue.", CTA **Send fresh link**), **expired** ("This intake link has likely expired. Send a fresh link.", CTA **Send fresh link**), and a **legacy fallback** (rows with null metadata use the started_at heuristic + the hedged "previous link may have expired"). Button label: **Send fresh link** (expired/close), **Resend again** (send_count ≥ 2), else **Resend intake link**. Saved answers preserved; studio-ownership gate + generic errors unchanged; no token/PII in logs; **no delivery/receipt/opened/completed claims**. **Manual smoke (read-only — do NOT send a real production email):** on `/clients/<id>` Health & Forms and `/clients/<id>/intake` for an in-progress intake, confirm the status lines + days-left; a link nearing 14 days shows "expires soon" + Send fresh link; a legacy row (no stored metadata) still shows the hedged fallback. Pinned by `tests/app/clients/intake-resend-status.test.ts`; the existing `tests/app/clients/intake-resend.test.ts` still passes. Deferred (out of scope): `sent_by`, content snapshot, delivery receipt, precare-sent tracking, inspector export/audit table, automatic/cron resend. Live payments remain disabled.

## Intake-form reminder emails smoke (PR #306, migration 0098)

Automated 7-day + 3-day "please complete your intake form" reminders on the existing appointment-reminders cron, only for confirmed upcoming appointments whose **latest intake is still `in_progress`**. **Migration 0098** adds per-appointment idempotency columns (`intake_reminder_7d_sent_at`/`_send_attempts`/`_claimed_at` + the `3d` set; additive/backfill-safe, no RLS/enum change) and extends `claim_email_send`/`record_email_result` with `intake_reminder_7d`/`intake_reminder_3d` branches (existing branches byte-for-byte). Each `sendIntakeReminderPass` reuses the 24h/2h claim-before-send machinery: skip if intake submitted/reviewed/missing or no client email; skip if already sent or attempts ≥ 3; claim → re-check confirmed → **always mint a fresh 14-day link** (`generateIntakeLinkUrl`) → send `buildIntakeReminderEmail` copy → `record_email_result` → stamp PR #303 metadata (`stampIntakeLinkIssued({emailed:true})`) on success. Windows are 2h wide, centered on the target day (≥ 15-min cadence). Logs only ids/kinds — no token/PII. **Manual smoke (read-only — do NOT trigger real sends):** for a confirmed appointment ~7 or ~3 days out with an `in_progress` intake and a client email, the cron sends one reminder per kind (dedup on the `_sent_at` column); a submitted/reviewed intake or no-email client is skipped; the email subject/body match the copy above and carry a working fresh link. Pinned by `tests/migrations/0098-intake-reminder-columns.test.ts`, `tests/lib/email/intake-reminder-template.test.ts`, `tests/app/api/cron/intake-reminder.test.ts`. Out of scope: SMS, unlimited/marketing emails, preference center, per-studio toggle. Live payments remain disabled.

## Intake review flags smoke (PR #266)

Confirms practitioner-only intake review flags surface existing intake answers for review — **read-only; no production writes, no new fields, no migration.** Primary coverage: `tests/lib/intake/review-flags.test.ts` (pure deriver: mapping/levels/ordering, empty-and-legacy → no flags, wording safety) + `tests/app/clients/intake-review-flags.test.ts` (deriver is pure/no-I/O, allowed wording present, forbidden wording absent, card mounted on the practitioner page and NOT on the public `/intake/[token]` route) — run `npm test`. **Operator check (`/clients/<id>/intake`, read-only):** for a client whose latest recorded intake reports a flagged answer (e.g. a medical condition, a listed medication, scars-easily, an active cold sore, recent sun), the **"Intake review needed"** card appears above the answer grid, each item showing a level pill — **Medical authorization may be required** / **Review before treatment** / **Precaution noted** — its category, and a "Based on intake response: …" basis line, closing with "Use professional judgment and clinic policy." A clean intake (or an older intake predating these questions) shows **no** flags card. Verify the wording uses ONLY the allowed phrases (and none of the forbidden clinical-decision terms), and that flags never appear on the client-facing `/intake/<token>` page. Live payments remain disabled.

## Intake modality-specific review flags smoke (PR #267)

Confirms chart-mapped flags carry **modality/category badges** from Chloe's clinic reference chart — **read-only; no production writes, no migration, no image/OCR/AI.** Primary coverage: `tests/lib/intake/review-flags-modality.test.ts` (chart mapping per condition, unmapped rows not invented, free-text never parsed, badge wording safety) + the extended `tests/app/clients/intake-review-flags.test.ts` (badges render practitioner-only via `MODALITY_WORDING`, never on the public route) — run `npm test`. **Operator check (`/clients/<id>/intake`, read-only):** for a client whose latest recorded intake reports e.g. a heart condition / pacemaker, the flag shows badges **"Review before continuous/galvanic current"** + **"Medical authorization may be required"**; blood-borne (hepatitis/HIV) shows **"Review before thermolysis"** + **"Review before continuous/galvanic current"**; a generic diabetes answer shows the conservative union of its chart rows. Conditions with no chart row keep the generic review/precaution badge; nothing is invented for chart rows with no structured intake field. Badges use ONLY the allowed phrases, the avoided clinical-decision wording never renders, and badges never appear on the client-facing `/intake/<token>` page. This is practitioner workflow support, not a medical decision. Live payments remain disabled.

## Chart parts / treatment area visibility smoke (PR #268)

Confirms the charted **treatment area** is visible across charting, saved entries, and treatment memory — **charting context only; read-only; no production writes, no migration, no image/upload/sketch/OCR/AI.** Primary coverage: `tests/app/clients/chart-parts-area.test.ts` (memory card labels the area + "Area not recorded" fallback + "Latest recorded setup — <area>" + "Imported area"; saved entries show a "Recorded area" / "Area not recorded" eyebrow; no Jane CDN/thumbnail asset URL anywhere) + the extended `tests/app/clients/before-today.test.ts` (latest setup tied to its area) — run `npm test`. **Operator check (read-only):** chart a session area (e.g. "Chin (Left)") on `/clients/<id>/sessions/<id>` and confirm the saved block shows a **"Recorded area"** eyebrow with the area; open the client Overview and confirm Before Today shows **"Treatment area: …"** and **"Latest recorded setup — Chin"**; a legacy block / last session with no structured area shows **"Area not recorded"**; imported history shows **"Imported area: …"** inside its separate amber section. Reuses existing `session_blocks` area fields (migration 0039) — no schema change. Jane was product-category inspiration only; no Jane assets/UI/thumbnails are present. Live payments remain disabled.

## Visual treatment-area picker smoke (PR #269)

Confirms area selection reads as a **visual chart part** in charting — **read-only; no production writes, no migration, no image/upload/sketch/canvas/OCR/AI.** Primary coverage: `tests/app/sessions/visual-area-picker.test.ts` (the `AreaPicker` maps the `AREA_REGIONS` catalog into region-grouped chips with selected state; the charting form frames it as a "Chart part" / "Treatment area" card with "Choose the area for this chart entry" + a live "Area being charted: …" preview + "Area not recorded" fallback; reuses `primary_area`/`side`/`custom_area_detail`; no upload/canvas/OCR/Jane asset) — run `npm test`. **Operator check (read-only):** open a session block setup on `/clients/<id>/sessions/<id>` and confirm the **"Treatment area"** chart-part card shows region-grouped area chips (Face & neck / Torso / Limbs / Intimate + "Other"); picking a chip highlights it and updates **"Area being charted: Upper lip"** (adds side, e.g. "Left underarm", and specifics); clearing shows **"Area not recorded"**; saved entries still show the PR #268 "Recorded area"; Before Today still shows the PR #268 treatment-area context. Simple visual grouped picker only — no anatomical body-map/image/upload/drawing (deferred). Live payments remain disabled.

## Body-map treatment-area picker smoke (PR #270)

Confirms the built-in **body-map** picker — **read-only; no production writes, no migration, no image/upload/canvas/drawing/OCR/AI.** Primary coverage: `tests/app/sessions/body-map-area-picker.test.ts` (`BODY_ZONES` map only onto existing `AREA_REGIONS` keys and cover every canonical area; `zoneForArea` routes canonical/custom/empty; the component renders an inline `<svg>` schematic with clickable `aria-pressed` zones and no upload/canvas/OCR/Jane asset; the form renders `BodyMapAreaPicker` above the list `AreaPicker`; the treatment-plan editor stays on the unchanged `AreaPicker`) — run `npm test`. **Operator check (read-only):** open a session block setup on `/clients/<id>/sessions/<id>` → the **"Body map"** shows a schematic body figure; clicking a zone (e.g. Face) reveals its area chips (Upper lip, Chin, …); picking one sets **"Area being charted: Upper lip"** and the same value appears selected in the **"Or choose from the list"** `AreaPicker` below; side + specifics still work; clearing shows **"Area not recorded"**. Built-in schematic only — not an uploaded body chart, image, drawing, or annotation (deferred). The treatment-plan editor is unchanged. Live payments remain disabled.

## Secure treatment image storage smoke (PR #271, migration 0092)

Confirms practitioner-only, private image storage. **Migration 0092 is applied in production — the `treatment_images` table exists and the private `treatment-images` bucket exists with `public=false`; Treatment Photos is live.** Primary coverage: `tests/lib/images/treatment-images.test.ts` (MIME allowlist jpeg/png/webp, reject SVG/PDF/oversize, filename sanitize, server-derived studio-prefixed path), `tests/migrations/0092-treatment-images.test.ts` (SQL pin: bucket `public=false`, table + FKs, RLS member policies, no-delete + revoke truncate/delete, storage.objects studio-scoped), `tests/app/clients/treatment-images.test.ts` (signed-URL-only / never `getPublicUrl`, service-role gated by a studio re-check, no public/token route imports the feature, no OCR/AI/Jane) — run `npm test`. **DB-lane (local/CI Supabase only):** `tests/db/treatment-images.db.test.ts` (cross-studio read blocked, member read/insert ok, cross-studio insert denied, soft-delete via `deleted_at`, hard-DELETE/TRUNCATE forbidden) — run `npm run test:db`. **Operator check (read-only on the surface; do not upload production data without explicit approval):** on `/clients/<id>/images` (the **Treatment Photos** tab-bar link) attach a JPEG/PNG/WebP → it lists with "Uploaded <date>"; "View" opens a short-TTL signed URL; "Archive" soft-deletes; the bucket has no public URL and no client/booking/portal/token route shows treatment images. Private storage, practitioner-only, no annotation/OCR/AI (deferred). Live payments remain disabled.

## Treatment Photos gallery UI smoke (PR #272)

Confirms the "Treatment Photos" UI polish — **UI/navigation only; no storage/RLS/signed-URL/validation/security change, no migration.** Primary coverage: `tests/app/clients/treatment-photos-ui.test.ts` (tab bar surfaces a "Treatment Photos" route link; page heading + private wording; styled "Choose image" card with the accessible native `type=file` input + image MIME allowlist; "Selected image" display + "Attach image" disabled until a file is chosen; gallery grid with View/Archive + empty state; manager calls only the existing actions and adds no storage/OCR/AI/annotation) — run `npm test`; PR #271 image tests still pass. **Operator check (read-only):** open a client record → the client tab bar shows a **Treatment Photos** tab/link (no longer buried under Health & Forms) → `/clients/<id>/images` shows the "Treatment Photos" heading + "Stored privately. Visible to practitioners in this studio."; "Choose image" opens the picker and shows the selected filename; "Attach image" is disabled until a file is chosen; existing photos render as a card grid with View/Archive; no photos shows "No treatment photos yet". Thumbnails deferred (viewing stays on-demand). No client/public exposure. Live payments remain disabled.

## Treatment Photos inline preview smoke (PR #273)

Confirms inline gallery previews — **preview polish only; no storage/RLS/signed-URL-security/schema change, no migration, no dependency.** Primary coverage: `tests/app/clients/treatment-photos-preview.test.ts` (page server-signs preview URLs with the service-role client after the studio-scoped load + does not pass raw `storage_path` to the client; grid renders inline `<img>` from the signed preview URL; in-app `role="dialog"` modal with "View larger" and no `window.open` primary path; modal re-signs via the existing ownership-checked action; "Image not available" fallback on `onError`; **no `getPublicUrl`/`publicUrl`** in app/lib; signed URLs not persisted; no public/token route imports the feature; no canvas/OCR/AI/Aesthetic-Record/comparison/export) — run `npm test`; PR #271 + #272 tests still pass. **Operator check (read-only):** on `/clients/<id>/images` photos appear as inline previews in the gallery grid; clicking a photo (or "View larger") opens an in-app larger preview modal (Close button, filename + "Uploaded <date>", "Stored privately…") — no new browser tab; a failed/expired preview shows "Image not available" while keeping filename/date/Archive; empty state unchanged. Signed URLs stay short-TTL, practitioner-only, never public, never stored. Live payments remain disabled.

## Treatment photo context tags smoke (PR #274)

Confirms treatment-context tags — **display-only / context-UI only; no schema/storage/RLS/signed-URL-security change, no migration, no dependency.** Primary coverage: `tests/app/clients/treatment-photo-context.test.ts` (pure units: scope label "Client photo" → "Session photo" → "Block photo" most-specific-wins; area label "Treatment area: <area · side · detail>" with the canonical side display label, "Area not recorded" when a block is attached but has no area, null when no block; UI wiring: `page.tsx` computes labels server-side + embeds `session_blocks ( primary_area, side, custom_area_detail )`, the manager renders `ContextTags` on cards + in the modal, and the client never receives raw `session_id`/`session_block_id`/`storage_path`/bucket/signed-URL text) — run `npm test`; PR #271/#272/#273 tests still pass. **Operator check (read-only):** on `/clients/<id>/images` each photo card shows a scope badge (today: "Client photo", since uploads are client-only), the "Uploaded <date>", and a muted "Clinical reference"; opening the larger preview shows the same tags + filename + "Stored privately…"; no UUIDs, storage paths, bucket names, or signed-URL strings appear in the UI. Session/block/area badges appear only once a future write-path attaches photos to a session/block. Live payments remain disabled.

## Treatment image storage boundary hardening smoke (PR #276, migration 0093)

Confirms the storage trust boundary — **hardening only; no UI/product/payment change.** Primary coverage: `tests/lib/images/treatment-images.test.ts` (the pure `validateTreatmentImagePath`: accepts a same-studio/client path; rejects wrong bucket / wrong studio prefix / wrong client prefix / traversal (raw + `%2e%2f`) / extra segment / whitespace / backslash / bad extension), `tests/migrations/0093-harden-treatment-image-storage.test.ts` (SQL pin: bucket stays private, authenticated `storage.objects` policies dropped, bucket/path CHECKs, block-requires-session CHECK, integrity trigger), and `tests/app/clients/treatment-image-hardening.test.ts` (signer + page call the validator; upload raises `treatment_image_orphan_cleanup_failed`; no `getPublicUrl`/public-route exposure) — run `npm test`; PR #271–#274 image tests still pass. **DB-lane (local/CI Supabase only):** `tests/db/treatment-image-hardening.db.test.ts` — direct authenticated `storage.objects` insert blocked + select returns 0; forged path/bucket and cross-studio client/session/block rejected; identity columns immutable; soft-archive + service-role valid inserts still work — run `npm run test:db`. **Operator check (read-only, after 0093 applied):** in the dashboard `treatment-images` is still PRIVATE (public=off); `select policyname from pg_policies where tablename='objects' and policyname like 'treatment_images_objects%'` returns 0 rows; the Treatment Photos gallery still renders previews (the service-role signer is unaffected). **Migration-first: production migration 0093 must NOT be applied until explicitly approved.** No public URLs; practitioner-only; live payments remain disabled.

## Treatment image content validation + EXIF stripping smoke (PR #277, no migration)

Confirms server-side upload content validation — **upload hardening only; no UI/product/payment change, no migration.** Primary coverage: `tests/lib/images/treatment-image-sanitize.test.ts` (sharp builds fixtures: real JPEG/PNG/WebP accepted; PDF-body-as-PNG, HTML-body-as-JPEG, SVG, HEIC container, empty, corrupt-garbage, and declared≠detected fake-MIME all rejected; **EXIF input → output has no EXIF**; output re-encoded ≠ input; content type deterministic per format), and `tests/app/clients/treatment-image-content-validation.test.ts` (the action calls `sanitizeTreatmentImage` and uploads `sanitized.bytes` with `sanitized.contentType` + `size_bytes: sanitized.bytes.length`; invalid image returns **before** any `.upload()`; orphan-cleanup preserved; sanitizer is `server-only` sharp, never calls a metadata-preserving encode, never logs bytes; no `getPublicUrl`/public-route exposure) — run `npm test`. **Operator check (read-only, no production upload):** uploading a renamed `.png` that is actually a PDF, an `.svg`, or a `.heic` is rejected with "Upload a valid JPEG, PNG, or WebP image."; a genuine JPEG with GPS EXIF uploads and the stored object carries no EXIF/GPS. No public URLs; practitioner-only; live payments remain disabled. (No DB migration — `sharp` promoted to a direct dependency; the build uses it as before.)

## Treatment image archive scope + zero-row smoke (PR #287, no migration)

Confirms archiving a Treatment Photo changes **exactly the current client's row** — and only then reports success. **Data-integrity hardening only; no storage/bucket/signing/sanitizer/RLS/schema change.** Primary coverage: `tests/app/clients/treatment-image-archive-scope.test.ts` (behavioral, Supabase mocked: a valid same-client archive succeeds and the UPDATE is scoped by `id + studio_id + client_id + deleted_at null`; a zero-row result — wrong-client / cross-studio / nonexistent / already-archived — returns a generic "Treatment photo not found.", does **not** revalidate the page, and never reports success; a DB error returns the generic "Could not archive the image." without leaking the provider message; the not-found error reveals nothing about another client/studio/image; source-grep: the `.eq("client_id", input.clientId)` scope + `.select("id")` row-affected check are present and storage/signing is unchanged) — run `npm test`. **Operator check (read-only, no production writes):** on `/clients/<A>/images`, a stale/tampered Archive carrying Client B's (same-studio) image id fails with "Treatment photo not found." and B's photo stays intact; a valid Archive on Client A's own photo still works and the gallery updates. Backstopped by 0093 (identity immutability) + RLS (studio gate). No public URLs; live payments remain disabled (unrelated).

## Treatment photo attach-to-session/block smoke (PR #284, no migration)

Confirms a photo can be attached to a session and/or treatment area at upload — **product feature only; no storage/RLS/signed-URL/sanitizer change, no migration.** Primary coverage: `tests/app/clients/treatment-photo-attach.test.ts` (the action reads `sessionId`/`sessionBlockId` and stores validated ids; default keeps both null = client photo; **server-side validation** scopes the session by studio+client and derives/validates the block's session, rejecting cross-tenant/mismatched ids with a generic error; sanitizer/path-validation/orphan-cleanup unchanged; no `getPublicUrl`; the page loads recent sessions via the studio+client-scoped RLS client; the manager renders the Client/Session/Treatment-area selector with a client-only fallback and shows area labels, never raw ids/paths) + the existing context-tag tests — run `npm test`. **DB backstop (unchanged):** `tests/db/treatment-image-hardening.db.test.ts` already proves the 0093 trigger rejects a cross-studio client/session, a block from another session, and a block without its session, while a valid session+block insert passes. **Operator check (read-only, no production upload):** on `/clients/<id>/images`, the upload form shows a "Photo context" selector — Client photo (default) / Session photo / Treatment area photo; choosing Session lists recent sessions, choosing Treatment area lists that session's blocks with area labels; a "Will attach as: …" summary appears before upload; a client with no sessions sees "No sessions yet … photos attach to the client." The resulting gallery card/modal shows the correct context tag (Client/Session/Block photo + "Treatment area: …"). No public URLs; practitioner-only; no client/portal exposure; live payments remain disabled.

## Treatment photo UX cleanup — labels + session date smoke (PR #304, no migration)

Render-only label/title cleanup (Chloe pilot feedback). (1) **No raw filename:** the gallery card + larger-preview modal no longer show the sanitized `.jpg` `original_filename`; a photo attached to a session is titled **"Session {session date}"** (the session's `started_at`), and a photo with no session falls back to **"Uploaded {date}"**. Image `alt`/`aria` are human ("Treatment photo"), never the filename. (2) **Consistent scope label:** `treatmentPhotoScopeLabel` (`photo-context.ts`) returns **"Treatment area photo"** for a block-attached photo (was "Block photo"), matching the upload selector's existing "Treatment area photo" option — one consistent label. (3) **Session date** comes from a **read-only PostgREST embed** added to the existing image query (`sessions ( started_at )` via the `treatment_images.session_id` FK) — display-only, no schema/security/sanitizer/storage/signed-URL/archive change, no migration. **Manual smoke (read-only):** on `/clients/<id>` Treatment Photos, a session-attached photo shows "Session {date}" (not a `.jpg` name) with the "Session photo"/"Treatment area photo" tag; a client-scope photo shows "Uploaded {date}"; the larger preview shows the same. Pinned by `tests/app/clients/treatment-photo-labels.test.ts`; the existing photo suites (context, attach-context, preview, UI, hardening) stay green. **Deferred (out of scope, need migration/product decision):** per-photo notes/caption, removing "Client photo", unifying "Session photo" vs "Treatment area photo", the full photo-context redesign. Live payments remain disabled.

## Treatment photo notes/captions smoke (PR #307, migration 0099)

Practitioners can add/edit a short note under each treatment photo. **Migration 0099** adds one nullable `practitioner_note text` column to `treatment_images` (additive/backfill-safe; existing rows NULL; **no RLS change** — the existing "treatment_images: members update" policy covers it; **no trigger change** — the 0093 integrity trigger freezes only identity columns, so a note UPDATE passes; no enum/destructive/storage/token change). `updateTreatmentImageNoteAction` (`actions.ts`) is a **metadata-only UPDATE via the RLS client** (not service-role), scoped by `id + studio_id + client_id + deleted_at IS NULL` with a `.select("id")` row-affected check — **exactly like `archiveTreatmentImageAction`** — so a same-studio cross-client write is a generic "not found"; it trims, stores whitespace-only as NULL, caps at **1,000 chars** (`TREATMENT_NOTE_MAX_LENGTH`), returns generic errors, logs nothing sensitive, and revalidates the images path. UI: the note renders under each photo on the **card and in the modal**, with **"Add note"** (empty) / **"Edit note"** (existing) opening an inline textarea + Save/Cancel calling the action; practitioner-only through the existing gated page. Upload form, sanitizer, storage paths, signed URLs, Archive/delete, and session/block attach are all unchanged. **Manual smoke (read-only — no real upload):** on `/clients/<id>` Treatment Photos, add a note on a photo → it shows under the card + modal; edit it; clear it (whitespace) → note disappears; a >1,000-char note is rejected with the generic error. Pinned by `tests/migrations/0099-treatment-image-notes.test.ts` + `tests/app/clients/treatment-photo-notes.test.ts`. Out of scope: note audit/history, removing "Client photo", photo-context redesign. Live payments remain disabled.

## Treatment photo upload size hardening smoke (PR #292, no migration)

Confirms the upload action defensively bounds byte length around the existing pipeline — **byte-length guards only; no sanitizer/storage/signed-URL/bucket/UI change, no migration.** Primary coverage: `tests/app/clients/treatment-image-upload-bounds.test.ts` (behavioral: `validateTreatmentImageUpload` — the function the action re-applies to the **actual buffered length** — rejects 0 / non-finite ("Image file is empty.") and `> 15 MB` ("Image is larger than the 15 MB limit."), accepts exactly the cap; real-Sharp: a valid JPEG/PNG/WebP still sanitizes and its **sanitized output stays ≤ 15 MB** so the new output cap never rejects a legitimate upload, and empty bytes are rejected; source-grep ordering: `file.size` validated **before** `arrayBuffer()`, the buffered `byteLength` re-validated **after** `arrayBuffer()` and **before** the sanitizer, the **sanitized output** capped **before** the storage `.upload(`, the sanitized bytes (not the original `inputBytes`) are uploaded, real `instanceof File` guard, no `getPublicUrl`, no `.withMetadata()`) — run `npm test`. The existing Treatment Photos suites (sanitizer content-validation, storage hardening, archive scope, attach context, UI) all stay green. **Operator check (read-only, no production upload):** uploading a valid JPEG/PNG/WebP still succeeds; an empty or > 15 MB file is rejected with the generic size error before any storage write. No public URLs; practitioner-only; sanitized bytes stored; live payments remain disabled.

## Tenant consistency constraints smoke (PR #278, migration 0094)

Confirms same-studio parent enforcement on clinical/import child tables — **DB hardening only; no UI/product/payment/RLS/app change.** Primary coverage: `tests/migrations/0094-tenant-consistency-constraints.test.ts` (SQL pin: parent unique keys; composite same-studio FKs on sessions/session_blocks/client_intake_forms/imported_treatment_memories/treatment_plans + electrolysis block-belongs-to-its-session; idempotent; no RLS/payment/trigger change). **DB-lane (local/CI Supabase only):** `tests/db/tenant-consistency.db.test.ts` — a child row with a cross-studio client/session/import-batch is rejected (insert and update), an electrolysis entry whose block is from another session is rejected, same-studio inserts work (authenticated + service role), client-delete cascade + appointment/block detach-to-NULL still work, and cross-studio RLS reads stay blocked — run `npm run test:db`. **Production preflight (read-only, before applying 0094):** run the 8 mismatch-count queries embedded in the migration header — every count must be 0 (verified 0 on 2026-06-28). **Migration-first: production migration 0094 must NOT be applied until explicitly approved.** The payment tables + `treatment_images` (0093) were already enforced and are untouched. No public URLs; live payments remain disabled.

## Stripe-write source inventory smoke (PR #309, no migration)

`scripts/check-stripe-gates.mjs` is now a **complete Stripe-write inventory** (source-gate/read-only; scans `app/`, `lib/`, `middleware.ts`, `next.config.ts`). Run `node scripts/check-stripe-gates.mjs` → exit 0 with: **money movement 1/1/0/0** (`paymentIntents.create`=1, `refunds.create`=1, `charges.create`=0, `checkout.sessions`=0 — output byte-compatible with the pre-#309 gate that `verify-production.mjs` relies on); the **six non-money writes** exactly-count pinned to one file each (`customers.create`/`setupIntents.create` → `lib/stripe/setup-intent.ts`; `accounts.create`/`accountLinks.create`/`accounts.createLoginLink` → `lib/stripe/account.ts`; browser `confirmSetup` → `app/portal/PortalPaymentMethodForm.tsx`); and **`no-unclassified-stripe-writes` PASS**. The catch-all **hard-fails** (exit non-zero, names the file/method) on any new Stripe mutating call — a new verb (`.update`/`.cancel`/`.confirm`/`.capture`/…), a new namespace, or a browser `confirmPayment`/`confirmCardPayment` — while comment-only mentions and read-only `.retrieve`/`.list` do not trip it. **Source-gate only: no runtime payment behavior changed, no live-mode guard touched, live payments remain disabled.** Pinned by `tests/scripts/check-stripe-gates.test.ts` (money 1/1/0/0 lines; six pinned non-money rules; catch-all hard-fail on injected server/browser fakes; comment-only + read-only pass) + `tests/scripts/check-stripe-gates-refund.test.ts`.

## storage.objects manual-check reminder smoke (PR #315, no migration)

A fresh evidence-based storage-isolation audit (before real client files) found **no P0/P1 blocker**: the single `treatment-images` bucket is private (`public=false`, migrations 0092/0093, verify-production-asserted), `storage.objects` is **service-role-only** (0093 dropped the 0092 authenticated select/insert policies and added none → `authenticated` is deny-by-default; db-integration lane pins this in `tests/db/treatment-image-hardening.db.test.ts`), the one object write is server-derived (`<studio_id>/<client_id>/<id>.<ext>`), every `createSignedUrl` is preceded by a studio+client ownership check + `validateTreatmentImagePath`, delete is soft-only + studio-scoped, and the studio export excludes binaries/paths. The one gap was verification-precision: the pre-live `verify-production.mjs` printed the Vercel/Stripe/log manual checks but **omitted the storage.objects dashboard check** — the one storage guarantee not introspectable from the linked query role. PR #315 adds that manual-check line (**print-only**, no logic change): "Supabase dashboard → Storage → policies: confirm `storage.objects` has no authenticated/anon policy granting access to `treatment-images`; 0093 dropped those policies, so objects must be service-role-only; confirm no foreign-bucket policy OR-combines onto `storage.objects`." **Smoke:** `node --env-file=.env.local scripts/verify-production.mjs` prints the storage.objects line in the "MANUAL checks still required" section; pinned by `tests/scripts/verify-production.test.ts`. Docs/tooling-only — **no migration, no RLS/storage-policy change, no service-role broadening, no runtime upload/read/sign/delete change, no payment/live change.** Runbook: docs/16 §17.13.

## Service-role inventory / allowlist smoke (PR #313, no migration)

`createAdminClient()` bypasses RLS, so every runtime call site under `app/`/`lib/` is now allowlisted in `tests/security/service-role-allowlist.ts` (61 entries) with a **path / purpose / why / scopeGuard**, enforced by `tests/security/service-role-allowlist.test.ts`. Run `npx vitest run tests/security/` → the live `createAdminClient()` call-site set must **exactly equal** the allowlist; each entry needs a non-empty purpose/why/scopeGuard; each **scopeGuard symbol must be present in its file** (e.g. `getCurrentPractitionerWithStudio`, `verifyIntakeToken`, `verifyCancellationToken`, `constructEvent`, `isAuthorizedCronRequest`/`CRON_SECRET`, `isAdmin`/`ADMIN_EMAILS`); and `createAdminClient` is only constructed in the allowlisted factory (no direct `SERVICE_ROLE_KEY` client elsewhere). **Drift fails CI** — a new unallowlisted usage, a removed-but-listed entry, or a dropped guard symbol. It's an **inventory/drift gate**, not a per-query proof; high-risk session-less surfaces (public token routes, webhooks, cron) still need deeper audits. Complements the browser-boundary test (`admin-server-boundary.test.ts`). **No migration, no RLS/schema change, no runtime behavior change** (spot-checks found no unsafe usage). Documented in docs/03 §1a. Stripe gates unchanged (money 1/1/0/0 + non-money + catch-all).

## Record Keeping export completeness smoke (PR #312, no migration)

The owner-only studio ZIP export (`exportStudioDataAction`, `app/(app)/settings/data/actions.ts`) now includes the four record-keeping / inspection tables that were previously omitted: **`record_keeping_sterile_items.csv`**, **`record_keeping_disinfectants.csv`**, **`record_keeping_exposure_incidents.csv`** (owner-only), and a **reduced** **`record_keeping_audit_events.csv`** (record type/id, action, changed-field **names**, actor, timestamp — **not** the `changes` value-snapshots or free-form `metadata`, so exposure-incident PII isn't duplicated into the audit file). Every new query is **studio-scoped** (`.eq("studio_id", studio.id)`) and read through the **RLS `createClient()`** (never the admin client), so exposure incidents + their audit rows remain **owner-only** (migration 0088 SELECT policy) — enforced twice: the action's `role === "owner"` gate **and** the RLS owner-only policy. The README gained a **SENSITIVE DATA** warning (the ZIP now contains an exposure-incident log with personal info; store/share securely; owner-only). The export **audit_logs** entry (fail-closed) is preserved. **No migration, no schema/RLS change, no treatment-image metadata/binaries/storage-paths/signed-URLs, no payment tables, no intake export change.** **Manual smoke (read-only — no writes):** as the studio owner on `/settings/data`, generate the export → the ZIP contains the four new CSVs, studio-scoped, with the README warning; a non-owner is refused (existing gate). Pinned by `tests/app/settings/data/export-owner-gate.test.ts` (+ the audit-trail guard confirms the export only reads, never writes, the audit table). Stripe gates unchanged (money 1/1/0/0 + non-money + catch-all). Live payments remain disabled.

## Postcare send-state correctness smoke (PR #311, migration 0100)

Fixes a P1 overclaim: `sendPostcareEmailAction` used `postcare_email_sent_at` as both the first-send claim and the "sent" marker, stamping it **before** the Resend call, so a provider failure showed a false "Postcare sent". **Migration 0100** adds four nullable columns to `appointments` (`postcare_email_claimed_at`/`_failed_at`/`_last_error`/`_last_attempt_at`; additive/backfill-safe, no RLS/enum/trigger/destructive change). The corrected action: first send **claims `claimed_at`** (guarded by `sent_at IS NULL` + no fresh claim, ~5-min stale-reclaim) + bumps attempts + `last_attempt_at` **without** setting `sent_at`; `sent_at` is stamped **only after provider success** (also clearing `_failed_at`/`_last_error`/`_claimed_at`); a provider failure sets `_failed_at` + a **safe/generic** `_last_error` (no raw payload/PII) and clears the claim, leaving `sent_at` NULL on first send (a failed resend keeps a prior real `sent_at`). **UI states:** Sent (`Postcare sent {date}`), Failed (`Postcare send failed. Try again.`), Sending (`Sending…`), Not-sent (`Not sent yet`), and resend-failed-after-success (keeps `Postcare sent {date}` + a small `Last resend failed. Try again.` sub-note). **"Sent" means handed to the provider — never delivered/received/opened.** **Manual smoke (read-only — no real send):** on `/calendar/<id>`, a never-sent appointment shows "Not sent yet"; a successful send shows "Postcare sent {date}"; a failed send shows "Postcare send failed. Try again." (not "sent"). Pinned by `tests/migrations/0100-postcare-send-state.test.ts` + `tests/app/calendar/postcare-send-state.test.ts` (+ existing `postcare-sent-visibility.test.ts`). Out of scope: delivery/opened tracking, content snapshot, precare, inspector export, template redesign. No payments/Stripe/live-payment change.

## Read-only production verification smoke (PR #308, no migration)

Operator-run, **read-only** pre-flight that proves remote production matches the repo's required state before live payments / broader sensitive-data use. `scripts/verify-production.mjs` (run `node --env-file=.env.local scripts/verify-production.mjs` from the production-linked Mac) reads prod exclusively via `supabase db query --linked` and checks: remote migration max — **derived from `supabase/migrations/` at run time, never hardcoded** (currently **0157**; the literal "0099" in earlier revisions of this entry was exactly the staleness the derivation was introduced to prevent); the 0093 (private treatment-image bucket + `treatment_images` RLS policies + integrity trigger), 0097 (intake-link columns), 0098 (intake-reminder columns + indexes + `claim_email_send`/`record_email_result` branches), and 0099 (`practitioner_note`) effects; RLS on the curated critical tables (incl. payments + `record_keeping_*`); zero unresolved critical payment ops alerts (count only); Stripe gates 1/1/0/0 (spawns `check-stripe-gates.mjs`); and a fresh reminder heartbeat (≤ 45 min, Upstash). It **fails closed** — prints only PASS/FAIL/INCOMPLETE + scalars (no secrets/PII/rows), exits non-zero if any required check fails or can't be verified (e.g. Upstash env absent → heartbeat INCOMPLETE, not PASS), and distinguishes `PRODUCTION VERIFIED ✓` (automated only) from the manual dashboard checks. It performs **no writes / no migration / no cron / no email / no Stripe writes**; not a CI gate, not a live-payment enablement step. Runbook + manual checks: **docs/16 §17.13** (cross-referenced from docs/10). Pinned by `tests/scripts/verify-production.test.ts` (read-only contract, no secrets/PII, fail-closed, required-check coverage, runbook present). Live payments remain disabled.

## Clinical entry command boundary smoke (0164 + 0165 APPLIED 2026-08-02, LASER-ONLY)

L18 Phase 1A. **`0164` was APPLIED to production 2026-08-02T19:39:45Z→19:39:49Z** and is frozen at
`sha256 a1f3aa27…39a3826`; hosted max is `0164`. It is **purely additive** — it revokes no table
grant and drops no policy — so direct DML remains available throughout this phase.

⚠️ **`0164` shipped with an unintended `service_role` EXECUTE grant on `create_laser_entry`**
(Supabase's `ALTER DEFAULT PRIVILEGES` grants it at create time; `0164` revoked only `public` and
`anon`). Discovered in post-apply verification. **No exposure found** — the command requires a
non-null `auth.uid()`, so a service-role caller raises `check_violation`. **Migration `0165` repaired it and was APPLIED
2026-08-02T20:20:02Z→20:20:06Z** — the ACL is now exactly
`{postgres=X/postgres,authenticated=X/postgres}`; hosted max `0165`, repo == hosted.

**L18 status:** PARTIAL — the clean laser-entry creation path uses a narrow command. Electrolysis entry writers remain direct because each relevant user workflow can depend on `session_blocks` and must move atomically in the combined phase. Direct table grants remain in place.
**`electrolysis_entries` is NOT command-bound; neither entry table is command-boundary complete;
L18 is not closed.**

**What moved.** `addLaserEntryAction` → `create_laser_entry`. **What did NOT move**, deliberately:
**all three** electrolysis writers. `createTreatmentAreaWithEntryAction` and
`updateTreatmentAreaWithEntryAction` write `session_blocks` and `electrolysis_entries` as one user
intent, and `addElectrolysisEntryAction` can create a default `session_blocks` row through `ensureBlockForSession` before creating the electrolysis entry; the two writes are not atomic today and must move together.

**Automated coverage (run these now):** `npm run test:db` →
`tests/db/entry-create-commands.db.test.ts` (22 cases against a real migrated database): an
authorized laser create succeeds and stores its values; cross-studio callers, wrong-client
assertions, foreign sessions, a NULL asserted client and inactive practitioners are all denied; the
command takes no practitioner parameter at all; studio and client resolve from the session; the
NOT NULL zone column still rejects a null; a refused command leaves no row; `anon` cannot execute
and `authenticated` can; it is SECURITY DEFINER with `search_path=""`; a service-role caller is
refused; **no electrolysis command exists**; direct DML remains available on both entry tables and
the deferred electrolysis writers still work through it; and the 0159/0160/0162/0163 boundaries are
all still intact. `npm test` →
`tests/migrations/0164-clean-entry-create-commands.test.ts` (source contract + the repo
migration-max tripwire, which moved here from the 0163 test),
`tests/security/entry-direct-dml-guard.test.ts` (the static drift guard: exactly **three**
permitted exceptions, pinned to exact file AND function, each carrying the label
`TEMPORARY L18 BLOCK-ENTRY ATOMICITY EXCEPTION`, and an explicit assertion that electrolysis direct
DML is **not** claimed closed), and `tests/app/sessions/entry-actions-use-commands.test.ts`.

**Reset discipline:** run the DB lane against a database reset with the **pinned** CLI
(`npx --yes supabase@2.102.0 db reset --local`) and confirm grants parity before trusting a
result.

**Operator check (read-only, no writes):** confirm
`supabase migration list --linked` shows `0165` in Remote exactly once; confirm the
`create_laser_entry` ACL is exactly `{postgres=X/postgres,authenticated=X/postgres}` — i.e.
`authenticated` **true**, `anon` **false**, PUBLIC **0 entries**, `service_role` **false**, owner
`postgres`; confirm `prosecdef = true` with `proconfig = search_path=""` and that **no
`create_electrolysis_entry` function exists**; and confirm
`has_table_privilege('authenticated','public.electrolysis_entries','insert')` is **still true** —
neither migration revokes a table privilege. Then, in the app, record a laser entry and confirm it
saves exactly as before, and confirm electrolysis charting is unchanged.

## Intake INSERT boundary smoke (migration 0163 — APPLIED 2026-08-02)

Closes the residual `0162` could not reach. **`0163` was APPLIED to production 2026-08-02** and
is frozen; hosted migration max is `0163`, so the operator checks below are now valid. Production
verification used effective `has_table_privilege` results, policy inspection and the table ACL —
**no production INSERT probe was performed**, which is the correct evidence for a
privilege-removal migration.

**Scope, stated exactly:** `client_intake_forms` authenticated INSERT residual closed by 0163; broader direct clinical DML findings remain open.

**The defect.** 0162's guard is a BEFORE **UPDATE** trigger, so it never fires on INSERT. An
authenticated studio member could skip the guarded transition entirely and INSERT a brand-new
`client_intake_forms` row already `status = 'reviewed'`, with a NULL `submitted_at` and a forged
historical `reviewed_at`. `0163` drops `client_intake_forms_member_insert` (plus any legacy
`FOR ALL` policy, defensively) and REVOKEs `INSERT` from `authenticated` **and** `anon`. It
removes the capability rather than constraining it because a caller audit found **zero**
legitimate authenticated INSERT paths — both writers (`ensureIntakeForClient`,
`createIntakeRequestForClient`) use the service-role admin client.

**Automated coverage (run these now):** `npm run test:db` →
`tests/db/intake-insert-boundary.db.test.ts` runs against a fresh local database with the whole
chain applied: an authenticated same-studio INSERT of a normal `in_progress` row is denied; the
same-studio INSERT of an **already-reviewed** row (the residual itself) is denied; a cross-studio
INSERT is denied; an anonymous INSERT is denied; a service-role INSERT of a normal `in_progress`
row succeeds; both writer shapes (`ensureIntakeForClient` and the `createIntakeRequestForClient`
reissue, which stamps `requested_at`/`requested_by`) still create rows; authenticated SELECT and
a permitted UPDATE are unchanged and cross-studio SELECT still returns zero rows; 0162's
`in_progress -> reviewed` refusal still fires with `23514`; and structurally, **no INSERT table
privilege and no INSERT or FOR ALL policy remains** for `anon`/`authenticated`, while
`service_role` keeps INSERT and RLS stays enabled. The former
`RESIDUAL: the INSERT path is NOT closed by 0162` cases in
`tests/db/intake-review-db-boundary.db.test.ts` are **inverted** and now assert refusal.
`npm test` → `tests/migrations/0163-revoke-authenticated-intake-insert.test.ts` pins the SQL
contract (transactional with an armed `lock_timeout`, both halves of the removal, everything it
must not touch, and that it does not claim L18 is closed) and carries the repo migration-max
tripwire, which moved here from the 0162 test.

**Reset discipline:** run the DB lane against a database reset with the **pinned** CLI
(`npx --yes supabase@2.102.0 db reset --local`) and confirm grants parity before trusting a
result — a newer CLI strips Data-API grants and makes every authenticated query fail at the
privilege layer, which looks exactly like this migration working when it is not.

**Operator check (read-only, no writes):** confirm
`supabase migration list --linked` shows `0163` in Remote exactly once; confirm
`information_schema.role_table_grants` returns **zero** INSERT rows for `anon`/`authenticated` on
`client_intake_forms`; confirm `pg_policies` for that table lists exactly `member_select`
(SELECT) and `member_update` (UPDATE) and nothing with cmd `INSERT` or `ALL`; confirm the 0162
trigger function md5 is unchanged; and confirm the row count is unchanged. Then, in the app,
confirm a practitioner can still send a new intake form and resend a link (both go through the
service-role writers) and that reviewing a submitted intake still works. Live payments remain
enabled for approved studios — do not initiate a charge as part of this smoke.

## Intake review database boundary smoke (migration 0162 — APPLIED 2026-08-02)

Confirms the database half of `F-CLIN-004`. **`0162` was APPLIED to production 2026-08-02** and
is frozen; hosted migration max is `0162`, so the operator checks below are now valid. Note that
0162 closed the review **UPDATE** transition only — the INSERT residual is closed by `0163`,
which is **NOT APPLIED**; see the section below.

**Automated coverage (run these now):** `npm run test:db` →
`tests/db/intake-review-db-boundary.db.test.ts` runs the full adversarial matrix against a fresh
local database with the whole migration chain applied, as the `authenticated` role with a real
studio-member JWT: `in_progress -> reviewed` refused (including with a forged `submitted_at`);
`submitted` with a NULL `submitted_at` refused; a legitimate `submitted -> reviewed` still
succeeds exactly once; `reviewed_by` from another studio, from the same studio but a different
user, inactive, NULL, or an arbitrary UUID all refused; a user holding practitioner rows in two
studios cannot review with the wrong studio's row; a forged historical or future `reviewed_at` is
overwritten with server time; attribution cannot be rewritten; `reviewed -> submitted` and
`reviewed -> in_progress` refused; answers and `submitted_at` immutable; `practitioner_notes`
still editable in every status; the service-role client submission still works; a service-role
review transition is refused; an anonymous update is refused; and a **real two-connection race**
produces exactly one transition with immutable attribution. `npm test` →
`tests/migrations/0162-intake-review-transition-integrity.test.ts` pins the SQL contract, the
transaction/lock discipline, and the repo migration-max tripwire. **Also run `npm run test:e2e`**:
0162 changes what `e2e/helpers/seed.ts`'s `markReviewedOutOfBand` must do (a service-role review
now fails closed, so it performs a genuine authenticated review instead), and the `browser-e2e`
lane is the only lane that executes that helper — via `e2e/intake-review-integrity.spec.ts` C2.

**Operator check — ONLY AFTER 0162 IS APPLIED (read-only, no writes):** confirm
`supabase migration list --linked` shows `0162` in Remote exactly once; open
`/clients/<id>/intake` for a client whose intake is still in progress and confirm there is no
*Mark reviewed* control (unchanged from PR #497); for a submitted intake, mark it reviewed
through the UI and confirm the Reviewed line shows **the server's** time; confirm the intake
history still lists prior rows unchanged. Do **not** attempt a direct PostgREST `PATCH` against
production to test the boundary — the automated lane already proves it on a disposable database.
No production writes, no backfill, no data correction. Live payments remain disabled.

## Global Search V2-A — searchable settings + navigation smoke (no migration)

Signed in **as the studio owner**, open the header search and type each of:
`reminder`, `hours`, `buffer`, `booking link`, `consent`, `photo consent`,
`google`, `calendar sync`, `sms`, `payments`, `services`, `team`,
`data export`, `privacy`, `records`. Confirm every one returns a result under
the **Settings & Pages** group with a plain-English description, and that
clicking it lands on the matching settings page — `reminder` should land on
Settings → Studio at the *Email notifications* block (not the top of the page),
and `photo consent` on Settings → Consent forms.

Then sign in **as a non-owner practitioner** in the same studio and repeat
`payments`, `hours`, `consent`, `reminder`, `team`, `services`. Confirm **none
of them offers an owner-only settings page** — not as a greyed row, not as a
"no permission" row, nothing at all. Confirm `profile`, `intake`, `launch`,
`sterile` and `getting started` still resolve for that practitioner.

Confirm, for both roles: typing a client name still returns the client (data
results were not displaced); the empty search box still shows the six
shortcuts Dashboard / Clients / Calendar / Record Keeping / Settings / Getting
Started; nothing in any result mentions Exposure Incidents or any `/admin`
page; and on a phone the search sheet still fits with no sideways scroll.

Search is discovery only — it adds no permission. Anything it offers was
already reachable by that practitioner from the menu. Live payments unchanged.

## Global Search V2-A.1 — settings CONTROL search smoke (no migration)

Signed in **as the studio owner**, open the header search and type the exact
visible setting name **`booking horizon`**. Confirm the first result is
**Booking horizon — "Choose how far ahead clients can book online"**, and that
clicking it lands on Settings → Booking **at the Booking horizon field**, not at
the top of the page. Repeat with `horizon`, `how far ahead`, `booking window`
and `months ahead` — all must reach the same control.

Then confirm each of the other seven Booking controls resolves to its own field:
`booking link`, `slug`, `timezone`, `default duration`, `buffer`,
`public address`, `booking page intro`. Confirm plain `booking` still returns the
Booking **page** — the page row and the control rows must both survive.

Spot-check one control from every other Settings page: `studio name`,
`time format`, `send 24 hour reminders`, `weekly hours`, `lunch`,
`service menu order`, `pending invitations`, `photo consent`,
`aftercare instructions`, `cancellation policy`, `late cancellation fee`,
`google calendar`, `pixel`, `csv`, `export your data`, `calendar feed`.

Then sign in **as a non-owner practitioner** and repeat `booking horizon`,
`timezone`, `weekly hours`, `studio name` and `export your data`. Confirm **none
of them returns anything at all**. Confirm `your name`, `calendar color`,
`calendar feed` and `intake form preview` still resolve for that practitioner.

Search adds no permission — every control it offers was already reachable from
that practitioner's own Settings tabs. Live payments unchanged.

## Quick gates a reviewer can run

GitHub Actions CI (PR #154) runs the full validation suite on every PR. The local equivalent is:

```bash
npm run ci    # typecheck + lint + build + test + check:stripe-gates
git diff --check
```

Since PR #220 there is also a DB/RLS integration lane (separate CI job `db-integration`; LOCAL database only, never production):

```bash
supabase db start          # local Docker stack (db port 54322)
supabase db reset --local  # applies migrations 0001-current from scratch
npm run test:db            # tests/db/: RLS, triggers, claim RPCs, constraints
npm run check:db-types     # PR #221: lib/types/database.ts vs migrated schema
```

And since PR #227 a browser E2E lane (separate CI job `browser-e2e`; LOCAL stack only, never production):

```bash
supabase start -x studio,imgproxy,realtime,edge-runtime,logflare,vector,storage-api
supabase db reset --local
npm run test:e2e           # Chromium, ALL 53 specs under e2e/ (testDir: ./e2e) —
                           # the core treatment-memory loop plus every later spec
npm run test:e2e:payment   # fake-Stripe payment lane
npm run test:e2e:mobile    # mobile-completion lane (iPhone profile)
npm run test:e2e:google    # fake-Google calendar lane
npm run test:e2e:ui        # interactive debugging
```

One-time local setup for the E2E login: `supabase/config.toml` (untracked) must allow-list the E2E app origin for the magic-link redirect. Set `additional_redirect_urls = ["http://localhost:3111/**", "http://127.0.0.1:3111/**"]` in the `[auth]` section and restart the stack. The CI `browser-e2e` job materializes the same setting itself.

The E2E flow covers: public booking, intake wizard, REAL practitioner magic-link login (GoTrue email captured by local Mailpit; no auth bypass), Dashboard incl. the Charted-within-24h card wording, charting a treatment area (area, machine frequency, probe brand + lot, minutes, tolerance, reaction), the For-next-visit note, a second booking, Before Today memory on the client page, the filtered Client Procedure Record + print (incl. the aftercare mark), and anonymous lockout of Records/print/Dashboard. It assumes a DISPOSABLE local database. **Scope corrected 2026-07-27:** the suite is Chromium-only and still does not cover real provider sends (Resend/Twilio), real Stripe Elements or real webhook delivery — but it **does** now cover payments (`payment-browser-e2e`, fake-Stripe) and **multi-practitioner permissions** (`e2e/practitioner-schedule-studio-b.spec.ts`, `practitioner-booking-studio-b.spec.ts`, `practitioner-reassignment-studio-b.spec.ts`). Cross-browser variants remain uncovered.

Mobile/iPad manual smoke (PR #228; the E2E lane covers the same ground with synthetic pointer events, but native gesture nuance still deserves real fingers): on an iPhone, open Dashboard, Notifications, Records, and Calendar; confirm the page cannot be dragged sideways on any of them; open the Menu button and navigate to each destination; confirm Sign out is reachable in the menu; on Calendar, scroll up/down with a finger over the grid and confirm NO booking drawer or chooser ever appears; swipe sideways within the calendar card (the week grid scrolls inside the card only); create an appointment ONLY via the "+" button at the top of a day column; on an iPad repeat the Calendar scroll/drag check. Combined Today workflow additions (2026-07-31; supersedes the PR #241 Daily Prep Brief steps): open the Dashboard and confirm there is exactly ONE appointment list, under the "Today" heading, and NO separate "Daily prep brief" card; confirm each of today's appointments appears exactly once, in time order; confirm a returning client with a saved next-visit note shows one "Remember: ..." line and a recorded caution shows one separate, rose-coloured "Caution: ..." line (never the same text under both labels); confirm the latest recorded setup shows once as "Latest setup: ..." and there is no second "Last recorded: ..." line; confirm intake shows only as the intake pill and charting only as the next-action chip, with no duplicate "Intake incomplete" / "Charting needed" reminder lines beneath; confirm specific record gaps show as chips ("Probe lot missing", "Aftercare not marked") with no generic "Records: N reminders" line beside them; confirm a brand-new client reads "New client · No charted history yet" once; confirm the row body still opens the appointment and the one action button still opens the right page; confirm with no appointments there is ONE empty state ("No appointments today.") and no "Nothing needs special review yet." card; confirm ONE quiet "Was this useful?" prompt at the foot of the section, not one per appointment; on a phone confirm long multi-line notes wrap in full with no sideways scroll. Rules-based only (no AI, no model call); it summarizes recorded facts and takes no action. PR #249 additions (Missing Records / Follow-up Assistant V1): open the Dashboard and confirm a "Follow-up assistant" card renders under Practice Snapshot with the subtitle "Record gaps and follow-ups from recent appointments."; with a recent completed appointment that was never charted confirm a "Charting needed" item with a Chart appointment link, with a recent session whose aftercare/risks were never marked confirm an "Aftercare not marked" item, with a treatment area saved without a probe lot confirm a "Probe lot missing" item, with an intake left in progress confirm an "Intake incomplete" item, and with a for-next-visit note on a client who has no upcoming appointment confirm a "Follow-up" item; confirm tapping an item opens the linked client/session page; confirm with no recorded gaps the card shows the calm empty state "Nothing needs follow-up right now."; on a phone confirm the items stack with no sideways scroll. It is rules-based only (no AI, no model call), read-only and link-only; it flags recorded gaps and takes no action (no auto-charting, no auto-send, no auto-book, no record edits). PR #250 additions (Pilot Love Loop V1): open the Dashboard and confirm a compact "Pilot learning" card renders near the bottom (well below Today) with the copy "Notice a moment where Hone helped you remember something? Send it to Sam." and two buttons, "Send feedback" and "Know another electrologist?"; confirm the Daily prep brief and Follow-up assistant cards each show a quiet "Was this useful?" footer with Yes / Not really / Tell us what it helped with; tap "Send feedback" (or any of these) and confirm it opens the device mail composer to hello@hone.care with a safe subject like "Hone feedback: Pilot learning" and a generic body (surface + sentiment + an "(Add any details here.)" placeholder) — NO client name, phone, address, treatment detail, exposure detail, Stripe id, payment data, token, or audit JSON anywhere in the subject/body; confirm nothing is sent automatically (it only opens the composer) and there are no contact-access, referral, or tracking links; on a phone confirm the prompts and card wrap cleanly with no sideways scroll. Everything is manual mailto only — no automated outreach, no contact importing, no referral automation, no AI/model call. On the public homepage, confirm the "Built from real treatment rooms." origin-story section renders as a balanced two-column story: left has the eyebrow "Why Hone exists", the heading, body copy, and a short supporting line; right has a compact "What gets hard to remember" card (generic question rows, a blue "Hone keeps those details close to the next appointment." band, and chips Used last time / Client response / Caution note / Record gap). Confirm it does not look empty or unfinished, fills the band, and stacks copy-then-card on mobile with no horizontal overflow at phone or desktop; copy only, generic labels only, no metrics, no fake proof, no generic salon/practice-management claims, treatment-memory positioning preserved. PR #238 additions (Chloe pilot feedback cleanup): on an iPhone, tap into the header search input and confirm the page does not zoom awkwardly when the field gains focus (and pinch zoom still works everywhere); open a client and confirm the sections are a Section dropdown on the phone (Overview, Sessions, Treatment Plans, Messages, Health & Forms, Personal Notes), pick two sections and confirm each loads with the dropdown showing the picked section and no sideways scroll, then on an iPad/desktop confirm the underlined tab row is back; chart a session and confirm the Finish up section at the bottom explains that each treatment area, the next-visit note, and the risks/aftercare stamp already saved with their own buttons, then tap Done charting and confirm it exits to the client's Sessions tab (with appointment context, also confirm Review appointment & billing opens the appointment); open Records and confirm the section reads Procedure records with the helper "Use this when you need a procedure record for one client", a Choose a client picker, and unchanged filter + Print/Export behavior; open the Dashboard and confirm Today is the first section, with the Getting started card below Today only while setup steps remain and a small "Setup complete. Getting started checklist" line at the bottom once they are done. PR #237 additions (Before Today hierarchy): open a returning client (one with at least one charted session) and confirm the Before Today card reads in briefing order with Remember today as the prominent blue band on top (the For-next-visit note and any watch lines live there), then a Last treatment snapshot (date, areas, and chips for modality, machine frequency, probe, lot, energy level, minutes when recorded), then Client response (last recorded) with tolerance and reaction chips plus reaction notes when recorded, then Record reminders; open a brand-new client and confirm the empty state explains that treatment memory will appear after the first charted session; on a phone confirm the chips wrap, long notes wrap, and nothing scrolls sideways. PR #236 additions (Dashboard Today actions): open the Dashboard and confirm each Today appointment shows one obvious action button: a brand-new client reads Open client; a returning client reads Review Before Today; a completed-but-uncharted appointment reads Chart appointment with an amber Charting needed chip; a charted appointment reads View session with a Charted chip; tap the action and confirm it lands on the right page; confirm the row body still opens the appointment detail and nothing scrolls sideways on a phone. PR #235 additions (charting on a phone): from a client page tap Log session, chart a treatment area end to end (area chip, machine frequency, probe lot, minutes, tolerance, reaction chip), save, write the For-next-visit note, and mark Risks & aftercare RIGHT ON the session page (new placement; same stamp as the Records row); confirm nothing scrolls sideways and no control is clipped; reopen the client page and confirm Before Today shows the note. PR #234 additions (public client surfaces on a phone): open the public booking page, a manage/cancel/reschedule link, an intake link, and an invalid token URL at phone width; confirm none scroll sideways, forms and buttons fit, and the authenticated app header (menu/search/bell) never appears on any public page. PR #234 additions (mobile sheets): open the Menu on a phone and confirm the panel is a clean full-width sheet under the header with nothing clipped and a compact identity block; open Search via the magnifier and confirm the sheet, its input, and the Close button are fully on-screen; search a client, tap the result, then reopen and dismiss via Close and via Escape; confirm no sideways scroll anywhere. PR #233 additions (client page on a phone): open a client at phone width, confirm no sideways scroll, the name reads at a comfortable size with the Edit button beside it, Log session and Book appointment sit together, all six tabs are reachable by swiping the one-row tab bar (the bar scrolls, the page does not), and Pinned Notes renders cleanly at the top of Overview. PR #232 additions (Global Search V1): in the header, search a known client by name and by phone/email, search a treatment area or probe lot number, click a result and confirm navigation; confirm results only show your studio's data; on mobile, open search via the magnifier icon, confirm the panel fits the screen with no sideways scroll, and confirm tapping a result closes the panel and navigates. PR #231 additions: on desktop, open the account dropdown (your name, top right) and confirm the profile/studio block plus Settings, Getting Started, and Sign out, then confirm outside-click and Escape close it; on mobile, open the Menu and confirm the profile/studio block sits on top with Dashboard/Clients/Calendar/Records then Settings/Getting Started/Sign out. PR #230 additions: from Calendar or Records, tap the Hone wordmark and confirm Dashboard opens; open the Menu and tap anywhere outside it (e.g. the Hone wordmark or page content), confirm the Menu closes without navigating, and confirm it reopens normally. PR #229 additions: tap the header bell and confirm Notifications opens (badge shows the unread count); open Menu and select Records, confirm the Menu closes itself; open Menu and select Calendar, confirm it closes; open Menu on the current page and tap that page's link, confirm it still closes; confirm Sign out remains reachable in the Menu and no sideways drag returned. Live payments remain disabled.

Record Keeping per-client pull (PR #223), manual smoke: on /records → Client Procedure Records, select a client (optionally a date range), Apply filter, confirm only that client's recorded sessions show with the active-filter line; Print / Export must carry the same filter (header shows "Filtered: client ..." and the range) and a filter with no matches must print the empty state, not a broken page. Clear filters must restore the default most-recent view.

Record Keeping disinfectant print status (PR #295, no migration), manual smoke: on /records → Disinfectant Records, note a batch's "Replace by" date and its on-screen due/overdue badge; open **Print / Export** for the disinfectants section and confirm the printed log now shows the **same** "Replace by" date (or "Not set") and, for an overdue/due-today/due-soon batch, a **"Replace status"** line ("Overdue — replace now" / "Due today" / "Due soon") — matching the screen, computed in the studio timezone. Pinned by `tests/app/records/print-export.test.ts` (source-grep: the disinfectants print references `discard_due_date`, renders "Replace by", and uses `disinfectantDueStatus`/`disinfectantStatusLabel`/`isDisinfectantAlert` + `todayInTz(timezone)`; render-only — no `.insert/.update/.upsert/.delete`, no schema/RLS DDL). Display-only; no migration, no cron/notification, no payment/Stripe change.

Record Keeping — Chloe feedback (PR #280, migration 0096; **requires 0096 applied** to the environment), manual smoke on /records: **Disinfectants** — Add a record and confirm THREE distinct dates: "Date prepared", "Discard / replace by", and "Actual date discarded"; set "Discard / replace by" to today and save → the row shows a **"Due today"** badge; set it to a past date with no actual discarded date → **"Overdue — replace now"** (red); within ~7 days → **"Due soon"** (amber); set an "Actual date discarded" → no badge ("replaced"); a legacy record with no due date shows "Replace by: Not set" and no badge. **Operator dropdown** — the Operator control lists yourself ("(you)") + active same-studio staff + "Other (type a name)"; pick a staff member and save → the row shows their name; pick "Other", type a name, save → that name renders; confirm no other-studio staff appear. **Exposure incidents** — the form shows an "Exposed person" Client / Staff / myself / Other selector; pick Client → choose a same-studio client → name/phone/address autofill and remain editable (edit one, save, confirm the edit persists); pick Staff → choose a practitioner → name autofills; pick Other → type a unique name; confirm only same-studio clients/staff are listed. On a phone (~390px) confirm the new selectors/badges fit with no sideways scroll and the Save button is reachable. **There is no email/SMS/bell reminder** — the due/overdue alert is read-time only (deferred; see docs/08). Pinned by tests/lib/record-keeping/disinfectant-status.test.ts, tests/app/records/record-keeping-feedback.test.ts, tests/migrations/0096-disinfectant-discard-due-date.test.ts, tests/db/record-keeping-discard-due.db.test.ts.

New-studio setup (PR #224): when creating a second real studio, follow docs/20_NEW_STUDIO_SETUP_RUNBOOK.md end to end; its sections 2.5 (surface verification), 3 (isolation checks), and 4 (smoke workflow) are the smoke catalogue for that operation.

Charted-within-24h card (PR #225), manual smoke: Dashboard shows the "Charted within 24h" card; with no completed appointments in the last 7 days it reads "No recent completed sessions yet."; after completing and charting an appointment the fraction increments (e.g. 1/1); completing an appointment without charting raises only the denominator.

Lighter manual checks the reviewer can run by hand for spot-checking:

```bash
# Stripe dormancy: diff-only sanity check. The authoritative gate
# is scripts/check-stripe-gates.mjs (run via npm run check:stripe-gates).
git diff | grep -E '^\+' | \
  grep -E 'paymentIntents\.create|charges\.create|refunds\.create|checkout\.sessions|set_studio_require_card_on_file|STRIPE_ALLOW_LIVE_MODE=true'

# Em-dashes in added lines
git diff -- '*.ts' '*.tsx' '*.sql' | grep -E '^\+' | grep -c '-'

# Static stripe imports that aren't behind the existing key gate
grep -rn '@stripe/' --include='*.ts' --include='*.tsx' . | grep -v node_modules | grep -v .next
```

## What the harness cannot verify

When opening a PR, the report MUST explicitly call out which smoke steps were not run. Items that always require manual execution because GitHub Actions CI (PR #154) cannot exercise them without real credentials or a real browser:

- Anything requiring the practitioner session cookie (`/calendar/[id]`, `/settings/*`, the in-app actions).
- Anything requiring a real Resend send to a real inbox.
- Anything requiring a real Twilio SMS to a real phone number.
- Anything requiring a real Stripe test charge against the connected account.
- Anything requiring a real client portal session cookie.
- Anything requiring the Vercel production env dashboard.

The DB/RLS integration lane (PR #220) removed several items from this list: cross-studio RLS isolation, audit-trail immutability and trigger behavior, the clinical delete posture, the double-booking constraint, and the claim RPCs are now exercised on a real local database in CI instead of requiring manual SQL against production. What the DB lane still cannot verify: production-specific state (data drift, policies edited outside migrations: the prod catalog audit recipe in docs/09 remains the check for that), Stripe/Resend/Twilio behavior, and the browser.
