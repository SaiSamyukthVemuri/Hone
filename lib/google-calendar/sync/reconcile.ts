import "server-only";

// Google Calendar: Phase B2.3-b: the transport-neutral reconciliation SWEEP core.
//
// The single orchestration seam the reconcile cron route calls. Depends on NO
// Next.js/Vercel/Supabase/host type, only on injected seams (a `ReconcileStore`
// for data, a per-studio `ReconcileLock` for mutation safety, a `ReconcileCoordinator`
// for global studio ordering, a `ReconcileContinuationStore` for resumable position)
// and a `now()` clock. The SAME logic runs against the real service-role Supabase
// client (production route) AND against a raw-pg store in the DB integration tests.
//
// WHAT THE SWEEP IS: a bounded DRIFT DETECTOR + ORCHESTRATOR over the EXISTING DB
// repair primitives. It builds NO enqueue path, NO idempotency key, NO outbox/link
// bookkeeping of its own, and NEVER calls Google. It recovers the gaps the enqueue
// trigger could not cover (mutations made while product INTENT was unavailable, or a
// swallowed never-raise enqueue) + first activation, within intent-eligible studios.
//
// CORRECTNESS POSTURE (two independent guarantees):
//   * MUTATION SAFETY is FAIL-CLOSED, the per-studio lock, the coordinator lock, and
//     the durable continuation/cursor are correctness state. Ownership is confirmed
//     immediately before every actuator; if it cannot be confirmed the sweep stops
//     mutating, preserves its cursor before the unprocessed item, and reports degraded
//     never swept unlocked, never past a lost lease, never from an unknown position,
//     never reported complete when work was left unrepresented.
//   * OBSERVABILITY (heartbeat / metrics / dead-row alert) is FAIL-OPEN, a failed
//     write never aborts the sweep or a booking.
//
// STALE-JOB MODEL: a pending/processing outbox row is "current work" ONLY when its op
// class AND payload sync_version correspond to the CURRENT desired state. An OLDER job
// does NOT block generating current intent; the EXECUTION-TIME stale fence (a B2.4
// worker op returning `ok_noop_superseded`) is deferred to the worker phase.

// ---------------------------------------------------------------------------
// Data shapes (operational-only, never client content / PHI).
// ---------------------------------------------------------------------------
export type ReconcileApptRow = { id: string; syncVersion: number };
export type ReconcileApptState = { id: string; status: string; syncVersion: number; cancellationKind: string | null };
export type ReconcileLinkRow = { id: string; honeEntityId: string; googleEventId: string | null; lastHoneVersion: number };

export type OpenJobStatus = "pending" | "processing" | "dead";
export type OpenJob = { opType: string; syncVersion: number | null; status: OpenJobStatus };

export type ReconcileClass = "missing_link_job" | "link_version_behind" | "orphaned_link_delete" | "surplus_event_delete";

export type ReconcileSkipReason =
  | "converged"
  | "work_in_flight"
  | "keep_event"
  | "handled_by_appointment_pass"
  | "inert_placeholder"
  | "dead_create_manual_review"
  | "decision_stale"
  | "vanished";

export type ReconcileDecision =
  | { act: "bump"; class: ReconcileClass; appointmentId: string }
  | { act: "orphan_delete"; class: ReconcileClass; linkId: string }
  | { act: "skip"; reason: ReconcileSkipReason };

