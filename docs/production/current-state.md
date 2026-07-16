# Hone — Current Production State

**Canonical single source of truth for "what Hone is today."** When this doc and any
other doc disagree, this doc + the live verifier win. Re-verify against
`supabase migration list --linked` and `node scripts/verify-production.mjs` before
trusting any number here.

> **This document pins the last runtime-bearing baseline, not its own documentation
> commit.** GitHub is authoritative for the current branch HEAD; Vercel is authoritative
> for the latest deployment record. A newer branch HEAD or deployment produced by a
> documentation-only change does not, by itself, change what Hone *does*.

- **Last reconciled:** 2026-07-15
- **Production branch:** `claude/build-hone-saas-hOex7`
- **Last runtime-bearing production HEAD:** `f664f0fd41edb398c46b81af872c5a4d53d839e1` — PR #426 merge. Later documentation-only commits (e.g. this phase-register reconciliation) may exist **above** this SHA **without changing application runtime behaviour**.
- **Last runtime-bearing Vercel production deployment:** `5h3RGRmWEjrMUjg72N4ox73wGPoG` — status **success**. A later documentation-only branch deployment does **not** indicate a new runtime capability or activation.
- **Current repository / production-branch HEAD:** query GitHub directly (e.g. `gh api repos/SaiSamyukthVemuri/Hone/branches/claude/build-hone-saas-hOex7 --jq .commit.sha`); it is **not** pinned inside this self-modifying document.
- **Production migration max:** **0132** (hosted == repo == `0132`). **Google Calendar B2.3-c1 event-link transitions (`0132_google_calendar_event_link_transitions.sql`, SHA-256 `0516776e…`) was hosted-applied migration-first on 2026-07-16.** At the pre-merge validation point migration 0132 had been hosted-applied and **PR #428 remained unmerged**; on merge, the c1 event-operation code becomes **deployed dormant** and **no route, cron, worker, or activation is introduced**. Read-only post-apply verify PASSED: `calendar_event_link_transition` present (SECURITY DEFINER, service-role-only EXECUTE, anon/authenticated/public denied, closed action set, outbox never transitioned, bind/update reject missing ETags), the placeholder-aware `enqueue_calendar_outbound` / `_on_delete` / `repair_enqueue_orphan_link_delete` in place; **worker_enabled=false, all sync flags OFF, `calendar_sync_outbox` + `calendar_event_links` = 0 rows, 0 real Google events, Willow unconnected, appointments/connections/credentials unmodified, 0 unresolved calendar ops-alerts.** B2.3-c1 also ships the dormant event-operation layer (serializer, deterministic 57-char event id, stale fence, create/update/delete + provider reconciliation, the execution-time connection-revalidation handler that dispatches on the authoritative `token.connection`, transactional link-transition RPC) — imported only by server-only worker modules, **no route, no cron, no worker**. **B2.3-c2 (authenticated worker-drain route) is the next separately-authorized phase.** **Google Calendar migration tail since 0124:** **0125 = B2.3-a** intent-gated enqueue+claim boundary (PR #412); **0131 = B2.4** dual-destination + destination-derived scope contract (PR #424, operator-validated dormant 2026-07-14); **B2.3-b** reconciliation sweep + heartbeat + dead-row alerting + authenticated `/api/cron/calendar-reconcile` route (**PR #426, merge `f664f0f`) added NO migration** — deployed **dormant**, route CRON_SECRET-protected + **not** cron-registered. (0126–0130 are non-calendar migrations.) Every Google Calendar phase is **additive + DORMANT**: no worker; the enqueue path + triggers are **deployed (0125) but produce no work** in production (no intent-eligible studio, all outbound flags OFF); **no Google appointment-event create/update/delete has occurred** — though **B2.4 did use Google OAuth + Calendar provisioning** to create Sam's empty "Hone Appointments" calendar (exact `calendar.app.created` scope granted; grants app.created=1/events.owned=0/broad `calendar.events`=0); all sync flags OFF; `calendar_sync_outbox` + `calendar_event_links` empty (0 rows); Willow not connected. See the *Google Calendar — sync status* section below. **0124 = Google Calendar — Phase B1: dormant outbound-sync schema & queue foundation** (`calendar_event_links` + `calendar_sync_outbox` + service-role-only `claim_calendar_sync_op` / `record_calendar_sync_result` RPCs) — additive + **DORMANT**. **0123 = Willow P1-B (remove an incorrectly-recorded treatment area): an atomic aggregate soft-delete SECURITY DEFINER RPC `soft_delete_session_area`** — `search_path` pinned (`pg_catalog, pg_temp`); EXECUTE **authenticated-only** (anon/public revoked); studio derived from the row via `is_studio_member` + the active practitioner from `auth.uid()`; **rejects finalized/void**; requires a ≥10-char reason; soft-deletes the block + its block-scoped electrolysis passes + block-scoped images in **one transaction** with a `session_audit` `area_removed` event; **NO hard delete**. Additive (one function). Post-apply read-only verify: remote max 0123, RPC SECURITY DEFINER + hardened search_path + authenticated-only, and the RPC was **NOT** called against real data (**0** `area_removed` audit events) so production data is unchanged (active session_blocks **38**, electrolysis_entries **23**, treatment_images **3**), 0 ops alerts, Stripe 15 PASS. **PR #406 (the P1-B CODE) is MERGED + deployed** (merge `306a473`). **0121/0122 = Google Calendar — Phase A (connection & OAuth foundation), additive + DORMANT** (applied 2026-07-11): post-apply read-only verify confirmed existing data preserved (appointments **75**, timed_blocks **9**, blockouts **1**, recurring-break occurrences **3**, calendar reservations **67** — all unchanged), all **four** Google studio flags default **false** with **0** studios enabled (Willow false), the 3 new tables created **empty** (`calendar_connections` = member-SELECT-only metadata + service-role writes; `calendar_connection_secrets` + `google_oauth_states` = RLS-on + **no** browser policy + explicit REVOKE, so ciphertext/state are unreadable by any browser role), one-connection-per-practitioner + at-most-one-studio-calendar-owner constraints present, same-studio composite FKs, `token_expires_at` in metadata only (**not** in secrets), `encryption_key_version` present, and NO event-sync/webhook/booking-availability schema. **PR #404 (the Phase-A CODE) is MERGED + deployed** (merge `1bfdf7b`). Phase A was subsequently **production-exercised on Sam's controlled studio only**: one connection was created (`calendar_connections` = 1, `calendar_connection_secrets` = 1, one OAuth state consumed) with least-privilege Phase-A scopes (**no** event scope; encrypted token peer-unreadable). `google_calendar_connection_enabled` is ON **for Sam's studio only**; all three sync flags (outbound/inbound/two-way) are OFF for every studio; **Willow not connected**. See the *Google Calendar — sync status* section below. The `reschedule_appointment` RPC is unchanged (hash-only). Clinical-Record detail (0120, applied migration-first 2026-07-11) follows. Purely additive + inert: post-apply verify confirmed existing data preserved (1 snapshot = the synthetic v1, now labeled `version_type='original'`; synthetic record still v1/finalized; 59 legacy unchanged; **0 corrections/amendments/audit events created**), `clinical_corrections_enabled=false` for all studios (default OFF; separate from Phase 1's flag), lineage columns + CHECK present, `clinical_record_amendments` + `clinical_audit_events` both RLS-on + append-only + RESTRICT FKs, the finalized-write guard extended with ONE narrow session-scoped transaction-local correction permit (no service-role/`auth.uid()`/role bypass), 3 SECURITY DEFINER RPCs (authenticated-only; appliers revoked), Stripe 15 PASS, 0 ops alerts. **PR #400 (the Phase-2 CODE) is MERGED + deployed** (merge `6de3b5d`, 2026-07-11) — the Phase-2 corrections/amendments backend is LIVE but **DORMANT**: `clinical_corrections_enabled` is OFF for all studios, so the Amend/Correct/History UI renders nowhere and no correction/amendment path is reachable; **no production correction or amendment has ever been created** (verified 0 amendments / 0 clinical audit events). See the *Clinical Record status* section below for the full designed/deployed/enabled/exercised/approved breakdown (incl. the PR #402 reliability/observability work). 0119 was applied migration-first 2026-07-10. The migration is purely additive + inert: read-only post-apply verify confirmed all **59** pre-existing sessions unchanged (`record_origin='legacy'`, `record_status='draft'`, `legacy_classification`/`finalized_at`/`finalized_by`/`current_snapshot_id` all NULL), **0** `clinical_record_snapshots` rows, `clinical_finalization_enabled=false` for **all** studios, all 7 guard triggers enabled, snapshot/attribution FKs RESTRICT/NO-ACTION, `finalize_session` SECURITY DEFINER (native+draft+flag-gated), Stripe gates 15 PASS, 0 unresolved ops alerts. **PR #399 (the Phase-1 CODE) is MERGED + deployed** (merge `d84180f`, 2026-07-10) and was **production-exercised end-to-end** on Sam's controlled test studio: one synthetic native session finalized via the real production UI → immutable v1 snapshot (deterministic hash; all finalized-lock attempts rejected even via service-role); the flag was then disabled and the record stayed locked. `clinical_finalization_enabled` is now OFF for all studios; 1 synthetic finalized session + 1 snapshot preserved. 0118 added a `BEFORE UPDATE` trigger making submitted/reviewed `client_intake_forms` answers immutable to authenticated members (service-role exempt), closing a same-tenant clinical-record integrity defect; draft/review/reissue flows unaffected; trigger-only, no code change. 0117 tightened the `session_audit` INSERT policy to bind a new audit row's session to the caller's studio, closing a confirmed cross-tenant integrity-write (Studio A → Studio B session audit). 0116 dropped the raw `practitioners.calendar_feed_token` column (calendar-feed credential is hash-only at rest; `calendar_feed_token_hash` retained); existing subscriptions preserved, no forced reconnect.
- **Stripe gates:** 15 PASS (`node scripts/check-stripe-gates.mjs`).
- **verify-production:** 11 PASS · 0 FAIL · 1 INCOMPLETE (the INCOMPLETE is the reminder-scheduler heartbeat, which reports INCOMPLETE only because `UPSTASH_REDIS_REST_URL/TOKEN` are unset in the *local* env used to run the script — it is not a production failure).
- **Hosting:** Vercel production (Node 24), deploys from the production branch HEAD.
- **Live customer:** Willow (Chloe) — one live studio with real clients.

