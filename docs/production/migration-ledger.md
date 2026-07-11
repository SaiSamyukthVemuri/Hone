# Hone — Migration Ledger

**Canonical migration ledger.** Regenerate the "applied" column from
`supabase migration list --linked`; regenerate the max from
`ls supabase/migrations/ | tail -1`.

- **Production migration max = 0118** (`0118_intake_terminal_immutability.sql`).
- **Applied status:** local repo max == remote (linked project) max == **0118**. Every
  migration `0001`–`0118` is applied in production. 0117 and 0118 were applied
  **migration-first** (0118 is a trigger-only add; the app flows already complied, so no
  code change was needed). 0116 was applied **code-first** — *after* PR #395's hash-only
  code merged + deployed — because it destructively dropped a column the deployed code wrote.
- **Total migrations in repo: 118** (`0001` … `0118`).
- The repo-max is enforced as a test tripwire: the newest migration test
  (`tests/migrations/0118-intake-terminal-immutability.test.ts`) asserts it is
  the repo max, and `tests/scripts/verify-production.test.ts` pins the derived expected max. When a
  new migration lands, those pins move to the new number.

> **Scope of this v1 ledger.** The recent tail (0089–0113) is enumerated below with a
> one-line purpose and applied status. Full per-migration narrative for **0001–0088** lives
> in `docs/09_DATABASE_AND_RLS.md` (migration table + per-range notes) and the per-PR entries
> in `docs/13_BACKLOG_AND_DECISIONS.md` / `docs/14_AI_HANDOFF.md`. A fully generated
> 0001–0113 one-line ledger is a documentation follow-up (see current-state "docs follow-up").

---

## Recent tail (0089 → 0113)