// ---------------------------------------------------------------------------
// Seams.
// ---------------------------------------------------------------------------
export type ReconcileStore = {
  listEligibleStudioIds(): Promise<string[]>;
  // Per-studio INTENT re-check (flag ON + owner conn + write target) used immediately
  // before a mutation, so the sweep never bumps while intent has gone unavailable.
  isStudioIntentEligible(studioId: string): Promise<boolean>;
  pageConfirmedFutureAppointments(
    studioId: string,
    activationStartedAtIso: string,
    snapshotStartedAtIso: string,
    afterId: string | null,
    limit: number,
  ): Promise<ReconcileApptRow[]>;
  pageActiveAppointmentLinks(studioId: string, afterId: string | null, limit: number): Promise<ReconcileLinkRow[]>;
  getActiveLinksForEntities(studioId: string, appointmentIds: string[]): Promise<Map<string, ReconcileLinkRow>>;
  getActiveLinkById(studioId: string, linkId: string): Promise<ReconcileLinkRow | null>;
  getAppointmentStates(studioId: string, appointmentIds: string[]): Promise<Map<string, ReconcileApptState>>;
  getOpenJobsForEntities(studioId: string, appointmentIds: string[]): Promise<Map<string, OpenJob[]>>;
  bumpAppointmentSyncVersion(appointmentId: string): Promise<number | null>;
  enqueueOrphanLinkDelete(linkId: string): Promise<string>;
  // Bounded, cursor-paginated dead-row inventory (from the queue-health view).
  pageStudiosWithDeadOutbox(afterStudioId: string | null, limit: number): Promise<{ studioId: string; deadCount: number }[]>;
};

export type LockAcquire = { ok: true; token: string } | { ok: false; reason: "held" | "unavailable" };
export type ReconcileLock = {
  acquire(studioId: string): Promise<LockAcquire>;
  release(studioId: string, token: string): Promise<void>;
  renew?(studioId: string, token: string): Promise<boolean>;
};

// Global route coordinator: serializes invocations + owns the durable studio cursor
// (the last-attempted immutable studio id). Cursor writes are ownership-token-atomic.
export type ReconcileCoordinator = {
  acquire(): Promise<{ ok: true; token: string } | { ok: false; reason: "held" | "unavailable" }>;
  release(token: string): Promise<void>;
  renew(token: string): Promise<boolean>;
  readCursor(): Promise<{ ok: true; cursor: string | null } | { ok: false }>;
  writeCursor(token: string, cursor: string | null): Promise<boolean>;
};

export type ReconcilePass = "appointments" | "links";
export type ReconcileContinuation = {
  snapshotStartedAtIso: string;
  activationStartedAtIso: string;
  pass: ReconcilePass;
  cursor: string | null;
};
// write/clear are OWNERSHIP-ATOMIC: they mutate only while the passed lock token
// still owns the per-studio lock, and return whether the mutation happened while owned.
export type ReconcileContinuationStore = {
  read(studioId: string): Promise<{ ok: true; value: ReconcileContinuation | null } | { ok: false }>;
  write(studioId: string, ownerToken: string, value: ReconcileContinuation): Promise<boolean>;
  clear(studioId: string, ownerToken: string): Promise<boolean>;
};

export type ReconcileObservability = { recordStudioResult?(result: StudioReconcileResult): Promise<void> | void };

export type ReconcileDeps = {
  store: ReconcileStore;
  lock: ReconcileLock;
  coordinator: ReconcileCoordinator;
  continuation: ReconcileContinuationStore;
  observability?: ReconcileObservability;
  now?: () => number;
  pageSize?: number; // clamped [1, 500]; default 200
  maxPagesPerStudioPerPass?: number; // per-invocation page budget; default 50
  studioBatchLimit?: number; // max studios attempted per invocation; default = all eligible
  deadlineMs?: number; // absolute epoch ms; stop starting work at/after it
  lockRenewIntervalMs?: number; // renew when this much elapsed since the last renew; default 40s
};

// ---------------------------------------------------------------------------
// Result shapes: aggregate, non-sensitive counts ONLY.
// ---------------------------------------------------------------------------
export type StudioOutcome = "ok" | "degraded" | "error" | "skipped_held";

export type StudioReconcileResult = {
  studioId: string;
  locked: boolean;
  lockSkipReason?: "held" | "unavailable";
  continuationRead: boolean;
  continuationPersisted: boolean; // a REQUIRED write happened while owned
  continuationCleared: boolean; // a REQUIRED clear happened while owned (completion)
  candidates: number;
  enqueued: number;
  skipped: number;
  superseded: number;
  intentVerifyFailed: number; // bump returned but no durable current op was proven
  byClass: Record<ReconcileClass, number>;
  errors: number;
  errored: boolean;
  truncated: boolean;
  deadlineHit: boolean;
  ownershipLost: boolean;
  intentLost: boolean; // intent-eligibility dropped mid-sweep
  appointmentCursor: string | null;
  linkCursor: string | null;
  outcome: StudioOutcome;
};

