# Hone — Current Production State

**Canonical single source of truth for "what Hone is today."** When this doc and any
other doc disagree, this doc + the live verifier win. Re-verify against
`supabase migration list --linked` and `node scripts/verify-production.mjs` before
trusting any number here.

- **Last reconciled:** 2026-07-10
- **Production branch:** `claude/build-hone-saas-hOex7`
- **Production HEAD:** `b31fd3993047c36d8e11d63e737fbaf7b6fd0914`
- **Production migration max:** **0118** (`0118_intake_terminal_immutability.sql`) — remote applied max. **Repo max is 0119** (`0119_clinical_record_finalization_phase1.sql`, Clinical Record — Phase 1 finalization boundary), which is **NOT yet applied to the hosted project** (PR open, awaiting approval for a controlled migration-first apply). Until that approved apply, remote max stays 0118 and `verify-production.mjs` will (correctly) report a repo(0119)-vs-remote(0118) migration-max mismatch — that is the signal to apply 0119, not a failure. 0119 is purely additive + inert (every session defaults to `draft`; the studio `clinical_finalization_enabled` flag is default OFF), so it is migration-first safe. 0118 added a `BEFORE UPDATE` trigger making submitted/reviewed `client_intake_forms` answers immutable to authenticated members (service-role exempt), closing a same-tenant clinical-record integrity defect; draft/review/reissue flows unaffected; trigger-only, no code change. 0117 tightened the `session_audit` INSERT policy to bind a new audit row's session to the caller's studio, closing a confirmed cross-tenant integrity-write (Studio A → Studio B session audit). 0116 dropped the raw `practitioners.calendar_feed_token` column (calendar-feed credential is hash-only at rest; `calendar_feed_token_hash` retained); existing subscriptions preserved, no forced reconnect.
- **Stripe gates:** 15 PASS (`node scripts/check-stripe-gates.mjs`).
- **verify-production:** 11 PASS · 0 FAIL · 1 INCOMPLETE (the INCOMPLETE is the reminder-scheduler heartbeat, which reports INCOMPLETE only because `UPSTASH_REDIS_REST_URL/TOKEN` are unset in the *local* env used to run the script — it is not a production failure).
- **Hosting:** Vercel production (Node 24), deploys from the production branch HEAD.
- **Live customer:** Willow (Chloe) — one live studio with real clients.

See also: [migration-ledger.md](./migration-ledger.md) · [release-changelog.md](./release-changelog.md) ·
[../runbooks/migration-first-process.md](../runbooks/migration-first-process.md).

---

## Deployed major capabilities

