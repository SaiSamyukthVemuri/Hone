# Google Calendar Two-Way Sync — Architecture

Canonical design for Hone's Google Calendar integration across all phases.
**Deployed today (all dormant): Phase A (connection & OAuth foundation), the Phase
B1 outbound-sync schema/queue foundation (0124), the B2.3-a enqueue+claim activation
boundary (0125), and the B2.4 dual-destination scope contract (0131).** Everything
that actually *moves an event* — the drain worker calling Google, inbound busy,
two-way edits — is design intent, not shipped. When this doc and the code disagree,
the code + the migration ledger win.

- **Status:** Phase A (migrations 0121/0122), **Phase B1** outbound-sync schema
  (0124, PR #407), **Phase B2.3-a** enqueue + claim activation boundary (0125), and
  **Phase B2.4** dual outbound destination + destination-derived event scope (0131)
  are **all APPLIED to production and DORMANT** (**hosted migration max = 0131**;
  B2.4 = PR #424 merged + deployed + operator-validated dormant 2026-07-14, see the
  owner-connection operator checklist §6). B2.4 deliberately **precedes** B2.3-b /
  B2.3-c and finalizes the outbound destination + scope semantics those phases
  consume. Granting a destination permission or creating the empty Hone-owned
  calendar still enables **no** synchronization.
  **Phase B2.3-b** (reconciliation sweep + heartbeat + authenticated route) is
  **authored in-repo (this PR), DORMANT, and adds NO migration** (hosted max stays
  **0131**): the `/api/cron/calendar-reconcile` route exists but is **not**
  cron-registered, actuates only within intent-eligible studios (of which production
  has none), never calls Google, and never enables the worker or any flag — see §3e.
  All Google flags default **OFF** (only Sam's `google_calendar_connection_enabled`
  is ON, on his controlled studio; all sync flags OFF). **No event sync runs:** no
  worker, no enqueue path (0125 adds triggers but they no-op while every studio's
  outbound flag is OFF), no trigger enqueues, no Google event has been created or
  modified, no Google API call has occurred, and no event scope has been requested.
- **Production exercised:** the Phase A OAuth connection was exercised once on **Sam's
  controlled studio** (one connection exists). **Phase B1 outbox/event-link behavior
  has NOT been production-exercised** — `calendar_event_links` and `calendar_sync_outbox`
  are empty (0 rows).
- **Willow:** not connected; all Google flags OFF. Willow is never used for initial
  integration testing (see §Rollout). No sync feature is approved for Willow.

---

## 1. Product constraint: Hone scheduling is studio-wide today

Hone computes public availability at the **studio** level, not per practitioner.
All unavailability (appointments + timed blocks + full-day blockouts + recurring
breaks) is mirrored by DB triggers into one studio-scoped shadow table,
`studio_calendar_reservations` (migration 0030), guarded by a **per-studio GiST
exclusion** that forbids any overlap. There is no per-practitioner or
per-appointment timezone; the single source is `studios.timezone`.

Consequence for this integration:

- The connection schema is **practitioner-scoped** (OAuth is a per-user grant;
  `practitioners.calendar_feed_token_hash` is already per-practitioner) so it is
  future-proof.
- But during the current studio-wide model, Hone designates **exactly one**
  practitioner connection as the studio's calendar owner
  (`calendar_connections.is_studio_calendar_owner`, at most one active per studio).
  That owner's connected calendar will be the future **write target** and, once
  inbound busy ships, its imported busy time will block the **whole studio**.
- **Calendar-owner and write-target are the SAME designation today** — modeled as
  one boolean, `is_studio_calendar_owner`, deliberately not two. They may split
  later when Hone becomes practitioner-resource-aware (see §Future).

**Google busy integration must not ship** until either (A) it intentionally
blocks the whole studio for the designated calendar owner, or (B) Hone's booking
becomes practitioner-resource-aware. This is a hard gate on Phase C.

### Future migration to practitioner-aware scheduling

When Hone adds per-practitioner booking resources, availability computation
(`lib/booking/slots.ts::getAvailableSlots`) will filter reservations + external
busy by the practitioner being booked, and the single `is_studio_calendar_owner`
designation can be joined by a separate `is_write_target` role. The Phase A
schema already carries per-practitioner rows and per-practitioner busy scope, so
that transition is additive.

---

## 2. Dependency choice: direct REST via `fetch` (not `googleapis`)

Chosen: **Option B — direct OAuth + Calendar REST via server-side `fetch`.**
Rationale:

| Criterion | `fetch` (chosen) | `googleapis` |
|---|---|---|
| Bundle / audit surface | zero new deps; native to Node runtime | tens of MB, hundreds of transitive types + a new audit surface |
| Token refresh | explicit; matches our encrypt-at-rest + worker model | implicit auto-refresh hides token state we must manage |
| Testability | mock one thin `fetch` client | heavier client-object mocking |
| Type safety | narrow declared types for the fields we consume | large mostly-unused type surface |
| Maintenance | ~4 hand-written request builders | library upgrades |

Trade-off accepted: we hand-write the request builders (`lib/google-calendar/oauth.ts`).
Revisit only if a later phase needs batch/watch ergonomics the library materially
simplifies.

---

## 3. Data model (Phase A)

Migrations **0121** (connection foundation) + **0122** (OAuth state). All additive,
dormant, default-deny where secret.

- **`calendar_connections`** — per-practitioner, NON-SECRET metadata: google
  account id/email, `write_calendar_id`, `connection_status`, `granted_scopes`,
  `token_expires_at` (operational only), `is_studio_calendar_owner`, health
  fields. Member-readable (`is_studio_member` SELECT); writes service-role only.
  Uniques: one per practitioner; at most one owner per studio (partial); companion
  `(id, studio_id)` for child composite FKs. Same-studio composite FK to
  `practitioners(id, studio_id)`.
- **`calendar_connection_secrets`** — the ONLY place ciphertext lives.
  `encrypted_refresh_token`, `refresh_token_last4`, `encryption_key_version`.
  **RLS on + NO browser-role policy + explicit REVOKE** = a same-studio peer can
  never read another practitioner's token (the explicit close of the 0116
  raw-feed-token peer-read lesson). Token expiry is NOT stored here (it is
  operational metadata on `calendar_connections`); the access token is not
  persisted at all in Phase A.
- **`google_oauth_states`** — single-use OAuth binding: state stored hash-only,
  session nonce stored hash-only (raw nonce is an httpOnly cookie), PKCE verifier
  **encrypted**, 10-min TTL, `consumed_at` CAS, same-studio composite FK.
  Default-deny (RLS + REVOKE), service-role only.

Deliberately NOT created in Phase A: `calendar_event_links`,
`external_calendar_busy_events`, any outbox, webhook/watch tables.

---

## 3b. Data model & queue foundation (Phase B — PR B1, migration 0124)