export type RunOutcome = "ok" | "degraded" | "error";

export type ReconcileRunResult = {
  runStartedAtIso: string;
  outcome: RunOutcome;
  coordinatorSkipped: "held" | "unavailable" | null;
  coordinatorLost: boolean;
  cursorReadFailed: boolean;
  cursorPersistFailed: boolean;
  eligibleStudios: number;
  studiosAttempted: number;
  studiosCompleted: number;
  studiosTruncated: number;
  studiosDeferred: number; // eligible but not attempted this invocation (deadline/batch/coordinator)
  studiosSkippedHeld: number;
  studiosSkippedUnavailable: number;
  studiosContinuationFailed: number;
  candidates: number;
  enqueued: number;
  skipped: number;
  superseded: number;
  intentVerifyFailed: number;
  errors: number;
  byClass: Record<ReconcileClass, number>;
  results: StudioReconcileResult[];
};

function emptyByClass(): Record<ReconcileClass, number> {
  return { missing_link_job: 0, link_version_behind: 0, orphaned_link_delete: 0, surplus_event_delete: 0 };
}

// ---------------------------------------------------------------------------
// Pure classifiers.
// ---------------------------------------------------------------------------
const CREATE_UPDATE_OPS = ["event.create", "event.update"];
const DELETE_OPS = ["event.delete"];

function hasCurrentOrNewerJob(jobs: OpenJob[], ops: string[], atLeastVersion: number): boolean {
  return jobs.some(
    (j) => (j.status === "pending" || j.status === "processing") && ops.includes(j.opType) && j.syncVersion !== null && j.syncVersion >= atLeastVersion,
  );
}
function hasDeadJob(jobs: OpenJob[], ops: string[]): boolean {
  return jobs.some((j) => j.status === "dead" && ops.includes(j.opType));
}

// Appointment pass. NOTE (§5): a bump for a PLACEHOLDER link re-drives a CURRENT
// UPSERT intent; the deployed trigger emits `event.update` (an active link exists),
// NOT `event.create`. No real provider update can happen (no google_event_id), the
// future B2.3-c worker op must treat `event.update` + a placeholder link as
// create-and-bind. `missing_link_job` is the internal drift class, not the wire op.
export function classifyConfirmedAppointment(appt: ReconcileApptRow, link: ReconcileLinkRow | undefined, jobs: OpenJob[]): ReconcileDecision {
  if (hasCurrentOrNewerJob(jobs, CREATE_UPDATE_OPS, appt.syncVersion)) return { act: "skip", reason: "work_in_flight" };
  if (!link) return { act: "bump", class: "missing_link_job", appointmentId: appt.id };
  if (link.googleEventId === null) {
    if (hasDeadJob(jobs, CREATE_UPDATE_OPS)) return { act: "skip", reason: "dead_create_manual_review" };
    return { act: "bump", class: "missing_link_job", appointmentId: appt.id }; // re-drive upsert intent
  }
  if (link.lastHoneVersion < appt.syncVersion) return { act: "bump", class: "link_version_behind", appointmentId: appt.id };
  return { act: "skip", reason: "converged" };
}

export function classifyActiveLink(link: ReconcileLinkRow, appt: ReconcileApptState | undefined, jobs: OpenJob[]): ReconcileDecision {
  if (!appt) {
    if (link.googleEventId === null) return { act: "skip", reason: "inert_placeholder" };
    return { act: "orphan_delete", class: "orphaned_link_delete", linkId: link.id };
  }
  if (appt.status === "cancelled") {
    if (appt.cancellationKind === "rescheduled") return { act: "skip", reason: "keep_event" };
    if (link.googleEventId === null) return { act: "skip", reason: "inert_placeholder" };
    if (hasCurrentOrNewerJob(jobs, DELETE_OPS, appt.syncVersion)) return { act: "skip", reason: "work_in_flight" };
    return { act: "bump", class: "surplus_event_delete", appointmentId: appt.id };
  }
  return { act: "skip", reason: appt.status === "confirmed" ? "handled_by_appointment_pass" : "keep_event" };
}

