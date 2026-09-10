import {
  coveredDayClasses,
  preferenceCoversDayClass,
  type CandidateAvailability,
  type DayClass,
} from "./preferences";
import { instant, type ValidInstant } from "./validated";

// ===========================================================================
// WAIT-ADMIT-01 — WAITLIST RANKING ENGINE (GENERAL STUDIO POLICY)
// ===========================================================================
//
// Ranks waiting prospects against the capacity a studio actually has, under a
// policy the studio configures. Pure: no I/O, no database, no `Date.now()` —
// the caller injects `now`, so the same inputs always produce the same output
// and a test never races a clock.
//
// ---------------------------------------------------------------------------
// THIS IS POLICY, NOT A STUDIO
// ---------------------------------------------------------------------------
//
// Nothing here names a studio, and no weight has a "because Chloe wants it"
// default. "Prefer weekday-available candidates" is expressed by setting
// `preferredDayClass: "weekday"` and a non-zero `preferenceAlignment` weight —
// a configuration, reachable by any studio, changeable without a code change.
// A hard-coded preference would have to be un-hard-coded for the second studio,
// and the second studio is the entire point of the product.
//
// ---------------------------------------------------------------------------
// IT RECOMMENDS. IT NEVER ACTS.
// ---------------------------------------------------------------------------
//
// The output is an ordered list with reasons. This module creates no
// appointment, sends no invitation, claims no entry and writes nothing. The
// existing lifecycle commands remain the only way an entry changes state, and
// they still require an owner and still re-derive authority in the database.
//
// ---------------------------------------------------------------------------
// FIFO IS THE FLOOR, NOT AN ALTERNATIVE
// ---------------------------------------------------------------------------
//
// With `FIFO_POLICY` every weight is zero, every candidate scores 0, and the
// tie-break alone decides: `(joined_at, id)` ascending — byte-for-byte the
// order `claim_new_client_waitlist_entries` already uses in the database. So
// this engine GENERALISES today's behaviour rather than replacing it, and a
// studio that configures nothing keeps exactly the queue it has now.
//
// The tie-break is also what makes every other policy a TOTAL order: two
// candidates with equal scores never swap between renders.
//
// ---------------------------------------------------------------------------
// AN UNEVALUABLE FACTOR IS DROPPED, NEVER SCORED ZERO
// ---------------------------------------------------------------------------
//
// If a studio has no weekend openings, "availability compatibility" has nothing
// to measure. Scoring it 0 would push every candidate down by an amount that
// depends on a weight the studio set for a question that was never asked —
// which looks exactly like a real signal. So an inapplicable factor is removed
// from the weighted mean AND from its denominator, and the explanation says
// which factors actually decided.
//
// The same rule covers a prospect who was never asked their availability. What
// happens to them is `unknownPolicy`, and it is the studio's choice, not a
// default this module smuggles in.
// ===========================================================================

/** What a prospect told the studio about the services they want. */
export type ServiceInterest =
  | { readonly stated: true; readonly serviceIds: readonly string[] }
  | { readonly stated: false };

export const UNSTATED_SERVICE_INTEREST: ServiceInterest = { stated: false };

/**
 * One waiting prospect, reduced to what ranking is allowed to see.
 *
 * DELIBERATELY NO NAME, EMAIL OR PHONE. Ranking has no use for them, and the
 * explanation output is designed to be loggable and screen-shareable; the only
 * way to guarantee it carries no contact detail is for the engine never to
 * receive one. The caller re-joins `entryId` to the display record afterwards.
 */
export type ScoringCandidate = {
  readonly entryId: string;
  /** From storage. The engine never invents or adjusts it. */
  readonly joinedAt: Date;
  /**
   * Whether `joinedAt` is a real wait anchor or only a queue position.
   *
   * Defaults to true, which is every row today. FALSE for a legacy entry whose
   * join date nobody has: the row still needs a position in the queue, so
   * `joinedAt` holds the import instant — but scoring its wait from that would
   * report a person who has been waiting eight months as having waited a day,
   * and rank them accordingly. So the waiting-time factor returns UNKNOWN for
   * these, and the studio's own `unknownPolicy` decides, exactly as it does for
   * an unanswered availability question. One rule for missing evidence.
   *
   * The tie-break still uses `joinedAt`, because a stable total order is needed
   * whether or not the anchor means anything.
   */
  readonly waitIsMeasurable?: boolean;
  readonly availability: CandidateAvailability;
  readonly serviceInterest: ServiceInterest;
};

