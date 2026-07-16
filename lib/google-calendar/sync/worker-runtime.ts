import "server-only";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { isAuthorizedCronRequest } from "@/lib/cron/auth";
import { recordOpsAlert } from "@/lib/ops/alerts";
import { encryptGoogleSecret, decryptGoogleSecret } from "../token-crypto";
import { computeBackoff } from "./backoff";
import { processAccessTokenCache, type AccessTokenCache } from "./access-token-cache";
import { createUpstashRefreshCoordinator } from "./upstash-refresh-coordinator";
import { createAdminConnectionStore } from "./connection-store";
import { createGoogleRestClient, type GoogleRestClient } from "./google-rest-client";
import { createAdminOpsLinkStore, type OpsLinkStore } from "./link-transition-store";
import { createCalendarSyncOperations } from "./operations";
import { handleCalendarSyncJob, type SyncOperations } from "./handler";
import {
  createTokenManager,
  type ConnectionStore,
  type RefreshCoordinator,
  type TokenCrypto,
  type TokenManager,
} from "./token-manager";
import type { RecordResultParams } from "./adapters";
import {
  isDead,
  isDone,
  isRetry,
  resultToRpcParams,
  type ClaimedJob,
  type JobResult,
} from "./job-result";
import { recordWorkerRun, type WorkerHeartbeat } from "./worker-heartbeat";

// Google Calendar — Phase B2.3-c2: the PRODUCTION worker-drain runtime.
//
// This is the ONE server-only seam that wires the deployed claim -> handle ->
// record architecture to the c1 operations map for the authenticated
// /api/cron/calendar-sync route. It:
//   * composes handleCalendarSyncJob with the production connection store, token
//     manager (Upstash cross-process refresh coordinator + ONE shared process
//     access-token cache), Google REST client, c1 operations map (whose mandatory
//     invalidator clears that SAME shared cache), event-link store, and the
//     execution-time outbound-intent reader;
//   * drains a BOUNDED number of claimed jobs (<= WORKER_MAX_CLAIMED) within a
//     server-side deadline, distinguishing the HANDLER result from the DURABLE
//     record-RPC result and never manually mutating the outbox; and
//   * exposes handleWorkerRoute — auth first (before any admin client / claim),
//     then drain, then a fail-open heartbeat + bounded fail-open ops alerts.
//
// It adds NO queue, NO coordinator beyond the narrow per-connection token-refresh
// mutex, NO retry engine, and NO caller-selected target. The database claim RPC
// remains the sole work selector; worker concurrency is owned by
// claim_calendar_sync_op + FOR UPDATE SKIP LOCKED + claim tokens + lease expiry +
// the reaper. While worker_enabled=false the claim RPC returns zero rows and
// performs zero mutation, so this route is dormant in production.

// ---- Fixed, hard-coded, NOT caller-controlled bounds (§8). ----
export const WORKER_BATCH_SIZE = 5; // per claim RPC call (<= the RPC's own [1,25] clamp)
export const WORKER_MAX_BATCHES = 3; // route claims at most this many batches
export const WORKER_MAX_CLAIMED = WORKER_BATCH_SIZE * WORKER_MAX_BATCHES; // 15
// The job-ADMISSION window (NOT the total invocation duration). The drain stops
// STARTING new jobs and stops claiming a new batch at/after this point; an
// already-started job then runs to completion within the platform ceiling below.
export const WORKER_JOB_ADMISSION_WINDOW_MS = 50_000;
// The platform function ceiling. A literal `export const maxDuration` is pinned in
// the route (app/api/cron/calendar-sync/route.ts) for Next.js/Vercel static
// detection; this constant lets tests assert the two agree and that the
// completion-headroom invariant below holds. NOT set via vercel.json.
export const WORKER_PLATFORM_MAX_DURATION_SECONDS = 180;
// The MINIMUM guaranteed completion headroom for the last in-flight job after the
// admission window closes: WORKER_PLATFORM_MAX_DURATION_SECONDS*1000 -
// WORKER_JOB_ADMISSION_WINDOW_MS must be >= this (>= 120s).
export const WORKER_MIN_COMPLETION_HEADROOM_MS = 120_000;