// ---------------------------------------------------------------------------
// Lock guard: time-based ownership maintenance.
// ---------------------------------------------------------------------------
const DEFAULT_RENEW_INTERVAL_MS = 40_000;
function renewIntervalMs(deps: ReconcileDeps): number {
  return Math.max(1_000, Math.floor(deps.lockRenewIntervalMs ?? DEFAULT_RENEW_INTERVAL_MS));
}

class LockGuard {
  private lastRenewMs: number;
  lost = false;
  constructor(
    private readonly lock: ReconcileLock,
    private readonly studioId: string,
    private readonly token: string,
    private readonly now: () => number,
    private readonly intervalMs: number,
  ) {
    this.lastRenewMs = now();
  }
  async ensureOwned(): Promise<boolean> {
    if (this.lost) return false;
    const t = this.now();
    if (t - this.lastRenewMs < this.intervalMs) return true;
    return this.renew(t);
  }
  // Force an ownership-token renewal/check regardless of the timer: used immediately
  // before every actuator and at each pass boundary.
  async ensureOwnedNow(): Promise<boolean> {
    if (this.lost) return false;
    return this.renew(this.now());
  }
  private async renew(t: number): Promise<boolean> {
    if (!this.lock.renew) {
      this.lastRenewMs = t;
      return true;
    }
    let ok = false;
    try {
      ok = await this.lock.renew(this.studioId, this.token);
    } catch {
      ok = false;
    }
    if (!ok) {
      this.lost = true;
      return false;
    }
    this.lastRenewMs = t;
    return true;
  }
}

// ---------------------------------------------------------------------------
// Orchestration.
// ---------------------------------------------------------------------------
function clampPageSize(n: number | undefined): number {
  return Math.min(500, Math.max(1, Math.floor(n ?? 200)));
}

function initResult(studioId: string): StudioReconcileResult {
  return {
    studioId,
    locked: false,
    continuationRead: true,
    continuationPersisted: true,
    continuationCleared: true,
    candidates: 0,
    enqueued: 0,
    skipped: 0,
    superseded: 0,
    intentVerifyFailed: 0,
    byClass: emptyByClass(),
    errors: 0,
    errored: false,
    truncated: false,
    deadlineHit: false,
    ownershipLost: false,
    intentLost: false,
    appointmentCursor: null,
    linkCursor: null,
    outcome: "ok",
  };
}

function computeStudioOutcome(res: StudioReconcileResult): StudioOutcome {
  if (res.errored) return "error";
  if (res.lockSkipReason === "held") return "skipped_held";
  if (res.lockSkipReason === "unavailable") return "degraded";
  if (!res.continuationRead) return "degraded";
  if (
    res.errors > 0 ||
    res.truncated ||
    res.ownershipLost ||
    res.intentLost ||
    res.intentVerifyFailed > 0 ||
    !res.continuationPersisted ||
    !res.continuationCleared
  ) {
    return "degraded";
  }
  return "ok";
}

function isValidContinuation(v: unknown): v is ReconcileContinuation {
  if (!v || typeof v !== "object") return false;
  const c = v as Record<string, unknown>;
  return (
    typeof c.snapshotStartedAtIso === "string" &&
    typeof c.activationStartedAtIso === "string" &&
    (c.pass === "appointments" || c.pass === "links") &&
    (c.cursor === null || typeof c.cursor === "string")
  );
}

type ActuationResult = "acted" | "skipped" | "ownership_lost" | "intent_lost";
type PassStopReason = "deadline" | "ownership" | "intent" | "page_budget";
type PassResult = { drained: boolean; cursor: string | null; stopped: PassStopReason | null };

