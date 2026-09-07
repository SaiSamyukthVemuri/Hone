import { describe, expect, it } from "vitest";
import { parseScoringPolicy, serializeScoringPolicy } from "@/lib/waitlist/policy";
import { FIFO_POLICY, SCORING_FACTORS, type ScoringPolicy } from "@/lib/waitlist/scoring";

// WAIT-ADMIT-01 — the parse rules that make a future policy column safe to add.
//
// The distinction under test throughout: ABSENT means FIFO, MALFORMED means
// refuse. Collapsing them would let a corrupt document silently reorder a
// studio's queue while the operator believes their policy is running.

const VALID: ScoringPolicy = {
  weights: {
    availabilityCompatibility: 2,
    preferenceAlignment: 1,
    waitingTime: 0.5,
    serviceCompatibility: 0,
    capacityFit: 0,
  },
  preferredDayClass: "weekday",
  unknownPolicy: "penalize",
  waitingTimeCapDays: 90,
};

describe("absent means FIFO", () => {
  it.each([null, undefined])("returns the default policy for %o", (raw) => {
    const result = parseScoringPolicy(raw);
    expect(result).toEqual({ ok: true, value: FIFO_POLICY, usedDefault: true });
  });

  it("marks an explicitly-stored FIFO document as NOT the default", () => {
    const result = parseScoringPolicy(serializeScoringPolicy(FIFO_POLICY));
    expect(result.ok && result.usedDefault).toBe(false);
    expect(result.ok && result.value).toEqual(FIFO_POLICY);
  });
});

describe("malformed means refuse", () => {
  it.each([
    [42, "must be an object"],
    ["{}", "must be an object"],
    [[], "must be an object"],
    [{ weights: 3 }, "weights must be an object"],
    [{ weights: { waitingTime: "1" } }, "waitingTime must be a finite number"],
    [{ weights: { waitingTime: Number.NaN } }, "waitingTime must be a finite number"],
    [{ weights: { waitingTime: -1 } }, "must not be negative"],
    [{ preferredDayClass: "tuesday" }, "preferredDayClass"],
    [{ unknownPolicy: "ignore" }, "unknownPolicy"],
    [{ waitingTimeCapDays: 0 }, "waitingTimeCapDays"],
    [{ waitingTimeCapDays: -5 }, "waitingTimeCapDays"],
  ])("refuses %o", (raw, expected) => {
    const result = parseScoringPolicy(raw);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain(expected);
  });

  it("never silently substitutes FIFO for a corrupt document", () => {
    const result = parseScoringPolicy({ weights: { waitingTime: -1 } });
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty("value");
  });
});

describe("forward and backward compatibility", () => {
  it("ignores an unrecognised factor from a later version", () => {
    const result = parseScoringPolicy({
      weights: { waitingTime: 1, someFutureFactor: 99 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.weights.waitingTime).toBe(1);
    expect(Object.keys(result.value.weights).sort()).toEqual([...SCORING_FACTORS].sort());
  });

  it("treats a factor missing from the document as switched off", () => {
    const result = parseScoringPolicy({ weights: { waitingTime: 1 } });
    expect(result.ok && result.value.weights.capacityFit).toBe(0);
  });

  it("fills absent top-level fields from the default rather than failing", () => {
    const result = parseScoringPolicy({ weights: { waitingTime: 1 } });
    expect(result.ok && result.value.unknownPolicy).toBe(FIFO_POLICY.unknownPolicy);
    expect(result.ok && result.value.waitingTimeCapDays).toBe(FIFO_POLICY.waitingTimeCapDays);
    expect(result.ok && result.value.preferredDayClass).toBeNull();
  });
});

describe("round trip", () => {
  it("parse(serialize(p)) === p", () => {
    for (const policy of [FIFO_POLICY, VALID]) {
      const result = parseScoringPolicy(serializeScoringPolicy(policy));
      expect(result.ok && result.value).toEqual(policy);
    }
  });

  it("serializes every known factor explicitly, including zeros", () => {
    const doc = serializeScoringPolicy(VALID);
    expect(Object.keys(doc.weights).sort()).toEqual([...SCORING_FACTORS].sort());
    expect(doc.weights.serviceCompatibility).toBe(0);
  });

  it("survives a JSON round trip, as a jsonb column would impose", () => {
    const doc = JSON.parse(JSON.stringify(serializeScoringPolicy(VALID)));
    expect(parseScoringPolicy(doc)).toEqual({ ok: true, value: VALID, usedDefault: false });
  });
});
