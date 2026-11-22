import { invitationExpiryLabel } from "@/lib/waitlist/invitation-deadline";

// DISPLAY ONLY. The database owns `expires_at`; nothing here computes, extends or writes an expiry, and nothing here decides
// whether an invitation is live. Callers pass the expiry of the LIVE invitation the page already read.
//
// "Time remaining" is a reading at the instant the page was rendered, not a countdown.

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export const EXPIRING_SOON_WINDOW_MS = DAY_MS;

/** The parsed instant, or null when the value is not a readable date. Unreadable input never becomes "now" or a number. */
export function parseExpiry(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** "2 days 3 h", "5 h 10 min", "12 min", "under 1 min". A deadline at or before `nowMs` has no remaining time: null. */
export function timeRemainingLabel(expiresMs: number, nowMs: number): string | null {
  const left = expiresMs - nowMs;
  if (!(left > 0)) return null;
  if (left < MINUTE_MS) return "under 1 min";
  if (left >= DAY_MS) {
    const days = Math.floor(left / DAY_MS);
    const hours = Math.floor((left % DAY_MS) / HOUR_MS);
    return `${days} ${days === 1 ? "day" : "days"}${hours > 0 ? ` ${hours} h` : ""}`;
  }
  const hours = Math.floor(left / HOUR_MS);
  const minutes = Math.floor((left % HOUR_MS) / MINUTE_MS);
  if (hours === 0) return `${minutes} min`;
  return `${hours} h${minutes > 0 ? ` ${minutes} min` : ""}`;
}

export type RowExpiry =
  | { kind: "open"; label: string; remaining: string }
  | { kind: "deadline_passed"; label: string };

/** One invitation's line: the exact deadline in the studio's zone, and what is left or that it has passed. Null when unreadable. */
export function rowExpiry(expiresAt: unknown, timeZone: string | null | undefined, nowMs: number): RowExpiry | null {
  const ms = parseExpiry(expiresAt);
  if (ms === null) return null;
  const label = invitationExpiryLabel(new Date(ms), timeZone);
  const remaining = timeRemainingLabel(ms, nowMs);
  return remaining === null ? { kind: "deadline_passed", label } : { kind: "open", label, remaining };
}

export type ExpirySummary = {
  /** The soonest deadline that has NOT passed, or null when none is open. */
  next: { label: string; remaining: string } | null;
  /** Open invitations whose deadline falls within the next 24 hours (inclusive of exactly 24 h). */
  withinDay: number;
  /** Open invitations counted. A passed deadline is not "about to expire". */
  open: number;
};

export function expirySummary(
  expiries: ReadonlyArray<unknown>,
  timeZone: string | null | undefined,
  nowMs: number,
): ExpirySummary {
  let next: number | null = null;
  let withinDay = 0;
  let open = 0;
  for (const value of expiries) {
    const ms = parseExpiry(value);
    if (ms === null || !(ms > nowMs)) continue;
    open += 1;
    if (ms - nowMs <= EXPIRING_SOON_WINDOW_MS) withinDay += 1;
    if (next === null || ms < next) next = ms;
  }
  return {
    next:
      next === null
        ? null
        : {
            label: invitationExpiryLabel(new Date(next), timeZone),
            remaining: timeRemainingLabel(next, nowMs) as string,
          },
    withinDay,
    open,
  };
}

/** The one summary sentence. Null when nothing is open (no line is rendered). */
export function summaryText(s: ExpirySummary): string | null {
  if (s.next === null) return null;
  const within = s.withinDay === 1 ? "1 expires" : `${s.withinDay} expire`;
  return `Next invitation expires ${s.next.label}, in ${s.next.remaining}. ${within} within 24 hours.`;
}