// Reconcile ONE studio under its per-studio lock. FAIL-CLOSED on the lock + continuation.
export async function reconcileStudio(studioId: string, deps: ReconcileDeps, runStartedAtIso: string): Promise<StudioReconcileResult> {
  const res = initResult(studioId);
  const now = deps.now ?? Date.now;
  const deadlineMs = deps.deadlineMs ?? Number.POSITIVE_INFINITY;

  const lock = await deps.lock.acquire(studioId);
  if (!lock.ok) {
    res.lockSkipReason = lock.reason;
    res.outcome = computeStudioOutcome(res);
    await recordStudio(deps, res);
    return res;
  }
  res.locked = true;

  try {
    const cont = await deps.continuation.read(studioId);
    if (!cont.ok) {
      res.continuationRead = false; // position unknown -> fail-closed, do not sweep
    } else {
      const ctx: ReconcileContinuation =
        cont.value && isValidContinuation(cont.value)
          ? cont.value
          : { snapshotStartedAtIso: runStartedAtIso, activationStartedAtIso: runStartedAtIso, pass: "appointments", cursor: null };
      const guard = new LockGuard(deps.lock, studioId, lock.token, now, renewIntervalMs(deps));
      const passes = await processStudioPasses(studioId, deps, ctx, guard, deadlineMs, now, res);
      // Continuation mutations happen HERE, before the lock release (finally).
      if (passes.done) {
        res.continuationCleared = await deps.continuation.clear(studioId, lock.token);
      } else {
        res.continuationPersisted = await deps.continuation.write(studioId, lock.token, passes.continuation);
      }
    }
  } catch {
    res.errored = true;
  } finally {
    await deps.lock.release(studioId, lock.token);
  }

  res.outcome = computeStudioOutcome(res);
  await recordStudio(deps, res);
  return res;
}

async function processStudioPasses(
  studioId: string,
  deps: ReconcileDeps,
  ctx: ReconcileContinuation,
  guard: LockGuard,
  deadlineMs: number,
  now: () => number,
  res: StudioReconcileResult,
): Promise<{ done: true } | { done: false; continuation: ReconcileContinuation }> {
  let pass: ReconcilePass = ctx.pass;
  let cursor = ctx.cursor;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const pr = await runPass(studioId, deps, pass, ctx, cursor, guard, deadlineMs, now, res);
    if (pr.stopped) {
      res.truncated = true;
      if (pr.stopped === "deadline") res.deadlineHit = true;
      if (pr.stopped === "ownership") res.ownershipLost = true;
      // "intent" already set res.intentLost inside applyDecision.
      return {
        done: false,
        continuation: { snapshotStartedAtIso: ctx.snapshotStartedAtIso, activationStartedAtIso: ctx.activationStartedAtIso, pass, cursor: pr.cursor },
      };
    }
    if (pass === "appointments") {
      if (!(await guard.ensureOwnedNow())) {
        res.truncated = true;
        res.ownershipLost = true;
        return {
          done: false,
          continuation: { snapshotStartedAtIso: ctx.snapshotStartedAtIso, activationStartedAtIso: ctx.activationStartedAtIso, pass: "links", cursor: null },
        };
      }
      pass = "links";
      cursor = null;
      continue;
    }
    return { done: true };
  }
}

