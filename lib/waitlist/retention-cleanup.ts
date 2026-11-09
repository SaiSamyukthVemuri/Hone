import { dbErrorCode, thrownErrorClass } from "@/lib/logging/error-class";

// 0326: the scheduled erase of overdue waitlist decline answers (and the purge of the ids-and-dates erase log, the owner-email outbox and old run
// rows). The database function does the work in one transaction per call and RAISES on failure, so a failed call changed nothing. This loop calls
// it in bounded batches and reports COUNTS ONLY: nothing here reads, returns or logs an answer, a name or an id.

export const RETENTION_BATCH_SIZE = 500;
/** At most this many database calls per tick (the contract's ceiling is about 20). */
export const RETENTION_MAX_CALLS = 20;
/** No NEW call is started after this long; one call is a single bounded transaction. The route runs this beside the owner-email sweep inside a 60 s cap. */
export const RETENTION_TICK_BUDGET_MS = 12_000;

export type RetentionCounts = {
  erasedAnswers: number;
  /** Answers whose erase failed and were skipped; the database retries them next run (outcome partial_failure). */
  failedAnswers: number;
  purgedEraseRecords: number;
  purgedOutbox: number;
  purgedRuns: number;
  remainingAnswers: number;
  remainingEraseRecords: number;
  remainingOutbox: number;
};

export type RetentionErrorClass = "exception" | "timeout" | "route_error" | "unknown";

export type RetentionTick =
  | { ok: true; calls: number; counts: RetentionCounts; remaining: number; stoppedEarly: boolean; partialFailure: boolean }
  | { ok: true; skipped: "not_installed" }
  | { ok: false; calls: number; counts: RetentionCounts; errorClass: RetentionErrorClass; failureRecorded: boolean };

/** The part of the admin client this module uses, so a test can supply a fake. */
export type RetentionRpcClient = {
  rpc: (fn: string, args?: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { code?: string } | null }>;
};

export const ZERO_RETENTION_COUNTS: RetentionCounts = {
  erasedAnswers: 0,
  failedAnswers: 0,
  purgedEraseRecords: 0,
  purgedOutbox: 0,
  purgedRuns: 0,
  remainingAnswers: 0,
  remainingEraseRecords: 0,
  remainingOutbox: 0,
};

const FUNCTION_MISSING = new Set(["PGRST202", "42883"]);
// statement_timeout (query cancelled) and lock_not_available (the contract sets a lock timeout)
const TIMEOUT_CODES = new Set(["57014", "55P03"]);

const count = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);

function readRow(data: unknown): (RetentionCounts & { outcome: string }) | null {
  const row = Array.isArray(data) ? data[0] : data;
  if (typeof row !== "object" || row === null) return null;
  const r = row as Record<string, unknown>;
  const parsed = {
    erasedAnswers: count(r.erased_answers),
    failedAnswers: count(r.failed_answers),
    purgedEraseRecords: count(r.purged_erase_records),
    purgedOutbox: count(r.purged_outbox),
    purgedRuns: count(r.purged_runs),
    remainingAnswers: count(r.remaining_answers),
    remainingEraseRecords: count(r.remaining_erase_records),
    remainingOutbox: count(r.remaining_outbox),
  };
  if (Object.values(parsed).some((v) => v === null)) return null;
  // the contract's two outcomes; a failed_answers count and the outcome must agree
  if (r.outcome !== "success" && r.outcome !== "partial_failure") return null;
  if ((r.outcome === "partial_failure") !== ((parsed.failedAnswers as number) > 0)) return null;
  return { ...(parsed as RetentionCounts), outcome: r.outcome };
}

export const remainingTotal = (c: RetentionCounts) => c.remainingAnswers + c.remainingEraseRecords + c.remainingOutbox;

/** Failure classes the contract accepts. A database error is a timeout only for the closed code list; a throw uses the shared thrown-error class. */
export function classifyRetentionFailure(error: unknown, thrown: boolean): RetentionErrorClass {
  if (thrown) {
    const c = thrownErrorClass(error);
    return c === "timeout" || c === "abort" ? "timeout" : "exception";
  }
  return TIMEOUT_CODES.has(dbErrorCode(error)) ? "timeout" : "exception";
}

async function recordFailure(admin: RetentionRpcClient, errorClass: RetentionErrorClass): Promise<boolean> {
  try {
    const { error } = await admin.rpc("record_waitlist_retention_failure", { p_error_class: errorClass });
    return !error;
  } catch {
    return false;
  }
}

/**
 * One tick: call the cleanup until nothing remains, the call ceiling or the time budget is reached, or it fails. A failure is recorded in the
 * database (a separate call, because the failed call rolled back) by CLASS only. Never throws.
 */
export async function runRetentionCleanup(
  admin: RetentionRpcClient,
  opts: { batchSize?: number; maxCalls?: number; budgetMs?: number; now?: () => number } = {},
): Promise<RetentionTick> {
  const batchSize = opts.batchSize ?? RETENTION_BATCH_SIZE;
  const maxCalls = opts.maxCalls ?? RETENTION_MAX_CALLS;
  const budgetMs = opts.budgetMs ?? RETENTION_TICK_BUDGET_MS;
  const now = opts.now ?? Date.now;
  const started = now();
  const total: RetentionCounts = { ...ZERO_RETENTION_COUNTS };
  let calls = 0;

  const fail = async (errorClass: RetentionErrorClass): Promise<RetentionTick> => ({
    ok: false,
    calls,
    counts: { ...total },
    errorClass,
    failureRecorded: await recordFailure(admin, errorClass),
  });

  while (calls < maxCalls && (calls === 0 || now() - started < budgetMs)) {
    calls += 1;
    let res: { data: unknown; error: { code?: string } | null };
    try {
      res = await admin.rpc("run_waitlist_retention_cleanup", { p_batch_size: batchSize });
    } catch (e) {
      return fail(classifyRetentionFailure(e, true));
    }
    if (res.error) {
      // Before 0326 is applied the function does not exist: not a failure of a job that is not installed yet.
      if (calls === 1 && FUNCTION_MISSING.has(dbErrorCode(res.error))) return { ok: true, skipped: "not_installed" };
      return fail(classifyRetentionFailure(res.error, false));
    }
    const got = readRow(res.data);
    if (!got) return fail("unknown");
    total.erasedAnswers += got.erasedAnswers;
    total.failedAnswers += got.failedAnswers;
    total.purgedEraseRecords += got.purgedEraseRecords;
    total.purgedOutbox += got.purgedOutbox;
    total.purgedRuns += got.purgedRuns;
    // remaining_* describe the state AFTER this call, so the last call's values are the answer
    total.remainingAnswers = got.remainingAnswers;
    total.remainingEraseRecords = got.remainingEraseRecords;
    total.remainingOutbox = got.remainingOutbox;
    if (remainingTotal(got) === 0) break;
    // A call that erased and purged nothing while rows remain is stuck on rows it skips (they fail every time); calling again only repeats it.
    if (got.erasedAnswers + got.purgedEraseRecords + got.purgedOutbox + got.purgedRuns === 0) break;
  }
  const remaining = remainingTotal(total);
  return { ok: true, calls, counts: total, remaining, stoppedEarly: remaining > 0, partialFailure: total.failedAnswers > 0 };
}
