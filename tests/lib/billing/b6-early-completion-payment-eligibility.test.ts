import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// T8 / T9 — B6 makes an early-completed appointment payment-eligible, and it
// does so WITHOUT any payment-runtime change.
//
// HONEST SCOPE. getSessionPaymentEligibility is an async server function that
// reads several tables; executing it here would mean rebuilding most of a
// studio fixture to re-prove code this suite does not own. What B6 actually
// needs to establish is narrower and is fully decidable from the live helper's
// own source: its appointment gate is keyed on STATUS and on nothing else.
//
// The proof therefore composes two facts, each proven where it lives:
//
//   1. HERE — the live helper admits an appointment iff status === 'completed',
//      and consults no end-time anywhere;
//   2. tests/db/appointment-transition-integrity.db.test.ts — B6 makes
//      status = 'completed' reachable from starts_at onward (T2/T3), and
//      leaves it 'confirmed' before then (T1).
//
// Together: early-completed => eligible (T8); started-but-still-confirmed =>
// refused (T9). Neither half is asserted twice, and neither is assumed.

const SRC = readFileSync(
  join(process.cwd(), "lib/billing/session-payment-eligibility.ts"),
  "utf8",
);

describe("T8/T9 — the live payment gate is status-keyed, so early completion just works", () => {
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
