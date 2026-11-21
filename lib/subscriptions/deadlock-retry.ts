// Bounded retry for a Postgres deadlock (SQLSTATE 40P01), plus the one stable
// message a person sees if it still fails.
//
// WHY THIS EXISTS (HON-70, DB-DESIGN.md section 3.3; Team ACK, option 1): the
// seat triggers take the studios lock from a BEFORE ROW trigger, which fires
// after the caller's row lock. An accept that REACTIVATES practitioner P can
// interleave with the owner's set-active of that same P, and either side can be
// chosen as the deadlock victim. Postgres aborts the victim's whole transaction,
// so nothing it did persists and the seat limit is never exceeded; the caller
// only sees an error, and re-running the same command is the right response.
//
// USED ON BOTH SIDES OF THE RACE: the accept action AND the owner's set-active
// (removal / reactivation) action. Team owns those call sites and reviews the
// minimal change that adopts this wrapper; it is not wired here.
//
// RULES (pinned by tests/lib/subscriptions/deadlock-retry.test.ts):
//   * ONLY 40P01. Never 40001 (serialization), 55P03 (lock timeout), P0001
//     (practitioner_limit_reached) or anything else: those are real answers.
//   * AT MOST TWO retries (three attempts). The cap is hard: a larger request is
//     clamped. The last result is returned unchanged.
//   * Short, growing backoff with jitter (about 25-75 ms, then 75-150 ms).
//   * Wrap exactly ONE database command (one RPC = one transaction). Wrapping a
//     multi-step action would repeat steps that already committed.
//   * NOTHING outside the transaction (email, SMS, Stripe, analytics) may run
//     before the command COMMITS. Send those only after the wrapper returns a
//     success, or a retry would repeat a side effect that cannot be undone.
//   * No data is logged: the hook receives only the retry number.
//   * No SQLSTATE or database text reaches the user. Use userMessageForDeadlock.

export const DEADLOCK_SQLSTATE = "40P01";

/** The ONLY text a person sees when a command is still deadlocked after retrying. */
export const TRY_AGAIN_MESSAGE = "That took longer than expected. Please try again.";

export const MAX_DEADLOCK_RETRIES = 2;

/** True only for a Postgres deadlock-detected error (PostgREST puts SQLSTATE in `code`). */
export function isDeadlock(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === DEADLOCK_SQLSTATE
  );
}

/** The stable message for a deadlock, or null for any other error. */
export function userMessageForDeadlock(error: unknown): string | null {
  return isDeadlock(error) ? TRY_AGAIN_MESSAGE : null;
}

export interface DeadlockRetryOptions {
  /** Retries after the first attempt. Clamped to 0..MAX_DEADLOCK_RETRIES. Default 2. */
  maxRetries?: number;
  /** Pause before retry number `retry` (1-based). Default: jittered 25-75 ms, then 75-150 ms. */
  sleep?: (retry: number) => Promise<void>;
  /** Called before each retry with its number and nothing else. */
  onRetry?: (retry: number) => void;
}

function retriesFrom(options: DeadlockRetryOptions): number {
  const n = options.maxRetries ?? MAX_DEADLOCK_RETRIES;
  if (!Number.isFinite(n)) return MAX_DEADLOCK_RETRIES;
  return Math.max(0, Math.min(MAX_DEADLOCK_RETRIES, Math.floor(n)));
}

const defaultSleep = (retry: number) => {
  const base = retry === 1 ? 25 : 75;
  const ms = base + Math.floor(Math.random() * (retry === 1 ? 50 : 75));
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
};

/**
 * For supabase-js style calls that RESOLVE to `{ data, error }`.
 * Returns the first result unless its error is a deadlock; then re-runs the
 * command, up to the cap, and returns the last result.
 */
export async function retryOnDeadlock<R extends { error: unknown }>(
  command: () => PromiseLike<R>,
  options: DeadlockRetryOptions = {},
): Promise<R> {
  const max = retriesFrom(options);
  let result = await command();
  for (let retry = 1; retry <= max && isDeadlock(result.error); retry++) {
    options.onRetry?.(retry);
    await (options.sleep ?? defaultSleep)(retry);
    result = await command();
  }
  return result;
}

/** For calls that THROW (a direct pg client). Same rules. */
export async function retryThrownDeadlock<T>(
  command: () => PromiseLike<T>,
  options: DeadlockRetryOptions = {},
): Promise<T> {
  const max = retriesFrom(options);
  for (let retry = 1; ; retry++) {
    try {
      return await command();
    } catch (err) {
      if (retry > max || !isDeadlock(err)) throw err;
      options.onRetry?.(retry);
      await (options.sleep ?? defaultSleep)(retry);
    }
  }
}
