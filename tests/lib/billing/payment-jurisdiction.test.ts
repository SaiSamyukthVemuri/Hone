import { describe, expect, it } from "vitest";
import {
  accountCountryBlockingReason,
  accountCountryChargeable,
  accountCountryVerdict,
  currencyLabel,
  parseJurisdiction,
} from "@/lib/billing/payment-jurisdiction";

// PAY-CCY-02 (#824). Country and currency are separate facts. These pin the
// pure rules the eligibility and charge paths apply; the database guard that
// is the authority is proved in tests/db/studio-payment-jurisdiction.db.test.ts.

describe("parseJurisdiction: only the two allowed pairs", () => {
  it("accepts CA/cad and US/usd", () => {
    expect(parseJurisdiction({ payment_country: "CA", payment_currency: "cad" })).toEqual({
      country: "CA",
      currency: "cad",
    });
    expect(parseJurisdiction({ payment_country: "US", payment_currency: "usd" })).toEqual({
      country: "US",
      currency: "usd",
    });
  });

  it.each([
    [{ payment_country: "CA", payment_currency: "usd" }],
    [{ payment_country: "US", payment_currency: "cad" }],
    [{ payment_country: "us", payment_currency: "usd" }],
    [{ payment_country: "GB", payment_currency: "gbp" }],
    [{}],
    [null],
    [undefined],
  ])("refuses %j rather than defaulting to Canada", (row) => {
    expect(parseJurisdiction(row as never)).toBeNull();
  });
});

describe("accountCountryVerdict compares COUNTRY with COUNTRY", () => {
  it("match / mismatch on an observed account", () => {
    expect(accountCountryVerdict("US", "US")).toBe("match");
    expect(accountCountryVerdict("CA", "CA")).toBe("match");
    expect(accountCountryVerdict("US", "CA")).toBe("mismatch");
    expect(accountCountryVerdict("CA", "US")).toBe("mismatch");
  });

  it("an unobserved account is chargeable only for a Canadian studio (legacy)", () => {
    expect(accountCountryVerdict("CA", null)).toBe("unobserved_legacy_ca");
    expect(accountCountryVerdict("US", null)).toBe("unobserved_refused");
    expect(accountCountryVerdict("US", "")).toBe("unobserved_refused");
    expect(accountCountryChargeable("unobserved_legacy_ca")).toBe(true);
    expect(accountCountryChargeable("unobserved_refused")).toBe(false);
    expect(accountCountryChargeable("mismatch")).toBe(false);
  });

  it("a currency code is never accepted as a country", () => {
    // "usd" is not "US": a currency passed where a country belongs is a mismatch.
    expect(accountCountryVerdict("US", "usd")).toBe("mismatch");
    expect(accountCountryVerdict("CA", "cad")).toBe("mismatch");
  });

  it("refusals carry practitioner-safe copy; chargeable verdicts carry none", () => {
    expect(accountCountryBlockingReason("match")).toBeNull();
    expect(accountCountryBlockingReason("unobserved_legacy_ca")).toBeNull();
    expect(accountCountryBlockingReason("mismatch")).toMatch(/different country/);
    expect(accountCountryBlockingReason("unobserved_refused")).toMatch(/not yet confirmed/);
  });
});

describe("currencyLabel", () => {
  it("labels each currency explicitly", () => {
    expect(currencyLabel("cad")).toBe("CAD");
    expect(currencyLabel("usd")).toBe("USD");
  });
});
