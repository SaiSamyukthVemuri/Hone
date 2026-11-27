import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { readMoneyForAppointments } from "@/lib/finance/statement-money-read";
import { buildStatement } from "@/lib/finance/statement";
import { assembleClientInputs } from "@/lib/finance/statement-document-assemble";
import { classifyVisit } from "@/lib/finance/statement-document";
import { studioVisitStatus } from "@/lib/finance/statement-methods";

// HON-123 / HON-122: a visit paid in parts, with refunds, is itemised on the statement. Nothing is netted: every payment stays at its full amount and a refund is
// its own line. A read that cannot be completed is UNAVAILABLE, never a total that leaves ledger rows out. Synthetic values only.

const STUDIO = "11111111-1111-4111-8111-111111111111";
const A = "22222222-2222-4222-8222-222222222222";
const T = "2026-11-10T15:00:00.000Z";

type Tables = Partial<Record<string, unknown[]>>;
function fake(tables: Tables, failing?: string) {
  return {
    from(table: string) {
      const q: Record<string, unknown> = {};
      const reasons: { in?: string[]; eq?: string } = {};
      const chain = () => q;
      Object.assign(q, {
        select: chain,
        eq: (col: string, v: string) => { if (col === "charge_reason") reasons.eq = v; return q; },
        is: chain,
        in: (col: string, v: string[]) => { if (col === "charge_reason") reasons.in = v; return q; },
        then: (res: (v: unknown) => unknown) => {
          let rows = (tables[table] ?? []) as Array<{ charge_reason?: string }>;
          if (reasons.in) rows = rows.filter((r) => reasons.in!.includes(r.charge_reason ?? ""));
          if (reasons.eq) rows = rows.filter((r) => r.charge_reason === reasons.eq);
          return res({ data: failing === table ? null : rows, error: failing === table ? { message: "x" } : null });
        },
      });
      return q;
    },
  } as never;
}
const SESSIONS = [{ id: "s1", appointment_id: A }];
const card = (cents: number) => ({ session_id: "s1", appointment_id: A, charge_reason: "session_payment", status: "succeeded", amount_cents: cents, currency: "cad", stripe_livemode: true, refund_status: null, refund_amount_cents: null, stripe_refund_status: null, stripe_refund_id: null, stripe_charge_refund_event_id: null });

// The $225 example: $100 card, $50 cash, a $75 transfer not yet confirmed; a $40 refund of the card payment.
const LEDGER: Tables = {
  sessions: SESSIONS,
  payment_charge_attempts: [card(10000)],
  visit_bills: [{ appointment_id: A, total_cents: 22500, currency: "cad" }],
  visit_external_payments: [
    { appointment_id: A, method: "paid_cash", amount_cents: 5000, currency: "cad", state: "confirmed" },
    { appointment_id: A, method: "paid_other_external", amount_cents: 7500, currency: "cad", state: "pending_confirmation" },
    { appointment_id: A, method: "paid_cash", amount_cents: 900, currency: "cad", state: "voided" },
  ],
  payment_refunds: [
    { appointment_id: A, amount_cents: 4000, currency: "cad", status: "succeeded", legacy: false },
    { appointment_id: A, amount_cents: 1000, currency: "cad", status: "failed", legacy: false },
    { appointment_id: A, amount_cents: 2500, currency: "cad", status: "succeeded", legacy: true },
  ],
};

async function build(tables: Tables) {
  const money = await readMoneyForAppointments(fake(tables), STUDIO, [A]);
  if (!money.ok) throw new Error("read failed");
  return { money, st: buildStatement({ studioCurrency: "cad", appointments: [{ id: A, practitionerId: null, startsAt: T }], cardRows: money.cardRows, settlementRows: money.settlementRows, legacyFeeRows: money.legacyFeeRows }) };
}

describe("the statement itemises a visit paid in parts", () => {
  it("lists each payment at its full amount, the refund as its own line, and the unconfirmed transfer as owed, never as money", async () => {
    const { st } = await build(LEDGER);
    const k = st.all.kinds;
    expect(k.collected_card_session.cents).toBe(10000);
    expect(k.collected_cash).toEqual({ count: 1, cents: 5000 });
    expect(k.collected_other_external.count).toBe(0); // the pending transfer is not collected
    expect(k.still_owes_note.count).toBe(1);
    expect(k.refunded_partial).toEqual({ count: 1, cents: 4000 }); // failed and legacy refunds add nothing here
    expect(k.bill_note.count).toBe(1);
    expect(st.all.collectedCents).toBe(15000); // $100 + $50 stays gross; the refund is not taken off it
    expect(st.reconciliation.rowsIn).toBe(st.reconciliation.rowsClassified);
  });
  it("a voided cash entry never appears", async () => {
    const { st } = await build(LEDGER);
    expect(st.all.kinds.collected_cash.count).toBe(1);
  });
  it("a refund still with Stripe is unresolved, so the visit cannot read as settled", async () => {
    const { st } = await build({ ...LEDGER, payment_refunds: [{ appointment_id: A, amount_cents: 4000, currency: "cad", status: "pending_stripe", legacy: false }] });
    expect(st.all.kinds.unresolved.count).toBe(1);
    expect(studioVisitStatus(st.visits[0].lines, 22500).label).toBe("Unresolved");
  });
  it("the visit pill says Part refunded once money has come back", async () => {
    const { st } = await build(LEDGER);
    expect(studioVisitStatus(st.visits[0].lines, 22500).label).toBe("Part refunded");
  });
  it("a refund of a cash payment is itemised the same way", async () => {
    const { st } = await build({ ...LEDGER, payment_charge_attempts: [], payment_refunds: [{ appointment_id: A, amount_cents: 2000, currency: "cad", status: "succeeded", legacy: false }] });
    expect(st.all.kinds.refunded_partial.cents).toBe(2000);
    expect(st.all.kinds.collected_cash.cents).toBe(5000);
  });
});

