# Google Calendar Two-Way Sync — Architecture

Canonical design for Hone's Google Calendar integration across all phases. When this doc and
the code disagree, the code plus
[the migration ledger](../production/migration-ledger.md) win. Per-phase status with evidence:
[capability-register.md §9](../production/capability-register.md).

---

## VERIFIED RUNTIME STATUS — 2026-07-27

**Overall posture: `DB applied` + `deployed` + `production-exercised once` + `currently
DORMANT`.** Deployed is not enabled. Read the distinction precisely.

| Question | Verified answer |
|---|---|
| Is any synchronization running? | **No.** |
| Is Willow Electrolysis connected? | **No.** She has never had an event synced. |
| How many studios are connected? | **One** — the controlled test studio, connected 2026-07-12, `connection_status='connected'`, `destination_mode='dedicated_app_created'`, `is_studio_calendar_owner=true`, `disconnected_at` NULL. |
| Granted scopes on that connection | `openid`, `userinfo.email`, `userinfo.profile`, **`calendar.app.created`**, `calendar.calendarlist.readonly`. **No `calendar.events.owned`. No broad `calendar.events`.** |
| Have real Google appointment events ever been created? | **Yes — exactly ONE.** On 2026-07-18, on that same controlled test studio. |
| `calendar_sync_outbox` | **1 row** — `op_type='event.create'`, `hone_entity_type='appointment'`, `status='done'`, `attempts=1`. |
| `calendar_event_links` | **1 row** — `sync_status='synced'`, `source_system='hone'`, `last_sync_direction='hone_to_google'`. |
| `google_calendar_outbound_sync_enabled` | **false on all 5 studios.** |
| `google_calendar_inbound_busy_enabled` | **false on all 5 studios.** |
| `google_calendar_two_way_updates_enabled` | **false on all 5 studios.** |
| `google_calendar_connection_enabled` | **true on the controlled test studio only**; false everywhere else, including Willow. |
| Is a worker draining the queue? | **No.** The worker flag is off and no studio is intent-eligible, so the enqueue path produces no work. |
| Are the calendar cron routes scheduled? | **YES — and this surprises people.** `vercel.json` registers three daily crons: `/api/cron/materialize-recurring-breaks` (`0 8 * * *`), `/api/cron/calendar-reconcile` (`0 9 * * *`) and `/api/cron/calendar-sync` (`30 9 * * *`). Both calendar routes **fire daily in production**. |
| So why is it still dormant? | Because **dormancy comes from the flags, not from the absence of a schedule.** The routes run, authenticate against `CRON_SECRET`, find **zero** intent-eligible studios and **zero** claimable jobs, and exit having done nothing. |

> **Do not describe the calendar cron routes as "not cron-registered" or "unscheduled".**
> Earlier revisions of this document and the operator checklist said exactly that; it is
> **false** as of PR #430. They are registered and they execute. What makes the system safe is
> that every studio's outbound flag is off, so there is no work for them to find.

> **Correction to earlier revisions of this document.** Prior versions stated that
> `calendar_sync_outbox` and `calendar_event_links` hold **0 rows** and that **no** Google
> event operation had ever occurred. That was true when written; it is **no longer true**.
> Each table holds **one row** from the single controlled outbound validation on 2026-07-18.
> The correct current statement is "exercised exactly once under control, then returned to
> dormant" — not "never exercised".

### Phase classification

