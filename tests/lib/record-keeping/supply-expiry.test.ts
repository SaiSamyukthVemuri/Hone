import { describe, expect, it } from "vitest";
import {
  SUPPLY_EXPIRING_WITHIN_DAYS,
  supplyExpiryState,
  supplyExpiryLabel,
  supplyExpiryPrintMarker,
  summarizeSupplyExpiry,
  supplyExpiryHorizon,
} from "@/lib/record-keeping/expiry";

// PR #316. Pure sterile-item / probe-lot expiry state (Chloe feedback:
// expired = red, within 30 days = amber). Display-only over the existing
// expiry_date column; deterministic (today passed in).

const TODAY = "2026-07-02";

describe("supplyExpiryState", () => {
  it("null / blank expiry is neutral", () => {
    expect(supplyExpiryState(null, TODAY)).toBe("neutral");
    expect(supplyExpiryState("", TODAY)).toBe("neutral");
    expect(supplyExpiryState(undefined, TODAY)).toBe("neutral");
  });
  it("strictly before today is expired", () => {
    expect(supplyExpiryState("2026-07-01", TODAY)).toBe("expired");
    expect(supplyExpiryState("2020-01-01", TODAY)).toBe("expired");
  });
  it("today itself is its own 'today' state (PR #317 parity)", () => {
    expect(supplyExpiryState("2026-07-02", TODAY)).toBe("today");
    expect(supplyExpiryState("2026-07-02T00:00:00Z", TODAY)).toBe("today");
  });
  it("within 30 days (inclusive) is expiring", () => {
    expect(supplyExpiryState("2026-07-10", TODAY)).toBe("expiring");
    expect(supplyExpiryState("2026-08-01", TODAY)).toBe("expiring"); // +30 exactly
  });
  it("beyond 30 days is neutral", () => {
    expect(supplyExpiryState("2026-08-02", TODAY)).toBe("neutral"); // +31
    expect(supplyExpiryState("2027-01-01", TODAY)).toBe("neutral");
  });
  it("tolerates timestamp-form dates by taking the date part", () => {
    expect(supplyExpiryState("2026-07-01T00:00:00Z", TODAY)).toBe("expired");
  });
});

describe("supplyExpiryLabel + supplyExpiryPrintMarker (PR #317)", () => {
  it("labels each state (null for neutral)", () => {
    expect(supplyExpiryLabel("expired")).toBe("Expired");
    expect(supplyExpiryLabel("today")).toBe("Expires today");
    expect(supplyExpiryLabel("expiring")).toBe("Expires soon");
    expect(supplyExpiryLabel("neutral")).toBeNull();
  });
  it("print marker is a lowercased parenthetical suffix (empty when neutral/null)", () => {
    expect(supplyExpiryPrintMarker("2026-06-01", TODAY)).toBe(" (expired)");
    expect(supplyExpiryPrintMarker("2026-07-02", TODAY)).toBe(" (expires today)");
    expect(supplyExpiryPrintMarker("2026-07-15", TODAY)).toBe(" (expires soon)");
    expect(supplyExpiryPrintMarker("2027-01-01", TODAY)).toBe("");
    expect(supplyExpiryPrintMarker(null, TODAY)).toBe("");
  });
});

describe("summarizeSupplyExpiry (banner counts)", () => {
  it("counts expired and expiring separately; 'today' folds into expiring; ignores neutral/null", () => {
    const rows = [
      { expiry_date: "2026-06-01" }, // expired
      { expiry_date: "2026-07-01" }, // expired
      { expiry_date: "2026-07-02" }, // today → counts as expiring (within 30d)
      { expiry_date: "2026-07-15" }, // expiring
      { expiry_date: "2027-01-01" }, // neutral
      { expiry_date: null }, // neutral
    ];
    expect(summarizeSupplyExpiry(rows, TODAY)).toEqual({ expired: 2, expiring: 2 });
  });
  it("all-clear yields zero counts", () => {
    expect(
      summarizeSupplyExpiry([{ expiry_date: null }, { expiry_date: "2030-01-01" }], TODAY),
    ).toEqual({ expired: 0, expiring: 0 });
  });
});

describe("supplyExpiryHorizon", () => {
  it("is today + N days (the query upper bound)", () => {
    expect(SUPPLY_EXPIRING_WITHIN_DAYS).toBe(30);
    expect(supplyExpiryHorizon(TODAY)).toBe("2026-08-01");
    expect(supplyExpiryHorizon(TODAY, 7)).toBe("2026-07-09");
  });
});
