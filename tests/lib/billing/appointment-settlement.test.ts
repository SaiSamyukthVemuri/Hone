import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  EXTERNALLY_COLLECTED_METHODS,
  PRACTITIONER_METHODS,
  SETTLEMENT_ACTION_LABEL,
  SETTLEMENT_BADGE_LABEL,
  SETTLEMENT_METHODS,
  isExternallyCollected,
  isPractitionerMethod,
  isSettlementMethod,
} from "@/lib/billing/settlement-types";
import { settlementIsOutranked } from "@/lib/billing/appointment-settlement";
import { SETTLEMENT_STATE_BY_METHOD } from "@/lib/billing/appointment-payment-state";

// PAY-SETTLE — the STATIC half of the runtime contract.
//
// Everything here is a rule that must hold in the browser bundle as well as in
// the database, because the browser is where Chloe actually reads the answer.
// The database cannot enforce that emerald means "Hone verified this"; only a
// guard like these can.

const ROOT = path.resolve(__dirname, "../../..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");

const CELL = read("components/appointment-checkout-cell.tsx");
const CONTROLS = read("components/appointment-settlement-controls.tsx");
const ACTIONS = read("app/(app)/appointment-settlement-actions.ts");
const MIGRATION = read("supabase/migrations/0187_appointment_settlement.sql");
const MODAL = read("components/quick-checkout-modal.tsx");
const CARD = read("components/session-payment-prepare-card.tsx");
const QUICK = read("lib/billing/quick-checkout.ts");

describe("the settlement vocabulary", () => {
  it("is the five agreed values and nothing else", () => {
    expect([...SETTLEMENT_METHODS].sort()).toEqual([
      "paid_cash",
      "paid_e_transfer",
      "paid_other_external",
      "still_owes",
      "waived",
    ]);
  });

  it("MATCHES the database CHECK exactly, so the two cannot drift", () => {
    const check = MIGRATION.match(
      /add constraint appointment_settlements_method_check\s+check \(method in \(([^)]*)\)\)/,
    )![1];
    const inSql = [...check.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
    expect(inSql).toEqual([...SETTLEMENT_METHODS].sort());
  });

  it("contains no card / hone member, which is the whole point", () => {
    for (const forbidden of ["card", "hone", "stripe", "paid_card"]) {
      expect(SETTLEMENT_METHODS as readonly string[]).not.toContain(forbidden);
    }
  });

  it("withholds waived from the practitioner list", () => {
    expect([...PRACTITIONER_METHODS].sort()).toEqual([
      "paid_cash",
      "paid_e_transfer",
      "paid_other_external",
      "still_owes",
    ]);
    expect(isPractitionerMethod("waived")).toBe(false);
    expect(isSettlementMethod("waived")).toBe(true);
  });

  it("counts exactly three methods as externally COLLECTED", () => {
    expect([...EXTERNALLY_COLLECTED_METHODS].sort()).toEqual([
      "paid_cash",
      "paid_e_transfer",
      "paid_other_external",
    ]);
    // The two that are NOT money in hand.
    expect(isExternallyCollected("waived")).toBe(false);
    expect(isExternallyCollected("still_owes")).toBe(false);
  });

  it("rejects unknown values rather than coercing them", () => {
    for (const junk of ["", "PAID_CASH", "unknown", "cash", null, 7, {}]) {
      expect(isSettlementMethod(junk)).toBe(false);
    }
  });

  it("maps every method to a distinct display state", () => {
    const states = SETTLEMENT_METHODS.map((m) => SETTLEMENT_STATE_BY_METHOD[m]);
    expect(new Set(states).size).toBe(SETTLEMENT_METHODS.length);
  });
});

