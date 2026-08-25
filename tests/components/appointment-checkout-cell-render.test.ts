import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { readFileSync } from "node:fs";
import path from "node:path";

// PAY-SETTLE / 0187 — WHAT THE DASHBOARD/CALENDAR ROW ACTUALLY RENDERS.
//
// Rendered output, not a source grep, because the finding this file pins was
// invisible in the source: `settled_owing` sat in the same map as the four
// collected/waived outcomes and inherited their badge-only branch. Every layer
// underneath deliberately permits a still-owing visit to be charged later —
// the SQL blocking set excludes it, prepareSessionPaymentChargeAction lets it
// through, settlementIsOutranked exists for exactly that progression — and the
// row silently removed the door.

vi.mock("@/components/checkout-button", async () => {
  const { createElement: ce } = await import("react");
  return {
    // Rendered as a marker element so the tests can assert the SHARED entry
    // point was used, with the props it was given, rather than some second
    // checkout implementation that merely looks similar.
    CheckoutButton: ({
      appointmentId,
      status,
      variant,
      label,
    }: {
      appointmentId: string;
      status: string | null;
      variant?: string;
      label?: string;
    }) =>
      ce(
        "button",
        {
          "data-testid": "shared-checkout-button",
          "data-appointment": appointmentId,
          "data-status": status,
          "data-variant": variant ?? "primary",
        },
        label ?? "Checkout",
      ),
  };
});

const { renderToStaticMarkup } = await import("react-dom/server");
const { createElement } = await import("react");
const { AppointmentCheckoutCell } = await import(
  "@/components/appointment-checkout-cell"
);

const APPT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function render(paymentState: string): string {
  return renderToStaticMarkup(
    createElement(AppointmentCheckoutCell, {
      appointmentId: APPT,
      status: "completed",
      paymentState,
    } as never) as ReactNode,
  );
}

const hasCheckout = (html: string) => html.includes("shared-checkout-button");

describe("attested outcomes that are SETTLED offer no Checkout", () => {
  it.each([
    ["settled_cash", "Paid"],
    ["settled_e_transfer", "Paid"],
    ["settled_other", "Paid"],
    ["settled_waived", "Fee waived"],
  ])("%s renders a neutral badge and NO Checkout", (state, label) => {
    const html = render(state);
    expect(html).toContain(`appointment-${state}`);
    expect(html).toContain(label);
    expect(hasCheckout(html)).toBe(false);
    // Neutral, never emerald: an attestation is not verified money.
    expect(html).toContain("bg-neutral-100");
    expect(html).not.toContain("emerald");
  });
});

describe("still_owes states BOTH facts: unpaid, and still collectable", () => {
  it("renders the neutral Still owes badge AND a Checkout entry", () => {
    const html = render("settled_owing");
    expect(html).toContain("appointment-settled_owing");
    expect(html).toContain("Still owes");
    expect(hasCheckout(html)).toBe(true);
  });

  it("the badge stays neutral and is never relabelled Paid", () => {
    const html = render("settled_owing");
    expect(html).toContain("bg-neutral-100");
    expect(html).not.toContain("emerald");
    // "Still owes" is the whole label; nothing here claims payment.
    const badge = html.slice(html.indexOf("appointment-settled_owing"));
    expect(badge.slice(0, 200)).not.toMatch(/>\s*Paid/);
  });

  it("uses the ORDINARY Checkout wording, not 'Record outcome'", () => {
    // An outcome has already been recorded. This is the ordinary card path for
    // money that is still owed.
    const html = render("settled_owing");
    expect(html).toContain(">Checkout<");
    expect(html).not.toContain("Record outcome");
  });

  it("reuses the SHARED CheckoutButton, with the row's own appointment + status", () => {
    const html = render("settled_owing");
    expect(html).toContain(`data-appointment="${APPT}"`);
    expect(html).toContain('data-status="completed"');
    expect(html).toContain('data-variant="compact"');
  });
});

describe("the card-truth states are unchanged", () => {
  it("paid renders the emerald verified badge and no Checkout", () => {
    const html = render("paid");
    expect(html).toContain("appointment-payment-paid");
    expect(html).toContain("emerald");
    expect(html).toContain("Paid");
    expect(hasCheckout(html)).toBe(false);
  });

  it("processing renders the amber processing badge and no Checkout", () => {
    const html = render("processing");
    expect(html).toContain("appointment-payment-processing");
    expect(html).toContain("Processing");
    expect(hasCheckout(html)).toBe(false);
  });

  it("a PARTIAL/unproven refund keeps the badge and offers nothing", () => {
    const html = render("refunded");
    expect(html).toContain("appointment-payment-refunded");
    expect(html).toContain("Refunded");
    expect(hasCheckout(html)).toBe(false);
  });

  it("a FULL refund keeps its badge plus the Record outcome route", () => {
    const html = render("refunded_full");
    expect(html).toContain("appointment-payment-refunded_full");
    expect(html).toContain("Refunded");
    expect(hasCheckout(html)).toBe(true);
    expect(html).toContain("Record outcome");
  });

  it("an unsettled chargeable visit still offers ordinary Checkout", () => {
    const html = render("chargeable");
    expect(hasCheckout(html)).toBe(true);
    expect(html).toContain(">Checkout<");
  });
});

describe("the progression still_owes -> paid by card", () => {
  it("verified card money OUTRANKS the attestation in the row state", () => {
    // The settlement row stays in the database as history; the DISPLAY simply
    // stops leading with it once Hone holds verified money. Proven as the pure
    // ranking in tests/lib/billing/appointment-settlement.test.ts; asserted
    // here as what the row shows at each end of the progression.
    expect(render("settled_owing")).toContain("Still owes");
    expect(render("paid")).toContain("emerald");
    expect(hasCheckout(render("paid"))).toBe(false);
  });

  it("an in-flight charge shows Processing rather than the attestation", () => {
    expect(render("processing")).toContain("Processing");
    expect(hasCheckout(render("processing"))).toBe(false);
  });
});

describe("there is exactly ONE checkout implementation", () => {
  it("the cell imports the shared CheckoutButton and defines no other", () => {
    const CELL = readFileSync(
      path.resolve(__dirname, "../..", "components/appointment-checkout-cell.tsx"),
      "utf8",
    );
    expect(CELL).toMatch(
      /import \{ CheckoutButton \} from "@\/components\/checkout-button"/,
    );
    // No second modal, no second entry point, no hand-rolled button.
    expect(CELL).not.toMatch(/QuickCheckoutModal|useState|onClick=/);
    // Every entry point in the file is the shared component.
    const opens = [...CELL.matchAll(/<CheckoutButton/g)];
    expect(opens.length).toBeGreaterThanOrEqual(3);
  });
});
