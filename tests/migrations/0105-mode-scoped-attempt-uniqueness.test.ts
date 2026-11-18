import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

describe("0105 companions: eligibility existing-attempt reads are mode-scoped", () => {
  function read(rel: string): string {
    return readFileSync(path.resolve(__dirname, "../../", rel), "utf8");
  }
  it("session eligibility reads attempts for the current mode only (variable, no literal)", () => {
    const src = read("lib/billing/session-payment-eligibility.ts");
    const block = src.slice(src.indexOf('.from("payment_charge_attempts")'));
    expect(block).toMatch(/\.eq\("charge_reason", "session_payment"\)\s*\n?\s*\.eq\("stripe_livemode", livemode\)/);
    expect(src).not.toMatch(/\.eq\("stripe_livemode", (true|false)\)/);
  });
  it("fee eligibility reads BOTH ledgers for the current mode only", () => {
    const src = read("lib/billing/manual-fee-eligibility.ts");
    const canonical = src.slice(src.indexOf('.from("payment_charge_attempts")'));
    expect(canonical).toMatch(/\.in\("charge_reason", \["no_show_fee", "late_cancellation_fee"\]\)\s*\n?\s*\.eq\("stripe_livemode", livemode\)/);
    const legacy = src.slice(src.indexOf('.from("manual_fee_charge_attempts")'));
    expect(legacy.slice(0, 600)).toMatch(/\.eq\("stripe_livemode", livemode\)/);
    expect(src).not.toMatch(/\.eq\("stripe_livemode", (true|false)\)/);
  });
});
