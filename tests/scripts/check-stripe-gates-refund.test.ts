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
  it("the gate's refunds.create block declares exactly 2 (full refund + HON-122 partial refund)", () => {
    expect(GATE).toMatch(
      /name:\s*"refunds\.create"[\s\S]{0,2600}exactly:\s*2/,
    );
  });

  it("the allowlist contains lib/billing/payment-refund.ts", () => {
    expect(GATE).toMatch(
      /name:\s*"refunds\.create"[\s\S]{0,2000}"lib\/billing\/payment-refund\.ts"/,
    );
  });

  it("the allowlist contains exactly the two reviewed refund files and no other", () => {
    const refundBlock =
      GATE.match(/name:\s*"refunds\.create"[\s\S]{0,2600}exactly:\s*2/)?.[0] ??
      "";
    const allowlistPaths = refundBlock.match(/^\s*"lib\/[^"]+",/gm)?.map((x) => x.trim()) ?? [];
    expect(allowlistPaths).toEqual(['"lib/billing/payment-refund.ts",', '"lib/billing/payment-partial-refund.ts",']);
  });
});

describe("check-stripe-gates: other gates unchanged in PR #178", () => {
  it("paymentIntents.create declares exactly 1 (PR #218 removed the legacy fee executor)", () => {
    expect(GATE).toMatch(
      /name:\s*"paymentIntents\.create"[\s\S]{0,3000}exactly:\s*1/,
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