async function runPass(
  studioId: string,
  deps: ReconcileDeps,
  pass: ReconcilePass,
  ctx: ReconcileContinuation,
  startCursor: string | null,
  guard: LockGuard,
  deadlineMs: number,
  now: () => number,
  res: StudioReconcileResult,
): Promise<PassResult> {
  const pageSize = clampPageSize(deps.pageSize);
  const maxPages = Math.max(1, Math.floor(deps.maxPagesPerStudioPerPass ?? 50));
  let after = startCursor;

  for (let page = 0; page < maxPages; page++) {
    if (now() >= deadlineMs) return { drained: false, cursor: after, stopped: "deadline" };
    if (!(await guard.ensureOwned())) return { drained: false, cursor: after, stopped: "ownership" };

    const items: Array<ReconcileApptRow | ReconcileLinkRow> =
      pass === "appointments"
        ? await deps.store.pageConfirmedFutureAppointments(studioId, ctx.activationStartedAtIso, ctx.snapshotStartedAtIso, after, pageSize)
        : await deps.store.pageActiveAppointmentLinks(studioId, after, pageSize);
    if (items.length === 0) return { drained: true, cursor: after, stopped: null };

    const entityIds = pass === "appointments" ? (items as ReconcileApptRow[]).map((a) => a.id) : (items as ReconcileLinkRow[]).map((l) => l.honeEntityId);
    const [links, appts, jobs] =
      pass === "appointments"
        ? await Promise.all([
            deps.store.getActiveLinksForEntities(studioId, entityIds),
            Promise.resolve(new Map<string, ReconcileApptState>()),
            deps.store.getOpenJobsForEntities(studioId, entityIds),
          ])
        : await Promise.all([
            Promise.resolve(new Map<string, ReconcileLinkRow>()),
            deps.store.getAppointmentStates(studioId, entityIds),
            deps.store.getOpenJobsForEntities(studioId, entityIds),
          ]);

    for (const item of items) {
      if (now() >= deadlineMs) return { drained: false, cursor: after, stopped: "deadline" };
      if (!(await guard.ensureOwned())) return { drained: false, cursor: after, stopped: "ownership" };

      res.candidates++;
      let decision: ReconcileDecision;
      if (pass === "appointments") {
        const appt = item as ReconcileApptRow;
        res.appointmentCursor = appt.id;
        decision = classifyConfirmedAppointment(appt, links.get(appt.id), jobs.get(appt.id) ?? []);
      } else {
        const link = item as ReconcileLinkRow;
        res.linkCursor = link.id;
        decision = classifyActiveLink(link, appts.get(link.honeEntityId), jobs.get(link.honeEntityId) ?? []);
      }
      const ar = await applyDecision(studioId, deps, decision, guard, res);
      // Advance the cursor ONLY when the item was fully processed (acted or a safe
      // no-op). On ownership/intent loss the cursor stays BEFORE the unprocessed item.
      if (ar === "ownership_lost") return { drained: false, cursor: after, stopped: "ownership" };
      if (ar === "intent_lost") return { drained: false, cursor: after, stopped: "intent" };
      after = item.id;
    }

    if (items.length < pageSize) return { drained: true, cursor: after, stopped: null };
  }
  return { drained: false, cursor: after, stopped: "page_budget" };
}

// Execute a decision. Every actuation is preceded by (1) FULL pre-actuation
// revalidation, (2) an INTENT re-check (do not mutate while intent is unavailable),
// and (3) a FORCED ownership check immediately before the repair RPC. A bump is then
// VERIFIED to have produced durable current intent before it counts as enqueued.
async function applyDecision(studioId: string, deps: ReconcileDeps, decision: ReconcileDecision, guard: LockGuard, res: StudioReconcileResult): Promise<ActuationResult> {
  if (decision.act === "skip") {
    res.skipped++;
    if (decision.reason === "work_in_flight") res.superseded++;
    return "skipped";
  }

  try {
    const fresh = await revalidate(studioId, deps, decision);
    if (fresh.act !== decision.act) {
      res.skipped++;
      res.superseded++;
      return "skipped";
    }
    // §6, intent-eligibility re-check immediately before mutation.
    if (!(await deps.store.isStudioIntentEligible(studioId))) {
      res.intentLost = true;
      return "intent_lost";
    }
    // §4, force an ownership-token check immediately before the repair RPC.
    if (!(await guard.ensureOwnedNow())) return "ownership_lost";

    if (fresh.act === "bump") {
      const newVersion = await deps.store.bumpAppointmentSyncVersion(fresh.appointmentId);
      if (newVersion === null) {
        res.skipped++; // vanished between revalidation and bump
        return "acted";
      }
      // §6, a returned version does not prove durable intent. Confirm a current
      // matching pending/processing op now exists for the resulting version + op class.
      const ops = fresh.class === "surplus_event_delete" ? DELETE_OPS : CREATE_UPDATE_OPS;
      const jobs = (await deps.store.getOpenJobsForEntities(studioId, [fresh.appointmentId])).get(fresh.appointmentId) ?? [];
      if (hasCurrentOrNewerJob(jobs, ops, newVersion)) {
        res.enqueued++;
        res.byClass[fresh.class]++;
      } else {
        // Trigger enqueue was swallowed or intent was lost between the checks: do NOT
        // claim converged. Degraded; the drift persists so the next run retries.
        res.intentVerifyFailed++;
      }
      return "acted";
    }

    const outcome = await deps.store.enqueueOrphanLinkDelete(fresh.linkId);
    if (outcome === "delete_in_flight" || outcome === "suppressed") {
      res.skipped++;
      if (outcome === "delete_in_flight") res.superseded++;
      return "acted";
    }
    if (outcome === "no_active_link") {
      res.skipped++;
      return "acted";
    }
    res.enqueued++;
    res.byClass[fresh.class]++;
    return "acted";
  } catch {
    res.errors++; // one bad row never aborts the studio sweep; the cursor advances
    return "acted";
  }
}

