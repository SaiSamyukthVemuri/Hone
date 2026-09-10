/**
 * VALIDATED EVIDENCE — the single place invalid comparison operands are refused.
 *
 * THE DEFECT CLASS. Five repairs on this branch each validated one operand at
 * one boundary and the next review found the next unguarded one; a census then
 * found a sixth before any review did. Three things composed to guarantee it:
 * an invalid operand stayed REPRESENTABLE (`Date` admits Invalid Date, `number`
 * admits NaN and ±Infinity); ownership was spread over five partial owners; and
 * the raw classifiers are exported, so the validating wrapper was never the
 * only door.
 *
 * THE FIRST ATTEMPT AT THIS FILE BRANDED A `Date`, AND IT FAILED ITS OWN
 * CLOSURE TEST. A brand describes a REFERENCE; `Date` keeps its value in an
 * internal slot that the reference can rewrite. So ordinary TypeScript, with no
 * cast and no JavaScript caller, could undo the guarantee two ways:
 *
 *     const d = new Date(...); const v = instant(d); d.setTime(NaN);  // aliasing
 *     v.setTime(NaN);                                                 // mutator API
 *
 * Measured on that head: `daysBetween` returned NaN and `applyConfirmation`
 * persisted `Invalid Date`, while the value still carried the validated type.
 *
 * `Object.freeze` DOES NOT FIX IT, and this was tested rather than assumed:
 * freeze guards properties, `[[DateValue]]` is an internal slot, and
 * `setTime(NaN)` on a frozen Date SUCCEEDS SILENTLY — no throw, even in strict
 * mode. A guard test pins that fact so nobody repairs this by freezing later.
 *
 * SO THE VALIDATED INSTANT IS NOT AN OBJECT. It is a finite epoch-millisecond
 * NUMBER: immutable by the language rather than by remembering to freeze, with
 * no mutator surface to expose and no reference to alias. Validation-once
 * requires post-validation immutability, and a primitive is the only
 * representation here that has it for free.
 *
 * Three properties that made this the choice over a frozen `{ epochMs }` value
 * object, all measured against the real call sites:
 *
 *   1. every in-module consumption was already `.getTime()` — the modules want
 *      epoch milliseconds, so this REMOVES conversions rather than adding them;
 *   2. arithmetic DROPS the brand (`v + 1` is a plain `number`), so a derived
 *      value cannot masquerade as validated;
 *   3. a value object's immutability is conditional on every construction
 *      remembering `Object.freeze` and every caller being in strict mode —
 *      a discipline requirement, which is the thing this file exists to remove.
 *
 * THE REMAINING LIMIT, STATED. An explicit `as ValidInstant` cast still
 * bypasses this, in any representation TypeScript can express. That belongs to
 * review and to the census guard in
 * tests/lib/waitlist/exported-boundary-census.test.ts, not to the type.
 */

declare const VALID_INSTANT: unique symbol;
declare const VALID_STALENESS: unique symbol;

/**
 * An instant known to be readable: epoch milliseconds, finite, immutable.
 *
 * A `number` at runtime, so comparisons and ordering are direct arithmetic and
 * there is nothing to mutate. Use `toDate()` at a formatting or interop edge.
 */
export type ValidInstant = number & { readonly [VALID_INSTANT]: true };

/** A staleness policy whose cap can express an age limit. */
export type ValidStalenessPolicy = {
  readonly maxAgeDays: number | null;
} & { readonly [VALID_STALENESS]: true };

/**
 * A policy the COMPILER can see is disabled.
 *
 * Load-bearing where no clock is supplied: `number | null` cannot be admitted
 * there, because the compiler cannot rule out the finite case — the one that
 * silently did nothing.
 */
export type DisabledStalenessPolicy = ValidStalenessPolicy & {
  readonly maxAgeDays: null;
};

function readEpoch(value: Date | string | number): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  return new Date(value).getTime();
}

/**
 * Refuse an unreadable instant, and return a value that cannot become one.
 *
 * Accepts what a caller genuinely has — a `Date`, an ISO string, or epoch
 * milliseconds — and reads it ONCE into a finite primitive. Nothing the caller
 * subsequently does to the argument can reach the returned value: there is no
 * shared reference, because there is no reference.
 *
 * Refusing rather than substituting is the point. `Date.now()`, epoch zero or a
 * clamped value would each invent a chronology the caller never supplied, and a
 * confident wrong instant is worse than an absent one.
 */
export function instant(value: Date | string | number): ValidInstant {
  const epochMs = readEpoch(value);
  if (!Number.isFinite(epochMs)) {
    throw new Error(
      `instant: ${JSON.stringify(String(value))} is not a readable instant; ` +
        `a comparison cannot be made against a clock that cannot be read`,
    );
  }
  return epochMs as ValidInstant;
}

/** Read an instant that may legitimately be absent. Returns null, never throws. */
export function optionalInstant(
  value: Date | string | number | null | undefined,
): ValidInstant | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim().length === 0) return null;
  const epochMs = readEpoch(value);
  return Number.isFinite(epochMs) ? (epochMs as ValidInstant) : null;
}

/**
 * Materialise a `Date` at a formatting or interoperability edge.
 *
 * A FRESH object every time, deliberately. Handing the same one back twice
 * would reintroduce exactly the aliasing this representation exists to remove —
 * the caller may mutate what they receive, and it must reach nothing else.
 */
export function toDate(value: ValidInstant): Date {
  return new Date(value);
}

export function stalenessPolicy(maxAgeDays: null): DisabledStalenessPolicy;
export function stalenessPolicy(maxAgeDays: number | null): ValidStalenessPolicy;
/**
 * Refuse a cap that cannot express an age limit.
 *
 * `NaN`, `±Infinity` and negatives are refused rather than clamped, defaulted
 * or swapped for a disabled policy — every one of those invents a policy the
 * studio never wrote. Measured against a 6-year-old and an 8-day-old preference
 * before this existed:
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
