# Hone — Known Limitations

**Verified residual limitations as of 2026-07-27**, against application HEAD
`96b28d62a5f3b9acd67d00b24c80caebd6a66e5d` and production migration max **0157**.

Only limitations that were **directly verified** in this reconciliation are listed. Items
that could not be checked from code, the CLI, or read-only production queries are recorded
explicitly as *unknown pending verification* rather than asserted in either direction.

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

## L9 — Finalized clinical photo *content* is not immutable

| Field | Value |
|---|---|
| **Impact** | When a clinical record is finalized, photo **metadata and attachment relationships** are frozen, but the underlying stored object is not content-addressed. Byte-level immutability of the image itself is not proven by the current design. |
| **Evidence** | Stated in the 0119 migration header as an explicit scope note. |
| **Current mitigation** | `treatment-images` is a private bucket, service-role-only, with path/identity CHECKs and an integrity trigger that freezes identity columns after insert. Archive only flips `deleted_at`. |
| **Owner** | Sam |
| **Next gate** | A later photo-integrity phase. Not scheduled. |
| **Blocks** | Neither today — clinical finalization itself is dormant (flag off on every studio). |

## L10 — Clinical finalization and corrections are dormant; the corrections workflow is parked

| Field | Value |
|---|---|
| **Impact** | The finalization boundary and the corrections/amendments backend are deployed but unreachable. No practitioner can finalize, correct or amend a record today. |
| **Evidence** | `clinical_finalization_enabled` and `clinical_corrections_enabled` are **false on all 5 studios**. Exactly 1 finalized session + 1 snapshot exist, both on the **controlled test studio**; Willow has 0. `clinical_record_amendments` = 0 rows; `clinical_audit_events` = 0 rows. |
| **Current mitigation** | Both flags off. The deployed backend — immutable snapshots, version lineage, append-only audit, RLS, and the narrow session-scoped correction permit — is **preserved and must not be weakened**. |
| **Owner** | Sam |
| **Next gate** | The Phase 2 customer-facing workflow is **PARKED**: the current generic 3-field correction UX is unsuitable for practitioner rollout. A full-chart correction workspace is not in the active queue. |
| **Blocks** | Neither today. |

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

## L18 — Finalized structured treatment areas are contained, but not signed and not correctable

| Field | Value |
|---|---|
| **Recorded** | 2026-07-27 |
| **Impact** | `public.session_block_areas` (0128) is the **authoritative** structured treatment-area + per-area laterality record — `lib/sessions/block-areas.ts` prefers it over the legacy `session_blocks.primary_area`/`side` projection. It shipped outside every clinical-integrity mechanism: no 0119 finalized-write guard, `authenticated` holding every table privilege including `TRUNCATE`, no representation in `build_session_snapshot`, and no 0120 correction applier. Migration 0158 **contains** this (finalized-parent trigger for all roles, browser DML revoked, SELECT-only policy, hardened charting RPCs). Containment is **not** tamper-evidence: the signed `content_hash` still does not cover structured areas, and a mis-recorded area on a finalized record cannot be corrected — only frozen. |
| **Evidence** | Verified read-only against production 2026-07-27 at migration max 0157: `clinical_finalization_enabled` and `clinical_corrections_enabled` **false on all 5 studios**; 72 sessions (71 draft, **1 finalized**, on a non-Willow test studio, finalized 2026-07-11T00:42:12Z, **zero** structured-area rows, 1 `original` snapshot); `session_block_areas` = **8 rows across 8 blocks in 1 studio (Willow)** on 2026-07-27, **15 rows** on 2026-07-29 (live charting — re-derive before acting on any count); **0** structured-area rows created after their parent session's `finalized_at`; 0 amendments; 0 `clinical_audit_events`. **Caveat — the table has no `updated_at`, no `deleted_at` and no history table, so the absence of post-finalization *created* rows does NOT prove that no UPDATE or DELETE ever occurred.** That gap is not retroactively reconstructible. |
| **Current mitigation** | **NOT YET APPLIED.** Migration 0158 exists in the repo only — production migration max is 0157 and applying 0158 needs its own explicit migration-only authorization. Until it is applied the defect is live and unmitigated at the database level. What *does* limit exposure today: both clinical flags are false on every studio, so nothing can newly become finalized through the product, and the one existing finalized record has zero structured-area rows. 0158 itself is containment only — schema/privilege, **zero data operations**, no backfill, no snapshot regeneration, no flag change. |
| **Owner** | Sam |
| **Next gate** | **Snapshot v2 + structured-area corrections** — (a) serialize `session_block_areas` into `build_session_snapshot` under a NEW `canonicalization_version` / schema id so existing v1 hashes stay valid and reproducible; (b) add a structured-area correction applier plus the matching narrow session-scoped permit; (c) resolve the already-present 0120 inconsistency where `_apply_block_correction` can correct the legacy `primary_area`/`side` projection on a finalized record while the authoritative rows stay unchanged — a correction the read contract then silently overrides; (d) decide and document the legacy rule for records finalized before v2. See [../runbooks/0158-finalized-structured-area-containment.md](../runbooks/0158-finalized-structured-area-containment.md) §8. |
| **Blocks** | Neither today — clinical finalization is dormant on every studio. But it is a **HARD BLOCKER on enabling `clinical_finalization_enabled` for any studio, Willow included**, until snapshot v2 ships. |

## L19 — `anon` holds full DML on `public.session_blocks` (out of scope, unaddressed)

| Field | Value |
|---|---|
| **Recorded** | 2026-07-27 |
| **Impact** | The role `anon` currently holds `SELECT`, `INSERT`, `UPDATE`, `DELETE` **and `TRUNCATE`** on `public.session_blocks` — a core clinical table; `authenticated` holds the same set. A second consequence surfaced during the 0158 review: because `authenticated` can `UPDATE public.session_blocks` directly, a studio member can move a block — and with it the whole authoritative structured-area set — from one **draft** record to another, including one belonging to a different client, without ever writing `session_block_areas`. 0119's own block on a finalized endpoint is keyed on `record_status` alone and is therefore round-trippable through the 0120 correction permit — so 0158 adds `session_blocks_guard_signed_write`, which refuses the move whenever either endpoint has **ever been signed**. Signed records are safe; the draft-to-draft move remains unguarded and 0158 does not close it. Row-level operations are still filtered by the table's studio-member RLS policies, which an anonymous JWT cannot satisfy (`is_studio_member` resolves through `auth.uid()`). **`TRUNCATE` is not an RLS-checked operation at all**, so no policy is consulted for it; the grant is the only thing standing between an anon-key holder and emptying the table. This is the same class of defect 0157 closed for `session_copy_operations` and 0158 closes for `session_block_areas`. |
| **Evidence** | Observed during the 0158 P0 investigation, read-only against production 2026-07-27 at migration max 0157. Almost certainly a Supabase `ALTER DEFAULT PRIVILEGES` grant that was never revoked — the same root cause migration 0130 had to fix for two charting RPCs. |
| **Current mitigation** | **None applied.** No exploit or loss is claimed or evidenced; this is a standing privilege exposure, not an incident. |
| **Owner** | Sam |
| **Next gate** | A separate, explicitly authorized migration: `revoke all on public.session_blocks from anon`, then re-grant only what is genuinely required (expected: nothing — no anon surface reads session blocks). **This requires its own authorization and its own review; it is deliberately NOT addressed by the 0158 containment PR**, which is scoped to `session_block_areas` alone. The same sweep should re-audit every clinical table's `anon` privilege set rather than fixing one table at a time. |
| **Blocks** | Neither today — but it should be closed before the deep audit signs off on the clinical surface. |

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
