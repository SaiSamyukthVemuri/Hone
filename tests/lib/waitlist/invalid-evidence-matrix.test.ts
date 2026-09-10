import { describe, expect, it } from "vitest";
import {
  instant,
  optionalInstant,
  stalenessPolicy,
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
    expect(instant(new Date("2026-01-01")).getTime()).toBe(Date.UTC(2026, 0, 1));
    expect(instant("2026-01-01T00:00:00.000Z").getTime()).toBe(Date.UTC(2026, 0, 1));
    expect(instant(0).getTime()).toBe(0);
    expect(optionalInstant(null)).toBeNull();
    expect(optionalInstant("2026-01-01")).not.toBeNull();
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
