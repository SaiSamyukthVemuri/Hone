import { describe, expect, it } from "vitest";
import {
  compareProviderMoney,
  providerMoneyMismatchDetails,
} from "@/lib/billing/provider-money-facts";

// PAY-CCY-01 (#824). The pure rule every payment writer now applies before it
// records a provider object: the provider's amount and currency must equal the
// prepared attempt's, exactly. The writers' wiring is proved separately in
// provider-money-mismatch-writers.test.ts.

const CAD_150 = { amountCents: 15000, currency: "cad" };
const USD_150 = { amountCents: 15000, currency: "usd" };

describe("compareProviderMoney: equal money is the only match", () => {
  it("accepts the same amount and currency (CAD)", () => {
    expect(compareProviderMoney(CAD_150, { amount: 15000, currency: "cad" })).toEqual({
      ok: true,
    });
  });

  it("accepts the same amount and currency (USD)", () => {
    expect(compareProviderMoney(USD_150, { amount: 15000, currency: "usd" })).toEqual({
      ok: true,
    });
  });

  it("treats an upper-case spelling of the SAME code as the same currency", () => {
    expect(compareProviderMoney(CAD_150, { amount: 15000, currency: "CAD" })).toEqual({
      ok: true,
    });
  });

  it("the same number of minor units in another currency is different money", () => {
    expect(compareProviderMoney(CAD_150, { amount: 15000, currency: "usd" })).toEqual({
      ok: false,
      mismatches: ["currency_mismatch"],
    });
    expect(compareProviderMoney(USD_150, { amount: 15000, currency: "cad" })).toEqual({
      ok: false,
      mismatches: ["currency_mismatch"],
    });
  });

  it("one minor unit apart is different money", () => {
    expect(compareProviderMoney(CAD_150, { amount: 15001, currency: "cad" })).toEqual({
      ok: false,
      mismatches: ["amount_mismatch"],
    });
    expect(compareProviderMoney(CAD_150, { amount: 14999, currency: "cad" })).toEqual({
      ok: false,
      mismatches: ["amount_mismatch"],
    });
  });

  it("reports BOTH mismatches when both differ", () => {
    expect(compareProviderMoney(CAD_150, { amount: 200, currency: "usd" })).toEqual({
      ok: false,
      mismatches: ["amount_mismatch", "currency_mismatch"],
    });
  });
});

describe("compareProviderMoney: what the provider did not state is never a match", () => {
  it.each([
    ["missing", undefined],
    ["null", null],
    ["a numeric string", "15000"],
    ["a float", 15000.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["beyond safe integers", Number.MAX_SAFE_INTEGER + 2],
  ])("amount %s is unreadable", (_label, amount) => {
    expect(compareProviderMoney(CAD_150, { amount, currency: "cad" })).toEqual({
      ok: false,
      mismatches: ["amount_unreadable"],
    });
  });

  it.each([
    ["missing", undefined],
    ["null", null],
    ["empty", ""],
    ["a number", 124],
    ["two letters", "ca"],
    ["a symbol", "$"],
    ["with whitespace inside", "c ad"],
  ])("currency %s is unreadable", (_label, currency) => {
    expect(compareProviderMoney(CAD_150, { amount: 15000, currency })).toEqual({
      ok: false,
      mismatches: ["currency_unreadable"],
    });
  });

  it("a row that cannot state its own prepared money vouches for nothing", () => {
    for (const prepared of [
      { amountCents: null, currency: "cad" },
      { amountCents: 15000, currency: null },
      { amountCents: "15000", currency: "cad" },
    ]) {
      expect(
        compareProviderMoney(prepared, { amount: 15000, currency: "cad" }),
      ).toEqual({ ok: false, mismatches: ["prepared_unreadable"] });
    }
  });
});

describe("compareProviderMoney: no conversion, no defaulting", () => {
  it("never treats zero or a missing amount as matching a zero-cent preparation", () => {
    // Attempts are > 0 by CHECK, but the rule must not lean on that.
    expect(
      compareProviderMoney({ amountCents: 0, currency: "cad" }, { amount: 0, currency: "cad" }),
    ).toEqual({ ok: true });
    expect(
      compareProviderMoney(
        { amountCents: 0, currency: "cad" },
        { amount: undefined, currency: "cad" },
      ),
    ).toEqual({ ok: false, mismatches: ["amount_unreadable"] });
  });
});

describe("providerMoneyMismatchDetails: flat and safe", () => {
  it("names the reasons and both sides, flat", () => {
    expect(
      providerMoneyMismatchDetails(
        CAD_150,
        { amount: 15000, currency: "usd" },
        ["currency_mismatch"],
      ),
    ).toEqual({
      money_mismatches: ["currency_mismatch"],
      prepared_amount_cents: 15000,
      prepared_currency: "cad",
      provider_amount: 15000,
      provider_currency: "usd",
    });
  });

  it("never carries a nested provider value or an unbounded string", () => {
    const details = providerMoneyMismatchDetails(
      CAD_150,
      { amount: { nested: "payload" }, currency: "x".repeat(500) },
      ["amount_unreadable", "currency_unreadable"],
    );
    expect(details.provider_amount).toBeNull();
    expect(typeof details.provider_currency).toBe("string");
    expect((details.provider_currency as string).length).toBeLessThanOrEqual(16);
  });
});
