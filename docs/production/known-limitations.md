# Hone — Known Limitations

**Verified residual limitations as of 2026-07-27**, against application HEAD
`96b28d62a5f3b9acd67d00b24c80caebd6a66e5d`. **Production migration max is 0162**, applied and
verified 2026-08-02 (`0162` intake review transition integrity). Preceding applies: `0161`
(service order + colours) 2026-07-30, and `0159` (signed-record retirement) + `0160` (immutable
clinical lineage) 2026-07-30. Repo and hosted are at **parity**; next free number is `0163`
(`0158` permanently skipped).

Only limitations that were **directly verified** in this reconciliation are listed. Items
that could not be checked from code, the CLI, or read-only production queries are recorded
explicitly as *unknown pending verification* rather than asserted in either direction.

**Amended 2026-07-29:** **L9** and **L10** were rewritten because signed / finalized clinical
records are now **RETIRED by product decision**, enforced by migration **0159**. **Amended
2026-07-30: 0159 is APPLIED and verified in production** — the retirement is database-enforced, and
the `hone.correction_session_id` bypass recorded here as live is **closed**. `0160` remains
unapplied. They are no longer parked, dormant or gated; there is no next
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

## L20 — `service_role` retains `TRIGGER` on the clinical tables, so 0160's guards are not tamper-proof against it

