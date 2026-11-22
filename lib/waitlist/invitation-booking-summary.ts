import { OUTCOME_DECLINED_LABEL, OUTCOME_EXPIRED_LABEL, OUTCOME_RELEASED_LABEL } from "@/lib/waitlist/invitation-history";

// THE INVITATION-TO-BOOKING SUMMARY. PURE: no I/O, no clock, nothing is sent or written.
//
// WHAT IT SAYS. For the invitations sent in ONE stated period, how many people were invited, how many invitations that was, and what became of them.
// Every figure is a count of invitations in that same period, so every figure has the same denominator: the number of invitations sent. There is no
// percentage on this page; where a figure is "of" something, the sentence says what.
//
// WHAT IT NEVER DOES. A number that could not be read is `null` and is shown as "Not available", never 0. Email opens and booking-page visits are not
// recorded anywhere, so they are always "Not tracked". A booking is counted only through the explicit link the booking command writes: a conversion with
// no link is shown as "Booking attribution unavailable" and is never counted as booked. The parts are never assumed to add up: anything left over is shown
// as "Other or not attributable", and a sum that exceeds its whole is reported as a count that moved while the page loaded, never as a negative.

/** The rolling reporting period, in whole days, counted back from now. The invitations SENT in it are the cohort. */
export const SUMMARY_PERIOD_DAYS = 30;

export const NOT_AVAILABLE = "Not available";
export const NOT_TRACKED = "Not tracked";
export const ATTRIBUTION_UNAVAILABLE = "Booking attribution unavailable";
export const OTHER_NOT_ATTRIBUTABLE = "Other or not attributable";

/** A count, or null when it could not be read. */
export type Count = number | null;

/** What the owner-only command returns (counts only), or null when the command is not there or failed. */
export type CommandCounts = {
  invitationsTotal: number;
  peopleInvited: number;
  bookedLinkedLive: number;
  bookedThenCancelled: number;
  convertedUnlinked: number;
};

/** One exact head count per outcome, under the same period filter. Each invitation falls in exactly ONE of these (same precedence as the history labels). */
export type OutcomeCounts = {
  /** Total invitations sent in the period, read directly (the fallback denominator while the command is unavailable). */
  total: Count;
  declined: Count;
  /** Link used: redeemed and not declined. */
  linkUsed: Count;
  /** Not declined, not used, with an expiry recorded. */
  expiredRecorded: Count;
  released: Count;
  /** No outcome, deadline still ahead. */
  open: Count;
  /** No outcome and the deadline has passed with no expiry recorded yet: shown as Expired. */
  deadlinePassed: Count;
};

export type SummaryInput = {
  /** The period's start instant (ISO). The period ends now. */
  periodStartIso: string;
  command: CommandCounts | null;
  outcomes: OutcomeCounts;
};

export type SummaryRow = {
  key: string;
  label: string;
  /** The count, or null for "Not available". */
  value: Count;
  /** A row that is never a count (email opens, page visits). */
  fixedText?: string;
  /** Nested under the row above it. */
  nested?: boolean;
  /** A short plain explanation shown under the row. */
  note?: string;
};

export type InvitationBookingSummary = {
  periodStartIso: string;
  /** The denominator every figure uses: invitations sent in the period. Null when it could not be read at all. */
  invitationsSent: Count;
  peopleInvited: Count;
  rows: SummaryRow[];
  /** Said when a part is larger than its whole, so a count moved while the page loaded. */
  inconsistent: boolean;
  /** True when the booking figures could not be read (the command is not available). */
  bookingUnavailable: boolean;
};

const sum = (...xs: Count[]): Count => (xs.some((x) => x === null) ? null : (xs as number[]).reduce((a, b) => a + b, 0));

/** Recorded expiry plus the deadline that has passed with none recorded: both are an expired invitation. Null when either part could not be read. */
export function expiredCount(o: OutcomeCounts): Count {
  return sum(o.expiredRecorded, o.deadlinePassed);
}

export function buildInvitationBookingSummary(input: SummaryInput): InvitationBookingSummary {
  const { command, outcomes: o } = input;
  // The denominator is the command's own count when it answered (one snapshot with the booking figures), else the direct head count.
  const sent: Count = command ? command.invitationsTotal : o.total;
  const expired = expiredCount(o);
  const bookingUnavailable = command === null;

  const rows: SummaryRow[] = [];
  let inconsistent = false;

  // Link used, with what is known about the booking behind it.
  rows.push({ key: "link-used", label: "Link used", value: o.linkUsed });
  const x = command ? command.bookedLinkedLive : null;
  const y = command ? command.bookedThenCancelled : null;
  const u = command ? command.convertedUnlinked : null;
  rows.push({ key: "booked", label: "Booked through this invitation, still booked", value: x, nested: true });
  rows.push({ key: "booked-cancelled", label: "Booked through this invitation, then cancelled", value: y, nested: true });
  rows.push({
    key: "attribution-unavailable",
    label: ATTRIBUTION_UNAVAILABLE,
    value: u,
    nested: true,
    note: "The invitation was used and the person was later booked, but no booking is recorded against this invitation, so it is not counted as booked.",
  });
  const known = sum(x, y, u);
  const rest = o.linkUsed === null || known === null ? null : o.linkUsed - known;
  if (rest !== null && rest < 0) inconsistent = true;
  rows.push({
    key: "link-used-other",
    label: OTHER_NOT_ATTRIBUTABLE,
    value: rest === null ? null : Math.max(0, rest),
    nested: true,
    note: "The link was used but no booking is recorded for it, or it cannot be attributed.",
  });

  rows.push({ key: "declined", label: OUTCOME_DECLINED_LABEL, value: o.declined });
  rows.push({ key: "expired", label: OUTCOME_EXPIRED_LABEL, value: expired });
  rows.push({ key: "released", label: OUTCOME_RELEASED_LABEL, value: o.released });
  rows.push({ key: "open", label: "Still open", value: o.open });

  const listed = sum(o.linkUsed, o.declined, expired, o.released, o.open);
  const left = sent === null || listed === null ? null : sent - listed;
  if (left !== null && left < 0) inconsistent = true;
  rows.push({
    key: "other",
    label: OTHER_NOT_ATTRIBUTABLE,
    value: left === null ? null : Math.max(0, left),
    note: "Invitations that match none of the outcomes above.",
  });

  rows.push({ key: "email-opens", label: "Email opens", value: null, fixedText: NOT_TRACKED });
  rows.push({ key: "page-visits", label: "Booking-page visits", value: null, fixedText: NOT_TRACKED });

  return {
    periodStartIso: input.periodStartIso,
    invitationsSent: sent,
    peopleInvited: command ? command.peopleInvited : null,
    rows,
    inconsistent,
    bookingUnavailable,
  };
}

/** The period's start: `days` whole days before `nowMs`. */
export function periodStart(nowMs: number, days: number = SUMMARY_PERIOD_DAYS): string {
  return new Date(nowMs - days * 86_400_000).toISOString();
}

/** The period in words, in the studio's time zone. */
export function periodLabel(startIso: string, timeZone: string): string {
  let when: string;
  try {
    when = new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric", year: "numeric" }).format(new Date(startIso));
  } catch {
    when = startIso.slice(0, 10);
  }
  return `Invitations sent in the last ${SUMMARY_PERIOD_DAYS} days (since ${when}, up to now)`;
}

/** The text for a count: the number, or "Not available". */
export function countText(n: Count): string {
  return n === null ? NOT_AVAILABLE : String(n);
}