describe("no attested outcome may present itself as verified money", () => {
  it("never labels an attestation with a bare 'Paid'", () => {
    for (const m of SETTLEMENT_METHODS) {
      expect(SETTLEMENT_BADGE_LABEL[m]).not.toBe("Paid");
      // Where it says Paid it must immediately say HOW.
      if (SETTLEMENT_BADGE_LABEL[m].startsWith("Paid")) {
        expect(SETTLEMENT_BADGE_LABEL[m]).toMatch(/Paid · \w/);
      }
    }
  });

  it("every method has practitioner-facing copy for both the action and the badge", () => {
    for (const m of SETTLEMENT_METHODS) {
      expect(SETTLEMENT_ACTION_LABEL[m].length).toBeGreaterThan(3);
      expect(SETTLEMENT_BADGE_LABEL[m].length).toBeGreaterThan(3);
    }
  });

  it("EMERALD IS RESERVED. The settled branch of the cell renders neutral", () => {
    // The emerald branch is the paid/refunded one, which is Hone-verified.
    const settledBranch = CELL.slice(CELL.indexOf("const settled = SETTLED_LABEL"));
    expect(settledBranch).not.toMatch(/emerald/);
    expect(settledBranch).toMatch(/bg-neutral-100/);
    // And the verified branch still owns emerald.
    expect(CELL).toMatch(/paymentState === "paid" \|\| paymentState === "refunded"/);
    expect(CELL.slice(0, CELL.indexOf("const settled"))).toMatch(/emerald/);
  });

  it("the cell offers no Checkout once a visit is settled", () => {
    const settledBranch = CELL.slice(
      CELL.indexOf("const settled = SETTLED_LABEL"),
      CELL.indexOf('if (paymentState === "processing")'),
    );
    expect(settledBranch).not.toMatch(/CheckoutButton/);
  });

  it("the controls say out loud that Hone did not verify this", () => {
    expect(CONTROLS).toMatch(/does not take a payment and Hone/);
    expect(CONTROLS).toMatch(/not verified by Hone/);
  });
});

