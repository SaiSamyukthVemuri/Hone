import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { formatMoneyWithCurrency } from "@/lib/billing/payment-jurisdiction";

// PAY-CCY-04, Codex P2 4244957363 ("Carry currency into every charge
// confirmation"). Once an attempt is prepared the currency-labelled form is
// gone; every panel that shows that attempt, above all ReadyPanel's
// money-moving confirmation, must name the currency the attempt was PREPARED
// in, read from the attempt itself.
//
// Rendered through react-dom/server, as in checkout-final-amount-ui.test.ts.

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

const REFERENCE = {
  kind: "resolved" as const,
  amountCents: 12_000,
  source: "service_price" as const,
  serviceName: "Electrolysis 60 min",
  durationMinutes: 60,
  customPricingNote: null,
};

function attempt(over: Record<string, unknown>) {
  return {
    id: "att-1",
    status: "ready",
    amountCents: 12_000,
    currency: "usd",
    createdAt: "2026-10-12T10:00:00.000Z",
    stripePaymentIntentId: null,
    stripeChargeId: null,
    chargedAt: null,
    failedAt: null,
    failureCode: null,
    failureMessageSafe: null,
    receiptStatus: null,
    receiptSentAt: null,
    receiptEmailTo: null,
    receiptFailureCode: null,
    receiptFailureMessageSafe: null,
    refundStatus: null,
    refundAmountCents: null,
    refundedAt: null,
    stripeRefundId: null,
    refundFailureCode: null,
    refundFailureMessageSafe: null,
    ...over,
  };
}

const noop = async () => ({ ok: false as const, error: "not called" });

function render(
  existing: ReturnType<typeof attempt>,
  paymentCurrency: "cad" | "usd" = "usd",
): string {
  return renderToStaticMarkup(
    createElement(SessionPaymentPrepareCard, {
      sessionId: "sess-1",
      clientId: "client-1",
      eligibility: {
        eligible: false,
        reasons: ["An active payment attempt already exists for this session."],
        session: { id: "sess-1", modality: "electrolysis", startedAt: null, endedAt: null, pricePaidCents: null },
        appointment: { id: "appt-1", status: "completed", startsAt: null },
        client: { id: "client-1", name: "Test Client" },
        paymentCurrency,
        existingAttempts: [existing],
      },
      amountResult: REFERENCE as never,
      isOwner: true,
      prepareAction: noop as never,
      executeAction: noop as never,
      sendReceiptAction: noop as never,
      refundAction: noop as never,
    } as never),
  );
}

const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&#x27;|&apos;/g, "'");

describe("formatMoneyWithCurrency", () => {
  it("names the currency, and never assumes Canada for an unknown one", () => {
    expect(formatMoneyWithCurrency(12_000, "usd")).toBe("$120.00 USD");
    expect(formatMoneyWithCurrency(12_000, "cad")).toBe("$120.00 CAD");
    expect(formatMoneyWithCurrency(5, "usd")).toBe("$0.05 USD");
    expect(formatMoneyWithCurrency(12_000, null)).toBe("$120.00 (currency unknown)");
  });
});

describe("ReadyPanel: the money-moving confirmation names the prepared currency", () => {
  it("a USD attempt is charged in USD", () => {
    const html = render(attempt({}));
    expect(html).toContain('data-testid="ready-charge-section"');
    expect(text(html)).toMatch(/saved card will be charged \$120\.00 USD\./);
    expect(text(html)).toMatch(/Ready to charge · \$120\.00 USD/);
  });

  it("Canadian regression: a CAD attempt reads CAD, same amount", () => {
    const html = render(attempt({ currency: "cad" }), "cad");
    expect(text(html)).toMatch(/saved card will be charged \$120\.00 CAD\./);
    expect(text(html)).not.toMatch(/USD/);
  });

  it("the ATTEMPT's currency wins over the studio's current configuration", () => {
    // A CAD attempt prepared before a (refused-in-practice) change still reads CAD.
    const html = render(attempt({ currency: "cad" }), "usd");
    expect(text(html)).toMatch(/charged \$120\.00 CAD\./);
  });

  it("an unknown currency withholds the charge instead of showing it unlabelled", () => {
    const html = render(attempt({ currency: null }));
    expect(html).not.toContain('data-testid="ready-charge-section"');
    expect(html).toContain('data-testid="ready-charge-currency-unknown"');
    expect(text(html)).not.toMatch(/Run charge/);
  });

  it("the armed confirmation label is built from the attempt's currency", () => {
    // The armed label only exists after a click, which a static render cannot
    // reach; pin its source so it cannot regress to a bare amount.
    const src = readFileSync(
      path.join(process.cwd(), "components/session-payment-prepare-card.tsx"),
      "utf8",
    );
    expect(src).toContain(
      "`Confirm: run charge (${formatAttemptMoney(attempt.amountCents, attempt.currency)})`",
    );
  });
});

describe("the other attempt panels carry the currency too", () => {
  it("succeeded + refunded: amount and refund in USD", () => {
    const html = render(
      attempt({
        status: "succeeded",
        stripePaymentIntentId: "pi_1",
        chargedAt: "2026-10-12T10:05:00.000Z",
        refundStatus: "succeeded",
        refundAmountCents: 12_000,
        refundedAt: "2026-10-12T10:10:00.000Z",
      }),
    );
    expect(text(html)).toMatch(/Refunded · \$120\.00 USD/);
    expect(text(html)).toMatch(/Amount refunded: \$120\.00 USD/);
    expect(text(html)).not.toMatch(/\$120\.00(?! USD)/);
  });

  it("no attempt amount anywhere in the card is formatted without its currency", () => {
    // Cancelled / blocked / unknown-status panels and the attempt history are
    // reached through paths a single static render does not cover; this pins
    // every one of them. Only the pre-preparation form (labelled by the
    // studio's currency) may still use the bare formatter.
    const src = readFileSync(
      path.join(process.cwd(), "components/session-payment-prepare-card.tsx"),
      "utf8",
    );
    expect(src).not.toMatch(/formatCadFromCents\(\s*(attempt|a|localRefunded)\b/);
    expect(src.match(/formatAttemptMoney\(/g)?.length ?? 0).toBeGreaterThanOrEqual(9);
  });
});
