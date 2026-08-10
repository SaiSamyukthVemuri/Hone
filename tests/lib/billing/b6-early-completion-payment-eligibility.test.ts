import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// T8 / T9 — SOURCE-CONTRACT proof (this file does NOT execute the helper).
//
// B6 makes an early-completed appointment payment-eligible, and does so with no
// payment-runtime change. This file reads the live helper's SOURCE and asserts
// one structural property: its appointment gate is keyed on STATUS and on
// nothing else. That is a claim about the code's shape, not about its runtime
// behaviour, and it is deliberately not described as more than that.
//
// THE BEHAVIOURAL PROOF LIVES ELSEWHERE, and it does run the real function:
// tests/db/quick-checkout-eligibility.db.test.ts "Stage J" invokes the actual
// getSessionPaymentEligibility against real seeded rows — a mid-visit
// appointment (started, not yet ended) that is already completed resolves
// ELIGIBLE, and the same mid-visit appointment left confirmed is refused for
// LIFECYCLE rather than for its clock. Nothing is mocked there.
//
// Keeping both is deliberate: the live test proves what happens, this one
// proves WHY — that no end-time check exists in the gate at all, which a
// passing behavioural case cannot demonstrate on its own. Read together with
// tests/db/appointment-transition-integrity.db.test.ts (T1/T2/T2b/T3), which
// establishes when 'completed' becomes reachable.

const SRC = readFileSync(
  join(process.cwd(), "lib/billing/session-payment-eligibility.ts"),
  "utf8",
);

describe("T8/T9 (SOURCE CONTRACT) — the payment gate is status-keyed, with no end-time check", () => {
  it("T8 — admits the appointment ONLY when its status is 'completed'", () => {
    expect(SRC).toMatch(/appointmentSummary\.status !== "completed"/);
  });

  it("T9 — anything other than completed is refused, and the reason names the status", () => {
    // A started-but-confirmed appointment falls into this branch: B6 changed
    // when a practitioner MAY complete, never what 'completed' means.
    expect(SRC).toMatch(
      /Appointment is not completed \(current status: \$\{appointmentSummary\.status/,
    );
  });

  it("consults NO appointment end time — which is why B6 needed no payment change", () => {
    // If eligibility had its own ends_at gate, early completion would have
    // produced a completed appointment that still could not be charged, and
    // B6 would have had to touch payment code. It does not.
    const gate = SRC.slice(
      SRC.indexOf("if (!appointmentSummary.id)"),
      SRC.indexOf("// 2)"),
    );
    expect(gate).not.toMatch(/ends_at|endsAt/);
  });

  it("B6 introduced no payment-runtime change at all", () => {
    // The dormant `create_or_claim_charge_attempt` named in earlier planning
    // does not exist in this schema; the live claim paths are untouched.
    const MIGRATION = readFileSync(
      join(
        process.cwd(),
        "supabase/migrations/0175_appointment_transition_integrity.sql",
      ),
      "utf8",
    )
      .split("\n")
      .map((l) => l.replace(/--.*$/, ""))
      .join("\n");
    for (const fn of [
      "claim_session_payment_charge_attempt",
      "claim_manual_fee_charge_attempt",
      "create_or_claim_charge_attempt",
      "appointment_payments",
    ]) {
      expect(MIGRATION, `0175 must not touch ${fn}`).not.toContain(fn);
    }
  });
});