Migration **0124** adds the **dormant** outbound-sync schema and durable queue.
It is additive and default-deny where sensitive; it introduces **no runtime
behavior** — no enqueue is wired, no drain worker exists, no Google event API is
called, no studio flag turns anything on. It is the schema/queue substrate that
Phase B2 (the enqueue + drain worker) will build on. Behavioral proof:
`tests/db/google-calendar-outbound-sync.db.test.ts`; static/shape proof:
`tests/migrations/0124-…test.ts`; positive-dormancy proof (no runtime module
references the new surface): `tests/app/google-calendar/outbound-sync-dormant.test.ts`.

- **`calendar_event_links`** — maps a Hone entity to its Google event.
  Polymorphic by design: `hone_entity_type ∈ {appointment, timed_block}` +
  `hone_entity_id`, with **no** direct FK to `appointments`/`studio_timed_blocks`
  (a linked entity can be hard-deleted; the link is soft-deleted/reconciled, not
  cascaded away). Holds `google_calendar_id`, `google_event_id` (null until the
  create round-trips), `google_ical_uid`, `google_etag`, `sync_status ∈
  {pending,synced,conflict,error,deleted}`, `last_sync_direction`,
  `last_hone_version` (**metadata only** — a monotonic marker for a future
  compare-before-write; nothing reads it in B1), `source_system ∈ {hone,google}`,
  and `deleted_at` for soft delete. Same-studio composite FK to
  `calendar_connections(id, studio_id)` **ON DELETE RESTRICT**. Two partial
  uniques: one **active** link per Hone entity (`WHERE deleted_at is null`) and
  one **active** mapping per `(connection, google_calendar_id, google_event_id)`
  (`WHERE google_event_id is not null and deleted_at is null`) — soft-deleting a
  link frees both slots for a clean replacement. **Member-readable**
  (`is_studio_member` SELECT) so a settings/health view can show link state; all
  writes are service-role only (the member SELECT policy is added now to avoid a
  later policy-only migration).
- **`calendar_sync_outbox`** — the durable transactional outbox (one row per
  pending Google operation). `op_type ∈ {event.create, event.update,
  event.delete, full.resync}`; entity ops carry `hone_entity_type` +
  `hone_entity_id`, `full.resync` carries neither (a CHECK enforces this).
  `payload jsonb` is **operational metadata only** (see §6). **Four-state model:
  `status ∈ {pending, processing, done, dead}`** — there is no separate `failed`
  state; a retryable failure returns to `pending`, exhaustion is `dead`.
  `priority integer` (**0..1000, lower = higher priority, default 100**),
  `attempts`/`max_attempts` (`attempts ≤ max_attempts`, `max_attempts > 0`),
  `next_attempt_at`, lease fields (`claimed_at`, `claim_token`,
  `lease_expires_at`), diagnostics (`last_error_code`, `last_error_message`),
  and `processed_at` (set **only** on a terminal `done`). A bidirectional CHECK
  ties the claim metadata to the `processing` state (all three set iff
  processing; all null otherwise). Same-studio composite FK **ON DELETE
  RESTRICT**. **Default-deny** (RLS on + REVOKE ALL from browser roles + no
  policy; service-role only) — the queue is invisible to the browser.
- **Idempotency key** — `calendar_sync_outbox.idempotency_key` carries a
  deterministic key `{hone_entity_type}:{hone_entity_id}:{op_type}:{source_version}`
  under a **FULL** unique index (across *all* statuses, no `WHERE`), so an enqueue
  is exactly-once even against an already-`done` or `dead` row. Recovery from a
  `dead` key is an explicit `source_version` bump or a `full.resync`, never a
  silent re-enqueue. **`sync_generation` is deferred to B2** — the epoch/fence for
  a disconnect→reconnect that must invalidate in-flight ops is documented in the
  migration and here, but intentionally not added in B1 (adding it now would be a
  dormant column with no writer).

### Claim / result RPCs (trusted, service-role only)

Two `SECURITY DEFINER` RPCs (pinned `search_path`, `EXECUTE` granted to
`service_role` only — `authenticated`/`anon` cannot call them) form the queue
contract the future drain worker will use. They exist but are **called by
nothing** in B1.

- **`claim_calendar_sync_op(p_batch_size)`** — bounded batch (clamped to **1..25**),
  `FOR UPDATE SKIP LOCKED`, claims due work `ORDER BY priority ASC, next_attempt_at
  ASC, created_at ASC`, stamps a fresh `claim_token` + a **fixed 5-minute lease**,
  increments `attempts`, and returns **safe operational fields only** (never
  credential material). It is claimable when `pending` and due, or when
  `processing` with an **expired lease** (crash recovery) and under the attempt
  cap. **Orphan reaper:** a `processing` row whose lease has expired **and** is
  already at `max_attempts` is transitioned to **`dead`** (claim metadata cleared,
  `processed_at` left null) *inside* the claim call rather than being handed out
  again — so a worker that dies at the attempt ceiling cannot strand a row in
  `processing` forever.
- **`record_calendar_sync_result(id, claim_token, ok, error_code, error_message,
  retry_after_seconds)`** — validates the `claim_token` (mismatch/stale →
  `stale_token`, no-op) and the terminal state (`done`/`dead` → `already_*`,
  no-op). On success → `done`, sets `processed_at`, clears the lease, **retains**
  prior diagnostics. On a retryable failure → back to `pending` at
  `now() + retry_after_seconds` (**bounded 5s..21600s**; out-of-range raises), lease
  cleared, diagnostics set. On exhaustion (`attempts ≥ max_attempts`) → `dead`,
  `processed_at` stays null, `last_error_message` capped to 500 chars. Backoff is
  **caller-supplied and bounded** in B1 (the worker owns the curve); the RPC only
  enforces the envelope.

### Connection teardown & the RESTRICT decision

Both new tables use `ON DELETE RESTRICT` to `calendar_connections`. The deployed
disconnect path (`lib/google-calendar/connection.ts::disconnectConnection`)
**does not delete** the connection row — it deletes the secrets row and *updates*
the connection to `status='disconnected'`, `disconnected_at`,
`is_studio_calendar_owner=false`. So RESTRICT never blocks a normal disconnect;
it only guards a *hard delete* of the connection while links/queue rows still
reference it. The one path that *would* hard-delete a connection is a
**practitioner or studio removal** (0121's connection→practitioner/studio FK is
`ON DELETE CASCADE`); with RESTRICT children present, that delete now blocks.
**Reconciliation is a B2 responsibility, not B1.** Because `ON DELETE RESTRICT`
also counts *soft-deleted* rows, soft-deleting the links does **not** release the
FK. Tenant teardown therefore **hard-purges** the studio's `calendar_sync_outbox`
rows and then its `calendar_event_links` rows (both reference
`calendar_connections`) in the same transaction as, and before, the
practitioner/studio removal — after which the CASCADE proceeds. The historical
obligation of the link/outbox ledger ends with the tenant, and the departed
practitioner's Google events remain in their own calendar (teardown does not
auto-delete Google events). The per-appointment `AFTER DELETE` enqueue trigger
(B2.3-a) is a no-op during teardown because the links are purged first (no active
link found). B1 **did not change the disconnect path** — it was inspected and left
intact; the hard-purge teardown routine itself lands in B2.4.

