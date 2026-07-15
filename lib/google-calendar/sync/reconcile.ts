import "server-only";

// Google Calendar — Phase B2.3-b: the transport-neutral reconciliation SWEEP core.
//
// This module is the single orchestration seam the reconcile cron route calls. It
// depends on NO Next.js/Vercel/Supabase/host type — only on an injected
// `ReconcileStore` (data access), a `ReconcileLock` (cross-process per-studio
// mutual exclusion), and a `now()` clock. That lets the SAME logic run against the
// real service-role Supabase client (production route) AND against a raw-pg store
// in the DB integration tests (so the REAL enqueue trigger + repair RPCs execute).
//
// WHAT THE SWEEP IS (and is not):
//   * It is a bounded DRIFT DETECTOR + ORCHESTRATOR over the EXISTING DB repair
//     primitives. It builds NO enqueue path, NO idempotency key, NO outbox/link
//     bookkeeping of its own, and NEVER calls Google. All identity/dedupe/
//     supersede/state-machine semantics remain the enqueue trigger's + outbox's.
//   * The ordinary appointment-intent generator remains the DB trigger
//     (`enqueue_calendar_outbound`). The sweep recovers ONLY the gaps the trigger
//     could not cover: mutations made while product INTENT was unavailable
//     (studio flag off / no owner / no write calendar / a swallowed never-raise
//     enqueue), plus initial activation of a studio's not-yet-ended confirmed
//     appointments.
//
// INTENT vs HEALTH (why the sweep is safe in production):
//   * The sweep only actuates within INTENT-ELIGIBLE studios (outbound flag ON +
//     an owner connection + a chosen write calendar) — the same gate the trigger
//     applies. Bumping an appointment in an intent-OFF studio would inflate
//     `sync_version` with NO enqueue (the trigger early-returns), so the sweep
//     never touches such studios. Every production studio is intent-OFF today, so
//     the sweep finds zero eligible studios and does zero work.
//   * Connection HEALTH (connected / scope / token) is the CLAIM gate, not an
//     enqueue gate. The sweep — like the trigger — is health-agnostic: work made
//     during a health outage already accumulates as pending/parked jobs and drains
//     when health returns. The sweep does NOT reconcile health-outage windows and
//     must never duplicate that already-pending work.

// ---------------------------------------------------------------------------
// Data shapes (minimal, operational-only — never client content / PHI).
// ---------------------------------------------------------------------------

// A confirmed, not-yet-ended appointment considered for create/update.
export type ReconcileApptRow = {
  id: string;
  syncVersion: number;
};

// The current state of any appointment referenced by an active link (for the
// link pass): status drives delete-vs-keep.
export type ReconcileApptState = {
  id: string;
  status: string; // 'confirmed' | 'cancelled' | 'completed' | 'no_show'
  syncVersion: number;
  cancellationKind: string | null; // 'rescheduled' | 'withdrawn' | null
};

// An active (deleted_at is null) appointment→event link.
export type ReconcileLinkRow = {
  id: string;
  honeEntityId: string;
  googleEventId: string | null; // null = local placeholder (no real Google event yet)
  lastHoneVersion: number;
};

// The four documented reconciliation classes (matches google-calendar-sync.md §3c).
export type ReconcileClass =
  | "missing_link_job" // Class 1: confirmed appt, no active link + no current job -> create
  | "link_version_behind" // Class 3: link.last_hone_version < appt.sync_version, no current job -> update
  | "orphaned_link_delete" // Class 2: active link whose appointment is cancelled/gone -> delete
  | "surplus_event_delete"; // Class 4: active link + real event where desired state is none -> delete

// The action decided for a single candidate (pure — no I/O).
export type ReconcileDecision =
  | { act: "bump"; class: ReconcileClass; appointmentId: string }
  | { act: "orphan_delete"; class: ReconcileClass; linkId: string }
  | { act: "skip"; reason: ReconcileSkipReason };

export type ReconcileSkipReason =
  | "converged" // link is current; nothing to do
  | "work_in_flight" // a pending/processing job already exists for this entity (supersede-safe)
  | "keep_event" // completed/no_show/rescheduled -> the event should remain / is handled elsewhere
  | "handled_by_appointment_pass" // confirmed link handled by the create/update pass
  | "inert_placeholder"; // orphaned local placeholder link with no real Google event -> nothing to reconcile

