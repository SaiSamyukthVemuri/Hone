import { describe, expect, it } from "vitest";
import {
  statedAvailability,
  UNSTATED_AVAILABILITY,
} from "@/lib/waitlist/preferences";
import {
  daysBetween,
  FIFO_POLICY,
  rankWaitlistCandidates,
  recommendNextInvites,
  UNSTATED_SERVICE_INTEREST,
  validateScoringPolicy,
  type ScoringCandidate,
  type ScoringPolicy,
  type ScoringWeights,
  type StudioOpening,
} from "@/lib/waitlist/scoring";
import { instant, stalenessPolicy } from "@/lib/waitlist/validated";

// WAIT-ADMIT-01 — the ranking engine.
//
// The properties under test are the ones a wrong answer here would cost real
// people their place in a queue: FIFO must survive as the floor, an unanswered
// question must not read as a negative answer, and the order must not depend on
// the order the rows happened to arrive in.

const NOW = instant("2026-09-07T12:00:00.000Z");
const day = (n: number) => instant(NOW.getTime() - n * 86_400_000);

function candidate(
  entryId: string,
  daysAgo: number,
  availability: ScoringCandidate["availability"] = UNSTATED_AVAILABILITY,
  serviceInterest: ScoringCandidate["serviceInterest"] = UNSTATED_SERVICE_INTEREST,
): ScoringCandidate {
  return { entryId, joinedAt: day(daysAgo), availability, serviceInterest };
}

const NO_OPENINGS: StudioOpening[] = [];
const MIXED_OPENINGS: StudioOpening[] = [
  { dayClass: "weekday", serviceId: null, slots: 8 },
  { dayClass: "weekend", serviceId: null, slots: 2 },
];

// Weights are PARTIAL here on purpose: a test names only the factors it is
// exercising and every other weight stays 0, so a factor a test did not mention
// can never quietly contribute to the score it asserts.
type PolicyOverrides = Partial<Omit<ScoringPolicy, "weights">> & {
  weights?: Partial<ScoringWeights>;
};

function policy(overrides: PolicyOverrides = {}): ScoringPolicy {
  return {
    ...FIFO_POLICY,
    ...overrides,
    weights: { ...FIFO_POLICY.weights, ...(overrides.weights ?? {}) },
  };
}

describe("FIFO is the floor", () => {
  it("reproduces (joined_at, id) order exactly under the default policy", () => {
    const cohort = [
      candidate("c", 1),
      candidate("a", 10),
      candidate("b", 10),
      candidate("d", 30),
    ];
    const result = rankWaitlistCandidates(cohort, { now: NOW, openings: MIXED_OPENINGS }, FIFO_POLICY);

    // Oldest first; the 10-day tie broken by entry id, exactly as the database's
    // `order by e.joined_at, e.id` does.
    expect(result.ranked.map((r) => r.entryId)).toEqual(["d", "a", "b", "c"]);
    expect(result.ranked.every((r) => r.score === 0)).toBe(true);
    expect(result.decidedBy).toEqual([]);
  });

  it("does not depend on input order", () => {
    const cohort = [candidate("a", 10), candidate("b", 10), candidate("c", 1)];
    const forward = rankWaitlistCandidates(cohort, { now: NOW, openings: NO_OPENINGS }, FIFO_POLICY);
    const reversed = rankWaitlistCandidates(
      [...cohort].reverse(),
      { now: NOW, openings: NO_OPENINGS },
      FIFO_POLICY,
    );
    expect(forward.ranked.map((r) => r.entryId)).toEqual(reversed.ranked.map((r) => r.entryId));
  });
});

