# Hone — Capability Register

**Detailed per-capability status matrix.** This is the evidence layer behind
[current-state.md](./current-state.md). Where the two disagree, re-verify both against
production; neither document is evidence for the other.

- **Reconciled:** 2026-07-27
- **Runtime-bearing baseline:** application HEAD `96b28d62a5f3b9acd67d00b24c80caebd6a66e5d`
  (PR #478 merge), production migration max **0157**.
- **Amended 2026-07-29:** §3 rewritten from *dormant / parked* to **RETIRED** — signed and
  finalized clinical records are not a Hone product capability. Enforced by migration **0159**
  (in-tree, **not yet applied**; hosted max is still 0157, and `0158` is intentionally skipped).
  Production facts re-verified read-only 2026-07-29 and unchanged. Decision record:
  [../decisions/clinical-finalization-retired.md](../decisions/clinical-finalization-retired.md).

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
| Charting | Session blocks, observation chips, treatment areas, Before Today / Treatment Intelligence | Merged | applied (≤0130) | Deployed | Enabled for all studios (no flag) | ✅ 49 `session_blocks`, 33 `electrolysis_entries` in production | ✅ in continuous operator use | production row counts | — |
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
| Whole-session copy | Editable ephemeral preview ("Copy areas & settings from last session") | Merged (PR #478) | ✅ 0157 applied 2026-07-27T02:01:29Z | Deployed (`96b28d6`) | Enabled — no feature flag | **❌ NOT production exercised** | **Pending** | `session_copy_operations` = **0 rows** | Deployment verification deliberately performed zero copy operations |
| Whole-session copy | Zero writes before the explicit commit | Merged | — | Deployed | Enabled | ❌ **not exercised** — consistent with the row above; the 0-row ledger is evidence the feature has not been *used*, not evidence the guarantee was *tested* in production | **Pending** | `session_copy_operations` = 0 rows | Preview is component memory only |
| Whole-session copy | One atomic commit (`copy_session_setup`) | Merged | ✅ function present | Deployed | Enabled | ❌ never invoked in production | **Pending** | `pg_proc`: SECURITY DEFINER, `search_path=""` | — |
| Whole-session copy | Source locking + stale-source rejection | Merged | ✅ fingerprint + source-id helpers | Deployed | Enabled | ❌ | **Pending** | `_whole_session_copy_fingerprint`, `_whole_session_copy_source_id` | Both helpers are **private** (service_role only) |
| Whole-session copy | Idempotency + provenance ledger | Merged | ✅ `session_copy_operations` | Deployed | Enabled | ❌ 0 rows | **Pending** | `(target_session_id, idempotency_key)` UNIQUE | Retry/double-submit is an at-most-once no-op |
| Whole-session copy | Reusable setup only — **minutes and outcomes excluded** | Merged | ✅ enforced in the RPC body | Deployed | Enabled | ❌ | **Pending** | 0157 RPC body | Clinical outcomes are never copied forward |
| Whole-session copy | **Galvanic intensity forced literal NULL** at the destination | Merged | ✅ enforced in the RPC body | Deployed | Enabled | ❌ | **Pending** | 0157 RPC body; fingerprint excludes it | Forged-spec-safe: the destination insert does not read the client value |
| Whole-session copy | Commit RPC unreachable from the browser | Merged | ✅ | Deployed | Enabled | n/a | n/a | `copy_session_setup` EXECUTE: anon **false**, authenticated **false**, service_role true | Invoked only by the authenticated server action with a server-derived practitioner id |

## 3. Clinical finalization, corrections and amendments — RETIRED

**Signed / finalized clinical records are RETIRED** by product decision (2026-07-29), enforced by
migration **0159**. This is `Retired`, not `Dormant` and not `Held`: both studio flags are pinned
`false` by CHECK constraint, so **no role can enable them** — not a studio owner through the
`studios: owners update` policy, not `service_role`. Treatment sessions are ordinary, editable
operational records; practitioners correct mistakes by editing. There is no snapshot v2, and no
document ever promised one. Reasoning, retained legacy artifact and the reintroduction bar:
**[../decisions/clinical-finalization-retired.md](../decisions/clinical-finalization-retired.md)**.

| Domain | Capability | Code state | DB state | Deployment | Enablement | Production exercise | Human acceptance | Evidence | Limitations / next gate |
|---|---|---|---|---|---|---|---|---|---|
| Clinical record | Phase 1 — finalization boundary (0119, PR #399) | **RETIRED** — practitioner-facing Finalize surface removed | 0119 applied; **0159 retires it** (nothing dropped) | Deployed, unreachable | **RETIRED** — `clinical_finalization_enabled` false on **all 5 studios** and **pinned false** by `studios_clinical_finalization_retired`; `EXECUTE` on `finalize_session` revoked from every runtime role; `sessions_guard_retired_finalization` refuses any transition into `finalized`/`void` | ✅ historically **exactly once**, on the controlled non-Willow test studio (2026-07-11T00:42:12Z) | n/a — never offered to Willow | 1 `finalized` session of 76 + 1 `clinical_record_snapshots` row whose `content_hash` **still re-derives to a MATCH**, both on the test studio; Willow has **0** non-draft sessions; 0 `void` | **RETIRED — no next gate.** The one legacy artifact is retained unchanged, deliberately **not deleted and not regenerated** |
| Clinical record | Phase 2 — corrections/amendments backend (0120, PR #400) | **RETIRED** — practitioner-facing signed-Correction surface removed | 0120 applied; **0159 retires it** | Deployed, unreachable | **RETIRED** — `clinical_corrections_enabled` false on all studios and **pinned false** by `studios_clinical_corrections_retired`; `EXECUTE` revoked on `correct_finalized_session` / `amend_finalized_session` / `amend_finalized_session_with_image` / `build_session_snapshot`; `INSERT` refused on all three signed-record ledgers | **❌ never** | n/a | `clinical_record_amendments` = **0 rows**; `clinical_audit_events` = **0 rows** | **RETIRED — no next gate.** Backend preserved and **must not be weakened** — not to allow later enablement, but to keep the legacy evidence immutable, keep the retirement fail-closed, and forbid `authenticated` `TRUNCATE` on the six clinical tables and any write to the three signed-record ledgers (ordinary row DML on the five app-written tables is NOT revoked — see known-limitations L18) |
| Clinical record | Amendment-path reliability + observability (PR #402) | **RETIRED with Phase 2** | no migration | Deployed, unreachable | **RETIRED** | ❌ | n/a | PR #402 | The path it instrumented cannot execute |
| Clinical record | `clinical_audit_events` — **not** the operational audit trail | **RETIRED with Phase 2** | 0120 applied; 0159 blocks `INSERT` | Deployed, immutable | **RETIRED** | ❌ 0 rows | n/a | its CHECK permits only `operation_type in ('correction','amendment')` | Named "audit" but scoped to signed corrections/amendments only. **Ordinary audit is retained and active**: `session_audit`, `record_keeping_audit_events`, `session_copy_operations`, `admin_action_events`, `client_portal_access_events` |
| Clinical record | Append-only clinical notes (`client_clinical_notes`, 0126/0127) | Merged | ✅ applied | Deployed | Enabled — all studios, no flag | ✅ 1 production row | ✅ | `client_clinical_notes` = 1 row | **Unrelated to 0119/0120 and NOT retired.** A correction/revision here is a **new row** (`supersedes_note_id`), never a signed snapshot |
| Clinical record | Finalized photo **content** immutability | Never built | — | — | — | — | — | 0119 header scope note | **RETIRED, not a later phase** — it was a sub-requirement of a capability Hone no longer offers. The live private-bucket / service-role-only / EXIF / identity-freeze protections are unaffected |

## 4. Probe inventory and record keeping

| Domain | Capability | Code state | DB state | Deployment | Enablement | Production exercise | Human acceptance | Evidence | Limitations / next gate |
|---|---|---|---|---|---|---|---|---|---|
| Record keeping | Sterile items, disinfectants, exposure incidents + audit | Merged | applied (0085–0088, 0096) | Deployed | Enabled | ✅ 8 `record_keeping_sterile_items` rows | ✅ | production row count | Exposure-incident history is **owner-only** |
| Record keeping | Overdue-disinfectant "Replace now" alerts (PR #422) | Merged | no migration | Deployed | Enabled | ⚠️ read-time computed; auto-resolves, leaves no row | ⚠️ unverified — no acceptance record | PR #422 | Not separately instrumented by design |
| Record keeping | Probe-lot ↔ inventory durable link (0155) | Merged | ✅ 0155 applied | Deployed | Enabled | — no linked block yet | **Pending** | `session_blocks.probe_inventory_item_id` | Legacy `probe_lots` table stays **dormant** |

## 5. Booking and calendar

| Domain | Capability | Code state | DB state | Deployment | Enablement | Production exercise | Human acceptance | Evidence | Limitations / next gate |
|---|---|---|---|---|---|---|---|---|---|
| Booking | Public booking (service selection, availability scan, intake gating, hashed-token manage/cancel/reschedule) | Merged | applied | Deployed | Enabled | ✅ 101 appointments across production | ✅ | production row count | — |
| Booking | Practitioner calendar (mobile single-day timeline; desktop week/month + preview drawer) | Merged | no migration | Deployed | Enabled | ✅ | ✅ | PRs #380–#383 | — |
| Booking | Move appointment — atomic same-record (0133, PRs #431/#434) | Merged | ✅ 0133 applied | Deployed | Enabled | ⚠️ available/custom-time paths deployed; no `moved` audit rows recorded at the last read | **Pending** for owner custom-time | migration 0133 | — |
| Booking | Manual-override booking: actual overlap HARD / buffer SOFT (0152) | Merged | ✅ 0152 applied | Deployed | Enabled | ✅ | ✅ | migration 0152 | Owner override bypasses **buffer only**, never real overlap |
| Booking | Backward-packed slot anchor + source-aware conflicts (PR #467) | Merged | no migration | Deployed | Enabled | ✅ | ✅ | PR #467 | — |
| Booking | Explicit per-service calendar colour (0153) | Merged | ✅ applied | Deployed | Enabled | ✅ | ✅ | migration 0153 | Rose/red reserved for clinical caution |
| Booking | **Direct new-client consultation booking route** | **Deferred** | — | — | — | — | — | Product decision 2026-07-27 | **Deferred by product decision.** Not built, not a blocker, not the next task |

## 6. Client portal and intake

| Domain | Capability | Code state | DB state | Deployment | Enablement | Production exercise | Human acceptance | Evidence | Limitations / next gate |
|---|---|---|---|---|---|---|---|---|---|
| Portal | Magic-link login, portal tasks, append-only access-event log (0111) | Merged | ✅ applied | Deployed | Enabled | ✅ 21 `client_portal_sessions` | ✅ | production row count | — |
| Portal | Portal messages + replies | Merged | ✅ applied (0053–0055) | Deployed | Enabled | ✅ 11 `client_portal_messages` | ✅ | production row count | One-way studio→client + client replies |
| Intake | Intake forms + reminders + terminal-state immutability (0118) | Merged | ✅ applied | Deployed | Enabled | ✅ 29 `client_intake_forms` | ✅ | production row count | Submitted/reviewed answers immutable to members |
| Consent | Versioned consent templates + e-signatures (0057, 0060, 0072) | Merged | ✅ applied | Deployed | Enabled | ✅ 19 `client_consent_signatures` | ✅ | production row count | ⚠️ **Draft wording — lawyer review required before relying on enforceability** |

## 7. Payments and Stripe

| Domain | Capability | Code state | DB state | Deployment | Enablement | Production exercise | Human acceptance | Evidence | Limitations / next gate |
|---|---|---|---|---|---|---|---|---|---|
| Payments | Stripe Connect onboarding (live + test, mode-scoped 0103) | Merged | ✅ applied | Deployed | **Enabled for 2 studios** — Willow Electrolysis and the controlled test studio | ✅ both hold `stripe_account_status='enabled'`, charges+payouts true in **live** mode | ✅ | `studio_payment_settings`: 4 rows (live+test per studio) | Per-studio, after supervised onboarding |
| Payments | Owner-run **session payment** charges, live mode | Merged | ✅ applied | Deployed | Enabled for the 2 approved studios | ✅ **Willow: 6 succeeded live charges, most recent 2026-07-26**; test studio: 2 succeeded live | ✅ | `payment_charge_attempts` grouped by studio + `stripe_livemode` | This is the strongest production-exercise evidence in the system |
| Payments | Card-on-file (SetupIntent), live/test isolation | Merged | ✅ applied (0058/0059/0104) | Deployed | Enabled | ✅ 8 `client_payment_methods`, 9 `client_stripe_customers` | ✅ | production row counts | `require_card_on_file` = **false** on every studio |
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
| Tenancy | Studio isolation via RLS `is_studio_member` + composite same-studio FKs (0094, 0151) | Merged | ✅ applied | Deployed | Enabled | ✅ 5 studios coexist | ✅ | migrations 0094/0151 | 0151 closed the appointments cross-studio-reference gap |
| Tenancy | Multi-studio user support + studio switcher (PRs #378/#379) | Merged | no migration | Deployed | Enabled | ✅ | ✅ | httpOnly `hone_selected_studio` cookie, re-validated per request | — |
| Multi-practitioner | Practitioner roster | Merged | ✅ applied | Deployed | Enabled | ✅ 6 practitioners across 5 studios; Willow has 2 | ✅ | production row counts | — |
| Multi-practitioner | Capacity foundation — collision/resource-key model (0134) | Merged | ✅ applied | Deployed | `practitioner_capacity_enabled` **true on the controlled test studio ONLY**; **false on Willow** | ⚠️ exercised only on the test studio | — | per-studio flag values | — |
| Multi-practitioner | Per-practitioner availability + scoped blocks/breaks (0135, 0137–0139) | Merged | ✅ applied | Deployed | follows the capacity flag | — **no recorded operation**; the flag is on for the test studio but no capacity-scoped row or audit event was verified | — | migrations 0135–0139; per-studio flag values | Production exercise **unknown pending verification** |
| Multi-practitioner | Internal booking + move/reassign commands (0142–0150) | Merged | ✅ applied | Deployed | follows the capacity flag | — **no recorded operation verified** | — | migrations 0142–0150 | Authoritative in-DB duration; owner-only length override. Production exercise **unknown pending verification** |
| Multi-practitioner | **Public booking practitioner selection/assignment** | Merged (flag exists) | ✅ 0136 applied | Deployed | **`practitioner_capacity_booking_enabled` = false on EVERY studio** | ❌ | — | per-studio flag values | **Held.** This is the public-facing kill switch and it is off everywhere |
| Multi-practitioner | Broad multi-practitioner rollout | — | — | — | — | ❌ | — | — | **Not ready.** Schema + code existing is not launch readiness. Needs the deep audit + explicit authorization |

## 11. Studio onboarding and self-service

| Domain | Capability | Code state | DB state | Deployment | Enablement | Production exercise | Human acceptance | Evidence | Limitations / next gate |
|---|---|---|---|---|---|---|---|---|---|
| Onboarding | Onboarding v2 — welcome email + resumable wizard (0140) | Merged | ✅ applied | Deployed | `onboarding_v2_enabled` **true on the controlled test studio ONLY** | ⚠️ 1 `studio_onboarding` row | — | per-studio flag values | Nudges + analytics **deferred** |
| Onboarding | Invitation reconciliation + single authoritative consent (0141) | Merged | ✅ applied | Deployed | Enabled | ✅ 11 `pending_invitations` | ⚠️ | migration 0141 | Nothing fabricates consent; nothing activates a membership merely because an Auth user was created |
| Onboarding | Practitioner signup | Merged | ✅ applied | Deployed | **Invite-only** | ✅ | ✅ | magic-link login creates an account only for a pending invitation | Deliberate pilot posture |
| Onboarding | Self-serve studio creation | — | — | — | — | ❌ | — | — | **Not built.** New studios are provisioned through the operator runbook |

## 12. Files, treatment photos and exports

| Domain | Capability | Code state | DB state | Deployment | Enablement | Production exercise | Human acceptance | Evidence | Limitations / next gate |
|---|---|---|---|---|---|---|---|---|---|
| Photos | Private `treatment-images` bucket, service-role signed URLs, EXIF stripping (0092/0093) | Merged | ✅ applied | Deployed | Enabled | ✅ 3 `treatment_images` rows | ✅ | production row count | Objects are **service-role only**; no public URLs |
| Photos | Multi-file upload + per-file validation | Merged | no migration | Deployed | Enabled | ✅ | ✅ | PR #368 | — |
| Photos | Finalized-record photo **content** immutability | Never built | — | — | — | — | — | 0119 header | **RETIRED with finalization — see §3.** Not a later phase |
| Exports | Per-client procedure record pull with filtered print | Merged | — | Deployed | Enabled | ⚠️ not instrumented | ✅ | PR #223 | — |

## 13. Operations, alerts and observability

| Domain | Capability | Code state | DB state | Deployment | Enablement | Production exercise | Human acceptance | Evidence | Limitations / next gate |
|---|---|---|---|---|---|---|---|---|---|
| Ops | `ops_alerts` with redaction + never-throws contract (0067) | Merged | ✅ applied | Deployed | Enabled | ✅ **0 unresolved alerts** at reconciliation | ✅ | `ops_alerts where resolved_at is null` = 0 | Zero *unresolved* — not a claim of zero incidents ever |
| Ops | Admin action audit log (0113, `/admin/audit`) | Merged | ✅ applied | Deployed | Enabled | ✅ 5 `admin_action_events` | ✅ | production row count | Service-role only; no token/URL/IP/PII columns |
| Ops | `scripts/verify-production.mjs` read-only health check | Merged | — | n/a | n/a | ✅ | ✅ | derives expected migration max from the repo — no hardcoded literal | Reports INCOMPLETE for the Upstash heartbeat when local creds are absent |
| Ops | `scripts/check-stripe-gates.mjs` | Merged | — | n/a | n/a | ✅ | ✅ | — | A gate suite, **not** proof of security |
| Ops | Sentry error monitoring | Merged | no migration | Deployed | Enabled | ⚠️ | — | `sendDefaultPii` off, deny-by-default scrubbers, Replay/Logs OFF | Console contents **not verifiable** from code/CLI alone |
| Ops | PostHog analytics | Merged | no migration | Deployed | ⚠️ **unknown** | ⚠️ | — | recording/autocapture/exception OFF, opaque-id identify | Whether `NEXT_PUBLIC_POSTHOG_*` is set in Vercel is **unknown pending verification** |
| Ops | Rate limiting (Upstash) | Merged | — | Deployed | Optional | ⚠️ | — | — | **Fails OPEN** — if Upstash is down or unset, portal + booking rate limits bypass |
| Ops | Cron routes with `CRON_SECRET` | Merged | — | Deployed | **3 daily crons in `vercel.json`** — `materialize-recurring-breaks` 08:00 (not a calendar cron) plus the **two** calendar crons at 09:00 and 09:30; worker off | ⚠️ they run daily; the calendar pair finds no work | — | `vercel.json` | — |

---

## Capability register summary

| Bucket | Count | Examples |
|---|---|---|
| Deployed + enabled + production-exercised + in routine operator use | ~20 | booking, charting core, portal, intake, consent, photos, live session payments, record keeping |
| Deployed + enabled + **human acceptance pending** | 8 | Phase A charting (unified box, galvanic retirement, 0.733 precision, pulse relabel, notes sizing), whole-session copy, numbing notes, probe-lot linkage |
| Deployed + **DB applied** + **never production-exercised** | 5 | whole-session copy commit path, refunds (current baseline), disputes, public-booking card collection, probe-lot linkage |
| Deployed + **dormant** (flag off / no worker / no eligible tenant) | 7 | all Google Calendar sync phases, capacity on Willow, onboarding v2 on Willow |
| **Held** behind a deliberate server-side gate | 3 | live manual fees, public-booking card collection, public practitioner assignment |
| **Deferred** by product decision | 1 | direct new-client consultation booking route |
| **RETIRED** by product decision (terminal; DB-enforced) | 5 | signed/finalized clinical records (0119), signed-record corrections/amendments (0120), amendment-path observability (PR #402), `clinical_audit_events`, finalized-photo content immutability — see §3 |
| **Not built** | 5 | deposits/packages/partial payments, broad self-serve live payments, inbound-busy/two-way calendar, broad-SaaS SMS, self-serve studio creation |

**The single most load-bearing distinction in this register:** whole-session copy and the
Phase A charting correction are *deployed and enabled* but **not yet exercised by the
person who asked for them**. Engineering delivery is complete; human acceptance is not.
