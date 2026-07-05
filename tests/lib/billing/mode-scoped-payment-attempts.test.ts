import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sessionEligibility = readFileSync(
  join(process.cwd(), "lib/billing/session-payment-eligibility.ts"),
  "utf8",
);
const manualFeeEligibility = readFileSync(
  join(process.cwd(), "lib/billing/manual-fee-eligibility.ts"),
  "utf8",
);

function queryBlock(source: string, anchor: string): string {
  const start = source.indexOf(anchor);
  expect(start).toBeGreaterThanOrEqual(0);
  return source.slice(start, start + 700);
}

describe("payment attempt eligibility reads are mode-scoped", () => {
  it("session-payment existing-attempt reads filter by inferStripeLivemode", () => {
    expect(sessionEligibility).toContain("const livemode = inferStripeLivemode()");
    const block = queryBlock(
      sessionEligibility,
      '.from("payment_charge_attempts")',
    );
    expect(block).toContain('.eq("studio_id", args.studioId)');
    expect(block).toContain('.eq("session_id", sessionSummary.id)');
    expect(block).toContain('.eq("charge_reason", "session_payment")');
    expect(block).toContain('.eq("stripe_livemode", livemode)');
  });

  it("manual-fee canonical existing-attempt reads filter by inferStripeLivemode", () => {
    expect(manualFeeEligibility).toContain("const livemode = inferStripeLivemode()");
    const block = queryBlock(
      manualFeeEligibility,
      '.from("payment_charge_attempts")',
    );
    expect(block).toContain('.eq("studio_id", args.studioId)');
    expect(block).toContain('.eq("appointment_id", args.appointmentId)');
    expect(block).toContain('.in("charge_reason", ["no_show_fee", "late_cancellation_fee"])');
    expect(block).toContain('.eq("stripe_livemode", livemode)');
  });

  it("manual-fee duplicate blocking uses current-mode canonical rows, not legacy history", () => {
    expect(manualFeeEligibility).toContain("const canonicalAttemptSummaries");
    expect(manualFeeEligibility).toContain("const legacyAttemptSummaries");
    expect(manualFeeEligibility).toContain("const activeCanonicalForType = canonicalAttemptSummaries.find");
    expect(manualFeeEligibility).toContain("Keep them visible in existingAttempts");
  });
});
