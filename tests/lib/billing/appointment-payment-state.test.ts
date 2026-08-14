import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deriveAppointmentPaymentState } from "@/lib/billing/appointment-payment-state";

// Batch payment-state loader for the dashboard/calendar checkout cell.

describe("deriveAppointmentPaymentState: strongest terminal state wins", () => {
  it("no session → no_session", () => {
    expect(deriveAppointmentPaymentState(false, [])).toBe("no_session");
  });
  it("session, no attempt → chargeable", () => {
    expect(deriveAppointmentPaymentState(true, [])).toBe("chargeable");
  });
  it("succeeded → paid; succeeded + refunded → refunded", () => {
    expect(
      deriveAppointmentPaymentState(true, [
        { status: "succeeded", refund_status: null },
      ]),
    ).toBe("paid");
    expect(
      deriveAppointmentPaymentState(true, [
        { status: "succeeded", refund_status: "succeeded" },
      ]),
    ).toBe("refunded");
  });
  it("pending_stripe → processing", () => {
    expect(
      deriveAppointmentPaymentState(true, [
        { status: "pending_stripe", refund_status: null },
      ]),
    ).toBe("processing");
  });
  it("only a failed/ready attempt → still chargeable", () => {
    expect(
      deriveAppointmentPaymentState(true, [
        { status: "failed", refund_status: null },
        { status: "ready", refund_status: null },
      ]),
    ).toBe("chargeable");
  });
  it("paid wins over a coexisting processing/failed row", () => {
    expect(
      deriveAppointmentPaymentState(true, [
        { status: "failed", refund_status: null },
        { status: "pending_stripe", refund_status: null },
        { status: "succeeded", refund_status: null },
      ]),
    ).toBe("paid");
  });
});

describe("loader is bounded + tenant-scoped (no N+1, no full history)", () => {
  const SRC = readFileSync(
    join(process.cwd(), "lib/billing/appointment-payment-state.ts"),
    "utf8",
  );
  it("reads sessions then attempts: two bounded .in() queries, keyed by id sets", () => {
    expect(SRC).toMatch(/from\("sessions"\)/);
    expect(SRC).toMatch(/from\("payment_charge_attempts"\)/);
    // FREE-01 adds a bounded free-price lookup (appointments -> services ->
    // client_pricing). Still batched and still constant in the number of
    // appointments, five reads total, never a per-appointment query.
    expect((SRC.match(/\.in\(/g) ?? []).length).toBe(5);
    expect((SRC.match(/from\("/g) ?? []).length).toBe(5);
    for (const t of ["appointments", "services", "client_pricing"]) {
      expect(SRC).toMatch(new RegExp(`from\\("${t}"\\)`));
    }
    // No query lives inside a per-appointment loop.
    // Bound the slice to the loop BODY. An unbounded slice runs to end-of-file
    // and would pick up the next function's queries, a false positive.
    // The free lookup now returns a discriminated result, so the old
    // `return free;` anchor no longer exists. Anchor on the current return.
    const loopStart = SRC.indexOf("for (const a of appts)");
    const loopEnd = SRC.indexOf(
      "return { ok: true, freeAppointmentIds: free };",
      loopStart,
    );
    expect(loopStart).toBeGreaterThan(-1);
    expect(loopEnd).toBeGreaterThan(loopStart);
    const loop = SRC.slice(loopStart, loopEnd);
    expect(loop.length).toBeGreaterThan(80); // slice is real, not empty
    expect(loop).not.toMatch(/await supabase|\.from\(/);

    // The per-appointment combine loop must not query either.
    // The braced form: the bare `for (const apptId of ids) out.set(...)`
    // one-liner is the unavailable early-return, not the combine loop.
    const combineStart = SRC.indexOf("for (const apptId of ids) {");
    const combineEnd = SRC.indexOf("return out;", combineStart);
    expect(combineStart).toBeGreaterThan(-1);
    expect(combineEnd).toBeGreaterThan(combineStart);
    const combine = SRC.slice(combineStart, combineEnd);
    expect(combine.length).toBeGreaterThan(80);
    expect(combine).not.toMatch(/await supabase|\.from\(/);
  });
  it("is studio-scoped and filtered to session_payment (tenant isolation)", () => {
    expect(SRC).toMatch(/\.eq\("studio_id", studioId\)/);
    expect(SRC).toMatch(/\.eq\("charge_reason", "session_payment"\)/);
  });
  it("reads only the coarse columns it needs (never the full payment history)", () => {
    expect(SRC).toMatch(/\.select\("session_id, status, refund_status"\)/);
    expect(SRC).not.toMatch(/stripe_payment_intent_id|receipt_email_to|failure_message/);
  });
  it("does not charge / write / call Stripe", () => {
    expect(SRC).not.toMatch(/\.insert\(|\.update\(|\.delete\(|@stripe\/|paymentIntents\./);
  });
});

describe("checkout cell + dashboard/calendar wiring (one shared flow)", () => {
  const CELL = readFileSync(
    join(process.cwd(), "components/appointment-checkout-cell.tsx"),
    "utf8",
  );
  const DASH = readFileSync(
    join(process.cwd(), "app/(app)/dashboard/page.tsx"),
    "utf8",
  );
  const CAL = readFileSync(
    join(process.cwd(), "app/(app)/calendar/[id]/page.tsx"),
    "utf8",
  );
  it("cell shows Paid/Processing/Refunded badges or the shared CheckoutButton", () => {
    expect(CELL).toMatch(/<CheckoutButton/);
    expect(CELL).toMatch(/Paid/);
    expect(CELL).toMatch(/Processing/);
    expect(CELL).toMatch(/Refunded/);
    // Only completed appointments are checkout-relevant.
    expect(CELL).toMatch(/if \(status !== "completed"\) return null/);
    // Status conveyed by text, not colour alone.
    expect(CELL).toMatch(/appointment-payment-/);
  });
  it("dashboard uses the ONE bounded batch loader + the shared cell", () => {
    expect(DASH).toMatch(/getAppointmentPaymentStates\(studio\.id, apptIds, studio\.timezone\)/);
    expect(DASH).toMatch(/<AppointmentCheckoutCell/);
  });
  it("calendar reuses the SAME loader + cell (not a second flow)", () => {
    expect(CAL).toMatch(/getAppointmentPaymentStates\(studio\.id, \[id\], studio\.timezone\)/);
    expect(CAL).toMatch(/<AppointmentCheckoutCell/);
  });
});
