// @vitest-environment jsdom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionPaymentPrepareCard } from "@/components/session-payment-prepare-card";
import { QuickCheckoutModal } from "@/components/quick-checkout-modal";
import type { CheckoutMethod } from "@/components/checkout-method-picker";
import { NO_CARD_ON_FILE_REASON, type SessionPaymentEligibility } from "@/lib/billing/session-payment-types";

const { record, waive, refresh, getContext } = vi.hoisted(() => ({ record: vi.fn(), waive: vi.fn(), refresh: vi.fn(), getContext: vi.fn() }));
vi.mock("@/app/(app)/quick-checkout-actions", () => ({ getQuickCheckoutContextAction: getContext }));
vi.mock("@/app/(app)/clients/[id]/sessions/[sessionId]/payment-actions", () => ({
  prepareSessionPaymentChargeAction: vi.fn(), executeSessionPaymentChargeAction: vi.fn(),
  sendPaymentChargeReceiptAction: vi.fn(), refundPaymentChargeAttemptAction: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/app/(app)/appointment-settlement-actions", () => ({
  recordAppointmentSettlementAction: record,
  waiveAppointmentFeeAction: waive,
  supersedeAppointmentSettlementAction: vi.fn(),
}));

const prepare = vi.fn(async () => { throw new Error("Unexpected Stripe call"); });
const common = {
  session: { id: "visit", modality: "electrolysis", startedAt: "2026-01-01T10:00:00Z", endedAt: null, pricePaidCents: null },
  appointment: { id: "appointment", startsAt: null, status: "completed" },
  client: { id: "client", name: "Test Client" }, existingAttempts: [],
};
const cardless: SessionPaymentEligibility = { ...common, eligible: false, jurisdiction: { country: "CA", currency: "cad" }, blockingReasons: [NO_CARD_ON_FILE_REASON], card: null, cardAuthorization: null };
const eligible: SessionPaymentEligibility = {
  ...common, eligible: true, card: { id: "card", brand: "Visa", last4: "4242", expMonth: 6, expYear: 2030 },
  cardAuthorization: { signedAt: "2026-01-01T10:00:00Z", signatureId: "sig", templateVersion: 1 },
  stripeAccountId: "account", stripeCustomerId: "customer", stripePaymentMethodId: "method", jurisdiction: { country: "CA", currency: "cad" },
};
let host: HTMLDivElement;
let root: Root;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
beforeEach(() => {
  vi.clearAllMocks();
  record.mockResolvedValue({ ok: true });
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

async function show(eligibility: SessionPaymentEligibility, initialMethod?: CheckoutMethod, overrides?: Partial<ComponentProps<typeof SessionPaymentPrepareCard>>) {
  await act(async () => root.render(createElement(SessionPaymentPrepareCard, {
    sessionId: "visit", appointmentId: "appointment", clientId: "client", isOwner: true, eligibility, initialMethod,
    amountResult: { kind: "resolved", amountCents: 9000, source: "service_price", serviceName: "Treatment", durationMinutes: 30, customPricingNote: null },
    settlementQuotedAmountCents: 9000, canRecordSettlement: true,
    prepareAction: prepare, executeAction: prepare, sendReceiptAction: prepare, refundAction: prepare, ...overrides,
  })));
}
function control<T extends HTMLElement>(id: string): T {
  const element = host.querySelector<T>(`[data-testid="${id}"]`);
  if (!element) throw new Error(`Missing ${id}`);
  return element;
}
async function click(id: string) { await act(async () => control<HTMLButtonElement>(id).click()); }
async function enter(id: string, value: string) {
  const input = control<HTMLInputElement>(id);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("checkout method selection in the actual session payment card", () => {
  it.each(["paid_e_transfer", "paid_cash", "paid_other_external"] as const)("records the confirmed %s amount without a card or Stripe call", async method => {
    await show(cardless, method);
    const choices = [...host.querySelectorAll<HTMLButtonElement>("fieldset button")];
    expect(choices.map(button => button.textContent)).toEqual(["Stripe", "E-transfer", "Cash", "Other external", "Still owes", "Fee waived"]);
    expect(choices.filter(button => button.disabled).map(button => button.textContent)).toEqual(["Stripe"]);
    expect(host.querySelector('a[href*="tab=messages"]')).toBeNull();
    expect(control(`settlement-open-${method}`).getAttribute("aria-pressed")).toBe("true");
    expect(control(`settlement-confirm-${method}`).textContent).toBe("Confirm payment · $90.00 CAD");
    await enter("settlement-amount", "78.25");
    expect(control(`settlement-confirm-${method}`).textContent).toBe("Confirm payment · $78.25 CAD");
    expect(record).not.toHaveBeenCalled();
    await click(`settlement-confirm-${method}`);
    expect(record).toHaveBeenCalledTimes(1);
    expect(Object.fromEntries(record.mock.calls[0][0].entries())).toMatchObject({ appointment_id: "appointment", method, amount_cents: "7825" });
    expect(waive).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
  });

  it("choosing and leaving an external method preserves the edited Stripe final charge", async () => {
    await show(eligible);
    expect(control("settlement-open-stripe").getAttribute("aria-pressed")).toBe("true");
    await enter("final-charge-input", "75.50");
    await click("settlement-open-paid_cash");
    expect(control("final-charge-input").closest("[hidden]")).not.toBeNull();
    expect(control("settlement-confirm-paid_cash").textContent).toBe("Confirm payment · $75.50 CAD");
    await click("settlement-open-stripe");
    expect(control("final-charge-input").closest("[hidden]")).toBeNull();
    expect(control<HTMLInputElement>("final-charge-input").value).toBe("75.50");
    expect(host.textContent).toContain("Checkout with Stripe");
    expect(record).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
  });

  it("applies one adjusted fee across tenders and submits only the cash actually received", async () => {
    await show(eligible);
    await enter("final-charge-input", "75.50");
    await enter("adjustment-reason-input", "Client discount");
    await click("settlement-open-paid_cash");
    expect(control<HTMLInputElement>("checkout-fee-reason").value).toBe("Client discount");
    await enter("settlement-amount", "50.25");
    expect(host.textContent).toContain("Balance remaining $25.25 CAD");
    await click("settlement-open-stripe");
    expect(control<HTMLInputElement>("final-charge-input").value).toBe("75.50");
    await click("settlement-open-paid_e_transfer");
    expect(control("settlement-confirm-paid_e_transfer").textContent).toBe("Confirm payment · $50.25 CAD");
    expect(record).not.toHaveBeenCalled();
    await click("settlement-confirm-paid_e_transfer");
    expect(Object.fromEntries(record.mock.calls[0][0])).toEqual({
      appointment_id: "appointment", method: "paid_e_transfer", amount_cents: "5025",
      reference_fee_cents: "9000", final_fee_cents: "7550", fee_adjustment_reason: "Client discount",
    });
    expect(prepare).not.toHaveBeenCalled();
  });

  it.each(["paid_cash", "stripe"] as const)("confirms a reduced-to-zero fee as a waiver through %s", async method => {
    waive.mockResolvedValueOnce({ok: true});
    await show(eligible, method, {initialFeeDraft: {
      referenceCents: 9000, finalFee: "0", received: null, reason: "Studio waived this visit",
    }});
    const confirm = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(el => el.textContent === "Confirm fee waiver");
    expect(confirm).toBeTruthy();
    await act(async () => confirm!.click());
    expect(waive).toHaveBeenCalledTimes(1);
    expect(Object.fromEntries(waive.mock.calls[0][0])).toMatchObject({
      appointment_id: "appointment", amount_cents: "9000", reference_fee_cents: "9000",
      final_fee_cents: "0", fee_adjustment_reason: "Studio waived this visit",
    });
    expect(record).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
  });

  it("discards a completed visit draft when the booked price has changed", async () => {
    getContext.mockResolvedValue({
      ok: false, isOwner: true, clientId: "client", reason: "No treatment session",
      settlement: { appointmentId: "appointment", canRecord: true, settledMethod: null,
        settledId: null, settledAmountCents: null, settledQuotedCents: null, quotedAmountCents: 10000, currency: "cad" },
    });
    await act(async () => root.render(createElement(QuickCheckoutModal, { appointmentId: "appointment", open: true,
      initialMethod: "paid_cash", initialFeeDraft: {referenceCents: 9000, finalFee: "75.50", received: "50.25", reason: "Discount"},
      onClose: vi.fn(),
    })));
    expect(host.textContent).toContain("The booked fee changed");
    expect(control("settlement-confirm-paid_cash").textContent).toBe("Confirm payment · $100.00 CAD");
    expect(record).not.toHaveBeenCalled();
  });

  it("opens a saved card for the recorded outstanding fee and retains the original pricing authority", async () => {
    await show(eligible, "stripe", {
      settledMethod: "still_owes", settledId: "outcome", settledAmountCents: 7550, settledQuotedCents: 7550,
    });
    expect(control<HTMLInputElement>("final-charge-input").value).toBe("75.50");
    expect(host.querySelector<HTMLInputElement>('input[name="expected_amount_cents"]')?.value).toBe("9000");
    expect(control<HTMLInputElement>("adjustment-reason-input").value).toBe("Collect recorded outstanding balance");
    expect(prepare).not.toHaveBeenCalled();
  });

  it("defaults cardless owners to e-transfer and keeps a completed $0 visit out of collection", async () => {
    await show(cardless);
    expect(control("settlement-open-paid_e_transfer").getAttribute("aria-pressed")).toBe("true");
    await show(cardless, "paid_e_transfer", {
      settlementQuotedAmountCents: 0,
      amountResult: { kind: "free", serviceName: "Consultation", durationMinutes: 15 },
    });
    expect(host.textContent).toContain("No payment due");
    expect(host.querySelector("fieldset button")).toBeNull();
    expect(host.querySelector('[data-testid="settlement-confirm-paid_e_transfer"]')).toBeNull();
  });

  it.each(["paid_cash", "waived"] as const)("does not offer another Stripe charge after %s is recorded", async method => {
    await show(eligible, "stripe", { settledMethod: method, settledAmountCents: 9000 });
    expect(control("appointment-settlement-recorded")).toBeTruthy();
    expect(host.textContent).not.toContain("Checkout with Stripe");
    expect(host.querySelector("fieldset button")).toBeNull();
    expect(prepare).not.toHaveBeenCalled();
  });

  it("quick checkout keeps the selected external method for a completed appointment without a session", async () => {
    getContext.mockResolvedValue({
      ok: false, isOwner: true, clientId: "client", reason: "No treatment session for this appointment yet.",
      settlement: { appointmentId: "appointment", canRecord: true, settledMethod: null, settledId: null, settledAmountCents: null, settledQuotedCents: null, quotedAmountCents: 9000, currency: "usd" },
    });
    await act(async () => root.render(createElement(QuickCheckoutModal, { appointmentId: "appointment", open: true, initialMethod: "paid_cash", onClose: vi.fn() })));
    expect(getContext).toHaveBeenCalledWith("appointment");
    expect(control<HTMLButtonElement>("settlement-open-stripe").disabled).toBe(true);
    expect(control("settlement-open-paid_cash").getAttribute("aria-pressed")).toBe("true");
    expect(control("settlement-confirm-paid_cash").textContent).toBe("Confirm payment · $90.00 USD");
    expect(host.querySelector("a")?.getAttribute("href")).toBe("/clients/client/sessions/new?appointment_id=appointment");
    expect(record).not.toHaveBeenCalled();
  });

  it("can recheck a failed chart lookup without creating a chart or recording payment", async () => {
    getContext.mockResolvedValueOnce({ ok: false, isOwner: true, clientId: "client", reason: "Could not verify chart", settlement: null, retryable: true });
    getContext.mockResolvedValueOnce({ ok: false, isOwner: true, clientId: "client", reason: "No treatment session",
      settlement: { appointmentId: "appointment", canRecord: true, settledMethod: null, quotedAmountCents: 9000, currency: "cad" } });
    await act(async () => root.render(createElement(QuickCheckoutModal, { appointmentId: "appointment", open: true, onClose: vi.fn() })));
    expect(host.querySelector("a, fieldset")).toBeNull();
    const retry = [...host.querySelectorAll("button")].find(b => b.textContent === "Retry checkout");
    expect(retry).toBeTruthy();
    await act(async () => retry!.click());
    expect(getContext).toHaveBeenCalledTimes(2);
    expect(host.querySelector("a")?.getAttribute("href")).toBe("/clients/client/sessions/new?appointment_id=appointment");
    expect(record).not.toHaveBeenCalled();
  });

  it.each([
    { quotedAmountCents: 0, canRecord: true, settledMethod: null },
    { quotedAmountCents: 9000, canRecord: false, settledMethod: null },
    { quotedAmountCents: 9000, canRecord: true, settledMethod: "paid_cash" },
  ])("offers no chart-for-checkout shortcut for a free, incomplete or settled visit (%j)", async state => {
    getContext.mockResolvedValue({ ok: false, isOwner: true, clientId: "client", reason: "No treatment session",
      settlement: { appointmentId: "appointment", settledId: null, settledAmountCents: null, settledQuotedCents: null, ...state } });
    await act(async () => root.render(createElement(QuickCheckoutModal, { appointmentId: "appointment", open: true, onClose: vi.fn() })));
    expect(host.querySelector("a")?.getAttribute("href")).toBe("/clients/client?tab=sessions");
  });
});