describe("the client document judges a visit against its bill", () => {
  async function doc(tables: Tables) {
    const { money } = await build(tables);
    const out = assembleClientInputs({
      studioCurrency: "cad", timezone: "America/Toronto", nowIso: "2026-11-20T00:00:00.000Z",
      appointments: [{ id: A, clientId: "c1", startsAt: T, status: "completed", practitionerId: null, serviceId: null, durationMinutes: 60 }],
      cardRows: money.cardRows, settlementRows: money.settlementRows, legacyFeeRows: money.legacyFeeRows, serviceNames: new Map(), practitionerNames: new Map(),
    });
    return classifyVisit(out.visits[0]);
  }
  it("a lone $100 card part of a $225 bill is NOT read as the whole fee", async () => {
    const v = await doc({ payment_charge_attempts: [card(10000)], visit_bills: LEDGER.visit_bills, sessions: SESSIONS });
    expect(v.fee).toMatchObject({ state: "recorded", cents: 22500 });
    expect(v.state).not.toBe("paid");
    expect(v.paidCents).toBe(10000);
  });
  it("fully paid in parts with a refund: paid, the refund shown, nothing netted", async () => {
    const v = await doc({
      payment_charge_attempts: [card(10000)], visit_bills: LEDGER.visit_bills, sessions: SESSIONS,
      visit_external_payments: [{ appointment_id: A, method: "paid_cash", amount_cents: 12500, currency: "cad", state: "confirmed" }],
      payment_refunds: [{ appointment_id: A, amount_cents: 4000, currency: "cad", status: "succeeded", legacy: false }],
    });
    expect(v.state).toBe("paid");
    expect(v.paidCents).toBe(22500);
    expect(v.refundedCents).toBe(4000);
  });
  it("the unconfirmed transfer leaves its amount owed against the bill", async () => {
    const v = await doc(LEDGER);
    expect(v.state).toBe("confirmed_unpaid");
    expect(v.owedCents).toBe(7500); // 225 - (100 card + 50 cash); the transfer is owed, not received
  });
  it("a payment returned leaves less retained: $100 cash with $40 reversed shows $40 due on a $100 bill", async () => {
    const v = await doc({
      visit_bills: [{ appointment_id: A, total_cents: 10000, currency: "cad" }], sessions: SESSIONS,
      visit_external_payments: [{ appointment_id: A, method: "paid_cash", amount_cents: 10000, currency: "cad", state: "confirmed" }],
      payment_refunds: [{ appointment_id: A, amount_cents: 4000, currency: "cad", status: "succeeded", legacy: false, kind: "payment_reversal" }],
    });
    expect(v.state).toBe("confirmed_unpaid");
    expect(v.owedCents).toBe(4000);
  });
  it("a price reduction with the money returned does not make the bill owe again", async () => {
    const v = await doc({
      visit_bills: [{ appointment_id: A, total_cents: 6000, currency: "cad" }], sessions: SESSIONS,
      visit_external_payments: [{ appointment_id: A, method: "paid_cash", amount_cents: 10000, currency: "cad", state: "confirmed" }],
      payment_refunds: [{ appointment_id: A, amount_cents: 4000, currency: "cad", status: "succeeded", legacy: false, kind: "price_reduction" }],
    });
    expect(v.state).toBe("paid");
  });
});

describe("an unreadable ledger is unavailable, never a total without it", () => {
  for (const table of ["visit_bills", "visit_external_payments", "payment_refunds"]) {
    it(`${table} read fails -> not ok`, async () => {
      expect(await readMoneyForAppointments(fake(LEDGER, table), STUDIO, [A])).toEqual({ ok: false });
    });
  }
  it("a scope with no ledger rows reads as before", async () => {
    const out = await readMoneyForAppointments(fake({}), STUDIO, [A]);
    expect(out.ok).toBe(true);
  });
  it("split refunds that total the whole charge are not counted twice beside the attempt's own full-refund mirror", async () => {
    const full = { ...card(10000), id: "att-1", refund_status: "refunded", refund_amount_cents: 10000 };
    const { st } = await build({
      payment_charge_attempts: [full], sessions: SESSIONS,
      payment_refunds: [
        { appointment_id: A, attempt_id: "att-1", amount_cents: 5000, currency: "cad", status: "succeeded", legacy: false, kind: "payment_reversal" },
        { appointment_id: A, attempt_id: "att-1", amount_cents: 5000, currency: "cad", status: "succeeded", legacy: false, kind: "payment_reversal" },
      ],
    });
    const refunded = st.all.kinds.refunded_partial.cents + st.all.kinds.refunded_card_session.cents;
    expect(refunded).toBe(10000);
  });
});
