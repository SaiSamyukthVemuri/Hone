import "server-only";

// Google Calendar — Phase B2.1: the transport-neutral worker-core result model.
//
// A ClaimedJob is exactly the row shape returned by the deployed
// claim_calendar_sync_op RPC (migration 0124). handleCalendarSyncJob consumes a
// ClaimedJob and returns a JobResult — a CLOSED, machine-readable union. The
// reason code is a stable enum (never free text) so B2.3 reconciliation queries
// and the B2.3-c worker/health surfaces can key off structured state.
//
// Nothing here calls Google or touches appointments/outbox; it defines the
// vocabulary the later phases consume, plus the mapping from a result to the
// three record_calendar_sync_result outcomes (done / retry / dead).

// The claim_calendar_sync_op(p_batch_size) return row (0124).
export type ClaimedJob = {
  id: string;
  studioId: string;
  connectionId: string;
  opType: "event.create" | "event.update" | "event.delete" | "full.resync";
  honeEntityType: "appointment" | "timed_block" | null;
  honeEntityId: string | null;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  attempts: number;
  maxAttempts: number;
  claimToken: string;
  leaseExpiresAt: string;
  priority: number;
};

// The CLOSED set of outcome codes. Grouped by how they map to the queue:
//   ok*            -> record done  (a no-op is still a terminal success)
//   retry*         -> record retry (bounded backoff; retry_rate_limited carries Retry-After)
//   terminal*      -> record dead  (no further Google attempt is useful without operator/re-auth)
export type JobResultCode =
  // Success (terminal, records `done`)
  | "ok" // the Google operation was applied
  | "ok_noop_superseded" // stale sync_version, or the entity no longer holds the active link
  | "ok_noop_no_active_link" // no active calendar_event_links row for this entity
  | "ok_noop_tombstone_deleted" // appointment row gone; linked event deleted via link tombstone data
  // Retryable (records `retry` with bounded backoff)
  | "retry_transient" // 5xx / network / timeout / malformed body
  | "retry_rate_limited" // 429 / rateLimitExceeded (carries retryAfterSeconds)
  | "retry_ineligible" // claimed, then eligibility flipped before execution (modest backoff; Option A holds it thereafter)
  // Terminal failures (records `dead`)
  | "terminal_reconnect_required" // invalid_grant — connection needs re-auth
  | "terminal_insufficient_scope" // 403 insufficient scope — needs the calendar.events grant
  | "terminal_conflict" // 409 whose event carries a foreign honeLink (id collision)
  | "terminal_dead"; // exhausted / unrecoverable per the handler

const DONE_CODES = new Set<JobResultCode>([
  "ok",
  "ok_noop_superseded",
  "ok_noop_no_active_link",
  "ok_noop_tombstone_deleted",
]);
const RETRY_CODES = new Set<JobResultCode>([
  "retry_transient",
  "retry_rate_limited",
  "retry_ineligible",
]);
const DEAD_CODES = new Set<JobResultCode>([
  "terminal_reconnect_required",
  "terminal_insufficient_scope",
  "terminal_conflict",
  "terminal_dead",
]);

// The complete enum, for the exhaustiveness / closed-set test.
export const ALL_JOB_RESULT_CODES: readonly JobResultCode[] = [
  "ok",
  "ok_noop_superseded",
  "ok_noop_no_active_link",
  "ok_noop_tombstone_deleted",
  "retry_transient",
  "retry_rate_limited",
  "retry_ineligible",
  "terminal_reconnect_required",
  "terminal_insufficient_scope",
  "terminal_conflict",
  "terminal_dead",
];

export type JobResult = {
  code: JobResultCode;
  // A short, non-sensitive detail code for last_error_code (never PHI / tokens).
  errorCode?: string;
  // For retry_rate_limited (and any retry that carries an explicit hint): the
  // caller-supplied backoff, already bounded to [5, 21600] by the backoff helper.
  retryAfterSeconds?: number;
};

export function isDone(code: JobResultCode): boolean {
  return DONE_CODES.has(code);
}
export function isRetry(code: JobResultCode): boolean {
  return RETRY_CODES.has(code);
}
export function isDead(code: JobResultCode): boolean {
  return DEAD_CODES.has(code);
}

// The parameters for record_calendar_sync_result(p_id, p_claim_token, p_ok,
// p_error_code, p_error_message, p_retry_after_seconds). `retryAfterSeconds` is
// required for a retry (the RPC rejects null/out-of-range) and MUST already be
// bounded to [5, 21600] by the caller (computeBackoff guarantees this).
export type ResultRpcParams = {
  ok: boolean;
  errorCode: string | null;
  errorMessage: string | null;
  retryAfterSeconds: number | null;
};

export function resultToRpcParams(
  result: JobResult,
  fallbackBackoffSeconds: number,
): ResultRpcParams {
  if (isDone(result.code)) {
    // A success (including a no-op). Diagnostics are retained but not required.
    return {
      ok: true,
      errorCode: result.errorCode ? clampCode(result.errorCode) : null,
      errorMessage: null, // never a message on success (no PHI, no noise)
      retryAfterSeconds: null,
    };
  }
  if (isRetry(result.code)) {
    const backoff = boundBackoff(result.retryAfterSeconds ?? fallbackBackoffSeconds);
    return {
      ok: false,
      errorCode: clampCode(result.errorCode ?? result.code),
      errorMessage: null,
      retryAfterSeconds: backoff,
    };
  }
  // Dead: the RPC marks it dead once attempts are exhausted; to force an
  // immediate terminal outcome the worker sets attempts=max before recording,
  // OR records a retry that the RPC converts to dead at the cap. We express a
  // terminal result as a retry at the MAX backoff carrying the terminal code, so
  // a still-recoverable-after-reconnect connection is not permanently killed by a
  // transient blip; a genuinely dead row reaches the cap and the RPC deads it.
  // (B2.3-c refines terminal handling; the mapping is defined here.)
  return {
    ok: false,
    errorCode: clampCode(result.errorCode ?? result.code),
    errorMessage: null,
    retryAfterSeconds: boundBackoff(result.retryAfterSeconds ?? 21600),
  };
}

const MIN_BACKOFF = 5;
const MAX_BACKOFF = 21600;
function boundBackoff(n: number): number {
  if (!Number.isFinite(n)) return MAX_BACKOFF;
  return Math.min(MAX_BACKOFF, Math.max(MIN_BACKOFF, Math.round(n)));
}
function clampCode(code: string): string {
  // last_error_code is capped at 500 by the RPC; keep our codes short + safe.
  return code.slice(0, 64);
}
