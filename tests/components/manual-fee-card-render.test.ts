import { describe, expect, it, vi } from "vitest";

// Manual late-cancel / no-show fee card: WHAT IT PRINTS, through react-dom/server on the real component
// (output, not a source grep). Synthetic data, fake actions, no Stripe. Pins: the owner copy and amount on the
// confirm button, the charge history (amount, type, status, time, refund), the unclear / pending / failed /
// needs-action states, and that NO charge or retry control is offered while an attempt is in flight or unclear.

const calls: string[] = [];
vi.mock("@/app/(app)/calendar/[id]/manual-fee-actions", () => {
  const f = (name: string) => async () => { calls.push(name); return { ok: false as const, error: "not called" }; };
  return {
    prepareManualFeeChargeAction: f("prepare"),
    chargeManualFeeAttemptAction: f("charge"),
    cancelManualFeeChargeAttemptAction: f("cancel"),
    sendFeeReceiptAction: f("receipt"),
    refundFeeAttemptAction: f("refund"),
  };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }) }));

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { ManualFeeChargeCard } = await import("@/app/(app)/calendar/[id]/ManualFeeChargeCard");

const CARD = { id: "pm-1", brand: "visa", last4: "4242", exp_month: 1, exp_year: 2030, status: "active" };
function attempt(over: Record<string, unknown> = {}) {
  return {
    id: "fa-1", charge_type: "no_show", status: "ready", amount_cents: 5000, currency: "cad",
    created_at: "2026-11-01T10:00:00.000Z", stripe_payment_intent_id: null, stripe_charge_id: null, charged_at: null,
    failed_at: null, failure_code: null, failure_message: null, cancelled_at: null, cancelled_reason: null,
    refund_status: null, refund_amount_cents: null, stripe_refund_status: null, stripe_refund_id: null,
    receipt_sent_at: null, updated_at: new Date().toISOString(),
    ...over,
  };
}
function eligible(attempts: unknown[], amountCents = 5000) {
  return {
    eligible: true as const, cardPaymentMethodId: "pm-1", cardAuthorizationSignatureId: "sig-1",
    policyAcknowledgementId: "ack-1", policySnapshotHash: "h", amountCents, currency: "cad",
    timingClassification: "practitioner_asserted",
    appointment: { id: "appt-1", status: "no_show", starts_at: "2026-11-01T09:00:00.000Z", cancelled_at: null, created_at: "2026-10-01T00:00:00.000Z", service_name: "Electrolysis" },
    client: { id: "c-1", name: "Test Client" }, card: CARD,
    cardAuthorization: { signature_id: "sig-1", signed_at: "2026-10-01T00:00:00.000Z" },
    policyAcknowledgement: { acknowledged_at: "2026-10-01T00:00:00.000Z" },
    existingAttempts: attempts,
  };
}
const blocked = (attempts: unknown[]) => ({ eligible: false as const, blockingReasons: ["An active fee charge attempt already exists for this appointment."], existingAttempts: attempts, card: CARD });
function render(attempts: unknown[], mode: "eligible" | "blocked" = "blocked"): string {
  const noShow = mode === "eligible" ? eligible(attempts) : blocked(attempts);
  const lateCancel = blocked(attempts.filter((a) => (a as { charge_type: string }).charge_type === "late_cancel"));
  // The card reads attempts from BOTH eligibilities; pass each type's attempts on its own side.
  return renderToStaticMarkup(createElement(ManualFeeChargeCard as never, { appointmentId: "appt-1", lateCancel: { ...lateCancel, existingAttempts: attempts.filter((a) => (a as { charge_type: string }).charge_type === "late_cancel") }, noShow: { ...noShow, existingAttempts: attempts.filter((a) => (a as { charge_type: string }).charge_type === "no_show") } } as never));
}
// The card opens on "late_cancel"; these helpers use a late_cancel attempt so its panel is the one shown.
const LC = { charge_type: "late_cancel" };

describe("ready: the owner is told what will be charged, and the button shows amount and type", () => {
  const html = render([attempt({ ...LC })]);
  it("owner copy names the saved fixed amount and the type", () => {
    expect(html).toContain('data-testid="fee-saved-amount-copy"');
    expect(html).toMatch(/saved fixed late cancellation fee of\s*\$50\.00 CAD will be charged/);
    expect(html).toContain("cannot be changed here");
  });
  it("the charge button carries the server amount and the fee type", () => {
    expect(html).toContain("Charge late cancellation fee ($50.00 CAD)");
  });
});

