import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  resolveAuthoritativeSessionPaymentAmount as resolve,
  unresolvedAmountMessage,
  type AuthoritativeCustomPricingInput,
} from "@/lib/billing/session-payment-amount";

// F-PAY-001. The browser used to decide amount_cents. These prove the SERVER
// decision: one number, from trusted records, or an explicit block.

const TODAY = "2026-07-31";

function svc(over: Partial<{ name: string; price_cents: number | null }> = {}) {
  return { name: "Electrolysis 60", price_cents: 14500, ...over };
}
function cp(
  over: Partial<AuthoritativeCustomPricingInput> = {},
): AuthoritativeCustomPricingInput {
  return {
    service_name: "Electrolysis 60",
    price_cents: 12000,
    notes: null,
    effective_from: "2026-01-01",
    ...over,
  };
}
function run(over: Partial<Parameters<typeof resolve>[0]> = {}) {
  return resolve({
    service: svc(),
    appointmentDurationMinutes: 60,
    customPricing: [],
    today: TODAY,
    ...over,
  });
}

describe("1-2. precedence", () => {
  it("a current custom client price wins over the menu price", () => {
    const r = run({ customPricing: [cp({ price_cents: 12000 })] });
    expect(r).toMatchObject({ kind: "resolved", amountCents: 12000, source: "custom_pricing" });
  });

  it("the menu price is used when no custom price applies", () => {
    const r = run();
    expect(r).toMatchObject({ kind: "resolved", amountCents: 14500, source: "service_price" });
  });
});

describe("3-4. effective dating", () => {
  it("a FUTURE custom price is ignored", () => {
    const r = run({ customPricing: [cp({ effective_from: "2099-01-01", price_cents: 500 })] });
    expect(r).toMatchObject({ amountCents: 14500, source: "service_price" });
  });

  it("the newest effective custom price wins", () => {
    const r = run({
      customPricing: [
        cp({ effective_from: "2026-01-01", price_cents: 11000 }),
        cp({ effective_from: "2026-06-01", price_cents: 13000 }),
        cp({ effective_from: "2025-01-01", price_cents: 9000 }),
      ],
    });
    expect(r).toMatchObject({ amountCents: 13000, source: "custom_pricing" });
  });

  it("a price effective TODAY counts (boundary is inclusive)", () => {
    const r = run({ customPricing: [cp({ effective_from: TODAY, price_cents: 10500 })] });
    expect(r).toMatchObject({ amountCents: 10500, source: "custom_pricing" });
    // ...and one day later does not.
    const tomorrow = run({ customPricing: [cp({ effective_from: "2026-08-01", price_cents: 1 })] });
    expect(tomorrow).toMatchObject({ source: "service_price" });
  });
});

describe("5-6. service matching", () => {
  it("matches the service name trimmed and case-insensitively", () => {
    const r = run({ customPricing: [cp({ service_name: "  eLeCtRoLySiS 60  ", price_cents: 9900 })] });
    expect(r).toMatchObject({ amountCents: 9900, source: "custom_pricing" });
  });

  it("pricing for an UNRELATED service is ignored", () => {
    const r = run({ customPricing: [cp({ service_name: "Consultation", price_cents: 100 })] });
    expect(r).toMatchObject({ amountCents: 14500, source: "service_price" });
  });
});

describe("7. non-positive custom prices", () => {
  it("zero and negative custom prices do not become the charge", () => {
    for (const price of [0, -500]) {
      const r = run({ customPricing: [cp({ price_cents: price })] });
      expect(r, `price ${price}`).toMatchObject({ amountCents: 14500, source: "service_price" });
    }
  });
});

describe("8-9. blocked states", () => {
  it("no booked service blocks", () => {
    const r = run({ service: null });
    expect(r).toEqual({ kind: "missing_service" });
    expect(unresolvedAmountMessage(r as never)).toMatch(/no booked service/i);
  });

  it("no price anywhere blocks", () => {
    const r = run({ service: svc({ price_cents: null }) });
    expect(r).toEqual({ kind: "missing_price", serviceName: "Electrolysis 60" });
    expect(unresolvedAmountMessage(r as never)).toMatch(/No price is configured/);
  });

  // FREE-01 changed this deliberately. A zero menu price is a DECIDED price of
  // nothing (a free consultation), not an absent one. It resolves to its own
  // `free` state — which can never be prepared or charged — while a NULL price
  // still blocks as missing_price. The two are no longer conflated.
  it("a zero menu price is FREE, not blocked", () => {
    expect(run({ service: svc({ price_cents: 0 }) })).toMatchObject({ kind: "free" });
  });

  it("a NULL menu price still blocks as missing_price", () => {
    expect(run({ service: svc({ price_cents: null }) })).toMatchObject({ kind: "missing_price" });
  });
});