| Field | Value |
|---|---|
| **Recorded** | 2026-07-30 (surfaced by the PR #483 / migration 0160 adversarial review) |
| **Impact** | Migration 0160 enforces record lineage entirely with `BEFORE UPDATE` triggers, but Supabase's default `grant all` leaves `TRIGGER` on `public.sessions`, `public.session_blocks`, `public.electrolysis_entries` and `public.laser_entries` for `service_role` (`anon` and `authenticated` correctly do **not** hold it). `CREATE TRIGGER` needs only the `TRIGGER` privilege plus `EXECUTE` on the function — not ownership — and `BEFORE ROW` triggers fire in **alphabetical name order**. So a DDL-capable `service_role` session could attach a trigger sorting after `sessions_immutable_lineage`, let the guard approve an unchanged `NEW`, and then overwrite the lineage column. Separately, the table owner can set `session_replication_role = 'replica'`, which silently disables all five guards. |
| **Evidence** | `has_table_privilege('service_role', …, 'TRIGGER')` = true on all four tables; the bypass was reproduced verbatim on a CI-parity database in a rolled-back transaction, using a helper function created in `pg_temp` (`service_role` cannot `CREATE FUNCTION` in `public`). The `session_replication_role` bypass was likewise reproduced as the table owner. |
| **Reachability** | **Not reachable from the browser or from the application.** `service_role` is `NOLOGIN`; the only path to it is PostgREST via `authenticator`, which issues DML and RPC calls only — never DDL. A scan of `pg_proc` found **zero** `SECURITY DEFINER` functions granted to `anon`/`authenticated`/`service_role` that execute caller-controlled dynamic SQL. `session_replication_role` requires superuser or the table owner. |
| **Current mitigation** | None beyond the above. This is a **defence-in-depth** gap, not an exploitable hole: it presumes an attacker who already has DDL against the production database, at which point they could simply `DROP TRIGGER`. |
| **Owner** | Sam |
| **Next gate** | Fold `revoke trigger on public.sessions, public.session_blocks, public.electrolysis_entries, public.laser_entries from service_role` into the same separately-authorized, repo-wide privilege sweep that L19(a) already requires — the two share a root cause (Supabase's default grants) and should be verified together rather than piecemeal in a lineage migration. |
| **Blocks** | Neither today. It did **not** block migration 0160, which is now applied — its guards are effective against every role reachable from the application. **This limitation remains OPEN.** |

## L21 — hard-deleting a session in the SAME transaction that created a block-attached treatment image fails

| Field | Value |
|---|---|
| **Recorded** | 2026-07-30 (surfaced by the PR #483 review; **pre-existing, and proven migration-0160-neutral**) |
| **Impact** | Deleting a `sessions` row raises `23503` against `treatment_images_session_block_id_fkey` when a `treatment_images` row carrying **both** `session_id` and `session_block_id` was inserted by the *same* transaction. Two independent `ON DELETE SET NULL` paths fire on `treatment_images` (its own `session_id` FK, and the `session_blocks` cascade); PostgreSQL skips the FK re-check on a key-preserving UPDATE only when the old row was not inserted by the current transaction, so for a same-transaction row the `session_id` SET NULL is forced to re-verify the block FK after the cascade has already removed the block. |
| **Evidence** | Reproduced on a CI-parity database, then independently re-reproduced from scratch by a second reviewer. Proven **not** caused by 0160: the failure is byte-identical with all five 0160 triggers dropped, and again with *every* trigger on `treatment_images` dropped. A control with `session_block_id` NULL deletes cleanly, isolating the two-SET-NULL interaction. In autocommit — rows committed in earlier transactions — the delete succeeds, which is why `tests/db/treatment-image-hardening.db.test.ts` passes today. |
| **Reachability** | **Unreachable from the application.** No `DELETE` or `ALL` RLS policy exists on `sessions`, `session_blocks` or `treatment_images`, and RLS is enabled on the parents, so the raw `DELETE` grant held by `authenticated` affects zero rows. Nothing in `app/`, `lib/` or `components/` hard-deletes sessions or blocks. |
| **Current mitigation** | None needed today. Recorded so a future admin or right-to-erasure routine that wraps seed-and-delete in one transaction is not surprised by it. |
| **Owner** | Sam |
| **Next gate** | Only if an in-transaction hard-delete path is ever built. The fix would be to null `session_block_id` before deleting the parent, or to delete the image rows first. |
| **Blocks** | Nothing. Explicitly **not** a blocker for migration 0160, which is now applied. **This limitation remains OPEN.** |

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
| **Partial carve-out (0163, APPLIED 2026-08-02)** | `client_intake_forms` authenticated INSERT residual closed by 0163; broader direct clinical DML findings remain open. Migration `0163` was **APPLIED to production 2026-08-02T17:37Z** and removes `INSERT` on `client_intake_forms` from `authenticated` and `anon` (verified by effective `has_table_privilege`: both **false**). That table is **not** one of the five listed above and this changes none of them: `sessions`, `session_blocks`, `electrolysis_entries`, `laser_entries` and `treatment_images` keep their direct row DML, and the 26 call sites still need to move onto narrow commands first. **L18 remains OPEN.** |
| **Phase 1A (migration `0164`, NOT APPLIED)** | PARTIAL — the clean laser-entry creation path uses a narrow command. Electrolysis entry writers remain direct because each relevant user workflow can depend on `session_blocks` and must move atomically in the combined phase. Direct table grants remain in place. `addLaserEntryAction` now calls `create_laser_entry` — SECURITY DEFINER, `search_path=''`, non-null `auth.uid()` required, studio and client derived from the trusted `sessions` row, EXECUTE granted to `authenticated` only. **All three electrolysis writers remain direct and are deferred to the combined phase**, including `addElectrolysisEntryAction`: addElectrolysisEntryAction can create a default session_blocks row through ensureBlockForSession before creating the electrolysis entry; the two writes are not atomic today and must move together. All three are pinned as the only exceptions by `tests/security/entry-direct-dml-guard.test.ts`. **Verified writer census: 25, not the 26 recorded above** — see [l18-command-inventory.md](./l18-command-inventory.md). |
| **Blocks** | Neither today. It should be closed before the deep audit signs off on the clinical write surface. |

## L22 — `F-CLIN-004`: the intake review UPDATE and INSERT boundaries are both CLOSED

**Status: APPLICATION DEPLOYED · MIGRATION 0162 APPLIED 2026-08-02 (UPDATE boundary) · MIGRATION 0163 APPLIED 2026-08-02 (INSERT boundary).** `client_intake_forms` authenticated INSERT residual closed by 0163; broader direct clinical DML findings remain open.

| Field | Value |
|---|---|
| **Recorded** | 2026-08-01 (amended the same day when migration 0162 was written) |
| **Impact** | `F-CLIN-004` is the "Mark reviewed accepts an unsubmitted intake, and any intake in the studio" finding. **The application and UI half is MERGED AND DEPLOYED** (PR #497, merge `b7d85f5`, Vercel production success): the review action is one conditional `UPDATE` requiring `id` + server-derived `studio_id` + the submitted `client_id` + `deleted_at is null` + `status = 'submitted'` + `submitted_at is not null`, proving exactly one affected row, and the CTA is no longer rendered for an `in_progress` intake at all. **What is still live in production:** an authenticated studio member can drive `in_progress -> reviewed` by a **direct PostgREST `PATCH`**, bypassing the application. Migration **0118** does not stop it — all of its review guards are nested under `if old.status in ('submitted','reviewed')`, which an `in_progress` OLD row never enters. |
| **Evidence** | Proved by a real authenticated PostgREST/SQL probe on the migrated local database at migration max 0161: `old.status = in_progress`, `new.status = reviewed`, `submitted_at = NULL`, result **`UPDATE 1`**; `reviewed_at` and `reviewed_by` were accepted. Cause verified in the trigger source (`enforce_intake_terminal_immutability`, `supabase/migrations/0118_intake_terminal_immutability.sql:50`). Every probe row was synthetic and confined to the disposable local database. |
| **What now exists** | Migration **`0162_intake_review_transition_integrity.sql`** is written, applied to a fresh local database, and covered by `tests/db/intake-review-db-boundary.db.test.ts` — the former canary, now **inverted**: the case that used to assert `UPDATE 1` now asserts rejection. It replaces the 0118 function body (same trigger name, still `SECURITY INVOKER`, still `search_path = ''`) and requires, for any `new.status = 'reviewed'` where `old.status IS DISTINCT FROM 'reviewed'`: `old.status = 'submitted'`; `old.submitted_at IS NOT NULL`; `new.submitted_at` unchanged; a non-null `reviewed_by` that is an **active practitioner owned by `auth.uid()` in `old.studio_id`**. **`reviewed_at` is stamped by the database** (`transaction_timestamp()`), so a backdated or future value cannot be forged. It further makes `reviewed` terminal for end users — closing a two-step `reviewed -> submitted -> reviewed` attribution-laundering path 0118 left open — and forbids review metadata on a non-reviewed row. Service-role review transitions **fail closed**; the service-role client submission, inserts and link-metadata writes are untouched. |
| **Production reality** | A read-only aggregate over `client_intake_forms` (counts only; no ids, no answers, no notes, no client/practitioner identity) found **zero inconsistent rows** across both studios: no `reviewed` row with a NULL `submitted_at`, NULL `reviewed_at` or NULL `reviewed_by`, and no `in_progress` row carrying review metadata. Willow Electrolysis: 7 `in_progress`, 2 `submitted`, 16 `reviewed`. My Studio: 1 / 1 / 3. **Zero inconsistent rows does not close the reachable defect** — it means the defect has not been exercised, not that it cannot be. 0162 changes no existing row, so applying it would not correct an inconsistent row if one appeared; that would need a separate, explicitly authorized reconciliation with the practitioner, never a silent downgrade. |
| **Current mitigation** | The ordinary route is closed and deployed. The residual path requires a studio member to deliberately craft a PostgREST request against their own studio's data. |
| **Residual — the INSERT path, CLOSED by 0163 (APPLIED 2026-08-02)** | 0162's guard is a BEFORE **UPDATE** trigger, so it never fires on INSERT. An authenticated studio member could create a brand-new intake row already **`reviewed`**, with a NULL `submitted_at` and a forged historical `reviewed_at` — `authenticated` held `INSERT` and the INSERT policy's `WITH CHECK` was only `is_studio_member(studio_id)`. **Migration `0163_revoke_authenticated_intake_insert.sql` closes it** by dropping `client_intake_forms_member_insert` (plus any legacy `FOR ALL` policy, defensively) and REVOKEing `INSERT` from **both** `authenticated` and `anon`. A caller audit at `b176f11` found ZERO legitimate authenticated INSERT paths — both runtime writers (`ensureIntakeForClient`, `createIntakeRequestForClient`) use the service-role admin client — so the capability is removed outright rather than constrained. `authenticated` SELECT and UPDATE, and service-role INSERT, are preserved. **0163 was APPLIED to production 2026-08-02T17:37:23Z→17:37:27Z** (hosted max `0163`), so this residual is CLOSED in production: effective `has_table_privilege` for `anon` and `authenticated` INSERT is **false**, the table ACL lost the `a` bit for both, and `pg_policies` holds only the SELECT and UPDATE policies. `authenticated` SELECT/UPDATE and `service_role` INSERT are preserved; 0162's trigger function md5 is unchanged. The old `RESIDUAL: the INSERT path is NOT closed by 0162` cases have been INVERTED, and the full matrix lives in `tests/db/intake-insert-boundary.db.test.ts`. Scope: `client_intake_forms` authenticated INSERT residual closed by 0163; broader direct clinical DML findings remain open. |
| **Why it remains listed** | The `UPDATE` half is **CLOSED**: `0162` was applied to production 2026-08-02T14:10:32Z→14:10:36Z under explicit authorization; hosted max is now `0162` and the deployed trigger function body is byte-identical to the reviewed source (normalized sha256 `5b2826dd…`). **This entry stays open solely for the INSERT residual in the row above**, which 0162 does not and cannot address. |
| **Owner** | Sam |
| **Next gate** | Close the INSERT residual (needs its own authorization — it means revoking `INSERT` or adding an INSERT guard, i.e. L18's blast radius). **Separately: production behavioural write-probing was NOT available** — the auto-mode classifier blocks UPDATE-bearing SQL through `supabase db query`, so the synthetic `in_progress -> reviewed` refusal and the legitimate `submitted -> reviewed` success were **not** observed against production. They are proven only by (a) the byte-identical deployed function source and (b) the green real-database `db integration` CI lane at head `dddfae6`. Observing them in production remains an open verification item. |
| **Blocks** | Neither today. `F-CLIN-004`'s **UPDATE** boundary is now database-enforced in production. It must still **not** be described as fully closed: the INSERT path is open, and no production behavioural probe was run — the fix is *source-verified*, not *behaviour-observed*, in production. |


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