See also: [migration-ledger.md](./migration-ledger.md) · [release-changelog.md](./release-changelog.md) ·
[../runbooks/migration-first-process.md](../runbooks/migration-first-process.md).

---

## Clinical Record — finalization & corrections status (as of 2026-07-11)

Read the columns precisely — **designed ≠ deployed ≠ enabled ≠ production-exercised ≠ approved for customer use.** All three rows below sit behind feature flags that are **OFF for every studio**; the feature is dormant and safe.

| Capability | Designed | Deployed | Enabled (any studio) | Production-exercised | Approved for customer use |
|---|---|---|---|---|---|
| **Phase 1 — finalization boundary** (migration 0119, PR #399) | yes | yes | no — `clinical_finalization_enabled` OFF for all studios | **yes** — 1 synthetic native session finalized via the real UI on Sam's controlled studio; immutable v1 snapshot; flag then disabled, record stayed locked | no (not enabled for Willow) |
| **Phase 2 — corrections/amendments backend** (migration 0120, PR #400) | yes | yes | no — `clinical_corrections_enabled` OFF for all studios | no | no — **customer workflow PARKED** |
| **Amendment/correction-path reliability & observability** (no migration, PR #402) | yes | **yes** (merge `e84ff94`, 2026-07-11) | no | **no** (not exercised in production after #402) | no |

**Phase 2 customer-facing workflow is PARKED.** The deployed backend — immutable snapshots, version lineage, `clinical_audit_events`, append-only + RLS + the narrow session-scoped correction permit — is **preserved and must not be weakened**. But the current generic 3-field correction UX is unsuitable for practitioner rollout, so the customer-facing workflow is parked: a full-chart correction workspace and a future correction allow-list expansion are **not in the active queue** (note: the "migration 0121" placeholder once used for that allow-list is obsolete — 0121 is now Google Calendar Phase A; a clinical allow-list would land at 0125+). Both flags remain OFF; no production correction or amendment has been created; the correction/amendment UI is **not approved for Willow**.

**PR #402 (amendment/correction-path reliability & observability, merge `e84ff94`, deployed 2026-07-11) added observability + failure handling ONLY — no application-schema change, no migration, no flag change, no production data change.** What it added:
- PHI-safe per-request correlation/request ids + staged server-action diagnostics (ids logged only via a one-way hash; never reason/body/clinical text).
- Explicit discriminated success/failure result contracts `{ ok, errorType, requestId }`.
- Amend reports success only **after** verifying the row persisted (an RPC that "succeeds" but leaves no row is treated as an inconsistency, not a success).
- A prominent, accessible **"Nothing was saved"** error panel with a reference id; fields retained on failure; the form clears only after confirmed success; duplicate-submit protection.
- Full real-path test coverage: browser E2E (UI → server action → PostgREST RPC → DB → history), server-action unit tests, a **PostgREST named-argument** integration test (the exact `supabase.rpc(fn, { named })` call shape — a CI gap the positional DB test left open; it PASSES), and DB integration. Post-merge CI all green; production HTTP 200.

**Historic-cause honesty (do NOT claim a confirmed root cause).** An earlier amendment attempted through the production UI did not persist (DB stayed at 0 amendments / 0 clinical audit events), and **its exact historic runtime cause could not be proven — no diagnostic trace existed at the time.** Accurate conclusion: the previous failure **remained unreproduced**; the complete amendment path now passes through browser E2E, server-action tests, PostgREST named-argument integration, and DB integration; observability and user-facing failure handling are **materially improved**; any recurrence will now surface a prominent error to the practitioner and a correlatable, PHI-safe request id in the server log.

---

## Google Calendar — sync status (as of 2026-07-15)

Read the columns precisely — **designed ≠ deployed ≠ enabled ≠ production-exercised ≠ approved for customer use.** No synchronization is running: every Google *sync* flag is OFF for every studio, and the outbound infrastructure is dormant.

**Deployed dormant: Phase A, B1 (0124), B2.3-a (0125), B2.4 (0131), and B2.3-b (reconciliation sweep + heartbeat + dead-row alerting + `/api/cron/calendar-reconcile`, PR #426, merge `f664f0f`, migration-free).** The reconciliation route is live + **CRON_SECRET-protected + NOT scheduled** (no `vercel.json` cron), and actuates only within intent-eligible studios (production has **none**). **No Google event write, drain worker, inbound busy import, or availability change exists yet** — that outbound event-execution work is **B2.3-c** (design intent, not built; see the architecture doc §3f). Sam's controlled Phase A connection + dedicated destination remain present; **all synchronization flags remain OFF**; **Willow is not connected.**

| Capability | Designed | Deployed | Enabled (any studio) | Production-exercised | Approved for Willow |
|---|---|---|---|---|---|
| **Phase A — connection & OAuth foundation** (0121/0122, PR #404) | yes | yes | connection flag ON for Sam's controlled studio only (all sync flags OFF) | **yes** — OAuth connection exercised once on Sam (least-privilege, no event scope) | no |
| **B1 — dormant outbound-sync schema & queue** (0124, PR #407) | yes | yes | no — all sync flags OFF | no — outbox + links empty (0 rows) | no |
| **B2.3-a — intent-gated enqueue + claim boundary** (0125, PR #412) | yes | yes | no — all sync flags OFF; worker OFF | no — no intent-eligible studio | no |
| **B2.4 — dual-destination + destination-derived scope** (0131, PR #424) | yes | yes | destination validated on Sam (dedicated app-created, dormant) | **yes** — one empty "Hone Appointments" calendar created; grants app.created=1/events.owned=0/broad=0 | no |
| **B2.3-b — reconciliation sweep + heartbeat + route** (PR #426, no migration) | yes | yes | no — route unscheduled; no intent-eligible studio | no — no outbox/link produced in production | no |
| **B2.3-c — outbound Google event execution (worker)** | yes (design) | **no — not built** | no | no | no |
| Inbound busy / two-way edits | yes (design) | **no — not built** | no | no | no |

**Deployed dormant (queue + reconciliation):** `calendar_event_links` + `calendar_sync_outbox` + service-role-only claim/result RPCs (0124); the intent-gated enqueue trigger + repair primitives + queue-health view (0125); the dual-destination scope contract (0131); and the reconciliation sweep + heartbeat + dead-row alerting + `/api/cron/calendar-reconcile` route (PR #426). **No appointment-event transport ships** — no worker calls Google, no `event.create`/`update`/`delete` runs, and the **appointment-event** scope drives no writes. (Separately, B2.4's **`calendar.app.created`** provisioning scope **was** exercised once to create Sam's empty destination calendar — that is calendar provisioning, not appointment-event CRUD.) The reconciliation route only orchestrates the existing DB repair primitives and, in production, finds **zero** intent-eligible studios (all outbound flags OFF), so it produces no outbox/link work.

**Security posture (recorded):**
- `calendar_sync_outbox` has **no anon/authenticated direct grants** (RLS on + REVOKE ALL + no policy) — invisible to the browser.
- `calendar_event_links` has **no anon/authenticated write path** (member SELECT only; writes service-role only).
- `claim_calendar_sync_op` / `record_calendar_sync_result` are executable **only by `service_role` / `postgres`** (`SECURITY DEFINER`, pinned `search_path`) — no PostgREST browser path can claim or mutate a sync job.
- **No drain worker references the outbox; no event-sync behavior is enabled.** The B2.3-a (0125) enqueue **triggers are deployed** but **enqueue no jobs in production** because every studio's outbound flag is OFF (no intent-eligible studio); the reconciliation route (PR #426) is deployed + `CRON_SECRET`-guarded + unscheduled and produces no work.

**Existing production data is unchanged by the calendar phases (0124 → 0131 + B2.3-b):** every calendar migration since 0124 is additive/dormant and B2.3-b added no migration. Booking data unchanged (last verified at 0124: appointments **75**, timed blocks **9**, calendar reservations **67**); no appointment/booking behavior changed; **no Google *event* data exists** (B2.4 validation created one empty "Hone Appointments" destination calendar on Sam's controlled account — **zero events**); no sync job was created; no availability logic changed; the reconciliation route wrote no outbox/link rows (zero intent-eligible studios). Full architecture: [../integrations/google-calendar-sync.md](../integrations/google-calendar-sync.md).

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

**Shipped since 0113:** 0114 (#391, audited soft-delete "Remove pass"), 0115 (#393, entry hard-delete hardening), 0116 (#395, calendar-feed credential hash-only), 0117 (#397, `session_audit` cross-tenant INSERT hardening), 0118 (#398, intake terminal-state immutability), **0119 (#399, Clinical Record Phase 1 finalization)**, **0120 (#400, Clinical Record Phase 2 corrections/amendments backend)**, **0121/0122 (#404, Google Calendar Phase A connection/OAuth foundation — dormant)**, **0123 (#406, Willow P1-B treatment-area removal RPC)**, **0124 (#407, Google Calendar Phase B1 dormant outbound-sync schema/queue)**, **0125 (#412, Google Calendar B2.3-a intent-gated enqueue + claim boundary — dormant)**, 0126/0127 (Willow clinical notes + RLS fix, live), 0128/0129 (Willow multi-area + laterality), 0130 (revoke anon calendar RPC), **0131 (#424, Google Calendar B2.4 dual-destination + destination-derived scope — dormant)**; calendar code-only **#426 (Google Calendar B2.3-b reconciliation sweep + heartbeat + `/api/cron/calendar-reconcile` route — no migration, unscheduled, dormant)**; code-only **#401** (mobile calendar: exact-date nav, Today visibility, date strip, Book/Block chooser + block time — Chloe's mobile fixes, live), **#402** (amendment/correction-path reliability & observability — see the *Clinical Record status* section), and **#405** (Willow P1-A signed-consent visibility — display-only). Details per PR in [release-changelog.md](./release-changelog.md).

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
0124; `treatment-images` bucket private + RLS policies + integrity trigger; intake link +
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
