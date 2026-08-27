# Hone — Capability Register

**Detailed per-capability status matrix.** This is the evidence layer behind
[current-state.md](./current-state.md). Where the two disagree, re-verify both against
production; neither document is evidence for the other.

- **Reconciled:** 2026-08-27
- **Runtime-bearing baseline:** the application HEAD recorded in
  [current-state.md](./current-state.md) *Reconciliation header* — **the single authority for
  that SHA, which is deliberately not copied here.** At this reconciliation the branch HEAD and
  the runtime-bearing HEAD are the **same commit**, which is unusual enough to state rather than
  leave implied. *(⚠️ **Corrected 2026-08-27.** This bullet used to name the PR and its runtime
  file count — "PR #644, TRUTH-01A, which changes eight runtime files" — and went stale across
  two production moves while the SHA beside it was correctly referenced rather than copied. The
  **identifier** was not the only thing that could rot: any restated particular can. Only the
  *fact of coincidence* is safe to repeat, because it does not name a commit. Which PR and how
  many files live in [current-state.md](./current-state.md) alone.)*
- **What this pass measured:** it re-derived every status below from the repository and the Git
  graph and **re-measured nothing in the production database or at any provider.** Counts
  carrying a 2026-08-23 stamp are **dated evidence, not current readings**; see
  [current-state.md](./current-state.md) *What this reconciliation did and did not measure*.
- **Migration state:** **not restated here.** Hosted max is declared once in
  [`migration-state.json`](./migration-state.json); repo max and the next free number are
  derived by `npm run migration:state`; the reconciled position with apply evidence is
  [migration-ledger.md](./migration-ledger.md). This register previously carried its own copy
  of the number and drifted 25 migrations behind the ledger — that copy is gone deliberately.
- **Tenant classification:** [current-state.md](./current-state.md) **§0** is canonical.
  Real-customer activity is **Willow Electrolysis only**; `hone-synthetic-twin` is a sanctioned
  synthetic test tenant whose rows are **never** customer activity. Counts in this register are
  tenant-scoped and carry an as-of stamp.
- **Amended 2026-07-29:** §3 rewritten from *dormant / parked* to **RETIRED** — signed and
  finalized clinical records are not a Hone product capability. Decision record:
  [../decisions/clinical-finalization-retired.md](../decisions/clinical-finalization-retired.md).
- **Amended 2026-07-30: migration `0159` is APPLIED and verified in production.** The retirement is
  now **database-enforced**: both studio flags pinned `false` by validated CHECK constraints,
  `EXECUTE` revoked from every runtime role on all 10 retired functions, `finalized`/`void`
  transitions refused, `INSERT` refused on all three signed ledgers, and the 0120
  `hone.correction_session_id` permit removed. `0158` remains intentionally skipped. ~~**UI/code removal is still pending PR #482's deployment** — the deployed application at
  `058b8bcb…` retains the dead Finalize/Correction components, but they are flag-gated and both flags
  are constrained `false`, so they are unreachable.~~ **CLOSED 2026-07-30, recorded here 2026-08-23.**
  PR #482 merged as `d77d4434` and deployed; `FinalizeSessionCard`, `RecordVersionsPanel`,
  `finalize-actions.ts` and `correction-actions.ts` are **absent from the tree** at the current
  production SHA. The struck text above is preserved as the dated record of what was true on
  2026-07-29; it stopped being true the next day and this register carried it for three weeks
  while [current-state.md](./current-state.md) §3 correctly recorded the removal — a
  contradiction between two canonical documents on a reachability claim. The **one legacy controlled-test artifact** (1
  finalized session + 1 snapshot, non-Willow) is retained unchanged and its hash still re-derives;
  **Willow has 0 non-draft sessions**. **Snapshot v2 remains permanently rejected.**
- **Amended 2026-07-30 (second entry): migration `0160` is APPLIED and verified in production.** The
  same-studio wrong-client / wrong-encounter re-parenting defect is now **database-enforced, deployed
  and production-verified** — see [current-state.md](./current-state.md) §3b. It pins record *identity*
  only (`sessions.client_id`/`studio_id`, `session_blocks.session_id`/`studio_id`,
  `electrolysis_entries.session_id`, `electrolysis_entries.block_id` clearable only to NULL,
  `laser_entries.session_id`); **ordinary charting stays fully editable** and no signed-record
  capability returned. It closed **no** other clinical write risk — L18, L19, L20 and L21 all remain
  open. *(The migration-max sentence that stood here has been removed: see the **Migration state**
  bullet above. It read `0160` while production was at `0185`.)*

Related: [current-state.md](./current-state.md) ·
[known-limitations.md](./known-limitations.md) · [migration-ledger.md](./migration-ledger.md) ·
[release-changelog.md](./release-changelog.md)

---

## Status vocabulary

These dimensions are **independent**. A capability normally holds several at once, and
"deployed" alone means almost nothing about whether anyone has used it.

| Status | Means |
|---|---|
| `Designed` | A reviewed design exists. No claim that code exists. |
| `Implemented` | Code exists in the repository. |
| `Merged` | The code is on the production branch `claude/build-hone-saas-hOex7`. |
| `DB applied` | Its migration is applied to the hosted production database. |
| `Deployed` | It is part of the Vercel production build currently serving `hone.care`. |
| `Enabled` | A runtime gate (studio flag / env / config) actually permits it to run. |
| `Production exercised` | It has actually run against production data at least once, with evidence. |
| `Human accepted` | The operator who asked for it has used it and confirmed it is correct. |
| `Dormant` | Deployed but structurally unable to act (flag off, no worker, no eligible tenant). |
| `Held` | Deliberately blocked by a server-side gate pending approval. |
| `Deferred` | A product decision put it out of scope. Not built, not scheduled. |
| `Retired` | **Terminal.** A product decision permanently removed it as a capability, and the database enforces that it cannot be enabled. Not dormant (nothing to flip), not held (no approval would unblock it), not deferred (it is not coming back). |

**A capability is never described as "live" merely because a table, migration, component,
route or flag exists.** The bar for "Production exercised" is a row, a log line, or a
recorded operation — not the existence of the code path that could produce one.

Notation in the matrix below: **✅ yes** · **—** no / not applicable · **⚠️** qualified,
read the Limitations column.

---

## 1. Charting and treatment memory

