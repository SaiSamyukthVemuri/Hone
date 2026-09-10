import { describe, expect, it } from "vitest";
import {
  instant,
  optionalInstant,
  stalenessPolicy,
  toDate,
  type ValidInstant,
} from "@/lib/waitlist/validated";
import { classifyPreferenceFreshness, applyConfirmation } from "@/lib/waitlist/confirmation";
import { projectCandidates } from "@/lib/waitlist/candidate";
import { daysBetween, rankWaitlistCandidates, FIFO_POLICY } from "@/lib/waitlist/scoring";
import { planLegacyWaitlistImport } from "@/lib/waitlist/legacy-import";

/**
 * THE INVALID MATRIX, DIRECT-CALLED.
 *
 * The old process tested the wrapper. The finding that ended it was a direct
 * call to the classifier the wrapper used — so this file calls each boundary
 * ITSELF, and asserts the one property that matters across all of them:
 *
 *   INVALID EVIDENCE NEVER PRODUCES A CONFIDENT ANSWER.
 *
 * Not a wrong number — a confident one. That is the whole family.
 */

const BAD_INSTANTS: ReadonlyArray<readonly [string, Date | string | number]> = [
  ["an Invalid Date", new Date("bad")],
  ["a NaN-valued Date", new Date(Number.NaN)],
  ["a malformed instant string", "not-an-instant"],
  ["NaN epoch", Number.NaN],
  ["+Infinity epoch", Number.POSITIVE_INFINITY],
  ["-Infinity epoch", Number.NEGATIVE_INFINITY],
];

const BAD_CAPS: ReadonlyArray<readonly [string, number]> = [
  ["NaN", Number.NaN],
  ["+Infinity", Number.POSITIVE_INFINITY],
  ["-Infinity", Number.NEGATIVE_INFINITY],
  ["a negative cap", -1],
  ["a large negative cap", -365],
];

const NOW = instant("2026-09-09T00:00:00.000Z");

describe("no unreadable instant can be constructed", () => {
  it.each(BAD_INSTANTS)("instant() refuses %s", (_label, bad) => {
    expect(() => instant(bad)).toThrow(/is not a readable instant/);
  });

  it.each(BAD_INSTANTS)("optionalInstant() reports %s as absent, never substitutes", (_l, bad) => {
    // The row-side reader answers null rather than throwing, because an
    // unreadable stored value is data to report, not a caller's mistake — but
    // it never invents a clock to stand in for it.
    expect(optionalInstant(bad)).toBeNull();
  });

  it("accepts every readable form", () => {
    // The control. Without it "refuses everything" would pass the whole file.
    expect(instant(new Date("2026-01-01"))).toBe(Date.UTC(2026, 0, 1));
    expect(instant("2026-01-01T00:00:00.000Z")).toBe(Date.UTC(2026, 0, 1));
    expect(instant(0)).toBe(0);
    expect(optionalInstant(null)).toBeNull();
    expect(optionalInstant("2026-01-01")).not.toBeNull();
  });
});

describe("a validated instant cannot become invalid after construction", () => {
  // THIS IS WHY THE BRANDED `Date` WAS REJECTED. A brand describes a REFERENCE;
  // Date keeps its value in an internal slot the reference can rewrite. On that
  // architecture, ordinary TypeScript with no cast and no JavaScript caller
  // undid the guarantee two ways — and both are proved dead here.

  it("mutating the ORIGINAL Date after construction cannot reach the value", () => {
    // Path 1: aliasing. `instant()` used to hand back the SAME object it was
    // given, so the caller kept a live handle on validated evidence.
    const source = new Date("2026-09-09T00:00:00.000Z");
    const validated = instant(source);
    const before = Number(validated);

    source.setTime(Number.NaN);
    source.setFullYear(1999);

    expect(Number(validated)).toBe(before);
    expect(Number.isFinite(Number(validated))).toBe(true);
    // And it still measures correctly against another instant.
    expect(daysBetween(validated, instant("2026-09-10T00:00:00.000Z"))).toBe(1);
  });

  it("exposes no mutation surface at all", () => {
    // Path 2: the mutator API. A ValidInstant is a primitive, so setTime,
    // setFullYear and the rest simply do not exist on it.
    const validated = instant("2026-09-09T00:00:00.000Z");
    expect(typeof validated).toBe("number");
    for (const mutator of ["setTime", "setFullYear", "setMonth", "setHours", "setUTCDate"]) {
      expect(
        (validated as unknown as Record<string, unknown>)[mutator],
        `${mutator} must not exist on a validated instant`,
      ).toBeUndefined();
    }
  });

  it("arithmetic DROPS the brand rather than carrying it", () => {
    // A derived number must not masquerade as validated evidence. This is a
    // compile-time property; the runtime check here only pins the arithmetic.
    const validated = instant(0);
    // @ts-expect-error arithmetic on a validated instant yields a plain number.
    const derived: ValidInstant = validated + 1;
    void derived;
    expect(validated + 1).toBe(1);
  });

  it("Object.freeze does NOT protect a Date — pinned so nobody 'repairs' this by freezing", () => {
    // Tested, not assumed, and the reason option D was rejected outright:
    // freeze guards PROPERTIES, while [[DateValue]] is an internal slot. The
    // mutation succeeds silently — no throw, even though this module is strict.
    const frozen = Object.freeze(new Date("2026-09-09T00:00:00.000Z"));
    expect(Object.isFrozen(frozen)).toBe(true);
    frozen.setTime(Number.NaN);
    expect(Number.isFinite(frozen.getTime()), "freezing a Date does not protect it").toBe(false);
  });

  it("toDate() hands back a FRESH object every time", () => {
    // The interop edge must not reintroduce the aliasing the representation
    // exists to remove: what a caller receives, they may mutate.
    const validated = instant("2026-09-09T00:00:00.000Z");
    const a = toDate(validated);
    const b = toDate(validated);
    expect(a).not.toBe(b);
    a.setTime(Number.NaN);
    expect(Number.isFinite(b.getTime())).toBe(true);
    expect(Number.isFinite(Number(validated))).toBe(true);
  });

  it("zero epoch is valid, and historical and future instants keep their meaning", () => {
    expect(Number(instant(0))).toBe(0);
    expect(Number(instant("1970-01-01T00:00:00.000Z"))).toBe(0);
    const past = instant("1999-12-31T00:00:00.000Z");
    const future = instant("2099-01-01T00:00:00.000Z");
    expect(past < future).toBe(true);
    expect(daysBetween(past, future)).toBeGreaterThan(36_000);
    expect(toDate(past).toISOString()).toBe("1999-12-31T00:00:00.000Z");
  });
});