describe("10-11. ambiguous custom pricing", () => {
  it("equally current CONFLICTING prices fail closed", () => {
    const r = run({
      customPricing: [
        cp({ effective_from: "2026-06-01", price_cents: 13000 }),
        cp({ effective_from: "2026-06-01", price_cents: 11000 }),
      ],
    });
    expect(r).toEqual({
      kind: "ambiguous_custom_pricing",
      serviceName: "Electrolysis 60",
      candidateCents: [11000, 13000],
    });
    expect(unresolvedAmountMessage(r as never)).toMatch(/more than one current client-specific price/);
  });

  it("equally current IDENTICAL prices are safe and deterministic", () => {
    // Every candidate yields the same number, so no row-order dependence exists.
    const r = run({
      customPricing: [
        cp({ effective_from: "2026-06-01", price_cents: 12500, notes: "a" }),
        cp({ effective_from: "2026-06-01", price_cents: 12500, notes: "b" }),
      ],
    });
    expect(r).toMatchObject({ kind: "resolved", amountCents: 12500, source: "custom_pricing" });
  });

  it("an OLDER conflicting pair does not block when a newer single row exists", () => {
    const r = run({
      customPricing: [
        cp({ effective_from: "2026-01-01", price_cents: 100 }),
        cp({ effective_from: "2026-01-01", price_cents: 200 }),
        cp({ effective_from: "2026-06-01", price_cents: 13000 }),
      ],
    });
    expect(r).toMatchObject({ kind: "resolved", amountCents: 13000 });
  });
});

describe("12-14. metadata and forbidden inputs", () => {
  it("duration is preserved as metadata only", () => {
    expect(run({ appointmentDurationMinutes: 90 })).toMatchObject({ durationMinutes: 90 });
    expect(run({ appointmentDurationMinutes: null })).toMatchObject({ durationMinutes: null });
  });

  it("duration NEVER changes the amount — no per-minute arithmetic", () => {
    const a = run({ appointmentDurationMinutes: 30 }) as { amountCents: number };
    const b = run({ appointmentDurationMinutes: 120 }) as { amountCents: number };
    expect(a.amountCents).toBe(b.amountCents);
    expect(a.amountCents).toBe(14500);
  });

  it("the module has no historical-session-price fallback and no browser input", () => {
    // Strip comments: the header NAMES the rejected fallbacks in order to say
    // they are never consulted. Prose explaining a ban is not a violation.
    const SRC = readFileSync(join(process.cwd(), "lib/billing/session-payment-amount.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !/^\s*\/\//.test(l))
      .join("\n");
    for (const forbidden of [
      "price_paid_cents",
      "amount_dollars",
      "formData",
      "FormData",
      "Date.now",
      "new Date(",
      "supabase",
      "await ",
    ]) {
      expect(SRC, `must not reference ${forbidden}`).not.toContain(forbidden);
    }
  });
});

describe("15-17. purity and determinism", () => {
  it("does not mutate its inputs", () => {
    const rows = [cp({ effective_from: "2026-01-01" }), cp({ effective_from: "2026-06-01" })];
    const snapshot = JSON.parse(JSON.stringify(rows));
    run({ customPricing: rows });
    expect(JSON.parse(JSON.stringify(rows))).toEqual(snapshot);
  });

  it("is independent of row order", () => {
    const rows = [
      cp({ effective_from: "2026-01-01", price_cents: 11000 }),
      cp({ effective_from: "2026-06-01", price_cents: 13000 }),
      cp({ service_name: "Other", price_cents: 1 }),
    ];
    const forward = run({ customPricing: rows });
    const reversed = run({ customPricing: [...rows].reverse() });
    expect(JSON.stringify(forward)).toBe(JSON.stringify(reversed));
  });

  it("ambiguity reporting is order-independent too", () => {
    const a = run({
      customPricing: [
        cp({ effective_from: "2026-06-01", price_cents: 13000 }),
        cp({ effective_from: "2026-06-01", price_cents: 11000 }),
      ],
    });
    const b = run({
      customPricing: [
        cp({ effective_from: "2026-06-01", price_cents: 11000 }),
        cp({ effective_from: "2026-06-01", price_cents: 13000 }),
      ],
    });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("same input, same output", () => {
    const args = { customPricing: [cp()] };
    expect(JSON.stringify(run(args))).toBe(JSON.stringify(run(args)));
  });
});
