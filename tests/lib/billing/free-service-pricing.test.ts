import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  resolveAuthoritativeSessionPaymentAmount as resolve,
} from "@/lib/billing/session-payment-amount";
import { deriveAppointmentPaymentState } from "@/lib/billing/appointment-payment-state";

// FREE-01. A deliberately $0 service is a DECIDED price of nothing. A NULL
// price is an absent decision. Conflating them made a free consultation look
// like a configuration error AND let it reach Checkout.

const svc = (price_cents: number | null) => ({ name: "Consultation", price_cents });
const base = { appointmentDurationMinutes: 30, today: "2026-08-13" };

describe("FREE-01 price matrix", () => {
  it("F1 service price = 0, no overriding custom price => FREE", () => {
    const r = resolve({ ...base, service: svc(0), customPricing: [] });
    expect(r.kind).toBe("free");
    if (r.kind === "free") expect(r.serviceName).toBe("Consultation");
  });

  it("F2 service price = null => missing/unconfigured, NOT free", () => {
    const r = resolve({ ...base, service: svc(null), customPricing: [] });
    expect(r.kind).toBe("missing_price");
    expect(r.kind).not.toBe("free");
  });

  it("F3 service price > 0 => normal resolved amount", () => {
    const r = resolve({ ...base, service: svc(14500), customPricing: [] });
    expect(r.kind).toBe("resolved");
    if (r.kind === "resolved") {
      expect(r.amountCents).toBe(14500);
      expect(r.source).toBe("service_price");
    }
  });

  // The precedence case. A $0 menu price must NOT short-circuit a real
  // client-specific price — that would charge nothing for a client the studio
  // deliberately priced.
  it("F4 zero menu price + current positive custom price => CUSTOM amount, not free", () => {
    const r = resolve({
      ...base,
      service: svc(0),
      customPricing: [
        { service_name: "Consultation", price_cents: 5000, notes: null, effective_from: "2026-01-01" },
      ],
    });
    expect(r.kind).toBe("resolved");
    if (r.kind === "resolved") {
      expect(r.amountCents).toBe(5000);
      expect(r.source).toBe("custom_pricing");
    }
  });

  it("F5 ambiguous custom pricing still fails closed, never silently free", () => {
    const r = resolve({
      ...base,
      service: svc(0),
      customPricing: [
        { service_name: "Consultation", price_cents: 5000, notes: null, effective_from: "2026-01-01" },
        { service_name: "Consultation", price_cents: 7000, notes: null, effective_from: "2026-01-01" },
      ],
    });
    expect(r.kind).toBe("ambiguous_custom_pricing");
    expect(r.kind).not.toBe("free");
  });

  it("a future-dated custom price does not suppress FREE", () => {
    const r = resolve({
      ...base,
      service: svc(0),
      customPricing: [
        { service_name: "Consultation", price_cents: 5000, notes: null, effective_from: "2099-01-01" },
      ],
    });
    expect(r.kind).toBe("free");
  });

  // The model has never accepted a zero custom price as "charge nothing"; such
  // rows read as "no custom price recorded". No support is invented here.
  it("a zero custom price is not a pricing authority; the menu price decides", () => {
    const r = resolve({
      ...base,
      service: svc(14500),
      customPricing: [
        { service_name: "Consultation", price_cents: 0, notes: null, effective_from: "2026-01-01" },
      ],
    });
    expect(r.kind).toBe("resolved");
    if (r.kind === "resolved") expect(r.amountCents).toBe(14500);
  });

  it("missing service is still missing_service, not free", () => {
    expect(resolve({ ...base, service: null, customPricing: [] }).kind).toBe("missing_service");
  });
});