// ---------------------------------------------------------------------------
// Claim row validation (§9). A malformed claim row aborts the run safely; nothing
// PHI/secret is placed in the error.
// ---------------------------------------------------------------------------
export class ClaimShapeError extends Error {
  constructor() {
    super("claim row shape invalid");
    this.name = "ClaimShapeError";
  }
}

const OP_TYPES = new Set(["event.create", "event.update", "event.delete", "full.resync"]);

export function toClaimedJob(raw: Record<string, unknown>): ClaimedJob {
  const id = raw.id;
  const studioId = raw.studio_id;
  const connectionId = raw.connection_id;
  const opType = raw.op_type;
  const claimToken = raw.claim_token;
  if (
    typeof id !== "string" ||
    typeof studioId !== "string" ||
    typeof connectionId !== "string" ||
    typeof claimToken !== "string" ||
    typeof opType !== "string" ||
    !OP_TYPES.has(opType)
  ) {
    throw new ClaimShapeError();
  }
  return {
    id,
    studioId,
    connectionId,
    opType: opType as ClaimedJob["opType"],
    honeEntityType: (raw.hone_entity_type as ClaimedJob["honeEntityType"]) ?? null,
    honeEntityId: (raw.hone_entity_id as string | null) ?? null,
    payload: (raw.payload as Record<string, unknown>) ?? {},
    idempotencyKey: typeof raw.idempotency_key === "string" ? raw.idempotency_key : "",
    attempts: Number(raw.attempts ?? 0),
    maxAttempts: Number(raw.max_attempts ?? 0),
    claimToken,
    leaseExpiresAt: raw.lease_expires_at ? String(raw.lease_expires_at) : "",
    priority: Number(raw.priority ?? 0),
  };
}

// ---------------------------------------------------------------------------
// The bounded drain (§8/§10). Reuses the existing backoff + result mapping and the
// existing claim/handle/record contract. Captures the DURABLE record-RPC status
// separately from the HANDLER JobResult, never trusts one as the other, and never
// touches the outbox itself (recovery of any claimed-but-unrecorded row is left to
// lease expiry + the reaper + c1 idempotency).
// ---------------------------------------------------------------------------
export type ClaimPort = (batchSize: number) => Promise<ClaimedJob[]>;
export type HandlePort = (job: ClaimedJob) => Promise<JobResult>;
export type RecordPort = (params: RecordResultParams) => Promise<string>;

export type WorkerRoutePorts = {
  claim: ClaimPort;
  handle: HandlePort;
  record: RecordPort;
  rng?: () => number;
};

export type WorkerRunResult = {
  outcome: "ok" | "degraded" | "error";
  no_work: boolean;
  timed_out: boolean;
  batches: number;
  claimed: number;
  handled: number;
  handler_success_results: number;
  handler_retry_results: number;
  handler_terminal_results: number;
  recorded_done: number;
  recorded_pending: number;
  recorded_dead: number;
  record_idempotent: number;
  record_rejected: number;
  record_errors: number;
  unstarted_claimed: number;
  by_code: Record<string, number>;
  error_class: string | null;
  duration_ms: number;
};

function emptyRun(): WorkerRunResult {
  return {
    outcome: "ok",
    no_work: false,
    timed_out: false,
    batches: 0,
    claimed: 0,
    handled: 0,
    handler_success_results: 0,
    handler_retry_results: 0,
    handler_terminal_results: 0,
    recorded_done: 0,
    recorded_pending: 0,
    recorded_dead: 0,
    record_idempotent: 0,
    record_rejected: 0,
    record_errors: 0,
    unstarted_claimed: 0,
    by_code: {},
    error_class: null,
    duration_ms: 0,
  };
}

function coarseErrorClass(err: unknown): string {
  return (err instanceof Error ? err.name : "unknown").slice(0, 64);
}

