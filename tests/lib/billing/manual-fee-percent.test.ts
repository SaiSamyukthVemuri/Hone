import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  computePercentFee,
  describeFeeAmount,
  fixedFeeCentsIssue,
  formatBasisPoints,
  manualFeeConfigIssue,
  parsePercentTextToBp,
  noFeeOwedMessage,
  percentFeeRefusalMessage,
  roundHalfUpPercentCents,
} from "@/lib/billing/manual-fee-percent";
import { MANUAL_FEE_AMOUNT_CEILING_CENTS } from "@/lib/billing/manual-fee-types";

// The rule under test (stated once, in the module and the PR body): fee = floor((basis * bp + 5000) / 10000), integer
// arithmetic, rounded ONCE to the cent, half-up. Cents are never rounded to whole dollars.

describe("rounding: half-up to the cent, in integer arithmetic", () => {
  // [basis cents, bp, expected cents, exact value]
  const cases: Array<[number, number, number, string]> = [
    [1, 7500, 1, "0.75 -> 1"],
    [2, 7500, 2, "1.5 -> 2 (the .5 boundary rounds UP)"],
    [3, 7500, 2, "2.25 -> 2"],
    [9999, 7500, 7499, "7499.25 -> 7499"],
    [12345, 7500, 9259, "9258.75 -> 9259"],
    [12000, 7500, 9000, "exact: 120.00 -> 90.00"],
    [10001, 5000, 5001, "5000.5 -> 5001 (.5 boundary up)"],
    [10003, 5000, 5002, "5001.5 -> 5002 (.5 boundary up)"],
    [7, 1, 0, "0.0007 -> 0 (refused below)"],
    [5000, 1, 1, "0.5 -> 1 (.5 boundary up at the smallest percentage)"],
    [4999, 1, 0, "0.4999 -> 0"],
  ];
  it.each(cases)("%i cents at %i bp = %i (%s)", (basis, bp, expected) => {
    expect(roundHalfUpPercentCents(basis, bp)).toBe(expected);
  });
  it("never rounds to whole dollars: the result keeps its cents", () => {
    const r = computePercentFee(12345, 7500);
    expect(r).toEqual({ ok: true, amountCents: 9259, basisCents: 12345, percentBp: 7500 });
    expect((r as { amountCents: number }).amountCents % 100).not.toBe(0);
  });
  it("is exact for every .5 boundary a float would risk (no Math.round, no floating point)", () => {
    for (let basis = 1; basis <= 4000; basis++) {
      const exact = (basis * 7500) / 10000; // may be fractional but 7500 has few binary issues; compare to integer rule
      const viaInteger = Math.floor((basis * 7500 + 5000) / 10000);
      expect(roundHalfUpPercentCents(basis, 7500)).toBe(viaInteger);
      expect(Math.abs(viaInteger - exact)).toBeLessThanOrEqual(0.5);
    }
  });
  it("source: integer arithmetic only", () => {
    const src = readFileSync(join(process.cwd(), "lib/billing/manual-fee-percent.ts"), "utf8").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    expect(src).not.toMatch(/Math\.round|toFixed|parseFloat|Number\.parseFloat/);
    expect(src).toMatch(/Math\.floor\(\(basisCents \* percentBp \+ 5000\) \/ 10000\)/);
  });
});

describe("refusals: no fallback, no cap, no substitution", () => {
  it("basis 0 (an explicit $0 price) is a ZERO FEE, not an error", () => {
    expect(computePercentFee(0, 7500)).toEqual({ ok: false, reason: "no_fee_owed", basisCents: 0, percentBp: 7500 });
    expect(noFeeOwedMessage(0, 7500)).toBe("Appointment price $0.00 \u00d7 75% = $0.00. No fee is owed, so there is nothing to prepare.");
  });
  it("a positive price whose percentage rounds to $0.00 is also a zero fee, distinct from invalid_basis", () => {
    expect(computePercentFee(1, 1)).toEqual({ ok: false, reason: "no_fee_owed", basisCents: 1, percentBp: 1 });
    expect(computePercentFee(4999, 1)).toEqual({ ok: false, reason: "no_fee_owed", basisCents: 4999, percentBp: 1 });
  });
  it("null, undefined, negative, fractional, NaN or non-numeric basis is invalid_basis (not a zero fee)", () => {
    for (const b of [-1, null, undefined, NaN, 1.5, "100"]) {
      expect(computePercentFee(b, 7500)).toEqual({ ok: false, reason: "invalid_basis" });
    }
  });
  it("no_fee_owed never exposes an amount", () => {
    expect(computePercentFee(0, 7500)).not.toHaveProperty("amountCents");
  });
  it("a result at or above the ceiling is refused (not capped)", () => {
    // 20000 = 200.00: 26667 cents at 75% = 20000.25 -> 20000 -> refused
    expect(computePercentFee(26667, 7500)).toEqual({ ok: false, reason: "at_or_above_ceiling" });
    expect(computePercentFee(30000, 7500)).toEqual({ ok: false, reason: "at_or_above_ceiling" });
    const justUnder = computePercentFee(26665, 7500); // 19998.75 -> 19999
    expect(justUnder).toMatchObject({ ok: true, amountCents: MANUAL_FEE_AMOUNT_CEILING_CENTS - 1 });
  });
  it("an invalid percentage is refused", () => {
    for (const bp of [0, -5, 10001, 7500.5, null, undefined, "7500"]) {
      expect(computePercentFee(12000, bp)).toEqual({ ok: false, reason: "invalid_percent" });
    }
  });
  it("every refusal has an owner message that names no fallback amount", () => {
    for (const r of ["invalid_percent", "invalid_basis", "at_or_above_ceiling"] as const) {
      expect(percentFeeRefusalMessage(r)).toMatch(/\w/);
      expect(percentFeeRefusalMessage(r)).not.toMatch(/\$50|C\$|fixed amount/i);
    }
  });
});