describe("configured weekday preference", () => {
  const weekdayPolicy = policy({
    preferredDayClass: "weekday",
    weights: { preferenceAlignment: 1 },
  });

  it("prefers a weekday-available candidate over an older weekend-only one", () => {
    const cohort = [
      candidate("weekend-old", 100, statedAvailability("weekends")),
      candidate("weekday-new", 1, statedAvailability("weekdays")),
    ];
    const result = rankWaitlistCandidates(cohort, { now: NOW, openings: MIXED_OPENINGS }, weekdayPolicy);
    expect(result.ranked[0]?.entryId).toBe("weekday-new");
    expect(result.decidedBy).toEqual(["preferenceAlignment"]);
  });

  it("counts 'both' as covering the preferred class", () => {
    const cohort = [
      candidate("both", 1, statedAvailability("both")),
      candidate("weekends", 100, statedAvailability("weekends")),
    ];
    const result = rankWaitlistCandidates(cohort, { now: NOW, openings: MIXED_OPENINGS }, weekdayPolicy);
    expect(result.ranked[0]?.entryId).toBe("both");
  });

  // The generality claim: the SAME engine, one config value changed, favours
  // the opposite cohort. Nothing about weekday is privileged in the code.
  it("favours weekends when the studio configures weekends", () => {
    const cohort = [
      candidate("weekday", 1, statedAvailability("weekdays")),
      candidate("weekend", 1, statedAvailability("weekends")),
    ];
    const result = rankWaitlistCandidates(
      cohort,
      { now: NOW, openings: MIXED_OPENINGS },
      policy({ preferredDayClass: "weekend", weights: { preferenceAlignment: 1 } }),
    );
    expect(result.ranked[0]?.entryId).toBe("weekend");
  });

  it("is inapplicable — not zero — when no day preference is configured", () => {
    const cohort = [candidate("a", 5, statedAvailability("weekdays"))];
    const result = rankWaitlistCandidates(
      cohort,
      { now: NOW, openings: MIXED_OPENINGS },
      policy({ preferredDayClass: null, weights: { preferenceAlignment: 1 } }),
    );
    const factor = result.ranked[0]?.factors.find((f) => f.factor === "preferenceAlignment");
    expect(factor?.outcome.kind).toBe("not_applicable");
    expect(factor?.contribution).toBeNull();
  });
});

describe("an unanswered question is not a negative answer", () => {
  const base = policy({
    preferredDayClass: "weekday",
    weights: { preferenceAlignment: 1, waitingTime: 1 },
  });

  const cohort = [
    candidate("stated-new", 1, statedAvailability("weekdays")),
    candidate("unstated-old", 180),
  ];

  it("neutral: the unanswered factor is dropped from the mean AND its denominator", () => {
    const result = rankWaitlistCandidates(
      cohort,
      { now: NOW, openings: MIXED_OPENINGS },
      policy({ ...base, unknownPolicy: "neutral" }),
    );
    const unstated = result.ranked.find((r) => r.entryId === "unstated-old");
    // Only waitingTime participated, and it was maxed — so the score is 1.0,
    // NOT 0.5. Halving it would be exactly the silent penalty this rule exists
    // to prevent.
    expect(unstated?.score).toBe(1);
    expect(result.ranked[0]?.entryId).toBe("unstated-old");
  });

  it("penalize: the unanswered factor scores 0 and participates", () => {
    const result = rankWaitlistCandidates(
      cohort,
      { now: NOW, openings: MIXED_OPENINGS },
      policy({ ...base, unknownPolicy: "penalize" }),
    );
    const unstated = result.ranked.find((r) => r.entryId === "unstated-old");
    expect(unstated?.score).toBe(0.5);
  });

  it("exclude: the candidate leaves the ranking with a stated reason", () => {
    const result = rankWaitlistCandidates(
      cohort,
      { now: NOW, openings: MIXED_OPENINGS },
      policy({ ...base, unknownPolicy: "exclude" }),
    );
    expect(result.ranked.map((r) => r.entryId)).toEqual(["stated-new"]);
    expect(result.excluded).toEqual([
      { entryId: "unstated-old", reason: "not stated: preferenceAlignment" },
    ]);
  });

  it("exclude ignores factors the studio switched off", () => {
    // preferenceAlignment weight 0 => the unstated availability is irrelevant,
    // so nobody is excluded for it.
    const result = rankWaitlistCandidates(
      cohort,
      { now: NOW, openings: MIXED_OPENINGS },
      policy({ preferredDayClass: "weekday", unknownPolicy: "exclude", weights: { waitingTime: 1 } }),
    );
    expect(result.excluded).toEqual([]);
    expect(result.ranked).toHaveLength(2);
  });
});

