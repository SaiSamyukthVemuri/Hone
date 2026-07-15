import "server-only";

// Google Calendar — Phase B2.3-b: the transport-neutral reconciliation SWEEP core.
//
// The single orchestration seam the reconcile cron route calls. Depends on NO
// Next.js/Vercel/Supabase/host type — only on an injected `ReconcileStore` (data
// access), a `ReconcileLock` (cross-process per-studio mutual exclusion), a
// `ReconcileContinuationStore` (durable, resumable pagination position), and a
// `now()` clock. The SAME logic runs against the real service-role Supabase client
// (production route) AND against a raw-pg store in the DB integration tests.
//
// WHAT THE SWEEP IS: a bounded DRIFT DETECTOR + ORCHESTRATOR over the EXISTING DB
// repair primitives. It builds NO enqueue path, NO idempotency key, NO outbox/link
// bookkeeping of its own, and NEVER calls Google. It recovers the gaps the enqueue
// trigger could not cover (mutations made while product INTENT was unavailable, or
// a swallowed never-raise enqueue) + first activation, within intent-eligible
// studios only.
//
// CORRECTNESS POSTURE (the two independent guarantees):
//   * MUTATION SAFETY is FAIL-CLOSED — the per-studio lock and the durable
//     continuation are correctness state. If either is unavailable the studio is
//     NOT swept (never swept unlocked, never past a lost lease, never with an
//     unknown position); the studio is reported degraded, never falsely complete.
//   * OBSERVABILITY (heartbeat / metrics / dead-row alert) is FAIL-OPEN — a failed
//     write never aborts the sweep or a booking.
//
// STALE-JOB MODEL: a pending/processing outbox row is "current work" ONLY when its
// op class and sync_version correspond to the CURRENT desired state. An OLDER job
// (stale sync_version, or wrong op for the current state) does NOT block generating
// current intent. Generating current intent alongside a stale pending job is safe
// at this phase because the worker is OFF (nothing dispatches); the EXECUTION-TIME
// stale fence (a worker operation returning `ok_noop_superseded` for a payload
// sync_version older than the current link/appointment state — see job-result.ts)
// is a B2.4 worker-operation responsibility. B2.3-b's job is only to ensure the
// current desired intent EXISTS.

// ---------------------------------------------------------------------------
// Data shapes (minimal, operational-only — never client content / PHI).
// ---------------------------------------------------------------------------
export type ReconcileApptRow = { id: string; syncVersion: number };

export type ReconcileApptState = {
  id: string;
  status: string; // 'confirmed' | 'cancelled' | 'completed' | 'no_show'
  syncVersion: number;
  cancellationKind: string | null; // 'rescheduled' | 'withdrawn' | null
};

export type ReconcileLinkRow = {
  id: string;
  honeEntityId: string;
  googleEventId: string | null; // null = local PLACEHOLDER (no real Google event yet)
  lastHoneVersion: number;
};

// Per-entity open/terminal outbox job metadata. `syncVersion` is read from
// payload->>'sync_version' (present on every appointment-keyed create/update/delete
// job; null for entity-less tombstones, which never key an appointment entity).
export type OpenJobStatus = "pending" | "processing" | "dead";
export type OpenJob = { opType: string; syncVersion: number | null; status: OpenJobStatus };

// The four documented reconciliation classes (google-calendar-sync.md §3c/§3e).
export type ReconcileClass =
  | "missing_link_job" // confirmed appt, no active/real link + no current job -> create
  | "link_version_behind" // real link behind the current appt version, no current job -> update
  | "orphaned_link_delete" // active real-event link whose appointment is gone -> tombstone delete
  | "surplus_event_delete"; // withdrawn cancellation w/ a live real-event link -> delete

export type ReconcileSkipReason =
  | "converged"
  | "work_in_flight" // a current-or-newer matching job already exists (supersede-safe)
  | "keep_event" // completed/no_show/rescheduled -> event remains / handled elsewhere
  | "handled_by_appointment_pass" // confirmed link handled by the create/update pass
  | "inert_placeholder" // placeholder link (no real event) needs no remote op
  | "dead_create_manual_review" // placeholder whose create is terminally dead -> operator/dead-row alert
  | "decision_stale" // pre-actuation revalidation showed the decision no longer holds
  | "vanished"; // the appointment disappeared before actuation

