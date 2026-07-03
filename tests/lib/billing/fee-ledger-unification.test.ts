import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #196. Fees unified onto payment_charge_attempts.
const ROOT = path.resolve(__dirname, "../../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const ACTIONS = read("app/(app)/calendar/[id]/manual-fee-actions.ts");
const ELIG = read("lib/billing/manual-fee-eligibility.ts");
const EXEC = read("lib/billing/session-payment-charge.ts");
const MIG = read("supabase/migrations/0083_fee_charge_unification.sql");
const code = (s: string) => s.split("\n").filter((l) => !/^\s*(--|\/\/)/.test(l)).join("\n");

describe("fees write the canonical ledger only", () => {
  it("prepare inserts payment_charge_attempts with the mapped fee reason", () => {
    expect(code(ACTIONS)).toMatch(/\.from\("payment_charge_attempts"\)\s*\n?\s*\.insert\(/);
    expect(ACTIONS).toMatch(/rawChargeType === "no_show" \? "no_show_fee" : "late_cancellation_fee"/);
    expect(ACTIONS).toMatch(/stripe_livemode: inferStripeLivemode\(\),/);
  });
  it("no new runtime writes to manual_fee_charge_attempts", () => {
    expect(code(ACTIONS)).not.toMatch(/from\("manual_fee_charge_attempts"\)\s*\n?\s*\.(insert|update)/);
  });
  it("charge delegates to the unified executor; cancel targets the canonical row", () => {
    expect(ACTIONS).toMatch(/await runSessionPaymentCharge\(\{/);
    expect(code(ACTIONS)).toMatch(/\.from\("payment_charge_attempts"\)\s*\n?\s*\.update\(\{\s*\n?\s*status: "cancelled",/);
  });
  it("receipt + refund reuse the reason-agnostic canonical helpers", () => {
    expect(ACTIONS).toMatch(/sendPaymentChargeReceipt\(\{/);
    expect(ACTIONS).toMatch(/refundPaymentChargeAttempt\(\{/);
  });
});

describe("executor + RPC accept the three canonical reasons", () => {
  it("executor reason allowlist", () => {
    expect(EXEC).toMatch(/"no_show_fee"/);
    expect(EXEC).toMatch(/"late_cancellation_fee"/);
  });
  it("migration widens the RPC guard, keeps live-mode guard + service_role-only grants", () => {
    expect(MIG).toMatch(/not in \('session_payment', 'no_show_fee', 'late_cancellation_fee'\)/);
    expect(MIG).toMatch(/v_row\.stripe_livemode <> false/);
    expect(MIG).toMatch(/grant execute on function public\.claim_session_payment_charge_attempt[\s\S]{0,80}to service_role/);
    expect(MIG).toMatch(/add column if not exists appointment_policy_acknowledgement_id uuid/);
    expect(MIG).not.toMatch(/drop table|delete from|truncate/i);
  });
});

describe("history + UI", () => {
  it("eligibility reads canonical AND legacy rows so history stays visible", () => {
    expect(ELIG).toMatch(/\.in\("charge_reason", \["no_show_fee", "late_cancellation_fee"\]\)/);
    expect(code(ELIG)).toMatch(/from\("manual_fee_charge_attempts"\)\s*\n?\s*\.select/);
  });
  it("succeeded fee panel exposes test receipt + refund controls", () => {
    const CARD = read("app/(app)/calendar/[id]/ManualFeeChargeCard.tsx");
    expect(CARD).toMatch(/Send test receipt/);
    expect(CARD).toMatch(/Refund test charge/);
  });
});