| Domain | Capability | Code state | DB state | Deployment | Enablement | Production exercise | Human acceptance | Evidence | Limitations / next gate |
|---|---|---|---|---|---|---|---|---|---|
| Charting | Session blocks, observation chips, treatment areas, Before Today / Treatment Intelligence | Merged | applied (≤0130) | Deployed | Enabled for all studios (no flag) | ✅ **Willow: 96 `session_blocks`, 86 `electrolysis_entries`** *(2026-08-23)*; controlled test 12/6; Synthetic Twin 66/1 — **not customer activity** | ✅ in continuous operator use | production row counts | — |
| Charting | **Phase A — unified "Treatment observations & skin response" box** (PR #479) | Merged | code-only, no migration | Deployed (in `3cabdca`, carried into `96b28d6`) | Enabled for all studios | ⚠️ deployed and reachable; no post-deploy production charting event recorded during verification | **Pending** | `lib/sessions/charting-labels.ts`; `block-setup-form.tsx:1325`; `lib/observation-chips.ts:15` | Chloe on-device acceptance |
| Charting | Legacy `reaction_type` folded into the unified representation | Merged | — | Deployed | Enabled | ⚠️ code path verified; shipped in PR #479 | **Pending** | `lib/observation-chips.ts:221-225` | — |
| Charting | Reaction-driven analytics consume the unified representation | Merged | — | Deployed | Enabled | ⚠️ code path verified; shipped in PR #479 | **Pending** | `lib/dashboard/clients-needing-attention.ts:126` | — |
| Charting | **Galvanic intensity retired** from current writes and ordinary display | Merged | no column drop — data preserved | Deployed | n/a (retired) | ⚠️ write path verified in source; no post-deploy production charting write observed | **Pending** | `block-actions.ts:718,816` ("a RETIRED reading… intentionally NOT emitted") | Historical values are preserved, not deleted. `galvanic_ma` and `galvanic_duration_seconds` remain **active** readings |
| Charting | Exact thermolysis precision — `0.733` displays as `0.733 seconds` | Merged | numeric column since 0071 | Deployed | Enabled | ⚠️ code path verified; no new PicoBlend entry charted post-deploy | **Pending** | `lib/sessions/format-seconds.ts` ("never a lossily rounded 0.73") | Chloe on-device acceptance |
| Charting | Pulse relabeled **"Thermolysis pulse count"**, inside the thermolysis section | Merged | — | Deployed | Enabled | ⚠️ code path verified | **Pending** | `block-setup-form.tsx:832`, `simplified-entry-form.tsx:247` | Chloe on-device acceptance |
| Charting | Larger **Additional notes** field | Merged | — | Deployed | Enabled | ⚠️ code path verified | **Pending** | PR #479 | Chloe on-device acceptance |
| Charting | Conditional numbing notes (0156) | Merged | ✅ 0156 applied | Deployed | Enabled | ⚠️ column exists, no production rows recorded at last check | **Pending** | migration 0156 | Kept only when `numbing_status='used'` |
| Charting | Inventory-backed probe-lot linkage (0155) | Merged | ✅ 0155 applied | Deployed | Enabled | — no production block has a linked inventory item yet | **Pending** | migration 0155 | Pointer-only FK, `ON DELETE SET NULL` |
| Charting | In-form "Copy settings" (same-form prefill, PR #473) | Merged | no migration | Deployed | Enabled | ⚠️ not separately instrumented | **Pending** | PR #473 | Outcomes never copied; galvanic intensity excluded |

## 2. Whole-session copy

| Domain | Capability | Code state | DB state | Deployment | Enablement | Production exercise | Human acceptance | Evidence | Limitations / next gate |
|---|---|---|---|---|---|---|---|---|---|
| Whole-session copy | Editable ephemeral preview ("Copy areas & settings from last session") | Merged (PR #478) | ✅ 0157 applied 2026-07-27T02:01:29Z | Deployed | Enabled — no feature flag | ✅ **PRODUCTION EXERCISED — 24 operations, all at Willow**, 2026-07-28 → 2026-08-23 | **Pending** | `session_copy_operations` = **24 rows** *(2026-08-23)* | Exercise is not acceptance. The original deployment verification did perform zero copy operations; that is now history |
| Whole-session copy | Zero writes before the explicit commit | Merged | — | Deployed | Enabled | ⚠️ the surrounding feature is exercised (24 operations), but a *negative* guarantee is not proven by a ledger row — no production evidence isolates an abandoned preview | **Pending** | 24 committed operations; abandoned previews leave nothing to count, by design | Preview is component memory only |
| Whole-session copy | One atomic commit (`copy_session_setup`) | Merged | ✅ function present | Deployed | Enabled | ✅ **invoked 24 times in production**, all at Willow | **Pending** | 24 `session_copy_operations` rows; `pg_proc`: SECURITY DEFINER, `search_path=""` | — |
| Whole-session copy | Source locking + stale-source rejection | Merged | ✅ fingerprint + source-id helpers | Deployed | Enabled | ⚠️ exercised on the accept path (24 commits); **no production rejection was observed or counted** | **Pending** | `_whole_session_copy_fingerprint`, `_whole_session_copy_source_id` | Both helpers are **private** (service_role only). The refusal branch remains unevidenced in production |
| Whole-session copy | Idempotency + provenance ledger | Merged | ✅ `session_copy_operations` | Deployed | Enabled | ✅ **24 rows** *(2026-08-23)*; the ledger is populated and in routine use | **Pending** | `(target_session_id, idempotency_key)` UNIQUE | Retry/double-submit is an at-most-once no-op. No production **duplicate-retry** event was isolated |
| Whole-session copy | Reusable setup only — **minutes and outcomes excluded** | Merged | ✅ enforced in the RPC body | Deployed | Enabled | ✅ enforced on 24 real commits | **Pending** | 0157 RPC body | Clinical outcomes are never copied forward |
| Whole-session copy | **Galvanic intensity forced literal NULL** at the destination | Merged | ✅ enforced in the RPC body | Deployed | Enabled | ✅ enforced on 24 real commits | **Pending** | 0157 RPC body; fingerprint excludes it | Forged-spec-safe: the destination insert does not read the client value |
| Whole-session copy | Commit RPC unreachable from the browser | Merged | ✅ | Deployed | Enabled | n/a | n/a | `copy_session_setup` EXECUTE: anon **false**, authenticated **false**, service_role true | Invoked only by the authenticated server action with a server-derived practitioner id |

## 3. Clinical finalization, corrections and amendments — RETIRED

**Signed / finalized clinical records are RETIRED** by product decision (2026-07-29), enforced in
production by migration **0159**, applied and verified 2026-07-30. This is `Retired`, not `Dormant`
and not `Held`: both studio flags are pinned
`false` by CHECK constraint on **every studio** (re-verified across all six tenants 2026-08-23), so **no role can enable them** — not a studio owner through the
`studios: owners update` policy, not `service_role`. Treatment sessions are ordinary, editable
operational records; practitioners correct mistakes by editing. There is no snapshot v2, and no
document ever promised one. Reasoning, retained legacy artifact and the reintroduction bar:
**[../decisions/clinical-finalization-retired.md](../decisions/clinical-finalization-retired.md)**.

| Domain | Capability | Code state | DB state | Deployment | Enablement | Production exercise | Human acceptance | Evidence | Limitations / next gate |
|---|---|---|---|---|---|---|---|---|---|
| Clinical record | Phase 1 — finalization boundary (0119, PR #399) | **RETIRED** — practitioner-facing Finalize surface removed | 0119 applied; **0159 retires it** (nothing dropped) | Deployed, unreachable | **RETIRED** — `clinical_finalization_enabled` false on **every studio** (all six, 2026-08-23) and **pinned false** by `studios_clinical_finalization_retired`; `EXECUTE` on `finalize_session` revoked from every runtime role; `sessions_guard_retired_finalization` refuses any transition into `finalized`/`void` | ✅ historically **exactly once**, on the controlled non-Willow test studio (2026-07-11T00:42:12Z) | n/a — never offered to Willow | 1 `finalized` session of 76 + 1 `clinical_record_snapshots` row whose `content_hash` **still re-derives to a MATCH**, both on the test studio; Willow has **0** non-draft sessions; 0 `void` | **RETIRED — no next gate.** The one legacy artifact is retained unchanged, deliberately **not deleted and not regenerated** |
| Clinical record | Phase 2 — corrections/amendments backend (0120, PR #400) | **RETIRED** — practitioner-facing signed-Correction surface removed | 0120 applied; **0159 retires it** | Deployed, unreachable | **RETIRED** — `clinical_corrections_enabled` false on all studios and **pinned false** by `studios_clinical_corrections_retired`; `EXECUTE` revoked on `correct_finalized_session` / `amend_finalized_session` / `amend_finalized_session_with_image` / `build_session_snapshot`; `INSERT` refused on all three signed-record ledgers | **❌ never** | n/a | `clinical_record_amendments` = **0 rows**; `clinical_audit_events` = **0 rows** | **RETIRED — no next gate.** Backend preserved and **must not be weakened** — not to allow later enablement, but to keep the legacy evidence immutable, keep the retirement fail-closed, and forbid `authenticated` `TRUNCATE` on the six clinical tables and any write to the three signed-record ledgers (⚠️ **corrected 2026-08-27** — this parenthetical previously read *"ordinary row DML on the five app-written tables is NOT revoked — see known-limitations L18"*, which is **false at `6786b07b`**: migration `0169` revoked `insert, update, delete` from `authenticated` on all six clinical tables in 2026-08-03 and **L18 is CLOSED**) |
| Clinical record | Amendment-path reliability + observability (PR #402) | **RETIRED with Phase 2** | no migration | Deployed, unreachable | **RETIRED** | ❌ | n/a | PR #402 | The path it instrumented cannot execute |
| Clinical record | `clinical_audit_events` — **not** the operational audit trail | **RETIRED with Phase 2** | 0120 applied; 0159 blocks `INSERT` | Deployed, immutable | **RETIRED** | ❌ 0 rows | n/a | its CHECK permits only `operation_type in ('correction','amendment')` | Named "audit" but scoped to signed corrections/amendments only. **Ordinary audit is retained and active**: `session_audit`, `record_keeping_audit_events`, `session_copy_operations`, `admin_action_events`, `client_portal_access_events` |
| Clinical record | Append-only clinical notes (`client_clinical_notes`, 0126/0127) | Merged | ✅ applied | Deployed | Enabled — all studios, no flag | ✅ **Willow: 52 `client_clinical_notes`** *(2026-08-23)*; Synthetic Twin 3; 55 all-tenant | ✅ | production row counts | **Unrelated to 0119/0120 and NOT retired.** A correction/revision here is a **new row** (`supersedes_note_id`), never a signed snapshot |
| Clinical record | Finalized photo **content** immutability | Never built | — | — | — | — | — | 0119 header scope note | **RETIRED, not a later phase** — it was a sub-requirement of a capability Hone no longer offers. The live private-bucket / service-role-only / EXIF / identity-freeze protections are unaffected |

## 4. Probe inventory and record keeping

| Domain | Capability | Code state | DB state | Deployment | Enablement | Production exercise | Human acceptance | Evidence | Limitations / next gate |
|---|---|---|---|---|---|---|---|---|---|
| Record keeping | Sterile items, disinfectants, exposure incidents + audit | Merged | applied (0085–0088, 0096) | Deployed | Enabled | ✅ **Willow: 8 `record_keeping_sterile_items`** *(2026-08-23)*; Synthetic Twin holds 5 more — not customer activity | ✅ | production row count | Exposure-incident history is **owner-only** |
| Record keeping | Overdue-disinfectant "Replace now" alerts (PR #422) | Merged | no migration | Deployed | Enabled | ⚠️ read-time computed; auto-resolves, leaves no row | ⚠️ unverified — no acceptance record | PR #422 | Not separately instrumented by design |
| Record keeping | Probe-lot ↔ inventory durable link (0155) | Merged | ✅ 0155 applied | Deployed | Enabled | — no linked block yet | **Pending** | `session_blocks.probe_inventory_item_id` | Legacy `probe_lots` table stays **dormant** |

## 5. Booking and calendar

| Domain | Capability | Code state | DB state | Deployment | Enablement | Production exercise | Human acceptance | Evidence | Limitations / next gate |
|---|---|---|---|---|---|---|---|---|---|
| Booking | Public booking (service selection, availability scan, intake gating, hashed-token manage/cancel/reschedule) | Merged | applied | Deployed | Enabled | ✅ **215 appointments at Willow** *(2026-08-23)* — all-tenant 382 includes the Synthetic Twin's 141 and is **not** a customer figure | ✅ | production row count | — |
| Booking | Practitioner calendar (mobile single-day timeline; desktop week/month + preview drawer) | Merged | no migration | Deployed | Enabled | ✅ | ✅ | PRs #380–#383 | — |
| Booking | Move appointment — atomic same-record (0133, PRs #431/#434) | Merged | ✅ 0133 applied | Deployed | Enabled | ⚠️ available/custom-time paths deployed; no `moved` audit rows recorded at the last read | **Pending** for owner custom-time | migration 0133 | — |
| Booking | Manual-override booking: actual overlap HARD / buffer SOFT (0152) | Merged | ✅ 0152 applied | Deployed | Enabled | ✅ | ✅ | migration 0152 | Owner override bypasses **buffer only**, never real overlap |
| Booking | Backward-packed slot anchor + source-aware conflicts (PR #467) | Merged | no migration | Deployed | Enabled | ✅ | ✅ | PR #467 | — |
| Booking | Explicit per-service calendar colour (0153) | Merged | ✅ applied | Deployed | Enabled | ✅ | ✅ | migration 0153 | Rose/red reserved for clinical caution |
| Booking | **Direct new-client consultation booking route** | **Deferred** | — | — | — | — | — | Product decision 2026-07-27 | **Deferred by product decision.** Not built, not a blocker, not the next task |

## 6. Client portal and intake

| Domain | Capability | Code state | DB state | Deployment | Enablement | Production exercise | Human acceptance | Evidence | Limitations / next gate |
|---|---|---|---|---|---|---|---|---|---|
| Portal | Magic-link login, portal tasks, append-only access-event log (0111) | Merged | ✅ applied | Deployed | Enabled | ✅ **Willow: 32 `client_portal_sessions`** *(2026-08-23)*; controlled test 6; Synthetic Twin 0 | ✅ | production row count | — |
| Portal | Portal messages + replies | Merged | ✅ applied (0053–0055) | Deployed | Enabled | ✅ **11 `client_portal_messages` all-tenant — 2 at Willow, 9 on the controlled test studio** *(2026-08-23)* | ✅ | production row count | One-way studio→client + client replies |
| Intake | Intake forms + reminders + terminal-state immutability (0118) | Merged | ✅ applied | Deployed | Enabled | ✅ **Willow: 72 `client_intake_forms`** *(2026-08-23)*; controlled test 6; Synthetic Twin 50 — **not customer activity** | ✅ | production row count | Submitted/reviewed answers immutable to members |
| Consent | Versioned consent templates + e-signatures (0057, 0060, 0072) | Merged | ✅ applied | Deployed | Enabled | ✅ **Willow: 49 `client_consent_signatures`** *(2026-08-23)*; controlled test 3; Synthetic Twin 0 — **not customer activity**; 52 all-tenant | ✅ | production row counts | ⚠️ **Draft wording — lawyer review required before relying on enforceability** |

## 7. Payments and Stripe

| Domain | Capability | Code state | DB state | Deployment | Enablement | Production exercise | Human acceptance | Evidence | Limitations / next gate |
|---|---|---|---|---|---|---|---|---|---|
| Payments | Stripe Connect onboarding (live + test, mode-scoped 0103) | Merged | ✅ applied | Deployed | **Enabled for 2 studios** — Willow Electrolysis and the controlled test studio | ✅ both hold `stripe_account_status='enabled'`, charges+payouts true in **live** mode | ✅ | `studio_payment_settings`: 4 rows (live+test per studio) | Per-studio, after supervised onboarding |
| Payments | Owner-run **session payment** charges, live mode | Merged | ✅ applied | Deployed | Enabled for the 2 approved studios | ✅ **Willow: 30 succeeded live charges of 34 attempts, most recent 2026-08-20T22:48:49Z** *(2026-08-23)*; test studio: 2 succeeded live; **Synthetic Twin: no payment rows at all** | ✅ | `payment_charge_attempts` grouped by studio + `stripe_livemode` | This is the strongest production-exercise evidence in the system |
| Payments | Card-on-file (SetupIntent), live/test isolation | Merged | ✅ applied (0058/0059/0104) | Deployed | Enabled | ✅ **Willow: 18 `client_payment_methods`, 18 `client_stripe_customers`** *(2026-08-23)*; controlled test 2 and 3 | ✅ | production row counts | `require_card_on_file` = **false** on every studio |
| Payments | Card add/replace studio notification (0154) | Merged | ✅ applied | Deployed | Enabled | ⚠️ 30 `practitioner_notifications` exist in total; **no per-type count was verified** for `card_added` / `card_replaced` | ⚠️ unverified | migration 0154; dedupe on the mode-scoped SetupIntent | Per-type production exercise is **unknown pending verification** |
| Payments | Receipts (session-payment receipt email) | Merged | — | Deployed | Enabled | ✅ receipt columns populated on charge rows | ✅ | `payment_charge_attempts.receipt_status` | — |
| Payments | Refunds (full-amount) | Merged | ✅ applied | Deployed | Enabled | **❌ zero production refunds** | — | `stripe_refunds` = **0 rows** | Code path proven in earlier controlled testing; no current-baseline production refund exists |
| Payments | Dispute handling | Merged | ✅ applied | Deployed | Enabled | **❌ never** | — | `stripe_disputes` = **0 rows** | **Alert-only** — a `charge.dispute.created` raises a critical ops alert; no automated response |
| Payments | Live manual no-show / late-cancellation fees | Merged | ✅ applied | Deployed | **HELD** — server-side allow-list blocks every live non-`session_payment` reason | test mode only: 2 fee charges on Willow, both `stripe_livemode=false` | — | `lib/billing/live-charge-reason-allowlist.ts`; fee rows are test-mode only | **Held.** Enabling needs a dedicated PR + approval |
| Payments | Public-booking card collection | Merged (path exists) | ✅ applied | Deployed | **OFF — not wired** | ❌ | — | `pending_booking_payment_sessions` = **0 rows**; `require_card_on_file` false everywhere | A Stripe gate proves the `set_studio_require_card_on_file` path has zero runtime occurrences |
| Payments | Deposits / packages / partial payments | — | — | — | — | — | — | no schema, no code | **Not built** |
| Payments | Broad self-serve live payments | — | — | — | — | — | — | — | **Not ready.** A new studio starts in test mode and is enabled only after supervised onboarding + approval |
| Payments | Automatic / batch / public-triggered charging | — | — | — | — | — | — | — | **Not built and not planned.** Charging is one manual practitioner click |

## 8. Communications

| Domain | Capability | Code state | DB state | Deployment | Enablement | Production exercise | Human acceptance | Evidence | Limitations / next gate |
|---|---|---|---|---|---|---|---|---|---|
| Email | Transactional email via Resend (confirmation, reminder, postcare, portal) | Merged | ✅ applied | Deployed | Enabled | ✅ | ✅ | appointment email tracking columns | Fail-soft — never blocks an appointment action |
| Email | Postcare auto-send on completion (0110) | Merged | ✅ applied | Deployed | **Default OFF (`manual`)** | ⚠️ opt-in per studio | — | `studios.postcare_delivery_mode` default `manual` | Skipped if the Resend key or postcare text is missing |
| SMS | Twilio SMS with opt-in + STOP/HELP | Merged | ✅ applied (0049, 0062) | Deployed | Env-gated on `TWILIO_*`, per-studio toggle, per-client consent | ⚠️ pilot scale only | ✅ | studio SMS toggles | **Broad-SaaS SMS not built** — no A2P/10DLC registration, no per-studio sender strategy, no rate limiting |
| Marketing | Per-studio conversion tracking + encrypted provider token (0106/0107) | Merged | ✅ applied | Deployed | **Inert per studio** until a token is configured | ❌ no studio has configured a provider token | — | `studio_tracking_providers` | Token configuration is an **enablement** step, not a default |

## 9. Google Calendar

**No synchronization is running.** Every outbound/inbound/two-way sync flag is `false` on
every studio. Read this table precisely — *deployed* is not *enabled*.

| Domain | Capability | Code state | DB state | Deployment | Enablement | Production exercise | Human acceptance | Evidence | Limitations / next gate |
|---|---|---|---|---|---|---|---|---|---|
| Google Calendar | Phase A — connection & OAuth foundation (0121/0122, PR #404) | Merged | ✅ applied | Deployed | `google_calendar_connection_enabled` **true on the controlled test studio only** | ✅ one connection created 2026-07-12 | — | `calendar_connections` = 1 row, `connection_status='connected'` | **Willow is not connected** |
| Google Calendar | B1 — outbound schema + queue (0124, PR #407) | Merged | ✅ applied | Deployed | — all sync flags off | ⚠️ see the next row | — | tables exist | — |
| Google Calendar | B2.3-a — intent-gated enqueue + claim boundary (0125, PR #412) | Merged | ✅ applied | Deployed | — no intent-eligible studio | ✅ **one row produced** | — | `calendar_sync_outbox` = 1 row | Correction to earlier docs: the outbox is **not** empty |
| Google Calendar | B2.4 — dual-destination + destination-derived scope (0131, PR #424) | Merged | ✅ applied | Deployed | destination validated on the test studio | ✅ `destination_mode='dedicated_app_created'`; an app-created calendar exists | — | granted scopes include `calendar.app.created`; **no** `events.owned`, **no** broad `calendar.events` | — |
| Google Calendar | B2.3-b — reconciliation sweep + heartbeat + route (PR #426) | Merged | no migration | Deployed | **cron-registered** — `/api/cron/calendar-reconcile` at `0 9 * * *` in `vercel.json`; CRON_SECRET-protected | ⚠️ the route fires daily but finds **zero** intent-eligible studios, so it produces no work | — | `vercel.json` | Registered ≠ syncing. Dormancy comes from the flags, not from the absence of a schedule |
| Google Calendar | B2.3-c1 — event-operation layer + transition RPC (0132, PR #428) | Merged — modules present at the production SHA | ✅ 0132 applied | Deployed | worker off; every studio sync flag off | ✅ **its operations map executed the one real `event.create` on 2026-07-18** | — | migration 0132; `lib/google-calendar/sync/operations.ts` | Exercised once under control, then returned to dormant |
| Google Calendar | B2.3-c2 — authenticated worker-drain route (PR #429) | Merged | no migration | Deployed | **cron-registered** — `/api/cron/calendar-sync` at `30 9 * * *`; worker flag off | ⚠️ the route fires daily; the claim RPC returns 0 rows | — | `vercel.json` | — |
| Google Calendar | B2.3-c3 — cron schedule registration (PR #430) | Merged | no migration | Deployed | **3 daily crons registered in `vercel.json`** — `materialize-recurring-breaks` 08:00 (not a calendar cron), plus the two calendar crons `calendar-reconcile` 09:00 and `calendar-sync` 09:30 | ⚠️ they run and find no work | — | `vercel.json` | Registration did **not** activate sync — the flags do that |
| Google Calendar | **Real outbound event creation** | Merged | ✅ | Deployed | currently **off everywhere** | ✅ **exactly ONE**, on the controlled test studio, 2026-07-18 | — | outbox row `op_type='event.create'`, `status='done'`, `attempts=1`; `calendar_event_links` row `sync_status='synced'`, `last_sync_direction='hone_to_google'` | Exercised once under control, then returned to dormant. **Willow has never had an event synced** |
| Google Calendar | Inbound busy import / two-way edits | Designed | — | **not built** | — | ❌ | — | — | Needs a whole-studio-owner-block decision before Phase C |
| Google Calendar | Willow enablement | — | — | — | **not connected** | ❌ | — | `calendar_connections` holds no Willow row | Needs separate authorization |

**Overall Google Calendar posture: DB applied + deployed + production-exercised once +
currently dormant.** Do not describe it as active, syncing, or enabled.

## 10. Multi-practitioner and practitioner capacity

| Domain | Capability | Code state | DB state | Deployment | Enablement | Production exercise | Human acceptance | Evidence | Limitations / next gate |
|---|---|---|---|---|---|---|---|---|---|
| Tenancy | Studio isolation via RLS `is_studio_member` + composite same-studio FKs (0094, 0151) | Merged | ✅ applied | Deployed | Enabled | ✅ **6 studios coexist** — 1 real-customer, 1 controlled test, 1 synthetic, 3 empty *(2026-08-23; see [current-state.md](./current-state.md) §0)* | ✅ | migrations 0094/0151 | 0151 closed the appointments cross-studio-reference gap |
| Tenancy | Multi-studio user support + studio switcher (PRs #378/#379) | Merged | no migration | Deployed | Enabled | ✅ | ✅ | httpOnly `hone_selected_studio` cookie, re-validated per request | — |
| Multi-practitioner | Practitioner roster | Merged | ✅ applied | Deployed | Enabled | ✅ **2 practitioners at Willow**; 7 across all six tenants, which includes the controlled test and synthetic studios *(2026-08-23)* | ✅ | production row counts | — |
| Multi-practitioner | Capacity foundation — collision/resource-key model (0134) | Merged | ✅ applied | Deployed | `practitioner_capacity_enabled` **true on the controlled test studio ONLY**; **false on Willow** | ⚠️ exercised only on the test studio | — | per-studio flag values | — |
| Multi-practitioner | Per-practitioner availability + scoped blocks/breaks (0135, 0137–0139) | Merged | ✅ applied | Deployed | follows the capacity flag | — **no recorded operation**; the flag is on for the test studio but no capacity-scoped row or audit event was verified | — | migrations 0135–0139; per-studio flag values | Production exercise **unknown pending verification** |
| Multi-practitioner | Internal booking + move/reassign commands (0142–0150) | Merged | ✅ applied | Deployed | follows the capacity flag | — **no recorded operation verified** | — | migrations 0142–0150 | Authoritative in-DB duration; owner-only length override. Production exercise **unknown pending verification** |
| Multi-practitioner | **Public booking practitioner selection/assignment** | Merged (flag exists) | ✅ 0136 applied | Deployed | **`practitioner_capacity_booking_enabled` = false on EVERY studio** | ❌ | — | per-studio flag values | **Held.** This is the public-facing kill switch and it is off everywhere |
| Multi-practitioner | Broad multi-practitioner rollout | — | — | — | — | ❌ | — | — | **Not ready.** Schema + code existing is not launch readiness. Needs the deep audit + explicit authorization |

## 11. Studio onboarding and self-service

| Domain | Capability | Code state | DB state | Deployment | Enablement | Production exercise | Human acceptance | Evidence | Limitations / next gate |
|---|---|---|---|---|---|---|---|---|---|
| Onboarding | Onboarding v2 — welcome email + resumable wizard (0140) | Merged | ✅ applied | Deployed | `onboarding_v2_enabled` **true on the controlled test studio ONLY** | ⚠️ 1 `studio_onboarding` row | — | per-studio flag values | Nudges + analytics **deferred** |
| Onboarding | Invitation reconciliation + single authoritative consent (0141) | Merged | ✅ applied | Deployed | Enabled | ✅ **12 `pending_invitations`** all-tenant — **5 at Willow** *(2026-08-23)* | ⚠️ | migration 0141 | Nothing fabricates consent; nothing activates a membership merely because an Auth user was created |
| Onboarding | Practitioner signup | Merged | ✅ applied | Deployed | **Invite-only** | ✅ | ✅ | magic-link login creates an account only for a pending invitation | Deliberate pilot posture |
| Onboarding | Self-serve studio creation | — | — | — | — | ❌ | — | — | **Not built.** New studios are provisioned through the operator runbook |

## 12. Files, treatment photos and exports

| Domain | Capability | Code state | DB state | Deployment | Enablement | Production exercise | Human acceptance | Evidence | Limitations / next gate |
|---|---|---|---|---|---|---|---|---|---|
| Photos | Private `treatment-images` bucket, service-role signed URLs, EXIF stripping (0092/0093) | Merged | ✅ applied | Deployed | Enabled | ✅ **3 `treatment_images`** all-tenant *(2026-08-23)* — 1 Willow, 2 controlled test, **0 synthetic** | ✅ | production row count | Objects are **service-role only**; no public URLs |
| Photos | Multi-file upload + per-file validation | Merged | no migration | Deployed | Enabled | ✅ | ✅ | PR #368 | — |
| Photos | Finalized-record photo **content** immutability | Never built | — | — | — | — | — | 0119 header | **RETIRED with finalization — see §3.** Not a later phase |
| Exports | Per-client procedure record pull with filtered print | Merged | — | Deployed | Enabled | ⚠️ not instrumented | ✅ | PR #223 | — |

## 13. Operations, alerts and observability

| Domain | Capability | Code state | DB state | Deployment | Enablement | Production exercise | Human acceptance | Evidence | Limitations / next gate |
|---|---|---|---|---|---|---|---|---|---|
| Ops | `ops_alerts` with redaction + never-throws contract (0067) | Merged | ✅ applied | Deployed | Enabled | ⚠️ **4 unresolved alerts** *(2026-08-23)* — all `session_payment_charge_failed`, severity warning, raised at Willow 19:30:48Z–19:32:39Z; they are the 4 non-succeeded live charge attempts | ✅ | `ops_alerts where resolved_at is null` = **4** of 7 rows total | **Corrects a standing "0 unresolved" claim** carried unverified from 2026-07-27. Unresolved rows are not a claim about incidents ever — and neither is zero, without a fresh read |
| Ops | Admin action audit log (0113, `/admin/audit`) | Merged | ✅ applied | Deployed | Enabled | ✅ **7 `admin_action_events`** all-tenant *(2026-08-23)* — 3 carry a studio, 4 carry none | ✅ | production row count | Service-role only; no token/URL/IP/PII columns |
| Ops | `scripts/verify-production.mjs` read-only health check | Merged | — | n/a | n/a | ✅ | ✅ | derives expected migration max from the repo — no hardcoded literal | Reports INCOMPLETE for the Upstash heartbeat when local creds are absent |
| Ops | `scripts/check-stripe-gates.mjs` | Merged | — | n/a | n/a | ✅ | ✅ | — | A gate suite, **not** proof of security |
| Ops | Sentry error monitoring | Merged | no migration | Deployed | Enabled | ⚠️ | — | `sendDefaultPii` off, deny-by-default scrubbers, Replay/Logs OFF | Console contents **not verifiable** from code/CLI alone |
| Ops | PostHog analytics | Merged | no migration | Deployed | ⚠️ **unknown** | ⚠️ | — | recording/autocapture/exception OFF, opaque-id identify | Whether `NEXT_PUBLIC_POSTHOG_*` is set in Vercel is **unknown pending verification** |
| Ops | Rate limiting (Upstash) | Merged | — | Deployed | Optional | ⚠️ | — | — | **Fails OPEN** — if Upstash is down or unset, portal + booking rate limits bypass |
| Ops | Cron routes with `CRON_SECRET` | Merged | — | Deployed | **3 daily crons in `vercel.json`** — `materialize-recurring-breaks` 08:00 (not a calendar cron) plus the **two** calendar crons at 09:00 and 09:30; worker off | ⚠️ they run daily; the calendar pair finds no work | — | `vercel.json` | — |

---

## 14. New-client waitlist (admission control)

Two capabilities, two stages. **Do not collapse them into one status.** WAIT-01 is live and its
commit point is an email. WAIT-02B Stage A is deployed and reachable by nobody.

| Domain | Capability | Code state | DB state | Deployment | Enablement | Production exercise | Human acceptance | Evidence | Limitations / next gate |
|---|---|---|---|---|---|---|---|---|---|
| Waitlist | **WAIT-01 — email-delivered new-client waitlist** (PR #601) | Merged | no migration | Deployed | ✅ **ENABLED for one studio** — `NEW_CLIENT_WAITLIST_STUDIO_SLUGS` present on the Vercel **Production** target only *(names read, no value)* | ✅ pilot activated 2026-08-19; one controlled canary submission at release | ⚠️ operator-observed at release; no separate acceptance record since | `/book/willow-electrolysis` renders `newClientWaitlistEnabled: true` *(2026-08-23)*; [release record](./releases/2026-08-19-willow-new-client-waitlist.md) | Commit point is the **studio notification email**, not a row. Clearing the env var is the whole kill switch |
| Waitlist | **WAIT-02B Stage A — durable studio-scoped waitlist** (PR #629, `48f02389`) | Merged | ✅ **0185 applied 2026-08-23**, frozen | Deployed | ❌ **NOT ENABLED anywhere** — `NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS` **absent from Vercel Production**; **Willow not enabled** | ❌ **never** — `new_client_waitlist_entries` = **0 rows** at apply verification and **0 when last measured** *(2026-08-23)* | n/a at this stage | migration 0185; `lib/booking/new-client-waitlist.ts`; env var **names** only | **DORMANT.** A table existing is not data being collected. See **L25** |
| Waitlist | `join_new_client_waitlist` / `remove_new_client_waitlist_entry` | Merged | ✅ present, SECURITY DEFINER | Deployed | ❌ unreachable — no studio on the durable allowlist | ❌ never invoked | n/a | 0185 body; EXECUTE held by `postgres` and `service_role` only — `anon` and `authenticated` hold none | — |
| Waitlist | Studio-scoped duplicate rule | Merged | ✅ generated `email_normalized` + partial unique index on `(studio_id, email_normalized) WHERE status='waiting'` | Deployed | ❌ | ❌ no row has ever existed to test it against | n/a | migration 0185 | **No global email uniqueness** — tenancy is structural |
| Waitlist | Stage-B configuration report (**was** the Stage-A inverted build gate) | Merged (#637) | no migration | Deployed | ⚠️ **report-only — it no longer fails a build** | n/a | n/a | `scripts/check-production-env-gates.mjs` Gate 4, contract sentences 1-2 and 9 | ⚠️ **CORRECTED 2026-08-26.** This row previously read *"A Vercel production build FAILS while the durable allowlist enables any studio. No bypass and no per-studio exception."* **That is no longer true.** Stage B1 replaced the prohibition with a report; the contract's own first two sentences are *"Gate 4 is report-only. It does not fail the build solely because of `NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS`."* What guards activation now is **runtime membership of TWO allowlists** (sentence 9) — a weaker, configuration-level guarantee, recorded as such. See [known-limitations.md](./known-limitations.md) **L25** |
| Waitlist | **WAIT-02B Stage B — durable collection enabled** | — | — | — | **NOT STARTED** | ❌ | — | — | Blocked on the public privacy disclosure for prospects, the policy's `lastUpdated` + a future `effectiveDate`, explicit studio-enablement GO, and human activation smoke |

**Overall new-client waitlist posture: WAIT-01 enabled and exercised at one studio; WAIT-02B
Stage A DB applied + deployed + DORMANT, with zero rows *when last measured 2026-08-23*; Stage B
not started.** Never describe the durable waitlist as live, enabled, active, or collecting —
and equally, do not restate that dated zero as a present-tense fact: it is evidence for
2026-08-23, not for today.

---

## 15. Capabilities added since the 2026-08-23 reconciliation

**Sixteen** production merges landed between `b9e0003f` and the current baseline. **Eight** carry
a capability that belongs in this register; the rest are UI, documentation or test work. **None
of the eight is production-exercised**, and each is recorded with the evidence that decides its
status rather than with a status word alone.

*(⚠️ **Corrected 2026-08-27.** This section stopped at fourteen merges and six capabilities and
had no row for `#648` at all, two production moves after it was written. The count and the head
are both derived facts and neither was re-derived when the baseline moved — the same class as
the bullet corrected at the top of this file.)*

| Capability | PR / migration | Status | Evidence that decides it |
|---|---|---|---|
| **Intake reminders at 24h / 2h** | #632 · **0186** | **DB applied · deployed · enabled by default** | 0186 adds exactly one column — `studios.send_intake_reminders`, boolean NOT NULL DEFAULT TRUE — plus a comment. No function, index, policy, constraint, trigger, and **no DML anywhere in the file**. The 0098 7d/3d columns, partial indexes and both `claim_email_send` / `record_email_result` branches **remain intact and are historical**; the application simply stops writing them. |
| **Non-card appointment settlement** | #636 · **0187** | **DB applied · deployed · enabled · NOT production-exercised** | `public.appointment_settlements` **holds 0 rows** — created empty, backfilled nothing *(post-apply verification 2026-08-24; not re-measured 2026-08-26)*. The structural guarantee is an **absence**: `method` has no `card` and no `hone` member, so an attestation that a card was charged is *unrepresentable*. Verified ACL: `authenticated` SELECT-only; `anon` and `service_role` FALSE on all eight verbs including `MAINTAIN`. |
| **WAIT-02B Stage B1** | #637 · none | **Deployed · NO STUDIO ENABLED · NOT exercised** | `app/privacy/page.tsx` covers **Prospective clients** (`effectiveDate` May 22 2026, `lastUpdated` August 24 2026). Gate 4 of `scripts/check-production-env-gates.mjs` is now **report-only** — its pinned contract says so in its first two sentences. Activation requires **two** allowlists, not one. |
| **Owner practice capacity** | #638, #641, #645 · none | **Deployed · enabled for owners · NOT exercised** | `app/(app)/dashboard/capacity/page.tsx` checks `practitioner.role !== "owner"` **before any capacity read is issued** and refuses **in place** rather than redirecting. Nine browser tests prove owner reach, practitioner refusal, and that rebooking links land on the right client. Nav visibility (#645) is presentation only. |
| **Clinical read truth** | #642 · none | **Deployed · enabled for all studios** | Four client-profile surfaces now check `unavailable` **before** `hasHistory`, so a failed `session_blocks` read renders *could not be loaded* instead of *no history*. `caution_for_next_session` / `caution_note` protected on both tabs. Recorded non-change: `attachStructuredAreas` still throws — loud, not a false absence. |
| **Export completeness accountability** | #644 · none | **Deployed · enabled** | `lib/export/resource-registry.ts` is the one place a disposition is decided; a missing decision is a **build failure**; schema authority is `information_schema`, not parsed SQL. **The payload is byte-for-byte unchanged** — pinned column-for-column against base `a1639a84`. Roughly fifty-nine studio-owned resources remain **pending**, each ticketed. |
| **Dashboard clinical read truth (F2)** | #648 · none | **Deployed · enabled for all studios** | The Dashboard *Before today* pipeline's four reads destructured `data` alone — `error` did not appear in `lib/dashboard/before-today-previews.ts`. All four now pass one wrapper retaining PostgREST `error` **and** a rejected invocation, classified into two independent facts: `clinicalUnavailable` (three clinical reads) and `clientRecordUnavailable` (the clients read). `compactBeforeToday` checks `unavailable` **before** `hasHistory`. **Explicit non-claim carried forward:** `DASHBOARD_RETURNING_AS_NEW = NOT_PROVEN`. **F3** (recency/tie authority) is a separate confirmed **P2, open**; **F4** latent and deferred; **HIST-01A** untouched. |
| **Owner financial truth surface (FIN-01A Slice 1)** | #646 · none | **Deployed · owner-only · NOT production-exercised** | `/financials` answers what the calendar held in one studio-local period and how those appointments divided. The role refusal is the **first statement** of `loadFinancialsView`, before a Supabase client is constructed, so a practitioner causes no studio-wide query at all. The route is **withheld from search** (`NON_SEARCHABLE_ROUTES`, no `NAV_ENTRIES` row). **No money arithmetic** — a source guard pins the absence of all three truth classes' ledger identifiers, and the slice reads exactly one table; the anchor is in **visits, not service value**, which is Slice 2. Unknown is a **closed cause vocabulary** (`not_recorded` / `unavailable` / `unknowable` / `not_yet_supported` / `not_enumerable`) and `known(0)` is the only route to a zero. **No migration, RPC, schema or external side effect; 0187 untouched.** |

**Studio launch readiness additionally gained a consent requirement** (#643): readiness now
requires at least one form with server-resolved `studio_id`, `form_type = 'treatment_consent'`,
`status = 'active'` **and** `is_live = true`. Draft, archived and active-but-not-live forms do
not satisfy it, so *ready* now means the intake will actually present a consent.

## Capability register summary

| Bucket | Count | Examples |
|---|---|---|
| Deployed + enabled + production-exercised + in routine operator use | ~21 | booking, charting core, portal, intake, consent, photos, live session payments, record keeping, **whole-session copy** |
| Deployed + enabled + **human acceptance pending** | 8 | Phase A charting (unified box, galvanic retirement, 0.733 precision, pulse relabel, notes sizing), whole-session copy *(now also production-exercised — the two are independent)*, numbing notes, probe-lot linkage |
| Deployed + **DB applied** + **never production-exercised** | 7 | refunds (current baseline), disputes, public-booking card collection, probe-lot linkage, **the durable new-client waitlist (WAIT-02B)**, **non-card appointment settlement (0187 — 0 rows)**, **`/dashboard/capacity` (no usage measured)**. **Whole-session copy has left this bucket** — 24 production operations |
| Deployed + **dormant** (flag off / no worker / no eligible tenant) | 8 | all Google Calendar sync phases, capacity on Willow, onboarding v2 on Willow, **the durable new-client waitlist on every studio** *(dormant by allowlist configuration since Stage B1 — no longer by a build-time prohibition; see §14)* |
| **Held** behind a deliberate server-side gate | 3 | live manual fees, public-booking card collection, public practitioner assignment |
| **Deferred** by product decision | 1 | direct new-client consultation booking route *(distinct from the WAIT-01 waitlist, which is live at Willow — see §14)* |
| **RETIRED** by product decision (terminal; DB-enforced) | 5 | signed/finalized clinical records (0119), signed-record corrections/amendments (0120), amendment-path observability (PR #402), `clinical_audit_events`, finalized-photo content immutability — see §3 |
| **Not built** | 5 | deposits/packages/partial payments, broad self-serve live payments, inbound-busy/two-way calendar, broad-SaaS SMS, self-serve studio creation |

**The single most load-bearing distinction in this register:** *production exercised* and
*human accepted* are independent, and whole-session copy now shows why. It is
**production exercised** — 24 real operations at the live studio between 2026-07-28 and
2026-08-23 — and it is still **not human accepted**, because Chloe has not confirmed she has
used it and accepts its behaviour. Usage is evidence of exercise. Only a person saying so is
evidence of acceptance.

The Phase A charting correction sits differently again: deployed and enabled, with **no
per-item production-exercise evidence measured in either direction**, and not accepted. Do not
borrow the charting surface's general activity as evidence for any individual Phase A item.

<!-- canonical-facts:ignore-start reason=quotes-the-superseded-not-exercised-claim -->
*This register previously asserted that whole-session copy was "not yet exercised by the person
who asked for them". That was true when written on 2026-07-27 and false from 2026-07-28
onward; it stood here for roughly four weeks. The correction is recorded rather than quietly
overwritten, because a register that silently changes its mind teaches readers not to trust it.*
<!-- canonical-facts:ignore-end -->