export type ReconcileDecision =
  | { act: "bump"; class: ReconcileClass; appointmentId: string }
  | { act: "orphan_delete"; class: ReconcileClass; linkId: string }
  | { act: "skip"; reason: ReconcileSkipReason };

// ---------------------------------------------------------------------------
// Store seam (data access). Studio-scoped; the route derives the eligible set
// server-side and never trusts a browser-supplied id.
// ---------------------------------------------------------------------------
export type ReconcileStore = {
  listEligibleStudioIds(): Promise<string[]>;
  pageConfirmedFutureAppointments(
    studioId: string,
    activationStartedAtIso: string,
    snapshotStartedAtIso: string,
    afterId: string | null,
    limit: number,
  ): Promise<ReconcileApptRow[]>;
  pageActiveAppointmentLinks(studioId: string, afterId: string | null, limit: number): Promise<ReconcileLinkRow[]>;
  getActiveLinksForEntities(studioId: string, appointmentIds: string[]): Promise<Map<string, ReconcileLinkRow>>;
  getActiveLinkById(studioId: string, linkId: string): Promise<ReconcileLinkRow | null>; // orphan revalidation
  getAppointmentStates(studioId: string, appointmentIds: string[]): Promise<Map<string, ReconcileApptState>>;
  // Per-entity open+dead job metadata (op class + sync_version) — the supersede model.
  getOpenJobsForEntities(studioId: string, appointmentIds: string[]): Promise<Map<string, OpenJob[]>>;
  // Actuators — the EXISTING repair RPCs. The sweep adds no new enqueue logic.
  bumpAppointmentSyncVersion(appointmentId: string): Promise<number | null>;
  enqueueOrphanLinkDelete(linkId: string): Promise<string>;
  // Terminal dead-row inventory (for the dead-row operational alert).
  listStudiosWithDeadOutbox(): Promise<{ studioId: string; deadCount: number }[]>;
};

// ---------------------------------------------------------------------------
// Lock seam — a REAL cross-process, per-studio ownership-token lock (Upstash SET
// NX + Lua compare-token release/renew). FAIL-CLOSED.
// ---------------------------------------------------------------------------
export type LockAcquire = { ok: true; token: string } | { ok: false; reason: "held" | "unavailable" };

export type ReconcileLock = {
  acquire(studioId: string): Promise<LockAcquire>;
  release(studioId: string, token: string): Promise<void>;
  // Extend the lease. Returns false when ownership is lost / cannot be confirmed ->
  // the caller stops mutating (fail-closed). Required for correct long runs.
  renew?(studioId: string, token: string): Promise<boolean>;
};

// ---------------------------------------------------------------------------
// Continuation seam — durable, resumable pagination position (correctness state).
// read() returning {ok:false} = an I/O error (fail-closed: do not sweep). A null
// value = no continuation (start a fresh pass under a new snapshot). Losing the
// record can never report the studio complete — the next run restarts from the
// beginning (convergence is idempotent), never skips to the end.
// ---------------------------------------------------------------------------
export type ReconcilePass = "appointments" | "links";
export type ReconcileContinuation = {
  snapshotStartedAtIso: string; // pinned when the studio run began (created_at <= this)
  activationStartedAtIso: string; // pinned activation boundary (ends_at >= this)
  pass: ReconcilePass;
  cursor: string | null; // immutable last-seen id within the pass
};
export type ReconcileContinuationStore = {
  read(studioId: string): Promise<{ ok: true; value: ReconcileContinuation | null } | { ok: false }>;
  write(studioId: string, value: ReconcileContinuation): Promise<boolean>;
  clear(studioId: string): Promise<boolean>;
};

export type ReconcileObservability = {
  recordStudioResult?(result: StudioReconcileResult): Promise<void> | void;
};

