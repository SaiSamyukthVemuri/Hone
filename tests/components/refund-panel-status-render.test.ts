import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

// R1. WHAT THE REFUND PANEL PRINTS, run through react-dom/server on the real checkout card (output, not a source
// grep). The panel must read OUR refund column AND the provider's (stripe_refund_status, 0240) through
// refundDisplayState: a provider failure is never shown as "succeeded", an in-flight or disagreeing refund is never
// shown as "failed", and none of those offers a new refund.

vi.mock("@/app/(app)/appointment-settlement-actions", () => ({
  recordAppointmentSettlementAction: async () => ({ ok: true }),
  waiveAppointmentFeeAction: async () => ({ ok: true }),
}));
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

describe("refund panel: a provider trace blocks a new attempt (Insurance F1; the runner refuses it as needs_manual_review)", () => {
  it("ours failed or null + provider failed/canceled: 'needs review' for the studio operator, never 'failed', NO retry button", () => {
    for (const o of [null, "failed"]) {
      for (const p of ["failed", "canceled"]) {
        const html = render({ refundStatus: o, stripeRefundStatus: p });
        expect(html, `${o}/${p}`).toContain("Refund needs review.");
        expect(html, `${o}/${p}`).toContain("Stripe has a record of a refund here that we could not confirm.");
        expect(html, `${o}/${p}`).toContain("studio operator must review");
        expect(html, `${o}/${p}`).not.toContain("did not complete");
        expect(html, `${o}/${p}`).not.toContain("Refund failed.");
        expect(canRetry(html), `${o}/${p}`).toBe(false);
      }
    }
  });
  it("a refund object id with no status is also a trace: needs review, no retry", () => {
    const html = render({ refundStatus: "failed", stripeRefundId: "re_1" });
    expect(html).toContain("Refund needs review.");
    expect(canRetry(html)).toBe(false);
  });
});

describe("refund panel: the agreed states still read as before", () => {
  it("both sides succeeded: 'Refund succeeded.', amount shown, no retry", () => {
    const html = render({ refundStatus: "succeeded", refundAmountCents: 12_000, stripeRefundStatus: "succeeded", refundedAt: "2026-08-02T00:00:00.000Z" });
    expect(html).toContain("Refund succeeded.");
    expect(html).toContain("Amount refunded");
    expect(canRetry(html)).toBe(false);
  });
  it("a terminal failure of ours with NO provider trace: 'Refund failed.' and the owner may try again", () => {
    const html = render({ refundStatus: "failed" });
    expect(html).toContain("Refund failed.");
    expect(canRetry(html)).toBe(true);
  });
  it("no refund yet: the owner is offered one; a non-owner never is", () => {
    expect(canRetry(render({}))).toBe(true);
    expect(canRetry(render({}, false))).toBe(false);
  });
});

// Insurance F2 / F3: the header and the settlement gate use the SAME reading as the panel.
function renderWithAppointment(a: Record<string, unknown>): string {
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
      isOwner: true, appointmentId: "appt-1", canRecordSettlement: true,
      prepareAction: noop as never, executeAction: noop as never,
      sendReceiptAction: noop as never, refundAction: noop as never,
    } as never),
  );
}
const FULL = { refundStatus: "succeeded", refundAmountCents: 12_000 };

describe("header (F2): never 'Refunded' beside a panel that says the status is unclear", () => {
  it("agreed full refund: header Refunded", () => {
    const html = render({ ...FULL, stripeRefundStatus: "succeeded", refundedAt: "2026-08-02T00:00:00.000Z" });
    expect(html).toMatch(/Refunded/);
    expect(html).toContain("Refund succeeded.");
  });
  it("ours succeeded, provider failed/canceled: header says 'Refund needs review', NOT 'Refunded'", () => {
    for (const p of ["failed", "canceled"]) {
      const html = render({ ...FULL, stripeRefundStatus: p, refundedAt: "2026-08-02T00:00:00.000Z" });
      expect(html, p).toContain("Refund needs review");
      expect(html, p).toContain("Refund status is unclear.");
      expect(html, p).not.toMatch(/>Refunded</);
      expect(html, p).not.toMatch(/Refunded\s*<[^>]*>[^<]*<\/time>|Refunded \d/);
    }
  });
  it("ours succeeded, provider still pending/requires_action: header 'Refund processing'", () => {
    for (const p of ["pending", "requires_action"]) {
      const html = render({ ...FULL, stripeRefundStatus: p });
      expect(html, p).toContain("Refund processing");
      expect(html, p).not.toMatch(/>Refunded</);
    }
  });
});

describe("settlement gate (F3): cash-replacement controls open only when BOTH columns agree the whole charge went back", () => {
  const controls = (html: string) => html.includes("appointment-settlement-controls");
  it("agreed full refund: controls offered (the money went back)", () => {
    expect(controls(renderWithAppointment({ ...FULL, stripeRefundStatus: "succeeded" }))).toBe(true);
    expect(controls(renderWithAppointment({ ...FULL }))).toBe(true); // provider silent
  });
  it("ours succeeded but the provider failed/canceled/pending/requires_action: the card money stays HELD, no controls", () => {
    for (const p of ["failed", "canceled", "pending", "requires_action"]) {
      expect(controls(renderWithAppointment({ ...FULL, stripeRefundStatus: p })), p).toBe(false);
    }
  });
  it("a partial refund still holds card money: no controls", () => {
    expect(controls(renderWithAppointment({ refundStatus: "succeeded", refundAmountCents: 2_000 }))).toBe(false);
  });
  it("an unreadable refund amount holds card money: no controls", () => {
    expect(controls(renderWithAppointment({ refundStatus: "succeeded", refundAmountCents: null }))).toBe(false);
  });
});

// Pre-existing disclosure (Privacy): the refund id appears in the technical-details row. WHO sees it is decided by
// TechnicalPaymentDetails, which returns null for a non-owner, so the id is not in a non-owner's DOM.
describe("the refund id is owner-only in the DOM (technicalRowsForAttempt -> TechnicalPaymentDetails)", () => {
  const ID = "re_SECRET_REFUND_ID";
  it("owner: the id appears only inside the collapsed technical-payment-details disclosure", () => {
    const html = render({ refundStatus: "succeeded", refundAmountCents: 12_000, stripeRefundId: ID }, true);
    const at = html.indexOf(ID);
    expect(at).toBeGreaterThan(-1);
    const open = html.lastIndexOf("technical-payment-details", at);
    expect(open, "inside the disclosure").toBeGreaterThan(-1);
    expect(html.slice(open, at)).not.toContain("</details>");
    expect(html.split(ID)).toHaveLength(2); // exactly once
  });
  it("non-owner: the id is nowhere in the rendered HTML", () => {
    const html = render({ refundStatus: "succeeded", refundAmountCents: 12_000, stripeRefundId: ID }, false);
    expect(html).not.toContain(ID);
    expect(html).not.toContain("technical-payment-details");
  });
});
