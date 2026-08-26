import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

// PAY-SETTLE / 0187 — WHAT THE SETTLEMENT CONTROLS ACTUALLY RENDER.
//
// These run the real component through react-dom/server rather than grepping
// its source, following tests/components/checkout-final-amount-ui.test.ts. A
// source pin could show that a "recorded" branch exists somewhere; it could not
// show that the ACTION BUTTONS ARE GONE once an outcome is recorded — which is
// the whole of the P2 finding: the modal kept offering them, and the only thing
// stopping a second record was the command answering `already_settled`.
//
// LIMIT OF THIS HARNESS, STATED PLAINLY: the repo has no jsdom and no
// @testing-library, so a click-through cannot be run here. What is proved is
// the OUTPUT for each state the modal can hold. That the modal reaches the
// settled state without being closed and reopened is proved separately, by the
// wiring assertions in tests/lib/billing/appointment-settlement.test.ts.

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined }),
}));
vi.mock("@/app/(app)/appointment-settlement-actions", () => ({
  recordAppointmentSettlementAction: async () => ({ ok: true }),
  waiveAppointmentFeeAction: async () => ({ ok: true }),
}));

const { renderToStaticMarkup } = await import("react-dom/server");
const { AppointmentSettlementControls } = await import(
  "@/components/appointment-settlement-controls"
);
const { createElement } = await import("react");

const APPT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function render(props: Record<string, unknown>): string {
  return renderToStaticMarkup(
    createElement(AppointmentSettlementControls, {
      appointmentId: APPT,
      isOwner: false,
      ...props,
    } as never) as ReactNode,
  );
}

describe("an UNSETTLED visit offers the outcomes", () => {
  it("renders every practitioner action", () => {
    const html = render({ settledMethod: null });
    for (const m of ["paid_cash", "paid_e_transfer", "paid_other_external", "still_owes"]) {
      expect(html).toContain(`settlement-open-${m}`);
    }
    expect(html).toContain("appointment-settlement-controls");
  });

  it("withholds Waive from a non-owner, and says why rather than hiding silently", () => {
    const html = render({ settledMethod: null, isOwner: false });
    expect(html).not.toContain("settlement-open-waived");
    expect(html).toContain("Waiving a fee is a studio-owner decision.");
  });

  it("offers Waive to an owner", () => {
    const html = render({ settledMethod: null, isOwner: true });
    expect(html).toContain("settlement-open-waived");
  });

  it("says out loud that Hone did not verify this", () => {
    const html = render({ settledMethod: null });
    expect(html).toContain("does not take a payment and Hone");
  });
});

describe("a SETTLED visit shows the outcome and offers nothing further", () => {
  // THIS IS THE P2 FIX, AS OUTPUT. Once the modal's context carries the
  // recorded outcome, the buttons are gone from the SAME render — a second
  // submission is not reachable through ordinary UI at all, rather than being
  // caught by `already_settled` after the fact.
  it("renders the recorded outcome, and NO action buttons", () => {
    const html = render({
      settledMethod: "paid_cash",
      settledAmountCents: 4500,
      isOwner: true,
    });
    expect(html).toContain("appointment-settlement-recorded");
    expect(html).toContain("Paid");
    expect(html).toContain("cash");
    for (const m of [
      "paid_cash",
      "paid_e_transfer",
      "paid_other_external",
      "still_owes",
      "waived",
    ]) {
      expect(html).not.toContain(`settlement-open-${m}`);
      expect(html).not.toContain(`settlement-confirm-${m}`);
    }
    // No amount field either: there is nothing to submit.
    expect(html).not.toContain("settlement-amount");
  });

  it("shows the amount, and marks it as attested rather than verified", () => {
    const html = render({ settledMethod: "paid_cash", settledAmountCents: 4500 });
    expect(html).toContain("45.00");
    expect(html).toContain("Recorded by the studio, not verified by Hone");
  });

  it("tells a non-owner that correction is an owner decision", () => {
    const html = render({ settledMethod: "waived", settledAmountCents: 4500, isOwner: false });
    expect(html).toContain("Ask the studio owner");
    expect(html).not.toContain("settlement-open-waived");
  });

  it("every method renders its own badge, never a bare 'Paid'", () => {
    const seen = new Set<string>();
    for (const m of [
      "paid_cash",
      "paid_e_transfer",
      "paid_other_external",
      "waived",
      "still_owes",
    ]) {
      const html = render({ settledMethod: m, settledAmountCents: 1000 });
      const label = html.slice(html.indexOf("font-medium"), html.indexOf("font-medium") + 200);
      seen.add(label);
      expect(html).toContain("appointment-settlement-recorded");
    }
    // Five distinct renderings: the distinction the schema keeps survives to
    // the screen.
    expect(seen.size).toBe(5);
  });
});