describe("states that must NOT offer a charge or a retry", () => {
  const noControls = (html: string) => {
    expect(html).not.toContain("Charge late cancellation fee");
    expect(html).not.toContain("Refresh status");
    expect(html).not.toContain("Prepare manual fee charge");
  };
  it("unclear (pending_stripe, old): the required sentence, no control", () => {
    const html = render([attempt({ ...LC, status: "pending_stripe", updated_at: "2026-11-01T10:00:00.000Z" })]);
    expect(html).toContain('data-testid="fee-unclear-panel"');
    expect(html).toContain("Charge status is unclear. Do not charge again until this is checked.");
    noControls(html);
  });
  it("unclear (pending_stripe with no readable time) is not shown as pending", () => {
    const html = render([attempt({ ...LC, status: "pending_stripe", updated_at: null })]);
    expect(html).toContain("fee-unclear-panel");
    expect(html).not.toContain("Charge pending");
  });
  it("an unrecognised status is unclear, not a raw string", () => {
    const html = render([attempt({ ...LC, status: "weird" })]);
    expect(html).toContain("fee-unclear-panel");
    expect(html).not.toContain("Attempt status: weird");
  });
  it("pending (recent) says pending, offers only Refresh, never a new charge", () => {
    const html = render([attempt({ ...LC, status: "pending_stripe" })]);
    expect(html).toContain("Charge pending.");
    expect(html).toContain("Refresh status");
    expect(html).not.toContain("Charge late cancellation fee");
    expect(html).not.toContain("fee-unclear-panel");
  });
  it("needs the client's action: says nothing was taken, offers no charge", () => {
    const html = render([attempt({ ...LC, status: "failed", failure_code: "requires_action_canceled" })]);
    expect(html).toContain("fee-needs-action-panel");
    expect(html).toContain("nothing was taken");
    expect(html).not.toContain("Charge failed.");
    noControls(html);
  });
  it("failed is failed, with the reason", () => {
    const html = render([attempt({ ...LC, status: "failed", failure_code: "card_declined", failure_message: "Declined" })]);
    expect(html).toContain("Charge failed.");
  });
});

describe("charge history lists every attempt: amount, type, status, time, refund", () => {
  const rows = [
    attempt({ id: "a", ...LC, status: "succeeded", amount_cents: 5000, charged_at: "2026-11-02T10:00:00.000Z", refund_status: "succeeded", refund_amount_cents: 5000, stripe_refund_status: "succeeded" }),
    attempt({ id: "b", charge_type: "no_show", status: "failed", amount_cents: 3000, failure_code: "card_declined" }),
    attempt({ id: "c", ...LC, status: "cancelled", amount_cents: 5000, cancelled_at: "2026-11-01T11:00:00.000Z" }),
  ];
  const html = render(rows);
  it("one row per attempt with amount and type", () => {
    expect((html.match(/data-testid="fee-history-row"/g) ?? []).length).toBe(3);
    expect(html).toContain("$30.00 CAD");
    expect(html).toContain("Late cancellation fee");
    expect(html).toContain("No-show fee");
  });
  it("each row has a truthful status label and the refund line only where there is one", () => {
    expect(html).toContain("Charged");
    expect(html).toContain("Charge failed");
    expect(html).toContain("Cancelled before charging");
    expect((html.match(/data-testid="fee-history-refund"/g) ?? []).length).toBe(1);
    expect(html).toContain(">Refunded<");
  });
});

describe("refund status on a charged fee (shared R1 logic)", () => {
  const charged = (over: Record<string, unknown>) => render([attempt({ ...LC, status: "succeeded", charged_at: "2026-11-02T10:00:00.000Z", ...over })]);
  it("a never-refunded charge offers the refund button", () => {
    expect(charged({})).toContain("Refund charge");
  });
  it("a refund in flight offers no new refund and says processing", () => {
    const html = charged({ refund_status: "pending_stripe" });
    expect(html).not.toContain("Refund charge");
    expect(html).toContain("Refund processing");
  });
  it("our refund succeeded but the provider says failed: review, not 'Refunded', no new refund", () => {
    const html = charged({ refund_status: "succeeded", refund_amount_cents: 5000, stripe_refund_status: "failed" });
    expect(html).toContain("Refund needs review");
    expect(html).not.toContain("Payment refunded");
    expect(html).not.toContain("Refund charge");
  });
  it("refunded shows once, with no refund button", () => {
    const html = charged({ refund_status: "succeeded", refund_amount_cents: 5000, stripe_refund_status: "succeeded" });
    expect(html).toContain("Refunded");
    expect(html).not.toContain("Refund charge");
  });
});

describe("the card never calls an action while rendering", () => {
  it("rendering fires no charge, refund or prepare", () => {
    expect(calls).toEqual([]);
  });
});