/** Capacity the studio expects to open, as whole bookable slots. */
export type StudioOpening = {
  readonly dayClass: DayClass;
  /** null = the opening is not service-specific. */
  readonly serviceId: string | null;
  /** How many slots of this shape. Non-positive entries are ignored. */
  readonly slots: number;
};

export type ScoringContext = {
  /** Injected, and VALIDATED at construction. This module never reads a clock. */
  readonly now: ValidInstant;
  readonly openings: readonly StudioOpening[];
};

/** How to treat a factor a prospect never answered. The studio decides. */
export type UnknownFactorPolicy =
  /** Drop the factor for this candidate; the factors they did answer decide. */
  | "neutral"
  /** Score the factor 0. A stated answer always outranks silence. */
  | "penalize"
  /** Remove the candidate from the recommendation entirely, with a reason. */
  | "exclude";

export type ScoringFactor =
  | "availabilityCompatibility"
  | "preferenceAlignment"
  | "waitingTime"
  | "serviceCompatibility"
  | "capacityFit";

export const SCORING_FACTORS: readonly ScoringFactor[] = [
  "availabilityCompatibility",
  "preferenceAlignment",
  "waitingTime",
  "serviceCompatibility",
  "capacityFit",
] as const;

export type ScoringWeights = Readonly<Record<ScoringFactor, number>>;

export type ScoringPolicy = {
  readonly weights: ScoringWeights;
  /**
   * The day class this studio wants to favour, or null for no preference.
   *
   * This is the "prefer weekday-available candidates when configured to do so"
   * control. Null makes `preferenceAlignment` inapplicable for everyone, which
   * removes it from the mean rather than scoring it 0.
   */
  readonly preferredDayClass: DayClass | null;
  readonly unknownPolicy: UnknownFactorPolicy;
  /**
   * Waiting time saturates here. A 400-day-old entry and a 200-day-old entry
   * are both "very long" at a 180-day cap; without a cap the factor would
   * eventually drown every other signal purely by ageing.
   */
  readonly waitingTimeCapDays: number;
};

const ZERO_WEIGHTS: ScoringWeights = {
  availabilityCompatibility: 0,
  preferenceAlignment: 0,
  waitingTime: 0,
  serviceCompatibility: 0,
  capacityFit: 0,
};

/**
 * The identity policy: reproduces the database's existing FIFO order exactly.
 *
 * Every weight zero, so every candidate scores 0 and `(joinedAt, entryId)`
 * decides. This is the safe default for a studio that has configured nothing.
 */
export const FIFO_POLICY: ScoringPolicy = {
  weights: ZERO_WEIGHTS,
  preferredDayClass: null,
  unknownPolicy: "neutral",
  waitingTimeCapDays: 180,
};

export type PolicyValidation =
  | { ok: true; value: ScoringPolicy }
  | { ok: false; error: string };

/**
 * Validate a studio-supplied policy.
 *
 * A NEGATIVE WEIGHT IS REJECTED, not clamped. Clamping to 0 would silently
 * discard an intent the studio expressed, and a negative weight inverts a
 * factor's meaning — "prefer people who have waited least" — which no part of
 * the explanation vocabulary below can honestly describe.
 */
export function validateScoringPolicy(policy: ScoringPolicy): PolicyValidation {
  for (const factor of SCORING_FACTORS) {
    const weight = policy.weights[factor];
    if (!Number.isFinite(weight)) {
      return { ok: false, error: `Weight for ${factor} must be a finite number.` };
    }
    if (weight < 0) {
      return { ok: false, error: `Weight for ${factor} must not be negative.` };
    }
  }
  if (!Number.isFinite(policy.waitingTimeCapDays) || policy.waitingTimeCapDays <= 0) {
    return { ok: false, error: "waitingTimeCapDays must be a positive number." };
  }
  return { ok: true, value: policy };
}

/** One factor's evaluation for one candidate. */
export type FactorOutcome =
  | { readonly kind: "scored"; readonly value: number; readonly detail: string }
  /** Nothing to measure — dropped from the mean AND its denominator. */
  | { readonly kind: "not_applicable"; readonly detail: string }
  /** The prospect never answered; `unknownPolicy` decided what that means. */
  | { readonly kind: "unknown"; readonly detail: string };

