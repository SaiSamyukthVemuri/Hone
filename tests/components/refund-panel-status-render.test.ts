import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

// R1. WHAT THE REFUND PANEL PRINTS, run through react-dom/server on the real checkout card (output, not a source
// grep). The panel must read OUR refund column AND the provider's (stripe_refund_status, 0240) through
// refundDisplayState: a provider failure is never shown as "succeeded", an in-flight or disagreeing refund is never
// shown as "failed", and none of those offers a new refund.

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
    id: "att-1", status: "succeeded", amountCents: 12_000, currency: "cad", createdAt: "2026-08-01T00:00:00.000Z",
    stripePaymentIntentId: "pi_1", stripeChargeId: "ch_1", chargedAt: "2026-08-01T01:00:00.000Z", failedAt: null,
    failureCode: null, failureMessageSafe: null, receiptStatus: null, receiptSentAt: null, receiptEmailTo: null,
    receiptFailureCode: null, receiptFailureMessageSafe: null,
    refundStatus: null, stripeRefundStatus: null, refundAmountCents: null, refundedAt: null, stripeRefundId: null,
    refundFailureCode: null, refundFailureMessageSafe: null,
    ...over,
  };
}
function render(a: Record<string, unknown>, isOwner = true): string {
  const elig = {
    eligible: true as const,
    session: { id: "sess-1", modality: "electrolysis", startedAt: null, endedAt: null, pricePaidCents: null },
    appointment: { id: "appt-1", status: "completed", startsAt: null },
    client: { id: "client-1", name: "Test Client" },
    card: { id: "card-1", brand: "visa", last4: "4242", expMonth: 12, expYear: 2030 },
    cardAuthorization: { signatureId: "sig-1", templateVersion: 2, signedAt: "2026-01-01T00:00:00.000Z" },
    stripeAccountId: "acct_1", stripeCustomerId: "cus_1", stripePaymentMethodId: "pm_1",
    existingAttempts: [attempt(a)],
    jurisdiction: { country: "CA" as const, currency: "cad" as const },
  };
  return renderToStaticMarkup(
    createElement(SessionPaymentPrepareCard, {
      sessionId: "sess-1", clientId: "client-1", eligibility: elig as never, amountResult: REFERENCE as never,
      isOwner, prepareAction: noop as never, executeAction: noop as never,
      sendReceiptAction: noop as never, refundAction: noop as never,
    } as never),
  );
}
const canRetry = (html: string) => html.includes("Refund charge");

describe("refund panel: the provider's state is read, not only ours", () => {
  it("ours says succeeded, the provider says FAILED or CANCELED: unclear, never 'succeeded', no retry", () => {
    for (const p of ["failed", "canceled"]) {
      const html = render({ refundStatus: "succeeded", refundAmountCents: 12_000, stripeRefundStatus: p });
      expect(html, p).toContain("Refund status is unclear.");
      expect(html, p).toContain("Do not refund again");
      expect(html, p).not.toContain("Refund succeeded.");
      expect(html, p).not.toContain("Refund failed.");
      expect(canRetry(html), p).toBe(false);
    }
  });
  it("ours says succeeded, the provider says it REQUIRES ACTION: 'needs action at Stripe', no retry", () => {
    const html = render({ refundStatus: "succeeded", refundAmountCents: 12_000, stripeRefundStatus: "requires_action" });
    expect(html).toContain("Refund needs action at Stripe.");
    expect(html).not.toContain("Refund succeeded.");
    expect(canRetry(html)).toBe(false);
  });
  it("in flight (our claim held), provider silent or pending: 'Refund pending.', never 'failed', no retry", () => {
    for (const p of [null, "pending"]) {
      const html = render({ refundStatus: "pending_stripe", stripeRefundStatus: p });
      expect(html, String(p)).toContain("Refund pending.");
      expect(html, String(p)).not.toContain("Refund failed.");
      expect(canRetry(html), String(p)).toBe(false);
    }
  });
  it("our claim held but the provider says failed/canceled: unclear (a held claim is never released on a guess), no retry", () => {
    for (const p of ["failed", "canceled"]) {
      const html = render({ refundStatus: "pending_stripe", stripeRefundStatus: p });
      expect(html, p).toContain("Refund status is unclear.");
      expect(html, p).not.toContain("Refund failed.");
      expect(canRetry(html), p).toBe(false);
    }
  });
  it("a provider refund we never recorded is unclear and cannot be retried", () => {
    const html = render({ refundStatus: null, stripeRefundStatus: "succeeded" });
    expect(html).toContain("Refund status is unclear.");
    expect(canRetry(html)).toBe(false);
  });
  it("an unrecognised value on either side is unclear", () => {
    expect(render({ refundStatus: "weird" })).toContain("Refund status is unclear.");
    expect(render({ stripeRefundStatus: "weird" })).toContain("Refund status is unclear.");
  });
});

describe("refund panel: the agreed states still read as before", () => {
  it("both sides succeeded: 'Refund succeeded.', amount shown, no retry", () => {
    const html = render({ refundStatus: "succeeded", refundAmountCents: 12_000, stripeRefundStatus: "succeeded", refundedAt: "2026-08-02T00:00:00.000Z" });
    expect(html).toContain("Refund succeeded.");
    expect(html).toContain("Amount refunded");
    expect(canRetry(html)).toBe(false);
  });
  it("a terminal failure of ours (provider silent, failed or canceled): 'Refund failed.' and the owner may try again", () => {
    for (const p of [null, "failed", "canceled"]) {
      const html = render({ refundStatus: "failed", stripeRefundStatus: p });
      expect(html, String(p)).toContain("Refund failed.");
      expect(canRetry(html), String(p)).toBe(true);
    }
  });
  it("no refund yet: the owner is offered one; a non-owner never is", () => {
    expect(canRetry(render({}))).toBe(true);
    expect(canRetry(render({}, false))).toBe(false);
  });
});
