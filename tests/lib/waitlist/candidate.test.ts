import { describe, expect, it } from "vitest";
import {
  projectCandidates,
  readAvailability,
  readServiceInterest,
  type WaitlistEntryRow,
} from "@/lib/waitlist/candidate";
import { NEVER_STALE, type StalenessPolicy } from "@/lib/waitlist/confirmation";
import { FIFO_POLICY, rankWaitlistCandidates } from "@/lib/waitlist/scoring";

// WAIT-ADMIT-01 — the adapter must be correct against TODAY'S schema (the
// preference columns do not exist) and against the post-migration schema, with
// no branch on which one it is looking at.

describe("today's rows, with no preference columns at all", () => {
  const rows: WaitlistEntryRow[] = [
    { id: "e1", joined_at: "2026-08-01T10:00:00.000Z" },
    { id: "e2", joined_at: "2026-07-01T10:00:00.000Z" },
  ];

  it("projects every row as not-stated rather than failing or guessing", () => {
    const { candidates, skipped } = projectCandidates(rows);
    expect(skipped).toEqual([]);
    expect(candidates).toHaveLength(2);
    for (const c of candidates) {
      expect(c.availability.stated).toBe(false);
      expect(c.serviceInterest.stated).toBe(false);
    }
  });

  it("still ranks, and the ranking is exactly FIFO", () => {
    const { candidates } = projectCandidates(rows);
    const result = rankWaitlistCandidates(
      candidates,
      { now: new Date("2026-09-07T12:00:00.000Z"), openings: [] },
      FIFO_POLICY,
    );
    expect(result.ranked.map((r) => r.entryId)).toEqual(["e2", "e1"]);
  });
});

describe("post-migration rows", () => {
  it("reads a stated preference through the same function", () => {
    const { candidates } = projectCandidates([
      {
        id: "e1",
        joined_at: "2026-08-01T10:00:00.000Z",
        availability_preference: "weekdays",
        availability_stated_at: "2026-08-01T10:00:00.000Z",
        availability_confirmed_at: "2026-08-01T10:00:00.000Z",
        service_interest_ids: ["svc-a"],
      },
    ]);
    expect(candidates[0]?.availability).toEqual({ stated: true, preference: "weekdays" });
    expect(candidates[0]?.serviceInterest).toEqual({ stated: true, serviceIds: ["svc-a"] });
  });

  it("treats an explicit null column exactly like an absent one", () => {
    const withNull = projectCandidates([
      {
        id: "e1",
        joined_at: "2026-08-01T10:00:00.000Z",
        availability_preference: null,
        service_interest_ids: null,
      },
    ]);
    const withAbsent = projectCandidates([{ id: "e1", joined_at: "2026-08-01T10:00:00.000Z" }]);
    expect(withNull.candidates).toEqual(withAbsent.candidates);
  });
});

describe("values it cannot read truthfully", () => {
  it("treats an out-of-vocabulary preference as not stated, never as a guess", () => {
    for (const raw of ["mondays", "", "ANY", 7, {}, null, undefined]) {
      expect(readAvailability(raw).stated).toBe(false);
    }
  });

  it("treats an empty service list as not stated, not as 'wants nothing'", () => {
    expect(readServiceInterest([]).stated).toBe(false);
    expect(readServiceInterest(null).stated).toBe(false);
    expect(readServiceInterest(undefined).stated).toBe(false);
  });

  it("drops non-string ids rather than passing them through", () => {
    const interest = readServiceInterest(["a", "", "b"] as readonly string[]);
    expect(interest).toEqual({ stated: true, serviceIds: ["a", "b"] });
  });
});

describe("joined_at has no honest default", () => {
  it.each([null, undefined, "", "   ", "not a date"])(
    "skips a row whose joined_at is %o rather than substituting now()",
    (joined) => {
      const { candidates, skipped } = projectCandidates([
        { id: "bad", joined_at: joined as string | null },
      ]);
      expect(candidates).toEqual([]);
      expect(skipped).toEqual([
        { entryId: "bad", reason: "joined_at is missing or unreadable" },
      ]);
    },
  );

  it("accepts a Date as well as an ISO string", () => {
    const when = new Date("2026-08-01T10:00:00.000Z");
    const { candidates } = projectCandidates([{ id: "e1", joined_at: when }]);
    expect(candidates[0]?.joinedAt.toISOString()).toBe(when.toISOString());
  });

  it("skips an Invalid Date object", () => {
    const { skipped } = projectCandidates([{ id: "e1", joined_at: new Date("nope") }]);
    expect(skipped).toHaveLength(1);
  });
});