export async function drainCalendarSyncQueue(
  ports: WorkerRoutePorts,
  opts: { startedAt: number; deadlineMs: number; now: () => number },
): Promise<WorkerRunResult> {
  const now = opts.now;
  const r = emptyRun();
  const finish = (): WorkerRunResult => {
    // Non-error outcome tiers: a timed-out or record-rejected run is NOT fully
    // healthy. Error paths set outcome before calling finish() and are preserved.
    if (r.outcome !== "error") {
      r.outcome = r.timed_out || r.record_rejected > 0 ? "degraded" : "ok";
      r.no_work = r.claimed === 0 && r.outcome === "ok";
    }
    r.duration_ms = Math.max(0, now() - opts.startedAt);
    return r;
  };

  for (let b = 0; b < WORKER_MAX_BATCHES; b++) {
    if (now() >= opts.deadlineMs) {
      r.timed_out = true;
      break; // do not claim another batch at/after the deadline
    }

    let jobs: ClaimedJob[];
    try {
      jobs = await ports.claim(WORKER_BATCH_SIZE);
    } catch (err) {
      // A claim transport/query/shape failure aborts the run; do not claim again.
      r.error_class = coarseErrorClass(err);
      r.outcome = "error";
      return finish();
    }
    r.batches += 1;
    r.claimed += jobs.length;
    if (jobs.length === 0) break; // drained / no work

    for (let i = 0; i < jobs.length; i++) {
      const job = jobs[i];
      if (now() >= opts.deadlineMs) {
        // Deadline reached mid-batch: stop starting new jobs. The remaining
        // claimed rows are left to lease-expiry reclaim (never manually cleared).
        r.timed_out = true;
        r.unstarted_claimed += jobs.length - i;
        return finish();
      }

      // HANDLE — the handler returns a typed JobResult for a Google outcome; an
      // unexpected throw stops the run (never converted to success).
      let result: JobResult;
      try {
        result = await ports.handle(job);
      } catch (err) {
        r.error_class = coarseErrorClass(err);
        r.outcome = "error";
        r.unstarted_claimed += jobs.length - i; // this job + the rest never durably recorded
        return finish();
      }
      r.handled += 1;
      r.by_code[result.code] = (r.by_code[result.code] ?? 0) + 1;
      if (isDone(result.code)) r.handler_success_results += 1;
      else if (isRetry(result.code)) r.handler_retry_results += 1;
      else if (isDead(result.code)) r.handler_terminal_results += 1;

      // RECORD — the DURABLE outcome. Never inferred from the handler result.
      const backoff = computeBackoff({
        attempts: job.attempts,
        retryAfterSeconds: result.retryAfterSeconds ?? null,
        rng: ports.rng,
      });
      const params = resultToRpcParams(result, backoff);
      let status: string;
      try {
        status = await ports.record({
          id: job.id,
          claimToken: job.claimToken,
          ok: params.ok,
          errorCode: params.errorCode,
          errorMessage: params.errorMessage,
          retryAfterSeconds: params.retryAfterSeconds,
        });
      } catch (err) {
        // Ambiguous record failure after a provider effect may have applied: STOP.
        // Never re-run the provider op, never mutate the outbox; leave recovery to
        // lease-token expiry + the reaper + c1 idempotency.
        r.record_errors += 1;
        r.error_class = coarseErrorClass(err);
        r.outcome = "error";
        r.unstarted_claimed += jobs.length - (i + 1);
        return finish();
      }

      switch (status) {
        case "done":
          r.recorded_done += 1;
          break;
        case "pending":
          r.recorded_pending += 1;
          break;
        case "dead":
          r.recorded_dead += 1;
          break;
        case "already_done":
        case "already_dead":
          r.record_idempotent += 1;
          break;
        case "not_found":
        case "not_claimed":
        case "stale_token":
          // A closed rejection: our claim was lost/superseded. Truthful — never
          // counted as durably done; the run is degraded, not healthy.
          r.record_rejected += 1;
          break;
        default:
          // An unrecognized RPC status is ambiguous -> stop the run.
          r.record_errors += 1;
          r.error_class = "record_unknown_status";
          r.outcome = "error";
          r.unstarted_claimed += jobs.length - (i + 1);
          return finish();
      }
    }

    if (jobs.length < WORKER_BATCH_SIZE) break; // partial batch -> queue drained
  }

  return finish();
}

