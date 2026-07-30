# Hone — Known Limitations

**Verified residual limitations as of 2026-07-27**, against application HEAD
`96b28d62a5f3b9acd67d00b24c80caebd6a66e5d` and production migration max **0157**.

Only limitations that were **directly verified** in this reconciliation are listed. Items
that could not be checked from code, the CLI, or read-only production queries are recorded
explicitly as *unknown pending verification* rather than asserted in either direction.

**Amended 2026-07-29:** **L9** and **L10** were rewritten because signed / finalized clinical
records are now **RETIRED by product decision**, enforced by migration **0159** (in-tree, not yet
applied — hosted max remains 0157). They are no longer parked, dormant or gated; there is no next
gate on either. The production facts in both rows were re-verified read-only on 2026-07-29 and
are unchanged. See
[../decisions/clinical-finalization-retired.md](../decisions/clinical-finalization-retired.md).

Related: [current-state.md](./current-state.md) ·
[capability-register.md](./capability-register.md) · [migration-ledger.md](./migration-ledger.md) ·
[release-changelog.md](./release-changelog.md)

**Blocking legend** — `Willow` = blocks the live pilot studio · `Broader launch` = blocks
selling to additional studios · `Neither` = accepted, tracked, not blocking today.

---

## L1 — Chloe's human acceptance testing is outstanding

