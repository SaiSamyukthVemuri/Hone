import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

// Codex P2 on #1827: on a BILLED visit the chart card shows Collected / Refunded / Net instead of ONE succeeded card payment's "Paid", but a READY (prepared, not charged) or
// pending attempt keeps its controls: hiding them would strand a prepared payment that nothing else can run. Rendered through react-dom/server on the real card.
vi.mock("@/app/(app)/appointment-settlement-actions", () => ({ recordAppointmentSettlementAction: async () => ({ ok: true }), waiveAppointmentFeeAction: async () => ({ ok: true }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }) }));
vi.mock("next/link", async () => { const react = await import("react"); return { default: (p: { href: string; children?: ReactNode }) => react.createElement("a", { href: p.href }, p.children) }; });

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { SessionPaymentPrepareCard } = await import("@/components/session-payment-prepare-card");
const { visitMoneySummary } = await import("@/lib/billing/visit-money");

const REFERENCE = { kind: "resolved" as const, amountCents: 12_000, source: "service_price" as const, serviceName: "Electrolysis 60 min", durationMinutes: 60, customPricingNote: null };
const noop = async () => ({ ok: false as const, error: "not called" });
const attempt = (over: Record<string, unknown>) => ({
  id: "att-1", status: "ready", amountCents: 10_000, currency: "cad", createdAt: "2026-08-01T00:00:00.000Z", stripePaymentIntentId: null, stripeChargeId: null, chargedAt: null, failedAt: null,
  failureCode: null, failureMessageSafe: null, receiptStatus: null, receiptSentAt: null, receiptEmailTo: null, receiptFailureCode: null, receiptFailureMessageSafe: null,
  refundStatus: null, stripeRefundStatus: null, refundAmountCents: null, refundedAt: null, stripeRefundId: null, refundFailureCode: null, refundFailureMessageSafe: null, ...over,
});
const ledger = { bill: { id: "b", totalCents: 10_000, currency: "cad", referenceFeeCents: null, feeAdjustmentReason: null, createdAt: "t" }, cards: [], externals: [], refunds: [] } as never;
function render(a: Record<string, unknown>): string {
  const elig = {
    eligible: true as const, session: { id: "sess-1", modality: "electrolysis", startedAt: null, endedAt: null, pricePaidCents: null }, appointment: { id: "appt-1", status: "completed", startsAt: null },
    client: { id: "client-1", name: "Test Client" }, card: { id: "card-1", brand: "visa", last4: "4242", expMonth: 12, expYear: 2030 },
    cardAuthorization: { signatureId: "sig-1", templateVersion: 2, signedAt: "2026-01-01T00:00:00.000Z" }, stripeAccountId: "acct_1", stripeCustomerId: "cus_1", stripePaymentMethodId: "pm_1",
    existingAttempts: [attempt(a)], jurisdiction: { country: "CA" as const, currency: "cad" as const },
  };
  return renderToStaticMarkup(createElement(SessionPaymentPrepareCard, {
    sessionId: "sess-1", clientId: "client-1", eligibility: elig as never, amountResult: REFERENCE as never, isOwner: true, prepareAction: noop as never, executeAction: noop as never,
    sendReceiptAction: noop as never, refundAction: noop as never, visitBilled: true, billedMoney: visitMoneySummary(ledger), billedCurrency: "cad", billedStillToCollectCents: 10_000,
  } as never));
}

describe("a billed visit's chart card", () => {
  it("a READY attempt keeps its Run charge control next to the Collected / Refunded / Net block", () => {
    const html = render({ status: "ready" });
    expect(html).toContain('data-testid="visit-money"');
    expect(html).toMatch(/Run charge|Charge /);
  });
  it("a SUCCEEDED attempt is summarised by the money block alone: no single-payment 'Paid' panel", () => {
    const html = render({ status: "succeeded", stripeChargeId: "ch_1", stripePaymentIntentId: "pi_1", chargedAt: "2026-08-01T01:00:00.000Z" });
    expect(html).toContain('data-testid="visit-money"');
    expect(html).not.toMatch(/Run charge/);
  });
});
