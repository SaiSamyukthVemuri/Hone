/**
 * VALIDATED EVIDENCE — the single place invalid comparison operands are refused.
 *
 * THE DEFECT CLASS THIS EXISTS TO END. Five separate repairs on this branch each
 * validated one operand at one boundary, and the next review found the next
 * unguarded one: the preference stamps but not the clock; then the ranking
 * clock; then the staleness cap; then the import instant; then the exported
 * classifier the wrapper called. The census that followed found a sixth
 * (`applyConfirmation`) before anyone reported it.
 *
 * Three things composed to make that inevitable:
 *
 *   A. `Date` is inhabited by Invalid Date and `number` by NaN and ±Infinity,
 *      so an invalid operand stayed REPRESENTABLE no matter what any wrapper
 *      checked;
 *   B. validation ownership was spread across five partial owners, none
 *      authoritative, so "is this operand guarded?" had no single answer;
 *   C. the raw classifiers were exported, so the wrapper that validated was
 *      never the only door.
 *
 * THE FIX IS TO MAKE THE INVALID VALUE UNREPRESENTABLE PAST CONSTRUCTION rather
 * than to add a sixth check. Both branded types below can only be obtained from
 * their constructor, and every comparison-bearing signature consumes the branded
 * type. There is then nothing to validate at each boundary, because an invalid
 * operand cannot occupy a parameter position. Ownership is TWO constructors, by
 * construction rather than by discipline.
 *
 * THE HONEST LIMIT, STATED HERE RATHER THAN DISCOVERED LATER. Branding is a
 * compile-time device: a `as ValidInstant` cast, or a caller compiled from
 * JavaScript, defeats it. That is precisely why the runtime refusal lives in the
 * constructors — the type system's job is to make FORGETTING impossible, not to
 * enforce at runtime. The census guard in
 * tests/lib/waitlist/exported-boundary-census.test.ts is what keeps a new
 * comparison-bearing export from quietly taking a raw operand again.
 */

declare const VALID_INSTANT: unique symbol;
declare const VALID_STALENESS: unique symbol;

/**
 * An instant that is known to be readable.
 *
 * Still a `Date` at runtime, so it formats, compares and serialises exactly as
 * before — but one whose `getTime()` is guaranteed finite, because `instant()`
 * is the only way to obtain the brand.
 */
export type ValidInstant = Date & { readonly [VALID_INSTANT]: true };

/** A staleness policy whose cap can express an age limit. */
export type ValidStalenessPolicy = {
  readonly maxAgeDays: number | null;
} & { readonly [VALID_STALENESS]: true };

/**
 * A policy the COMPILER can see is disabled.
 *
 * The distinction is load-bearing where no clock is supplied: `number | null`
 * cannot be admitted there because the compiler cannot rule out the finite
 * case, which is the one that silently did nothing.
 */
export type DisabledStalenessPolicy = ValidStalenessPolicy & {
  readonly maxAgeDays: null;
};

/**
 * Refuse an unreadable instant.
 *
 * Accepts what a caller genuinely has — a `Date`, an ISO string, or epoch
 * milliseconds — and refuses anything that cannot be read as a real instant.
 * Refusing rather than substituting is the whole point: `Date.now()`, epoch
 * zero or a clamped value would each invent a chronology the caller never
 * supplied, and a confident wrong instant is worse than an absent one.
 */
export function instant(value: Date | string | number): ValidInstant {
  const asDate = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(asDate.getTime())) {
    throw new Error(
      `instant: ${JSON.stringify(String(value))} is not a readable instant; ` +
        `a comparison cannot be made against a clock that cannot be read`,
    );
  }
  return asDate as ValidInstant;
}

/** Read an instant that may legitimately be absent. Returns null, never throws. */
export function optionalInstant(
  value: Date | string | number | null | undefined,
): ValidInstant | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim().length === 0) return null;
  const asDate = value instanceof Date ? value : new Date(value);
  return Number.isFinite(asDate.getTime()) ? (asDate as ValidInstant) : null;
}

export function stalenessPolicy(maxAgeDays: null): DisabledStalenessPolicy;
export function stalenessPolicy(maxAgeDays: number | null): ValidStalenessPolicy;
/**
 * Refuse a cap that cannot express an age limit.
 *
 * `NaN`, `±Infinity` and negatives are each refused rather than clamped,
 * defaulted or swapped for a disabled policy — every one of those invents a
 * policy the studio never wrote. Measured against a 6-year-old and an 8-day-old
 * preference before this existed:
 *
 *     maxAgeDays = NaN       -> stale | stale      an 8-day-old answer, STALE
 *     maxAgeDays = -5        -> stale | stale
 *     maxAgeDays = Infinity  -> fresh | fresh      a 6-year-old answer, FRESH
 *
 * ZERO IS LEGITIMATE and stays so: `age <= 0` means only an answer confirmed
 * today counts, a real same-day expiry. Disabled is spelled `null`.
 */
export function stalenessPolicy(maxAgeDays: number | null): ValidStalenessPolicy {
  if (maxAgeDays !== null && (!Number.isFinite(maxAgeDays) || maxAgeDays < 0)) {
    throw new Error(
      `stalenessPolicy: maxAgeDays must be a finite, non-negative number of days ` +
        `or null to disable staleness; received ${String(maxAgeDays)}`,
    );
  }
  return { maxAgeDays } as ValidStalenessPolicy;
}
