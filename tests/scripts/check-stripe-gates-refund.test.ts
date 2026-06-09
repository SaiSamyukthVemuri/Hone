import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #178. Pin the gate-script allowlist for refunds.create. The
// gate is the structural guarantee that NO new refunds.create
// call site can slip in without an accompanying review event.

const GATE_PATH = path.resolve(
  __dirname,
  "../../scripts/check-stripe-gates.mjs",
);
const GATE = readFileSync(GATE_PATH, "utf8");

describe("check-stripe-gates: refunds.create allowlist", () => {
  it("the gate's refunds.create block now declares exactly 1", () => {
    expect(GATE).toMatch(
      /name:\s*"refunds\.create"[\s\S]{0,2000}exactly:\s*1/,
    );
  });

  it("the allowlist contains lib/billing/payment-refund.ts", () => {
    expect(GATE).toMatch(
      /name:\s*"refunds\.create"[\s\S]{0,2000}"lib\/billing\/payment-refund\.ts"/,
    );
  });

  it("the allowlist does NOT contain any other refund file", () => {
    // The refund-block allowlist must contain exactly one path.
    const refundBlock =
      GATE.match(/name:\s*"refunds\.create"[\s\S]{0,2000}exactly:\s*1/)?.[0] ??
      "";
    const allowlistPaths = refundBlock.match(/"lib\/[^"]+"/g) ?? [];
    expect(allowlistPaths.length).toBe(1);
    expect(allowlistPaths[0]).toBe('"lib/billing/payment-refund.ts"');
  });
});

describe("check-stripe-gates: other gates unchanged in PR #178", () => {
  it("paymentIntents.create still declares exactly 2", () => {
    expect(GATE).toMatch(
      /name:\s*"paymentIntents\.create"[\s\S]{0,3000}exactly:\s*2/,
    );
  });

  it("charges.create still declares exactly 0", () => {
    expect(GATE).toMatch(
      /name:\s*"charges\.create"[\s\S]{0,400}exactly:\s*0/,
    );
  });

  it("checkout.sessions still declares exactly 0", () => {
    expect(GATE).toMatch(
      /name:\s*"checkout\.sessions"[\s\S]{0,600}exactly:\s*0/,
    );
  });

  it("set_studio_require_card_on_file still declares exactly 0", () => {
    expect(GATE).toMatch(
      /name:\s*"set_studio_require_card_on_file"[\s\S]{0,400}exactly:\s*0/,
    );
  });

  it("STRIPE_ALLOW_LIVE_MODE=true allowlist still contains lib/stripe/server.ts", () => {
    expect(GATE).toMatch(
      /name:\s*"STRIPE_ALLOW_LIVE_MODE=true"[\s\S]{0,1500}"lib\/stripe\/server\.ts"/,
    );
  });
});
