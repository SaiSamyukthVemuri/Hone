import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #216. The Chloe iPad retest fixes must not touch the
// Stripe gate counts. This file is a regression backstop that pins
// the existing allowlist + exact-count discipline.

const GATE_PATH = path.resolve(
  __dirname,
  "../../scripts/check-stripe-gates.mjs",
);
const GATE = readFileSync(GATE_PATH, "utf8");

describe("check-stripe-gates: unchanged by PR #216", () => {
  it("paymentIntents.create still exactly 2", () => {
    expect(GATE).toMatch(
      /name:\s*"paymentIntents\.create"[\s\S]{0,3000}exactly:\s*2/,
    );
  });

  it("refunds.create still exactly 1 (PR #178 allowlist)", () => {
    expect(GATE).toMatch(
      /name:\s*"refunds\.create"[\s\S]{0,2000}exactly:\s*1/,
    );
  });

  it("refunds.create allowlist still names only payment-refund.ts", () => {
    const block =
      GATE.match(/name:\s*"refunds\.create"[\s\S]{0,2000}exactly:\s*1/)?.[0] ??
      "";
    const allowlistPaths = block.match(/"lib\/[^"]+"/g) ?? [];
    expect(allowlistPaths.length).toBe(1);
    expect(allowlistPaths[0]).toBe('"lib/billing/payment-refund.ts"');
  });

  it("charges.create still exactly 0", () => {
    expect(GATE).toMatch(/name:\s*"charges\.create"[\s\S]{0,400}exactly:\s*0/);
  });

  it("checkout.sessions still exactly 0", () => {
    expect(GATE).toMatch(/name:\s*"checkout\.sessions"[\s\S]{0,600}exactly:\s*0/);
  });

  it("STRIPE_ALLOW_LIVE_MODE=true allowlist still names lib/stripe/server.ts only", () => {
    expect(GATE).toMatch(
      /name:\s*"STRIPE_ALLOW_LIVE_MODE=true"[\s\S]{0,1500}"lib\/stripe\/server\.ts"/,
    );
  });
});