// ---------------------------------------------------------------------------
// Store seam (data access). Every method is studio-scoped where it mutates or
// reads tenant rows; the route derives the eligible studio set SERVER-SIDE and
// never trusts a browser-supplied id.
// ---------------------------------------------------------------------------
export type ReconcileStore = {
  // INTENT-eligible studios only (outbound flag ON + owner conn + write calendar).
  listEligibleStudioIds(): Promise<string[]>;

  // Appointment pass source: confirmed appointments that have NOT ended
  // (ends_at >= activation) created no later than the pinned snapshot, paginated
  // by the IMMUTABLE appointment id (never the mutable starts_at).
  pageConfirmedFutureAppointments(
    studioId: string,
    activationStartedAtIso: string,
    snapshotStartedAtIso: string,
    afterId: string | null,
    limit: number,
  ): Promise<ReconcileApptRow[]>;

  // Link pass source: active appointment links, paginated by the immutable link id.
  pageActiveAppointmentLinks(
    studioId: string,
    afterId: string | null,
    limit: number,
  ): Promise<ReconcileLinkRow[]>;

  // Batched lookups for a page (studio-scoped).
  getActiveLinksForEntities(studioId: string, appointmentIds: string[]): Promise<Map<string, ReconcileLinkRow>>;
  getAppointmentStates(studioId: string, appointmentIds: string[]): Promise<Map<string, ReconcileApptState>>;
  // Entities with a pending OR processing outbox row (the supersede / in-flight guard).
  getEntitiesWithOpenJobs(studioId: string, appointmentIds: string[]): Promise<Set<string>>;

  // Actuators — the EXISTING repair RPCs. The sweep adds no new enqueue logic.
  bumpAppointmentSyncVersion(appointmentId: string): Promise<number | null>;
  enqueueOrphanLinkDelete(linkId: string): Promise<string>; // 'no_active_link'|'delete_in_flight'|'suppressed'|<uuid>
};

// ---------------------------------------------------------------------------
// Lock seam — a REAL cross-process, per-studio ownership-token lock (Upstash
// SET NX + token-compare release in production). Lock acquisition/integrity
// failure is FAIL-CLOSED: the studio is skipped, never swept unlocked.
// ---------------------------------------------------------------------------
export type LockAcquire =
  | { ok: true; token: string }
  | { ok: false; reason: "held" | "unavailable" }; // held = another sweep owns it; unavailable = backend down/misconfigured

export type ReconcileLock = {
  acquire(studioId: string): Promise<LockAcquire>;
  release(studioId: string, token: string): Promise<void>;
  // Extend the lease mid-run (called between pages). Returns false when the lock
  // is no longer owned or cannot be extended -> the caller stops paging that
  // studio (fail-closed) rather than run past an expired lease. Optional: a lock
  // whose TTL safely exceeds a full studio run may omit it.
  renew?(studioId: string, token: string): Promise<boolean>;
};

// Best-effort observability sink (fail-open — a failed write NEVER aborts the
// sweep or a booking). Kept separate from the lock, which is fail-closed.
export type ReconcileObservability = {
  recordStudioResult?(result: StudioReconcileResult): Promise<void> | void;
};

export type ReconcileDeps = {
  store: ReconcileStore;
  lock: ReconcileLock;
  observability?: ReconcileObservability;
  now?: () => number;
  pageSize?: number; // clamped [1, 500]; default 200
  maxPagesPerStudioPerPass?: number; // deadline backstop; default 50
};

// ---------------------------------------------------------------------------
// Result shapes — aggregate, non-sensitive counts ONLY. No client identity,
// appointment content, Google id, token or calendar id ever appears here.
// ---------------------------------------------------------------------------
export type StudioReconcileResult = {
  studioId: string;
  locked: boolean; // true when the sweep held the per-studio lock and ran
  lockSkipReason?: "held" | "unavailable";
  candidates: number; // appointments + links examined
  enqueued: number; // repair actuations that produced work (create/update/delete intent)
  skipped: number; // converged / kept / inert
  superseded: number; // skipped because a pending/processing job already exists
  byClass: Record<ReconcileClass, number>; // enqueued counts per class
  errors: number; // per-candidate actuator errors (swallowed; studio continues)
  appointmentCursor: string | null; // last immutable appointment id examined
  linkCursor: string | null; // last immutable link id examined
  truncated: boolean; // a pass hit the page bound before draining
};

