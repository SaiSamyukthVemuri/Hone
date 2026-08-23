# Hone — Known Limitations

**Verified residual limitations as of 2026-08-23**, against the last runtime-bearing application
HEAD `48f0238900c07bd5d2dfed5c1ebbd832e77fdc50` (PR #629). **Repo and hosted migration state are
at parity, with nothing pending** — the reconciling *numbers* are deliberately not written here.
Hosted max is declared once in [`migration-state.json`](./migration-state.json); repo max and the
next free number are derived by `npm run migration:state`; the reconciled position with apply
evidence is [migration-ledger.md](./migration-ledger.md). (`0158` is permanently skipped.)

<!-- canonical-facts:ignore-start reason=quotes-the-superseded-hardcoded-max -->
> **This header used to hardcode its own migration max, and it went stale by 23 releases.** It
> read *"Production migration max is 0162 … next free number is `0163`"* while production stood
> far above that, and the same paragraph simultaneously claimed `0160` was applied *and*
> unapplied. Both defects came from copying a derived number into prose. The numbers are now
> referenced, not restated, and `tests/docs/canonical-production-facts.test.ts` fails the build
> if they come back.
<!-- canonical-facts:ignore-end -->

Only limitations that were **directly verified** in this reconciliation are listed. Items
that could not be checked from code, the CLI, or read-only production queries are recorded
explicitly as *unknown pending verification* rather than asserted in either direction.

**Amended 2026-07-29:** **L9** and **L10** were rewritten because signed / finalized clinical
records are now **RETIRED by product decision**, enforced by migration **0159**. **Amended
2026-07-30: 0159 is APPLIED and verified in production** — the retirement is database-enforced, and
the `hone.correction_session_id` bypass recorded here as live is **closed**. ~~`0160` remains
unapplied.~~ **Corrected 2026-08-23: `0160` was applied and verified on 2026-07-30** — the same
date this very paragraph names two sentences earlier, which is how the contradiction was visible
on the page for three weeks without being seen. They are no longer parked, dormant or gated;
there is no next gate on either. The production facts in both rows were re-verified read-only on 2026-07-29 and
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
| **Impact** | The Phase A charting correction (PR #479) and whole-session copy (PR #478 + migration 0157) are deployed and enabled, and **Chloe has not confirmed that she accepts their behaviour**. Engineering delivery is complete; acceptance is not. |
| **Status by dimension** | **Whole-session copy** — implemented ✅ · DB applied ✅ · deployed ✅ · enabled ✅ · **production exercised ✅** · **human accepted ⏸ PENDING**. **Phase A charting** — implemented ✅ · deployed ✅ · enabled ✅ · **production exercise: not measured for any individual item** · **human accepted ⏸ PENDING**. |
| **Evidence** | `session_copy_operations` = **24 rows, all at Willow**, 2026-07-28T20:39:54Z → 2026-08-23T19:40:49Z *(read-only query, 2026-08-23)*. **No acceptance record exists** for any item; `docs/runbooks/0157-whole-session-copy-rollout.md` still records *"Human acceptance: PENDING"*. **No per-item production-exercise evidence was measured for the Phase A charting items, and none is asserted in either direction.** |
<!-- canonical-facts:ignore-start reason=quotes-the-superseded-zero-row-claim -->
| **What changed 2026-08-23** | This row previously read *"No production copy operation exists (`session_copy_operations` = 0 rows)"*. That is **false** and is corrected. **L2 is CLOSED** on the strength of the same evidence. **L1 is not** — the two limitations were never the same claim: L2 asked whether the feature had ever run, L1 asks whether Chloe accepts it. Only the first has been answered. |
<!-- canonical-facts:ignore-end -->
| **Current mitigation** | Both changes are additive and reversible. Phase A is code-only — rollback is a code revert with no migration to undo. Whole-session copy performs zero writes until an explicit commit. Galvanic-intensity history is preserved rather than deleted. |
| **Owner** | Chloe (operator) · Sam (engineering) |
| **Next gate** | Chloe explicitly confirms she has used and accepts: the unified *Treatment observations & skin response* box; galvanic intensity being gone from new charting; `0.733` displaying as `0.733 seconds`; the *Thermolysis pulse count* label; the larger *Additional notes* field; **and whole-session copy**. **Usage does not substitute for any of these** — 24 operations are evidence of exercise, not of acceptance. |
| **Blocks** | Neither today — but it is the **last gate on calling this release accepted**. |

## L2 — No real production whole-session copy has ever been performed — **CLOSED 2026-08-23 (production evidence)**

> The heading above is preserved verbatim as the historical title of this limitation.
> **It describes the state BEFORE 2026-07-28. It is no longer true.**

| Field | Value |
|---|---|
| **Recorded** | 2026-07-27 |
| **Status** | **CLOSED by production evidence, 2026-08-23.** Whole-session copy is **production exercised**. |
| **Closing evidence** | `session_copy_operations` = **24 rows**, **all 24 on `willow-electrolysis`**, observed range **2026-07-28T20:39:54Z → 2026-08-23T19:40:49Z** *(read-only query, as of 2026-08-23)*. The commit path (`copy_session_setup`), its idempotency guarantee and the provenance ledger have executed repeatedly against real production data. |
| **Historical impact (before 2026-07-28)** | The commit path, the idempotency guarantee, the provenance ledger and the source-locking / stale-source rejection behaviour had **never executed against production data**; they were verified by source inspection and browser testing only. The original deployment verification was deliberately designed to be zero-data-operation, which was the correct posture for a clinical system. That record stands as history. |
| **What this closure does NOT establish** | **Human acceptance.** Usage is evidence of exercise, not of acceptance. Chloe has not confirmed she has used the feature and accepts its behaviour. **Do not infer acceptance from 24 operations.** See **L1**, which remains OPEN. Two narrower gaps also remain unevidenced in production: no **stale-source rejection** and no **duplicate-retry** event has been isolated — the 24 rows are all accept-path commits. |
| **How this went stale** | The 0-row claim was true when written on 2026-07-27 and false from 2026-07-28. It was restated across three canonical documents and elevated into a banned-claims rule in `docs/15_DOCS_MAINTENANCE.md`, and none of those copies was re-read against production for roughly four weeks. |
| **Owner** | Sam (record) · Chloe (acceptance, tracked in L1) |
| **Next gate** | **None for L2 — CLOSED.** |
| **Blocks** | **Neither — CLOSED.** |

## L3 — Direct new-client consultation booking route is deferred

| Field | Value |
|---|---|
| **Impact** | New clients cannot book a consultation through a dedicated direct route. |
| **Evidence** | Product decision recorded 2026-07-27. No code exists **for a direct booking route**. |
| **Not the whole picture for new-client intake** | A **new-client waitlist** does exist and is **live at Willow** (WAIT-01, PR #601, activated 2026-08-19): new-client booking is refused and routed to a waitlist whose commit point is the studio notification email. A **durable** waitlist (WAIT-02B Stage A, migration 0185) is deployed but **dormant and enabled for nobody** — see **L25**. Read this limitation as "no direct route", **not** as "nothing exists for new clients". |
| **Current mitigation** | Existing public booking, the WAIT-01 waitlist at Willow, and operator-side booking cover current pilot volume. |
| **Owner** | Product (Sam) |
| **Next gate** | None scheduled. This is **deferred by product decision**, not blocked on engineering. |
| **Blocks** | **Neither.** Explicitly not a launch blocker and not the next engineering task. |

## L4 — Payment readiness is controlled, not broad

| Field | Value |
|---|---|
| **Impact** | Live payments work for two specifically approved studios. A new studio cannot self-serve into live payments. |
| **Evidence** | *(all counts as of 2026-08-23, read-only query)* `studio_payment_settings` holds live-mode enabled accounts for exactly 2 studios (Willow Electrolysis and the controlled test studio), and `require_card_on_file` is **false on all four of its rows**. Willow has **30 succeeded live charges of 34 attempts**, most recent **2026-08-20T22:48:49Z** — so live payment capability is genuinely production-exercised for her. The 4 non-succeeded attempts are the unresolved alerts in **L26**. The controlled test studio holds 2 succeeded live charges; the Synthetic Twin holds **no payment rows at all**. Refunds: `stripe_refunds` = **0 rows**. Disputes: `stripe_disputes` = **0 rows**. |
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
| **Evidence** | `calendar_connections` = 1 row, on the **controlled test studio only** (`destination_mode='dedicated_app_created'`, connected 2026-07-12). Exactly one real outbound event was ever created: `calendar_sync_outbox` = 1 row (`op_type='event.create'`, `status='done'`, 2026-07-18) with a matching `calendar_event_links` row (`sync_status='synced'`, `hone_to_google'`). Every `google_calendar_outbound_sync_enabled` / `inbound_busy` / `two_way_updates` flag is **false on every studio** — re-verified across all six tenants 2026-08-23, with `google_calendar_connection_enabled` true on the controlled test studio and nowhere else. |
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
| **Evidence** | Product decision 2026-07-29, enforced by migration **0159**: both flags pinned `false` by CHECK constraints (no role can set them); `EXECUTE` revoked from every runtime role on `finalize_session` / `correct_finalized_session` / `amend_finalized_session` / `amend_finalized_session_with_image` / `build_session_snapshot`; `sessions.record_status` transitions into `finalized`/`void` refused; `INSERT` refused on all three signed-record ledgers. Verified production state: both flags **false on every studio** (all six, re-verified 2026-08-23); exactly 1 finalized session + 1 snapshot (hash still re-derives) on the **controlled non-Willow test studio**, retained unchanged; Willow has **0** non-draft sessions; `clinical_record_amendments` = 0 rows; `clinical_audit_events` = 0 rows. |
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
| **Current mitigation** | `ops_alerts` is a first-party, in-database alerting path that does not depend on either vendor. It currently holds **4 unresolved alerts** *(2026-08-23)* — see **L26**; the path is working, and the queue is not empty. |
| **Owner** | Sam |
| **Next gate** | Confirm in the Vercel and PostHog consoles during the deep audit. Do not assert either way until then. |
| **Blocks** | Neither. |

## L13 — Consent wording is draft and not lawyer-reviewed

| Field | Value |
|---|---|
| **Impact** | Consent and e-signature templates produce an evidence-friendly record, but enforceability under Ontario law depends on lawyer-reviewed wording that has not happened. |
| **Evidence** | Long-standing documented posture; **49 consent signatures captured at Willow under draft wording** *(2026-08-23)*, 52 across all tenants. The exposure grew while this row said 19 — which is the point of an as-of stamp. |
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

## L23 — foreign-key referential actions still write `appointments` for a caller holding no privilege on it — **CLOSED 2026-08-09 (migration `0173`)**

> The heading above is preserved verbatim as the historical title of this limitation.
> **It describes the state BEFORE migration `0173`. It is no longer true in production.**

| Field | Value |
|---|---|
| **Recorded** | 2026-08-08, by the adversarial review of appointment boundary B3 (migration `0172`, PR #532 — since **merged and applied to production on 2026-08-09**). |
| **Impact** | A referential action executes as the **constraint's** owner and consults neither the table ACL nor RLS (`appointments` is not `FORCE ROW LEVEL SECURITY`). So `0172`'s revoke — which correctly stops all **direct** DML — does not stop a member from causing a write to `appointments` by deleting a **parent** row. Two paths are reachable from a logged-in browser session: **(a)** any studio member may `DELETE` a `services` row (`services_member_all` is `FOR ALL`), and `appointments_service_same_studio_fk` `ON DELETE SET NULL` nulls `appointments.service_id`; **(b)** an owner may `DELETE` a `practitioners` row ("practitioners: owners delete"), and `appointments_practitioner_same_studio_fk` nulls `appointments.practitioner_id`. The appointment loses its service (pricing, duration provenance, calendar colour) or its practitioner attribution. **The write is entirely silent**: no `appointment_audit` row, no `updated_at` touch, no `sync_version` bump, no Google Calendar outbox enqueue — undetectable by every mechanism the product has. |
| **Evidence** | Reproduced on the local `0172` chain as role `authenticated` with a real member's `request.jwt.claims`: the direct `update public.appointments set service_id = null` is refused `42501 permission denied for table appointments`, while `delete from public.services where id = …` succeeds and the appointment's `service_id` reads null immediately after. The owner/practitioner path reproduces the same way. `pg_constraint.confdeltype` on `appointments` measured as `{client:c, studio:c, practitioner:n, service:n, rescheduled_from:n, rescheduled_to:n}`. |
| **Bounded by** | **Row DELETION is not reachable.** The two `ON DELETE CASCADE` parents — `clients` and `studios` — carry **no DELETE policy at all**, so RLS default-denies the parent delete and the cascade never fires (measured: `DELETE 0` for both as a member). The reachable damage is therefore limited to two columns being nulled, never an appointment or audit row disappearing. |
| **Current mitigation** | None at the database layer. Materially: **the product never deletes a service or a practitioner** — the settings UI hides/deactivates instead (`show_studio_service`), and there is no `.delete()` against either table anywhere in `app/` or `lib/`. This is an unused capability held by a browser role, not a path the application exercises. Both bounds are pinned by tests in `tests/db/appointment-boundary-revocation.db.test.ts`, so a new `CASCADE`, or a DELETE policy appearing on `clients`/`studios`, fails CI rather than silently widening this. |
| **Owner** | Sam |
| **Status** | ✅ **CLOSED / RESOLVED in production by migration `0173`, applied 2026-08-09T12:06:37Z→12:06:47Z (hosted max `0172` → `0173`).** Closed **BY AUTHORITY BOUNDARY**, not by changing referential semantics: `GROUP 5` of `0173` revoked `DELETE` on `public.services` and `public.practitioners` from `anon` and `authenticated`, and removed the DELETE policy residue — `services_member_all` (`FOR ALL`) replaced by explicit `services_member_select` / `_insert` / `_update` (`TO authenticated`, `is_studio_member(studio_id)` reused verbatim), and `"practitioners: owners delete"` dropped outright. Verified read-only after the apply: `anon` and `authenticated` hold **no DELETE** on either parent while `authenticated` **retains** SELECT/INSERT/UPDATE on both; **zero DELETE-capable policies** remain on either table; the practitioners members-read / owners-insert / owners-update policies are preserved unchanged; and `service_role` + `postgres` retain DELETE for maintenance. **THE FOREIGN KEYS THEMSELVES WERE NOT CHANGED** — `appointments_service_same_studio_fk` and `appointments_practitioner_same_studio_fk` are still `ON DELETE SET NULL`, and every appointment parent FK is still `ON UPDATE NO ACTION`. The referential action remains privilege-blind exactly as described above; what changed is that no browser role can any longer trigger the parent delete that fires it. The repair commands in `0173`'s other groups are installed `service_role`-only; **PR #534, which carries the application code, remains unmerged**, so nothing in the deployed app calls them yet. |
| **Next gate** | Belongs to the later appointment-boundary work, **not** to `0172` — closing it means changing grants or FK actions on `services` and `practitioners`, and `0172`'s whole value is being exactly two tables wide and provably no-op for the deployed application. Options, in preference order: revoke `DELETE` on `services`/`practitioners` from `authenticated` (they are already never deleted by the app); or re-point the two FKs to `ON DELETE NO ACTION` so the parent delete fails loudly instead of silently mutating. **`0173`'s GROUP 5 takes the FIRST option and additionally removes the policy residue** — it drops the standalone `"practitioners: owners delete"` policy and splits the `services_member_all` `FOR ALL` policy into explicit `select`/`insert`/`update` policies with no DELETE (the `0087` pattern). Both layers move because a privilege alone can be re-granted out of band by platform tooling, and the surviving `FOR ALL` policy would then reopen this silently. FK referential semantics are deliberately **unchanged** — the authority layer is where this belongs, and altering `ON DELETE` actions would be a schema change with real migration risk and no additional security gain. A census taken for B4 re-confirmed the premise: **zero** runtime hard-deletes of `services` or `practitioners` across every `.delete()` call site in `app/`, `lib/` and `components/`, and no SQL function in 172 prior migrations deletes from either table. Every FK on an appointment parent is additionally `ON UPDATE NO ACTION`, so there is no update-cascade sibling to this hazard — now pinned by a test, because `authenticated` deliberately keeps UPDATE on both parents. |
| **Blocks** | **Nothing — closed.** It was never a blocker for `0172`, which shipped 2026-08-09 and strictly reduced the attack surface without introducing any of this; the paths predated it. `0173` closed the edge itself. |

## L19 — `TRUNCATE` is still granted broadly outside the clinical tables, and two session links are not same-client validated

> The heading above is preserved verbatim as the historical title of this
> limitation (and is pinned by `tests/migrations/0160-immutable-clinical-lineage.test.ts`).
> **Part (a) NARROWED BY TWO TABLES on 2026-08-09, when migration `0172` was
> applied to production.** `0172` (appointment boundary B3) revokes `TRUNCATE`,
> `REFERENCES`, `TRIGGER` and `MAINTAIN` — as well as INSERT/UPDATE/DELETE —
> from `anon` and `authenticated` on `public.appointments` and
> `public.appointment_audit`.
>
> Measured on the local `0172` chain, so the scale is not overstated: **24 of 86
> `public` tables now deny `TRUNCATE` to `authenticated`, up from 22.** The "nine
> tables `0159` covered" figure in the Impact cell below was only ever `0159`'s
> own contribution — `0089`, `0092`, `0111`, `0113`, `0115`, `0119`, `0120`,
> `0126` and `0140` had already revoked it on 13 further tables. So the Impact
> cell's "**still granted on the rest**" is true of the majority but NOT of every
> other operational table. The two named there, `session_audit` and
> `record_keeping_audit_events`, do still carry the default grant, and the
> repo-wide sweep under **Next gate** is still the fix. Part (b) is untouched.
>
> ✅ **`0172` IS MERGED AND APPLIED.** PR #532 merged 2026-08-09T02:21:27Z;
> `0172` applied to production 2026-08-09T02:41:35Z→02:41:45Z, hosted migration
> max `0171` → **`0172`** (reconciled into
> `docs/production/migration-state.json` by PR #538, which remains the
> authority). Verified read-only after the apply: on BOTH `appointments` and
> `appointment_audit`, `anon` and `authenticated` retain `SELECT` and hold none
> of INSERT/UPDATE/DELETE/`TRUNCATE`/`REFERENCES`/`TRIGGER`/`MAINTAIN`.
>
> **L19(a) is therefore NARROWED, NOT CLOSED.** The two appointment tables are
> done; the repo-wide breadth described in the Impact cell is untouched, and the
> two tables named there — `session_audit` and `record_keeping_audit_events` —
> **still carry the default `TRUNCATE` grant in production**. The repo-wide
> sweep under **Next gate** remains the fix. Part (b) is untouched.

| Field | Value |
|---|---|
| **Recorded** | 2026-07-29 |
| **Impact** | Two separate residuals, both surfaced by the 0159/0160 review. **(a) `TRUNCATE` breadth.** Supabase's `ALTER DEFAULT PRIVILEGES` granted `TRUNCATE` to `anon` and `authenticated` on essentially every table in `public`. 0159 removed it from the six clinical tables and the three retired ledgers — nine in total — because `TRUNCATE` is statement-level, fires no row trigger and consults no RLS policy, so a grant is the only thing stopping it. It is **still granted on the rest**, including the ordinary operational audit trails this product decision explicitly promises to keep: a studio member's JWT can `truncate public.session_audit` or `public.record_keeping_audit_events` and wipe **every studio's** audit history, because `TRUNCATE` ignores RLS. **(b) Two session links are same-studio but not same-client.** `sessions.treatment_plan_id` and `sessions.appointment_id` can be re-pointed by a direct PostgREST `PATCH` to a plan or appointment belonging to a **different client in the same studio**. Migration 0119 deliberately left both mutable so re-linking and reconciliation keep working, and 0160 therefore does not pin them; the composite FK on `appointment_id` enforces same-studio only. No clinical content moves — the treatment stays on the correct client — so this is a data-quality/linkage defect, not clinical-record corruption. |
| **Evidence** | `has_table_privilege('authenticated','public.session_audit','TRUNCATE')` = true, same for `record_keeping_audit_events`, verified on a fresh CI-parity database; both `truncate` statements reproduced as `authenticated` in rolled-back transactions. The link re-point was reproduced as `authenticated` with a real studio-member JWT: `update public.sessions set treatment_plan_id = <another client's plan>` succeeds. |
| **Current mitigation** | For (a): none beyond the nine tables 0159 covers — deliberately, because a repo-wide `TRUNCATE` sweep is a much larger change than this PR's scope and needs its own verification that nothing (tests, seeds, ops scripts) relies on it. For (b): none; both columns are intentionally mutable. |
| **Owner** | Sam |
| **Next gate** | (a) A separate, explicitly authorized migration doing a repo-wide `revoke truncate on all tables in schema public from anon, authenticated` plus an `ALTER DEFAULT PRIVILEGES` change so new tables do not re-acquire it, with a drift-guard test asserting the matrix. (b) A same-client validation trigger on the two link columns — validate, do not freeze, so re-linking still works. |
| **Blocks** | Neither today. (a) should be closed before the deep audit signs off on the write surface; it is strictly broader than the clinical scope of these PRs. |

## L18 — `authenticated` still holds direct row DML on five clinical tables — **CLOSED 2026-08-03 (migration `0169`)**

> The heading above is preserved verbatim as the historical title of this
> limitation (and is pinned by `tests/migrations/0160-immutable-clinical-lineage.test.ts`).
> **It describes the state BEFORE migration `0169`. It is no longer true.**

| Field | Value |
|---|---|
| **Recorded** | 2026-07-29 |
<!-- canonical-facts:ignore-start reason=frozen-L18-closure-then-state -->
| **Status** | **CLOSED at the database layer, 2026-08-03.** Migration `0169` was **APPLIED and FROZEN** (2026-08-03T18:25:41Z→18:25:51Z, SHA256 `e8fb5aaa28de9a76c2196a22d60bcf8529d004ba164e570a5c1fe0b6ba5b07b6`). Hosted max = repo max = **0169**; next free **0170**. |
<!-- canonical-facts:ignore-end -->
| **Historical impact (before `0169`)** | A studio member's browser JWT could `INSERT`/`UPDATE`/`DELETE` `public.sessions`, `public.session_blocks`, `public.electrolysis_entries`, `public.laser_entries` and `public.treatment_images` **directly through PostgREST**, bypassing every application command. RLS restricted it to the member's own studio and 0160 pinned the lineage columns, so it was never a cross-tenant or cross-client hole — but it allowed a member editing clinical rows outside the reviewed server actions, with none of their validation, defaulting or audit behaviour. Root cause: Supabase's `ALTER DEFAULT PRIVILEGES` granted these at table creation and no migration in 0001–0157 ever named `sessions` or `session_blocks` in a grant or revoke at all. |
| **Final production posture (after `0169`)** | **`authenticated` clinical write grants: 12 → 0** across `sessions`, `session_blocks`, `session_block_areas`, `electrolysis_entries`, `laser_entries` and `treatment_images`. **`authenticated` SELECT REMAINS** on all six — reads, listings and signed-URL lookups are unaffected. `TRUNCATE` stays denied. **`service_role`, `anon` and PUBLIC posture is UNCHANGED** (PUBLIC holds 0 grants of any kind). All **16 commands** remain `authenticated`-EXECUTE only, `SECURITY DEFINER` with `search_path=""`. **All clinical row counts were unchanged** by the apply: `sessions` 83, `session_blocks` 61, `session_block_areas` 27, `electrolysis_entries` 45, `laser_entries` 2, `treatment_images` 3. |
| **Writer census** | **25 → 0.** `sessions` 10→0, `session_blocks` 7→0, `electrolysis_entries` 4→0, `treatment_images` 3→0, `laser_entries` 1→0, `session_block_areas` 0→0. Every writer is behind one of **16 reviewed commands** (migrations `0164`/`0165`, `0166`, `0167`, `0168`). Pinned by `tests/security/entry-direct-dml-guard.test.ts`, which carries **no exception list**. |
| **`session_block_areas`** | An **explicit no-op** in `0169`: measured in production before the apply, it already had **no** `authenticated` write grant, only SELECT. It is named in the migration so the posture is explicit for all six tables in one auditable place, and so a future grant would have to actively contradict it. |
| **Verification honesty** | ⚠️ **Production behavioural command writes were NOT probed** — the `db query` classifier blocks INSERT/UPDATE-bearing SQL. **The revocation itself WAS directly verified**, through effective `has_table_privilege` and ACL counts, which measure the privilege rather than inferring it. That the commands still *work* with the grants gone is proven on a fresh local stack (126 command cases, 1254-test DB lane) and by a full browser matrix run against the `0169` chain — not against production. |
| **Still required, unchanged by this closure** | ⚠️ **Image storage and Postgres remain separate planes** and cannot share a transaction. The upload's compensating cleanup — remove the uploaded object when metadata creation fails, and raise a **CRITICAL** orphaned-object alert if that removal also fails — **remains required**, and must not be deleted on the grounds that the metadata write is now a command. |
| **Owner** | Sam |
| **Next gate** | **None — CLOSED.** No remaining engineering gate for L18. Reversal, if ever needed, would be a NEW migration re-granting the privileges; `0169` is frozen. |
| **Blocks** | **Neither — CLOSED.** |

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
<!-- canonical-facts:ignore-start reason=frozen-L22-closure-then-state -->
| **Why it remains listed** | The `UPDATE` half is **CLOSED**: `0162` was applied to production 2026-08-02T14:10:32Z→14:10:36Z under explicit authorization; hosted max is now `0162` and the deployed trigger function body is byte-identical to the reviewed source (normalized sha256 `5b2826dd…`). **This entry stays open solely for the INSERT residual in the row above**, which 0162 does not and cannot address. |
<!-- canonical-facts:ignore-end -->
| **Owner** | Sam |
| **Next gate** | Close the INSERT residual (needs its own authorization — it means revoking `INSERT` or adding an INSERT guard, i.e. L18's blast radius). **Separately: production behavioural write-probing was NOT available** — the auto-mode classifier blocks UPDATE-bearing SQL through `supabase db query`, so the synthetic `in_progress -> reviewed` refusal and the legitimate `submitted -> reviewed` success were **not** observed against production. They are proven only by (a) the byte-identical deployed function source and (b) the green real-database `db integration` CI lane at head `dddfae6`. Observing them in production remains an open verification item. |
| **Blocks** | Neither today. `F-CLIN-004`'s **UPDATE** boundary is now database-enforced in production. It must still **not** be described as fully closed: the INSERT path is open, and no production behavioural probe was run — the fix is *source-verified*, not *behaviour-observed*, in production. |

## L24 — Quick Import is not atomic; execution is MITIGATED to operator-assisted only, not fixed

| Field | Value |
|---|---|
| **Impact** | `confirmImportAction` performs three independent statements with **no transaction and no RPC**: insert `import_batches`, bulk-insert `clients`, bulk-insert `imported_treatment_memories`. A failure at the third leaves the second **committed**. Migration 0087 forbids hard-deleting a client, so the created client rows cannot be rolled back — the batch is soft-voided instead. Re-running the identical paste then re-reads existing clients (archived rows included), matches those same rows as confident duplicates and **skips** them, so the file that failed cannot repair the history it failed to write. The studio ends up with clients carrying no treatment memory and no self-service route out. |
| **Evidence** | `app/(app)/settings/import/actions.ts:173-339` (`confirmImportAction`) — batch insert `:212-226`, bulk client insert `:249-264`, memory insert with exactly one retry `:289-314`, soft-void + honest failure copy `:306-312`. Previously recorded in `docs/audits/2026-07-30`. **Reproduced mechanically at production `773dbc70`** before any change, as an ordinary owner with no operator standing and no feature flag: preview succeeded; confirm wrote `import_batches` → `clients`(2) → `imported_treatment_memories`(3) → `import_batches.completed_at`; with the memory insert forced to fail, both attempts failed, the batch was voided, and **2 client rows remained** with no delete and no compensation. |
| **Current mitigation** | **IMPORT-01 (2026-08-12), no migration.** Ordinary studio owners can no longer execute the path. `ownerContext()` — which **both** server actions open with, before their first statement — now requires active studio ownership **and** platform-operator standing (`isImportOperator()` in `lib/import/operator-assist.ts`: verified `supabase.auth.getUser()` email against the existing `isAdmin`/`ADMIN_EMAILS` allowlist, fail-closed in production). The boundary is the **server**: the page also hides the executable island, but a direct POST to `previewImportAction`/`confirmImportAction` is refused on identical terms and writes nothing. `/settings/import` remains as an informational surface (what to prepare + `mailto:support@hone.care`), and Global Search advertises it as "Import clients and history — Operator-assisted". The pipeline itself is **unchanged and preserved** so the rebuild can be built from it. |
| **What is NOT fixed** | The atomicity defect itself. An **operator** running an assisted migration executes the same three-statement path with the same failure mode, and the same non-repairable partial state if the memory insert fails. The mitigation reduces exposure to a supervised operator who can see and correct the outcome; it does not make the import safe. `:316-320` still discards the `completed_at` update's error. |
| **Owner** | Sam |
| **Next gate** | The root fix: a staged / transactional / resumable import (stage rows, one atomic commit or an idempotent resumable batch, and an attach-to-existing-client repair path so a retry can complete a partial import instead of skipping it). Requires its own migration and its own authorization. Until then, do **not** describe Quick Import as safe or self-service. |
| **Blocks** | **Broader launch** for self-service migration. Neither for Willow (assisted migration is the supported route today). |


## L25 — The durable new-client waitlist is deployed DARK: its table would hold prospect PII the public privacy policy does not disclose

| Field | Value |
|---|---|
| **Recorded** | 2026-08-23 (WAIT-02B Stage A, PR #629 + migration 0185) |
| **Impact** | `new_client_waitlist_entries` stores personal information for **prospects** — people who are not yet clients — and the **current public privacy notice does not cover that category**. Enabling any studio today would collect personal data outside every disclosed category. |
| **Evidence** | `NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS` is **absent from the Vercel Production environment** *(verified 2026-08-23 by reading variable **names** only; no value was read)*. `new_client_waitlist_entries` = **0 rows** at apply verification and **0 rows** now. `scripts/check-production-env-gates.mjs` Gate 4 states the reason in its own failure text. |
| **Current mitigation** | **Structural, not procedural.** Gate 4 is an **inverted** build gate: a Vercel **production build FAILS** while the durable allowlist enables one or more studios. It has, in its own words, *"no bypass and no per-studio exception."* Enabling a studio is therefore a **code-and-release action, not an environment-variable flip** — which is a materially stronger guarantee than an unset variable. |
| **What is NOT mitigated** | Nothing about the disclosure gap itself. The gate prevents collection; it does not write the privacy notice. |
| **Owner** | Sam (engineering + release) · Product (disclosure wording) |
| **Next gate** | **Stage B**, in one authorized release carrying: the truthful public disclosure for waitlist prospects; the policy's `lastUpdated` and a future `effectiveDate` consistent with the notice process that policy itself requires; explicit studio-enablement GO; and human activation smoke. |
| **Blocks** | **Stage B only.** Neither Willow nor broader launch today — WAIT-01 is unaffected and remains live at Willow. |

## L26 — Four unresolved `ops_alerts` from failed live charge attempts

| Field | Value |
|---|---|
| **Recorded** | 2026-08-23 |
| **Impact** | Four `session_payment_charge_failed` alerts (severity **warning**) sit unresolved at Willow. Each corresponds to a live-mode charge attempt that did not succeed. Unresolved alerts are the operator's queue; left unattended they erode the signal that makes the queue useful. |
| **Evidence** | `ops_alerts where resolved_at is null` = **4** of 7 rows total, all `session_payment_charge_failed`, all raised **2026-08-23T19:30:48Z–19:32:39Z** *(read-only query, 2026-08-23)*. Willow's live-mode charge record is **30 succeeded of 34 attempts** — the same four events. |
| **Not yet determined** | Whether these were ordinary card declines or something requiring action. The alert payloads were **not** read during this reconciliation, and no cause is asserted. |
| **Current mitigation** | The alert path itself worked: the failures were captured, redacted and surfaced rather than lost. `/admin/ops-alerts` shows them. |
| **Owner** | Sam |
| **Next gate** | Read the four `safe_details` payloads, determine whether any needs action, then resolve or act. Until then, **no document may claim "0 unresolved `ops_alerts`"** — that claim stood unverified for four weeks and is what this entry exists to prevent. |
| **Blocks** | **Neither** today, pending triage. |

---

## Explicitly *not* claimed

To keep this register honest, the following are **not** asserted anywhere in Hone's
documentation, because no evidence supports them:

- That Hone has had "zero incidents". The verified statement is a **count read at a stated
  time**, and that count is currently **4 unresolved `ops_alerts` rows** *(2026-08-23)*, not
  zero. A previous version of this bullet named zero as the verified statement and was carried
  for four weeks without being re-read — the lesson is the *"read it at a stated time"* half,
  not the number.
- That Hone is "fully compliant" with any regulatory regime. No compliance assessment exists.
- That security is proven because tests pass. The DB/RLS lane and gate scripts prove specific
  behaviours, not the absence of vulnerabilities.
- That any capability is "live" because a table, migration, component, route or flag exists.
- That Chloe has accepted anything she has not yet confirmed she accepts. **Note the sharpened
  wording:** whole-session copy *has* now been used in production 24 times (L2, CLOSED), and that
  is still not acceptance. Exercise and acceptance are independent, and only Chloe closes the
  second one.
- Any claim that the durable new-client waitlist has been switched on, or is gathering prospect
  data. It is **deployed and dormant**, its table holds **0 rows**, and no studio is enabled (L25).
- That real-customer activity figures include the Synthetic Twin. They do not, and an
  all-tenant total is never presented as a customer figure — see
  [current-state.md](./current-state.md) §0.
- That Hone offers signed, cryptographically finalized or immutable clinical records. It does
  **not** — that capability is retired (L10). Treatment records are ordinary and editable. What
  Hone does claim is ordinary operational audit: `session_audit`, `record_keeping_audit_events`,
  `session_copy_operations`, `admin_action_events` and `client_portal_access_events`, with actor
  attribution and timestamps.
