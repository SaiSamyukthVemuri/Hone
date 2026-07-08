# 21 Supervised Pilot Readiness Checklist (Chloe / Laura)

This is the practical **go / no-go** checklist for putting Hone in front of the
first two supervised pilot practitioners. **Supervised live owner-run session
payments are live for approved studios** (Willow + Sam's controlled studio);
**public booking still collects no payment**, and a NEW studio starts test-mode
until it completes its own supervised live-enablement. It complements the deeper
runbooks: [docs/11 Runbook](./11_RUNBOOK.md),
[docs/12 Smoke tests](./12_SMOKE_TESTS.md),
[docs/16 Live payments readiness](./16_LIVE_PAYMENTS_READINESS.md),
[docs/20 New studio setup runbook](./20_NEW_STUDIO_SETUP_RUNBOOK.md),
[docs/production/current-state.md](./production/current-state.md).

> **Payment posture:** supervised live **session payments** are enabled for
> approved studios (live Connect + charges + refunds + webhooks proven; live/test
> isolation live; Stripe gates 15 PASS). **Public booking card collection is
> OFF**, deposits/packages/partial payments are not built, and **live manual
> no-show / late-cancel fees are hard-held** server-side (only `session_payment`
> charges live). **Broad self-serve live payments are not ready** — do not enable
> live payments for a new/unapproved studio outside the supervised approval
> process.

---

## 1. Go / No-go summary

**GO when every item in §2 (must-configure) is checked for each studio and the
§4 verifications pass. NO-GO if any of these are true:**

- No active service, or no consultation-type service, or no open availability
  day for a studio (public booking will be unavailable or dead-end for new
  clients).
- Studio timezone is wrong (all public slot times will be wrong).
- `verify-production.mjs` fails, or the treatment-image bucket is missing / not
  private.
- Production is not on the current expected migration max. **Do not hardcode the number — derive it** from `supabase migration list --linked` and [docs/production/current-state.md](./production/current-state.md). (As of 2026-07-08 the production max is **0112**.)
- The data-recovery expectations in §6 are not confirmed **before** real client
  data is entered.

Everything else below is either intentionally disabled (§3), a day-1 test (§5),
or a supervised workaround.

---

## 2. Must-configure (per studio, before pilot)

Do this once per pilot studio (Chloe, Laura) in Settings:

- [ ] **At least one ACTIVE service.** Without it the public page shows
      "Online booking is not available yet" (`lib/booking/readiness.ts`).
- [ ] **At least one CONSULTATION-type service** (modality `consultation`, or a
      service whose name contains "consultation"). New clients can only book
      consultation services; without one, new clients hit an "online
      consultation booking is not set up yet" dead-end
      (`lib/booking/consultation.ts`).
- [ ] **Weekly availability** — at least one open day with open/close times
      (Settings → Availability). These rows are **not** auto-seeded on studio
      creation (`app/(app)/settings/availability/actions.ts`).
- [ ] **Correct studio timezone.** Default is `America/Toronto`
      (`supabase/migrations/0010_booking_v1.sql`). If a practitioner is not in
      Eastern time, **every** public slot time is wrong until this is set.
- [ ] **Booking slug, studio name, and public address** set (Settings →
      Booking / Studio). The slug drives the `/book/[slug]` URL; a missing slug
      404s the public page.
- [ ] **Email env for confirmations:** `RESEND_API_KEY` set and the studio's
      `send_confirmation_emails = true`. Email is the default confirmation
      channel.
- [ ] **Core production env present:**
      `NEXT_PUBLIC_APP_ORIGIN=https://hone.care` (required in prod —
      `lib/app-origin.ts` throws otherwise), `SUPABASE_SERVICE_ROLE_KEY`
      (public reads use the admin client). Optional: `TWILIO_*` (SMS — off
      unless configured), `UPSTASH_*` (rate limit — **fails open** if absent,
      so its absence never blocks a booking).
- [ ] **`CRON_SECRET` set in production** (Bearer token for the reminder /
      recurring-break cron endpoints; validated by `lib/cron/auth.ts`, which
      rejects when unset). If unset, appointment/intake **reminders never
      fire** (booking confirmations still send at booking time). This is **not**
      enforced by the production build gate, so confirm it manually here.
      > Note: it is intentionally NOT added to
      > `scripts/check-production-env-gates.mjs` — doing so would break the
      > production build with a false failure if the secret is not yet set.
      > Track it here instead.

## 3. Verify before pilot (§4 checks)

- [ ] **Run `scripts/verify-production.mjs`** and confirm all checks pass
      (an INCOMPLETE that is only the reminder-scheduler heartbeat / local Upstash
      is acceptable), including the production migration max (**0112** as of
      2026-07-08 — verify against `supabase migration list --linked`, do not assume)
      and the `0093 bucket` check.
- [ ] **Treatment-image bucket / private-policy verification.** Confirm the
      `treatment-images` bucket exists and is **private**
      (`verify-production.mjs` `0093 bucket` check), and in the Supabase
      dashboard → Storage → policies confirm `storage.objects` has **no**
      authenticated/anon policy granting access to `treatment-images` (0093
      dropped those; objects are service-role-only). If the bucket is missing,
      create a PRIVATE bucket named `treatment-images` per the 0092 manual
      fallback note. Uploads fail safe (generic error + ops alert, no data
      loss) if this is wrong, but photos won't work until it is fixed.
- [ ] **External reminder scheduler health.** Wire the external scheduler
      (cron-job.org) to hit the reminder route every ~15 min with
      `Authorization: Bearer ${CRON_SECRET}`, then confirm the `/admin`
      "Reminder scheduler" card reads **Healthy** and the
      `verify-production.mjs` heartbeat check passes. The heartbeat alert
      (`lib/cron/reminder-heartbeat.ts`) is the automatic backstop that fires
      if the scheduler goes silent.
- [ ] **`check-stripe-gates.mjs` passes (13 PASS)** and
      **`check-production-env-gates.mjs`** passes — confirms money paths stay
      inert and required prod env is present.

## 4. What is intentionally disabled / held (do NOT "fix" for the pilot)

- **Public booking card collection.** Booking never touches Stripe; the
  confirmation states "No payment was collected for this booking." (Live
  owner-run *session* payments happen in-app after the appointment, not at
  booking — and only for approved studios; see the payment posture banner above.)
- **Live manual no-show / late-cancel fees.** Hard-held server-side; only
  `session_payment` charges live.
- **Broad self-serve live payments.** A new/unapproved studio stays test-mode
  until it completes supervised live-enablement; do not flip it as part of setup.
- **Booking deposits / packages / partial payments.** Not built; booking never
  touches Stripe; the confirmation states "No payment was collected for this booking."
- **Returning-client online self-booking.** The "I'm an existing client" path
  routes to the client portal (manage / reschedule / cancel only) — it does
  **not** self-book a new appointment. Returning clients are re-booked by the
  practitioner via **calendar quick-book**. (Portal copy says "manage your
  upcoming appointments" — it no longer promises booking.)
- **SMS confirmations** — off unless `TWILIO_*` is configured **and** the client
  consents (and, for existing clients, the submitted phone matches the stored
  phone). Email is the default channel.

## 5. Day-1 practitioner test plan

Have Chloe / Laura (with a supervisor) run these on the real production site:

- [ ] **New-client consultation booking** end-to-end → appointment appears on
      the calendar, a confirmation email arrives, and the **slot time matches
      the studio's real wall clock** (timezone guard).
- [ ] **Concurrent double-book:** two browsers submit the same slot → the
      second fails with "That time is no longer available."
- [ ] **Buffer / close-of-day:** back-to-back appointments honor the buffer and
      no slot overruns the close time.
- [ ] **Unconfigured path:** with no service / no open day, the public page
      shows the sanitized "not available yet" message.
- [ ] **Existing-client path** routes to portal sign-in (no booking form), then
      the practitioner books that returning client from calendar quick-book.
- [ ] **Reschedule / cancel** links from the confirmation email resolve and
      free / rebook the slot.
- [ ] **Charting:** chart a session, confirm recall on the next visit (open the
      client's Before Today card before charting so prior-visit cautions show).
- [ ] **Treatment photo:** upload a **~10 MB** photo against production and
      confirm it succeeds. The advertised cap is 15 MB and `next.config.ts` sets
      the server-action body limit to 16 MB, but confirm the platform accepts a
      large image; if a large upload fails at the platform layer, communicate a
      smaller safe cap until adjusted.
- [ ] **Record Keeping:** add/edit a sterile item; confirm expiry badges /
      banner / print marker; confirm **exposure incident history is owner-only**;
      run the owner ZIP export and confirm completeness.
- [ ] **Cross-studio isolation:** Chloe's `/book/[slug]` shows only Chloe's
      services + availability; Laura's only Laura's.

## 6. Data recovery (confirm BEFORE real client data is entered)

The documented rollback path covers **code and migrations** (revert the merge +
Vercel redeploy; migration-first process in docs/11 / docs/14). It does **not**
yet cover recovery of **data** after an operator / service-role mistake, a bad
bulk operation, or accidental deletion. Confirm the following before the pilot:

- [ ] **Supabase backups / PITR are enabled.** Confirm the project has daily
      backups and Point-In-Time Recovery available (Supabase dashboard →
      Database → Backups). PITR is required to recover to a moment just before a
      mistake rather than to the previous nightly snapshot.
- [ ] **Confirm the plan tier.** Daily backups + PITR depend on the Supabase
      plan tier — verify the current project's plan actually includes them
      (some tiers do not include PITR by default).
- [ ] **Expected RPO / RTO written down.** Record the expected **Recovery Point
      Objective** (max acceptable data loss — e.g. "≤ 5 min with PITR, or ≤ 24 h
      with nightly backups only") and **Recovery Time Objective** (how long a
      restore takes) so a decision to restore during the pilot is made against
      known numbers, not guesses.
- [ ] **Who can restore.** Name the person(s) with Supabase project access
      authorized to perform a restore, and confirm they know the steps. A
      restore is destructive/global — it is a supervisor decision, not a
      practitioner one.
- [ ] **Restore drill (recommended).** Before real client data is trusted,
      perform one non-production restore drill (restore to a scratch project or
      branch) to confirm the backup is usable and to measure the real RTO. Do
      **not** run a restore against production data as a drill.

## 7. Support / escalation expectations

- Supervised only: a supervisor is available during pilot sessions for booking,
  charting, and Record Keeping questions, and owns any restore decision (§6).
- Known supervised workarounds: returning-client rebooking via calendar
  quick-book; unfiltered Procedure Records print shows the most recent 30 with a
  "filter by client for a complete log" notice (use the per-client filter or the
  ZIP export for a complete artifact).
- Rollback of a bad deploy: revert the merge on the base branch and redeploy
  production (docs/11 / docs/14); the production migration max stays where it is
  (**0112** as of 2026-07-08) unless a reviewed migration is applied via the
  [migration-first process](./runbooks/migration-first-process.md). Reverting code
  does not roll back an additive migration (old code runs fine against it).
