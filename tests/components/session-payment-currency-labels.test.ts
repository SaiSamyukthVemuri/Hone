import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

// #1035 Codex P1 #4369182087. WHAT THE CHECKOUT CARD PRINTS FOR THE CHARGE
// CURRENCY, run through react-dom/server (output, not a source grep).
//
//   * the amount-entry label and its accessible name come from the SERVER-
//     resolved jurisdiction (eligibility.jurisdiction.currency), never a literal;
//   * every prepared / run / refund panel prints the PERSISTED attempt currency;
//   * an attempt whose stored currency is unreadable prints it as unknown and its
//     money-moving controls are disabled (refuse, never default);
//   * the currency the form shows is posted back as expected_currency so the
//     server can refuse a mismatch (payment-actions tests pin the refusal).
// The card is shared by session checkout and quick checkout.

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }) }));
vi.mock("next/link", async () => {
  const react = await import("react");
  return { default: (props: { href: string; children?: ReactNode }) => react.createElement("a", { href: props.href }, props.children) };
});

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { SessionPaymentPrepareCard } = await import("@/components/session-payment-prepare-card");

const REFERENCE = {
  kind: "resolved" as const, amountCents: 12_000, source: "service_price" as const,
  serviceName: "Electrolysis 60 min", durationMinutes: 60, customPricingNote: null,
};
const noop = async () => ({ ok: false as const, error: "not called" });

function attempt(over: Record<string, unknown> = {}) {
  return {
    id: "att-1", status: "ready", amountCents: 12_000, currency: "cad", createdAt: "2026-08-01T00:00:00.000Z",
    stripePaymentIntentId: null, stripeChargeId: null, chargedAt: null, failedAt: null, failureCode: null,
    failureMessageSafe: null, receiptStatus: null, receiptSentAt: null, receiptEmailTo: null,
    receiptFailureCode: null, receiptFailureMessageSafe: null, refundStatus: null, refundAmountCents: null,
    refundedAt: null, stripeRefundId: null, refundFailureCode: null, refundFailureMessageSafe: null,
    ...over,
  };
}
function eligibility(currency: "cad" | "usd", attempts: unknown[] = []) {
  return {
    eligible: true as const,
    session: { id: "sess-1", modality: "electrolysis", startedAt: null, endedAt: null, pricePaidCents: null },
    appointment: { id: "appt-1", status: "completed", startsAt: null },
    client: { id: "client-1", name: "Test Client" },
    card: { id: "card-1", brand: "visa", last4: "4242", expMonth: 12, expYear: 2030 },
    cardAuthorization: { signatureId: "sig-1", templateVersion: 2, signedAt: "2026-01-01T00:00:00.000Z" },
    stripeAccountId: "acct_1", stripeCustomerId: "cus_1", stripePaymentMethodId: "pm_1",
    existingAttempts: attempts,
    jurisdiction: currency === "usd" ? { country: "US" as const, currency: "usd" as const } : { country: "CA" as const, currency: "cad" as const },
  };
}
function render(elig: unknown): string {
  return renderToStaticMarkup(
    createElement(SessionPaymentPrepareCard, {
      sessionId: "sess-1", clientId: "client-1", eligibility: elig as never, amountResult: REFERENCE as never,
      isOwner: true, prepareAction: noop as never, executeAction: noop as never,
      sendReceiptAction: noop as never, refundAction: noop as never,
    } as never),
  );
}
const hidden = (html: string, name: string) =>
  html.match(new RegExp(`<input[^>]*name="${name}"[^>]*>`))?.[0] ?? "";

describe("amount entry prints the verified jurisdiction currency", () => {
  it("US studio: USD label, US-dollars accessible name, usd posted back, no CAD wording anywhere", () => {
    const html = render(eligibility("usd"));
    expect(html).toContain("Final charge (USD)");
    expect(html).toContain('aria-label="Final charge in US dollars"');
    expect(hidden(html, "expected_currency")).toContain('value="usd"');
    // The booked reference and the adjustment line print a plain "$": they make
    // no currency claim, and the currency sits on the label above the field.
    expect(html).toMatch(/data-testid="authoritative-amount"[^>]*>\$120\.00</);
    expect(html).not.toMatch(/Canadian dollars|\(CAD\)|\bCAD\b/);
  });
  it("CA studio: CAD label, Canadian-dollars accessible name, cad posted back", () => {
    const html = render(eligibility("cad"));
    expect(html).toContain("Final charge (CAD)");
    expect(html).toContain('aria-label="Final charge in Canadian dollars"');
    expect(hidden(html, "expected_currency")).toContain('value="cad"');
    expect(html).toMatch(/data-testid="authoritative-amount"[^>]*>\$120\.00</);
    expect(html).not.toMatch(/US dollars|\(USD\)|\bUSD\b/);
  });
});

describe("a prepared attempt prints the PERSISTED attempt currency", () => {
  it("usd attempt: 'will be charged $120.00 USD', never CAD", () => {
    const html = render(eligibility("usd", [attempt({ currency: "usd" })]));
    expect(html).toContain("will be charged");
    expect(html).toContain("$120.00 USD");
    expect(html).not.toMatch(/\bCAD\b|Canadian/);
  });
  it("the persisted currency wins over the jurisdiction's (a cad attempt in a studio now showing usd stays CAD)", () => {
    const html = render(eligibility("usd", [attempt({ currency: "cad" })]));
    expect(html).toMatch(/will be charged[\s\S]{0,40}\$120\.00 CAD/);
  });
  it("succeeded usd attempt with a usd refund: both amounts carry USD", () => {
    const html = render(eligibility("usd", [attempt({
      status: "succeeded", currency: "usd", stripePaymentIntentId: "pi_1", stripeChargeId: "ch_1",
      chargedAt: "2026-08-01T01:00:00.000Z", refundStatus: "succeeded", refundAmountCents: 12_000,
      refundedAt: "2026-08-02T00:00:00.000Z", stripeRefundId: "re_1",
    })]));
    expect(html).toContain("$120.00 USD");
    expect(html).not.toMatch(/\bCAD\b/);
  });
});

describe("an unreadable stored currency refuses rather than defaults", () => {
  it("attempt currency null: printed as unknown and Run charge is disabled", () => {
    // The eligibility mapper parses the stored value (parsePaymentCurrency), so
    // the card receives null for anything but cad/usd (pinned in
    // tests/lib/billing/session-payment-eligibility-currency.test.ts).
    const html = render(eligibility("usd", [attempt({ currency: null })]));
    expect(html).toContain("currency unknown");
    expect(html).toContain('data-testid="attempt-currency-unknown"');
    const runButton = html.match(/<button[^>]*>\s*Run charge\s*<\/button>/)?.[0] ?? "";
    expect(runButton).toContain("disabled");
    expect(html).not.toMatch(/will be charged[\s\S]{0,40}\bCAD\b/);
  });
});
