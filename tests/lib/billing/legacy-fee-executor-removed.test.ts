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
    // Exactly two READERS: the fee-eligibility helper, and the dashboard's unpaid-balance check (#1356 AO2: a manual fee on the
    // appointment makes its amount unavailable). Each is a bare select; neither writes.
    expect(out.length).toBe(2);
    const files = out.map((l) => l.split(":")[0]).sort();
    expect(files).toEqual(["lib/billing/manual-fee-eligibility.ts", "lib/dashboard/other-money-forms.ts"]);
    for (const f of files) {
      const src = read(f);
      const at = src.indexOf('from("manual_fee_charge_attempts")');
      expect(src.slice(at, at + 200), f).toMatch(/\.select\(/);
      expect(src.slice(at, at + 200), f).not.toMatch(/\.insert|\.update|\.delete/);
    }
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