| Phase | Code | DB | Deployed | Enabled | Production exercised |
|---|---|---|---|---|---|
| A — connection & OAuth foundation (0121/0122, PR #404) | merged | applied | ✅ | connection flag: **test studio only** | ✅ one connection |
| B1 — outbound schema + queue (0124, PR #407) | merged | applied | ✅ | — | see B2.3-a |
| B2.3-a — intent-gated enqueue + claim boundary (0125, PR #412) | merged | applied | ✅ | — no intent-eligible studio | ✅ **1 outbox row** |
| B2.4 — dual-destination + destination-derived scope (0131, PR #424) | merged | applied | ✅ | destination validated on the test studio | ✅ one app-created calendar |
| B2.3-b — reconciliation sweep + heartbeat + route (PR #426) | merged | *no migration* | ✅ | **scheduled** `0 9 * * *`, CRON_SECRET-protected | runs daily, finds 0 eligible studios |
| B2.3-c1 — event-operation layer + transition RPC (0132, PR #428) | merged | **applied** | ✅ | worker off | ❌ |
| B2.3-c2 — authenticated worker-drain route (PR #429) | merged | *no migration* | ✅ | **scheduled** `30 9 * * *`; worker flag off | runs daily, claim RPC returns 0 rows |
| B2.3-c3 — cron schedule registration (PR #430) | merged | *no migration* | ✅ | **3 daily crons registered in `vercel.json`**; **registration did NOT activate sync** | ❌ |
| Inbound busy import / two-way edits | **designed only** | — | **not built** | — | ❌ |
| Willow enablement | — | — | — | **not connected** | ❌ |

**Each of the following needs SEPARATE explicit authorization:** connecting Willow, enabling
any outbound/inbound/two-way flag on any studio, activating the worker, and beginning
inbound-busy or two-way work. Granting a destination permission or creating an empty
Hone-owned calendar enables **no** synchronization.

**Phase-name note:** the sequence is non-numeric on purpose — **B2.4 landed before
B2.3-b/B2.3-c** to finalize the destination and destination-derived scope semantics those
phases consume. B2.4 is, and remains, the completed dual-destination scope phase, not a
future-worker label.

---

## Historical status header (superseded — retained for context)

The paragraph below described the state as of roughly 2026-07-15. It is **point-in-time
history**; the verified table above supersedes it.

> **Deployed then (all dormant): Phase A (connection & OAuth foundation), the Phase
> B1 outbound-sync schema/queue foundation (0124), the B2.3-a enqueue+claim activation
> boundary (0125), the B2.4 dual-destination scope contract (0131), and the B2.3-b
> reconciliation sweep + heartbeat + dead-row alerting + authenticated
> `/api/cron/calendar-reconcile` route (PR #426, migration-free).** Everything that
> actually *moved a Google event* — the drain worker calling Google's event API,
> inbound busy, two-way edits — was design intent, **not shipped**; that outbound
> event-execution work was **B2.3-c** (§3f). Hosted migration max at that time = 0131.
> B2.4 = PR #424 merged + deployed + operator-validated dormant 2026-07-14 (see the
> owner-connection operator checklist §6).
  **Phase B2.3-b** (reconciliation sweep + heartbeat + dead-row alerting + the
  authenticated `/api/cron/calendar-reconcile` route) is **MERGED (PR #426, merge
  commit `f664f0f`), deployed, and DORMANT — migration-free** (hosted max stays
  **0131**): the route is deployed + **CRON_SECRET-protected** but **not**
  cron-registered (unscheduled), actuates only within intent-eligible studios (of
  which production has none), never calls Google, and never enables the worker or any
  flag — see §3e. **Next: B2.3-c** — the outbound Google event-execution layer
  (create/update/delete) + worker-drain route + controlled Sam-only activation (§3f).
  All Google flags default **OFF** (only Sam's `google_calendar_connection_enabled`
  is ON, on his controlled studio; all sync flags OFF). **No appointment-event sync
  runs**, but keep three distinct facts un-collapsed:
  - *Enqueue infrastructure is deployed but inactive.* B2.3-a (0125) deployed the
    outbound **enqueue path + DB triggers**; in production they **no-op / produce no
    work** because every studio's outbound flag is OFF and there is **no
    intent-eligible studio**. `calendar_sync_outbox` + `calendar_event_links` stay
    **empty (0 rows)**.
  - *Provisioning API was used; appointment-event CRUD was not.* **B2.4 exercised
    OAuth and Calendar provisioning to create the empty dedicated "Hone Appointments"
    calendar** on Sam's controlled studio; the exact **`calendar.app.created`** scope
    is currently **granted** on that connection (grants app.created=1 / events.owned=0
    / broad `calendar.events`=0). **No Google appointment-event create, update or
    delete operation has occurred**; no appointment event exists.
  - *No worker; reconciliation calls no Google.* No drain worker exists and no flag
    turns one on; the B2.3-b reconciliation route never calls Google.
- **Production exercised (per phase, precisely):**
  - **Phase A OAuth connection** — production-exercised once on **Sam's controlled
    studio** (one connection exists; least-privilege connect-time scopes).
  - **B2.4 dedicated-destination provisioning** — production-exercised **once** on
    Sam's controlled studio (OAuth + provisioning created the empty "Hone
    Appointments" calendar; `calendar.app.created` granted; **zero events**).
  - **B1 / B2.3-a / B2.3-b outbox, reconciliation, and event lifecycle** — **NOT
    production-exercised.** `calendar_event_links` + `calendar_sync_outbox` are empty
    (0 rows); no appointment event exists. B2.3-b returning `401` to an unauthenticated
    probe is an auth check, **not** a production exercise of the sweep.
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
are **B2.3-c**). Migration 0125 is DB-only — **it** makes no Google call and, by
itself, requests no event scope (the destination-derived scope is requested separately
by **B2.4** — see §3d, where `calendar.app.created` is already granted on Sam's
controlled connection); no re-consent, no studio flag enabled, and the global worker
control defaults OFF. Behavioural proof:
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
- **Post-bump verification, worker-race form (activation prerequisite).** B2.3-b verifies a
  bump by confirming a matching pending/processing op now exists. Once a live worker exists,
  a sufficiently fast worker could complete the op **between** the sweep's bump and its
  verification read. So the worker-phase must broaden post-bump verification to accept
  **either** a matching current pending/processing op **or** proof that the op already
  completed and advanced `calendar_event_links.last_hone_version` to the resulting version.
  Not reachable today (worker off) — an activation prerequisite, enforced by the static
  activation gate; no algorithm change in B2.3-b.
- **Dead-row alert partial unique index (future migration-bearing phase).** The dead-row
  sweep is the sole writer of `calendar_outbox_dead_rows` (verified at HEAD), so its
  coordinator-serialized read-then-insert dedupe holds today. A future migration should add
  a **partial unique index** `(studio_id, event) WHERE resolved_at IS NULL` scoped to this
  event kind, so at most one unresolved alert per studio is enforced at the DB layer.
  **NOT** added in B2.3-b (no migration).
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
Distinguish the migration from the phase's controlled validation:
- **Migration 0131 itself** is DB-only — it makes no Google call, mutates no
  appointment, and writes no enqueue / outbox / event-link / backfill row.
- **The B2.4 phase was operator-validated on Sam's controlled studio, which DID use
  Google:** OAuth + Calendar provisioning created the empty dedicated **"Hone
  Appointments"** calendar and the exact **`calendar.app.created`** scope is now
  **granted** on that connection. **No Google appointment-event create, update or
  delete operation has occurred** — broad `calendar.events` remains absent
  (grants app.created=1 / events.owned=0 / broad=0), no re-consent, no studio flag
  enabled, the global worker control stays OFF, `calendar_sync_outbox` +
  `calendar_event_links` stay empty, and Willow stays unconnected.

Behavioural + shape proofs live under `tests/db` / `tests/migrations` for 0131.

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
  B2.3-c worker operation returning `ok_noop_superseded` (already a defined JobResult
  code) when a job's `payload.sync_version` is older than the current link/appointment
  version — is a **B2.3-c worker-operation responsibility and needs no migration**
  (`appointments.sync_version` + `calendar_event_links.last_hone_version` already carry
  everything the fence needs). B2.3-b only ensures the current desired intent EXISTS.
- **Placeholder-vs-real link distinction (upsert contract).** A **placeholder** link
  (`google_event_id` null → no remote event) is never treated as convergence: a
  confirmed appointment with a placeholder link and no current job re-drives a
  **current upsert intent**. Because an active link already exists, the deployed
  enqueue trigger emits **`event.update`** (NOT `event.create`); no real provider
  update can occur (there is no provider event id), so the future B2.3-c worker op must
  treat `event.update` + a placeholder link as **create-and-bind**, and must fence any
  stale earlier create first. If the placeholder's create is terminally **dead** it
  enters a manual-review skip surfaced by the dead-row alert (no auto-loop). A
  **withdrawn cancellation** whose link is a placeholder is **inert** — never a provider
  `event.delete` without provider coordinates. Only a real-event link
  (`google_event_id` present) yields a delete/tombstone. Worker/cron activation is
  forbidden until both the stale-create fence and the create-and-bind behaviour are
  implemented + tested (see the B2.4 input list; enforced by a static activation gate).
- **Supersede-safe, no version inflation.** Every actuation is preceded by a **FULL
  pre-actuation revalidation**: the current appointment + its link + its jobs are
  re-read and the SAME classifier is re-run; the actuator fires only if the fresh
  decision still matches. For an orphan delete the link is re-read by id (detecting a
  rebind, a cleared `google_event_id`, a soft-delete, or an in-flight delete). Because
  `repair_bump_appointment_sync_version` increments unconditionally, a bump is issued
  only after that fresh check + an **intent-eligibility re-check** (do not mutate while
  the studio flag/owner/write target has gone unavailable) + a **forced ownership-token
  check immediately before the RPC**. And a returned version does not prove intent: the
  bump is **VERIFIED** — the entity's jobs are re-read to confirm a current matching
  pending/processing op now exists at the new version. If not (a swallowed trigger
  enqueue / lost intent) it is counted `intentVerifyFailed` (degraded), NOT enqueued and
  NOT converged, so the next run retries. Repeated/interleaved sweeps produce **exactly
  one** effective operation per appointment. (An orphaned, gone-appt link can never be
  rebound: the reschedule rebind keys on `rescheduled_from_appointment_id`, which is
  `ON DELETE SET NULL`, so a gone predecessor is unreachable — verified. The app-level
  re-read is therefore sufficient; no RPC/migration change is required.)
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
  (convergence is idempotent — we never skip to the end). Its write/clear are
  **ownership-atomic** — Lua compare-token scripts that mutate the continuation ONLY
  while the caller still owns the per-studio lock key, so a stale owner (whose lease was
  re-acquired by a newer sweep) can neither overwrite nor clear the newer owner's record.
  It is stored **durably with NO arbitrary expiry** (schema-versioned; removed only by an
  explicit ownership-atomic clear) — a short TTL could expire between scheduled
  invocations and silently restart a large studio, so it is not used. A studio is counted
  *completed* only when its continuation was cleared (or proven absent) while still owned.
  Rows created after the snapshot are covered organically by the trigger.
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
  The ownership check before every actuator is a **forced** renew (not just between
  pages); the route deadline is kept materially below the TTL but is NOT a substitute for
  that final check. A second concurrent sweep for the same studio is skipped. **Lock
  acquisition / integrity failure is fail-closed** — if Upstash is unreachable, or a
  renewal cannot confirm continued ownership, the sweep **stops mutating immediately**,
  preserves its cursor BEFORE the unprocessed item, persists a continuation for the
  remainder, and reports degraded; it never runs past a lost lease or sweeps unlocked.
  This is the one place that is *not* fail-open.
- **Exactly TWO coordinators, never held simultaneously by one invocation.** (1) The
  **main reconciliation coordinator** (`gcal_reconcile:coordinator:lock` + durable cursor
  `gcal_reconcile:studio_cursor`) serializes route invocations and owns the global studio
  cursor; it is acquired + **released inside `runReconciliation`**. (2) The **dead-alert
  coordinator** (`gcal_reconcile:dead_alerts:lock` + durable cursor
  `gcal_reconcile:dead_alerts:cursor`) owns the dead-row alert campaign, acquired **after**
  the main coordinator is released. Between them, metric pruning runs **UNLOCKED**. Each
  coordinator's cursor holds only the last-attempted immutable studio id, is written
  **ownership-atomically** (Lua compare-token guarded by that coordinator's lock), and is
  **durable (no expiry)** — cleared only by an ownership-atomic clear on completion. Both
  are fail-closed (unavailable → the campaign does not run; held → benign skip). Per-studio
  locks remain the mutation-safety boundary. There is no third coordinator or maintenance lock.
- **Anti-starvation (both cursors).** Eligible studios (and dead-row studios) are sorted by
  immutable id and processed in **wrap-around** order starting AFTER the cursor, so the same
  first studios can never be swept forever while later ones starve — every studio eventually
  gets a turn even when every invocation processes only one before its deadline. A read I/O
  error on a cursor is `unavailable` (do not run from an unknown position); an **absent**
  cursor starts at the beginning (a lost record never skips to the end — convergence /
  dedupe are idempotent).
- **Route flow (three cases).** *Main coordinator HELD* → benign concurrency: return `202`
  `skipped_held`, run **no** prune / **no** dead-row sweep, and write **NO** heartbeat (a
  stale heartbeat after a crashed active run is the intended monitoring signal and must stay
  visible — the held invocation must not refresh it). *Main coordinator UNAVAILABLE* →
  truthful degraded response, no maintenance, **no successful heartbeat**. *Main
  reconciliation RAN* → unlocked metric prune → dead-alert coordinator campaign → final
  heartbeat tier → truthful response. Each notable outcome emits a PHI-free, tenant-safe,
  best-effort operational signal (fail-open — a failed signal never changes route/lock/cursor
  behaviour).
- **Dead-row alert campaign.** Reads the pre-aggregated `calendar_sync_queue_health` view
  via **durable-cursor** pagination (immutable studio_id; no raw multi-thousand-row scan),
  resuming AFTER the persisted cursor, bounded by the studio cap + route deadline,
  ownership-atomically persisting the cursor after each fully-processed studio and clearing
  it on completion. Explicit outcome model: `completed` / `deferred` / `skipped_held` /
  `unavailable` / `error`. The deduped, PHI-free `calendar_outbox_dead_rows` alert
  (studio-scoped, aggregate count only) recurs after resolution, never reopens a dead row.
  **Sole-writer:** the sweep is the only writer of `calendar_outbox_dead_rows` (verified), so
  the coordinator-serialized read-then-insert dedupe is sufficient today; a **future
  migration-bearing phase** should add a partial unique index (`(studio_id, event) WHERE
  resolved_at IS NULL`, scoped to this event) — NOT in B2.3-b (no migration).
- **Heartbeat tiers (truthful).** `error` is reserved for a reconciliation-run failure. A
  successful run preserves its outcome (`ok`/`degraded`) when the dead-row campaign
  `completed`; **any** non-completed dead-row outcome (deferred / skipped_held / unavailable
  / error) makes a successful run **at least `degraded`** — never falsely `ok`. `at` is the
  completion time; the scheduler classifier treats a recent degraded/error heartbeat as NOT
  healthy. A **store/inventory failure is `error`, not a completed sweep** — fail-open (a
  failed alert INSERT / signal never blocks bookings or reconciliation) does not mean
  "maintenance succeeded". Metric pruning is unlocked, best-effort, fail-open, idempotent,
  and acquires no lock. Observability failing open must not be confused with the coordinators
  + cursors, which are fail-closed. The stale/degraded/error scheduler alert recorder exists
  but is **not** wired to a schedule in B2.3-b (no cron cadence yet — that is B2.3-c).
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
- **Deferred to B2.3-c:** the outbound Google event-execution layer
  (create/update/delete + the fixed minimal serializer), the worker-drain route
  (`/api/cron/calendar-sync`), registering the reconciliation + worker-drain crons,
  wiring the stale-run heartbeat alert to a schedule, and controlled Sam-only
  activation. **B2.3-c is the worker phase (§3f)** — NOT "B2.4 worker" (B2.4 is the
  completed destination phase).

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

## 3f. B2.3-c — outbound Google event execution and controlled activation (NEXT — design intent, NOT built)

> **Phase-name binding.** **B2.4** is, and remains, the completed **dual-destination +
> destination-derived scope** phase. **B2.3-c** is the future **outbound worker** phase.
> Do **not** call the future worker "B2.4 worker". The register sequence is non-numeric
> because B2.4 landed before B2.3-b/B2.3-c to finalize destination + scope semantics.
> B2.3-b (reconciliation sweep, §3e) is merged + deployed dormant; B2.3-c is next.

> **B2.3-c1 implementation status — AUTHORED IN A PR, DORMANT, NOT YET DEPLOYED.**
> The event-operation layer below is **implemented** (`lib/google-calendar/sync/`:
> `event-id.ts`, `serializer.ts`, `stale-fence.ts`, `link-transition-store.ts`,
> `operations.ts`) plus **migration `0132`** (the transactional
> `calendar_event_link_transition` RPC + corrected placeholder version semantics +
> placeholder-aware cleanup). It is **dormant**: the operations map is imported only by
> server-only worker modules, **no app route wires it**, `/api/cron/calendar-sync` does
> not exist, no calendar cron is registered, and `worker_enabled` + all studio flags stay
> **OFF**. **Migration `0132` is authored but NOT hosted-applied** (repo max `0132`, hosted
> max `0131` — the intended pending-apply signal); its migration-first hosted apply and the
> PR merge require separate authorization. **Two approved register amendments** are in
> force: (1) a **machine-only private correlation marker** `extendedProperties.private`
> `{hone:"1", hlk:base32hex(SHA-256(link.id))}` (non-PHI, one-way) that proves Hone's own
> lifecycle and detects a foreign event on the derived id; (2) **GET-verified
> placeholder-delete orphan recovery** (replacing the blanket "placeholder delete is
> inert" rule — a placeholder delete now GETs the derived id and verifies the marker
> before any provider delete, never a blind DELETE). **Provider identity** is the exact
> 57-char `"hone1"` + full 52-char lowercase base32hex SHA-256 of `studio_id + ":" +
> link.id` (no truncation); a fresh lifecycle comes only from a fresh link row
> (`rotate_for_recreate`). A cancelled Google event is **never** bound as `synced`. The
> outbox stays under the existing claim → handle → `record_calendar_sync_result` authority
> (the link-transition RPC persists link state only, never the outbox). **B2.3-c2** (the
> authenticated worker-drain route) remains the next sub-phase.

**Objective.** Safely **execute** the already-durable Hone outbound *intent* — by
creating, updating, and deleting the approved **minimal** Google events — and prove the
full lifecycle on **Sam's controlled dedicated destination** before any Willow
enablement. **B2.3-c is outbound only.** It does **not** include: inbound Google busy,
Google→Hone edits, two-way sync, destination-mode switching, Willow activation,
Google-originated appointment creation, shared/non-owned calendar support, broad
`calendar.events`, or deleting a Hone-created Google calendar on disconnect.

### B2.3-c implementation sequence (separately reviewable sub-PRs)

**B2.3-c1 — Google event operations, DORMANT.** Implement the real event-operation
layer with **no** route, cron, or runtime activation: the fixed minimal serializer;
`event.create` / `event.update` / `event.delete` operations; execution-time tenant +
destination revalidation; the execution-time stale-version fence; placeholder-link
**create-and-bind**; provider idempotency + duplicate-replay safety; **the existing
enqueue/repair machinery creates or preserves a local placeholder link
(`google_event_id` null — a placeholder does not claim a Google event exists) *before*
provider execution, while provider coordinates (`google_event_id` and any returned iCal
UID / ETag) and provider-applied link state (`sync_status`, `last_hone_version`, …) are
persisted *only after* confirmed provider success or an explicitly defined
ambiguous-response reconciliation** — provider-applied state must not falsely advance
before the provider result and local persistence are safely committed, and provider
success is never recorded while provider-coordinate persistence is missing except
through an explicit recoverable partial-success state (B2.3-c1 builds the operation
behavior; it does **not** replace or delay the already-shipped placeholder lifecycle);
retry + terminal result mapping; partial-success recovery; **fake-Google** transport
tests (no real Google call in validation); no worker activation. **Approved v1 payload (exact):** `summary` = constant `"Hone appointment"`;
`start` = appointment `starts_at`; `end` = appointment `ends_at`; `visibility` =
`private`; `transparency` = `opaque`; **no** location, description, attendees, client
identity, or health/treatment/payment/internal-token data.

**B2.3-c2 — worker-drain route, deployed DORMANT.** Wire the existing
claim→handle→record adapters into a bounded authenticated drain route
`/api/cron/calendar-sync`: `CRON_SECRET` auth; bounded batch + route deadline; claim via
`claim_calendar_sync_op`; execute through the approved operations map; record via
`record_calendar_sync_result`; aggregate PHI-free response; operational heartbeat +
alerting; no browser-supplied tenant/provider ids; **no cron registration yet**;
`worker_enabled` remains false; all studio sync flags remain false; no hosted outbox
work; **no real Google call during dormant-deployment validation**.

> **B2.3-c2 implemented + reviewed (PR #429).** At the final pre-merge review point PR #429
> was open and CI-green at the reviewed implementation head `f9ce6db` (0 unresolved threads).
> **When the final documentation-only descendant merges, B2.3-c2 becomes deployed dormant**;
> it remains **unscheduled** (c3 owns schedule registration), the worker stays off, every
> studio sync flag stays off, and migration max remains `0132`. As of this pre-merge
> checkpoint **no real Google appointment-event operation has occurred**. Operational
> completion remains contingent on merge-commit CI, the production deployment, and the
> separately-recorded authorized no-work validation (NOT asserted here). c4 owns Sam-only
> controlled activation.
> The route lives at `app/api/cron/calendar-sync/route.ts` (Node runtime, `force-dynamic`,
> `Cache-Control: no-store`) and delegates to the one server-only seam
> `lib/google-calendar/sync/worker-runtime.ts`, which is the FIRST and ONLY application
> path allowed to import the c1 operations map. Fixed, non-caller-controlled bounds:
> batch size 5, at most 3 batches (≤ 15 claimed). The **50s value is the job-ADMISSION
> window** (`WORKER_JOB_ADMISSION_WINDOW_MS`) — it only gates STARTING new work / claiming a
> new batch, NOT the total invocation duration. The platform ceiling is pinned as a literal
> `export const maxDuration = 180` in the route (Next/Vercel static detection; **never via
> `vercel.json`**), guaranteeing ≥ 120s of completion headroom for the last in-flight job
> after the admission window closes (`180000 − 50000 = 130000 ms ≥ 120000`; asserted by
> constant + test). It authenticates first (`isAuthorizedCronRequest`, before any admin
> client or claim), rejects any caller-supplied query parameter with a PHI-free 400, then
> drains `claim_calendar_sync_op` → `handleCalendarSyncJob` (c1 operations map) →
> `record_calendar_sync_result`, distinguishing the **handler** JobResult from the
> **durable** record-RPC status (`done`/`pending`/`dead`/`already_*`/`not_*`/`stale_token`)
> and never touching the outbox itself. A worker-specific fail-open heartbeat
> (`gcal_worker:last_run`, distinct from the reconciliation heartbeat) and bounded
> fail-open ops alerts carry only PHI-free aggregates.
>
> **Refresh-secret read failures are preserved (not forced reconnect).** The production
> connection store's `loadRefreshCiphertext` now DISTINGUISHES a genuinely-absent secret
> (query succeeds, no row → `null` → the existing `no_refresh_token` reconnect path) from a
> FAILED/uncertain read (a Supabase `error` or a thrown transport error → a safe typed
> `RefreshSecretReadError`). The token manager maps that to a **transient**
> (`refresh_secret_read_error` → worker `retry_transient`) and NEVER calls
> `markReconnectRequired` or touches the stored refresh token, so a transient DB blip can no
> longer force a connection into `reconnect_required`. The Upstash refresh lock still
> releases normally in `finally`. No raw Supabase/SQL detail, connection id, ciphertext, or
> token is ever surfaced.
>
> **Architecture amendment — the token-refresh coordinator.** The original design called
> for `createPgRefreshCoordinator` (a `pg_advisory_xact_lock`), but the deployed serverless
> route holds no pooled raw-Postgres connection: `pg` is a dev-only dependency deliberately
> kept out of the application bundle, there is no production Postgres connection-string
> secret, and none may be added in this phase. c2 therefore implements a NEW **Upstash**-
> backed implementation of the existing `RefreshCoordinator` interface
> (`createUpstashRefreshCoordinator`, key `gcal_refresh:lock:<connectionId>`, random
> ownership token, atomic `SET … NX EX`, ownership-safe compare-and-delete release, fixed
> 120s TTL) using ONLY the existing `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN`.
> It **fails closed** (a held/unavailable/thrown lock throws a safe typed error the token
> manager maps to the bounded `refresh_lock_error` transient — an uncoordinated refresh
> never runs). This is a **narrow per-connection token-lifecycle mutex, not a third worker
> coordinator**: the only two Google Calendar orchestration coordinators remain
> reconciliation and dead-row alerting, and worker concurrency is owned entirely by the
> claim RPC + `FOR UPDATE SKIP LOCKED` + claim tokens + lease expiry + the reaper. The token
> manager and the c1 operations-map invalidator share ONE process access-token cache. **No
> `pg`, no new environment variable, no migration, no new infrastructure was added.** The
> route is unscheduled, `worker_enabled` stays false, every studio sync flag stays false,
> and an authorized invocation while dormant claims zero rows, calls Google zero times, and
> mutates nothing.

**B2.3-c3 — scheduler + observability readiness.** Prepare scheduled execution while
still preventing Google dispatch, in this **safe order**: (1) register the
reconciliation schedule first; (2) keep every studio outbound flag OFF; (3) keep
`worker_enabled` false; (4) observe reconciliation heartbeat + dead-alert coordinator +
maintenance behaviour; (5) register/validate the worker-drain schedule only after the
route is independently reviewed; (6) keep `worker_enabled` false so claim returns no
work and mutates nothing; (7) prove scheduled **no-op** behaviour before enabling any
studio. **Cron registration does NOT enable synchronization** — the data gate (studio
outbound flag) and worker gate (`worker_enabled`) remain authoritative.

> **B2.3-c3 implemented (this PR — authored, held for exact-head review; DORMANT).** Both
> Google Calendar cron routes are now registered in `vercel.json` as **daily** schedules,
> staggered after the 08:00 `materialize-recurring-breaks` cron, reconciliation before the
> worker: `/api/cron/calendar-reconcile` at **`0 9 * * *`** and `/api/cron/calendar-sync` at
> **`30 9 * * *`** (single source of truth: `lib/cron/calendar-cron-schedule.ts`, pinned by
> `tests/app/cron-config.test.ts` + the activation gate). **Why daily:** the production Vercel
> plan caps cron cadence at **once per day** — a sub-daily `*/N` cron is rejected at deploy
> (the same reason the appointment-reminder route runs on an external every-15-min scheduler;
> see docs/08 + docs/10). Daily is sufficient for the dormant no-work proof; a higher cadence
> for real draining is a later (activation-time) decision. **Dormancy is now enforced by
> `worker_enabled=false` + the studio intent flags, NOT by being unscheduled:** when these
> crons fire, the claim RPC returns zero rows and mutates nothing, and the reconciliation
> sweep finds zero intent-eligible studios. No migration (max stays `0132`); no worker/flag
> is enabled; no queue row is seeded; the existing `materialize-recurring-breaks` cron is
> preserved exactly. **The first Vercel-scheduled `/api/cron/calendar-sync` run is the
> accepted platform-originated replacement for the B2.3-c2 manual no-work validation** (Vercel
> Cron auto-supplies the production `CRON_SECRET` in the Authorization bearer — solving the
> sensitive-secret delivery that blocked manual validation), expected to return HTTP 200
> `no_work:true` with all counters zero and write only the `gcal_worker:last_run` heartbeat.
> **c4, not c3, owns Sam-only controlled activation.**

**B2.3-c4 — Sam-only controlled activation.** Prove the full outbound lifecycle on Sam's
controlled dedicated **"Hone Appointments"** calendar, in this **exact order**:
1. Read-only production baseline: migration max, worker state, flags, outbox count, link
   count, scope counts, destination readiness.
2. **Confirm the controlled destination + reconnect preflight (conditional — not an
   assumed step).** Confirm `dedicated_app_created`, owner-bound, not ambiguous, exact
   `calendar.app.created` scope granted, write calendar configured. **Re-read connection
   health and the exact destination-derived grants immediately before activation.** For
   Sam's dedicated path, **no new consent or reconnect is required** while the connection
   remains `connected`, the encrypted refresh token remains usable, and the
   `calendar.app.created` grant is present — **do not reconnect merely because B2.3-c
   begins.** Reconnect is required **only if** the connection is `reconnect_required`, the
   dedicated grant is missing or unusable, or a **separately approved** `existing_owned`
   validation needs `calendar.events.owned`. A **Testing-mode token expiry** may
   legitimately produce `reconnect_required` — treat it as a **preflight condition, not an
   assumed step**. **Existing-owned incremental consent remains separate and is NOT part of
   the first dedicated activation.**
3. Keep Willow unconnected.
4. **Initial-activation candidate-set gate (MANDATORY — before enabling any flag).** The
   deployed reconciliation boundary sweeps **every** appointment that is `status =
   confirmed` **and** `ends_at >= activation_started_at` **and** not already converged —
   not a caller-chosen appointment. So, with **intent still OFF**, perform a **read-only**
   enumeration of that exact candidate set:
   1. Enumerate every appointment that would qualify under the deployed
      initial-activation boundary for Sam's controlled studio.
   2. Record only **safe operational identifiers and counts** (no PHI — no client name,
      email, phone, or notes).
   3. Confirm the candidate set contains **exactly** the one explicitly approved
      controlled appointment for this first live worker test.
   4. Confirm **no** unrelated future or in-progress appointment would be queued.
   5. Confirm there is **no** existing pending, processing, dead, or otherwise
      conflicting calendar work for the studio.
   6. Confirm the target appointment is **synthetic** or otherwise explicitly approved
      for this controlled test.

   **If the candidate set contains more than the approved appointment: STOP.** Do **not**
   enable the studio flag; do **not** delete, cancel, or alter unrelated appointments
   merely to manufacture a clean test. Instead use a **separately approved clean
   controlled studio**, or return for a targeting/isolation design. Batch size 1 does
   **not** guarantee the intended appointment when multiple claimable rows exist — the
   claim RPC selects by **queue ordering**, not by a caller-supplied appointment id.
5. Enable outbound **intent** only for Sam's controlled studio (only after the gate above
   passes).
6. Keep `worker_enabled` false.
7. Run bounded reconciliation manually.
8. Inspect (fail-closed proof, worker still OFF): exactly the expected outbox intent; a
   placeholder event link; no unexpected tenants; no PHI in payload; **no provider event
   yet**. Then prove the **single-operation** invariant before enabling the worker:
   **exactly one** claimable operation exists; it belongs to the **approved** appointment;
   **exactly one** corresponding placeholder link exists; **no other** appointment was
   enqueued; and the future worker's **bounded claim cannot select a different
   operation**.
9. Enable worker execution only under a **separately approved, time-boxed** gate.
10. Process **one** controlled appointment operation.
11. Immediately verify: exactly one Google event; created in "Hone Appointments"; approved
    minimal payload only; provider event id bound to the correct link; source version
    recorded; outbox result `done`; no duplicate event; no cross-studio impact.
12. Disable worker execution after the controlled operation unless the approval explicitly
    authorizes continued testing.
13. Separately test, **one approved operation at a time** (not an uncontrolled batch),
    **inspecting the queue between tests** so only one claimable operation is ever
    present: create; time update; duration update; withdrawn cancellation/delete;
    duplicate replay; transient retry; stale-operation suppression; reconnect-required
    behaviour; placeholder-update create-and-bind; partial create/link-write recovery.
14. End with worker + controlled-studio flags disabled unless a later approval authorizes a soak.

**B2.3-c5 — controlled soak + rollout decision.** Decide whether outbound may remain
enabled for the controlled studio. **Required evidence:** no duplicate events; no stale
dispatch; no cross-tenant access; no retry storms; no dead rows without an alert;
reconciliation heartbeat healthy; worker heartbeat healthy; queue drains; reconnect
behaviour truthful; no PHI leakage; update/delete lifecycle proven; provider rate limits
handled; operational rollback tested. **Completing the controlled soak does NOT authorize
Willow.**

### Worker activation prerequisites (before `/api/cron/calendar-sync` executes real ops)

Enforced by the static activation gate (`tests/app/google-calendar/b2-4-worker-activation-gate.test.ts`).
Do **not** mark complete without direct code + test evidence — **all remain unproven today (worker unbuilt):**
1. A stale earlier operation returns `ok_noop_superseded`.
2. `event.update` against a placeholder link (null `google_event_id`) performs provider create-and-bind.
3. A successful create persists `google_event_id` to the link.
4. A duplicate replay cannot create a second provider event.
5. A partial Google-create / local-link-write failure is recoverable.
6. Post-bump verification accepts **either** a matching current pending/processing operation **or** proof the operation already completed + advanced `last_hone_version`.
7. Destination + required scope are revalidated at execution time.
8. Broad `calendar.events` is accepted **nowhere**.
9. The job connection + link are studio-bound.
10. A provider success is never recorded before local link persistence succeeds (or enters an explicit recoverable state).
11. No event content exceeds the v1 privacy allow-list.
12. No production route imports a live operations map before these tests exist.

### Create / update / delete semantics (expected provider behaviour)

- **Create** — used when there is no real provider event; retry-safe; must not produce
  duplicate provider events after ambiguous responses; binds provider coordinates only
  after confirmed create/reconciliation; a placeholder `event.update` is treated as
  create-and-bind.
- **Update** — requires a real provider event id **unless** using the explicit placeholder
  upsert rule; compares the job source version to current Hone/link state; stale work
  returns `ok_noop_superseded`; a provider `404` enters an **explicit recovery path**, not
  a blind success.
- **Delete** — requires a real provider event coordinate; missing/already-deleted provider
  events may be treated as converged **only under an explicit documented rule**;
  placeholder links produce **no** provider delete; a rescheduled predecessor stays
  delete-suppressed when the link was rebound to the successor.

> **Mandatory pre-implementation checkpoint:** the final `404` / ambiguous-response policy
> is **unresolved** and must be decided from code discovery + the live Google API contract
> before B2.3-c1 implementation — do not invent it here.

### Provider idempotency + partial-failure requirements (decide + test in B2.3-c1)

The worker implementation must decide and test, **verified against the official Google
Calendar API contract at implementation time** (do not assume an unsupported capability):
whether Google event ids are caller-controlled for Hone's chosen insert path; whether a
deterministic provider id is safe/valid; whether an extended property (or another
non-sensitive correlation value) is required; how ambiguous create responses are
reconciled; how duplicate creates are detected; how provider-success + local-persistence-
failure is recovered; how local success is fenced against stale result recording; how a
retry distinguishes create / update / already-converged states.

### Execution-time stale fence (worker)

Before **any** Google call, compare the claimed job's source version + desired operation
against the current: appointment status; appointment `sync_version`; active link; link
`last_hone_version`; provider-event presence; destination + connection; current studio
outbound intent; current scope/readiness. Examples that must yield **no Google call**:
stale `v1` create while a `v3` upsert exists; stale update after cancellation; stale delete
after reschedule rebind; a duplicate already-applied version; a destination mismatch (fail
closed); a disconnected / reconnect-required connection. Use `ok_noop_superseded` where
appropriate.

### Runtime controls + rollback

Distinct controls (never conflate them): **studio outbound flag** = product intent;
**connection health** = execution eligibility; **global `worker_enabled`** = claim/dispatch
gate; **cron registration** = external invocation schedule; **`CRON_SECRET`** = route
authentication. **Rollback order:** (1) disable `worker_enabled`; (2) disable the controlled
studio outbound flag when new intent must stop; (3) leave existing queue/link state intact
for diagnosis; (4) do **not** delete the Google calendar; (5) do **not** erase provider
coordinates; (6) do **not** reconnect/rotate credentials during incident response without
separate approval; (7) preserve dead rows + operational evidence. **Disabling the worker is
not the same as disabling product intent.**

### Migration decision checkpoint (start of B2.3-c)

**Default: NO migration** unless direct implementation evidence requires one. Possible
migration-bearing follow-ups: the partial unique index for unresolved
`calendar_outbox_dead_rows` (`(studio_id, event) WHERE resolved_at IS NULL`); new provider
idempotency/recovery state that cannot fit the existing schema; a transactional
link/result-persistence RPC; generation/move fencing not already safely represented; other
correctness constraints. Any migration must be the **next repo migration number at
implementation time** (do **not** pre-assign `0132` — another migration may land first),
**proposed before application, independently approved migration-first, and NOT applied
inside the implementation PR without approval**.

### Dedicated vs existing-owned rollout

- **Dedicated app-created** is the controlled default path for Sam: one empty "Hone
  Appointments" calendar, `calendar.app.created` grant, no events, no ambiguity — the
  **first** worker-validation target.
- **Existing-owned** validation is **separate** and NOT required to prove the dedicated
  path: it needs owner-access revalidation, the exact `calendar.events.owned` grant,
  cross-boundary error behaviour (404 vs 403), owner-only calendar selection, and
  independent operator approval. **Do not test existing-owned during the first dedicated
  activation.**

### Google publication + Willow gate (destination-aware)

No destination is "verification-free": dedicated app-created is the verification-**light**
default *from a scope perspective*; existing-owned uses a **sensitive** scope. **OAuth
Testing mode is not suitable for a production Willow rollout.** Google app publication,
consent-screen truthfulness, and any required verification must be completed **before**
external-client activation, with the exact requirements verified against the **live Google
console + current Google policies at rollout time**. **Willow remains unconnected until
separate approval after controlled proof.** Willow activation requires: the worker
lifecycle proven on Sam; production monitoring proven; rollback proven; the Google
publication/verification decision complete; privacy + consent copy approved; Willow-
specific owner setup; and **separate explicit authorization**.

### When B2.3-c is complete

B2.3-c is complete **only** when: real create/update/delete operations exist; all
activation prerequisites pass; the worker-drain route exists + is authenticated; route +
operations are independently reviewed; reconciliation + worker scheduling are proven safe;
the Sam-only dedicated lifecycle is proven; stale operations do not dispatch; duplicate
replays do not duplicate events; placeholder create-and-bind works; link state reflects
provider truth; retry + terminal states are observable; rollback is proven; and the
controlled-soak decision is recorded. **B2.3-c completion still does NOT mean** inbound
busy, two-way edits, existing-owned, Willow authorization, Google verification, or
full-customer calendar integration are complete.

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

### Incremental authorization strategy — historical pre-B2.4 strategy (SUPERSEDED; retained for decision provenance)

> **⚠️ HISTORICAL — pre-B2.4, superseded by B2.4 (§3d). Do not read the paragraphs
> below as the current plan.** The **active** outbound authorization contract is:
> `dedicated_app_created` → **`calendar.app.created`**; `existing_owned` →
> **`calendar.events.owned`**; broad **`calendar.events` is accepted nowhere**;
> **B2.3-c is the worker/event-execution phase** (not "B2.4 worker" or "B2.5"); and
> **Sam's dedicated path already holds its required `calendar.app.created` grant** (empty
> "Hone Appointments" calendar already provisioned — see §3d). The text below (including
> its `calendar.events.owned`-single-scope, broad-`calendar.events`-fallback, "expected
> migration 0126", "B2.5", "open B2.4 validation", and "Sam requires a future reconnect"
> language) is **obsolete** and kept only for decision history.

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
serializer** that maps the allow-list above into a Google payload belongs to
**B2.3-c1 and is NOT built in B2.3-b** — the reconciliation sweep produces no
payloads and makes no Google call; it only re-drives intent through the trigger.

---

## 7. Phase register — status + later phases

**Completed, deployed dormant** (hosted migration max **0131**):
- **Phase A** — connection & OAuth foundation (0121/0122, PR #404).
- **B1** — queue + event-link schema (0124, PR #407): `calendar_event_links` + durable
  `calendar_sync_outbox` + service-role claim/result RPCs; inert (0 rows).
- **B2.1** — transport-neutral worker **core** + adapters (`lib/google-calendar/sync/handler.ts`,
  `adapters.ts`), where already shipped — DI-seamed, wired to nothing, no live operations map.
- **B2.3-a** — intent-gated enqueue + claim activation boundary (0125, PR #412).
- **B2.4** — dual-destination + destination-derived scope contract (0131, PR #424).
- **B2.3-b** — reconciliation sweep + heartbeat + dead-row alerting + authenticated
  `/api/cron/calendar-reconcile` route (**PR #426, merge `f664f0f`, migration-free**);
  deployed + CRON_SECRET-protected, **not scheduled**; see §3e.

**Next — B2.3-c: outbound Google event execution + controlled activation (§3f).** The real
`event.create`/`update`/`delete` operations, the fixed minimal serializer, the worker-drain
route `/api/cron/calendar-sync`, the reconciliation + worker cron registrations, and
controlled Sam-only dedicated-destination activation. **Google event transport itself is
still unbuilt** — this is where it lands. **For Sam's dedicated path, no new consent or
reconnect is required** while the connection remains `connected`, the encrypted refresh
token remains usable, and the exact `calendar.app.created` grant remains present (all
recorded today — the empty "Hone Appointments" calendar is already provisioned).
**Reconnect is required only if** the connection enters `reconnect_required`, the required
dedicated grant is missing or unusable, or a **separately approved** `existing_owned`
validation requests `calendar.events.owned` (broad `calendar.events` is **retired**;
`dedicated_app_created` → `calendar.app.created`, `existing_owned` →
`calendar.events.owned`; see §3d). See §3f for the full sub-phase register, the reconnect
preflight rule, activation prerequisites, semantics, and rollout gates.

**Later:**
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

**Milestones to date (all dormant):** connection foundation proven on Sam (Phase A
connection created once, least-privilege, no event scope); the **dual-destination
dedicated path proven** on Sam (one empty "Hone Appointments" calendar,
`calendar.app.created` grant, zero events, not ambiguous); **B2.3-b deployed dormant**
(reconciliation route live + CRON_SECRET-protected + unscheduled). **The next controlled
subject remains Sam** (B2.3-c dedicated-destination outbound lifecycle, §3f). **Willow
remains OFF.** Outbound completion (B2.3-c) implies **no** inbound busy and **no** two-way
edits — those are separate later phases (§7).

1. Apply 0121 + 0122 (additive, dormant). Deploy code. Keep
   `google_calendar_connection_enabled` **OFF**. Do not create a production
   connection. **(Done — dormant.)**
2. Separate approval → enable the connection flag for **Sam's controlled studio
   only**, connect Sam's controlled Google account, validate the foundation
   (state single-use, secret unreadable by a peer, no token in logs), then
   disable. **(Done — Sam connected, dedicated destination validated, dormant.)**
3. Each later phase repeats the Sam-only, flag-gated, **validate-then-disable**
   pattern (or an explicit soak approval) before any broader enablement. B2.3-c
   sub-phases (§3f) each carry their own read-only baseline → intent-only →
   time-boxed worker gate → verify → disable ordering.
4. **Willow remains OFF** through every phase until each is proven on Sam's studio
   AND separately approved — and, for outbound, until the Google publication /
   verification decision is complete and privacy + consent copy is approved (§3f). Two-way
   sync is never enabled for Willow without separate approval. **Willow launch is not
   approved.**

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