describe("factors with nothing to measure", () => {
  it("drops availability and capacity when the studio supplied no openings", () => {
    const result = rankWaitlistCandidates(
      [candidate("a", 10, statedAvailability("weekdays"))],
      { now: NOW, openings: NO_OPENINGS },
      policy({ weights: { availabilityCompatibility: 1, capacityFit: 1, waitingTime: 1 } }),
    );
    const factors = result.ranked[0]?.factors ?? [];
    expect(factors.find((f) => f.factor === "availabilityCompatibility")?.outcome.kind).toBe(
      "not_applicable",
    );
    expect(factors.find((f) => f.factor === "capacityFit")?.outcome.kind).toBe("not_applicable");
    expect(result.decidedBy).toEqual(["waitingTime"]);
  });

  it("ignores openings with non-positive slot counts", () => {
    const result = rankWaitlistCandidates(
      [candidate("a", 10, statedAvailability("weekdays"))],
      {
        now: NOW,
        openings: [
          { dayClass: "weekday", serviceId: null, slots: 0 },
          { dayClass: "weekend", serviceId: null, slots: -3 },
        ],
      },
      policy({ weights: { availabilityCompatibility: 1 } }),
    );
    expect(
      result.ranked[0]?.factors.find((f) => f.factor === "availabilityCompatibility")?.outcome.kind,
    ).toBe("not_applicable");
  });

  it("treats service match as inapplicable when no opening names a service", () => {
    const result = rankWaitlistCandidates(
      [candidate("a", 1, statedAvailability("both"), { stated: true, serviceIds: ["s1"] })],
      { now: NOW, openings: MIXED_OPENINGS },
      policy({ weights: { serviceCompatibility: 1 } }),
    );
    expect(
      result.ranked[0]?.factors.find((f) => f.factor === "serviceCompatibility")?.outcome.kind,
    ).toBe("not_applicable");
  });
});

describe("availability compatibility is measured against real supply", () => {
  it("scores the share of slots a candidate can actually attend", () => {
    const result = rankWaitlistCandidates(
      [
        candidate("weekday-only", 1, statedAvailability("weekdays")),
        candidate("weekend-only", 1, statedAvailability("weekends")),
        candidate("either", 1, statedAvailability("both")),
      ],
      { now: NOW, openings: MIXED_OPENINGS }, // 8 weekday, 2 weekend
      policy({ weights: { availabilityCompatibility: 1 } }),
    );
    const score = (id: string) => result.ranked.find((r) => r.entryId === id)?.score;
    expect(score("either")).toBe(1);
    expect(score("weekday-only")).toBeCloseTo(0.8, 10);
    expect(score("weekend-only")).toBeCloseTo(0.2, 10);
  });
});

describe("capacity fit prefers whoever can serve scarce capacity", () => {
  it("ranks the only weekend-available candidate above the crowded weekday pool", () => {
    const cohort = [
      candidate("wd1", 1, statedAvailability("weekdays")),
      candidate("wd2", 1, statedAvailability("weekdays")),
      candidate("wd3", 1, statedAvailability("weekdays")),
      candidate("we1", 1, statedAvailability("weekends")),
    ];
    // Equal supply on both classes, but three candidates compete for weekdays
    // and only one can take a weekend slot.
    const result = rankWaitlistCandidates(
      cohort,
      {
        now: NOW,
        openings: [
          { dayClass: "weekday", serviceId: null, slots: 2 },
          { dayClass: "weekend", serviceId: null, slots: 2 },
        ],
      },
      policy({ weights: { capacityFit: 1 } }),
    );
    expect(result.ranked[0]?.entryId).toBe("we1");
  });

  it("scores zero when the candidate cannot attend any class that has openings", () => {
    const result = rankWaitlistCandidates(
      [candidate("we", 1, statedAvailability("weekends"))],
      { now: NOW, openings: [{ dayClass: "weekday", serviceId: null, slots: 5 }] },
      policy({ weights: { capacityFit: 1 } }),
    );
    expect(result.ranked[0]?.score).toBe(0);
  });
});

describe("waiting time saturates", () => {
  it("treats everything past the cap as equally long", () => {
    const result = rankWaitlistCandidates(
      [candidate("old", 400), candidate("older", 800)],
      { now: NOW, openings: NO_OPENINGS },
      policy({ waitingTimeCapDays: 180, weights: { waitingTime: 1 } }),
    );
    expect(result.ranked.every((r) => r.score === 1)).toBe(true);
    // Both saturate, so the FIFO tie-break decides — the genuinely older entry.
    expect(result.ranked[0]?.entryId).toBe("older");
  });

  it("never reports a negative wait for a future joinedAt", () => {
    const result = rankWaitlistCandidates(
      [candidate("future", -5)],
      { now: NOW, openings: NO_OPENINGS },
      policy({ weights: { waitingTime: 1 } }),
    );
    expect(result.ranked[0]?.daysWaiting).toBe(0);
  });
});

