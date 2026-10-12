import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import {
  countryName,
  currencyName,
  describePaymentCountry,
} from "@/lib/billing/payment-jurisdiction";
import { PaymentCountryCard } from "@/app/(app)/settings/payments/PaymentCountryCard";

// PAY-CCY-04 (#824). What the owner's payment settings page says about the
// studio's payment country, currency and Stripe account country. The rule the
// copy follows is the charging rule (accountCountryVerdict); the tone is "ok"
// only when the country side permits charging.

const CA = { country: "CA", currency: "cad" } as const;
const US = { country: "US", currency: "usd" } as const;

describe("describePaymentCountry", () => {
  it("no account yet: names the country the account will be created in", () => {
    const s = describePaymentCountry({ jurisdiction: US, account: { kind: "none" } });
    expect(s).toMatchObject({ tone: "ok", heading: "United States · charges in USD" });
    expect(s.detail).toMatch(/will be created in United States/);
  });

  it("matching account: ok, in both countries", () => {
    expect(
      describePaymentCountry({ jurisdiction: CA, account: { kind: "bound", observedCountry: "CA" } }),
    ).toMatchObject({ tone: "ok", heading: "Canada · charges in CAD" });
    expect(
      describePaymentCountry({ jurisdiction: US, account: { kind: "bound", observedCountry: "US" } }),
    ).toMatchObject({ tone: "ok", detail: "Your Stripe account is registered in United States." });
  });

  it("mismatch: blocked, names both countries, says it will not be replaced", () => {
    const s = describePaymentCountry({
      jurisdiction: US,
      account: { kind: "bound", observedCountry: "CA" },
    });
    expect(s.tone).toBe("blocked");
    expect(s.detail).toMatch(/registered in Canada, not United States/);
    expect(s.detail).toMatch(/will not be replaced/);
  });

  it("unobserved account: attention for a legacy CA studio, blocked for a US one", () => {
    expect(
      describePaymentCountry({ jurisdiction: CA, account: { kind: "bound", observedCountry: null } }).tone,
    ).toBe("attention");
    const us = describePaymentCountry({
      jurisdiction: US,
      account: { kind: "bound", observedCountry: null },
    });
    expect(us.tone).toBe("blocked");
    expect(us.detail).toMatch(/Charges are paused/);
  });

  it("an unread jurisdiction or account is never presented as fine", () => {
    expect(describePaymentCountry({ jurisdiction: null, account: { kind: "none" } }).tone).toBe(
      "unknown",
    );
    expect(describePaymentCountry({ jurisdiction: CA, account: { kind: "unknown" } }).tone).toBe(
      "unknown",
    );
  });
});

describe("PaymentCountryCard renders the summary, and only the summary", () => {
  it("shows heading and detail with the tone as data", () => {
    const html = renderToStaticMarkup(
      createElement(PaymentCountryCard, {
        summary: describePaymentCountry({
          jurisdiction: US,
          account: { kind: "bound", observedCountry: "CA" },
        }),
      }),
    );
    expect(html).toContain('data-tone="blocked"');
    expect(html).toContain("United States · charges in USD");
    expect(html).toContain("registered in Canada, not United States");
    // Read-only: no control that could change the country.
    expect(html).not.toMatch(/<(button|input|select|form)\b/);
  });
});

describe("names", () => {
  it("currency and country names", () => {
    expect(currencyName("cad")).toBe("Canadian dollars");
    expect(currencyName("usd")).toBe("US dollars");
    expect(countryName("CA")).toBe("Canada");
    expect(countryName("US")).toBe("United States");
  });

  // Codex P1 4244834151: a persisted conflict is blocked even when the
  // recorded country matches the studio.
  it("a recorded country conflict is blocked, whichever report matches", () => {
    const blocked = describePaymentCountry({
      jurisdiction: CA,
      account: { kind: "bound", observedCountry: "CA", conflictingCountry: "US" },
    });
    expect(blocked.tone).toBe("blocked");
    expect(blocked.detail).toMatch(/more than one country/);
    // Negative control: the same account without a conflict is ok.
    expect(
      describePaymentCountry({
        jurisdiction: CA,
        account: { kind: "bound", observedCountry: "CA", conflictingCountry: null },
      }).tone,
    ).toBe("ok");
  });
});
