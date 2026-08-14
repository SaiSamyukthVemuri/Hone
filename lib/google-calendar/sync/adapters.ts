import "server-only";
import { computeBackoff } from "./backoff";
import { isDead, isDone, isRetry, resultToRpcParams, type ClaimedJob, type JobResult } from "./job-result";

// Google Calendar: Phase B2.1: the two transport adapters. Each does ONLY:
//   claim -> handleCalendarSyncJob -> record result.
// They contain no Google logic (that lives in the injected `handle`) and no
// route/host coupling. They are DEFINED here but NOT ACTIVATED: there is no
// app/api route and no cron schedule in this PR. The B2.3-c worker route wires
// them to the real claim/record RPCs + the real handler; the pilot cron route (Bearer CRON_SECRET,
// time-boxed) and the future continuous worker both reuse these functions.
//
// ENVIRONMENT PIN: these are exercised only against a LOCAL disposable Supabase
// with synthetic outbox rows. No adapter, test, or script may call the claim /
// result RPCs against hosted production.

export type ClaimFn = (batchSize: number) => Promise<ClaimedJob[]>;
export type RecordResultParams = {
  id: string;
  claimToken: string;
  ok: boolean;
  errorCode: string | null;
  errorMessage: string | null;
  retryAfterSeconds: number | null;
};
export type RecordFn = (params: RecordResultParams) => Promise<string>; // RPC status text
export type HandleFn = (job: ClaimedJob) => Promise<JobResult>;

export type BatchSummary = {
  claimed: number;
  done: number;
  retried: number;
  dead: number;
  byCode: Record<string, number>;
  timedOut: boolean;
};

export type CronBatchDeps = {
  claim: ClaimFn;
  record: RecordFn;
  handle: HandleFn;
  batchSize?: number; // clamped to [1, 25] (the claim RPC's own clamp)
  deadlineMs?: number; // stop starting new jobs at/after this epoch ms (time box)
  now?: () => number;
  rng?: () => number; // injectable jitter source for backoff
};

function emptySummary(): BatchSummary {
  return { claimed: 0, done: 0, retried: 0, dead: 0, byCode: {}, timedOut: false };
}

// Bounded single-batch drain (the pilot cron adapter's body). Claims up to
// batchSize jobs and processes them sequentially, stopping early if the deadline
// is reached. Never throws for a per-job Google outcome (the handler returns a
// typed result); a thrown transport error from claim/record propagates to the
// caller (the route), which records an ops alert.
export async function runCalendarSyncCronBatch(deps: CronBatchDeps): Promise<BatchSummary> {
  const now = deps.now ?? Date.now;
  const batchSize = Math.min(25, Math.max(1, Math.floor(deps.batchSize ?? 25)));
  const summary = emptySummary();

  const jobs = await deps.claim(batchSize);
  summary.claimed = jobs.length;

  for (const job of jobs) {
    if (deps.deadlineMs !== undefined && now() >= deps.deadlineMs) {
      summary.timedOut = true;
      break; // leave the remaining claimed jobs to lease-expiry reclaim
    }
    const result = await deps.handle(job);
    const backoff = computeBackoff({
      attempts: job.attempts,
      retryAfterSeconds: result.retryAfterSeconds ?? null,
      rng: deps.rng,
    });
    const params = resultToRpcParams(result, backoff);
    await deps.record({
      id: job.id,
      claimToken: job.claimToken,
      ok: params.ok,
      errorCode: params.errorCode,
      errorMessage: params.errorMessage,
      retryAfterSeconds: params.retryAfterSeconds,
    });
    summary.byCode[result.code] = (summary.byCode[result.code] ?? 0) + 1;
    if (isDone(result.code)) summary.done += 1;
    else if (isRetry(result.code)) summary.retried += 1;
    else if (isDead(result.code)) summary.dead += 1;
  }
  return summary;
}

export type WorkerLoopDeps = CronBatchDeps & {
  maxIterations?: number; // bound for tests; production loop runs until stopped
  shouldStop?: () => boolean; // graceful-shutdown signal
};

// Continuously-running worker adapter (DEFINED, NOT ACTIVATED). Loops claiming
// batches until the queue drains, a stop is signaled, or the iteration bound is
// hit. A dedicated worker fleet adds per-connection serialization + rate limiting
// on top; the core claim->handle->record contract is identical to the cron path,
// so moving from cron to a worker requires ZERO change to the handler or the RPCs.
export async function runCalendarSyncWorkerLoop(deps: WorkerLoopDeps): Promise<BatchSummary> {
  const totals = emptySummary();
  let iterations = 0;
  while (!deps.shouldStop?.() && (deps.maxIterations === undefined || iterations < deps.maxIterations)) {
    const s = await runCalendarSyncCronBatch(deps);
    totals.claimed += s.claimed;
    totals.done += s.done;
    totals.retried += s.retried;
    totals.dead += s.dead;
    totals.timedOut = totals.timedOut || s.timedOut;
    for (const [code, n] of Object.entries(s.byCode)) totals.byCode[code] = (totals.byCode[code] ?? 0) + n;
    iterations += 1;
    if (s.claimed === 0) break; // drained
  }
  return totals;
}
