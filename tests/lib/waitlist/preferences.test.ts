import { describe, expect, it } from "vitest";
import {
  AVAILABILITY_PREFERENCES,
  coveredDayClasses,
  dayClassOfWeekday,
  parseAvailabilityPreference,
  preferenceCoversDayClass,
  statedAvailability,
  UNSTATED_AVAILABILITY,
} from "@/lib/waitlist/preferences";

// WAIT-ADMIT-01 — the vocabulary, and the one property that matters most:
// "we never asked" must be impossible to read as an answer.

describe("availability vocabulary", () => {
  it("offers exactly three values, in operator-facing order", () => {
    expect(AVAILABILITY_PREFERENCES).toEqual(["weekdays", "weekends", "both"]);
  });

  it("parses exact members after trim and lowercase", () => {
    expect(parseAvailabilityPreference("weekdays")).toBe("weekdays");
    expect(parseAvailabilityPreference("  WEEKENDS ")).toBe("weekends");
    expect(parseAvailabilityPreference("Both")).toBe("both");
  });

  // The point of the refusal list: each of these is something a human would
  // plausibly type, and translating any of them into a stated preference would
  // be this module inventing an answer on the prospect's behalf.
  it.each(["", "   ", "any", "flexible", "n/a", "weekday", "weekends only", "0"])(
    "refuses %o rather than guessing",
    (raw) => {
      expect(parseAvailabilityPreference(raw)).toBeNull();
    },
  );

  it("refuses non-strings", () => {
    for (const raw of [null, undefined, 3, {}, [], true]) {
      expect(parseAvailabilityPreference(raw)).toBeNull();
    }
  });
});

describe("unstated availability", () => {
  it("carries no preference field to misread", () => {
    expect(UNSTATED_AVAILABILITY.stated).toBe(false);
    expect(Object.hasOwn(UNSTATED_AVAILABILITY, "preference")).toBe(false);
  });

  it("is distinguishable from every stated value", () => {
    for (const p of AVAILABILITY_PREFERENCES) {
      expect(statedAvailability(p).stated).toBe(true);
      expect(UNSTATED_AVAILABILITY).not.toEqual(statedAvailability(p));
    }
  });
});

describe("day classification", () => {
  it("treats Saturday and Sunday as the weekend", () => {
    expect(dayClassOfWeekday(0)).toBe("weekend");
    expect(dayClassOfWeekday(6)).toBe("weekend");
    for (const d of [1, 2, 3, 4, 5]) expect(dayClassOfWeekday(d)).toBe("weekday");
  });

  it("returns null for anything outside 0..6", () => {
    for (const d of [-1, 7, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(dayClassOfWeekday(d)).toBeNull();
    }
  });
});

describe("coverage rules", () => {
  it("is total over the vocabulary", () => {
    expect(preferenceCoversDayClass("weekdays", "weekday")).toBe(true);
    expect(preferenceCoversDayClass("weekdays", "weekend")).toBe(false);
    expect(preferenceCoversDayClass("weekends", "weekend")).toBe(true);
    expect(preferenceCoversDayClass("weekends", "weekday")).toBe(false);
    expect(preferenceCoversDayClass("both", "weekday")).toBe(true);
    expect(preferenceCoversDayClass("both", "weekend")).toBe(true);
  });

  it("agrees with the set form", () => {
    for (const p of AVAILABILITY_PREFERENCES) {
      const covered = coveredDayClasses(p);
      for (const dc of ["weekday", "weekend"] as const) {
        expect(covered.includes(dc)).toBe(preferenceCoversDayClass(p, dc));
      }
    }
  });
});