---

## 3c. Outbound enqueue + claim activation boundary (Phase B2.3-a, migration 0125)

Migration **0125** wires the DB-side outbound-sync foundation the future drain
worker will consume. It is **additive + DORMANT** and ships with **no production
caller** (the worker-drain `/api/cron/calendar-sync` route + its cron registration
are **B2.3-c**). No Google call, no event scope requested, no re-consent, no studio flag
enabled, and the global worker control defaults OFF. Behavioural proof:
`tests/db/google-calendar-b2-3a-enqueue-claim.db.test.ts`; static proof:
`tests/migrations/0125-…test.ts`.

- **Intent vs health — two independent gates.**
  - *Intent gate* (enqueue + canonical link bookkeeping — create/rebind — no Google
    call): studio `google_calendar_outbound_sync_enabled` ON **+** an owner
    connection row exists (`is_studio_calendar_owner`) **+** a `write_calendar_id`
    is selected. It **does not** require `connected` status, event scope, or a
    usable refresh token, so a **transient connection outage never erases calendar
    intent** — changes made during an outage accumulate as `pending` jobs.
  - *Health gate* (claim / external execution): global worker control ON **+** studio
    intent ON **+** `connected` **+** owner **+** `write_calendar_id` **+**
    `granted_scopes @> calendar_required_event_scopes()` (superset) **+** a usable
    encrypted refresh token. When unhealthy, jobs stay `pending`, attempts **do not
    decay** (Option A). A pause is a *health* condition, not an intent one.
- **Runtime global worker control** — a singleton `calendar_sync_control`
  (`worker_enabled`, default **OFF**, service-role only) is authoritative at the
  **claim** boundary. While OFF/absent (fail-safe), `claim_calendar_sync_op`
  returns zero rows and performs zero queue mutations (no reap-to-dead, no attempt
  increment, no lease). It is a runtime (data) control, distinct from the
  deployment-time env default and the worker-drain cron schedule (B2.3-c).
- **Health-aware expired-lease reaper — single-health-read invariant.** Inside
  `claim_calendar_sync_op`, connection health is evaluated **exactly once per stale
  processing row** (a `stale` CTE that locks the rows `FOR UPDATE OF … SKIP LOCKED`
  and materializes one `is_healthy` + `at_max` per row); a single `UPDATE … CASE`
  then applies **exactly one** transition, so a row can never be released **and**
  dead-lettered by two independently evaluated predicates, and two concurrent claim
  calls cannot process the same stale row twice. Healthy-at-max → `dead` (deployed
  contract); **unhealthy → released to `pending` with its lease-consuming attempt
  restored** (`attempts = greatest(attempts-1, 0)`, claim metadata cleared) so a
  transient outage never terminally kills an operation or permanently decays
  attempts; healthy-below-max is left for the claimable CTE. (Pilot pending-age
  thresholds may need recalibration once real reconnect behaviour is observed —
  revisit in B2.4, not this PR.)
- **Genuinely never-raise triggers, with deduped markers.** The enqueue +
  AFTER-DELETE triggers swallow any failure (link, outbox, telemetry) so a booking is
  never aborted; the `ops_alerts` skip marker — including its **deduplicating
  `ON CONFLICT DO NOTHING`** against a partial unique index
  (`ops_alerts_calendar_enqueue_skip_dedup_uniq` on `(studio_id, safe_details->>
  'dedup_key')` where `event='calendar_enqueue_skipped' and resolved_at is null`) —
  is written entirely inside a **nested** guarded block, so even an index/predicate
  mismatch cannot re-raise and abort the operation. At most **one unresolved marker
  per (studio, appointment)**; a resolved marker never blocks a fresh one. The
  AFTER-DELETE marker carries no `appointment_id` (the row is gone;
  `ops_alerts.appointment_id` is `ON DELETE SET NULL`) and dedups on the same
  `dedup_key`. Honest limitation: if both the enqueue and its marker fail there is no
  durable trace — the **reconciliation sweep** (B2.3-b) is the recovery net.
- **Append-only suppression telemetry** — `calendar_sync_metric_events` is
  append-only (one row per event, random PK); there is **no** contended
  `(studio_id, metric, day)` counter row, so concurrent suppressed enqueues never
  serialize inside a booking transaction.
- **Queue-health eligible-vs-parked split.** The `calendar_sync_queue_health` view
  keeps **parked (currently-ineligible) work visible** — it still counts in total
  `pending` + `oldest_pending_due` — while separately reporting `eligible_pending`,
  `parked_pending`, `oldest_eligible_pending_due`, and `oldest_parked_pending_due`,
  so a reconnect window never makes work invisible and operators can tell "worker
  not draining eligible work" from "work intentionally held (connection not
  healthy)". No separate parked-age alert ships in B2.3-a.
- **Repair primitives — full-unique-safe; a dead row is never reopened.** Because
  the idempotency index is FULL (all statuses), every repair mints a **genuinely
  new** key: `repair_bump_appointment_sync_version` does a real `sync_version`
  increment → a strictly-higher organic key (reconcile Classes 1–3, and Class 4 for
  a still-present cancelled appointment); `repair_enqueue_orphan_link_delete` uses a
  `reconcile_generation`-scoped tombstone key for a link whose appointment row is
  gone. The four-class reconciliation sweep (missing link+job / orphaned link /
  link version behind appointment / surplus event) runs app-side in B2.3-b.
- **Entity-tombstone CHECK change** — the one deliberate change to a deployed
  object: `calendar_sync_outbox_entity_chk` is relaxed so `event.delete` may be
  **entity-less** (carrying a link tombstone after its appointment row is gone).
  `event.create`/`event.update` still require an entity; `full.resync` still carries
  none. (The 0124 file + its static test are historical and unchanged; the 0125
  tests document the new live contract.)
- **No eager write-calendar link repoint.** Changing `write_calendar_id` must NOT
  repoint an existing link's `google_calendar_id` — that would falsely claim the
  event lives on the new calendar while it still exists on the old, and destroy the
  old coordinates the move needs. 0125 adds **no** such bulk update (a static test
  pins this). The correct bookkeeping is: bump `sync_generation`, **preserve** each
  link's existing `google_calendar_id` + `google_event_id`, start a
  generation-scoped full-resync carrying the old/new calendar context, and repoint
  the link only at the **successful delete-old/create-new move boundary** — all
  **B2.4** (worker-side).
