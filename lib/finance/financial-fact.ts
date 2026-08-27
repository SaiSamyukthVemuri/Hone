// ===========================================================================
// FIN-01A — the known/unknown vocabulary for owner-facing financial figures
// ===========================================================================
//
// Every figure on /financials travels as a `Fact<T>`. The discipline this file
// exists to enforce is the one the whole surface is built on: AN ABSENT INPUT
// IS NEVER ZERO, and the several different ways a figure can be absent are not
// the same claim and do not get the same sentence.
//
// WHY NOT `Fact<T>` FROM lib/dashboard/owner-capacity-model. That type carries
// `reason: string` — free prose chosen at the call site. It is right for the
// capacity briefing, where every absence has the same shape ("not enough
// evidence yet") and only the wording differs. It is wrong here, because a
// money surface has to keep FIVE absences apart, and a string cannot be
// exhaustively checked by the compiler, cannot be switched on, and cannot stop
// two causes drifting into one sentence. OWNER-CAP's type is deliberately left
// alone; widening it belongs to that lane, not this one.
//
// The two are structurally incompatible on purpose — `{ known: false; cause }`
// is not assignable to `{ known: false; reason }` — so importing the wrong one
// is a type error rather than a screen that quietly says the wrong thing.
//
// THERE IS DELIBERATELY NO `valueOr(fact, fallback)` AND NO `.value ?? 0`
// ANYWHERE. A coercion helper is the single mechanism by which "we could not
// read this" becomes "$0.00", and once it exists somebody reaches for it under
// deadline. Reading a value requires narrowing the union, which is a decision
// the author has to make in the open. `tests/app/finance/financials-truth.test.ts`
// pins that absence.

/**
 * WHY a figure is not known. Closed, and exhaustively handled at the render
 * boundary, because each member gets a different sentence in front of the
 * studio owner.
 */
export type FinancialUnknownCause =
  /**
   * NO DISPOSITION RECORDED. The read succeeded and the row simply is not
   * there. This is the truthful state for a completed visit nobody has settled:
   * migration 0187 writes no rows and backfills nothing, so an absent
   * disposition means an absent disposition, not a free visit.
   */
  | "not_recorded"
  /**
   * READ FAILED. supabase-js RESOLVES with `{ data: null, error }` rather than
   * rejecting, so a discarded error becomes an empty row set and an empty row
   * set becomes a confident zero. This cause is what that failure turns into.
   */
  | "unavailable"
  /**
   * HISTORICALLY UNKNOWABLE. No record was ever capable of existing, so no
   * amount of looking will produce one and there is nothing for the owner to
   * do. Two live instances: a visit that happened before Hone could record a
   * settlement at all, and processor cost, which the live ledger has no column
   * for.
   */
  | "unknowable"
  /**
   * NOT YET SUPPORTED. Hone could answer this and does not answer it yet. It is
   * a statement about this release, never about the studio's data, and it must
   * never be shown where one of the four above is the truth.
   */
  | "not_yet_supported"
  /**
   * NOT ENUMERABLE. The population was larger than one read can return, so the
   * figure would be computed over a set that was never fully in hand. A short
   * sum presented as a total is the specific lie this prevents.
   */
  | "not_enumerable";

export type Fact<T> =
  | { readonly known: true; readonly value: T }
  | { readonly known: false; readonly cause: FinancialUnknownCause };

/**
 * A figure that IS established. Zero is a legitimate value here and only here:
 * `known(0)` says "we looked, and it is nothing", which is a different claim
 * from every member of FinancialUnknownCause.
 */
export function known<T>(value: T): Fact<T> {
  return { known: true, value };
}

export function unknownBecause<T>(cause: FinancialUnknownCause): Fact<T> {
  return { known: false, cause };
}

/** The slice-boundary constant. Named so a reader sees the release, not a bug. */
export function notYetSupported<T>(): Fact<T> {
  return { known: false, cause: "not_yet_supported" };
}

/**
 * Transform a known value, PRESERVING the cause when there is none.
 *
 * The point is that there is no way to write this transformation that silently
 * invents a value for the unknown branch: `mapFact(unknown, f)` cannot call
 * `f`, so no default can leak in through a callback either.
 */
export function mapFact<A, B>(fact: Fact<A>, f: (value: A) => B): Fact<B> {
  return fact.known ? known(f(fact.value)) : fact;
}

/**
 * Combine two facts. UNKNOWN IS CONTAGIOUS, and the FIRST unknown cause wins so
 * the sentence the owner reads names the thing that actually went wrong rather
 * than whichever operand happened to be second.
 */
export function combineFacts<A, B, C>(
  a: Fact<A>,
  b: Fact<B>,
  f: (a: A, b: B) => C,
): Fact<C> {
  if (!a.known) return a;
  if (!b.known) return b;
  return known(f(a.value, b.value));
}
