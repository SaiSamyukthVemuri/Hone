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
      expect(html, p).toContain("Our record and Stripe do not agree.");
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
      expect(html, p).toContain("Our record and Stripe do not agree.");
      expect(html, p).not.toContain("Refund failed.");
      expect(canRetry(html), p).toBe(false);
    }
  });
  it("a provider refund we never recorded is unclear and cannot be retried", () => {
    const html = render({ refundStatus: null, stripeRefundStatus: "succeeded" });
    expect(html).toContain("Our record and Stripe do not agree.");
    expect(canRetry(html)).toBe(false);
  });
  it("an unrecognised value on either side is unclear", () => {
    expect(render({ refundStatus: "weird" })).toContain("Our record and Stripe do not agree.");
    expect(render({ stripeRefundStatus: "weird" })).toContain("Our record and Stripe do not agree.");
  });
});

const REVIEW = "Refund needs review";
const panelHeading = (html: string) => html.match(/<p class="font-medium">(Refund needs [^<]*?)\.<\/p>/)?.[1] ?? null;
const headerHeading = (html: string) => html.match(/data-testid="payment-summary-(?:refund_review|refund_action)"[\s\S]*?<span>([^<]*?)(?: · [^<]*)?<\/span><\/p>/)?.[1] ?? null;

describe("Sam, 12 Nov: ONE heading 'Refund needs review' in the header AND the panel, for every unresolved state", () => {
  const unresolved: Array<[string, Record<string, unknown>]> = [
    ["unclear: disagreement", { refundStatus: "succeeded", refundAmountCents: 12_000, stripeRefundStatus: "failed" }],
    ["unclear: unknown value", { refundStatus: "weird" }],
    ["unclear: unrecorded provider refund", { refundStatus: null, stripeRefundStatus: "succeeded" }],
    ["needs_review: provider failed", { refundStatus: null, stripeRefundStatus: "failed" }],
    ["needs_review: id only", { refundStatus: "failed", stripeRefundId: "re_1" }],
  ];
  for (const [name, a] of unresolved) {
    it(`${name}: header and panel headings are EQUAL and read '${REVIEW}'`, () => {
      const html = render(a);
      expect(headerHeading(html), "header").toBe(REVIEW);
      expect(panelHeading(html), "panel").toBe(REVIEW);
      expect(headerHeading(html)).toBe(panelHeading(html));
      expect(html).toContain("studio owner");
      expect(html).not.toContain("studio operator");
      expect(html).not.toContain("Refund status is unclear");
    });
  }
  it("the explanation is accurate per cause: an id with no status says 'we could not confirm', never 'did not complete'", () => {
    const idOnly = render({ refundStatus: "failed", stripeRefundId: "re_1" });
    expect(idOnly).toContain("Stripe has a record of a refund here that we could not confirm.");
    expect(idOnly).not.toContain("did not complete");
    expect(render({ refundStatus: "weird" })).toContain("Our record and Stripe do not agree. Do not refund again until the studio owner has reviewed this.");
  });
  it("requires_action: header AND panel both say action is needed at Stripe (not 'processing')", () => {
    const html = render({ refundStatus: "succeeded", refundAmountCents: 12_000, stripeRefundStatus: "requires_action" });
    expect(headerHeading(html)).toBe("Refund needs action at Stripe");
    expect(panelHeading(html)).toBe("Refund needs action at Stripe");
    expect(html).not.toContain("Refund processing");
  });
  it("the refund id is never printed in an unresolved state's panel or header (disclosure only, exactly once)", () => {
    const ID = "re_SECRET_REFUND_ID";
    const html = render({ refundStatus: "failed", stripeRefundId: ID }, true);
    expect(html.split(ID)).toHaveLength(2);
    const at = html.indexOf(ID);
    const open = html.lastIndexOf("technical-payment-details", at);
    expect(open).toBeGreaterThan(-1);
    expect(html.slice(open, at)).not.toContain("</details>");
    expect(render({ refundStatus: "failed", stripeRefundId: ID }, false)).not.toContain(ID);
  });
});

describe("Insurance N1: the card container is keyed on the summary kind, not styled as paid", () => {
  const emerald = (html: string) => html.includes("border-emerald-200 bg-emerald-50/60");
  it("paid -> emerald; refunded / pending / unresolved / action -> never emerald", () => {
    expect(emerald(render({}))).toBe(true);
    expect(emerald(render({ refundStatus: "succeeded", refundAmountCents: 12_000 }))).toBe(false);
    expect(emerald(render({ refundStatus: "pending_stripe" }))).toBe(false);
    expect(emerald(render({ refundStatus: "succeeded" }))).toBe(false); // no readable amount -> review
    expect(emerald(render({ refundStatus: "succeeded", refundAmountCents: 12_000, stripeRefundStatus: "requires_action" }))).toBe(false);
    expect(emerald(render({ refundStatus: null, stripeRefundStatus: "failed" }))).toBe(false);
  });
});

describe("refund panel: a provider trace blocks a new attempt (Insurance F1; the runner refuses it as needs_manual_review)", () => {
  it("ours failed or null + provider failed/canceled: 'needs review' for the studio owner, never 'failed', NO retry button", () => {
    for (const o of [null, "failed"]) {
      for (const p of ["failed", "canceled"]) {
        const html = render({ refundStatus: o, stripeRefundStatus: p });
        expect(html, `${o}/${p}`).toContain("Refund needs review.");
        expect(html, `${o}/${p}`).toContain("Stripe has a record of a refund here that we could not confirm.");
        expect(html, `${o}/${p}`).toContain("studio owner must review");
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
      expect(html, p).toContain("Our record and Stripe do not agree.");
      expect(html, p).not.toMatch(/>Refunded</);
      expect(html, p).not.toMatch(/Refunded\s*<[^>]*>[^<]*<\/time>|Refunded \d/);
    }
  });
  it("ours succeeded, provider still pending: header 'Refund processing'; requires_action: 'Refund needs action at Stripe' (never 'processing')", () => {
    const pending = render({ ...FULL, stripeRefundStatus: "pending" });
    expect(pending).toContain("Refund processing");
    expect(pending).not.toMatch(/>Refunded</);
    const action = render({ ...FULL, stripeRefundStatus: "requires_action" });
    expect(action).toContain("Refund needs action at Stripe");
    expect(action).not.toContain("Refund processing");
    expect(action).not.toMatch(/>Refunded</);
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
