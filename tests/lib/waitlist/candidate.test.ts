import { describe, expect, it } from "vitest";
import {
  projectCandidates,
  readAvailability,
  readServiceInterest,
  type WaitlistEntryRow,
} from "@/lib/waitlist/candidate";
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
  it("produces exactly the four ranking fields and nothing else", () => {
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
    ]);
  });
});
