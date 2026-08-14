import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// F-PAY-001. This suite used to pin the "display default" amount FIELD: an
// editable input whose value the prepare action inserted verbatim. The amount
// is now a server decision that the card RENDERS and never edits, so these pin
// the authoritative display instead.

const CARD = readFileSync(
  path.resolve(__dirname, "../../../components/session-payment-prepare-card.tsx"),
  "utf8",
);

const amountRegion = CARD.slice(
  CARD.indexOf('data-testid="authoritative-amount"') - 900,
  CARD.indexOf('name="internal_note"'),
);

describe("the authoritative amount is displayed, not edited", () => {
  it("renders the server amount and submits it only as a stale-price check", () => {
    expect(amountRegion).toMatch(/formatCadFromCents\(amount\.amountCents\)/);
    expect(amountRegion).toMatch(/name="expected_amount_cents"/);
    expect(amountRegion).toMatch(/type="hidden"/);
  });

  it("there is NO editable amount input anywhere in the card", () => {
    expect(CARD).not.toMatch(/name="amount_dollars"/);
    expect(CARD).not.toMatch(/aria-label="Amount in Canadian dollars"/);
    expect(CARD).not.toMatch(/suggestedAmount/);
    // ...and no copy inviting an edit.
    expect(CARD).not.toMatch(/You can adjust before preparing/);
  });

  it("names the booked service and its duration beside the amount", () => {
    expect(amountRegion).toMatch(/Booked service: \{amount\.serviceName\}/);
    expect(amountRegion).toMatch(/amount\.durationMinutes != null/);
  });

  it("states the source truthfully for both pricing paths", () => {
    expect(amountRegion).toMatch(/amount\.source === "custom_pricing"/);
    expect(amountRegion).toMatch(/Client-specific price for this service\./);
    expect(amountRegion).toMatch(/Booked service price\./);
    expect(amountRegion).toMatch(/amount\.customPricingNote/);
  });

  it("blocked pricing replaces the form with a calm reason — never a blank box", () => {
    expect(CARD).toMatch(/data-testid="pricing-blocked"/);
    // Review 3780456783 moved this call into the shared presentation decision
    // (lib/billing/ready-control-permission), so the card renders the returned
    // copy instead of recomputing it. The invariant is unchanged: unresolved
    // pricing yields a calm practitioner reason, never a blank box and never a
    // historical-price fallback.
    expect(CARD).toMatch(/presentation\.unresolvedExplanation/);
    const PERM_MSG = readFileSync(
      path.join(process.cwd(), "lib/billing/ready-control-permission.ts"),
      "utf8",
    );
    expect(PERM_MSG).toMatch(/unresolvedAmountMessage\(amountResult\)/);
    // The prepare form only renders when the amount actually resolved.
    expect(CARD).toMatch(/showPrepareForm && resolvedAmount &&/);
  });

  it("carries no historical-session-price fallback", () => {
    const code = CARD.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/pricePaidCents != null\s*\n?\s*\?/);
    expect(code).not.toMatch(/Suggestion from session price/);
  });

  it("prepare/execute/receipt/refund actions are untouched by the amount change", () => {
    for (const prop of [
      "prepareAction",
      "executeAction",
      "sendReceiptAction",
      "refundAction",
    ]) {
      expect(CARD).toContain(prop);
    }
    // Execution still receives only the attempt id — no amount argument.
    expect(CARD).not.toMatch(/executeAction[\s\S]{0,200}amount/);
  });
});