export type ReconcileRunResult = {
  runStartedAtIso: string; // pinned; serves as BOTH snapshot_started_at and activation_started_at
  eligibleStudios: number;
  studiosSwept: number; // held the lock and ran
  studiosSkippedHeld: number;
  studiosSkippedUnavailable: number;
  candidates: number;
  enqueued: number;
  skipped: number;
  superseded: number;
  errors: number;
  byClass: Record<ReconcileClass, number>;
  results: StudioReconcileResult[];
};

function emptyByClass(): Record<ReconcileClass, number> {
  return { missing_link_job: 0, link_version_behind: 0, orphaned_link_delete: 0, surplus_event_delete: 0 };
}

// ---------------------------------------------------------------------------
// Pure classifiers (no I/O — the testable core of the decision logic).
// ---------------------------------------------------------------------------

// Appointment pass: a confirmed, not-yet-ended appointment. `link` is its active
// link (or undefined) and `hasOpenJob` is whether a pending/processing outbox row
// already exists for the entity. Completed/no_show/cancelled never reach here (the
// query only yields confirmed rows); the delete decision lives in the link pass.
export function classifyConfirmedAppointment(
  appt: ReconcileApptRow,
  link: ReconcileLinkRow | undefined,
  hasOpenJob: boolean,
): ReconcileDecision {
  // A pending/processing job means current effective work already exists — never
  // bump on top of it (that is the supersede / no-duplicate guard).
  if (hasOpenJob) return { act: "skip", reason: "work_in_flight" };
  if (!link) {
    // Class 1: no active link and no job — the create was never generated (intent
    // was unavailable at booking time, or the enqueue was swallowed).
    return { act: "bump", class: "missing_link_job", appointmentId: appt.id };
  }
  if (link.lastHoneVersion < appt.syncVersion) {
    // Class 3: the link's synced version trails the appointment and there is no
    // current job to advance it -> re-drive an update via a genuine bump.
    return { act: "bump", class: "link_version_behind", appointmentId: appt.id };
  }
  return { act: "skip", reason: "converged" };
}

// Link pass: an active appointment link. `appt` is the CURRENT state of its
// appointment (undefined => the appointment row was hard-deleted). Drives the
// two delete classes; confirmed links are left to the appointment pass.
export function classifyActiveLink(
  link: ReconcileLinkRow,
  appt: ReconcileApptState | undefined,
  hasOpenJob: boolean,
): ReconcileDecision {
  if (!appt) {
    // Class 2/4: the appointment is gone. A real Google event must be tombstoned;
    // a local placeholder (no google_event_id) has no remote event -> inert.
    if (link.googleEventId === null) return { act: "skip", reason: "inert_placeholder" };
    return { act: "orphan_delete", class: "orphaned_link_delete", linkId: link.id };
  }
  if (appt.status === "cancelled") {
    // A rescheduled predecessor intentionally suppresses its own delete (the
    // successor rebinds the link) — never reconcile it to a delete.
    if (appt.cancellationKind === "rescheduled") return { act: "skip", reason: "keep_event" };
    if (hasOpenJob) return { act: "skip", reason: "work_in_flight" };
    // Class 4/2a: a withdrawn cancellation whose delete was never generated. The
    // appointment row still exists, so a genuine bump re-drives the (appointment-
    // keyed) event.delete through the trigger — matching the ordinary cancel path.
    return { act: "bump", class: "surplus_event_delete", appointmentId: appt.id };
  }
  // confirmed -> handled by the appointment pass; completed/no_show -> the event
  // remains as a truthful historical block.
  return {
    act: "skip",
    reason: appt.status === "confirmed" ? "handled_by_appointment_pass" : "keep_event",
  };
}

// ---------------------------------------------------------------------------
// Orchestration.
// ---------------------------------------------------------------------------

function clampPageSize(n: number | undefined): number {
  return Math.min(500, Math.max(1, Math.floor(n ?? 200)));
}