export type FactorContribution = {
  readonly factor: ScoringFactor;
  readonly weight: number;
  readonly outcome: FactorOutcome;
  /** weight x value, or null when the factor did not participate. */
  readonly contribution: number | null;
};

export type ScoredCandidate = {
  readonly entryId: string;
  /** Weighted mean over participating factors, in [0, 1]. */
  readonly score: number;
  /** 1-based position in the returned order. */
  readonly rank: number;
  /** null when the join date is only a queue anchor. Never rendered as 0. */
  readonly daysWaiting: number | null;
  /**
   * Carried through from the candidate so the tie-break needs no lookup back
   * into the input. A comparator that searched the cohort per comparison would
   * make sorting O(n^2 log n) — and this factor exists to keep ranking linear
   * in the cohort plus the sort.
   */
  readonly joinedAt: Date;
  readonly factors: readonly FactorContribution[];
};

export type ExcludedCandidate = {
  readonly entryId: string;
  readonly reason: string;
};

export type RankingResult = {
  readonly ranked: readonly ScoredCandidate[];
  readonly excluded: readonly ExcludedCandidate[];
  /** Factors that participated for at least one candidate. */
  readonly decidedBy: readonly ScoringFactor[];
};

/**
 * Whole days between two instants, floored, never negative.
 *
 * A non-finite interval is REFUSED rather than flattened to 0. Returning zero
 * was the age-zero failure in its ranking form: an unusable instant produced a
 * confident "waited no days", which is a real measurement, not an absence of
 * one. Same doctrine as `ageInDays` in ./confirmation — a clock you cannot
 * trust must not be allowed to answer.
 */
export function daysBetween(from: ValidInstant, to: ValidInstant): number {
  // No finiteness check here any more: both operands are ValidInstant, so a
  // non-finite interval is unconstructable rather than merely unlikely.
  // `instant()` refused it before it could reach a parameter position.
  const ms = to.getTime() - from.getTime();
  return Math.max(0, Math.floor(ms / 86_400_000));
}

function usableOpenings(openings: readonly StudioOpening[]): readonly StudioOpening[] {
  return openings.filter((o) => Number.isFinite(o.slots) && o.slots > 0);
}

function slotsByDayClass(
  openings: readonly StudioOpening[],
): Readonly<Record<DayClass, number>> {
  let weekday = 0;
  let weekend = 0;
  for (const o of openings) {
    if (o.dayClass === "weekday") weekday += o.slots;
    else weekend += o.slots;
  }
  return { weekday, weekend };
}

/**
 * COHORT DEMAND, which is why ranking is a function of the whole list.
 *
 * `capacityFit` asks whether a candidate can take openings that FEW OTHERS can
 * take, so it cannot be computed one candidate at a time. Counting it once for
 * the cohort — rather than re-deriving it inside a per-candidate loop — is also
 * what keeps the ranking O(n) rather than O(n^2).
 *
 * A candidate whose availability is unstated is NOT counted as demand for any
 * class. Counting them everywhere would inflate demand with people who may not
 * be able to attend at all; counting them nowhere states plainly that we do not
 * know, which is true.
 */
function demandByDayClass(
  candidates: readonly ScoringCandidate[],
): Readonly<Record<DayClass, number>> {
  let weekday = 0;
  let weekend = 0;
  for (const c of candidates) {
    if (!c.availability.stated) continue;
    for (const dc of coveredDayClasses(c.availability.preference)) {
      if (dc === "weekday") weekday += 1;
      else weekend += 1;
    }
  }
  return { weekday, weekend };
}

function availabilityFactor(
  candidate: ScoringCandidate,
  openings: readonly StudioOpening[],
): FactorOutcome {
  const supply = slotsByDayClass(openings);
  const total = supply.weekday + supply.weekend;
  if (total === 0) {
    return { kind: "not_applicable", detail: "no openings supplied" };
  }
  if (!candidate.availability.stated) {
    return { kind: "unknown", detail: "availability not stated" };
  }
  const covered = coveredDayClasses(candidate.availability.preference);
  const reachable = covered.reduce((sum, dc) => sum + supply[dc], 0);
  return {
    kind: "scored",
    value: reachable / total,
    detail: `can attend ${reachable} of ${total} opening slots`,
  };
}

