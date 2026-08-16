import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

// F-PAY-002 (Chloe P1: "When I prepare charge it's stuck as whatever the price
// of the service is"). WHAT THE PREPARE FORM ACTUALLY RENDERS.
//
// These assertions run the real card through react-dom/server rather than
// grepping its source, so "the final charge is editable" is proved as OUTPUT.
// A source pin could only ever show that an `<input>` appears somewhere near
// the word "final"; it could not show that the control is present, enabled,
// writable, and defaulted to the current reference amount.
//
// The two mocks below stand in for browser-only Next plumbing that has no
// server render. Neither touches the amount, the copy or the form fields under
// test. The precedent for this idiom is
// tests/app/reliability/authenticated-error-boundary.test.ts.

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined }),
}));

vi.mock("next/link", async () => {
  const react = await import("react");
  return {
    default: (props: { href: string; children?: ReactNode }) =>
      react.createElement("a", { href: props.href }, props.children),
  };
});

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { SessionPaymentPrepareCard } = await import(
  "@/components/session-payment-prepare-card"
);

const ELIGIBILITY = {
  eligible: true as const,
  session: {
    id: "sess-1",
    modality: "electrolysis",
    startedAt: null,
    endedAt: null,
    pricePaidCents: null,
  },
  appointment: { id: "appt-1", status: "completed", startsAt: null },
  client: { id: "client-1", name: "Test Client" },
  card: { id: "card-1", brand: "visa", last4: "4242", expMonth: 12, expYear: 2030 },
  cardAuthorization: {
    signatureId: "sig-1",
    templateVersion: 2,
    signedAt: "2026-01-01T00:00:00.000Z",
  },
  stripeAccountId: "acct_1",
  stripeCustomerId: "cus_1",
  stripePaymentMethodId: "pm_1",
  existingAttempts: [],
};

const REFERENCE = {
  kind: "resolved" as const,
  amountCents: 12_000,
  source: "service_price" as const,
  serviceName: "Electrolysis 60 min",
  durationMinutes: 60,
  customPricingNote: null,
};

const noop = async () => ({ ok: false as const, error: "not called" });

function render(
  overrides: {
    amountResult?: unknown;
    isOwner?: boolean;
  } = {},
): string {
  // `in`, not `??`: `amountResult: null` is a MEANINGFUL case (the pricing
  // context could not be loaded at all) and a nullish default would silently
  // turn that test into a duplicate of the resolved one.
  const amountResult =
    "amountResult" in overrides ? overrides.amountResult : REFERENCE;
  return renderToStaticMarkup(
    createElement(SessionPaymentPrepareCard, {
      sessionId: "sess-1",
      clientId: "client-1",
      eligibility: ELIGIBILITY,
      amountResult: amountResult as never,
      isOwner: overrides.isOwner ?? true,
      prepareAction: noop as never,
      executeAction: noop as never,
      sendReceiptAction: noop as never,
      refundAction: noop as never,
    } as never),
  );
}

/** The one `<input>` element carrying the given name attribute. */
function inputTag(html: string, name: string): string | null {
  const m = html.match(
    new RegExp(`<input[^>]*name="${name}"[^>]*>`),
  );
  return m ? m[0] : null;
}

describe("the prepare form offers an editable final charge", () => {
  it("renders a final-charge input the practitioner can type into", () => {
    const html = render();
    const tag = inputTag(html, "final_amount_dollars");
    expect(tag).not.toBeNull();
    // Editable means editable: not readonly, not disabled, not a hidden field
    // that merely echoes the server's number back.
    expect(tag).not.toMatch(/readonly/i);
    expect(tag).not.toMatch(/disabled/i);
    expect(tag).not.toMatch(/type="hidden"/i);
  });

  it("defaults the final charge to the current reference amount", () => {
    const tag = inputTag(render(), "final_amount_dollars")!;
    expect(tag).toMatch(/value="120\.00"/);
  });

  it("labels the field so it is reachable by name, not by position", () => {
    const html = render();
    expect(html).toMatch(/Final charge \(CAD\)/);
  });

  it("uses a numeric-friendly keyboard and a real touch target", () => {
    const html = render();
    const tag = inputTag(html, "final_amount_dollars")!;
    // Chloe fills this on a phone with a client in the chair.
    expect(tag).toMatch(/inputmode="decimal"/i);
    expect(tag).toMatch(/min-h-\[44px\]/);
  });

  it("tells the practitioner what the field is for", () => {
    expect(render()).toMatch(
      /Change this for a discount, product\/add-on, or other adjustment\./,
    );
  });

  it("is not buried behind an Advanced disclosure", () => {
    const html = render();
    const field = html.indexOf('name="final_amount_dollars"');
    expect(field).toBeGreaterThan(-1);
    // No <details> wrapper opens before the field and closes after it.
    const detailsBefore = html.slice(0, field).lastIndexOf("<details");
    const detailsClosed = html.slice(0, field).lastIndexOf("</details>");
    expect(detailsBefore).toBeLessThanOrEqual(detailsClosed);
  });
});

