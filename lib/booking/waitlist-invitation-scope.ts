// WAIT-03B B2 — scope enforcement for a scoped waitlist invitation.
//
// WHY THIS FILE IS THE ONLY ENFORCEMENT: no accepted B1/B1.5c command evaluates
// a weekday, a date or a service against a REQUESTED appointment. `redeem_...
// _verified` takes only a token and a capability -- it never sees which slot the
// recipient picked, so it cannot possibly police scope. The database owns
// admission, tenancy, recipient proof and lifecycle; the requested-slot half of
// the offer is enforced here and nowhere else.
//
// That makes this module load-bearing rather than convenience, so it is pure:
// no I/O, no clock of its own, every input passed in. It is called BEFORE the
// invitation is consumed.

/** `extract(dow)` convention, matching B1's CHECK: 0 = Sunday .. 6 = Saturday. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export type InvitationScope = {
  serviceId: string;
  /** Studio-local calendar dates, inclusive on both ends. */
  startDate: string;
  endDate: string;
  /** null means "every day inside the range" -- B1's documented NULL semantics. */
  allowedWeekdays: readonly number[] | null;
};

export type ScopeRefusal =
  | "service_not_in_scope"
  | "date_before_scope"
  | "date_after_scope"
  | "weekday_not_in_scope"
  | "unreadable_scope";

export type ScopeDecision =
  | { ok: true; localDate: string; weekday: number }
  | { ok: false; reason: ScopeRefusal };

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Gregorian leap rule, in full: every 4, except every 100, except every 400. */
function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/**
 * A REAL calendar date in `YYYY-MM-DD`, not merely a string shaped like one.
 *
 * The shape alone was a FAIL-OPEN in the one authority that decides whether a
 * requested slot is inside the offer. "2026-00-01" passed it, and every later
 * comparison here is LEXICAL -- "2026-06-15" > "2026-00-01" is true -- so an
 * unreadable scope silently authorised an ordinary 2026 request. An offer whose
 * own window cannot be read must authorise nothing.
 *
 * Deliberately arithmetic, not `Date.parse`: that normalises Feb 30 into March 2
 * and would call the impossible date real. This module is pure by contract -- no
 * clock, no I/O, every input passed in -- so the calendar is checked with a
 * month table and the Gregorian leap rule rather than by constructing a Date.
 */
function isRealCalendarDate(value: string | null | undefined): boolean {
  if (typeof value !== "string") return false;
  const m = YMD.exec(value);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  // THERE IS NO YEAR ZERO. The Gregorian calendar this contract uses runs
  // 1 BC -> AD 1, and PostgreSQL's date type refuses 0000 for the same reason.
  // "0000-01-01" passed the month and day rules while naming a date that has
  // never existed -- and because every comparison in this module is lexical, it
  // sorted BEFORE any real date, so an impossible lower bound authorised
  // everything after it.
  if (year < 1) return false;
  if (month < 1 || month > 12) return false;
  if (day < 1) return false;
  return day <= daysInMonth(year, month);
}

/**
 * Decide whether a requested (service, instant) falls inside an invitation's
 * offer, evaluated in the STUDIO's timezone.
 *
 * The timezone matters and is not cosmetic: an instant late on a Sunday evening
 * UTC is still Sunday in Toronto but already Monday in Berlin. Scope dates and
 * weekdays are studio-local, so the instant must be projected into the studio's
 * zone before either is tested -- otherwise an offer for "Mondays only" would
 * admit a Sunday booking for studios east of UTC.
 */
export function evaluateInvitationScope(args: {
  scope: InvitationScope;
  requestedServiceId: string;
  /** The requested appointment start, as an absolute instant. */
  requestedStartsAt: Date;
  studioTimezone: string;
  /** Injected so this module keeps no clock and stays pure. */
  localDateString: (d: Date, tz: string) => string;
  localDayOfWeek: (d: Date, tz: string) => number;
}): ScopeDecision {
  const { scope, requestedServiceId, requestedStartsAt, studioTimezone } = args;

  // A scope we cannot read is never treated as permissive. An unscoped or
  // malformed offer refuses rather than defaulting to "any service, any day".
  if (
    typeof scope.serviceId !== "string" ||
    scope.serviceId.length === 0 ||
    !isRealCalendarDate(scope.startDate) ||
    !isRealCalendarDate(scope.endDate) ||
    scope.startDate > scope.endDate ||
    !(requestedStartsAt instanceof Date) ||
    Number.isNaN(requestedStartsAt.getTime()) ||
    typeof studioTimezone !== "string" ||
    studioTimezone.length === 0
  ) {
    return { ok: false, reason: "unreadable_scope" };
  }

  // An empty weekday array authorises NOTHING. Only NULL means "every day":
  // B1's CHECK requires 1..7 entries when the column is non-null, so an empty
  // array cannot arise through the supported path -- and if one ever did, it
  // must fail closed rather than read as "unrestricted".
  const weekdays = scope.allowedWeekdays;
  if (weekdays !== null && weekdays !== undefined) {
    if (!Array.isArray(weekdays) || weekdays.length === 0) {
      return { ok: false, reason: "unreadable_scope" };
    }
    if (weekdays.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
      return { ok: false, reason: "unreadable_scope" };
    }
  }

  if (requestedServiceId !== scope.serviceId) {
    return { ok: false, reason: "service_not_in_scope" };
  }

  const localDate = args.localDateString(requestedStartsAt, studioTimezone);
  if (localDate < scope.startDate) return { ok: false, reason: "date_before_scope" };
  if (localDate > scope.endDate) return { ok: false, reason: "date_after_scope" };

  const weekday = args.localDayOfWeek(requestedStartsAt, studioTimezone);
  if (weekdays !== null && weekdays !== undefined && !weekdays.includes(weekday)) {
    return { ok: false, reason: "weekday_not_in_scope" };
  }

  return { ok: true, localDate, weekday };
}
