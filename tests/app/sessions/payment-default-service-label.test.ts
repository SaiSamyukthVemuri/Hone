import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// F-PAY-001 then F-PAY-002. This suite has pinned the amount field through two
// inversions, and the history is the point:
//
//   * originally: an editable `amount_dollars` input whose value the prepare
//     action inserted VERBATIM — the browser decided what a client was charged;
//   * F-PAY-001: no input at all, the server-resolved price the only amount —
//     which closed the hole and took Chloe's till with it;
//   * F-PAY-002 (here): the server-resolved price is the REFERENCE and the
//     default, and a separate `final_amount_dollars` field carries the
//     operator-authored total, which the server authorises, bounds and audits.
//
// What is pinned below is therefore NOT "there is no input" — that claim is
// deliberately false now. It is the narrower, still-load-bearing claim: the
// REFERENCE is display-only and the legacy unguarded field is gone for good.
//
// The rendered-output proof (the field exists, is enabled, defaults to the
// reference) lives in tests/components/checkout-final-amount-ui.test.ts, and
// the amount that actually lands on the row in
// tests/app/sessions/prepare-final-amount-authority.test.ts. These are source
// pins about STRUCTURE only.

const CARD = readFileSync(
  path.resolve(__dirname, "../../../components/session-payment-prepare-card.tsx"),
  "utf8",
);

const amountRegion = CARD.slice(
  CARD.indexOf('data-testid="authoritative-amount"') - 900,
  CARD.indexOf('name="internal_note"'),
);

describe("the reference is displayed; the FINAL charge is the editable total", () => {
  it("renders the server reference and submits it only as a stale-price check", () => {
    expect(amountRegion).toMatch(/formatCadFromCents\(amount\.amountCents\)/);
    expect(amountRegion).toMatch(/name="expected_amount_cents"/);
    expect(amountRegion).toMatch(/type="hidden"/);
  });

  it("the reference itself is never an input", () => {
    // `authoritative-amount` is the reminder. Wrapping it in a control would
    // make the reference look like the editable total and reintroduce the
    // confusion between the two numbers.
    const referenceTag = CARD.slice(
      CARD.lastIndexOf("<", CARD.indexOf('data-testid="authoritative-amount"')),
      CARD.indexOf('data-testid="authoritative-amount"'),
    );
    expect(referenceTag).not.toMatch(/<input/);
  });

  it("the legacy unguarded amount field is gone for good", () => {
    // The exact field name the pre-F-PAY-001 code inserted verbatim. Its
    // replacement is `final_amount_dollars`, which no code path reads without
    // going through decideCheckoutFinalAmount.
    expect(CARD).not.toMatch(/name="amount_dollars"/);
    expect(CARD).not.toMatch(/aria-label="Amount in Canadian dollars"/);
    expect(CARD).not.toMatch(/suggestedAmount/);
    // ...and no copy that frames the total as a mere suggestion to tweak.
    expect(CARD).not.toMatch(/You can adjust before preparing/);
  });

  it("parses the typed total with the SAME parser the server uses", () => {
    // Not a re-implementation: a second parser in the browser could decide
    // "this is an adjustment" while the action decided "this is malformed".
    expect(CARD).toMatch(
      /import \{[\s\S]{0,200}parseCadAmountToCents[\s\S]{0,120}\} from "@\/lib\/billing\/cad-amount"/,
    );
    expect(CARD).toMatch(/parseCadAmountToCents\(\s*finalAmount,/);
  });

  it("carries no historical-session-price fallback", () => {
    const code = CARD.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/pricePaidCents != null\s*\n?\s*\?/);
    expect(code).not.toMatch(/Suggestion from session price/);
  });
});
