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
import {
  SETTLEMENT_STATE_BY_METHOD,
  deriveAppointmentPaymentState,
} from "@/lib/billing/appointment-payment-state";

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
    void 0;
    // The emerald branch is the paid/refunded one, which is Hone-verified.
    const settledBranch = CELL.slice(CELL.indexOf("const settled = SETTLED_LABEL"));
    expect(settledBranch).not.toMatch(/emerald/);
    expect(settledBranch).toMatch(/bg-neutral-100/);
    // And the verified branch still owns emerald.
    expect(CELL).toMatch(/paymentState === "paid" \|\|/);
    expect(CELL.slice(0, CELL.indexOf("const settled"))).toMatch(/emerald/);
  });

  it("the cell offers no Checkout once a visit is COLLECTED or WAIVED", () => {
    // RESTATED, NOT RELAXED. This was "once a visit is settled", which held
    // only while all five methods shared one branch. `still_owes` attests the
    // visit is UNPAID: it is the one method absent from the SQL blocking set,
    // the one prepareSessionPaymentChargeAction lets through, and the reason
    // settlementIsOutranked exists. Withholding Checkout from it contradicted
    // every layer beneath the view and left the debt collectable only from the
    // session detail page.
    //
    // The invariant that actually matters is the one about MONEY ALREADY
    // ACCOUNTED FOR: a visit paid in cash, by e-transfer, another way, or
    // waived must never be asked to be charged again.
    const settledBranch = CELL.slice(
      CELL.indexOf("const settled = SETTLED_LABEL"),
      CELL.indexOf('if (paymentState === "processing")'),
    );
    // The four collected/waived states return the bare badge...
    expect(settledBranch).toMatch(
      /if \(paymentState !== "settled_owing"\) return badge;/,
    );
    // ...and the ONLY entry point below that guard is the still-owing one.
    const afterGuard = settledBranch.slice(
      settledBranch.indexOf('if (paymentState !== "settled_owing") return badge;'),
    );
    expect([...afterGuard.matchAll(/<CheckoutButton/g)]).toHaveLength(1);
    // Behavioural coverage of every state lives in
    // tests/components/appointment-checkout-cell-render.test.ts.
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

  it("the write path does NOT decide the service value at all", () => {
    // The snapshot is derived inside the SQL command now. These actions are
    // reachable only as one caller among several — the commands are granted to
    // `authenticated` — so anything this file could pass, a hand-built
    // PostgREST call could pass instead.
    expect(ACTIONS).not.toMatch(/p_quoted_amount_cents/);
    expect(ACTIONS).not.toMatch(/resolveAppointmentQuotedAmountCents/);
    expect(ACTIONS).not.toMatch(/resolveAuthoritativeSessionPaymentAmount/);
  });

  it("the UI may still SUGGEST an amount, which is display and not authority", () => {
    const reader = read("lib/billing/appointment-settlement.ts");
    // Kept: the modal pre-fills the form from it. It reaches no database write.
    expect(reader).toMatch(/export async function resolveAppointmentQuotedAmountCents/);
    expect(QUICK).toMatch(/resolveAppointmentQuotedAmountCents/);
    // A price it cannot resolve is null, never a manufactured zero — and the
    // ONE truthful zero is an authoritative free service.
    expect(reader).toMatch(/if \(result\.kind === "free"\) return 0;/);
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

  it("ONLY a proven full refund keeps a route to record the replacement payment", () => {
    const branch = CELL.slice(CELL.indexOf('paymentState === "paid" ||'));
    expect(branch).toMatch(/Record outcome/);
    expect(branch).toMatch(/<CheckoutButton/);
    // The card fact and the refund fact are still shown, not replaced.
    expect(branch).toMatch(/\{badge\}/);
    // THE GATE. A partial refund, an unknown-amount refund and a plain paid row
    // all return the badge before reaching the entry point.
    expect(branch).toMatch(/if \(paymentState !== "refunded_full"\) return badge;/);
  });

  it("the cell makes NO eligibility guess of its own — the row state carries it", () => {
    const branch = CELL.slice(CELL.indexOf('paymentState === "paid" ||'));
    // No refund arithmetic, no amounts, no second derivation in the view.
    expect(branch).not.toMatch(/refund_amount_cents|refundAmountCents|amount_cents/);
  });

  it("full and partial refunds are DERIVED apart before the row renders", () => {
    const state = read("lib/billing/appointment-payment-state.ts");
    expect(state).toMatch(/function isFullyRefunded/);
    // The same law as the SQL and the payment card: status AND cents.
    expect(state).toMatch(/if \(a\.refund_status !== "succeeded"\) return false;/);
    expect(state).toMatch(/return refunded >= amount;/);
    // An unknown amount is not full.
    expect(state).toMatch(
      /typeof amount !== "number" \|\| typeof refunded !== "number"/,
    );
    expect(state).toMatch(/isFullyRefunded\(a\) \? "refunded_full" : "refunded"/);
  });
});


// ---------------------------------------------------------------------------
// P2-1 — the modal must show the recorded outcome in the SAME open modal
// ---------------------------------------------------------------------------
describe("recording a settlement advances the quick-checkout modal in place", () => {
  const MODAL_SRC = read("components/quick-checkout-modal.tsx");
  const CARD_SRC = read("components/session-payment-prepare-card.tsx");

  it("the controls expose a success hook and AWAIT it while still pending", () => {
    expect(CONTROLS).toMatch(/onRecorded\?: \(\) => void \| Promise<void>/);
    // Awaited INSIDE the transition, so the buttons never flash back between
    // "recorded" and the new context arriving.
    expect(CONTROLS).toMatch(/await onRecorded\(\)/);
    const submit = CONTROLS.slice(CONTROLS.indexOf("startTransition"));
    expect(submit.indexOf("await onRecorded()")).toBeGreaterThan(
      submit.indexOf("router.refresh()"),
    );
  });

  it("a failed refresh is not reported as a failed RECORD", () => {
    // The settlement is already committed at that point; showing an error
    // would tell the practitioner to try again and produce a second submission.
    expect(CONTROLS).toMatch(/try \{\s*await onRecorded\(\);\s*\} catch/);
  });

  it("BOTH modal render paths supply the silent refetch", () => {
    expect(MODAL_SRC).toMatch(
      /const refetchAfterSettlement = useCallback\(\s*\(\) => fetchContext\(\{ silent: true \}\)/,
    );
    // A. the no-session / ineligible branch, rendering the controls directly
    const ineligible = MODAL_SRC.slice(
      MODAL_SRC.indexOf("ctx.ok === false"),
      MODAL_SRC.indexOf("ctx.ok === true"),
    );
    expect(ineligible).toMatch(/onRecorded=\{refetchAfterSettlement\}/);
    // B. the ordinary session/card branch, through the shared card
    const eligible = MODAL_SRC.slice(MODAL_SRC.indexOf("ctx.ok === true"));
    expect(eligible).toMatch(/onSettlementRecorded=\{refetchAfterSettlement\}/);
  });

  it("the card forwards the hook rather than implementing its own refresh", () => {
    expect(CARD_SRC).toMatch(/onRecorded=\{onSettlementRecorded\}/);
    // No refetch of its own, and no knowledge of the modal's context action.
    expect(CARD_SRC).not.toMatch(/getQuickCheckoutContextAction|fetchContext/);
  });

  it("once settled, the controls render the outcome and NO action buttons", () => {
    // The early return is what makes a second submission unreachable through
    // ordinary UI — `already_settled` is a backstop, not the mechanism.
    const settledBranch = CONTROLS.slice(
      CONTROLS.indexOf("if (settledMethod) {"),
      CONTROLS.indexOf("const submit ="),
    );
    expect(settledBranch).toMatch(/appointment-settlement-recorded/);
    expect(settledBranch).toMatch(/SETTLEMENT_BADGE_LABEL\[settledMethod\]/);
    expect(settledBranch).not.toMatch(/settlement-open-|settlement-confirm-/);
    expect(settledBranch).toMatch(/return \(/);
  });

  it("the session detail page needs no hook and is left alone", () => {
    const page = read("app/(app)/clients/[id]/sessions/[sessionId]/page.tsx");
    expect(page).not.toMatch(/onSettlementRecorded/);
  });
});


// ---------------------------------------------------------------------------
// P2-2 — the row state itself must carry the full-refund truth
// ---------------------------------------------------------------------------
// Behavioural, against the real reducer. The dashboard row decides whether the
// replacement-payment door EXISTS, so the answer has to be right before
// anything renders — a view that has to re-derive it is a second place for the
// law to drift.
describe("full and partial refunds are different row states", () => {
  const attempt = (over: Record<string, unknown> = {}) => ({
    status: "succeeded",
    refund_status: null as string | null,
    amount_cents: 12000,
    refund_amount_cents: null as number | null,
    ...over,
  });

  it("A · succeeded, no refund -> paid", () => {
    expect(deriveAppointmentPaymentState(true, [attempt()])).toBe("paid");
  });

  it("B · succeeded + PARTIAL refund -> refunded (no replacement route)", () => {
    expect(
      deriveAppointmentPaymentState(true, [
        attempt({ refund_status: "succeeded", refund_amount_cents: 6000 }),
      ]),
    ).toBe("refunded");
  });

  it("C · succeeded + refund with NULL amount -> refunded, failing closed", () => {
    // Cannot prove the money went back, so it is not treated as if it had.
    expect(
      deriveAppointmentPaymentState(true, [
        attempt({ refund_status: "succeeded", refund_amount_cents: null }),
      ]),
    ).toBe("refunded");
  });

  it("D · succeeded + FULL refund -> refunded_full (replacement route)", () => {
    expect(
      deriveAppointmentPaymentState(true, [
        attempt({ refund_status: "succeeded", refund_amount_cents: 12000 }),
      ]),
    ).toBe("refunded_full");
  });

  it("an over-refund still counts as full", () => {
    expect(
      deriveAppointmentPaymentState(true, [
        attempt({ refund_status: "succeeded", refund_amount_cents: 12500 }),
      ]),
    ).toBe("refunded_full");
  });

  it("a caller that omits the cents gets the closed answer, never the open one", () => {
    // The fields are optional on AttemptRow so existing callers still compile;
    // omitting them must never unlock the route.
    expect(
      deriveAppointmentPaymentState(true, [
        { status: "succeeded", refund_status: "succeeded" },
      ]),
    ).toBe("refunded");
  });

  it("both refund states still rank above pricing, so neither becomes 'free'", () => {
    for (const refundAmount of [6000, 12000]) {
      const state = deriveAppointmentPaymentState(
        true,
        [attempt({ refund_status: "succeeded", refund_amount_cents: refundAmount })],
        true, // isFree
      );
      expect(["refunded", "refunded_full"]).toContain(state);
    }
  });
});