export type ReconcileDeps = {
  store: ReconcileStore;
  lock: ReconcileLock;
  continuation: ReconcileContinuationStore;
  observability?: ReconcileObservability;
  now?: () => number;
  pageSize?: number; // clamped [1, 500]; default 200
  maxPagesPerStudioPerPass?: number; // per-invocation page budget; default 50
  deadlineMs?: number; // absolute epoch ms; stop starting work at/after it (default: no deadline)
  lockRenewIntervalMs?: number; // renew when this much has elapsed since the last renew (default 40s)
};

// ---------------------------------------------------------------------------
// Result shapes — aggregate, non-sensitive counts ONLY.
// ---------------------------------------------------------------------------
export type StudioOutcome = "ok" | "degraded" | "error" | "skipped_held";

export type StudioReconcileResult = {
  studioId: string;
  locked: boolean;
  lockSkipReason?: "held" | "unavailable";
  continuationRead: boolean; // false when the continuation read failed (fail-closed skip)
  continuationPersisted: boolean; // false when a REQUIRED continuation write failed
  candidates: number;
  enqueued: number;
  skipped: number;
  superseded: number;
  byClass: Record<ReconcileClass, number>;
  errors: number; // per-candidate actuator errors (swallowed; studio continues)
  errored: boolean; // an unhandled error aborted the studio
  truncated: boolean; // work remains; a continuation was persisted
  deadlineHit: boolean;
  ownershipLost: boolean;
  appointmentCursor: string | null;
  linkCursor: string | null;
  outcome: StudioOutcome;
};

export type RunOutcome = "ok" | "degraded" | "error";