- **Auth / tenancy:** invite-only practitioner auth (Supabase); studio resolved server-side
  (`getCurrentPractitionerWithStudio`); owner/member gating enforced server-side; RLS
  (`is_studio_member`) on all tenant tables. **Multi-studio users are supported** (PR #378/#379):
  0 or 2+ active memberships no longer 500; a user with 2+ active studios chooses one via a
  studio switcher, persisted in an httpOnly `hone_selected_studio` cookie that is re-validated
  against active memberships every request (never auto-picked, never cross-studio).
- **Public booking:** service selection, availability scan, cancel/reschedule/manage via
  hashed tokens, intake gating, compact marketing consent, confirmation/reminder emails.
- **Practitioner calendar:** **mobile = a single-day vertical timeline** (PR #380 — replaced
  the sideways-scrollable week grid; date strip, prev/next day, tap-to-book, now-line, floating
  +); **desktop = week/month grid** with a Google/Apple-style toolbar (Today / ‹ › / date range /
  Week·Month, PR #382), one clean vertical scroll (PR #383), and an **in-context appointment
  preview drawer** (PR #381 — click an appointment for a read-only summary + "Open full details"
  deep link, instead of navigating away). Exact clicked-time booking, owner-only blocked-time
  editing, appointment completion, studio 12h/24h preference.
- **Client records:** profile, intake, versioned consent + signatures, treatment notes,
  imported treatment memory (read-model), record-keeping + audit.
- **Charting / treatment memory:** session blocks, observation chips, probe-lot suggestion,
  treatment areas, Before Today / Treatment Intelligence surfaces. **Charting hardening (PR
  #384–#386, all app-layer, no migration):** a non-blocking aftercare prompt at "Done charting";
  server-side treatment-area canonical validation (flat `AREAS` incl. "Full face" + explicit
  "Other" custom); probe-lot studio-ownership + UUID verification on write.
- **Photos:** private `treatment-images` bucket, service-role signed URLs, per-file EXIF
  stripping, tenant-scoped paths, multi-file upload.
- **Client portal:** passwordless magic-link login, portal tasks, practitioner send/copy
  link, portal CTA in appointment emails, append-only access-event log.
- **Postcare:** studio templates, manual send, opt-in auto-send on completion.
- **Payments (Stripe):** **supervised live owner-run session payments are live for approved
  studios** (Willow + Sam's controlled studio) — live Stripe Connect onboarding, live
  charges, live refunds, and live webhook processing are all proven; live/test isolation for
  cards + payment attempts is live; mode-aware dashboard/admin/payment copy is live. Card-on-file,
  receipts, and refunds work in both modes. **Broad self-serve live payments are not ready**
  (a new studio starts in test mode and is enabled per-studio only after supervised
  onboarding + approval). See "Still OFF / held" below for what remains disabled.
- **Messaging:** transactional email (Resend), reminder + postcare + portal emails; SMS
  opt-in with STOP/HELP (pilot scale).
- **Marketing/tracking:** per-studio marketing consent + encrypted provider token storage;
  provider-agnostic conversion service with a Meta CAPI adapter (inert per studio until a
  token is configured).
- **Admin/ops:** `/admin` surfaces (service-role), ops alerts, verifier + gate scripts,
  cron auth, migration-max tripwire. **Admin Action Audit Log (PR #374, migration 0113):**
  append-only `admin_action_events` records sensitive operator actions (studio creation,
  ops-alert resolution, demo follow-up) — who/what/which-studio/when/outcome, privacy-safe
  metadata only; viewable at **`/admin/audit`** (linked from the admin dashboard, PR #376).

---

## Recently shipped (0108 → 0113 and the surrounding UI wave)

| Area | Migration | Live status |
|---|---|---|
| Treatment observation chips | **0108** | Live. |
| SMS client-facing 12-hour time format | none (code) | Live. |
| Studio time-format preference (12h/24h) | **0109** | Live (default 12h). |
| Postcare automation (auto-send on completion) | **0110** | Live but **default OFF (`manual`)** — opt-in per studio. |
| Calendar/booking usability (drawer override + exact time, internal scroll + mobile sticky rail, owner-only blocked-time editing, calendar 12h) | none (code) | Live. |
| Client portal: practitioner send / copy login URL + resend rate limits | none (code) | Live. |
| Client portal: CTA in confirmation + reminder emails; login-page copy fix | none (code) | Live. |
| Multiple photo upload | none (code) | Live. |
| Compact marketing-consent UI on public booking | none (code) | Live. |
| Client portal access events + practitioner status card | **0111** | Live. |
| Public booking previous/next availability navigation | none (code) | Live. |
| Public booking horizon 1–12 months | **0112** | Live (default 3 months; existing studios unchanged). |
| Admin Action Audit Log (`admin_action_events`, `/admin/audit`) | **0113** | Live (append-only, service-role-only, privacy-safe). |
| Admin audit log dashboard discoverability | none (code) | Live (PR #376). |
| Postcare auto-send setting discoverability (nav label + stale-copy fix) | none (code) | Live (PR #375; setting unchanged, still default `manual`). |
| Portal verify-page expiry copy fix (30 min → 1 hour) | none (code) | Live (PR #377; matches the real 60-min TTL). |
| Multi-studio-user robustness (never 500 on 0/2+ memberships) | none (code) | Live (PR #378). |
| Multi-studio switcher + selected-studio httpOnly cookie | none (code) | Live (PR #379). |
| Mobile single-day calendar timeline | none (code) | Live (PR #380). |
| Desktop in-context appointment preview | none (code) | Live (PR #381). |
| Desktop Google-style calendar toolbar | none (code) | Live (PR #382). |
| Desktop calendar scroll cleanup (one clean vertical scroll) | none (code) | Live (PR #383). |
| Charting: non-blocking aftercare prompt at "Done charting" | none (code) | Live (PR #384; emergency-safe, never blocks). |
| Charting: server-side treatment-area canonical validation | none (code) | Live (PR #385; flat `AREAS` + explicit custom; legacy preserved). |
| Charting: probe-lot studio-ownership verification on write | none (code) | Live (PR #386; free-text/manual lot preserved). |

Details per PR in [release-changelog.md](./release-changelog.md).

---

## Live but default OFF / manual (say so honestly)

- **Postcare auto-send (0110):** shipped, but `studios.postcare_delivery_mode` defaults to
  `manual`. An owner must explicitly switch to `auto_on_complete`, and auto-send is skipped
  if `RESEND_API_KEY` is unset or postcare text is empty (fail-soft — never blocks
  appointment completion). Before enabling for a studio: confirm Resend key + aftercare text.
- **Marketing/tracking (0106/0107):** the framework is live but **inert per studio** — no
  data is sent until an owner configures a provider token. The Meta CAPI adapter *can* POST
  to the real Graph API once a token exists, so treat token configuration as an enablement
  step, not a default.
- **SMS:** live at **pilot scale** only; env-gated on `TWILIO_*`. Broad-SaaS SMS
  (A2P/10DLC registration, per-studio vs shared sender, rate-limiting) is not built.

## Payments — what IS live vs what is still OFF / held

**Live (for approved studios, supervised):** owner-run **session payments** in live mode —
live Stripe Connect onboarding, live charges, live refunds, live webhook processing, all
proven on Willow + Sam's controlled studio. Live/test isolation for cards and payment
attempts is live; mode-aware dashboard/admin/payment copy is live. Stripe gates remain 15 PASS.

**Still OFF / held (do not enable without a dedicated PR + approval):**
- **Broad self-serve live-payment rollout** — not complete. Live is enabled per-studio only
  after supervised onboarding + approval; a new studio starts in test mode.
- **Public booking card collection** — OFF (not wired; a Stripe gate proves the
  `set_studio_require_card_on_file` path has zero runtime occurrences).
- **Deposits / packages / partial payments** — not built.
- **Live manual no-show / late-cancel fees** — on a **server-side hard hold** in live mode
  (`lib/billing/live-charge-reason-allowlist.ts`); only `session_payment` charges live. Test
  mode is unaffected.
- **Public card collection at booking:** not wired (the `set_studio_require_card_on_file`
  path has zero runtime occurrences — a Stripe gate proves this).
- **Deposits / packages / partial payments:** not built.

---

## Known verifier state

`node scripts/verify-production.mjs` → **11 PASS, 0 FAIL, 1 INCOMPLETE**. The verifier is a
read-only production health check (not a pre-live gate). It confirms: remote migration max =
0113; `treatment-images` bucket private + RLS policies + integrity trigger; intake link +
reminder columns/indexes/RPC branches; RLS on 12/12 critical tables; 0 unresolved critical
payment ops alerts; Stripe gates pass. The lone INCOMPLETE is the reminder-scheduler
heartbeat (needs Upstash env to check; a standing local-run limitation, not a prod fault).

## Known risks (updated 2026-07-09 after the #374–#386 wave)

**Resolved since the 2026-07-08 readiness audit:**
- ~~Multi-studio practitioner not supported~~ — **RESOLVED** (PR #378 no-500; PR #379 switcher).
- ~~Portal verify-page copy says "30 minutes"~~ — **RESOLVED** (PR #377; now "1 hour" = real TTL).
- ~~No admin-action audit~~ — **RESOLVED** (PR #374, migration 0113; `/admin/audit`).
- ~~Charting: free-text treatment area / aftercare not save-gated / probe-lot unverified~~ —
  **RESOLVED for session blocks** (PR #384 aftercare prompt, #385 area canonical validation,
  #386 probe-lot studio verification). *Remaining:* treatment-plans multi-area validation +
  legacy `addElectrolysisEntryAction` area path (see Optional/deferred).

**Still open:**
- **Rate limiters fail OPEN** — if Upstash is down/unset, portal + booking rate limits bypass.
- **DB-level charting constraints deferred** — the new area/probe validation is app-layer only
  (a hard DB whitelist / composite FK would reject legacy rows and needs a migration with
  grandfathering; intentionally not built).
- **Observation-chip vocabulary is a placeholder** — awaiting the real list before it's finalized.
- **Docs beyond this set may be stale** — `docs/13` / `docs/14` are large historical per-PR
  logs, not maintained as current-state. Trust this doc + the verifier, not those.

## Optional / deferred (not a commitment)

The 2026-07-08 audit items (docs repair, verify copy, admin audit log, multi-studio robustness,
charting hardening) are **shipped**. Remaining optional work, none started:
- **Charting:** treatment-plans multi-area canonical validation (PR 2b, app-layer); legacy
  electrolysis-entry area path; real observation-chip vocabulary; DB-level constraints (needs migration).
- **Calendar:** desktop Day view (PR D); agenda/list view (PR E); mobile bottom-sheets /
  swipe-to-change-day / mobile appointment preview; member-own blocked-time editing.
- **Multi-studio:** cross-device selection; a dedicated `/switch-studio` route.
- **Later:** referral/conversion analytics; broad SaaS SMS hardening (A2P/10DLC, sender strategy).