// ---------------------------------------------------------------------------
// Production runtime composition (§11/§12/§13-amended/§15). Overridable ONLY for
// direct composition tests; the route calls it with no overrides.
// ---------------------------------------------------------------------------
type AdminLike = ReturnType<typeof createAdminClient>;

export type WorkerRuntimeOverrides = {
  admin?: AdminLike;
  cache?: AccessTokenCache;
  coordinator?: RefreshCoordinator;
  connectionStore?: ConnectionStore;
  restClient?: GoogleRestClient;
  opsStore?: OpsLinkStore;
  crypto?: TokenCrypto;
  isStudioOutboundEnabled?: (studioId: string) => Promise<boolean>;
  claim?: ClaimPort;
  record?: RecordPort;
};

// Introspection exposed for composition tests only; the route never reads it.
export type WorkerRuntimeWiring = {
  cache: AccessTokenCache;
  coordinator: RefreshCoordinator;
  tokenManager: TokenManager;
  operations: SyncOperations;
  invalidateAccessToken: (connectionId: string) => void;
};

export type WorkerRuntime = WorkerRoutePorts & { wiring: WorkerRuntimeWiring };

const productionCrypto: TokenCrypto = {
  encrypt: (raw) => encryptGoogleSecret(raw),
  decrypt: (blob) => decryptGoogleSecret(blob),
};

// Execution-time outbound-intent reader (mirrors the reconcile store). Fail-safe:
// any error reads as "not enabled" so an uncertain read HOLDS the job.
function makeOutboundReader(admin: AdminLike): (studioId: string) => Promise<boolean> {
  return async (studioId: string) => {
    try {
      const { data, error } = await admin
        .from("studios")
        .select("id")
        .eq("id", studioId)
        .eq("google_calendar_outbound_sync_enabled", true)
        .maybeSingle();
      return !error && Boolean(data);
    } catch {
      return false;
    }
  };
}

// Server-only admin claim adapter: calls claim_calendar_sync_op with ONLY the
// fixed bounded batch size. No tenant/provider target is ever supplied.
function makeAdminClaim(admin: AdminLike): ClaimPort {
  return async (batchSize: number) => {
    const { data, error } = await admin.rpc("claim_calendar_sync_op", { p_batch_size: batchSize });
    if (error) throw new Error("claim_rpc_error"); // coarse; no PHI/secret
    if (!Array.isArray(data)) throw new ClaimShapeError();
    return data.map((row) => toClaimedJob(row as Record<string, unknown>));
  };
}

// Server-only admin record adapter around record_calendar_sync_result. Returns the
// RPC's closed status text verbatim (the drain interprets it).
function makeAdminRecord(admin: AdminLike): RecordPort {
  return async (p: RecordResultParams) => {
    const { data, error } = await admin.rpc("record_calendar_sync_result", {
      p_id: p.id,
      p_claim_token: p.claimToken,
      p_ok: p.ok,
      p_error_code: p.errorCode,
      p_error_message: p.errorMessage,
      p_retry_after_seconds: p.retryAfterSeconds,
    });
    if (error) throw new Error("record_rpc_error"); // coarse; drain -> record_errors + stop
    if (typeof data !== "string") throw new Error("record_rpc_shape");
    return data;
  };
}