export type ReconcileRunResult = {
  runStartedAtIso: string;
  outcome: RunOutcome;
  eligibleStudios: number;
  studiosSwept: number; // acquired the lock and read a continuation
  studiosCompleted: number; // fully drained this invocation (continuation cleared)
  studiosTruncated: number; // continuation persisted for a later invocation
  studiosSkippedHeld: number;
  studiosSkippedUnavailable: number;
  studiosContinuationFailed: number; // read or required-write failed (fail-closed)
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
const CREATE_UPDATE_OPS = ["event.create", "event.update"];
const DELETE_OPS = ["event.delete"];

// A pending/processing job is "current or newer" only if its op class matches AND
// its payload sync_version is >= the appointment's current version.
function hasCurrentOrNewerJob(jobs: OpenJob[], ops: string[], atLeastVersion: number): boolean {
  return jobs.some(
    (j) =>
      (j.status === "pending" || j.status === "processing") &&
      ops.includes(j.opType) &&
      j.syncVersion !== null &&
      j.syncVersion >= atLeastVersion,
  );
}
function hasDeadJob(jobs: OpenJob[], ops: string[]): boolean {
  return jobs.some((j) => j.status === "dead" && ops.includes(j.opType));
}

// Appointment pass: a confirmed, not-yet-ended appointment with its active link (or
// undefined) and its open/dead job metadata.
export function classifyConfirmedAppointment(
  appt: ReconcileApptRow,
  link: ReconcileLinkRow | undefined,
  jobs: OpenJob[],
): ReconcileDecision {
  // Current-or-newer create/update already queued -> never generate a duplicate.
  if (hasCurrentOrNewerJob(jobs, CREATE_UPDATE_OPS, appt.syncVersion)) {
    return { act: "skip", reason: "work_in_flight" };
  }
  if (!link) {
    // Class 1: no link, no current job -> the create was never generated.
    return { act: "bump", class: "missing_link_job", appointmentId: appt.id };
  }
  if (link.googleEventId === null) {
    // PLACEHOLDER link: no real Google event exists. NOT convergence.
    if (hasDeadJob(jobs, CREATE_UPDATE_OPS)) {
      // The create is terminally dead — do not auto-loop; surface via the dead-row
      // alert (§8) for operator/manual review.
      return { act: "skip", reason: "dead_create_manual_review" };
    }
    // Swallowed/abandoned create (no live and no dead job) -> re-drive it.
    return { act: "bump", class: "missing_link_job", appointmentId: appt.id };
  }
  // Real provider link.
  if (link.lastHoneVersion < appt.syncVersion) {
    return { act: "bump", class: "link_version_behind", appointmentId: appt.id };
  }
  return { act: "skip", reason: "converged" };
}

// Link pass: an active appointment link. `appt` is the CURRENT state of its
// appointment (undefined => the appointment row was hard-deleted).
export function classifyActiveLink(
  link: ReconcileLinkRow,
  appt: ReconcileApptState | undefined,
  jobs: OpenJob[],
): ReconcileDecision {
  if (!appt) {
    // Appointment gone. Only a REAL provider event can be tombstoned; a placeholder
    // has no remote event -> inert (a future local lifecycle may soft-delete it).
    if (link.googleEventId === null) return { act: "skip", reason: "inert_placeholder" };
    return { act: "orphan_delete", class: "orphaned_link_delete", linkId: link.id };
  }
  if (appt.status === "cancelled") {
    if (appt.cancellationKind === "rescheduled") return { act: "skip", reason: "keep_event" }; // successor rebinds
    if (link.googleEventId === null) return { act: "skip", reason: "inert_placeholder" }; // no remote event to delete
    if (hasCurrentOrNewerJob(jobs, DELETE_OPS, appt.syncVersion)) return { act: "skip", reason: "work_in_flight" };
    return { act: "bump", class: "surplus_event_delete", appointmentId: appt.id };
  }
  // confirmed -> the appointment pass owns it; completed/no_show -> the event stays.
  return { act: "skip", reason: appt.status === "confirmed" ? "handled_by_appointment_pass" : "keep_event" };
}

// ---------------------------------------------------------------------------
// Lock guard — time-based ownership maintenance (renew when due; stop once lost).
// ---------------------------------------------------------------------------
const DEFAULT_RENEW_INTERVAL_MS = 40_000; // TTL is 120s; renew when >40s has elapsed
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
  // Confirm continued ownership, renewing when the interval has elapsed. Returns
  // false the moment ownership is lost or cannot be confirmed (fail-closed).
  async ensureOwned(): Promise<boolean> {
    if (this.lost) return false;
    const t = this.now();
    if (t - this.lastRenewMs < this.intervalMs) return true; // not due
    if (!this.lock.renew) {
      this.lastRenewMs = t; // TTL-only lock: nothing to renew, treat as owned
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
  // Force an ownership check regardless of the timer (pass boundary).
  async ensureOwnedNow(): Promise<boolean> {
    this.lastRenewMs = 0;
    return this.ensureOwned();
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
    candidates: 0,
    enqueued: 0,
    skipped: 0,
    superseded: 0,
    byClass: emptyByClass(),
    errors: 0,
    errored: false,
    truncated: false,
    deadlineHit: false,
    ownershipLost: false,
    appointmentCursor: null,
    linkCursor: null,
    outcome: "ok",
  };
}

function computeStudioOutcome(res: StudioReconcileResult): StudioOutcome {
  if (res.errored) return "error";
  if (res.lockSkipReason === "held") return "skipped_held"; // benign concurrency
  if (res.lockSkipReason === "unavailable") return "degraded"; // lock backend down (fail-closed)
  if (!res.continuationRead) return "degraded"; // could not read position (fail-closed)
  if (res.errors > 0 || res.truncated || res.ownershipLost || !res.continuationPersisted) return "degraded";
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

type PassStopReason = "deadline" | "ownership" | "page_budget";
type PassResult = { drained: boolean; cursor: string | null; stopped: PassStopReason | null };

// Reconcile ONE studio: acquire the lock, read/resume the durable continuation,
// process bounded work under the lease + deadline, and persist/clear the
// continuation. FAIL-CLOSED on the lock and the continuation.
export async function reconcileStudio(
  studioId: string,
  deps: ReconcileDeps,
  runStartedAtIso: string,
): Promise<StudioReconcileResult> {
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
      // Cannot determine our position -> fail-closed, do not sweep.
      res.continuationRead = false;
    } else {
      const ctx: ReconcileContinuation =
        cont.value && isValidContinuation(cont.value)
          ? cont.value
          : {
              snapshotStartedAtIso: runStartedAtIso,
              activationStartedAtIso: runStartedAtIso,
              pass: "appointments",
              cursor: null,
            };
      const guard = new LockGuard(deps.lock, studioId, lock.token, now, renewIntervalMs(deps));
      const passes = await processStudioPasses(studioId, deps, ctx, guard, deadlineMs, now, res);
      if (passes.done) {
        // Best-effort clear: a failed clear is benign (next run resumes past the end,
        // drains an empty page, advances, and clears again).
        await deps.continuation.clear(studioId);
      } else {
        // REQUIRED write: a failed write leaves the studio degraded (never reported
        // complete); the next run restarts from the beginning (idempotent).
        res.continuationPersisted = await deps.continuation.write(studioId, passes.continuation);
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

// Drive the appointment pass then the link pass from the resume point, stopping on
// deadline / lost ownership / page budget with a continuation for the remainder.
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
      if (pr.stopped === "deadline" || pr.stopped === "page_budget") res.deadlineHit = pr.stopped === "deadline";
      if (pr.stopped === "ownership") res.ownershipLost = true;
      return {
        done: false,
        continuation: {
          snapshotStartedAtIso: ctx.snapshotStartedAtIso,
          activationStartedAtIso: ctx.activationStartedAtIso,
          pass,
          cursor: pr.cursor,
        },
      };
    }
    // Pass drained.
    if (pass === "appointments") {
      // Verify ownership before switching passes.
      if (!(await guard.ensureOwnedNow())) {
        res.truncated = true;
        res.ownershipLost = true;
        return {
          done: false,
          continuation: {
            snapshotStartedAtIso: ctx.snapshotStartedAtIso,
            activationStartedAtIso: ctx.activationStartedAtIso,
            pass: "links",
            cursor: null,
          },
        };
      }
      pass = "links";
      cursor = null;
      continue;
    }
    return { done: true }; // both passes drained
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
        ? await deps.store.pageConfirmedFutureAppointments(
            studioId,
            ctx.activationStartedAtIso,
            ctx.snapshotStartedAtIso,
            after,
            pageSize,
          )
        : await deps.store.pageActiveAppointmentLinks(studioId, after, pageSize);

    if (items.length === 0) return { drained: true, cursor: after, stopped: null };

    // Batch the classification inputs for the page (cheap; the actuation is what
    // costs, and it is deadline/ownership-gated per item below).
    const entityIds =
      pass === "appointments"
        ? (items as ReconcileApptRow[]).map((a) => a.id)
        : (items as ReconcileLinkRow[]).map((l) => l.honeEntityId);
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
      // Deadline + ownership are re-checked before EVERY actuator (per item).
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
        const appt = appts.get(link.honeEntityId);
        decision = classifyActiveLink(link, appt, jobs.get(link.honeEntityId) ?? []);
      }
      await applyDecision(studioId, deps, decision, res);
      after = item.id; // advance the cursor only AFTER the item is fully processed
    }

    if (items.length < pageSize) return { drained: true, cursor: after, stopped: null };
  }
  // Hit the per-invocation page budget with more rows remaining.
  return { drained: false, cursor: after, stopped: "page_budget" };
}

