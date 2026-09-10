import type { AvailabilityPreference } from "./preferences";
import type { AvailabilitySource } from "./provenance";
import {
  stalenessPolicy,
  type DisabledStalenessPolicy,
  type ValidInstant,
  type ValidStalenessPolicy,
} from "./validated";

// ===========================================================================
// WAIT-ADMIT-01 — PREFERENCE FRESHNESS
// ===========================================================================
//
// Answers one question: how much should the studio still trust what this person
// told them, and when? Pure — `now` is injected.
//
// ---------------------------------------------------------------------------
// WHY "STATED" AND "CONFIRMED" ARE TWO TIMESTAMPS, NOT ONE
// ---------------------------------------------------------------------------
//
// They answer different questions and a single column cannot answer both:
//
//   statedAt     when this VALUE was last set or changed.
//                "Weekends, since March."
//   confirmedAt  when the studio last had it AFFIRMED, whether or not it moved.
//                "And they told us again last week that it is still weekends."
//
// Collapse them into one and you must choose which truth to lose:
//
//   * Move a single timestamp on re-confirmation and you destroy the history of
//     the value — a preference held unchanged for eight months looks like one
//     set last week, and "has anything changed for you?" becomes unanswerable.
//
//   * Do NOT move it on re-confirmation and the preference ages out while the
//     person is actively telling you it still holds, so the studio re-asks
//     someone who just answered. That is the more visible failure, and it is
//     the one that trains operators to ignore the staleness signal.
//
// This is what makes the confirmation timestamp REQUIRED rather than decorative:
// without it, freshness cannot be refreshed except by pretending the answer
// changed.
//
// INVARIANT: confirmedAt >= statedAt, always. Setting a value IS confirming it,
// so a fresh statement seeds both. A row violating this is treated as
// inconsistent and reported, never silently repaired — a confirmation that
// predates the value it confirms describes a write ordering nobody intended.
// ===========================================================================

/** A preference as stored, with the two timestamps that qualify it. */
export type StoredPreference = {
  readonly preference: AvailabilityPreference;
  readonly statedAt: Date;
  readonly confirmedAt: Date;
  readonly source: AvailabilitySource;
};

export type PreferenceFreshness =
  /** Affirmed recently enough to act on. */
  | { readonly kind: "fresh"; readonly ageDays: number }
  /** Real, but old enough that the studio should re-ask before relying on it. */
  | { readonly kind: "stale"; readonly ageDays: number }
  /** confirmedAt < statedAt. Not trusted, and surfaced rather than repaired. */
  | { readonly kind: "inconsistent"; readonly detail: string };

/**
 * How stale a preference may be before it stops counting as stated.
 *
 * `null` means preferences NEVER go stale, and that is the default: expiring
 * someone's stated answer is a policy decision with a real cost — it pushes a
 * person who answered honestly back into the "not stated" pool — and no studio
 * should acquire it by upgrading.
 */
/**
 * A staleness policy that has been through `stalenessPolicy()`.
 *
 * The NAME is unchanged so every existing reader keeps reading, but it now
 * denotes VALIDATED evidence: a cap that cannot express an age limit is
 * unrepresentable in this type, so no consumer has to re-check one — and no
 * consumer can forget to.
 */
export type StalenessPolicy = ValidStalenessPolicy;

/**
 * Declared with the LITERAL null rather than as StalenessPolicy so it stays
 * usable where no clock is supplied: a `number | null` cannot be admitted
 * there, because the compiler cannot rule out the finite case.
 */
export const NEVER_STALE: DisabledStalenessPolicy = stalenessPolicy(null);

/** Whole days between two instants, floored, never negative. */
function ageInDays(from: Date, to: Date): number {
  const ms = to.getTime() - from.getTime();
  // Both operands are validated by every caller before reaching here, so a
  // non-finite result is a programming error rather than data to interpret.
  // It used to return 0, which is how an invalid clock became "fresh".
  if (!Number.isFinite(ms)) {
    throw new Error("ageInDays: non-finite interval; the clock or the stamp is invalid");
  }
  return Math.max(0, Math.floor(ms / 86_400_000));
}

export function classifyPreferenceFreshness(
  stored: StoredPreference,
  now: ValidInstant,
  policy: StalenessPolicy,
): PreferenceFreshness {
  const statedMs = stored.statedAt.getTime();
  const confirmedMs = stored.confirmedAt.getTime();

  if (!Number.isFinite(statedMs) || !Number.isFinite(confirmedMs)) {
    return { kind: "inconsistent", detail: "statedAt or confirmedAt is not a valid instant" };
  }
  // THE CLOCK IS EVIDENCE TOO, AND IT WAS THE ONE INPUT NOT CHECKED.
  //
  // An Invalid Date makes the elapsed calculation NaN, ageInDays returned 0 for
  // any non-finite result, and 0 <= maxAgeDays reads as FRESH -- so a broken
  // clock made a years-old preference look current. That is the age-zero
  // failure in its most damaging form: not a wrong number, a confident one.
  // An unusable clock cannot establish freshness, so it establishes nothing.
  if (!Number.isFinite(now.getTime())) {
    return { kind: "inconsistent", detail: "now is not a valid instant" };
  }
  if (confirmedMs < statedMs) {
    return {
      kind: "inconsistent",
      detail: "confirmedAt precedes statedAt",
    };
  }

  // AGE IS MEASURED FROM confirmedAt, NOT statedAt. That is the whole point of
  // holding both: re-confirming an unchanged preference refreshes trust without
  // rewriting the history of the value.
  const ageDays = ageInDays(stored.confirmedAt, now);
  if (policy.maxAgeDays === null || ageDays <= policy.maxAgeDays) {
    return { kind: "fresh", ageDays };
  }
  return { kind: "stale", ageDays };
}

/**
 * Should the ranking engine treat this preference as stated?
 *
 * Stale and inconsistent both answer NO, and they reach the engine as ordinary
 * "not stated" — which means the studio's own `unknownPolicy` decides what
 * happens next, rather than this module inventing a second, competing rule for
 * the same situation.
 */
export function preferenceIsActionable(freshness: PreferenceFreshness): boolean {
  return freshness.kind === "fresh";
}

/**
 * Apply a confirmation to a stored preference.
 *
 * Returns the fields to persist. An UNCHANGED value moves only `confirmedAt`;
 * a CHANGED value moves both, because a different answer is a new statement.
 * Kept here rather than in the eventual RPC so the rule is unit-tested and has
 * exactly one definition.
 */
export function applyConfirmation(
  current: StoredPreference | null,
  answer: { readonly preference: AvailabilityPreference; readonly source: AvailabilitySource },
  at: ValidInstant,
): StoredPreference {
  if (current === null || current.preference !== answer.preference) {
    return {
      preference: answer.preference,
      statedAt: at,
      confirmedAt: at,
      source: answer.source,
    };
  }
  return {
    preference: current.preference,
    statedAt: current.statedAt,
    confirmedAt: at,
    // The most recent route that affirmed it, so provenance describes the
    // freshest evidence rather than the oldest.
    source: answer.source,
  };
}