describe("the write path touches no Stripe surface", () => {
  it("the actions module issues no Stripe call and reads no Stripe object", () => {
    // inferStripeLivemode is a LOCAL env read (the key prefix), not a call to
    // Stripe. Anything else from the Stripe surface would be a defect.
    expect(ACTIONS).not.toMatch(/stripe\.(paymentIntents|charges|refunds|customers)/);
    expect(ACTIONS).not.toMatch(/getStripe|stripeClient|api\.stripe\.com/);
    expect(ACTIONS).not.toMatch(/payment_charge_attempts/);
  });

  it("the actions module never writes the settlement table directly", () => {
    // Every write goes through a SECURITY DEFINER command; there is no table
    // grant that would let this succeed anyway, and the guard makes that an
    // intention rather than an accident.
    expect(ACTIONS).not.toMatch(/from\("appointment_settlements"\)\s*\.\s*(insert|update|delete)/);
    for (const rpc of [
      "record_appointment_settlement",
      "waive_appointment_fee",
      "supersede_appointment_settlement",
    ]) {
      expect(ACTIONS).toContain(`rpc("${rpc}"`);
    }
  });

  it("livemode comes from the deployment, never from the form", () => {
    expect(ACTIONS).toMatch(/p_livemode: inferStripeLivemode\(\)/);
    expect(ACTIONS).not.toMatch(/formData\.get\("(livemode|p_livemode|is_owner)"\)/);
  });

  it("the owner fact is derived from the authenticated practitioner alone", () => {
    expect(ACTIONS).toMatch(/practitioner\.role === "owner"/);
    expect(ACTIONS).not.toMatch(/formData\.get\("owner/);
  });

  it("the quoted amount uses the SAME resolver the card path uses, defined ONCE", () => {
    const reader = read("lib/billing/appointment-settlement.ts");
    // The P1-B refactor moved the price snapshot here so the quick-checkout
    // context and the write action share one definition and cannot offer one
    // amount while snapshotting another.
    expect(reader).toMatch(/resolveAuthoritativeSessionPaymentAmount/);
    expect(reader).toMatch(/export async function resolveAppointmentQuotedAmountCents/);
    expect(ACTIONS).toMatch(/resolveAppointmentQuotedAmountCents/);
    expect(QUICK).toMatch(/resolveAppointmentQuotedAmountCents/);
    // Exactly one definition, so there is no second copy to drift.
    expect(ACTIONS).not.toMatch(/resolveAuthoritativeSessionPaymentAmount/);
    // A price it cannot resolve is stored as null, never as a manufactured zero
    // — and the ONE truthful zero is an authoritative free service.
    expect(reader).toMatch(/if \(result\.kind === "free"\) return 0;/);
    expect(reader).toMatch(/return null;/);
  });
});

describe("Hone-verified money outranks attestation", () => {
  it("only still_owes is outranked by a later verified charge", () => {
    for (const m of SETTLEMENT_METHODS) {
      expect(settlementIsOutranked(m, true)).toBe(m === "still_owes");
    }
  });

  it("nothing is outranked when Hone holds no money", () => {
    for (const m of SETTLEMENT_METHODS) {
      expect(settlementIsOutranked(m, false)).toBe(false);
    }
  });
});


// ---------------------------------------------------------------------------
// P1-B — settlement is appointment-scoped, and the UI must agree
// ---------------------------------------------------------------------------
describe("a missing treatment session blocks CARD charging, never settlement", () => {
  it("the quick-checkout context resolves settlement BEFORE the session gate", () => {
    const settlementAt = QUICK.indexOf("const settlement: AppointmentSettlementContext");
    const sessionGate = QUICK.indexOf("if (!sessionRow)");
    expect(settlementAt).toBeGreaterThan(0);
    expect(sessionGate).toBeGreaterThan(settlementAt);
  });

  it("the no-session refusal CARRIES the settlement context", () => {
    const branch = QUICK.slice(
      QUICK.indexOf("if (!sessionRow)"),
      QUICK.indexOf("const sessionId = sessionRow.id"),
    );
    expect(branch).toMatch(/settlement,/);
    // And it still says truthfully why the card path is unavailable.
    expect(branch).toMatch(/card charge is not available/i);
  });

  it("the modal renders the controls on the INELIGIBLE branch too", () => {
    const ineligible = MODAL.slice(
      MODAL.indexOf("ctx.ok === false"),
      MODAL.indexOf("ctx.ok === true"),
    );
    expect(ineligible).toMatch(/<AppointmentSettlementControls/);
    expect(ineligible).toMatch(/ctx\.settlement\?\.canRecord/);
  });

  it("there is exactly ONE settlement control implementation", () => {
    // The same component on both branches and in the card: Dashboard, Calendar
    // and the session page cannot drift apart.
    const files = [MODAL, CARD];
    for (const f of files) {
      expect(f).toMatch(/AppointmentSettlementControls/);
    }
    expect(CONTROLS).toMatch(/export function AppointmentSettlementControls/);
  });

  it("no fake session is manufactured to make settlement work", () => {
    // The settlement path never inserts a session, and 0187 does not reference
    // sessions as a write target at all.
    expect(ACTIONS).not.toMatch(/from\("sessions"\)/);
    expect(MIGRATION).not.toMatch(/insert\s+into\s+public\.sessions/i);
  });

  it("only a COMPLETED appointment may carry a disposition, in UI and in SQL", () => {
    expect(QUICK).toMatch(/canRecord: apptStatus === "completed"/);
    expect(MIGRATION).toMatch(/v_status is distinct from 'completed'/);
  });
});

// ---------------------------------------------------------------------------
// P2 — a full refund releases the block; a partial one must not
// ---------------------------------------------------------------------------
describe("retained card money is measured in cents, not inferred from a status", () => {
  it("the SQL requires refund_amount_cents to cover the whole charge", () => {
    expect(MIGRATION).toMatch(
      /a\.refund_status = 'succeeded'\s*\n\s*and coalesce\(a\.refund_amount_cents, 0\) >= a\.amount_cents/,
    );
  });

  it("the card gates on FULL refund, not on the presence of an attempt", () => {
    expect(CARD).toMatch(/const fullyRefunded =/);
    expect(CARD).toMatch(/activeAttempt\.refundAmountCents \?\? 0\) >= activeAttempt\.amountCents/);
    expect(CARD).toMatch(/const cardMoneyHeld = activeAttempt !== null && !fullyRefunded/);
    // The settlement controls are gated on money HELD, never on the mere
    // existence of a succeeded row.
    expect(CARD).toMatch(/canRecordSettlement && !cardMoneyHeld/);
  });

  it("a refunded row keeps a route to record the replacement payment", () => {
    const refundBranch = CELL.slice(CELL.indexOf('paymentState === "paid" || paymentState === "refunded"'));
    expect(refundBranch).toMatch(/Record outcome/);
    expect(refundBranch).toMatch(/<CheckoutButton/);
    // The card fact and the refund fact are still shown, not replaced.
    expect(refundBranch).toMatch(/\{badge\}/);
  });

  it("a PAID (unrefunded) row still offers no route — nothing is over-opened", () => {
    const refundBranch = CELL.slice(CELL.indexOf('paymentState === "paid" || paymentState === "refunded"'));
    expect(refundBranch).toMatch(/if \(paymentState !== "refunded"\) return badge;/);
  });
});