function preferenceAlignmentFactor(
  candidate: ScoringCandidate,
  preferred: DayClass | null,
): FactorOutcome {
  if (preferred === null) {
    return { kind: "not_applicable", detail: "studio expresses no day preference" };
  }
  if (!candidate.availability.stated) {
    return { kind: "unknown", detail: "availability not stated" };
  }
  const covers = preferenceCoversDayClass(candidate.availability.preference, preferred);
  return {
    kind: "scored",
    value: covers ? 1 : 0,
    detail: covers
      ? `available on the studio's preferred ${preferred}s`
      : `not available on the studio's preferred ${preferred}s`,
  };
}

function waitingTimeFactor(
  days: number,
  capDays: number,
  measurable: boolean,
): FactorOutcome {
  if (!measurable) {
    return { kind: "unknown", detail: "join date unknown — wait cannot be measured" };
  }
  const value = Math.min(1, days / capDays);
  return {
    kind: "scored",
    value,
    detail: `waiting ${days} day${days === 1 ? "" : "s"} (cap ${capDays})`,
  };
}

function serviceCompatibilityFactor(
  candidate: ScoringCandidate,
  openings: readonly StudioOpening[],
): FactorOutcome {
  const total = openings.reduce((sum, o) => sum + o.slots, 0);
  if (total === 0) {
    return { kind: "not_applicable", detail: "no openings supplied" };
  }
  // Openings that name no service are open to everyone, so a cohort where no
  // opening is service-specific has nothing to discriminate on.
  if (openings.every((o) => o.serviceId === null)) {
    return { kind: "not_applicable", detail: "no service-specific openings" };
  }
  if (!candidate.serviceInterest.stated) {
    return { kind: "unknown", detail: "service interest not stated" };
  }
  const wanted = new Set(candidate.serviceInterest.serviceIds);
  const matched = openings.reduce(
    (sum, o) => sum + (o.serviceId === null || wanted.has(o.serviceId) ? o.slots : 0),
    0,
  );
  return {
    kind: "scored",
    value: matched / total,
    detail: `matches ${matched} of ${total} opening slots by service`,
  };
}

function capacityFitFactor(
  candidate: ScoringCandidate,
  openings: readonly StudioOpening[],
  demand: Readonly<Record<DayClass, number>>,
): FactorOutcome {
  const supply = slotsByDayClass(openings);
  if (supply.weekday + supply.weekend === 0) {
    return { kind: "not_applicable", detail: "no openings supplied" };
  }
  if (!candidate.availability.stated) {
    return { kind: "unknown", detail: "availability not stated" };
  }
  let best = 0;
  let bestClass: DayClass | null = null;
  for (const dc of coveredDayClasses(candidate.availability.preference)) {
    if (supply[dc] === 0) continue;
    // Slots per interested candidate, squashed into [0,1]. A class only this
    // person can serve scores near 1; a class everyone can serve scores near 0.
    const fit = supply[dc] / (supply[dc] + demand[dc]);
    if (fit > best) {
      best = fit;
      bestClass = dc;
    }
  }
  if (bestClass === null) {
    return {
      kind: "scored",
      value: 0,
      detail: "cannot attend any day class with openings",
    };
  }
  return {
    kind: "scored",
    value: best,
    detail: `best fit on ${bestClass}s (${supply[bestClass]} slots, ${demand[bestClass]} candidates available)`,
  };
}

/**
 * Rank a cohort of waiting prospects.
 *
 * Deterministic and total: equal scores are broken by `joinedAt` then
 * `entryId`, so the order never depends on input order or on Array#sort's
 * stability guarantees.
 *
 * Throws on an invalid policy or an invalid clock — a caller that hands this a
 * negative weight or an unusable `now` has a configuration bug, and silently
 * ranking under a policy nobody wrote, or a clock nobody can read, would be
 * worse than failing.
 */
