import { readFileSync } from "node:fs";
import path from "node:path";
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

// PAY-CCY-04. An attested amount names the currency its row was recorded in,
// and a new amount is labelled with the studio's currency.
describe("settlement amounts carry their currency", () => {
  it("a recorded USD settlement reads USD; a CAD one reads CAD", () => {
    expect(
      render({ settledMethod: "paid_cash", settledAmountCents: 4500, settledCurrency: "usd", currency: "usd" }),
    ).toContain("$45.00 USD");
    expect(
      render({ settledMethod: "paid_cash", settledAmountCents: 4500, settledCurrency: "cad", currency: "cad" }),
    ).toContain("$45.00 CAD");
  });

  it("the RECORDED row's currency wins over the studio's current one", () => {
    const html = render({ settledMethod: "paid_cash", settledAmountCents: 4500, settledCurrency: "cad", currency: "usd" });
    expect(html).toContain("$45.00 CAD");
    expect(html).not.toContain("USD");
  });

  it("an unknown currency is said so, never shown as Canadian", () => {
    const html = render({ settledMethod: "paid_cash", settledAmountCents: 4500, settledCurrency: null, currency: null });
    expect(html).toContain("$45.00 (currency unknown)");
    expect(html).not.toContain("CAD");
  });
});

// Codex P2 4249009847. The entry label names the studio's currency, and a
// failed studio-currency read says so instead of rendering nothing.
describe("the settlement amount field names its currency", () => {
  it("USD, CAD, and an unknown currency said out loud", async () => {
    const { settlementAmountLabel } = await import("@/components/appointment-settlement-controls");
    expect(settlementAmountLabel("paid_cash", "usd")).toBe("Amount collected (USD)");
    expect(settlementAmountLabel("paid_e_transfer", "cad")).toBe("Amount collected (CAD)");
    expect(settlementAmountLabel("still_owes", "usd")).toBe("Amount still owed (USD)");
    expect(settlementAmountLabel("waived", "cad")).toBe("Amount waived (CAD)");
    expect(settlementAmountLabel("paid_cash", null)).toBe("Amount collected (currency unknown)");
    expect(settlementAmountLabel("paid_other_external", null)).not.toMatch(/CAD|USD/);
  });

  it("the field renders that label, not a hand-written one", () => {
    const src = readFileSync(
      path.join(process.cwd(), "components/appointment-settlement-controls.tsx"),
      "utf8",
    );
    expect(src).toContain("{settlementAmountLabel(open, currency)}");
    expect(src).not.toMatch(/: ""\}\s*\n\s*<input/);
  });
});

// PAY-CCY-07 (#824; option B chosen 2026-10-12). A US studio
// is not offered Interac e-Transfer; its Zelle / Venmo / check is recorded as
// paid_other_external with US wording. Canada and an unread country are
// byte-for-byte today's list. Stored values and meanings are unchanged.
describe("US external payments (option B, draft)", () => {
  const buttons = (html: string) =>
    [...html.matchAll(/data-testid="settlement-open-([a-z_]+)"[^>]*>([^<]*)</g)].map(
      (m) => [m[1], m[2]] as const,
    );
  const TODAY = [
    ["paid_cash", "Paid cash"],
    ["paid_e_transfer", "Paid by e-transfer"],
    ["paid_other_external", "Paid another way"],
    ["still_owes", "Client still owes"],
  ];

  it("US: e-transfer is not offered; 'Paid another way' names the US rails", () => {
    expect(buttons(render({ settledMethod: null, paymentCountry: "US" }))).toEqual([
      ["paid_cash", "Paid cash"],
      ["paid_other_external", "Paid another way (Zelle, Venmo, check)"],
      ["still_owes", "Client still owes"],
    ]);
  });

  it("US owner still gets Waive, and still no e-transfer", () => {
    const html = render({ settledMethod: null, paymentCountry: "US", isOwner: true });
    expect(html).toContain("settlement-open-waived");
    expect(html).not.toContain("settlement-open-paid_e_transfer");
  });

  it("CANADIAN REGRESSION: a CA studio sees exactly today's four, worded exactly as today", () => {
    expect(buttons(render({ settledMethod: null, paymentCountry: "CA" }))).toEqual(TODAY);
  });

  it("an UNREAD country keeps today's full list (no silent change on a failed read)", () => {
    expect(buttons(render({ settledMethod: null, paymentCountry: null }))).toEqual(TODAY);
  });

  it("an existing paid_e_transfer record still reads truthfully, whatever the country", () => {
    const html = render({
      settledMethod: "paid_e_transfer",
      settledAmountCents: 4500,
      settledCurrency: "usd",
      currency: "usd",
      paymentCountry: "US",
    });
    expect(html).toContain("Paid · e-transfer");
  });

  it("the stored vocabulary and its meanings are unchanged; the server still accepts every value", async () => {
    const t = await import("@/lib/billing/settlement-types");
    expect([...t.SETTLEMENT_METHODS]).toEqual([
      "paid_cash",
      "paid_e_transfer",
      "paid_other_external",
      "waived",
      "still_owes",
    ]);
    expect([...t.PRACTITIONER_METHODS]).toEqual([
      "paid_cash",
      "paid_e_transfer",
      "paid_other_external",
      "still_owes",
    ]);
    // The VOCABULARY still contains it: the per-country refusal lives in the
    // server actions (tests/app/settlement-country-enforcement.test.ts) and
    // the 0224 guard, not in the type.
    expect(t.isPractitionerMethod("paid_e_transfer")).toBe(true);
    expect(t.SETTLEMENT_BADGE_LABEL.paid_other_external).toBe("Paid · other");
    expect(t.SETTLEMENT_ACTION_LABEL.paid_other_external).toBe("Paid another way");
  });
});