| Field | Value |
|---|---|
| **Impact** | The Phase A charting correction (PR #479) and whole-session copy (PR #478 + migration 0157) are deployed and enabled, but the operator who requested them has **not** used them on a real device against real work. Engineering delivery is complete; correctness in her hands is unconfirmed. |
| **Evidence** | No production copy operation exists (`session_copy_operations` = 0 rows). No acceptance record exists for the charting changes. |
| **Current mitigation** | Both changes are additive and reversible. Phase A is code-only — rollback is a code revert with no migration to undo. Whole-session copy performs zero writes until an explicit commit, so simply not using it is a safe state. Galvanic-intensity history is preserved rather than deleted. |
| **Owner** | Chloe (operator) · Sam (engineering) |
| **Next gate** | Chloe performs on-device acceptance of: the unified *Treatment observations & skin response* box; galvanic intensity being gone from new charting; `0.733` displaying as `0.733 seconds`; the *Thermolysis pulse count* label; the larger *Additional notes* field; and one real whole-session copy. |
| **Blocks** | Neither today — but it is the **last gate on calling this release accepted**. |

## L2 — No real production whole-session copy has ever been performed

| Field | Value |
|---|---|
| **Impact** | The commit path (`copy_session_setup`), the idempotency guarantee, the provenance ledger and the source-locking / stale-source rejection behaviour have **never executed against production data**. They were verified by source inspection and browser testing only. |
| **Evidence** | `session_copy_operations` = **0 rows**. The deployment verification deliberately performed zero copy operations. |
| **Current mitigation** | Deliberate. Deployment verification was designed to be zero-data-operation, which is the correct posture for a clinical system. The DB objects, privilege matrix and RPC body were verified directly instead. |
| **Owner** | Chloe (first real copy) |
| **Next gate** | One real copy on a real session, then confirm exactly one ledger row appears and the destination records match the reviewed preview. |
| **Blocks** | Neither — but do **not** describe whole-session copy as production-exercised until this happens. |

## L3 — Direct new-client consultation booking route is deferred

| Field | Value |
|---|---|
| **Impact** | New clients cannot book a consultation through a dedicated direct route. |
| **Evidence** | Product decision recorded 2026-07-27. No code exists. |
| **Current mitigation** | Existing public booking and operator-side booking cover current pilot volume. |
| **Owner** | Product (Sam) |
| **Next gate** | None scheduled. This is **deferred by product decision**, not blocked on engineering. |
| **Blocks** | **Neither.** Explicitly not a launch blocker and not the next engineering task. |

## L4 — Payment readiness is controlled, not broad

| Field | Value |
|---|---|
| **Impact** | Live payments work for two specifically approved studios. A new studio cannot self-serve into live payments. |
| **Evidence** | `studio_payment_settings` holds live-mode enabled accounts for exactly 2 studios (Willow Electrolysis and the controlled test studio). Willow has **6 succeeded live charges**, most recent 2026-07-26 — so live payment capability is genuinely production-exercised for her. Refunds: `stripe_refunds` = 0 rows. Disputes: `stripe_disputes` = 0 rows. |
| **Current mitigation** | Per-studio supervised onboarding + approval. A new studio starts in test mode. Live manual no-show / late-cancellation fees are on a **server-side hard hold** (`lib/billing/live-charge-reason-allowlist.ts`) — only `session_payment` charges live. Public-booking card collection is off and unwired. Deposits, packages and partial payments are not built. |
| **Owner** | Sam |
| **Next gate** | Deep audit of the payment surface, then an explicit decision on broad self-serve enablement. |
| **Blocks** | **Broader launch.** Does **not** block Willow — she is live and charging. |

## L5 — No production refund or dispute has occurred on this baseline

| Field | Value |
|---|---|
| **Impact** | The refund and dispute paths carry no production evidence against the current baseline. Dispute handling is alert-only by design. |
| **Evidence** | `stripe_refunds` = 0 rows; `stripe_disputes` = 0 rows; `stripe_payment_audit` = 0 rows. |
| **Current mitigation** | Refund code was proven in earlier controlled testing. `charge.dispute.created` raises a critical ops alert so a dispute cannot pass unnoticed. |
| **Owner** | Sam |
| **Next gate** | Include both paths in the deep audit. |
| **Blocks** | Neither today. |

## L6 — Google Calendar is deployed and dormant, exercised exactly once

| Field | Value |
|---|---|
| **Impact** | No calendar synchronization is running. Willow's calendar is not connected to Google at all. |
| **Evidence** | `calendar_connections` = 1 row, on the **controlled test studio only** (`destination_mode='dedicated_app_created'`, connected 2026-07-12). Exactly one real outbound event was ever created: `calendar_sync_outbox` = 1 row (`op_type='event.create'`, `status='done'`, 2026-07-18) with a matching `calendar_event_links` row (`sync_status='synced'`, `hone_to_google'`). Every `google_calendar_outbound_sync_enabled` / `inbound_busy` / `two_way_updates` flag is **false on all 5 studios**. |
| **Current mitigation** | Deployed dormant by design. The worker flag is off, no studio is intent-eligible, and the enqueue path therefore produces no work. Granted scopes are least-privilege: `calendar.app.created` only — **no** `events.owned`, **no** broad `calendar.events`. |
| **Owner** | Sam |
| **Next gate** | Separate authorization is required for each of: connecting Willow, enabling any outbound flag, activating the worker, and beginning inbound-busy/two-way work. |
| **Blocks** | Neither. Correct earlier docs that claim the outbox and links are empty — they each hold one row from the controlled validation. |

## L7 — Multi-practitioner capacity is enabled only on the test studio

| Field | Value |
|---|---|
| **Impact** | The three-practitioner capacity model exists in schema and code but is not in use at the live studio, and public practitioner selection is off everywhere. |
| **Evidence** | `practitioner_capacity_enabled` is **true only on the controlled test studio** and **false on Willow Electrolysis**. `practitioner_capacity_booking_enabled` — the public-booking kill switch — is **false on every studio**. |
| **Current mitigation** | Both flags default off. 0136 deliberately split structural capacity from booking acceptance so the public switch can stay off independently. Note that flipping `practitioner_capacity_enabled` from ON to OFF is **not** a truthful instant rollback once parallel appointments exist — see the 0136 migration header. |
| **Owner** | Sam |
| **Next gate** | Deep audit, then a controlled pilot, then explicit authorization per studio. |
| **Blocks** | **Broader launch.** Schema and code existing is not launch readiness. |

## L8 — Onboarding and self-service gaps

| Field | Value |
|---|---|
| **Impact** | A studio cannot onboard itself. Practitioner signup is invite-only. Onboarding v2 is enabled on one non-production studio. |
| **Evidence** | `onboarding_v2_enabled` true on the controlled test studio only; 1 `studio_onboarding` row; 11 `pending_invitations`. No self-serve studio-creation path exists. |
| **Current mitigation** | New studios are provisioned through the operator runbook (`docs/20_NEW_STUDIO_SETUP_RUNBOOK.md`). Invite-only signup is a deliberate pilot posture. |
| **Owner** | Sam |
| **Next gate** | Onboarding nudges + analytics remain deferred; broad rollout follows the audit. |
| **Blocks** | **Broader launch.** |

## L9 — Finalized clinical photo *content* immutability was never built, and is now moot

| Field | Value |
|---|---|
| **Impact** | **None going forward.** The gap only existed inside the finalization boundary, which is retired (L10): no clinical record is ever finalized, so there is no finalized-photo integrity claim to fall short of. Historically: finalization froze photo metadata and attachment relationships but the stored object was never content-addressed. |
| **Evidence** | Stated in the 0119 migration header as an explicit scope note. Migration 0159 retires the finalization lifecycle entirely (`sessions_guard_retired_finalization`). |
| **Current mitigation** | Unchanged and unaffected by the retirement: `treatment-images` is a private bucket, service-role-only, with path/identity CHECKs and an integrity trigger that freezes identity columns after insert. Archive only flips `deleted_at`. |
| **Owner** | Sam |
| **Next gate** | **None — RETIRED, not scheduled.** Content-addressed object immutability is not a later photo-integrity phase; it was a sub-requirement of a capability Hone no longer offers. See [../decisions/clinical-finalization-retired.md](../decisions/clinical-finalization-retired.md). |
| **Blocks** | Neither, now or later. |

## L10 — Signed / finalized clinical records are RETIRED

| Field | Value |
|---|---|
| **Impact** | **This is a closed product decision, not an open limitation.** Hone does not offer signed or cryptographically finalized clinical records, signed-record corrections, or amendments. Treatment sessions are ordinary, editable operational records and practitioners correct charting mistakes by editing them. No practitioner can finalize, correct or amend a signed record — and none ever will. |
| **Evidence** | Product decision 2026-07-29, enforced by migration **0159**: both flags pinned `false` by CHECK constraints (no role can set them); `EXECUTE` revoked from every runtime role on `finalize_session` / `correct_finalized_session` / `amend_finalized_session` / `amend_finalized_session_with_image` / `build_session_snapshot`; `sessions.record_status` transitions into `finalized`/`void` refused; `INSERT` refused on all three signed-record ledgers. Verified production state: both flags **false on all 5 studios**; exactly 1 finalized session + 1 snapshot (hash still re-derives) on the **controlled non-Willow test studio**, retained unchanged; Willow has **0** non-draft sessions; `clinical_record_amendments` = 0 rows; `clinical_audit_events` = 0 rows. |
| **Current mitigation** | Not a mitigation — an enforcement posture. The deployed 0119/0120 backend — immutable snapshots, version lineage, append-only audit, RLS and the narrow session-scoped correction permit — is **preserved and must not be weakened**, **not** so finalization can be enabled later, but because it keeps the one legacy artifact immutable, keeps the retirement fail-closed, and forbids `authenticated` `TRUNCATE` on the six clinical tables (0159 §5b) and any write to the three signed-record ledgers. **It does NOT stop ordinary direct DML:** `authenticated` still holds row `INSERT`/`UPDATE`/`DELETE` on `sessions`, `session_blocks`, `electrolysis_entries`, `laser_entries` and `treatment_images`, restricted only by RLS to same-studio rows — see L18. Ordinary audit trails (`session_audit`, `record_keeping_audit_events`, `session_copy_operations`, `admin_action_events`, `client_portal_access_events`), actor attribution, timestamps, treatment-history integrity, whole-session-copy provenance and tenant isolation are all **retained**. `clinical_audit_events` is **not** ordinary audit — it records only signed corrections/amendments and is retired with the rest. |
| **Owner** | Sam (product) |
| **Next gate** | **None — RETIRED.** Not parked, not dormant, not held, not in any queue, and not a gate anyone can grant. No snapshot v2 is planned (and no document ever promised one). Reintroduction would need a new explicit product decision, an architecture review, a legal/privacy review, a migration plan and fresh acceptance: [../decisions/clinical-finalization-retired.md](../decisions/clinical-finalization-retired.md). |
| **Blocks** | Neither, now or later. |

## L11 — Rate limiters fail OPEN

| Field | Value |
|---|---|
| **Impact** | If Upstash Redis is unavailable or its env vars are unset, portal and public-booking rate limits are bypassed rather than enforced. |
| **Evidence** | Long-standing documented posture; the Upstash dependency is marked optional. |
| **Current mitigation** | Accepted trade-off — availability over strict throttling on customer-facing surfaces. |
| **Owner** | Sam |
| **Next gate** | Reassess in the deep audit; a fail-closed option for the most sensitive routes is worth considering. |
| **Blocks** | Neither today. Worth an explicit decision during the audit. |

## L12 — Observability consoles are not verifiable from code or CLI alone

| Field | Value |
|---|---|
| **Impact** | Whether Sentry and PostHog are actually receiving production events — and whether `NEXT_PUBLIC_POSTHOG_*` is set in the Vercel environment — could not be confirmed in this reconciliation. |
| **Evidence** | **Unknown pending verification.** The integration code is merged and deployed with hardened settings (`sendDefaultPii` off, deny-by-default scrubbers, Replay/Logs off; PostHog recording/autocapture/exception off, opaque-id identify). The console state itself requires an authenticated dashboard session. |
| **Current mitigation** | `ops_alerts` is a first-party, in-database alerting path that does not depend on either vendor, and it currently shows **0 unresolved alerts**. |
| **Owner** | Sam |
| **Next gate** | Confirm in the Vercel and PostHog consoles during the deep audit. Do not assert either way until then. |
| **Blocks** | Neither. |

## L13 — Consent wording is draft and not lawyer-reviewed

| Field | Value |
|---|---|
| **Impact** | Consent and e-signature templates produce an evidence-friendly record, but enforceability under Ontario law depends on lawyer-reviewed wording that has not happened. |
| **Evidence** | Long-standing documented posture; 19 signatures captured in production under draft wording. |
| **Current mitigation** | Documentation consistently refuses to claim signatures are legally binding. |
| **Owner** | Sam |
| **Next gate** | Lawyer review before relying on enforceability. |
| **Blocks** | **Broader launch** (and is a standing risk for the pilot). |

## L14 — Broad-SaaS SMS is not built

| Field | Value |
|---|---|
| **Impact** | SMS works at pilot scale only. There is no A2P/10DLC registration, no per-studio-versus-shared sender strategy, and no SMS rate limiting. |
| **Evidence** | Env-gated on `TWILIO_*` with per-studio toggle and per-client consent; no registration or sender-strategy code exists. |
| **Current mitigation** | Off by default per studio; consent-gated per client; STOP/HELP handled. |
| **Owner** | Sam |
| **Next gate** | The P0 sender-strategy decision (shared versus per-studio) is still open. |
| **Blocks** | **Broader launch.** |

## L15 — Observation-chip vocabulary is still a placeholder

| Field | Value |
|---|---|
| **Impact** | The structured charting chip list has not been finalized against the real clinical vocabulary. |
| **Evidence** | Long-standing documented posture, carried forward through the Phase A unification. |
| **Current mitigation** | Free text remains available; legacy `reaction_type` values are folded into the unified representation so nothing is lost. |
| **Owner** | Chloe (vocabulary) · Sam (implementation) |
| **Next gate** | Chloe supplies the real list. |
| **Blocks** | Neither. |

## L16 — DB-level charting constraints are deferred

| Field | Value |
|---|---|
| **Impact** | Treatment-area and probe-lot validation is app-layer only; the database does not reject an out-of-vocabulary area written by another path. |
| **Evidence** | Documented deferral — a hard DB whitelist or composite FK would reject legacy rows and needs a grandfathering migration. |
| **Current mitigation** | Server-side canonical validation on every current write path; 0155 adds a real same-studio FK for the inventory-backed probe link. |
| **Owner** | Sam |
| **Next gate** | Deep audit to decide whether this is worth a grandfathering migration. |
| **Blocks** | Neither. |

## L17 — The deep production / security / code audit has not been performed

| Field | Value |
|---|---|
| **Impact** | No comprehensive skeptical audit exists against this baseline. Passing tests and passing gates are **not** evidence that the system is secure. |
| **Evidence** | Not yet performed against `96b28d6` / migration 0157. |
| **Current mitigation** | Per-PR adversarial reviews were run on recent changes; `check-stripe-gates`, the DB/RLS integration lane, the types-drift check and `verify-production.mjs` all run in CI. None of these is a substitute for an audit. |
| **Owner** | Sam |
| **Next gate** | **This is the next substantive engineering/governance work after documentation reconciliation.** |
| **Blocks** | **Broader launch.** |

## L19 — `TRUNCATE` is still granted broadly outside the clinical tables, and two session links are not same-client validated

| Field | Value |
|---|---|
| **Recorded** | 2026-07-29 |
| **Impact** | Two separate residuals, both surfaced by the 0159/0160 review. **(a) `TRUNCATE` breadth.** Supabase's `ALTER DEFAULT PRIVILEGES` granted `TRUNCATE` to `anon` and `authenticated` on essentially every table in `public`. 0159 removed it from the six clinical tables and the three retired ledgers — nine in total — because `TRUNCATE` is statement-level, fires no row trigger and consults no RLS policy, so a grant is the only thing stopping it. It is **still granted on the rest**, including the ordinary operational audit trails this product decision explicitly promises to keep: a studio member's JWT can `truncate public.session_audit` or `public.record_keeping_audit_events` and wipe **every studio's** audit history, because `TRUNCATE` ignores RLS. **(b) Two session links are same-studio but not same-client.** `sessions.treatment_plan_id` and `sessions.appointment_id` can be re-pointed by a direct PostgREST `PATCH` to a plan or appointment belonging to a **different client in the same studio**. Migration 0119 deliberately left both mutable so re-linking and reconciliation keep working, and 0160 therefore does not pin them; the composite FK on `appointment_id` enforces same-studio only. No clinical content moves — the treatment stays on the correct client — so this is a data-quality/linkage defect, not clinical-record corruption. |
| **Evidence** | `has_table_privilege('authenticated','public.session_audit','TRUNCATE')` = true, same for `record_keeping_audit_events`, verified on a fresh CI-parity database; both `truncate` statements reproduced as `authenticated` in rolled-back transactions. The link re-point was reproduced as `authenticated` with a real studio-member JWT: `update public.sessions set treatment_plan_id = <another client's plan>` succeeds. |
| **Current mitigation** | For (a): none beyond the nine tables 0159 covers — deliberately, because a repo-wide `TRUNCATE` sweep is a much larger change than this PR's scope and needs its own verification that nothing (tests, seeds, ops scripts) relies on it. For (b): none; both columns are intentionally mutable. |
| **Owner** | Sam |
| **Next gate** | (a) A separate, explicitly authorized migration doing a repo-wide `revoke truncate on all tables in schema public from anon, authenticated` plus an `ALTER DEFAULT PRIVILEGES` change so new tables do not re-acquire it, with a drift-guard test asserting the matrix. (b) A same-client validation trigger on the two link columns — validate, do not freeze, so re-linking still works. |
| **Blocks** | Neither today. (a) should be closed before the deep audit signs off on the write surface; it is strictly broader than the clinical scope of these PRs. |

## L18 — `authenticated` still holds direct row DML on five clinical tables

| Field | Value |
|---|---|
| **Recorded** | 2026-07-29 |
| **Impact** | A studio member's browser JWT can `INSERT`/`UPDATE`/`DELETE` `public.sessions`, `public.session_blocks`, `public.electrolysis_entries`, `public.laser_entries` and `public.treatment_images` **directly through PostgREST**, bypassing every application command. RLS restricts it to the member's own studio, and migration 0160 pins the lineage columns so a row cannot be moved to another client or encounter — so this is not a cross-tenant or cross-client hole. What it does allow is a member editing clinical rows outside the reviewed server actions, with none of their validation, defaulting or audit behaviour. |
| **Evidence** | `has_table_privilege('authenticated', …)` verified against production 2026-07-29 and against a fresh CI-parity database: `sessions` and `session_blocks` = `SELECT/INSERT/UPDATE/DELETE`; `electrolysis_entries`, `laser_entries`, `treatment_images` = `SELECT/INSERT/UPDATE`. Root cause: Supabase's `ALTER DEFAULT PRIVILEGES` granted these at table creation and **no migration in 0001–0157 ever named `sessions` or `session_blocks` in a grant or revoke at all**. |
| **Current mitigation** | Partial, and deliberately so. **0159** removed every remaining `anon` write privilege and removed `TRUNCATE`/`REFERENCES`/`TRIGGER` from `anon` **and** `authenticated` on all six clinical tables — `TRUNCATE` being the dangerous one, since no RLS policy is consulted for it. **0160** pins the lineage columns immutable. The 26 application call sites are themselves already safe: each derives `studio_id` server-side, validates `(studio, client, session)` lineage, and never writes an identity column from a payload. |
| **Why it is not closed here** | Revoking the row DML requires those 26 call sites to move onto narrow reviewed commands (RPCs or service-role server actions) **first**. Doing it in 0159 would have broken Willow's live charting the moment the migration applied, before any deploy. It is **not** covered by PR #483 / migration 0160, which changes no grant. |
| **Owner** | Sam |
| **Next gate** | A separate, explicitly authorized piece of work: (1) move the 26 direct writers onto narrow commands with the authority checks the existing charting RPCs already model; (2) deploy; (3) only then revoke `INSERT`/`UPDATE`/`DELETE` from `authenticated` on those five tables. Sequence matters — application-first, then the revocation. |
| **Blocks** | Neither today. It should be closed before the deep audit signs off on the clinical write surface. |


---

## Explicitly *not* claimed

To keep this register honest, the following are **not** asserted anywhere in Hone's
documentation, because no evidence supports them:

- That Hone has had "zero incidents". The verified statement is: **0 unresolved `ops_alerts`
  rows at reconciliation time.**
- That Hone is "fully compliant" with any regulatory regime. No compliance assessment exists.
- That security is proven because tests pass. The DB/RLS lane and gate scripts prove specific
  behaviours, not the absence of vulnerabilities.
- That any capability is "live" because a table, migration, component, route or flag exists.
- That Chloe has accepted anything she has not yet tested.
- That Hone offers signed, cryptographically finalized or immutable clinical records. It does
  **not** — that capability is retired (L10). Treatment records are ordinary and editable. What
  Hone does claim is ordinary operational audit: `session_audit`, `record_keeping_audit_events`,
  `session_copy_operations`, `admin_action_events` and `client_portal_access_events`, with actor
  attribution and timestamps.