export function rankWaitlistCandidates(
  candidates: readonly ScoringCandidate[],
  context: ScoringContext,
  policy: ScoringPolicy,
): RankingResult {
  const validated = validateScoringPolicy(policy);
  if (!validated.ok) throw new Error(`Invalid scoring policy: ${validated.error}`);

  // The ranking clock is not re-checked here: ScoringContext.now is a
  // ValidInstant, so an unreadable clock cannot occupy it. `instant()` owns
  // that refusal, and owns it for every comparison in this module.

  const openings = usableOpenings(context.openings);
  const demand = demandByDayClass(candidates);

  const excluded: ExcludedCandidate[] = [];
  const scored: ScoredCandidate[] = [];
  const decidedBy = new Set<ScoringFactor>();

  for (const candidate of candidates) {
    // `joinedAt` arrives as a plain Date on ScoringCandidate, which callers
    // build from rows. It crosses into a comparison HERE, so it goes through
    // the constructor here — the owner is the constructor, wherever raw
    // evidence enters.
    const days = daysBetween(instant(candidate.joinedAt), context.now);
    const waitMeasurable = candidate.waitIsMeasurable !== false;

    const outcomes: Readonly<Record<ScoringFactor, FactorOutcome>> = {
      availabilityCompatibility: availabilityFactor(candidate, openings),
      preferenceAlignment: preferenceAlignmentFactor(candidate, policy.preferredDayClass),
      waitingTime: waitingTimeFactor(
        days,
        policy.waitingTimeCapDays,
        candidate.waitIsMeasurable !== false,
      ),
      serviceCompatibility: serviceCompatibilityFactor(candidate, openings),
      capacityFit: capacityFitFactor(candidate, openings, demand),
    };

    // EXCLUSION IS DECIDED BEFORE ANY ARITHMETIC. A candidate excluded for one
    // unknown factor must not appear in the ranking with a score computed from
    // the others; the studio asked for them to be left out, not down-weighted.
    if (policy.unknownPolicy === "exclude") {
      const missing = SCORING_FACTORS.filter(
        (f) => policy.weights[f] > 0 && outcomes[f].kind === "unknown",
      );
      if (missing.length > 0) {
        excluded.push({
          entryId: candidate.entryId,
          reason: `not stated: ${missing.join(", ")}`,
        });
        continue;
      }
    }

    const factors: FactorContribution[] = [];
    let weighted = 0;
    let denominator = 0;

    for (const factor of SCORING_FACTORS) {
      const weight = policy.weights[factor];
      const outcome = outcomes[factor];

      // A zero weight means the studio switched this factor off. It never
      // participates and never appears as a reason.
      if (weight === 0) {
        factors.push({ factor, weight, outcome, contribution: null });
        continue;
      }

      let value: number | null = null;
      if (outcome.kind === "scored") {
        value = outcome.value;
      } else if (outcome.kind === "unknown" && policy.unknownPolicy === "penalize") {
        value = 0;
      }
      // "neutral" unknowns and not_applicable factors fall through with a null
      // value: dropped from BOTH the numerator and the denominator.

      if (value === null) {
        factors.push({ factor, weight, outcome, contribution: null });
        continue;
      }

      weighted += weight * value;
      denominator += weight;
      decidedBy.add(factor);
      factors.push({ factor, weight, outcome, contribution: weight * value });
    }

    // No participating factor means nothing distinguished this candidate. Score
    // 0 for everyone collapses to the FIFO tie-break, which is the honest
    // answer rather than a fabricated ordering.
    const score = denominator === 0 ? 0 : weighted / denominator;

    scored.push({
      entryId: candidate.entryId,
      score,
      rank: 0,
      daysWaiting: waitMeasurable ? days : null,
      joinedAt: candidate.joinedAt,
      factors,
    });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const ja = a.joinedAt.getTime();
    const jb = b.joinedAt.getTime();
    if (ja !== jb) return ja - jb;
    return a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0;
  });

  const ranked = scored.map((c, i) => ({ ...c, rank: i + 1 }));

  return {
    ranked,
    excluded,
    decidedBy: SCORING_FACTORS.filter((f) => decidedBy.has(f)),
  };
}

/**
 * The top N recommendations, for an "invite next N" surface.
 *
 * A THIN SLICE, ON PURPOSE, and it is not an action. It returns the same
 * ScoredCandidate objects the full ranking produced, so the reasons an operator
 * sees are the reasons the engine used. Nothing is claimed, invited or booked.
 *
 * `n` is clamped to the cohort size and floored at 0; asking for 50 out of 17
 * returns 17 rather than padding, because there is no 18th recommendation to
 * make.
 */
export function recommendNextInvites(
  result: RankingResult,
  n: number,
): readonly ScoredCandidate[] {
  if (!Number.isFinite(n) || n <= 0) return [];
  return result.ranked.slice(0, Math.floor(n));
}