describe("the booked-service price stays visible as secondary context", () => {
  it("names the booked service and its current price", () => {
    const html = render();
    expect(html).toMatch(/Booked service/);
    expect(html).toMatch(/Electrolysis 60 min/);
    expect(html).toMatch(/60 min/);
    expect(html).toMatch(/\$120\.00/);
  });

  it("still submits the displayed reference for the stale-price check", () => {
    const tag = inputTag(render(), "expected_amount_cents")!;
    expect(tag).toMatch(/type="hidden"/);
    expect(tag).toMatch(/value="12000"/);
  });

  it("identifies a client-specific reference truthfully", () => {
    const html = render({
      amountResult: {
        ...REFERENCE,
        source: "custom_pricing",
        customPricingNote: "Long-standing client",
      },
    });
    expect(html).toMatch(/Client-specific price for this service\./);
    expect(html).toMatch(/Long-standing client/);
  });

  it("does not present the reference as the immutable total", () => {
    const html = render();
    // The reference is context; the editable field is the total. The old copy
    // labelled the fixed number "Amount (CAD)", which read as the final word.
    const reference = html.indexOf("Booked service");
    const finalField = html.indexOf('name="final_amount_dollars"');
    expect(reference).toBeGreaterThan(-1);
    expect(reference).toBeLessThan(finalField);
  });
});

describe("the adjustment reason appears only once the total differs", () => {
  it("is absent on first render, when final still equals the reference", () => {
    const html = render();
    expect(inputTag(html, "adjustment_reason")).toBeNull();
    expect(html).not.toMatch(/Reason for adjustment/);
  });

  it("is absent for an UNPARSEABLE prefill, so the form can still be submitted", () => {
    // REGRESSION GUARD. A configured price above the ceiling prefills
    // "5000.00", which the strict parser rejects. An earlier draft treated
    // "does not parse" as "differs from the reference", so the reason field
    // rendered with `required` and native validation blocked the submit — the
    // practitioner never reached the server's "review the pricing" message and
    // the payment lane's ceiling test failed with the form simply not
    // responding. Caught by e2e-payment/server-authoritative-amount.spec.ts
    // "an authoritative price above the ceiling BLOCKS and never clamps"; this
    // pins it two layers earlier.
    const html = render({
      amountResult: { ...REFERENCE, amountCents: 500_000 },
    });
    const tag = inputTag(html, "final_amount_dollars")!;
    expect(tag).toMatch(/value="5000\.00"/);
    expect(inputTag(html, "adjustment_reason")).toBeNull();
    expect(html).not.toMatch(/Reason for adjustment/);
    // ...and the Prepare button is still there to press.
    expect(html).toMatch(/Prepare session payment/);
  });

  it("is absent for a zero reference-equal prefill of any size", () => {
    for (const cents of [1, 99, 12_000, 199_999, 200_000]) {
      const html = render({ amountResult: { ...REFERENCE, amountCents: cents } });
      expect(inputTag(html, "adjustment_reason")).toBeNull();
    }
  });
});

describe("a non-owner is offered the ordinary checkout", () => {
  // NAMED FOR WHAT IT CHECKS. An earlier draft called this "is told the truth
  // before submitting", which claimed the owner-only HINT — and that hint only
  // appears once the operator has typed a different total, which a static
  // server render cannot reach. The interactive half (type a different amount
  // as a member -> the amber owner-only hint appears, the reason field does
  // not, and the server refuses the submission) is proved end-to-end by
  // e2e-payment/checkout-default-amount.spec.ts "a non-owner practitioner".
  it("still sees the field, because preparing at the reference is allowed", () => {
    const html = render({ isOwner: false });
    expect(inputTag(html, "final_amount_dollars")).not.toBeNull();
  });

  it("is not shown an owner-only warning before she has changed anything", () => {
    const html = render({ isOwner: false });
    expect(html).not.toMatch(/Only the studio owner can change/);
    expect(inputTag(html, "adjustment_reason")).toBeNull();
  });
});

describe("the prepare affordance is unchanged", () => {
  it("still reads 'Prepare session payment'", () => {
    expect(render()).toMatch(/Prepare session payment/);
  });

  it("still says preparation moves no money", () => {
    expect(render()).toMatch(/No PaymentIntent\. No charge\./);
  });
});

describe("pricing that was never chargeable offers no editable total", () => {
  it("renders no final-charge input for a free service", () => {
    const html = render({
      amountResult: {
        kind: "free",
        serviceName: "Consultation",
        durationMinutes: 15,
      },
    });
    expect(inputTag(html, "final_amount_dollars")).toBeNull();
    expect(html).toMatch(/Consultation is free/);
  });

  it("renders no final-charge input when the price is unresolved", () => {
    const html = render({
      amountResult: { kind: "missing_price", serviceName: "Electrolysis 60 min" },
    });
    expect(inputTag(html, "final_amount_dollars")).toBeNull();
  });

  it("renders no final-charge input when pricing could not be loaded", () => {
    const html = render({ amountResult: null });
    expect(inputTag(html, "final_amount_dollars")).toBeNull();
  });
});
