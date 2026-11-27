// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppointmentCheckoutCell } from "@/components/appointment-checkout-cell";
import type { AppointmentPaymentState } from "@/lib/billing/appointment-payment-state";
import type { CardOnFileStatus } from "@/lib/payment-methods/card-on-file";

const { complete, refresh, loadQuote } = vi.hoisted(() => ({ complete: vi.fn(), refresh: vi.fn(), loadQuote: vi.fn() }));
vi.mock("@/app/(app)/quick-checkout-actions", () => ({ getDashboardCheckoutQuoteAction: loadQuote }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/app/(app)/calendar/actions", () => ({ markAppointmentCompleteAction: complete }));
vi.mock("@/components/quick-checkout-modal", () => ({
  QuickCheckoutModal: ({ appointmentId, open, initialMethod, initialFeeDraft }: { appointmentId: string; open: boolean; initialMethod?: string; initialFeeDraft?: unknown }) =>
    open ? createElement("div", { role: "dialog", "data-appointment": appointmentId, "data-method": initialMethod, "data-draft": JSON.stringify(initialFeeDraft) }, "Session checkout") : null,
}));

const appointmentId = "dashboard-appointment";
let host: HTMLDivElement;
let root: Root;
const past = new Date(Date.now() - 60_000).toISOString();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  vi.clearAllMocks();
  loadQuote.mockResolvedValue(null);
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

async function render(
  status: string,
  startsAt?: string,
  paymentState: AppointmentPaymentState = "chargeable",
  dashboardCardOnFile?: CardOnFileStatus | null,
) {
  await act(async () => root.render(
    createElement(AppointmentCheckoutCell, { appointmentId, status, paymentState, dashboardStartsAt: startsAt, dashboardCardOnFile }),
  ));
}
function button(label: string) {
  const match = [...host.querySelectorAll("button")].find(button => button.textContent === label);
  if (!match) throw new Error(`Missing ${label}`);
  return match;
}
const click = (label: string) => act(async () => { button(label).click(); });
const checkout = () => host.querySelector('[role="dialog"]');

describe("checkout for a confirmed dashboard visit", () => {
  it("offers one enabled way to finish the visit and review the saved-card charge", async () => {
    loadQuote.mockResolvedValue({ referenceCents: 9000, currency: "cad" });
    complete.mockResolvedValue({ ok: true });
    await render("confirmed", past, "chargeable", "card_on_file");
    await click("Checkout");
    expect(button("Stripe").getAttribute("aria-pressed")).toBe("true");
    expect(button("Finish visit and review card charge").disabled).toBe(false);
    expect([...host.querySelectorAll("button")].some(b => b.textContent?.startsWith("Confirm payment"))).toBe(false);
    expect(complete).not.toHaveBeenCalled();
    await click("Finish visit and review card charge");
    expect(complete).toHaveBeenCalledTimes(1);
    expect([...complete.mock.calls[0][0].entries()]).toEqual([["appointment_id", appointmentId]]);
    expect(checkout()?.getAttribute("data-method")).toBe("stripe");
    await render("completed", past);
    expect(checkout()?.getAttribute("data-appointment")).toBe(appointmentId);
  });

  it("opens the payment flow for this appointment only after explicit completion and keeps it open through refresh", async () => {
    complete.mockResolvedValue({ ok: true });
    await render("confirmed", past);
    await click("Checkout");
    for (const label of ["Stripe", "E-transfer", "Cash", "Other external", "Still owes", "Fee waived"]) {
      expect(button(label).disabled).toBe(false);
    }
    expect(button("Confirm payment").disabled).toBe(true);
    expect(document.activeElement).toBe(button("Stripe"));
    await click("E-transfer");
    expect(button("E-transfer").getAttribute("aria-pressed")).toBe("true");
    expect(complete).not.toHaveBeenCalled();
    expect(checkout()).toBeNull();
    await click("Finish visit");
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0][0].get("appointment_id")).toBe(appointmentId);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(checkout()?.getAttribute("data-appointment")).toBe(appointmentId);
    expect(checkout()?.getAttribute("data-method")).toBe("paid_e_transfer");
    await render("completed", past);
    expect(checkout()?.getAttribute("data-appointment")).toBe(appointmentId);
    expect(host.querySelector('[role="alertdialog"]')).toBeNull();
  });

  it("carries the edited fee and partial receipt into review without sending either to the finish action", async () => {
    loadQuote.mockResolvedValue({ referenceCents: 9000, currency: "cad" });
    complete.mockResolvedValue({ ok: true });
    await render("confirmed", past, "chargeable", "no_card");
    await click("Checkout");
    expect(button("Confirm payment · $90.00 CAD").disabled).toBe(true);

    async function type(label: string, value: string) {
      const input = host.querySelector<HTMLInputElement>(`[data-testid="${label}"]`)!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    }
    await type("checkout-final-fee", "75.50");
    await type("checkout-fee-reason", "Agreed visit fee");
    await type("settlement-amount", "50.25");
    expect(button("Confirm payment · $50.25 CAD").disabled).toBe(true);
    expect(host.textContent).toContain("$25.25 CAD");
    expect(complete).not.toHaveBeenCalled();
    await click("Finish visit");
    expect([...complete.mock.calls[0][0].entries()]).toEqual([["appointment_id", appointmentId]]);
    expect(JSON.parse(checkout()!.getAttribute("data-draft")!)).toEqual({
      referenceCents: 9000, finalFee: "75.50", received: "50.25", reason: "Agreed visit fee",
    });
  });

  it("honours a fresh zero quote even if the cached roster showed a chargeable visit", async () => {
    loadQuote.mockResolvedValue({ referenceCents: 0, currency: "cad" });
    complete.mockResolvedValue({ ok: true });
    await render("confirmed", past, "no_session", "no_card");
    await click("Checkout");
    expect(host.textContent).toContain("No payment due");
    expect(host.querySelector("fieldset")).toBeNull();
    await click("Finish visit");
    expect(complete).toHaveBeenCalledTimes(1);
    expect(checkout()).toBeNull();
  });

  it("stays on the dashboard if cancelled or if completion fails", async () => {
    complete.mockResolvedValue({ ok: false, error: "Could not complete." });
    await render("confirmed", past);
    await click("Checkout");
    await click("Cash");
    await click("Cancel");
    expect(complete).not.toHaveBeenCalled();
    expect(checkout()).toBeNull();
    await click("Checkout");
    expect(button("Cash").getAttribute("aria-pressed")).toBe("false");
    await click("Still owes");
    expect(button("Record amount owed").disabled).toBe(true);
    await click("Fee waived");
    expect(button("Confirm fee waiver").disabled).toBe(true);
    await click("Finish visit");
    expect(host.querySelector('[role="alertdialog"]')?.textContent).toContain("Could not complete.");
    expect(refresh).not.toHaveBeenCalled();
    expect(checkout()).toBeNull();
  });

  it.each([
    ["chargeable", "no_card", "no saved card"],
    ["chargeable", "unavailable", "could not be verified"],
    ["no_session", "card_on_file", "treatment chart"],
  ] as const)("shows the eligible external methods for %s / %s", async (state, card, reason) => {
    await render("confirmed", past, state, card);
    await click("Checkout");
    expect(button("Stripe").disabled).toBe(true);
    expect(button("E-transfer").disabled).toBe(false);
    expect(document.activeElement).toBe(button("E-transfer"));
    expect(host.textContent).toContain(reason);
    expect(button("Confirm payment").disabled).toBe(true);
    expect(complete).not.toHaveBeenCalled();
  });

  it.each([
    ["chargeable", "no_card", "E-transfer", "paid_e_transfer"],
    ["no_session", "card_on_file", "E-transfer", "paid_e_transfer"],
    ["chargeable", "unavailable", null, null],
    ["chargeable", null, null, null],
  ] as const)("uses a local default for %s / %s and carries it through explicit completion", async (state, card, label, method) => {
    complete.mockResolvedValue({ok: true});
    await render("confirmed", past, state, card);
    await click("Checkout");
    expect(host.querySelector('[aria-pressed="true"]')?.textContent ?? null).toBe(label);
    expect(button("Confirm payment").disabled).toBe(true);
    expect(complete).not.toHaveBeenCalled();
    expect(checkout()).toBeNull();
    await click("Finish visit");
    const completionBody: FormData = complete.mock.calls[0][0];
    expect([...completionBody.entries()]).toEqual([["appointment_id", appointmentId]]);
    expect(checkout()?.getAttribute("data-method")).toBe(method);
  });

  it.each(["paid", "processing", "free", "unavailable", "settled_waived"] as const)(
    "keeps completion accessible without new tenders for a %s visit", async state => {
      complete.mockResolvedValue({ok: true});
      await render("confirmed", past, state);
      await click("Mark completed");
      expect(host.querySelector("fieldset")).toBeNull();
      await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="confirm-dialog-confirm"]')!.click());
      expect(complete).toHaveBeenCalledTimes(1);
      expect(checkout()).toBeNull();
    },
  );

  it("keeps future appointments disabled and reserves this entry for the dashboard", async () => {
    await render("confirmed", new Date(Date.now() + 60_000).toISOString());
    expect(button("Checkout").disabled).toBe(true);
    await render("confirmed");
    expect(host.querySelector("button")).toBeNull();
    await render("cancelled", past);
    expect(host.querySelector("button")).toBeNull();
    expect(complete).not.toHaveBeenCalled();
  });
});
