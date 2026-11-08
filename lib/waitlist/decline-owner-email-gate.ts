// The owner email on a waitlist decline (HON-7 item 4) is OFF until an explicit enabling input exists.
//
// Both inputs are required, and either one missing or malformed fails closed:
//   HONE_WAITLIST_DECLINE_OWNER_EMAIL_ENABLED === "true"   (exact; "TRUE", "1", "yes", whitespace all fail)
//   HONE_WAITLIST_DECLINE_OWNER_EMAIL_SINCE   an ISO instant; outbox rows created BEFORE it are never claimed.
//
// The second input is how "held rows are never sent on activation" is enforced. Rows are created held while the flag is off (the
// decline transaction inserts them regardless), so without a cutoff the first sweep after switching on would mail every decline
// that happened while the feature was dark. Set SINCE to the moment of activation.
export function declineOwnerEmailActivation(): { enabled: false } | { enabled: true; since: Date } {
  if (process.env.HONE_WAITLIST_DECLINE_OWNER_EMAIL_ENABLED !== "true") return { enabled: false };
  const raw = process.env.HONE_WAITLIST_DECLINE_OWNER_EMAIL_SINCE;
  if (!raw || !/^\d{4}-\d{2}-\d{2}T/.test(raw)) return { enabled: false };
  const since = new Date(raw);
  if (Number.isNaN(since.getTime())) return { enabled: false };
  return { enabled: true, since };
}

// Retention of outbox rows is undecided (Sam, HON-7). The purge period lives in this one constant and nothing deletes with it yet.
export const DECLINE_OWNER_EMAIL_PURGE_DAYS = 90;

/**
 * The reviewed retry budget: at most this many attempts, all within the window below of the row's creation. After either limit the row is
 * `failed` and is only shown in Hone. Both are counted from the row, never from cron ticks, so the backstop behaves the same at any cadence.
 */
export const DECLINE_OWNER_EMAIL_MAX_ATTEMPTS = 3;
// 23, not 24: the provider honours an idempotency key for about 24 hours, so an attempt at the very edge of a 24-hour window could fall outside
// it and be delivered a second time. The last attempt must stay inside the key's life.
export const DECLINE_OWNER_EMAIL_RETRY_WINDOW_HOURS = 23;

/**
 * One sweep keeps claiming batches until nothing eligible remains or this budget is spent. The cron route declares maxDuration = 60 (the most
 * a Hobby serverless function may run), and one row can take up to ~30s in the worst case (a 15s provider timeout, retried once under the same key),
 * so the budget is 60 - 30 - margin = 25s: a row started just inside it still finishes before the platform cuts the function. A row cut anyway is left
 * `sending`, reclaimed after the stale window under the same provider key. Rows left when the budget ends are reported as `remaining`, never dropped.
 */
export const DECLINE_OWNER_EMAIL_SWEEP_BUDGET_MS = 25_000;
export const DECLINE_OWNER_EMAIL_ROUTE_MAX_DURATION_SECONDS = 60;
export const DECLINE_OWNER_EMAIL_BATCH_SIZE = 50;

/** A row left in `sending` longer than this was abandoned by a dead invocation and may be claimed again. */
export const DECLINE_OWNER_EMAIL_STALE_CLAIM_MINUTES = 10;