| # | Filename | Purpose | Applied |
|---|---|---|---|
| 0089 | `0089_imported_treatment_memory.sql` | Imported treatment-memory tables (studio-scoped, RLS, read-model) | ✅ |
| 0090 | token hash-at-rest (cancellation) | Hash appointment/cancellation tokens at rest | ✅ |
| 0091 | drop raw cancellation_token column | Destructive hardening after the 0090 hash cutover | ✅ |
| 0092 | `0092_treatment_images.sql` | Private `treatment-images` bucket + metadata table + studio-scoped RLS | ✅ |
| 0093 | `0093_harden_treatment_image_storage.sql` | Service-role-only storage; path/identity CHECKs + integrity trigger | ✅ (NOT pending) |
| 0094 | `0094_tenant_consistency_constraints.sql` | Composite same-studio FKs (sessions/blocks/intake/imported) | ✅ (NOT pending) |
| 0095 | `0095_charting_numbing_probe_lot.sql` | `session_blocks.numbing_status` + `probe_lot_confirmed` | ✅ |
| 0096 | `0096_disinfectant_discard_due_date.sql` | Record-keeping disinfectant "replace by" date | ✅ |
| 0097 | intake link columns | Intake link last-sent / send-count / expires | ✅ |
| 0098 | intake reminder columns | Intake 7d/3d reminder columns + indexes + RPC branches | ✅ |
| 0099 | `0099_treatment_image_notes.sql` | `treatment_images.practitioner_note` | ✅ |
| 0101 | payment live-capability | Make payment rows live-capable (supervised live session payments are now enabled for approved studios) | ✅ |
| 0103 | mode-scoped payment settings | Per-studio test/live payment settings scoping (live/test isolation is live) | ✅ |
| 0105 | mode-scoped attempt uniqueness | Test + live attempt uniqueness per session; underpins live/test card + attempt isolation | ✅ |
| 0106 | `0106_*studio_marketing_tracking*.sql` | Per-studio marketing tracking settings + booking consent | ✅ |
| 0107 | `0107_studio_tracking_encrypted_token.sql` | Encrypted provider token storage + owner-only RLS | ✅ (NOT pending) |
| **0108** | `0108_electrolysis_observation_chips.sql` | **Treatment observation chips** — structured `observation_chips` on `session_blocks`; per-row backfill from legacy `comments` on edit | ✅ |
| **0109** | `0109_studio_time_format_preference.sql` | **Studio 12h/24h time-format preference** (`studios.time_format_preference`, default `12h`; existing studios → 12h) | ✅ |
| **0110** | `0110_studio_postcare_delivery_mode.sql` | **Postcare delivery mode** (`studios.postcare_delivery_mode` text, default `manual`, CHECK `manual`/`auto_on_complete`) — enables opt-in auto-send; default OFF | ✅ |
| **0111** | `0111_client_portal_access_events.sql` | **Client portal access events** — append-only, studio-scoped, SELECT-only RLS (`is_studio_member`), no INSERT/UPDATE/DELETE policy (service-role writes only), composite same-studio FK, no token/URL/PII columns | ✅ |
| **0112** | `0112_public_booking_horizon_expand.sql` | **Public booking horizon 1–12** — widen `studios.public_booking_horizon_months` CHECK from `(3,4,6)` to `(1..12)`; default 3 unchanged; existing values unchanged | ✅ |
| **0113** | `0113_admin_action_events.sql` | **Admin Action Audit Log** — append-only `admin_action_events` (operator-action events). RLS enabled with **no policies** (service-role reads + writes only; admin authorized at the app layer); **no foreign keys** (audit durability); write grants revoked from `authenticated`/`anon`; **no token/URL/IP/email/clinical/payment columns**; metadata allowlisted + redacted | ✅ |
| **0114** | `0114_entry_soft_delete.sql` | **Audited "Remove/void pass"** — adds `deleted_at`/`deleted_by`/`delete_reason` (+ active partial indexes) to `electrolysis_entries` and `laser_entries`, mirroring the `session_blocks` soft-delete triad (0019). Lets a practitioner remove ONE pass from a multi-pass area without hard-deleting the clinical record. **Additive**; nullable; no backfill; **no RLS change** (the pre-existing entry DELETE policy is left intact but unused — the code PR switches the entry delete actions to soft-delete). Applied **migration-first** (before the code merge). | ✅ |
| **0115** | `0115_entry_hard_delete_hardening.sql` | **Entry hard-delete hardening** — closes the residual hard-delete path an independent audit confirmed: **drops** the `for delete to authenticated` RLS policy on `electrolysis_entries` + `laser_entries` (kept by 0087) and **revokes** `truncate, delete` from `anon, authenticated`, so removals go only through the audited soft-delete UPDATE (0114/#391). **Policy/grant-only**; no schema/data change; **hardens** RLS (does not weaken it); `service_role` unaffected (maintenance path preserved). Applied **migration-first**. | ✅ |
| **0116** | `0116_drop_calendar_feed_raw_token.sql` | **Calendar-feed credential hash-only at rest** — **drops** the raw `practitioners.calendar_feed_token` column + its partial unique index (kept `calendar_feed_token_hash` from 0079, which the feed route authenticates by). Removes the only same-studio-member-readable feed credential; raw token now surfaced only once at generate/rotate. Existing subscriptions keep working (hash lookup); no reconnect. **Drop-only**; no other schema/data/RLS change. Applied **code-first** (2026-07-10, after PR #395's hash-only code deployed — destructive drop of a written column). | ✅ |
| **0117** | `0117_session_audit_cross_tenant_insert_hardening.sql` | **session_audit cross-tenant INSERT hardening** — tightens the `session_audit_studio_member_insert` policy so a new audit row's `session_id` must belong to a studio the caller is an active member of (mirrors the SELECT scoping), in addition to the existing actor binding. Closes a confirmed cross-tenant integrity-write (Studio A could attach a fabricated audit event to a Studio B session). **Policy-only** (INSERT policy replaced, stricter); no SELECT/UPDATE/DELETE/grant/schema/data change; **hardens** RLS. A read-only audit found **0** cross-studio-mismatched historical rows. No code change needed (the sole app writer already complied). Applied **migration-first**. | ✅ |
| **0118** | `0118_intake_terminal_immutability.sql` | **Intake terminal-state immutability** — adds a `BEFORE UPDATE` trigger on `client_intake_forms` so that, for authenticated end-users (service-role exempt), once `status ∈ (submitted, reviewed)` the answers (`responses`) and `submitted_at` are immutable, status cannot regress to `in_progress`, and `reviewed_by` must be the caller's own active practitioner (review attribution immutable once reviewed). Closes a same-tenant clinical-record integrity defect (a member could directly PATCH a submitted/reviewed intake). **Trigger-only**; no schema/policy/grant/data change; no RLS weakening. Draft editing, review, and reissue-based corrections (a NEW intake row) are unaffected — the multi-row model already preserves originals. No code change needed. Applied **migration-first**. | ✅ |
| **0119** | `0119_clinical_record_finalization_phase1.sql` | **Clinical Record — Phase 1: finalization boundary.** Additive `sessions` lifecycle (`record_status` draft/finalized/void, `finalized_at/by`, `record_version`, `current_snapshot_id`) + provenance (`record_origin` native/legacy, `legacy_classification`); a studio-scoped `clinical_finalization_enabled` flag (**default OFF**); an immutable **append-only** `clinical_record_snapshots` artifact (RESTRICT/NO-ACTION FKs — **never cascade-deletes**; UPDATE/DELETE blocked for *all* roles); a deterministic **UTC-canonical** snapshot builder (excludes soft-deleted children, image bytes, and operational `price_paid_cents`; captures practitioner display-name evidence); DB **write-guards** freezing the finalized aggregate — sessions clinical/attribution/soft-delete/lifecycle, child `session_blocks`/`electrolysis_entries`/`laser_entries` INSERT+UPDATE+DELETE, and `treatment_images` INSERT/UPDATE/reassign/soft-delete/hard-delete — with **NO service-role / `auth.uid()` / GUC bypass**; a `practitioners` BEFORE DELETE trigger retaining finalized attribution (deactivation still allowed); and a trusted native-only, flag-enforced, min-charting, compare-and-set, idempotent `finalize_session` RPC (session/snapshot version = 1, no increment). **Purely additive + inert** (every existing/new row is `draft`; guards fire only after an explicit, flag-gated finalize), so **migration-first is safe** (no break window). Legacy: all pre-existing rows → `record_origin='legacy'` via metadata-only default (no physical rewrite); `legacy_classification` deferred to a manual review queue (the historical data has no reliable completion signal). **Scope note (honest):** finalized treatment-image *metadata + attachment relationships* are locked; full content-addressed object immutability is a later photo-integrity phase. No treatment-memory read change; no Stripe/payment/email/SMS/booking change; `price_paid_cents`/`appointment_id`/`treatment_plan_id` stay operational/mutable. **✅ APPLIED to hosted 2026-07-10 (migration-first, additive/inert)** — remote max now 0119; read-only verify confirmed all 59 legacy sessions unchanged (`record_origin='legacy'`, `record_status='draft'`, classification/finalized/snapshot NULL), 0 snapshots, `clinical_finalization_enabled=false` for all studios, all guards/triggers enabled, RESTRICT FKs, Stripe gates 15 PASS, 0 unresolved ops alerts. **PR #399 code NOT yet merged/deployed** (the applied schema is inert under the deployed old code until merge). | ✅ applied (code pending merge) |
| **0120** | `0120_clinical_record_corrections_amendments_phase2.sql` | **Clinical Record — Phase 2: corrections & amendments.** Adds two attributable ways to evolve a FINALIZED record without changing/deleting the original: **amendments** (append-only additions — late note / clarification / late photo — recorded in a new append-only `clinical_record_amendments` table; NEVER overwrite a recorded value; no version/normalized change) and **corrections** (fix a wrong value → new immutable snapshot **version N+1**, `record_version`+1 once, supersede the prior version, preserve all priors). Adds snapshot **lineage** columns (`version_type` original/correction, `supersedes_snapshot_id` RESTRICT, `correction_reason`, `corrected_by` RESTRICT, `corrected_by_display_name`, `corrected_at`) + a lineage CHECK; a dedicated append-only **`clinical_audit_events`** table (PHI-safe — ids + version numbers + reason only); a separate studio flag **`clinical_corrections_enabled`** (**default OFF**). The correction path introduces the codebase's FIRST narrow bypass: a **transaction-local, session-scoped GUC `hone.correction_session_id`** the guard permits ONLY when it equals the exact row's `session_id`, set only inside the SECURITY DEFINER `correct_finalized_session` / `amend_finalized_session_with_image` RPCs (structurally unreachable from PostgREST — a client cannot compose a `SET` + frozen-row write in one transaction; row-scoped; auto-discarded at COMMIT/ROLLBACK). Corrections apply through **typed, allow-listed per-entity appliers** (no arbitrary columns; no studio/client/lifecycle reassignment); rebuild + re-hash + re-validate min-charting on the persisted snapshot; are atomic (FOR UPDATE, compare-and-set, one-winner concurrency, no partial commit). `session_audit` left as-is; treatment-memory reads UNCHANGED; no Stripe/payment/email/SMS/booking change. **Purely additive + inert** (gated by the new flag, default OFF; guards only permit the trusted RPCs), so **migration-first is safe**. Legacy rows remain ineligible. **✅ APPLIED to hosted 2026-07-11 (migration-first, additive/inert)** — remote max now 0120; read-only post-apply verify confirmed: existing snapshot count unchanged (1, the synthetic v1, correctly labeled `version_type='original'`), synthetic record still version 1/finalized/unchanged, 59 legacy sessions unchanged, **0 corrections / 0 amendments / 0 audit events created**, `clinical_corrections_enabled=false` for all studios (and `clinical_finalization_enabled` unchanged), lineage columns + CHECK present, both new tables RLS-on + SELECT-only + append-only + RESTRICT FKs (no cascade), guard permit session-scoped with **no** service-role/`auth.uid()`/role bypass, 3 RPCs SECURITY DEFINER + authenticated-only (appliers revoked), Stripe 15 PASS, 0 ops alerts, verifier `Remote migration max = 0120` PASS. **PR #400 code NOT yet merged/deployed** (applied schema inert under the deployed old code until merge; flag OFF everywhere). | ✅ applied (code pending merge) |

(Numbers not listed in the 0100–0107 band, e.g. 0100/0102/0104, are documented per-PR in
`docs/13`/`docs/14`; all are applied — production max is 0113.)

---

## Notes on the newest six (0108–0113)

- **0108 observation chips** — additive; legacy chip data is backfilled from the free-text
  `comments` field **on row edit**, so rows never re-edited retain unstructured chips (a
  known, non-blocking data-quality tail; see the readiness audit).
- **0109 time-format preference** — additive text column, default `12h`; drives client-facing
  time rendering (calendar labels, SMS, emails). Machine values stay 24h.
- **0110 postcare delivery mode** — additive; default `manual` means **no behavior change on
  deploy**. Auto-send is opt-in and fail-soft.
- **0111 client portal access events** — append-only audit log; the table has **no column**
  for any token, URL, IP, email, or clinical/payment value; SELECT-only for studio members;
  inserts only via the app's service-role paths.
- **0112 booking horizon expand** — CHECK-only change; no column add, no default change, no
  data backfill; existing `3/4/6` values remain valid.
- **0113 admin action events** — append-only operator-action audit log; **service-role-only**
  (RLS enabled, no policies + write grants revoked), **no FK** (event survives referenced-row
  deletion), and **no column** for any token, URL, IP, email, or clinical/payment value.
  Applied **migration-first** (before the #374 code merge); reads/writes go only through
  `lib/audit/admin-actions.ts` from `isAdmin`-gated `/admin` code.

## Correcting prior stale statements

Earlier docs (e.g. `docs/09`, `docs/14`) contain "0096 not yet applied", "0095 NOT yet
applied", "0093/0094 must not be applied until approved" language written **before** those
migrations were applied. As of 2026-07-09, **all of 0093, 0094, 0095, 0096, 0107 are applied**
(production max is 0113). Trust this ledger + `supabase migration list --linked`, not the
historical per-PR prose.
