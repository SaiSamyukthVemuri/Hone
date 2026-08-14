import "server-only";

// Google Calendar: Phase B2.1: the single reusable bounded backoff helper.
//
// Exponential backoff with FULL jitter, honoring a server-supplied Retry-After
// when present, clamped to the outbox contract's [5, 21600] seconds. Both the
// randomness and the clock are injectable so tests are deterministic. There is
// NO backoff for terminal auth errors: the caller simply does not call this for
// a terminal result.

export const MIN_BACKOFF_SECONDS = 5;
export const MAX_BACKOFF_SECONDS = 21600; // 6 hours (matches record_calendar_sync_result)

// Base for the exponential curve. attempts=1 -> ~30s window, doubling thereafter,
// capped at MAX. With full jitter the actual value is uniform in [MIN, window].
const BASE_SECONDS = 30;

export type BackoffInput = {
  attempts: number; // the job's attempts count AFTER this claim (>= 1)
  retryAfterSeconds?: number | null; // server hint (429/503); when set, it wins (bounded)
  rng?: () => number; // injectable uniform [0,1); defaults to Math.random
};

// Returns a whole number of seconds in [5, 21600].
export function computeBackoff(input: BackoffInput): number {
  // A server Retry-After is authoritative: respect it, only bounded.
  if (typeof input.retryAfterSeconds === "number" && Number.isFinite(input.retryAfterSeconds)) {
    return bound(input.retryAfterSeconds);
  }
  const attempts = Math.max(1, Math.floor(input.attempts));
  // Exponential window, capped BEFORE jitter so jitter never overshoots MAX.
  const rawWindow = BASE_SECONDS * Math.pow(2, attempts - 1);
  const window = Math.min(MAX_BACKOFF_SECONDS, rawWindow);
  const rand = input.rng ? input.rng() : Math.random();
  const r = Number.isFinite(rand) ? Math.min(0.999999, Math.max(0, rand)) : 0;
  // Full jitter in [0, window], then floored to the MIN.
  const jittered = window * r;
  return bound(jittered);
}

function bound(n: number): number {
  if (!Number.isFinite(n)) return MAX_BACKOFF_SECONDS;
  const rounded = Math.round(n);
  return Math.min(MAX_BACKOFF_SECONDS, Math.max(MIN_BACKOFF_SECONDS, rounded));
}