// Execute a decision. Every actuation is preceded by a FULL pre-actuation
// revalidation (re-read the current state and re-classify); the actuator fires only
// if the fresh decision still matches the original action.
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
    const fresh = await revalidate(studioId, deps, decision);
    if (fresh.act !== decision.act) {
      // The world changed between classification and actuation.
      res.skipped++;
      res.superseded++;
      return;
    }
    if (fresh.act === "bump") {
      const newVersion = await deps.store.bumpAppointmentSyncVersion(fresh.appointmentId);
      if (newVersion === null) {
        res.skipped++; // vanished between revalidation and bump
        return;
      }
      res.enqueued++;
      res.byClass[fresh.class]++;
      return;
    }
    // orphan_delete — the RPC re-reads the link + guards delete_in_flight + full-
    // unique suppressed. Only a genuinely new outbox row counts as enqueued.
    const outcome = await deps.store.enqueueOrphanLinkDelete(fresh.linkId);
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
    res.byClass[fresh.class]++;
  } catch {
    res.errors++; // one bad row never aborts the studio sweep
  }
}

// FULL pre-actuation revalidation: re-read enough CURRENT state and RE-CLASSIFY, so
// the actuator only fires if the original decision still holds. For orphan delete
// this re-reads the link by id (detecting a rebind, a cleared google_event_id, a
// soft-delete, or an in-flight delete). For a bump it re-reads the appointment +
// its link + its jobs and re-runs the same classifier.
async function revalidate(
  studioId: string,
  deps: ReconcileDeps,
  decision: ReconcileDecision,
): Promise<ReconcileDecision> {
  if (decision.act === "orphan_delete") {
    const link = await deps.store.getActiveLinkById(studioId, decision.linkId);
    if (!link) return { act: "skip", reason: "decision_stale" };
    const [appts, jobs] = await Promise.all([
      deps.store.getAppointmentStates(studioId, [link.honeEntityId]),
      deps.store.getOpenJobsForEntities(studioId, [link.honeEntityId]),
    ]);
    // Re-classifying from the link side detects a rebind (the entity now resolves to
    // a live appointment -> classifyActiveLink no longer returns orphan_delete).
    return classifyActiveLink(link, appts.get(link.honeEntityId), jobs.get(link.honeEntityId) ?? []);
  }

  if (decision.act !== "bump") return { act: "skip", reason: "decision_stale" }; // never called with skip
  // bump: re-read the appointment, its active link, and its jobs.
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
  if (appt.status === "confirmed") {
    return classifyConfirmedAppointment({ id, syncVersion: appt.syncVersion }, link, entityJobs);
  }
  if (appt.status === "cancelled") {
    if (!link) return { act: "skip", reason: "keep_event" }; // nothing to delete
    return classifyActiveLink(link, appt, entityJobs);
  }
  return { act: "skip", reason: "keep_event" }; // completed / no_show
}