export function createProductionWorkerRuntime(overrides: WorkerRuntimeOverrides = {}): WorkerRuntime {
  const admin = overrides.admin ?? createAdminClient();
  // ONE shared process access-token cache for BOTH the token manager and the c1
  // operations-map invalidator (§12). Never two caches.
  const cache = overrides.cache ?? processAccessTokenCache;
  // Upstash cross-process refresh mutex (fail-closed). Never inProcessOnly / pg.
  const coordinator = overrides.coordinator ?? createUpstashRefreshCoordinator();
  const connectionStore = overrides.connectionStore ?? createAdminConnectionStore();
  const restClient = overrides.restClient ?? createGoogleRestClient();
  const opsStore = overrides.opsStore ?? createAdminOpsLinkStore();
  const crypto = overrides.crypto ?? productionCrypto;
  const isStudioOutboundEnabled = overrides.isStudioOutboundEnabled ?? makeOutboundReader(admin);

  const tokenManager = createTokenManager({ store: connectionStore, crypto, client: restClient, cache, coordinator });
  const invalidateAccessToken = (connectionId: string) => cache.clear(connectionId);
  const operations = createCalendarSyncOperations({ rest: restClient, store: opsStore, invalidateAccessToken });

  const handle: HandlePort = (job) =>
    handleCalendarSyncJob(job, { store: connectionStore, tokenManager, isStudioOutboundEnabled, operations });

  const claim = overrides.claim ?? makeAdminClaim(admin);
  const record = overrides.record ?? makeAdminRecord(admin);

  return { claim, handle, record, wiring: { cache, coordinator, tokenManager, operations, invalidateAccessToken } };
}

// ---------------------------------------------------------------------------
// The route handler seam (§6/§16/§17/§18/§19). Auth FIRST — before any admin
// client, claim, heartbeat, or request-bearing alert.
// ---------------------------------------------------------------------------
const ROUTE = "/api/cron/calendar-sync";

export type WorkerRouteObservers = {
  recordHeartbeat: (hb: WorkerHeartbeat) => Promise<void>;
  emitAlert: (severity: "info" | "warning" | "critical", event: string, safeDetails: Record<string, unknown>) => Promise<void>;
};

export type WorkerRouteOptions = {
  runtime?: WorkerRoutePorts; // injected for tests; production builds the real one
  observers?: Partial<WorkerRouteObservers>;
  now?: () => number;
  budgetMs?: number;
};

async function defaultEmitAlert(
  severity: "info" | "warning" | "critical",
  event: string,
  safeDetails: Record<string, unknown>,
): Promise<void> {
  try {
    await recordOpsAlert({ severity, event, message: `Google Calendar worker route: ${event}`, route: ROUTE, safeDetails });
  } catch {
    // A failed signal write must never change route/claim/record behaviour.
  }
}

// Wrap an injected observer so a sabotaged (throwing) heartbeat/alert can never
// alter the route's core execution truth or its response.
async function guarded(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch {
    // observability failure is swallowed
  }
}

function heartbeatFromResult(result: WorkerRunResult, startedAt: number, atMs: number): WorkerHeartbeat {
  return {
    at: new Date(atMs).toISOString(),
    started_at: new Date(startedAt).toISOString(),
    duration_ms: result.duration_ms,
    outcome: result.outcome,
    no_work: result.no_work,
    claimed: result.claimed,
    handled: result.handled,
    recorded_done: result.recorded_done,
    recorded_pending: result.recorded_pending,
    recorded_dead: result.recorded_dead,
    record_idempotent: result.record_idempotent,
    record_rejected: result.record_rejected,
    record_errors: result.record_errors,
    unstarted_claimed: result.unstarted_claimed,
    timed_out: result.timed_out,
    error_class: result.error_class,
    by_code: result.by_code,
  };
}

function responseBody(result: WorkerRunResult): Record<string, unknown> {
  return {
    ok: result.outcome === "ok",
    outcome: result.outcome,
    claimed: result.claimed,
    handled: result.handled,
    handler_success_results: result.handler_success_results,
    handler_retry_results: result.handler_retry_results,
    handler_terminal_results: result.handler_terminal_results,
    recorded_done: result.recorded_done,
    recorded_pending: result.recorded_pending,
    recorded_dead: result.recorded_dead,
    record_idempotent: result.record_idempotent,
    record_rejected: result.record_rejected,
    record_errors: result.record_errors,
    unstarted_claimed: result.unstarted_claimed,
    timed_out: result.timed_out,
    no_work: result.no_work,
    batches: result.batches,
    duration_ms: result.duration_ms,
    by_code: result.by_code,
  };
}