describe("FREE-01 appointment payment state", () => {
  it("free outranks chargeable so Checkout is never offered", () => {
    expect(deriveAppointmentPaymentState(true, [], true)).toBe("free");
    expect(deriveAppointmentPaymentState(true, [], false)).toBe("chargeable");
  });

  it("free applies before a session exists too", () => {
    expect(deriveAppointmentPaymentState(false, [], true)).toBe("free");
    expect(deriveAppointmentPaymentState(false, [], false)).toBe("no_session");
  });

  // Truthfulness: if money actually moved, say so.
  it("R5/R6/R7 terminal money states still win over free", () => {
    expect(deriveAppointmentPaymentState(true, [{ status: "succeeded", refund_status: null }], true)).toBe("paid");
    expect(deriveAppointmentPaymentState(true, [{ status: "succeeded", refund_status: "succeeded" }], true)).toBe("refunded");
    expect(deriveAppointmentPaymentState(true, [{ status: "pending_stripe", refund_status: null }], true)).toBe("processing");
  });

  it("R5-R8 non-free behaviour is unchanged", () => {
    expect(deriveAppointmentPaymentState(true, [{ status: "succeeded", refund_status: null }])).toBe("paid");
    expect(deriveAppointmentPaymentState(true, [{ status: "failed", refund_status: null }])).toBe("chargeable");
    expect(deriveAppointmentPaymentState(false, [])).toBe("no_session");
  });
});

// Source pins: a free visit must never reach a money-moving control.
const read = (rel: string) => readFileSync(path.resolve(__dirname, "../../..", rel), "utf8");
const CELL = read("components/appointment-checkout-cell.tsx");
const CARD = read("components/session-payment-prepare-card.tsx");
const ACTIONS = read("app/(app)/clients/[id]/sessions/[sessionId]/payment-actions.ts");

describe("FREE-01 no money-moving path", () => {
  it("F6 the dashboard/calendar cell renders No payment required, not Checkout", () => {
    expect(CELL).toMatch(/paymentState === "free"/);
    expect(CELL).toMatch(/No payment required/);
    const freeIdx = CELL.indexOf('paymentState === "free"');
    const checkoutIdx = CELL.indexOf("<CheckoutButton");
    expect(freeIdx).toBeGreaterThan(-1);
    expect(checkoutIdx).toBeGreaterThan(freeIdx); // free returns before Checkout
  });

  it("F7 the session prepare card shows a calm free state, never Prepare", () => {
    expect(CARD).toMatch(/amountResult\.kind === "free"/);
    expect(CARD).toMatch(/data-testid="payment-not-required"/);
    // PrepareForm is gated on a strictly `resolved` amount, so free cannot reach it.
    expect(CARD).toMatch(/amountResult\.kind === "resolved" \? amountResult : null/);
  });

  it("F8 free is not shown as a pricing error", () => {
    expect(CARD).toMatch(/amountResult\.kind !== "free"/);
  });

  it("F9 the prepare action returns before any payment attempt is written", () => {
    // Compare against the actual WRITE, not the first textual mention of the
    // table — the file names it in comments long before it touches it.
    const freeIdx = ACTIONS.indexOf('priced.result.kind === "free"');
    const writeIdx = ACTIONS.indexOf(".insert(");
    expect(freeIdx).toBeGreaterThan(-1);
    expect(writeIdx).toBeGreaterThan(-1);
    expect(writeIdx).toBeGreaterThan(freeIdx);
    expect(ACTIONS).toMatch(/is free — no payment is required/);
  });

  it("F9b there is exactly one write in the prepare action, and free returns first", () => {
    expect(ACTIONS.match(/\.insert\(/g) ?? []).toHaveLength(1);
    // and the free branch returns rather than falling through
    const branch = ACTIONS.slice(
      ACTIONS.indexOf('priced.result.kind === "free"'),
      ACTIONS.indexOf(".insert("),
    );
    expect(branch).toMatch(/return \{\s*ok: false/);
  });

  it("no Stripe call was introduced by this change", () => {
    for (const src of [CELL, CARD]) {
      expect(src).not.toMatch(/stripe\.|paymentIntents|charges\.create|refunds\.create/);
    }
  });
});