async function recordStudio(deps: ReconcileDeps, res: StudioReconcileResult): Promise<void> {
  try {
    await deps.observability?.recordStudioResult?.(res);
  } catch {
    // Observability is fail-open; it must never abort the sweep.
  }
}

function computeRunOutcome(results: StudioReconcileResult[]): RunOutcome {
  if (results.some((r) => r.outcome === "error")) return "error";
  if (results.some((r) => r.outcome === "degraded")) return "degraded";
  return "ok";
}

// Run the full sweep across every INTENT-eligible studio under one pinned run clock.
export async function runReconciliation(deps: ReconcileDeps): Promise<ReconcileRunResult> {
  const now = deps.now ?? Date.now;
  const runStartedAtIso = new Date(now()).toISOString();

  const result: ReconcileRunResult = {
    runStartedAtIso,
    outcome: "ok",
    eligibleStudios: 0,
    studiosSwept: 0,
    studiosCompleted: 0,
    studiosTruncated: 0,
    studiosSkippedHeld: 0,
    studiosSkippedUnavailable: 0,
    studiosContinuationFailed: 0,
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
    // Stop starting new studios once the deadline has passed (their continuation, if
    // any, is untouched — the next invocation resumes them).
    if (deps.deadlineMs !== undefined && now() >= deps.deadlineMs) break;

    const r = await reconcileStudio(studioId, deps, runStartedAtIso);
    result.results.push(r);

    if (r.lockSkipReason === "held") result.studiosSkippedHeld++;
    else if (r.lockSkipReason === "unavailable") result.studiosSkippedUnavailable++;
    else if (!r.continuationRead || !r.continuationPersisted) result.studiosContinuationFailed++;

    if (r.locked && r.continuationRead) {
      result.studiosSwept++;
      if (r.truncated) result.studiosTruncated++;
      else if (!r.errored) result.studiosCompleted++;
    }

    result.candidates += r.candidates;
    result.enqueued += r.enqueued;
    result.skipped += r.skipped;
    result.superseded += r.superseded;
    result.errors += r.errors;
    for (const k of Object.keys(result.byClass) as ReconcileClass[]) result.byClass[k] += r.byClass[k];
  }

  result.outcome = computeRunOutcome(result.results);
  return result;
}