describe("contact detail cannot cross the boundary", () => {
  it("produces exactly the ranking fields and nothing else", () => {
    const { candidates } = projectCandidates([
      {
        id: "e1",
        joined_at: "2026-08-01T10:00:00.000Z",
        // Extra columns a real row carries. The structural type permits them;
        // the projection must not copy them through.
        ...({ name: "A Person", email: "a@example.com", phone: "555" } as object),
      } as WaitlistEntryRow,
    ]);
    expect(Object.keys(candidates[0] ?? {}).sort()).toEqual([
      "availability",
      "entryId",
      "joinedAt",
      "serviceInterest",
      "waitIsMeasurable",
    ]);
  });
});

describe("provenance decides whether a wait can be scored at all", () => {
  const NOW = new Date("2026-09-07T12:00:00.000Z");

  it("marks an 'unknown' join date unmeasurable and suppresses the duration", () => {
    const { candidates, provenance } = projectCandidates([
      {
        id: "legacy",
        joined_at: "2026-09-01T00:00:00.000Z",
        joined_at_provenance: "unknown",
      },
    ]);
    expect(candidates[0]?.waitIsMeasurable).toBe(false);
    expect(provenance[0]?.durationIsMeaningful).toBe(false);
  });

  it("does not let an imported anchor out-rank a real long wait", () => {
    // The legacy entry has waited far longer in reality, but its anchor is the
    // import instant. Scoring that anchor would rank it as the NEWEST entry.
    const { candidates } = projectCandidates([
      { id: "legacy", joined_at: "2026-09-06T00:00:00.000Z", joined_at_provenance: "unknown" },
      { id: "real", joined_at: "2026-08-01T00:00:00.000Z", joined_at_provenance: "form" },
    ]);
    const result = rankWaitlistCandidates(
      candidates,
      { now: NOW, openings: [] },
      {
        ...FIFO_POLICY,
        weights: { ...FIFO_POLICY.weights, waitingTime: 1 },
      },
    );
    const legacy = result.ranked.find((r) => r.entryId === "legacy");
    expect(legacy?.daysWaiting).toBeNull();
    // waitingTime is the only weighted factor and it is unknown for the legacy
    // row, so under the default neutral policy nothing scores it — it is not
    // given a near-zero wait score it did not earn.
    const factor = legacy?.factors.find((f) => f.factor === "waitingTime");
    expect(factor?.outcome.kind).toBe("unknown");
    expect(factor?.contribution).toBeNull();
  });

  it("defaults absent provenance to 'form', which today's rows all satisfy", () => {
    const { candidates, provenance } = projectCandidates([
      { id: "e1", joined_at: "2026-08-01T00:00:00.000Z" },
    ]);
    expect(provenance[0]?.joinedAtProvenance).toBe("form");
    expect(candidates[0]?.waitIsMeasurable).toBe(true);
  });

  it("reads an unrecognised provenance conservatively as 'unknown'", () => {
    const { provenance } = projectCandidates([
      { id: "e1", joined_at: "2026-08-01T00:00:00.000Z", joined_at_provenance: "sometime" },
    ]);
    expect(provenance[0]?.joinedAtProvenance).toBe("unknown");
  });
});

describe("stale preferences reach the engine as ordinary unstated ones", () => {
  const NOW = new Date("2026-09-07T12:00:00.000Z");
  const row = {
    id: "e1",
    joined_at: "2026-01-01T00:00:00.000Z",
    availability_preference: "weekdays",
    availability_stated_at: "2025-01-01T00:00:00.000Z",
    availability_confirmed_at: "2025-01-01T00:00:00.000Z",
    availability_source: "public_form",
  };

  it("keeps it stated when nothing goes stale (the default)", () => {
    const { candidates } = projectCandidates([row]);
    expect(candidates[0]?.availability.stated).toBe(true);
  });

  it("drops it to unstated once past the configured age", () => {
    const { candidates, provenance } = projectCandidates([row], {
      now: NOW,
      staleness: { maxAgeDays: 90 },
    });
    expect(candidates[0]?.availability.stated).toBe(false);
    expect(provenance[0]?.freshness?.kind).toBe("stale");
  });

  it("keeps it stated when it was re-confirmed recently", () => {
    const { candidates } = projectCandidates(
      [{ ...row, availability_confirmed_at: "2026-09-01T00:00:00.000Z" }],
      { now: NOW, staleness: { maxAgeDays: 90 } },
    );
    expect(candidates[0]?.availability.stated).toBe(true);
  });

  it("refuses a preference stored without a timestamp", () => {
    const { candidates, provenance } = projectCandidates([
      { id: "e1", joined_at: "2026-01-01T00:00:00.000Z", availability_preference: "weekdays" },
    ]);
    expect(candidates[0]?.availability.stated).toBe(false);
    expect(provenance[0]?.freshness?.kind).toBe("inconsistent");
  });
});