describe("percentage text", () => {
  it.each([
    ["75", 7500], ["75%", 7500], [" 12.5 ", 1250], ["12.34", 1234], ["100", 10000], ["0.01", 1], ["0.1", 10],
  ])("%s -> %i bp", (text, bp) => expect(parsePercentTextToBp(text)).toBe(bp));
  it.each(["", "0", "0.00", "100.01", "101", "-5", "7.555", "abc", "1e2", "75,5", "١٢"])("rejects %j", (text) => {
    expect(parsePercentTextToBp(text)).toBeNull();
  });
  it("formats basis points back to text", () => {
    expect(formatBasisPoints(7500)).toBe("75%");
    expect(formatBasisPoints(1250)).toBe("12.5%");
    expect(formatBasisPoints(1234)).toBe("12.34%");
  });
});

describe("configuration validity: one validator", () => {
  const base = { late_cancel_fee_cents: 5000, no_show_fee_cents: 5000, late_cancel_fee_mode: "fixed", no_show_fee_mode: "fixed", late_cancel_fee_percent_bp: null, no_show_fee_percent_bp: null };
  it("fixed mode needs a usable amount; percent mode needs a valid percentage; an unknown mode fails closed", () => {
    expect(manualFeeConfigIssue("late_cancellation_fee", base)).toBeNull();
    expect(manualFeeConfigIssue("late_cancellation_fee", { ...base, late_cancel_fee_cents: 0 })).toBe("fixed_amount");
    expect(manualFeeConfigIssue("late_cancellation_fee", { ...base, late_cancel_fee_cents: null })).toBe("fixed_amount");
    expect(manualFeeConfigIssue("late_cancellation_fee", { ...base, late_cancel_fee_cents: 20001 })).toBe("fixed_amount");
    expect(manualFeeConfigIssue("late_cancellation_fee", { ...base, late_cancel_fee_mode: "percent" })).toBe("percent_value");
    expect(manualFeeConfigIssue("late_cancellation_fee", { ...base, late_cancel_fee_mode: "percent", late_cancel_fee_percent_bp: 7500 })).toBeNull();
    expect(manualFeeConfigIssue("late_cancellation_fee", { ...base, late_cancel_fee_mode: "weird" })).toBe("mode");
    expect(manualFeeConfigIssue("late_cancellation_fee", null)).toBe("mode");
  });
  it("the two types are validated independently", () => {
    const row = { ...base, no_show_fee_mode: "percent" };
    expect(manualFeeConfigIssue("late_cancellation_fee", row)).toBeNull();
    expect(manualFeeConfigIssue("no_show_fee", row)).toBe("percent_value");
  });
  it("fixed amounts: the ceiling itself is allowed, above it is not (unchanged rule)", () => {
    expect(fixedFeeCentsIssue(MANUAL_FEE_AMOUNT_CEILING_CENTS)).toBeNull();
    expect(fixedFeeCentsIssue(MANUAL_FEE_AMOUNT_CEILING_CENTS + 1)).toBe("out_of_range");
    expect(fixedFeeCentsIssue(-1)).toBe("out_of_range");
    expect(fixedFeeCentsIssue(0)).toBe("not_configured");
  });
});

describe("what the owner sees before confirming", () => {
  it("percent: the basis, the percentage and the final amount, in the studio currency", () => {
    expect(describeFeeAmount({ calcMode: "percent", basisCents: 12000, percentBp: 7500, amountCents: 9000, currency: "cad" })).toBe("75% of $120.00 session price = $90.00 CAD");
    expect(describeFeeAmount({ calcMode: "percent", basisCents: 12345, percentBp: 7500, amountCents: 9259, currency: "cad" })).toBe("75% of $123.45 session price = $92.59 CAD");
  });
  it("fixed and older attempts print just the amount", () => {
    expect(describeFeeAmount({ calcMode: "fixed", basisCents: null, percentBp: null, amountCents: 5000, currency: "cad" })).toBe("$50.00 CAD");
    expect(describeFeeAmount({ calcMode: null, basisCents: null, percentBp: null, amountCents: 5000, currency: "usd" })).toBe("$50.00 USD");
  });
  it("a percent attempt missing its basis prints no invented explanation", () => {
    expect(describeFeeAmount({ calcMode: "percent", basisCents: null, percentBp: 7500, amountCents: 9000, currency: "cad" })).toBe("$90.00 CAD");
  });
  it("the card prints it and offers no amount field", () => {
    const src = readFileSync(join(process.cwd(), "app/(app)/calendar/[id]/ManualFeeChargeCard.tsx"), "utf8");
    expect(src).toMatch(/data-testid="fee-amount-basis"/);
    expect(src).toMatch(/describeFeeAmount\(/);
    expect(src).not.toMatch(/name="amount|name="percent|fd\.set\("amount|fd\.set\("percent/);
  });
});
