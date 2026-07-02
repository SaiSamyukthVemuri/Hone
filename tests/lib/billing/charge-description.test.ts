import { describe, expect, it } from "vitest";
import { buildChargeDescription } from "@/lib/billing/charge-description";

// PR #320. The Stripe PaymentIntent description must be accurate per
// charge_reason and must NEVER say "session null" for a fee row (fees have
// session_id = null). It must also never leak client/intake/health PII — only
// the reason + an internal UUID.

const SID = "11111111-1111-1111-1111-111111111111";
const AID = "22222222-2222-2222-2222-222222222222";

describe("buildChargeDescription", () => {
  it("session_payment with a session id keeps the session-specific description", () => {
    expect(
      buildChargeDescription({ charge_reason: "session_payment", session_id: SID, appointment_id: null }),
    ).toBe(`Session payment for session ${SID}`);
  });

  it("session_payment without a session id degrades gracefully (never 'session null')", () => {
    expect(
      buildChargeDescription({ charge_reason: "session_payment", session_id: null, appointment_id: null }),
    ).toBe("Session payment");
  });

  it("no_show_fee uses an appointment-based description (NOT 'session null')", () => {
    const d = buildChargeDescription({
      charge_reason: "no_show_fee",
      session_id: null, // fee rows have null session_id
      appointment_id: AID,
    });
    expect(d).toBe(`No-show fee for appointment ${AID}`);
    expect(d).not.toContain("session");
    expect(d).not.toContain("null");
  });

  it("no_show_fee without an appointment id is a clean generic label", () => {
    expect(
      buildChargeDescription({ charge_reason: "no_show_fee", session_id: null, appointment_id: null }),
    ).toBe("No-show fee");
  });

  it("late_cancellation_fee uses an appointment-based description (NOT 'session null')", () => {
    const d = buildChargeDescription({
      charge_reason: "late_cancellation_fee",
      session_id: null,
      appointment_id: AID,
    });
    expect(d).toBe(`Late cancellation fee for appointment ${AID}`);
    expect(d).not.toContain("session");
    expect(d).not.toContain("null");
  });

  it("late_cancellation_fee without an appointment id is a clean generic label", () => {
    expect(
      buildChargeDescription({ charge_reason: "late_cancellation_fee", session_id: null, appointment_id: null }),
    ).toBe("Late cancellation fee");
  });

  it("an unknown/absent reason never interpolates a null id", () => {
    for (const reason of [null, "", "something_else"]) {
      const d = buildChargeDescription({ charge_reason: reason, session_id: null, appointment_id: null });
      expect(d).not.toContain("null");
      expect(d).not.toContain("undefined");
      expect(d.length).toBeGreaterThan(0);
    }
  });

  it("NEVER produces the literal 'session null' for any reason (the bug this fixes)", () => {
    const reasons = ["session_payment", "no_show_fee", "late_cancellation_fee", null];
    for (const charge_reason of reasons) {
      const d = buildChargeDescription({ charge_reason, session_id: null, appointment_id: null });
      expect(d).not.toContain("session null");
      expect(d).not.toContain("null");
    }
  });

  it("descriptions contain only the reason + a UUID — no PII fields", () => {
    // Simulate a row that also carried PII-ish fields; the function only reads
    // the three whitelisted keys, so nothing else can leak into the string.
    const d = buildChargeDescription({
      charge_reason: "session_payment",
      session_id: SID,
      appointment_id: AID,
      // @ts-expect-error extra fields must be ignored by the builder
      client_name: "Jane Doe",
      intake_notes: "penicillin allergy",
      health_condition: "diabetes",
    });
    expect(d).toBe(`Session payment for session ${SID}`);
    for (const leak of ["Jane", "Doe", "penicillin", "allergy", "diabetes"]) {
      expect(d).not.toContain(leak);
    }
  });
});