// FULL pre-actuation revalidation: re-read current state + RE-CLASSIFY.
async function revalidate(studioId: string, deps: ReconcileDeps, decision: ReconcileDecision): Promise<ReconcileDecision> {
  if (decision.act === "orphan_delete") {
    const link = await deps.store.getActiveLinkById(studioId, decision.linkId);
    if (!link) return { act: "skip", reason: "decision_stale" };
    const [appts, jobs] = await Promise.all([
      deps.store.getAppointmentStates(studioId, [link.honeEntityId]),
      deps.store.getOpenJobsForEntities(studioId, [link.honeEntityId]),
    ]);
    return classifyActiveLink(link, appts.get(link.honeEntityId), jobs.get(link.honeEntityId) ?? []);
  }
  if (decision.act !== "bump") return { act: "skip", reason: "decision_stale" };
  const id = decision.appointmentId;
  const [states, links, jobs] = await Promise.all([
    deps.store.getAppointmentStates(studioId, [id]),
    deps.store.getActiveLinksForEntities(studioId, [id]),
    deps.store.getOpenJobsForEntities(studioId, [id]),
  ]);
  const appt = states.get(id);
  if (!appt) return { act: "skip", reason: "vanished" };
  const link = links.get(id);
  const entityJobs = jobs.get(id) ?? [];
  if (appt.status === "confirmed") return classifyConfirmedAppointment({ id, syncVersion: appt.syncVersion }, link, entityJobs);
  if (appt.status === "cancelled") return link ? classifyActiveLink(link, appt, entityJobs) : { act: "skip", reason: "keep_event" };
  return { act: "skip", reason: "keep_event" };
}

async function recordStudio(deps: ReconcileDeps, res: StudioReconcileResult): Promise<void> {
  try {
    await deps.observability?.recordStudioResult?.(res);
  } catch {
    // fail-open
  }
}

// Rotate a SORTED studio list so it starts AFTER the cursor, wrapping around. This is
// what guarantees every eligible studio eventually gets a turn even when every
// invocation processes only one studio before its deadline.
export function rotateAfter(sorted: string[], cursor: string | null): string[] {
  if (cursor === null || sorted.length === 0) return sorted;
  let idx = sorted.findIndex((id) => id > cursor);
  if (idx === -1) idx = 0; // cursor >= all -> wrap to the start
  return [...sorted.slice(idx), ...sorted.slice(0, idx)];
}

function computeRunOutcome(r: ReconcileRunResult): RunOutcome {
  if (r.results.some((x) => x.outcome === "error")) return "error";
  if (
    r.coordinatorSkipped === "unavailable" ||
    r.coordinatorLost ||
    r.cursorReadFailed ||
    r.cursorPersistFailed ||
    r.studiosDeferred > 0 ||
    r.intentVerifyFailed > 0 ||
    r.studiosContinuationFailed > 0 ||
    r.results.some((x) => x.outcome === "degraded")
  ) {
    return "degraded";
  }
  return "ok";
}

