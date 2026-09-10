import { describe, expect, it } from "vitest";
import { statedAvailability, UNSTATED_AVAILABILITY } from "@/lib/waitlist/preferences";
import { explainCandidate, explainRanking } from "@/lib/waitlist/explain";
import {
  FIFO_POLICY,
  rankWaitlistCandidates,
  SCORING_FACTORS,
  UNSTATED_SERVICE_INTEREST,
  type ScoringCandidate,
  type ScoringPolicy,
  type StudioOpening,
} from "@/lib/waitlist/scoring";
import { instant, stalenessPolicy } from "@/lib/waitlist/validated";
import { toDate } from "@/lib/waitlist/validated";

// WAIT-ADMIT-01 — the explanation is the audit trail for a decision about who
// is offered capacity first. It must be byte-stable and must carry no contact
// detail.

const NOW = instant("2026-09-07T12:00:00.000Z");
const day = (n: number) => new Date(NOW - n * 86_400_000);

const OPENINGS: StudioOpening[] = [
  { dayClass: "weekday", serviceId: null, slots: 8 },
  { dayClass: "weekend", serviceId: null, slots: 2 },
];

const COHORT: ScoringCandidate[] = [
  {
    entryId: "entry-1",
    joinedAt: day(40),
    availability: statedAvailability("weekdays"),
    serviceInterest: UNSTATED_SERVICE_INTEREST,
  },
  {
    entryId: "entry-2",
    joinedAt: day(12),
    availability: statedAvailability("weekends"),
    serviceInterest: UNSTATED_SERVICE_INTEREST,
  },
  {
    entryId: "entry-3",
    joinedAt: day(3),
    availability: UNSTATED_AVAILABILITY,
    serviceInterest: UNSTATED_SERVICE_INTEREST,
  },
];

const POLICY: ScoringPolicy = {
  ...FIFO_POLICY,
  preferredDayClass: "weekday",
  weights: {
    ...FIFO_POLICY.weights,
    availabilityCompatibility: 2,
    preferenceAlignment: 1,
    waitingTime: 1,
  },
};

const rank = () => rankWaitlistCandidates(COHORT, { now: NOW, openings: OPENINGS }, POLICY);

describe("determinism", () => {
  it("renders byte-identical text across repeated runs", () => {
    const a = explainRanking(rank(), POLICY).text;
    const b = explainRanking(rank(), POLICY).text;
    expect(a).toBe(b);
  });

  it("is unaffected by the order candidates were supplied in", () => {
    const forward = explainRanking(
      rankWaitlistCandidates(COHORT, { now: NOW, openings: OPENINGS }, POLICY),
      POLICY,
    ).text;
    const reversed = explainRanking(
      rankWaitlistCandidates([...COHORT].reverse(), { now: NOW, openings: OPENINGS }, POLICY),
      POLICY,
    ).text;
    expect(forward).toBe(reversed);
  });

  it("emits factors in the fixed SCORING_FACTORS order, not the engine's", () => {
    const explained = explainCandidate(rank().ranked[0]!);
    expect(explained.factors.map((f) => f.factor)).toEqual([...SCORING_FACTORS]);
  });
});

describe("what the text says", () => {
  const text = () => explainRanking(rank(), POLICY).text;

  it("names the policy and the unknown-handling rule up front", () => {
    expect(text()).toContain("Policy: ranked by");
    expect(text()).toContain("Studio prefers weekday-available candidates.");
    expect(text()).toContain("Prospects who did not state a factor: neutral.");
  });

  it("says a prospect was never asked instead of hiding the line", () => {
    const explained = explainRanking(rank(), POLICY);
    const three = explained.candidates.find((c) => c.entryId === "entry-3");
    const availability = three?.factors.find((f) => f.factor === "availabilityCompatibility");
    expect(availability?.status).toBe("not_stated");
    expect(explained.text).toContain("Availability: not stated");
  });

  it("omits factors the studio switched off", () => {
    // serviceCompatibility and capacityFit both carry weight 0 in POLICY.
    expect(text()).not.toContain("Service match:");
    expect(text()).not.toContain("Capacity fit:");
  });

  it("says queue order decided when no factor applied", () => {
    const fifo = rankWaitlistCandidates(COHORT, { now: NOW, openings: OPENINGS }, FIFO_POLICY);
    const explained = explainRanking(fifo, FIFO_POLICY);
    expect(explained.text).toContain("no active ranking factors");
    expect(explained.candidates[0]?.summary).toContain("Queue order");
    expect(explained.candidates[0]?.summary).toContain("no ranking factor applied");
  });
});

describe("no contact detail can reach the output", () => {
  it("mentions only entry ids", () => {
    const explained = explainRanking(rank(), POLICY);
    for (const id of ["entry-1", "entry-2", "entry-3"]) {
      expect(explained.text).toContain(id);
    }
    // The engine is never handed a name, email or phone, so the rendered text
    // cannot contain one. This asserts the shape rather than a blocklist.
    for (const c of explained.candidates) {
      expect(Object.keys(c)).toEqual([
        "entryId",
        "rank",
        "score",
        "daysWaiting",
        "factors",
        "summary",
      ]);
    }
  });

  it("never renders a negative zero", () => {
    const zeroed = rankWaitlistCandidates(
      [
        {
          entryId: "z",
          joinedAt: toDate(NOW),
          availability: statedAvailability("weekends"),
          serviceInterest: UNSTATED_SERVICE_INTEREST,
        },
      ],
      { now: NOW, openings: [{ dayClass: "weekday", serviceId: null, slots: 4 }] },
      { ...FIFO_POLICY, weights: { ...FIFO_POLICY.weights, capacityFit: 1 } },
    );
    expect(explainRanking(zeroed, FIFO_POLICY).text).not.toContain("-0.00");
  });
});

describe("excluded candidates are reported, not dropped silently", () => {
  it("lists them with their reason", () => {
    const excluding: ScoringPolicy = { ...POLICY, unknownPolicy: "exclude" };
    const explained = explainRanking(
      rankWaitlistCandidates(COHORT, { now: NOW, openings: OPENINGS }, excluding),
      excluding,
    );
    expect(explained.excluded).toEqual([
      {
        entryId: "entry-3",
        reason: "not stated: availabilityCompatibility, preferenceAlignment",
      },
    ]);
    expect(explained.text).toContain("Excluded:");
  });
});