describe("policy validation", () => {
  it("rejects a negative weight rather than clamping it", () => {
    const bad = policy({ weights: { waitingTime: -1 } });
    expect(validateScoringPolicy(bad).ok).toBe(false);
    expect(() =>
      rankWaitlistCandidates([candidate("a", 1)], { now: NOW, openings: NO_OPENINGS }, bad),
    ).toThrow(/must not be negative/);
  });

  it("rejects a non-finite weight and a non-positive cap", () => {
    expect(validateScoringPolicy(policy({ weights: { waitingTime: Number.NaN } })).ok).toBe(false);
    expect(validateScoringPolicy(policy({ waitingTimeCapDays: 0 })).ok).toBe(false);
  });
});

describe("an invalid ranking clock fails closed", () => {
  // THE DEFECT: with an unusable `context.now` every elapsed wait came out
  // non-finite, daysBetween flattened that to 0, and a waiting-time factor the
  // studio had deliberately weighted contributed an identical zero for the
  // WHOLE cohort — silently collapsing that part of the ranking to FIFO while
  // still reporting the factor as scored. A uniform wrong answer is invisible.
  const RAW_INVALID = "bad";
  const weighted = policy({ weights: { waitingTime: 1 } });

  it("refuses rather than reporting every candidate as waiting zero days", () => {
    // The refusal MOVED to the constructor: ScoringContext.now is a
    // ValidInstant, so an unreadable ranking clock cannot occupy it.
    expect(() => instant(RAW_INVALID)).toThrow(/is not a readable instant/);
  });

  it("refuses even when the cohort is empty", () => {
    // The per-candidate loop never runs here, so a boundary check inside the
    // ranker could never see it. Construction is earlier than any loop.
    expect(() => instant(RAW_INVALID)).toThrow(/is not a readable instant/);
  });

  it("cannot even be WRITTEN with a raw ranking clock", () => {
    expect(() =>
      // @ts-expect-error a raw Date is no longer admissible as a ranking clock.
      rankWaitlistCandidates([candidate("a", 5)], { now: new Date(RAW_INVALID), openings: NO_OPENINGS }, FIFO_POLICY),
    ).not.toThrow();
  });

  // THIS USED TO NEED TWO SEPARATELY PINNED LIMBS. daysBetween carried its own
  // finiteness throw and rankWaitlistCandidates carried a boundary check, so a
  // test through the ranker alone stayed green when the zero-day fallback came
  // back — the classic vacuous control. Under one owner there is one thing to
  // pin: the constructor. daysBetween needs no check because it cannot be
  // reached with a non-finite interval.
  it("daysBetween takes only operands that were already constructed valid", () => {
    expect(() => instant("bad")).toThrow(/is not a readable instant/);
    expect(daysBetween(day(30), NOW)).toBe(30);
    expect(daysBetween(NOW, NOW)).toBe(0);
  });

  it("a VALID clock still ranks exactly as before", () => {
    // The control: without it the tests above would pass against a function
    // that refuses everything.
    const result = rankWaitlistCandidates(
      [candidate("recent", 10), candidate("old", 400)],
      { now: NOW, openings: NO_OPENINGS },
      policy({ waitingTimeCapDays: 180, weights: { waitingTime: 1 } }),
    );
    expect(result.ranked[0]?.entryId).toBe("old");
    expect(result.ranked[0]?.score).toBe(1);
    expect(result.ranked[0]?.daysWaiting).toBe(400);
    expect(result.ranked[1]?.daysWaiting).toBe(10);
    expect(daysBetween(day(30), NOW)).toBe(30);
  });
});

describe("invite recommendations", () => {
  const cohort = [candidate("a", 30), candidate("b", 20), candidate("c", 10)];
  const result = () =>
    rankWaitlistCandidates(cohort, { now: NOW, openings: NO_OPENINGS }, FIFO_POLICY);

  it("returns the top N in ranked order", () => {
    expect(recommendNextInvites(result(), 2).map((r) => r.entryId)).toEqual(["a", "b"]);
  });

  it("clamps to the cohort rather than padding", () => {
    expect(recommendNextInvites(result(), 50)).toHaveLength(3);
  });

  it("returns nothing for a non-positive or non-finite N", () => {
    for (const n of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(recommendNextInvites(result(), n)).toEqual([]);
    }
  });
});
