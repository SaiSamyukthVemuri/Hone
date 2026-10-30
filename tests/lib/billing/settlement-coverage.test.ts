import { describe, expect, it } from "vitest";
import { settlementCoverage } from "@/lib/billing/settlement-coverage";

// HON-45: a recorded external payment smaller than the quoted visit price must
// not read as the visit being paid. Display fact only: no status, balance or
// total is invented, and nothing is written.
describe("settlementCoverage", () => {
  it("full: collected equals or exceeds the quote", () => {
    expect(settlementCoverage("paid_cash", 10000, 10000)).toEqual({ kind: "full" });
    expect(settlementCoverage("paid_e_transfer", 12000, 10000)).toEqual({ kind: "full" });
  });
  it("part: collected is below the quote, with the shortfall", () => {
    expect(settlementCoverage("paid_cash", 2000, 10000)).toEqual({
      kind: "part", collectedCents: 2000, quotedCents: 10000, shortfallCents: 8000,
    });
    expect(settlementCoverage("paid_other_external", 0, 10000).kind).toBe("part");
  });
  it("unknown: no quote on record is never assumed full", () => {
    expect(settlementCoverage("paid_cash", 2000, null)).toEqual({ kind: "unknown" });
  });
  it("only money-collected methods are assessed", () => {
    expect(settlementCoverage("still_owes", 10000, 10000)).toEqual({ kind: "not_applicable" });
    expect(settlementCoverage("waived", 0, 10000)).toEqual({ kind: "not_applicable" });
  });
});