async function emitOutcomeAlerts(
  emit: WorkerRouteObservers["emitAlert"],
  result: WorkerRunResult,
): Promise<void> {
  // Never alert for an ordinary healthy / disabled / no-work invocation.
  if (result.outcome === "ok") return;
  const base = {
    stage: "drain",
    outcome: result.outcome,
    claimed: result.claimed,
    handled: result.handled,
    record_rejected: result.record_rejected,
    record_errors: result.record_errors,
    timed_out: result.timed_out,
    unstarted_claimed: result.unstarted_claimed,
    duration_ms: result.duration_ms,
    error_class: result.error_class,
  };
  if (result.outcome === "error") {
    if (result.record_errors > 0) {
      await guarded(() => emit("warning", "calendar_worker_record_failed", base));
    } else {
      await guarded(() => emit("critical", "calendar_worker_route_failed", base));
    }
    return;
  }
  // degraded
  if (result.timed_out) {
    await guarded(() => emit("info", "calendar_worker_timed_out", base));
  }
  if (result.record_rejected > 0) {
    await guarded(() => emit("warning", "calendar_worker_degraded", base));
  }
}

export async function handleWorkerRoute(
  req: Request,
  opts: WorkerRouteOptions = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  // 1. AUTHENTICATE before creating an admin client or touching claim state.
  if (!isAuthorizedCronRequest(req)) {
    return { status: 401, body: { ok: false, error: "Unauthorized" } };
  }

  // 2. Reject any caller-supplied query parameter (fail-closed, PHI-free) — the
  //    route trusts NO caller-selected tenant/provider/batch target (§7).
  let url: URL | null = null;
  try {
    url = new URL(req.url);
  } catch {
    url = null;
  }
  if (url && Array.from(url.searchParams.keys()).length > 0) {
    return { status: 400, body: { ok: false, error: "unexpected_query" } };
  }

  const now = opts.now ?? Date.now;
  const startedAt = now();
  const deadlineMs = startedAt + (opts.budgetMs ?? WORKER_JOB_ADMISSION_WINDOW_MS);
  const recordHeartbeat = opts.observers?.recordHeartbeat ?? recordWorkerRun;
  const emitAlert = opts.observers?.emitAlert ?? defaultEmitAlert;

  let result: WorkerRunResult;
  try {
    const runtime = opts.runtime ?? createProductionWorkerRuntime();
    result = await drainCalendarSyncQueue(runtime, { startedAt, deadlineMs, now });
  } catch (err) {
    // An unexpected route-level throw (e.g. runtime construction). Safe failure.
    const errorClass = coarseErrorClass(err);
    const at = now();
    await guarded(() =>
      recordHeartbeat({
        at: new Date(at).toISOString(),
        started_at: new Date(startedAt).toISOString(),
        duration_ms: Math.max(0, at - startedAt),
        outcome: "error",
        error_class: errorClass,
      }),
    );
    await guarded(() =>
      emitAlert("critical", "calendar_worker_route_failed", { stage: "route", outcome: "error", error_class: errorClass, duration_ms: Math.max(0, at - startedAt) }),
    );
    return { status: 500, body: { ok: false, outcome: "error", error: "worker_failed" } };
  }

  // 3. Heartbeat AFTER the run reaches its truthful final result (fail-open; a
  //    heartbeat failure never hides a record failure or changes the response).
  await guarded(() => recordHeartbeat(heartbeatFromResult(result, startedAt, now())));

  // 4. Bounded fail-open ops alerts for non-healthy outcomes only.
  await emitOutcomeAlerts(emitAlert, result);

  // 5. Truthful PHI-free aggregate response; status consistent with the outcome.
  return { status: result.outcome === "error" ? 500 : 200, body: responseBody(result) };
}