- **Stable resync cursor (design intent, B2.4 enumerator).** A full-resync
  enumerator paginates by the **immutable appointment UUID** under a pinned snapshot
  (`created_at <= snapshot_started_at`), never by the mutable `starts_at`, so an
  appointment moving mid-enumeration is neither skipped nor double-visited;
  post-snapshot mutations are covered organically. On a **write-calendar change**
  the resync **preserves the actual Google location** (the old `google_calendar_id`
  + `google_event_id`) until the worker completes the approved delete-old/create-new
  move; the link's `google_calendar_id` is repointed **only** at that successful
  move boundary. Worker-side move + partial-move recovery + stale-generation fencing
  remain B2.4 inputs.
- **Un-cancel is defensive.** Hone has **no** user-facing un-cancel flow today; the
  transition-into-`confirmed` rows (matrix rows 3/8) + tests exist so a future
  un-cancel feature reuses this contract rather than deriving a second calendar
  rule.
- **No production CLAIM caller before B2.3-c.** The B2.3-b reconciliation sweep +
  heartbeat + route ship first (enqueue-side, §3e); the first caller of
  `claim_calendar_sync_op` (the worker-drain route + its cron) is B2.3-c and must not
  be registered until the sweep + monitoring are deployed and observed.

### B2.4 input list (owed by the next phase, NOT built in B2.3-a)

- `reschedule_appointment` / cancel RPC **lineage wiring** — populate
  `rescheduled_from/to` + `cancellation_kind` so the enqueue trigger's rebind +
  delete-suppression activate (dormant until then; reschedule falls back to
  delete-old + create-new, still correct).
- **`.owned` boundary validation** — `accessRole = "owner"` correspondence; the
  cross-boundary GET response (404 vs 403); the write-calendar picker owner-only rule.
- **`invalid_grant` → delete the encrypted secret** (not only flag the connection),
  which the usable-secret eligibility check already treats as ineligible.
- **Worker-side calendar move + delayed link repoint** — preserve old event
  coordinates, validate create-new/delete-old ordering, repoint the link only at the
  successful move boundary, fence older generations from reversing a completed move,
  repair partial move completion.
- **Execution-time stale fence (worker op).** The create/update/delete worker
  operation must, before calling Google, compare the job's `payload.sync_version` to the
  current `appointments.sync_version` / `calendar_event_links.last_hone_version` and
  return `ok_noop_superseded` when the job is stale (that JobResult code already exists;
  both columns are already readable — no migration). B2.3-b deliberately relies on this:
  it generates current intent even when a stale job is still pending, and the fence (not
  the sweep) prevents a stale dispatch once the worker exists. A worker op for a link with
  a null `google_event_id` (a placeholder) must UPSERT (create), not blindly update.
- **Stale-generation fencing**, the Google-call lifecycle tests, the hard-purge
  teardown routine, and — before Willow — **privacy-policy publication + scope
  justification + consent-screen verification** for the sensitive `.owned` scope.
  (The four-class reconciliation **sweep** + dead-row alert + heartbeat/retention +
  durable continuation now ship in B2.3-b — see §3e.)

---

## 3d. Dual destination — owner-selectable outbound target (Phase B2.4, migration 0131)