// Reconcile ONE studio under its per-studio lock. Fail-closed on the lock: if the
// lock is held by another sweep, or the lock backend is unavailable, the studio is
// SKIPPED (never swept unlocked). Per-candidate actuator errors are swallowed so
// one bad row never aborts the studio; they are counted for observability.
export async function reconcileStudio(
  studioId: string,
  deps: ReconcileDeps,
  runStartedAtIso: string,
): Promise<StudioReconcileResult> {
  const pageSize = clampPageSize(deps.pageSize);
  const maxPages = Math.max(1, Math.floor(deps.maxPagesPerStudioPerPass ?? 50));
  const res: StudioReconcileResult = {
    studioId,
    locked: false,
    candidates: 0,
    enqueued: 0,
    skipped: 0,
    superseded: 0,
    byClass: emptyByClass(),
    errors: 0,
    appointmentCursor: null,
    linkCursor: null,
    truncated: false,
  };

  const lock = await deps.lock.acquire(studioId);
  if (!lock.ok) {
    res.lockSkipReason = lock.reason; // 'held' or 'unavailable' (fail-closed)
    await recordStudio(deps, res);
    return res;
  }
  res.locked = true;

  // Between-page lease extension. Fail-closed: a renewal that cannot confirm
  // continued ownership stops further paging for this studio.
  const renew = async (): Promise<boolean> => {
    if (!deps.lock.renew) return true; // TTL alone covers the run
    try {
      return await deps.lock.renew(studioId, lock.token);
    } catch {
      return false; // treat a renewal error as lost ownership (fail-closed)
    }
  };

  try {
    await runAppointmentPass(studioId, deps, runStartedAtIso, pageSize, maxPages, renew, res);
    await runLinkPass(studioId, deps, pageSize, maxPages, renew, res);
  } finally {
    // Release with the ownership token (compare-token-delete). Best-effort: a
    // failed release simply lets the TTL expire the lock.
    await deps.lock.release(studioId, lock.token);
  }

  await recordStudio(deps, res);
  return res;
}

async function runAppointmentPass(
  studioId: string,
  deps: ReconcileDeps,
  runStartedAtIso: string,
  pageSize: number,
  maxPages: number,
  renew: () => Promise<boolean>,
  res: StudioReconcileResult,
): Promise<void> {
  let after: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    const rows = await deps.store.pageConfirmedFutureAppointments(
      studioId,
      runStartedAtIso, // activation_started_at (ends_at >= this)
      runStartedAtIso, // snapshot_started_at (created_at <= this)
      after,
      pageSize,
    );
    if (rows.length === 0) return;
    const ids = rows.map((r) => r.id);
    const links = await deps.store.getActiveLinksForEntities(studioId, ids);
    const openJobs = await deps.store.getEntitiesWithOpenJobs(studioId, ids);

    for (const appt of rows) {
      res.candidates++;
      res.appointmentCursor = appt.id;
      const decision = classifyConfirmedAppointment(appt, links.get(appt.id), openJobs.has(appt.id));
      await applyDecision(studioId, deps, decision, res);
    }
    after = rows[rows.length - 1].id;
    if (rows.length < pageSize) return;
    if (page === maxPages - 1) {
      res.truncated = true;
      return;
    }
    if (!(await renew())) {
      res.truncated = true; // lost the lease -> stop paging (fail-closed)
      return;
    }
  }
}

async function runLinkPass(
  studioId: string,
  deps: ReconcileDeps,
  pageSize: number,
  maxPages: number,
  renew: () => Promise<boolean>,
  res: StudioReconcileResult,
): Promise<void> {
  let after: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    const links = await deps.store.pageActiveAppointmentLinks(studioId, after, pageSize);
    if (links.length === 0) return;
    const entityIds = links.map((l) => l.honeEntityId);
    const appts = await deps.store.getAppointmentStates(studioId, entityIds);
    const openJobs = await deps.store.getEntitiesWithOpenJobs(studioId, entityIds);

    for (const link of links) {
      res.candidates++;
      res.linkCursor = link.id;
      const appt = appts.get(link.honeEntityId);
      const decision = classifyActiveLink(link, appt, appt ? openJobs.has(appt.id) : false);
      await applyDecision(studioId, deps, decision, res);
    }
    after = links[links.length - 1].id;
    if (links.length < pageSize) return;
    if (page === maxPages - 1) {
      res.truncated = true;
      return;
    }
    if (!(await renew())) {
      res.truncated = true; // lost the lease -> stop paging (fail-closed)
      return;
    }
  }
}