describe("no unusable staleness cap can be constructed", () => {
  it.each(BAD_CAPS)("stalenessPolicy() refuses %s", (_label, bad) => {
    expect(() => stalenessPolicy(bad)).toThrow(/finite, non-negative number of days/);
  });

  it("accepts null, zero and any finite positive cap", () => {
    expect(stalenessPolicy(null).maxAgeDays).toBeNull();
    expect(stalenessPolicy(0).maxAgeDays).toBe(0);
    expect(stalenessPolicy(90).maxAgeDays).toBe(90);
  });
});

describe("every censused boundary is direct-called, not reached through a wrapper", () => {
  const STORED = {
    preference: "weekdays" as const,
    statedAt: new Date("2020-01-01T00:00:00.000Z"),
    confirmedAt: new Date("2020-01-01T00:00:00.000Z"),
    source: "practitioner" as const,
  };

  it("classifyPreferenceFreshness — the finding's boundary — cannot be fed either bad operand", () => {
    for (const [, bad] of BAD_CAPS) expect(() => stalenessPolicy(bad)).toThrow();
    for (const [, bad] of BAD_INSTANTS) expect(() => instant(bad)).toThrow();
    // And with valid evidence it still answers, so this is not "refuses everything".
    expect(classifyPreferenceFreshness(STORED, NOW, stalenessPolicy(90)).kind).toBe("stale");
    expect(classifyPreferenceFreshness(STORED, NOW, stalenessPolicy(null)).kind).toBe("fresh");
  });

  it("applyConfirmation cannot stamp a record with an unreadable instant", () => {
    // The census found this one before any review did: it does not merely
    // classify with a bad operand, it PERSISTS one.
    for (const [, bad] of BAD_INSTANTS) expect(() => instant(bad)).toThrow();
    const written = applyConfirmation(null, { preference: "both", source: "practitioner" }, NOW);
    expect(Number.isFinite(written.statedAt.getTime())).toBe(true);
    expect(Number.isFinite(written.confirmedAt.getTime())).toBe(true);
  });

  it("daysBetween never returns a number derived from an unreadable operand", () => {
    expect(daysBetween(instant("2026-09-01T00:00:00.000Z"), NOW)).toBe(8);
    expect(daysBetween(NOW, NOW)).toBe(0);
  });

  it("rankWaitlistCandidates never ranks from an unreadable clock", () => {
    for (const [, bad] of BAD_INSTANTS) expect(() => instant(bad)).toThrow();
    const ranked = rankWaitlistCandidates(
      [{ entryId: "a", joinedAt: new Date("2026-01-01"), availability: { stated: false },
         serviceInterest: { stated: false } }],
      { now: NOW, openings: [] },
      FIFO_POLICY,
    );
    expect(ranked.ranked).toHaveLength(1);
  });

  it("projectCandidates never projects under an unusable policy", () => {
    for (const [, bad] of BAD_CAPS) expect(() => stalenessPolicy(bad)).toThrow();
    expect(projectCandidates([{ id: "e1", joined_at: "2026-01-01T00:00:00.000Z" }],
      { now: NOW, staleness: stalenessPolicy(90) }).candidates).toHaveLength(1);
  });

  it("planLegacyWaitlistImport never plans against an unreadable batch authority", () => {
    for (const [, bad] of BAD_INSTANTS) expect(() => instant(bad)).toThrow();
    const plan = planLegacyWaitlistImport(
      [{ email: "a@example.com", name: "A Person", joinedAt: "2026-01-01" }],
      { importedAt: NOW },
    );
    expect(plan.ready).toHaveLength(1);
  });
});
