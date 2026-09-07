import { describe, expect, it } from "vitest";
import {
  applyConfirmation,
  classifyPreferenceFreshness,
  NEVER_STALE,
  preferenceIsActionable,
  type StoredPreference,
} from "@/lib/waitlist/confirmation";

// WAIT-ADMIT-01 — why the schema needs TWO timestamps, proved by the two things
// a single one cannot do.

const NOW = new Date("2026-09-07T12:00:00.000Z");
const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000);

const stored = (statedDaysAgo: number, confirmedDaysAgo: number): StoredPreference => ({
  preference: "weekdays",
  statedAt: ago(statedDaysAgo),
  confirmedAt: ago(confirmedDaysAgo),
  source: "public_form",
});

describe("age is measured from confirmedAt, not statedAt", () => {
  it("keeps a long-held but recently re-confirmed preference fresh", () => {
    // Stated 240 days ago, re-confirmed 5 days ago. A single timestamp could
    // not represent this without destroying one of the two facts.
    const result = classifyPreferenceFreshness(stored(240, 5), NOW, { maxAgeDays: 90 });
    expect(result).toEqual({ kind: "fresh", ageDays: 5 });
  });

  it("ages out a preference nobody has re-confirmed", () => {
    const result = classifyPreferenceFreshness(stored(240, 240), NOW, { maxAgeDays: 90 });
    expect(result.kind).toBe("stale");
    expect(result.kind === "stale" && result.ageDays).toBe(240);
  });

  it("treats exactly-at-the-cap as still fresh", () => {
    expect(classifyPreferenceFreshness(stored(90, 90), NOW, { maxAgeDays: 90 }).kind).toBe(
      "fresh",
    );
  });
});

describe("nothing goes stale by default", () => {
  it("keeps an ancient preference fresh under NEVER_STALE", () => {
    const result = classifyPreferenceFreshness(stored(5000, 5000), NOW, NEVER_STALE);
    expect(result.kind).toBe("fresh");
  });
});

describe("an inconsistent pair is surfaced, never repaired", () => {
  it("refuses a confirmation that predates the value it confirms", () => {
    const result = classifyPreferenceFreshness(stored(5, 40), NOW, NEVER_STALE);
    expect(result).toEqual({ kind: "inconsistent", detail: "confirmedAt precedes statedAt" });
  });

  it("refuses an invalid instant", () => {
    const bad: StoredPreference = {
      preference: "both",
      statedAt: new Date("nope"),
      confirmedAt: NOW,
      source: "public_form",
    };
    expect(classifyPreferenceFreshness(bad, NOW, NEVER_STALE).kind).toBe("inconsistent");
  });
});

describe("only fresh preferences are actionable", () => {
  it.each([
    [{ kind: "fresh", ageDays: 1 } as const, true],
    [{ kind: "stale", ageDays: 400 } as const, false],
    [{ kind: "inconsistent", detail: "x" } as const, false],
  ])("%o -> %o", (freshness, expected) => {
    expect(preferenceIsActionable(freshness)).toBe(expected);
  });
});

describe("applying a confirmation", () => {
  const current = stored(200, 200);

  it("moves ONLY confirmedAt when the answer is unchanged", () => {
    const next = applyConfirmation(current, { preference: "weekdays", source: "prospect_link" }, NOW);
    expect(next.statedAt).toEqual(current.statedAt);
    expect(next.confirmedAt).toEqual(NOW);
    expect(next.preference).toBe("weekdays");
  });

  it("moves BOTH when the answer changes, because that is a new statement", () => {
    const next = applyConfirmation(current, { preference: "weekends", source: "practitioner" }, NOW);
    expect(next.statedAt).toEqual(NOW);
    expect(next.confirmedAt).toEqual(NOW);
    expect(next.preference).toBe("weekends");
  });

  it("seeds both when there was no prior preference", () => {
    const next = applyConfirmation(null, { preference: "both", source: "public_form" }, NOW);
    expect(next.statedAt).toEqual(NOW);
    expect(next.confirmedAt).toEqual(NOW);
  });

  it("records the freshest route, so provenance describes the newest evidence", () => {
    const next = applyConfirmation(current, { preference: "weekdays", source: "practitioner" }, NOW);
    expect(next.source).toBe("practitioner");
  });

  it("never produces a pair classifyPreferenceFreshness would call inconsistent", () => {
    for (const answer of ["weekdays", "weekends", "both"] as const) {
      const next = applyConfirmation(current, { preference: answer, source: "public_form" }, NOW);
      expect(classifyPreferenceFreshness(next, NOW, NEVER_STALE).kind).toBe("fresh");
    }
  });
});