// Run the full sweep: under the coordinator lock, resume the durable studio cursor,
// process studios (each under its own per-studio lock) in a deterministic wrap-around
// order, advance the cursor after each, and truthfully report deferred work.
export async function runReconciliation(deps: ReconcileDeps): Promise<ReconcileRunResult> {
  const now = deps.now ?? Date.now;
  const runStartedAtIso = new Date(now()).toISOString();
  const deadlineMs = deps.deadlineMs ?? Number.POSITIVE_INFINITY;

  const result: ReconcileRunResult = {
    runStartedAtIso,
    outcome: "ok",
    coordinatorSkipped: null,
    coordinatorLost: false,
    cursorReadFailed: false,
    cursorPersistFailed: false,
    eligibleStudios: 0,
    studiosAttempted: 0,
    studiosCompleted: 0,
    studiosTruncated: 0,
    studiosDeferred: 0,
    studiosSkippedHeld: 0,
    studiosSkippedUnavailable: 0,
    studiosContinuationFailed: 0,
    candidates: 0,
    enqueued: 0,
    skipped: 0,
    superseded: 0,
    intentVerifyFailed: 0,
    errors: 0,
    byClass: emptyByClass(),
    results: [],
  };

  const coord = await deps.coordinator.acquire();
  if (!coord.ok) {
    result.coordinatorSkipped = coord.reason; // 'held' (benign) or 'unavailable' (degraded)
    result.outcome = coord.reason === "unavailable" ? "degraded" : "ok";
    return result;
  }

  try {
    const eligible = (await deps.store.listEligibleStudioIds()).slice().sort();
    result.eligibleStudios = eligible.length;

    const cur = await deps.coordinator.readCursor();
    if (!cur.ok) {
      result.cursorReadFailed = true;
    } else if (eligible.length > 0) {
      const ordered = rotateAfter(eligible, cur.cursor);
      const batchLimit = Math.max(1, Math.floor(deps.studioBatchLimit ?? ordered.length));
      let attempted = 0;
      for (const studioId of ordered) {
        if (attempted >= batchLimit) break;
        if (now() >= deadlineMs) break;
        if (!(await deps.coordinator.renew(coord.token))) {
          result.coordinatorLost = true;
          break;
        }
        const r = await reconcileStudio(studioId, deps, runStartedAtIso);
        result.results.push(r);
        aggregateStudio(result, r);
        attempted++;
        // Advance the durable studio cursor (ownership-atomic).
        if (!(await deps.coordinator.writeCursor(coord.token, studioId))) {
          result.cursorPersistFailed = true;
          break;
        }
      }
      result.studiosAttempted = attempted;
      result.studiosDeferred = Math.max(0, eligible.length - attempted);
    }
  } catch {
    // Aggregate-level failure; outcome will reflect it.
    result.cursorPersistFailed = result.cursorPersistFailed || false;
    result.outcome = "error";
  } finally {
    await deps.coordinator.release(coord.token);
  }

  if (result.outcome !== "error") result.outcome = computeRunOutcome(result);
  return result;
}

function aggregateStudio(result: ReconcileRunResult, r: StudioReconcileResult): void {
  if (r.lockSkipReason === "held") result.studiosSkippedHeld++;
  else if (r.lockSkipReason === "unavailable") result.studiosSkippedUnavailable++;
  else if (!r.continuationRead || !r.continuationPersisted || !r.continuationCleared) result.studiosContinuationFailed++;

  if (r.locked && r.continuationRead) {
    if (r.truncated) result.studiosTruncated++;
    else if (!r.errored && r.continuationCleared) result.studiosCompleted++;
  }

  result.candidates += r.candidates;
  result.enqueued += r.enqueued;
  result.skipped += r.skipped;
  result.superseded += r.superseded;
  result.intentVerifyFailed += r.intentVerifyFailed;
  result.errors += r.errors;
  for (const k of Object.keys(result.byClass) as ReconcileClass[]) result.byClass[k] += r.byClass[k];
}
