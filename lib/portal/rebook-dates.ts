// EMERG-PORTAL-REBOOK-01 — the one date step the rebooking card performs.
//
// WHY THIS IS A MODULE AND NOT A HELPER AT THE BOTTOM OF THE COMPONENT.
//
// The unit lane is `environment: "node"` with `include: ["tests/**/*.test.ts"]`,
// so a function living inside a `.tsx` can only be reached by source-regex
// assertions — which prove text, not behaviour. This one had TWO wrong answers
// that no amount of grepping would have caught, and both were only visible by
// running it. Lifting it here makes the actual rule executable, the same
// argument lib/booking/confirmation-presentation.ts makes for its copy builder.

/**
 * The next calendar day after a `YYYY-MM-DD` string, or null when the input is
 * not one.
 *
 * TOTAL BY CONSTRUCTION, because the previous inline version was not, and its
 * two failure modes pulled in opposite directions:
 *
 *   ""            -> "1900-01-02"
 *       `"".split("-").map(Number)` is `[0]`, so `y` is 0 and both `m` and `d`
 *       fall back to 1. `Date.UTC(0, 0, 2)` is not invalid — two-digit years map
 *       into the 1900s — so it produced a confident, silently wrong answer. The
 *       date input CAN be cleared, so this was the reachable one: pressing
 *       "Next available" with no date searched from 1900, which the server then
 *       clamped to today. A different question from the one the control asks.
 *
 *   "not-a-date"  -> threw RangeError from toISOString()
 *       Not reachable through `<input type="date">`, which yields "" or a
 *       well-formed value. But an exception on a client surface escapes to the
 *       route's error boundary, and a partial function is a crash waiting for
 *       its first other caller.
 *
 * Null makes "there is no next day to search from" a value the caller has to
 * handle, rather than a shape it can trip over.
 *
 * The shape check is deliberately stricter than `Date` parsing: it rejects
 * anything that is not exactly four-two-two digits, so a value that `Date`
 * would cheerfully coerce cannot slip through. Calendar overflow is then caught
 * by the NaN check rather than by re-implementing month lengths here.
 */
export function nextCalendarDay(dateStr: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  const [y, m, d] = dateStr.split("-").map(Number);

  // THE INPUT MUST BE A REAL CALENDAR DATE, and a shape check is not enough to
  // establish that. `Date.UTC` rolls over silently: month 13 becomes January of
  // the next year, 30 February becomes March, and — the trap that produced the
  // "1900" answer in the first place — a year below 100 is mapped into the
  // 1900s, so "0026-01-01" would come back as 1926. Round-tripping every
  // component is what rejects all three, and it does so without this function
  // re-implementing month lengths or leap rules.
  const asGiven = new Date(Date.UTC(y, m - 1, d));
  if (
    Number.isNaN(asGiven.getTime()) ||
    asGiven.getUTCFullYear() !== y ||
    asGiven.getUTCMonth() !== m - 1 ||
    asGiven.getUTCDate() !== d
  ) {
    return null;
  }

  // Rollover is DESIRED here, and only here: 31 October plus one day is 1
  // November. UTC has no DST, so a fixed 24 hours is exact.
  const next = new Date(asGiven.getTime() + 24 * 60 * 60 * 1000);
  if (Number.isNaN(next.getTime())) return null;
  return next.toISOString().slice(0, 10);
}
