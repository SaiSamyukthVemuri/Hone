# Hone — Migration Ledger

**Canonical migration ledger.** Regenerate the "applied" column from
`supabase migration list --linked`; regenerate the max from
`ls supabase/migrations/ | tail -1`.

- **Production migration max = 0112** (`0112_public_booking_horizon_expand.sql`).
- **Total migrations in repo: 112** (`0001` … `0112`).
- **Applied status:** local repo max == remote (linked project) max == **0112**. Every
  migration `0001`–`0112` is applied in production.
- The repo-max is enforced as a test tripwire: the newest migration test
  (`tests/migrations/0112-public-booking-horizon-expand.test.ts`) asserts it is the repo
  max, and `tests/scripts/verify-production.test.ts` pins the derived expected max. When a
  new migration lands, those pins move to the new number.

> **Scope of this v1 ledger.** The recent tail (0089–0112) is enumerated below with a
> one-line purpose and applied status. Full per-migration narrative for **0001–0088** lives
> in `docs/09_DATABASE_AND_RLS.md` (migration table + per-range notes) and the per-PR entries
> in `docs/13_BACKLOG_AND_DECISIONS.md` / `docs/14_AI_HANDOFF.md`. A fully generated
> 0001–0112 one-line ledger is a documentation follow-up (see current-state "docs follow-up").

---

## Recent tail (0089 → 0112)

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
| 0101 | payment live-capability | Make payment rows live-capable (still gated OFF) | ✅ |
| 0103 | mode-scoped payment settings | Per-studio test/live payment settings scoping | ✅ |
| 0105 | mode-scoped attempt uniqueness | Test + live attempt uniqueness per session (0105) | ✅ |
| 0106 | `0106_*studio_marketing_tracking*.sql` | Per-studio marketing tracking settings + booking consent | ✅ |
| 0107 | `0107_studio_tracking_encrypted_token.sql` | Encrypted provider token storage + owner-only RLS | ✅ (NOT pending) |
| **0108** | `0108_electrolysis_observation_chips.sql` | **Treatment observation chips** — structured `observation_chips` on `session_blocks`; per-row backfill from legacy `comments` on edit | ✅ |
| **0109** | `0109_studio_time_format_preference.sql` | **Studio 12h/24h time-format preference** (`studios.time_format_preference`, default `12h`; existing studios → 12h) | ✅ |
| **0110** | `0110_studio_postcare_delivery_mode.sql` | **Postcare delivery mode** (`studios.postcare_delivery_mode` text, default `manual`, CHECK `manual`/`auto_on_complete`) — enables opt-in auto-send; default OFF | ✅ |
| **0111** | `0111_client_portal_access_events.sql` | **Client portal access events** — append-only, studio-scoped, SELECT-only RLS (`is_studio_member`), no INSERT/UPDATE/DELETE policy (service-role writes only), composite same-studio FK, no token/URL/PII columns | ✅ |
| **0112** | `0112_public_booking_horizon_expand.sql` | **Public booking horizon 1–12** — widen `studios.public_booking_horizon_months` CHECK from `(3,4,6)` to `(1..12)`; default 3 unchanged; existing values unchanged | ✅ |

(Numbers not listed in the 0100–0107 band, e.g. 0100/0102/0104, are documented per-PR in
`docs/13`/`docs/14`; all are applied — production max is 0112.)

---

## Notes on the newest five (0108–0112)

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

## Correcting prior stale statements

Earlier docs (e.g. `docs/09`, `docs/14`) contain "0096 not yet applied", "0095 NOT yet
applied", "0093/0094 must not be applied until approved" language written **before** those
migrations were applied. As of 2026-07-08, **all of 0093, 0094, 0095, 0096, 0107 are applied**
(production max is 0112). Trust this ledger + `supabase migration list --linked`, not the
historical per-PR prose.