describe("staleness and the clock", () => {
  const ROW = {
    id: "e1",
    joined_at: "2026-01-01T00:00:00.000Z",
    availability_preference: "weekdays",
    availability_stated_at: "2025-01-01T00:00:00.000Z",
    availability_confirmed_at: "2025-01-01T00:00:00.000Z",
    availability_source: "public_form",
  };
  const NOW = new Date("2026-09-08T00:00:00.000Z");

  /** A policy the compiler only knows as `number | null`, as a real caller has. */
  function loadPolicy(maxAgeDays: number | null): StalenessPolicy {
    return { maxAgeDays };
  }

  // THE OVERCORRECTION THIS PROVES FIXED. Requiring a LITERAL maxAgeDays
  // rejected an ordinary caller holding a runtime-loaded policy, even though it
  // supplied the clock. Refusing a correct caller is its own defect.
  it("accepts a dynamically typed StalenessPolicy when a clock is present", () => {
    const policy = loadPolicy(90);
    expect(() => projectCandidates([ROW], { now: NOW, staleness: policy })).not.toThrow();
  });

  it("evaluates a dynamic finite policy against that clock", () => {
    const policy = loadPolicy(90);
    const { candidates, provenance } = projectCandidates([ROW], { now: NOW, staleness: policy });
    // Confirmed 2025-01-01, far past a 90-day cap.
    expect(provenance[0]?.freshness?.kind).toBe("stale");
    expect(candidates[0]?.availability.stated).toBe(false);
  });

  it("accepts a dynamic DISABLED policy with a clock", () => {
    const policy = loadPolicy(null);
    const { candidates } = projectCandidates([ROW], { now: NOW, staleness: policy });
    expect(candidates[0]?.availability.stated).toBe(true);
  });

  it("keeps a recently confirmed preference fresh under the same finite cap", () => {
    const { candidates } = projectCandidates(
      [{ ...ROW, availability_confirmed_at: "2026-09-01T00:00:00.000Z" }],
      { now: NOW, staleness: loadPolicy(90) },
    );
    expect(candidates[0]?.availability.stated).toBe(true);
  });

  // THE ORIGINAL DEFECT: finite cap, no clock, silently age 0 -- every
  // preference fresh, a configured policy doing nothing, no error anywhere.
  it("REFUSES a finite cap with no clock, at compile time and at runtime", () => {
    expect(() =>
      // @ts-expect-error a finite cap without `now` must not type-check.
      projectCandidates([ROW], { staleness: { maxAgeDays: 90 } }),
    ).toThrow(/cannot be evaluated without a clock/);
  });

  it("REFUSES a dynamic policy with no clock, because finite cannot be ruled out", () => {
    const policy = loadPolicy(90);
    expect(() =>
      // @ts-expect-error `number | null` is inadmissible without a clock.
      projectCandidates([ROW], { staleness: policy }),
    ).toThrow(/cannot be evaluated without a clock/);
  });

  it("the age-zero fallback cannot return: a refused call yields no result", () => {
    // The bug was not just a wrong answer, it was a CONFIDENT one. Nothing may
    // come back from an unevaluable policy.
    let result: unknown = "untouched";
    try {
      // @ts-expect-error finite cap, no clock.
      result = projectCandidates([ROW], { staleness: { maxAgeDays: 1 } });
    } catch {
      /* expected */
    }
    expect(result).toBe("untouched");
  });

  it("requires no clock when staleness is disabled or absent", () => {
    expect(() => projectCandidates([ROW])).not.toThrow();
    expect(() => projectCandidates([ROW], { staleness: { maxAgeDays: null } })).not.toThrow();
    expect(() => projectCandidates([ROW], { staleness: NEVER_STALE })).not.toThrow();
    expect(projectCandidates([ROW]).candidates[0]?.availability.stated).toBe(true);
  });
});
