import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

// PR #218: the dead legacy manual-fee executor is removed and the
// Stripe gate is TIGHTENED (paymentIntents.create exactly 1, in the
// unified executor only). The 36 identical per-PR gate-pin clones
// were consolidated into tests/scripts/check-stripe-gates.test.ts.

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

describe("legacy fee executor removed", () => {
  it("the file is gone and nothing imports it", () => {
    expect(existsSync(join(process.cwd(), "lib/billing/manual-fee-charge.ts"))).toBe(false);
    const out = execSync(
      "grep -rln 'from \"@/lib/billing/manual-fee-charge\"\\|runManualFeeCharge(' app lib --include='*.ts' --include='*.tsx' 2>/dev/null || true",
      { cwd: process.cwd() },
    )
      .toString()
      .trim();
    expect(out).toBe("");
  });

  it("no runtime code writes to manual_fee_charge_attempts (history reads only)", () => {
    const out = execSync(
      "grep -rn 'from(\"manual_fee_charge_attempts\")' app lib --include='*.ts' 2>/dev/null || true",
      { cwd: process.cwd() },
    )
      .toString()
      .trim()
      .split("\n")
      .filter(Boolean);
    expect(out.length).toBe(1);
    expect(out[0]).toContain("lib/billing/manual-fee-eligibility.ts");
    const eligibility = read("lib/billing/manual-fee-eligibility.ts");
    const at = eligibility.indexOf('from("manual_fee_charge_attempts")');
    expect(eligibility.slice(at, at + 200)).toMatch(/\.select\(/);
    expect(eligibility.slice(at, at + 200)).not.toMatch(/\.insert|\.update|\.delete/);
  });

  it("the canonical executor remains intact (single PaymentIntent call site)", () => {
    const session = read("lib/billing/session-payment-charge.ts");
    expect(session.match(/paymentIntents\.create/g)?.length).toBe(1);
    expect(session).toMatch(/no_show_fee|late_cancellation_fee/);
  });

  it("the gate is tightened, not weakened", () => {
    const gate = read("scripts/check-stripe-gates.mjs");
    expect(gate).toMatch(/name:\s*"paymentIntents\.create"[\s\S]{0,1500}exactly:\s*1/);
    expect(gate).not.toMatch(/manual-fee-charge\.ts"/);
    // The other gates stay exact.
    expect(gate).toMatch(/name:\s*"refunds\.create"[\s\S]{0,2000}exactly:\s*1/);
    expect(gate).toMatch(/name:\s*"charges\.create"[\s\S]{0,400}exactly:\s*0/);
    expect(gate).toMatch(/name:\s*"checkout\.sessions"[\s\S]{0,600}exactly:\s*0/);
    expect(gate).toMatch(/"lib\/stripe\/server\.ts"/);
  });
});