Migration **0131** (`0131_google_calendar_dual_destination.sql`) makes the outbound
event-write **scope contract destination-aware** and records **where** Hone will
(later) place appointment events. It is **additive + nullable + DORMANT** and, per
its own header, sequences on top of Phase A (0121/0122) / B1 (0124) / B2.3-a (0125):
prod migration max was 0130, this is 0131, and it is **APPLIED to production and
DORMANT** (PR #424 merged + operator-validated 2026-07-14; hosted migration max = 0131).
No Google API call, no event scope granted, no re-consent, no studio flag enabled,
the global worker control stays OFF, and no enqueue / outbox row / event-link /
appointment mutation / backfill occurs. Behavioural + shape proofs live under
`tests/db` / `tests/migrations` for 0131.

### Ordering — why B2.4 precedes B2.3-b and B2.3-c

B2.4 ships **before** the reconciliation/heartbeat sweep (B2.3-b) and the
cron/worker activation (B2.3-c) **on purpose**: B2.3-b consumes the **readiness**
semantics (`calendar_connection_outbound_ready`) and B2.3-c consumes the **worker
eligibility** contract, and B2.4 is precisely the change that redefines the
destination + required-scope semantics those two phases rely on. Landing B2.4 first
means B2.3-b / B2.3-c are built against the final contract rather than a
soon-to-change one.

---

## 3e. Reconciliation sweep + heartbeat + route (Phase B2.3-b)

B2.3-b ships the enqueue-side recovery net + its observability. It **adds no
migration** (hosted max stays **0131**), builds **no** new enqueue/queue engine, and
**never calls Google, enables the worker, or changes a flag**. It is a bounded
**drift detector + orchestrator** over the EXISTING repair primitives
(`repair_bump_appointment_sync_version`, `repair_enqueue_orphan_link_delete`), the
intent-gated enqueue trigger, and the `calendar_sync_outbox` state machine.
Behavioural proof: `tests/db/google-calendar-b2-3b-reconcile.db.test.ts`; unit proof:
`tests/lib/google-calendar/sync/reconcile*.test.ts`.

- **The gap it closes — the ineligibility (intent-off) window.** The enqueue trigger
  only records outbound intent while the INTENT gate holds (studio outbound flag ON +
  owner connection + `write_calendar_id`). Appointments mutated while intent is
  **unavailable** (flag off, no owner, no write target) — or when the trigger's
  never-raise guard **swallowed** an enqueue — leave **no** outbox/link row. When
  eligibility returns there may be no pending work to drain. The sweep discovers and
  converges those appointments. It does **not** reconcile connection-**health**
  outages: those already accumulate pending/parked work (the trigger is health-blind)
  that the claim gate drains on recovery, so the sweep must never duplicate it.
- **Intent-eligible studios only.** The sweep actuates only within studios that pass
  the same INTENT gate; bumping an intent-off studio would inflate `sync_version`
  with no enqueue. Production has zero intent-eligible studios, so the sweep is inert.
- **Four classes → existing actuators.**
  - *Class 1 — missing link+job* (confirmed, not-yet-ended appointment, no active link
    + no current job) → `repair_bump_appointment_sync_version` → the trigger creates
    the link + an `event.create`.
  - *Class 3 — link version behind* (`last_hone_version < sync_version`, no current
    job) → bump → an `event.update`.
  - *Class 4 — surplus event* (a withdrawn cancellation whose still-present appointment
    has a live link, no current job) → bump → an `event.delete` (the ordinary cancel
    path). A `cancellation_kind='rescheduled'` predecessor is left alone (the successor
    rebinds the link); completed/no_show keep their historical event.
  - *Class 2 — orphaned link* (the appointment row is gone) → `repair_enqueue_orphan_
    link_delete` (a `reconcile_generation`-scoped, entity-less tombstone). A local
    **placeholder** link (`google_event_id` null → no remote event) is inert.
- **Stale-job model (op + version), not "any open job".** A pending/processing
  outbox row counts as *current work* ONLY when its op class AND `payload.sync_version`
  correspond to the CURRENT desired state (`>= appointment.sync_version`). An OLDER
  job (a stale `sync_version`, or the wrong op for the current status) does **not**
  block generating current intent — otherwise a booking mutated during the intent-off
  window would look "converged" behind a stale `create:1`. There is **no execution-time
  version fence today** (the claim RPC orders by `priority/next_attempt_at/created_at`
  with no version compare; the handler/`record_calendar_sync_result` compare nothing —
  verified). Generating current intent alongside a stale pending job is safe at this
  phase because the worker is OFF (nothing dispatches). The execution-time fence — a
  B2.4 worker operation returning `ok_noop_superseded` (already a defined JobResult
  code) when a job's `payload.sync_version` is older than the current link/appointment
  version — is a **B2.4 worker-operation responsibility and needs no migration**
  (`appointments.sync_version` + `calendar_event_links.last_hone_version` already carry
  everything the fence needs). B2.3-b only ensures the current desired intent EXISTS.
- **Placeholder-vs-real link distinction.** A **placeholder** link (`google_event_id`
  null → no remote event) is never treated as convergence: a confirmed appointment with
  a placeholder link and no current job **re-drives** a create (abandoned/swallowed);
  if its create is terminally **dead** it enters a manual-review skip surfaced by the
  dead-row alert (no auto-loop). A **withdrawn cancellation** whose link is a placeholder
  is **inert** — never a provider `event.delete` without provider coordinates. Only a
  real-event link (`google_event_id` present) yields a delete/tombstone.
- **Supersede-safe, no version inflation.** Every actuation is preceded by a **FULL
  pre-actuation revalidation**: the current appointment + its link + its jobs are
  re-read and the SAME classifier is re-run; the actuator fires only if the fresh
  decision still matches. For an orphan delete the link is re-read by id (detecting a
  rebind, a cleared `google_event_id`, a soft-delete, or an in-flight delete). Because
  `repair_bump_appointment_sync_version` increments unconditionally, a bump is issued
  only after that fresh check under the per-studio lock — repeated/interleaved sweeps
  produce **exactly one** effective operation per appointment. (An orphaned, gone-appt
  link can never be rebound: the reschedule rebind keys on
  `rescheduled_from_appointment_id`, which is `ON DELETE SET NULL`, so a gone
  predecessor is unreachable — verified. The app-level re-read is therefore sufficient;
  no RPC/migration change is required.)
- **Stable, RESUMABLE enumeration.** Candidates paginate by the **immutable appointment
  UUID** (link classes by the immutable link id) under a pinned run clock that serves as
  both `snapshot_started_at` (`created_at <=`) and `activation_started_at` (`ends_at
  >=`) — never the mutable `starts_at`. A truncated run (page budget, route deadline, or
  lost lease) persists a **durable Upstash continuation** (`gcal_reconcile:cursor:{studio}`
  — pass/class + snapshot + activation + immutable last-seen id) so the next invocation
  resumes AFTER that cursor; later appointments never starve behind already-converged
  early rows. The continuation is **correctness state, FAIL-CLOSED**: a read I/O error
  skips the studio (position unknown), a required-write failure marks it degraded (never
  reported complete); a *lost* record restarts from the beginning under a fresh snapshot
  (convergence is idempotent — we never skip to the end). All continuation changes happen
  under the lock. Rows created after the snapshot are covered organically by the trigger.
- **Initial-activation boundary (no arbitrary horizon).** On first eligibility the
  sweep creates events for every `status='confirmed'` appointment with `ends_at >=
  activation_started_at` (not-yet-ended, including in-progress) that has no converged
  link — ended/cancelled/completed/no_show and already-converged rows are excluded.
  Large future sets are bounded by pages + cursors, never silently dropped.
- **Real per-studio distributed lock (FAIL-CLOSED).** Because the route runs on
  serverless functions through the PostgREST service-role client (no held Postgres
  transaction), mutual exclusion uses an **Upstash ownership-token** lock: `SET key
  <token> NX EX` to acquire, a Lua compare-and-`DEL` to release, a compare-and-
  `PEXPIRE` to renew. Ownership is checked **before every actuator and at each pass
  boundary** (time-based: renew once the configured fraction of the TTL has elapsed, so
  a long op triggers a renewal), and the run is bounded by an overall **route deadline**.
  A second concurrent sweep for the same studio is skipped. **Lock acquisition /
  integrity failure is fail-closed** — if Upstash is unreachable, or a renewal cannot
  confirm continued ownership, the sweep **stops mutating immediately**, persists a
  continuation for the remainder, and reports degraded; it never runs past a lost lease
  or sweeps unlocked. This is the one place that is *not* fail-open.
- **Heartbeat + dead-row alert + retention (FAIL-OPEN observability).** After each run
  the route writes a single non-sensitive Upstash heartbeat (`gcal_reconcile:last_run`)
  whose **outcome is truthful** — `ok` / `degraded` / `error` (degraded when a studio was
  truncated, the lock was unavailable, a continuation read/write failed, or a per-candidate
  actuator errored; error on a top-level exception). `at` is the completion time; the
  scheduler classifier treats a recent **degraded/error** heartbeat as NOT healthy (it is
  not healthy just because it is recent). It also sweeps a **deduped, PHI-free dead-row
  alert** (`calendar_outbox_dead_rows`, studio-scoped, aggregate count only) for terminal
  dead outbox work — recurring after resolution when new dead rows appear, never reopening
  a dead row — and prunes `calendar_sync_metric_events` past its retention window (the 0125
  `delete` grant). Every heartbeat/metric/alert write is fail-open — a failure never aborts
  the sweep or a booking. Observability failing open must not be confused with the lock +
  continuation, which are fail-closed. The stale/degraded/error scheduler alert recorder
  exists but is **not** wired to a schedule in B2.3-b (no cron cadence yet — that is B2.3-c).
- **Route — `/api/cron/calendar-reconcile`.** Constant-time `CRON_SECRET` bearer
  (`isAuthorizedCronRequest`, 401 otherwise); no browser-supplied studio/connection/
  calendar/provider id is trusted (the eligible set is derived server-side). It is
  **NOT** gated on `calendar_sync_control.worker_enabled` — that remains the
  authoritative CLAIM/DISPATCH gate and is not repurposed. The route stays dormant in
  production because it is not cron-registered, every studio's outbound flag is OFF
  (so the intent gate yields nothing), invocation requires `CRON_SECRET`, and the
  worker is OFF (queued work cannot dispatch). This separation permits a later
  controlled activation: enable intent for one studio, run bounded reconciliation,
  inspect the queue, and only then authorize the worker (B2.3-c) — with no new flag.
- **Deferred to B2.3-c:** registering a cron for the sweep, the worker-drain route
  (`/api/cron/calendar-sync`) + its cron, wiring the stale-run heartbeat alert to a
  schedule, and any live Google event transport (B2.4 worker behaviour).

### The two owner-selectable destinations (the final outbound destination boundary)

An owner picks **one** appointment destination; the server **derives** the required
OAuth scope from that choice. **The browser only selects a destination option — it
never selects, names, or requests a scope.** This closes the previously-parked
outbound scope-boundary item (see the open validation note in §5):

| Destination (`destination_mode`) | Where events land | `accessRole` required | Derived OAuth event scope |
|---|---|---|---|
| `dedicated_app_created` | a dedicated calendar **Hone creates** ("Hone Appointments") | n/a (Hone owns what it created) | `https://www.googleapis.com/auth/calendar.app.created` |
| `existing_owned` | an **existing calendar the connected user owns** | exact Google `accessRole === "owner"` | `https://www.googleapis.com/auth/calendar.events.owned` |

Only an **owned** calendar qualifies for `existing_owned`: `writer`, `reader`,
`freeBusyReader`, and otherwise-shared calendars are **excluded**. Shared calendars
owned by another person/organization remain unsupported near-term.

The required scope is the **single SQL source** of truth via the destination-aware
`calendar_required_event_scopes(text)`: `dedicated_app_created →
{calendar.app.created}`, `existing_owned → {calendar.events.owned}`, and **NULL
(never `'{}'`)** for any null/unknown/malformed mode.
`calendar_connection_outbound_ready` is rewritten **fail-closed** against the Postgres
`any_array @> '{}'` fail-open trap: it requires `destination_mode` set **and** the
required-scope array non-NULL **and** `cardinality >= 1` **and**
`granted_scopes @> required` (plus connected + owner + `write_calendar_id` + a usable
encrypted refresh token). A discovery-only connection (no destination chosen) derives
as **not event-ready**.

### Broad `calendar.events` is SUPERSEDED for outbound destination authorization

Broad `https://www.googleapis.com/auth/calendar.events` is **removed from the
outbound destination contract**: it is gone from the app request path, the callback
acceptance, readiness, worker eligibility, and the DB scope seam
(`calendar_required_event_scopes` maps it to nothing; the legacy 0-arg overload now
returns NULL, never the old universal scope, never `'{}'`). It satisfies the outbound
contract **nowhere**. Earlier sections (notably §5's incremental-authorization note)
that describe broad `calendar.events` as the working or fallback event scope reflect
the **previous contract** and are retained only as history — they are superseded here.

### Migration 0131 schema (additive + nullable + dormant)

- **`calendar_connections` — destination metadata:** `destination_mode`
  (CHECK: NULL or one of the two known modes), `selected_calendar_display_name`
  (safe human-readable name for the UI, never event data / PHI),
  `destination_configured_at` (a derived-readiness **input**, never a stored
  readiness flag; a CHECK requires `write_calendar_id` set once configured),
  `destination_ownership_validated_at` (`existing_owned` only, CHECK-guarded),
  `app_created_calendar_id` (`dedicated_app_created` only, CHECK-guarded; the
  idempotency anchor — a retry that finds it set never re-creates). The two
  provenance facts (`app_created_calendar_id` vs `destination_ownership_validated_at`)
  are **mutually exclusive** by CHECK. Intermediate states (mode chosen + permission
  granted, not yet provisioned/selected) are deliberately **not** over-constrained so
  the flow can progress.
- **`calendar_connections` — dedicated provisioning-state:**
  `destination_provisioning_attempt_token`, `destination_provisioning_started_at`,
  `destination_provisioning_ambiguous_at`, all **guarded by CHECK to the
  `dedicated_app_created` mode** (they can never attach to an `existing_owned` / unset
  row).
- **`google_oauth_states` — destination binding:** `destination_mode` +
  `required_event_scope`, with a **known-mode CHECK** and a **matched-pair CHECK**
  (`(destination_mode is null) = (required_event_scope is null)` — an upgrade binds
  both, a plain Phase-A connect binds neither). The callback additionally **re-derives**
  the scope from the mode and compares, so a tampered single-column value cannot pass.
  The state table stays default-deny for browser roles (0122 RLS/REVOKE unchanged) and
  is ephemeral (10-min TTL, single-use), so there is **no backfill**.
- **Functions:** destination-aware `calendar_required_event_scopes(text)` and
  fail-closed `calendar_connection_outbound_ready` (signature unchanged, so the claim
  RPC / reaper / queue-health view pick up the new logic without modification). Both
  remain `service_role`-EXECUTE-only.

### Dedicated-calendar provisioning idempotency (attempt-token reconciliation)

Google `calendars.insert` accepts **no** caller-supplied resource id and **no**
idempotency key, so an ambiguous provider response (Google created the calendar but
the client saw a timeout/disconnect) cannot be de-duplicated by the provider. B2.4
reconciles by a **random, NON-SENSITIVE attempt token**:

- The token is minted and **persisted BEFORE** `calendars.insert`, then embedded in
  the created calendar's **DESCRIPTION**.
- A retry / ambiguous response is reconciled by **EXACT token match** — **never** by
  display name (multiple calendars can share the name "Hone Appointments").
- **Multiple matches → fail closed / needs attention** (`destination_provisioning_ambiguous_at`
  set): **no** auto-create while ambiguous; readiness derives "needs attention" until
  a human resolves it.
- The description carries **only** the non-sensitive random attempt token — **no**
  credential token, secret, account identifier, or PHI.

### Destination switching is OUT OF SCOPE for B2.4 (explicit follow-up)

Once a mode is selected **and configured**, B2.4 does **not** allow changing it to the
other mode. **Recovery from a pending/ambiguous state retries the SAME mode only.**
Switching a configured connection between `dedicated_app_created` and `existing_owned`
is deferred to a **future product + data-lifecycle design** that must address, at
minimum: existing-calendar cleanup, dedicated-calendar lifecycle, **event-link
migration**, permission downgrade / re-consent, rollback, and audit history. This is
recorded here as an explicit open follow-up — do not add ad-hoc mode switching without
that design.

### Dormancy & disconnect

- Granting a destination permission or creating the empty Hone-owned secondary
  calendar does **NOT** enable synchronization. The drain worker and **all four**
  `google_calendar_*` studio flags stay **OFF**; no event / outbox row / event-link is
  created; Willow stays unconnected.
- **Disconnect NEVER deletes a Hone-created Google calendar.** Whether/how to remove a
  Hone-created calendar on disconnect is a **separate future product decision**;
  disconnect revokes credentials + clears local state only (consistent with the
  existing §3b disconnect path, which updates the connection row rather than deleting
  it).

### OAuth surface (unchanged transport, destination-bound state)

The exact callback path is **`/api/google-calendar/oauth/callback`**, with the redirect
URI **built server-side** and **never derived from a request header**. The Phase-A
discovery scopes are unchanged (`openid`,
`https://www.googleapis.com/auth/userinfo.email`,
`https://www.googleapis.com/auth/calendar.calendarlist.readonly`). The server-only env
vars are unchanged and never `NEXT_PUBLIC_*`: `GOOGLE_OAUTH_CLIENT_ID`,
`GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_TOKEN_ENCRYPTION_KEY` (AES-256-GCM key),
`GOOGLE_TOKEN_ENCRYPTION_KEY_VERSION`. See the operator checklist
(`docs/integrations/google-calendar-owner-connection-operator-checklist.md`) for the
Google Cloud console setup of the two destination scopes.

---

## 4. Token encryption & key rotation

Reuses the AES-256-GCM primitive of `lib/conversion/token-crypto.ts` but with a
**dedicated key** and a **versioned, self-describing ciphertext**
(`lib/google-calendar/token-crypto.ts`):

```
v1:<keyVersion>:<base64(iv)>:<base64(tag)>:<base64(ciphertext)>
```

- Key: `GOOGLE_TOKEN_ENCRYPTION_KEY` (32 bytes, hex or base64) +
  `GOOGLE_TOKEN_ENCRYPTION_KEY_VERSION` (positive integer). A dedicated key
  decouples the blast radius / rotation of Google credentials from tracking tokens.
- `import "server-only"`; the key is read from `process.env` only inside server
  modules; decryption happens only in the OAuth callback + (future) sync worker,
  under the service-role client. Fail-closed everywhere (never throws, never logs
  a token or the raw crypto error).
- The refresh token and the PKCE verifier are encrypted (replayable). The access
  token is not stored. The watch-channel token (future) will be **hashed** (it is
  only ever compared, never replayed).

**Key rotation:** the format carries a key version, but Phase A has a single
active key (no previous-key slot). Rotating the key makes existing ciphertext
`decrypt_failed`; because a refresh token is recoverable only by re-consent, a
rotation forces every practitioner to **reconnect**. This is an accepted,
documented operational cost for a small install base. A future change can add a
`GOOGLE_TOKEN_ENCRYPTION_KEY_PREVIOUS` slot for dual-decrypt re-wrap without
changing the stored format.

**Deploy-time gate:** `scripts/check-production-env-gates.mjs` Gate 3 validates
the Google config **shape if present** (32-byte key, positive version, all four
vars set together) — a partial/malformed config FAILS the production build; total
absence PASSES (dormant). The connect action also fails closed at runtime via
`isGoogleTokenCryptoConfigured()`.

---

## 5. OAuth 2.0 security

Authorization-code flow with PKCE (S256), server-side token exchange, and a
single-use state bound to the exact authenticated practitioner + studio + browser
session:

- **Start** (`startGoogleCalendarConnectAction`): authenticated, resolves
  practitioner + studio, **requires the connection flag ON server-side**, requires
  crypto/OAuth configured, mints state (hash stored) + nonce (hash stored, raw in
  an httpOnly cookie) + PKCE (verifier encrypted), redirects to Google.
- **Nonce cookie:** `HttpOnly`, `Secure` in production, **`SameSite=Lax`** (never
  Strict — Google returns via a top-level cross-site redirect and Strict cookies
  would not be sent, failing every valid callback), path `/`, TTL aligned to the
  10-min state.
- **Refresh-token issuance:** `access_type=offline` + `include_granted_scopes=true`
  always; `prompt=consent` only on first connect / `reconnect_required` / when no
  usable refresh token is stored (not forced on a healthy reconnect). If the
  callback returns no refresh token, an existing stored token is **preserved**; if
  none exists, the connection is marked `reconnect_required` (never healthy without
  a usable token).
- **Callback** (`app/api/google-calendar/oauth/callback`): Node runtime,
  force-dynamic, **not** allow-listed anonymous (it carries the session). It:
  requires an authenticated user → **atomically consumes** the state (validates
  hash, expiry, nonce cookie, and `user.id == state.user_id`) → re-checks the
  practitioner is active + belongs to the bound studio + user → exchanges the code
  with the PKCE verifier → verifies granted scopes include calendar-list discovery
  → verifies the Google account identity server-side (userinfo) → encrypts the
  refresh token → persists metadata + ciphertext in **separate** tables → clears
  the nonce cookie → redirects to a fixed `/settings/profile?gcal=…` status (never
  an arbitrary request-supplied redirect).
- **Threat coverage:** state fixation / cross-studio attach (state binding + CAS +
  user re-assert), CSRF (PKCE + double-submit nonce cookie), calendar-id swap
  (write calendar resolved server-side from the connection's own list; selection
  validated against Google's list), peer token read (secret side table
  default-deny), open redirect (fixed allow-listed return paths), plaintext at
  rest (encrypt-before-store, fail if encryption fails), token in logs (hard rule:
  never log code/state/tokens/verifier).

### Incremental authorization strategy

Phase A requests the **minimum** scopes: `openid`, `userinfo.email`, and
`calendar.calendarlist.readonly` (the narrowest official scope that makes calendar
selection possible — grants NO event access). Phase B's **working** event-write
scope is the narrower **`calendar.events.owned`** (CRUD on calendars the connected
account owns), not broad `calendar.events`; broad `calendar.events` is retained as
a **documented fallback** for a future customer who must write to a *non-owned*
shared calendar. Because both DB-side consumers read the required scope from a
single SQL source (`calendar_required_event_scopes()`, migration 0125) and the app
reads `config.EVENT_WRITE_SCOPE`, a switch to broad `calendar.events` is a
**tracked migration** (expected 0126) carrying the function body + the app constant
+ the consent-screen disclosure + fresh re-consent — never an untracked production
`CREATE OR REPLACE`. Phase B eligibility uses **superset containment** (`granted_scopes
@> calendar_required_event_scopes()`), so Google-bundled extra identity scopes (e.g.
`userinfo.profile`, which Sam's live connection carries though Phase A never
requested it) never make a connection ineligible. Sam's controlled connection will
require exactly **one** additional consent/reconnect (for the final chosen scope)
when Phase B activates (B2.5). `calendar.events.owned` is still a Google
**sensitive** scope, so external users (Willow) require Google app verification
before activation. Requesting event access before event sync exists would violate
least privilege.

An open B2.4 validation confirms `.owned` fits Hone's product boundary before any
live re-consent: whether `calendarList.accessRole = "owner"` corresponds to the
`.owned` authorization boundary, and what a speculative cross-boundary GET returns
(404 vs 403) so the handler can distinguish *event does not exist* from *not
authorized to inspect* from *calendar outside the supported ownership boundary*.
The write-calendar picker will exclude calendars that do not satisfy the validated
owned-calendar rule; shared calendars owned by another person/organization are
explicitly unsupported near-term.

> **Superseded by B2.4 (see §3d).** The paragraphs above reflect the **pre-B2.4**
> contract, in which broad `calendar.events` was retained as a documented fallback
> and `calendar.events.owned` was the single working event scope. Under B2.4's
> **dual-destination** model, the required event scope is **derived from the chosen
> destination** — `calendar.app.created` for `dedicated_app_created`,
> `calendar.events.owned` for `existing_owned` — and broad `calendar.events` is
> **removed from the outbound destination contract** (app request path, callback
> acceptance, readiness, worker eligibility, and the DB scope seam); it authorizes no
> outbound destination. The above text is kept only as history.

---

## 6. Privacy defaults (reserved for later phases)

When outbound sync ships, the future Google event is a **pure function over a
minimal v1 allow-list** (approved 2026-07-14):

| Field | Value |
|---|---|
| `summary` | the constant `"Hone appointment"` (no client, service, or reason) |
| `start.dateTime` | `starts_at` (server-derived local time zone / RFC3339 offset) |
| `end.dateTime` | `ends_at` — the human end, **never** the buffered `blocked_ends_at` |
| `visibility` | `private` |
| `transparency` | `opaque` |

**Excluded from v1 (never sent):** client first/last name, email, phone; **studio
address / event `location`** (a home-based or private studio location may not be
appropriate to export); `description`; attendees; appointment reason; service /
modality; treatment area / body-map; consultation / skin-hair / practitioner notes;
observation chips; treatment settings; intake / consent data; contraindications;
photos; payment / Stripe / price; internal ids; appointment tokens; provider ids;
audit / operational metadata. No PHI in any log, metric, heartbeat, or ops alert.
This is *stricter* than the existing iCal feed (which carries the studio address).
Any later expansion requires a separate **privacy + resynchronization** decision;
because identity is `sync_version` (not a content hash), an allow-list change does
not invalidate idempotency keys — it must be propagated via a controlled
generation/`sync_version` bump, never a destructive full resync.

**Stance through B2.3-b:** `calendar_sync_outbox.payload` carries **operational
metadata only** (`schema_version`, `sync_version`, op, and — for orphan tombstones —
`google_event_id`/`google_calendar_id`/`reason`); it is written only by the DB
enqueue trigger + repair RPCs from typed values, never a free-form spread of an
entity row (a DB test asserts no client identity in the queue). The **event
serializer** that maps the allow-list above into a Google payload is **B2.4 worker
territory and is NOT built in B2.3-b** — the reconciliation sweep produces no
payloads and makes no Google call; it only re-drives intent through the trigger.

---

## 7. Later phases (design intent, NOT implemented)

- **Phase B — Hone → Google (outbound).** Split into schema-first + behavior:
  - **B1 (DEPLOYED — migration 0124 applied + PR #407 merged 2026-07-12, dormant).**
    The `calendar_event_links` mapping + durable `calendar_sync_outbox` + the
    service-role-only claim/result queue RPCs, with no runtime wiring. See §3b for
    the full data model, four-state queue, idempotency contract, lease/backoff
    constants, and the orphan reaper. **No behavior ships in B1** — the schema is
    live but inert (0 rows, no worker, no enqueue, nothing reads it).
  - **B2 (design intent, NOT built): behavior.** Enqueue at the DB commit point
    (inside the cancel/complete/no_show/reschedule RPCs + the 0030 mirror trigger
    for creates/blocks) via a fixed allow-listed serializer (§6); a drain worker
    (`/api/cron/calendar-sync`, riding the external 15-min scheduler) that claims
    via `claim_calendar_sync_op`, calls Google, and reports via
    `record_calendar_sync_result` with an exponential-backoff curve; reschedule
    handled as a linked delete(old) + create(new). Adds the `sync_generation`
    epoch (deferred from B1) so a disconnect→reconnect invalidates in-flight ops.
    Booking never blocks on a Google call. Requires ONE reconnect for Sam via
    incremental auth to add the **destination-derived** event scope
    (`calendar.app.created` for a dedicated Hone calendar, `calendar.events.owned` for
    an existing owned calendar — broad `calendar.events` is retired; see §3d). Phase A
    withheld any event scope.
- **Phase C — Google → Hone busy:** `external_calendar_busy_events` (per-
  practitioner, separate from the GiST-excluded shadow), merged into
  `getAvailableSlots`; initial + incremental sync with `singleEvents=true` to
  sidestep Hone's RRULE-less model. **Gated on the studio-wide constraint in §1.**
- **Phase D — Push + reconciliation:** `events.watch` channels (validated by a
  stored channel_id + hashed channel token + resource_id, never headers alone),
  a webhook that validates→enqueues→acks fast, incremental sync via `syncToken`,
  channel renewal + a staleness heartbeat/ops-alert.
- **Phase E — Controlled two-way edits:** a new in-place reschedule RPC applies a
  Google time change only when a studio opts in; a Google deletion of a Hone
  appointment is never a silent delete (conflict state + alert).

### Conflict ownership (later phases)

Hone-linked appointment → **Hone canonical** (Google may change time only if
explicitly permitted; Google deletion → conflict + alert, never silent delete;
Google content edits ignored). Google-originated event → **Google canonical**,
mirrored as external busy, never becomes a Hone appointment. Hone block linked to
Google → **Hone canonical, no sync-back** (justified by hard-delete + no-RRULE +
TZ-reprojection semantics). Loop prevention: a transaction-local origin GUC +
`etag`/`updated`/`last_pushed_version` compare-before-write.

### Fail-closed behavior (reserved for the inbound phase)

Availability is fail-**open** today (a swallowed read error yields more slots).
For **inbound Google busy** this inverts to **fail-closed**: if a practitioner's
Google sync is stale beyond a threshold, Hone does not offer slots it cannot
verify (a missed booking is recoverable; a double-book with a real client is not),
surfaces a staleness banner + ops alert, and never silently claims Google is
current. This is a Phase C concern, not Phase A.

---

## 8. Rollout & Willow gates

1. Apply 0121 + 0122 (additive, dormant). Deploy code. Keep
   `google_calendar_connection_enabled` **OFF**. Do not create a production
   connection.
2. Separate approval → enable the connection flag for **Sam's controlled studio
   only**, connect Sam's controlled Google account, validate the foundation
   (state single-use, secret unreadable by a peer, no token in logs), then
   disable.
3. Each later phase repeats the Sam-only, flag-gated, validate-then-disable
   pattern before any broader enablement.
4. **Willow remains OFF** through every phase until each is proven on Sam's studio
   AND separately approved. Two-way sync is never enabled for Willow without
   separate approval.

---

## 9. Known `reschedule_appointment` status (audit follow-up)

The Phase-audit flagged that `reschedule_appointment` might still reference the
pre-0091 raw `cancellation_token` column. **Investigated and refuted:** the
function was re-created **hash-only in migration 0091** (which drops the raw
column *after* re-creating the RPC), and the **deployed** function references only
`cancellation_token_hash` (`raw column exists = 0`, `references raw = false`,
verified read-only against production). The audit had read the superseded **0029**
definition. **No live defect, no latent defect — no remediation PR is required.**
Phase A does not touch this function. (If a later phase edits it for outbound
sync, re-verify at that time.)
