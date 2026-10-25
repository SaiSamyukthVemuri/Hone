import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parsePaymentCurrency, formatMoney, checkDisplayedCurrency, currencyLabel, currencyName } from "@/lib/billing/payment-jurisdiction";

// #1035 Codex P1 #4369182087. The currency helpers every checkout / fee / refund
// surface relies on, and the eligibility mapping of the PERSISTED attempt
// currency. Behavioural mapping of existing attempts is exercised through the
// real getSessionPaymentEligibility in eligibility-read-fail-closed.test.ts
// ("existing attempts carry the persisted currency", appended there).

describe("parsePaymentCurrency", () => {
  it.each([["cad", "cad"], ["usd", "usd"]])("%s is %s", (v, out) => expect(parsePaymentCurrency(v)).toBe(out));
  it.each([["CAD"], ["USD"], ["eur"], [""], [null], [undefined], [0], [{}], [" cad"]])("%j is unknown (null), never a default", (v) =>
    expect(parsePaymentCurrency(v)).toBeNull());
});

describe("formatMoney prints the code of the currency it is given", () => {
  it("usd / cad / unknown", () => {
    expect(formatMoney(12_000, "usd")).toBe("$120.00 USD");
    expect(formatMoney(12_005, "cad")).toBe("$120.05 CAD");
    expect(formatMoney(5, "usd")).toBe("$0.05 USD");
    expect(formatMoney(12_000, null)).toBe("$120.00 (currency unknown)");
  });
  it("labels and spoken names", () => {
    expect(currencyLabel("usd")).toBe("USD");
    expect(currencyName("usd")).toBe("US dollars");
    expect(currencyName("cad")).toBe("Canadian dollars");
  });
});

describe("checkDisplayedCurrency: the server's value decides, the posted value can only refuse", () => {
  it.each([
    ["usd", "usd", "ok"], ["cad", "cad", "ok"],
    ["usd", "cad", "changed"], ["cad", "usd", "changed"],
    ["usd", null, "changed"], ["usd", "", "changed"], ["usd", "eur", "changed"], ["usd", "USD", "changed"],
    ["eur", "eur", "unverified"], [null, "cad", "unverified"], [undefined, "usd", "unverified"], ["USD", "usd", "unverified"],
  ] as const)("server %j posted %j -> %s", (server, posted, verdict) => {
    expect(checkDisplayedCurrency(server, posted)).toBe(verdict);
  });
});

describe("eligibility maps the persisted currency (source contract)", () => {
  const src = readFileSync(join(__dirname, "../../../lib/billing/session-payment-eligibility.ts"), "utf8");
  it("selects currency and parses it; no constant", () => {
    expect(src).toMatch(/"id, status, amount_cents, currency, created_at/);
    expect(src).toMatch(/currency: parsePaymentCurrency\(row\.currency\)/);
    expect(src).not.toMatch(/currency: "cad"/);
  });
});
