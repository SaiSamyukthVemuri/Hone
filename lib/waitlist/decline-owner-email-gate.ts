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
export const DECLINE_OWNER_EMAIL_RETRY_WINDOW_HOURS = 24;

/** A row left in `sending` longer than this was abandoned by a dead invocation and may be claimed again. */
export const DECLINE_OWNER_EMAIL_STALE_CLAIM_MINUTES = 10;
