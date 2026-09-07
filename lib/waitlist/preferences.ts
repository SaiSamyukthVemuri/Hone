// ===========================================================================
// WAIT-ADMIT-01 — PROSPECT PREFERENCE VOCABULARY
// ===========================================================================
//
// The vocabulary a studio uses to describe WHEN a waiting prospect can attend,
// and the compatibility rules over it. Pure: no I/O, no clock, no database, no
// `server-only` — the operator UI renders these labels and the ranking engine
// consumes the same values, so one definition serves both.
//
// ---------------------------------------------------------------------------
// "NOT STATED" IS A VALUE, NOT A ZERO
// ---------------------------------------------------------------------------
//
// Most of the people this feature must rank were never asked. They joined
// through a form that had no availability question, or they arrive by a legacy
// import from an email inbox. Modelling that as `weekdays: false, weekends:
// false` would be a fabrication that reads as a real answer, and every ranking
// downstream would silently act on it.
//
// So availability is a DISCRIMINATED UNION, not a nullable enum with a default.
// `{ stated: false }` cannot be confused with an expressed preference, cannot
// be compared for compatibility, and forces every caller to decide what to do
// about it. The scoring policy decides — see UnknownFactorPolicy in ./scoring.
//
// NOTHING HERE INFERS A PREFERENCE. Not from a phone area code, not from when
// someone submitted the form, not from a past appointment. An inferred
// preference is indistinguishable from a stated one once written down, and the
// person is the only authority on their own availability.
// ===========================================================================

/** What a prospect told the studio about the days they can attend. */
export type AvailabilityPreference = "weekdays" | "weekends" | "both";

/** The canonical vocabulary, in the order an operator UI should offer it. */
export const AVAILABILITY_PREFERENCES: readonly AvailabilityPreference[] = [
  "weekdays",
  "weekends",
  "both",
] as const;

/** Operator- and prospect-facing labels. One definition, reused everywhere. */
export const AVAILABILITY_PREFERENCE_LABELS: Readonly<
  Record<AvailabilityPreference, string>
> = {
  weekdays: "Weekdays",
  weekends: "Weekends",
  both: "Weekdays or weekends",
};

/**
 * A calendar day reduced to the only distinction this vocabulary makes.
 *
 * Saturday and Sunday are the weekend. This is a DELIBERATE simplification of
 * a genuinely cultural question, and it is stated here rather than scattered:
 * a studio whose weekend is Friday/Saturday is not served correctly by this
 * vocabulary, and extending it is a schema question (a per-studio weekend
 * definition), not something to paper over with a heuristic here.
 */
export type DayClass = "weekday" | "weekend";

/**
 * Availability as the ranking engine receives it.
 *
 * `stated: false` carries no preference field at all, so there is no value to
 * accidentally read. TypeScript refuses `candidate.availability.preference`
 * until the caller has narrowed on `stated`.
 */
export type CandidateAvailability =
  | { readonly stated: true; readonly preference: AvailabilityPreference }
  | { readonly stated: false };

/** The one way to construct a stated preference. */
export function statedAvailability(
  preference: AvailabilityPreference,
): CandidateAvailability {
  return { stated: true, preference };
}

/** The one way to represent "we never asked, and we will not guess". */
export const UNSTATED_AVAILABILITY: CandidateAvailability = { stated: false };

/** JS `Date#getDay()` semantics: 0 = Sunday, 6 = Saturday. */
export function dayClassOfWeekday(dayOfWeek: number): DayClass | null {
  if (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) return null;
  return dayOfWeek === 0 || dayOfWeek === 6 ? "weekend" : "weekday";
}

/**
 * Parse an untrusted string into the vocabulary.
 *
 * Accepts only exact members after trim + lowercase. Returns null for anything
 * else — including the empty string, "any", "flexible" and "n/a", all of which
 * a human might reasonably type and none of which this module is entitled to
 * translate into a stated preference.
 */
export function parseAvailabilityPreference(
  raw: unknown,
): AvailabilityPreference | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim().toLowerCase();
  return (AVAILABILITY_PREFERENCES as readonly string[]).includes(value)
    ? (value as AvailabilityPreference)
    : null;
}

/**
 * Can a prospect with this stated preference attend on this class of day?
 *
 * Total over the vocabulary, and deliberately NOT defined for the unstated
 * case: the caller must narrow first, which is what stops "unknown" from
 * quietly becoming "no".
 */
export function preferenceCoversDayClass(
  preference: AvailabilityPreference,
  dayClass: DayClass,
): boolean {
  if (preference === "both") return true;
  return preference === "weekdays"
    ? dayClass === "weekday"
    : dayClass === "weekend";
}

/**
 * The day classes a stated preference covers, as a set.
 *
 * Useful when the question is "which of the openings we actually have could
 * this person take?" rather than "could they take this specific one?".
 */
export function coveredDayClasses(
  preference: AvailabilityPreference,
): readonly DayClass[] {
  if (preference === "both") return ["weekday", "weekend"];
  return preference === "weekdays" ? ["weekday"] : ["weekend"];
}
