import { describe, expect, it } from "vitest";
import { decideExecutionPricingPermission } from "@/lib/billing/execution-pricing-permission";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  resolveAuthoritativeSessionPaymentAmount as resolve,
} from "@/lib/billing/session-payment-amount";
import { deriveAppointmentPaymentState } from "@/lib/billing/appointment-payment-state";

// FREE-01. A deliberately $0 service is a DECIDED price of nothing. A NULL
// price is an absent decision. Conflating them made a free consultation look
// like a configuration error AND let it reach Checkout.

// Strips line comments so a guard cannot be satisfied by prose that merely
// quotes the forbidden token. (Same helper idiom as live-mode-disabled.)
function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");
}

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
    expect(CARD).toMatch(/const isFreeNow = amountResult\?\.kind === "free"/);
    expect(CARD).toMatch(/data-testid="payment-not-required"/);
    // Free must not depend on a prepare form being shown: a `ready` attempt
    // sets showPrepareForm false, and the status panel would still offer
    // Run charge.
    expect(CARD).toMatch(/\{isFreeNow && !settledOrInFlightAttempt && \(/);
    expect(CARD).toMatch(/\{activeAttempt && !readyAttemptBlocked && \(/);
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

  // ---- Review 3777045537 / 3777045543: the two P1s this round closed. ----

  it("F10 only a READY attempt is suppressed by freeness; in-flight and settled survive", () => {
    // ACTIVE_STATUSES is {ready, pending_stripe, succeeded}. Only `ready` has a
    // money-moving control, so only `ready` may be hidden. Hiding the others
    // concealed an in-flight charge and removed receipt/refund from a
    // succeeded one.
    // Review 3780286321 generalised this: freeness is no longer a special
    // case, it is one of the non-resolved pricing results that withdraw the
    // ready control. The invariant F10 protects — only `ready` is suppressed,
    // in-flight and settled survive — is unchanged and now lives in the shared
    // decision module.
    expect(CARD).toMatch(/decideReadyControlPermission\(/);
    const PERM = read("lib/billing/ready-control-permission.ts");
    expect(PERM).toMatch(/if \(attemptStatus !== "ready"\)/);
    expect(PERM).toMatch(/return \{ canRun: false, blocked: false \}/);
    expect(CARD).toMatch(
      /const settledOrInFlightAttempt =\s*\n?\s*activeAttempt !== null && activeAttempt\.status !== "ready"/,
    );
    // the panel gate must NOT be the blunt one that hid every active status
    expect(CARD).not.toMatch(/\{activeAttempt && !isFreeNow && \(/);
    // and "No payment required" must yield to money that has actually moved,
    // matching the reducer's processing/paid/refunded > free ranking
    expect(CARD).toMatch(/\{isFreeNow && !settledOrInFlightAttempt && \(/);
  });

  it("F11 permission is granted ONLY by a currently resolved price", () => {
    // Strengthened from a source slice into a direct test of the decision
    // itself. Every kind in the union is enumerated, so this fails if a new
    // kind is ever added and silently allowed. (The behavioural proof that a
    // block really means zero charges lives in
    // tests/app/sessions/execute-pricing-permission.test.ts.)
    const allow = decideExecutionPricingPermission({
      ok: true,
      result: {
        kind: "resolved",
        amountCents: 12_000,
        source: "service_price",
        serviceName: "E",
        durationMinutes: 30,
        customPricingNote: null,
      },
      appointmentId: "a1",
    });
    expect(allow.allow).toBe(true);

    const blocked: Array<[string, ReturnType<typeof decideExecutionPricingPermission>]> = [
      ["no context at all", decideExecutionPricingPermission(null)],
      [
        "load failure",
        decideExecutionPricingPermission({
          ok: false,
          failure: { kind: "session_not_found" },
        }),
      ],
      [
        "free",
        decideExecutionPricingPermission({
          ok: true,
          result: { kind: "free", serviceName: "Consultation", durationMinutes: 30 },
          appointmentId: "a1",
        }),
      ],
      [
        "missing_service",
        decideExecutionPricingPermission({
          ok: true,
          result: { kind: "missing_service" },
          appointmentId: null,
        }),
      ],
      [
        "missing_price",
        decideExecutionPricingPermission({
          ok: true,
          result: { kind: "missing_price", serviceName: "E" },
          appointmentId: "a1",
        }),
      ],
      [
        "ambiguous_custom_pricing",
        decideExecutionPricingPermission({
          ok: true,
          result: {
            kind: "ambiguous_custom_pricing",
            serviceName: "E",
            candidateCents: [1, 2],
          },
          appointmentId: "a1",
        }),
      ],
    ];
    for (const [label, decision] of blocked) {
      expect(decision.allow, label).toBe(false);
      // every refusal carries copy the practitioner can act on
      expect(!decision.allow && decision.error.length, label).toBeGreaterThan(20);
    }
    // and free says so specifically
    const free = blocked.find(([l]) => l === "free")![1];
    expect(!free.allow && free.error).toMatch(/is free — no payment is required/);
  });

  it("F11b the permission module is exhaustive and is NOT an amount source", () => {
    const MOD = read("lib/billing/execution-pricing-permission.ts");
    // No `default` arm: adding a pricing kind must break the BUILD rather than
    // silently inheriting permission to charge. This is the structural
    // property a chain of `if` refusals could never have.
    expect(codeOnly(MOD)).not.toMatch(/default:/);
    expect(codeOnly(MOD)).toMatch(/case "resolved":/);
    expect(codeOnly(MOD)).toMatch(/case "free":/);
    expect(codeOnly(MOD)).toMatch(/case "missing_service":/);
    expect(codeOnly(MOD)).toMatch(/case "missing_price":/);
    expect(codeOnly(MOD)).toMatch(/case "ambiguous_custom_pricing":/);
    // It decides permission; it must never expose or carry an amount.
    expect(codeOnly(MOD)).not.toMatch(/amountCents|amount_cents/);
  });

  it("F11c execution has exactly ONE path to the charge runner", () => {
    // The action must not regain a second, unguarded route.
    const exec = ACTIONS.slice(
      ACTIONS.indexOf("export async function executeSessionPaymentChargeAction"),
    );
    expect(exec).toMatch(/decideExecutionPricingPermission\(/);
    expect(exec).toMatch(/if \(!permission\.allow\)/);
    // one call to the runner in the whole action
    expect(codeOnly(exec).match(/await runSessionPaymentCharge\(/g) ?? []).toHaveLength(1);
    // and the permission decision precedes it
    expect(exec.indexOf("runSessionPaymentCharge({")).toBeGreaterThan(
      exec.indexOf("decideExecutionPricingPermission("),
    );
    // execution still derives no amount of its own
    expect(codeOnly(exec)).not.toMatch(/amountCents|amount_cents/);
  });

  it("no Stripe call was introduced by this change", () => {
    for (const src of [CELL, CARD]) {
      expect(src).not.toMatch(/stripe\.|paymentIntents|charges\.create|refunds\.create/);
    }
  });
});