// Execute a decision. Before every BUMP we REVALIDATE the candidate against the
// current row (§7): a concurrent booking mutation may have created a job or
// changed the status since the page was read. `repair_bump_appointment_sync_version`
// increments UNCONDITIONALLY, so a bump is only ever issued after a fresh
// drift + no-open-job re-check — this is what prevents gratuitous version inflation
// from duplicate/interleaved sweeps.
async function applyDecision(
  studioId: string,
  deps: ReconcileDeps,
  decision: ReconcileDecision,
  res: StudioReconcileResult,
): Promise<void> {
  if (decision.act === "skip") {
    res.skipped++;
    if (decision.reason === "work_in_flight") res.superseded++;
    return;
  }

  try {
    if (decision.act === "bump") {
      const stillDrifted = await revalidateBump(studioId, deps, decision);
      if (!stillDrifted) {
        res.skipped++;
        res.superseded++;
        return;
      }
      const newVersion = await deps.store.bumpAppointmentSyncVersion(decision.appointmentId);
      if (newVersion === null) {
        // The appointment vanished between revalidation and bump — nothing enqueued.
        res.skipped++;
        return;
      }
      res.enqueued++;
      res.byClass[decision.class]++;
      return;
    }

    // orphan_delete: the RPC is itself idempotent (guards delete_in_flight +
    // full-unique suppressed). Only a genuinely new outbox row counts as enqueued.
    const outcome = await deps.store.enqueueOrphanLinkDelete(decision.linkId);
    if (outcome === "delete_in_flight" || outcome === "suppressed") {
      res.skipped++;
      if (outcome === "delete_in_flight") res.superseded++;
      return;
    }
    if (outcome === "no_active_link") {
      res.skipped++;
      return;
    }
    res.enqueued++;
    res.byClass[decision.class]++;
  } catch {
    // A single actuator failure never aborts the studio sweep.
    res.errors++;
  }
}

// Fresh re-check immediately before a bump: is the appointment STILL a drift
// candidate (confirmed→still needs create/update, or cancelled→still needs
// delete) with NO open job? Returns false to cancel the bump.
async function revalidateBump(
  studioId: string,
  deps: ReconcileDeps,
  decision: { class: ReconcileClass; appointmentId: string },
): Promise<boolean> {
  const [states, openJobs] = await Promise.all([
    deps.store.getAppointmentStates(studioId, [decision.appointmentId]),
    deps.store.getEntitiesWithOpenJobs(studioId, [decision.appointmentId]),
  ]);
  const appt = states.get(decision.appointmentId);
  if (!appt) return false; // vanished
  if (openJobs.has(decision.appointmentId)) return false; // a job appeared -> supersede-safe skip

  if (decision.class === "surplus_event_delete") {
    // Delete drift: must still be a non-rescheduled cancellation.
    return appt.status === "cancelled" && appt.cancellationKind !== "rescheduled";
  }
  // Create/update drift (missing_link_job / link_version_behind): must still be
  // confirmed. (Re-fetching the link to re-confirm "behind" is unnecessary: if a
  // concurrent update advanced the link, it also created a job, which the open-job
  // check above already caught.)
  return appt.status === "confirmed";
}

async function recordStudio(deps: ReconcileDeps, res: StudioReconcileResult): Promise<void> {
  try {
    await deps.observability?.recordStudioResult?.(res);
  } catch {
    // Observability is fail-open; it must never abort the sweep.
  }
}

// Run the full sweep across every INTENT-eligible studio. Pins ONE run clock used
// as both the enumeration snapshot boundary (created_at <=) and the activation
// boundary (ends_at >=). Each studio is independently locked; a studio the sweep
// cannot lock is skipped (fail-closed) and reported, never swept unlocked.
export async function runReconciliation(deps: ReconcileDeps): Promise<ReconcileRunResult> {
  const now = deps.now ?? Date.now;
  const runStartedAtIso = new Date(now()).toISOString();

  const result: ReconcileRunResult = {
    runStartedAtIso,
    eligibleStudios: 0,
    studiosSwept: 0,
    studiosSkippedHeld: 0,
    studiosSkippedUnavailable: 0,
    candidates: 0,
    enqueued: 0,
    skipped: 0,
    superseded: 0,
    errors: 0,
    byClass: emptyByClass(),
    results: [],
  };

  const studioIds = await deps.store.listEligibleStudioIds();
  result.eligibleStudios = studioIds.length;

  for (const studioId of studioIds) {
    const r = await reconcileStudio(studioId, deps, runStartedAtIso);
    result.results.push(r);
    if (r.locked) result.studiosSwept++;
    else if (r.lockSkipReason === "held") result.studiosSkippedHeld++;
    else if (r.lockSkipReason === "unavailable") result.studiosSkippedUnavailable++;
    result.candidates += r.candidates;
    result.enqueued += r.enqueued;
    result.skipped += r.skipped;
    result.superseded += r.superseded;
    result.errors += r.errors;
    for (const k of Object.keys(result.byClass) as ReconcileClass[]) result.byClass[k] += r.byClass[k];
  }

  return result;
}
