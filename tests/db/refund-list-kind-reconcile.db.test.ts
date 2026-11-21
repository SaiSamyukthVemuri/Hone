import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { adminQuery, closePool } from "./helpers/harness";
import { cleanupPaymentScenario, seedEligibleQuickCheckoutScenario } from "./helpers/payment-seed";

// 0359: the BEHAVIOURAL half. reconcile_bound_payment_event accepts signed_event_with_authenticated_list for charge.refunded only.
// Needs a local stack carrying 0358 and 0359. Synthetic rows only; no provider call.

const created: string[] = [];
afterAll(async () => {
  for (const studioId of created) await cleanupPaymentScenario(studioId).catch(() => undefined);
  await closePool();
});

const AUTH = "signed_event_with_authenticated_list";
type P = Awaited<ReturnType<typeof prepared>>;
async function prepared() {
  const s = await seedEligibleQuickCheckoutScenario({ attempt: "ready" });
  created.push(s.studioId);
  const pi = `pi_kind_${randomUUID()}`;
  await adminQuery(`update public.payment_charge_attempts a
    set stripe_account_id=m.stripe_account_id, stripe_customer_id=m.stripe_customer_id, stripe_payment_intent_id=$2
    from public.client_payment_methods m where a.studio_id=$1 and m.id=a.client_payment_method_id`, [s.studioId, pi]);
  const row = (await adminQuery(`select * from public.payment_charge_attempts where studio_id=$1`, [s.studioId])).rows[0];
  const object = { customer_id: row.stripe_customer_id, payment_intent_id: pi, charge_id: `ch_kind_${randomUUID()}`, amount_cents: row.amount_cents,
    currency: row.currency, evidence_kind: "signed_event", event_created: 100 };
  const p = { s, row, object };
  expect((await bound(p, {}, "payment_intent.succeeded")).rows[0].result).toBe("reconciled");
  return p;
}
function bound(p: { row: Record<string, any>; object: Record<string, unknown> }, over: Record<string, unknown> = {}, type = "charge.refunded", eventId = `evt_${randomUUID()}`) {
  return adminQuery(`select * from public.reconcile_bound_payment_event($1,$2,$3,$4,$5,$6,$7::jsonb)`, [
    p.row.id, eventId, type, p.row.studio_id, p.row.stripe_account_id, p.row.stripe_livemode, JSON.stringify({ ...p.object, ...over })]);
}
const read = async (p: P) => (await adminQuery(`select refund_status,refund_amount_cents,stripe_refund_id,stripe_charge_refund_event_id
  from public.payment_charge_attempts where id=$1`, [p.row.id])).rows[0];

function cumulative(p: P, kind: string, parts?: number[], over: Record<string, unknown> = {}) {
  const amounts = parts ?? [Math.floor(p.row.amount_cents / 2), p.row.amount_cents - Math.floor(p.row.amount_cents / 2)];
  const comp = (amount: number) => ({ object_type: "refund", refund_id: `re_k_${randomUUID()}`, amount_cents: amount, currency: p.row.currency,
    refund_status: "succeeded", charge_id: p.object.charge_id, payment_intent_id: p.object.payment_intent_id, customer_present: false, customer_id: null });
  return { evidence_kind: kind, event_created: 600, refund_id: null, charge_object_type: "charge", charge_status: "succeeded", charge_paid: true,
    charge_captured: true, charge_amount_captured: p.row.amount_cents, charge_livemode: p.row.stripe_livemode, charge_refunded: true,
    charge_amount_refunded: p.row.amount_cents, charge_refund_list_complete: true, charge_refund_components: amounts.map(comp), ...over };
}
function single(p: P, kind: string, over: Record<string, unknown> = {}) {
  return { evidence_kind: kind, event_created: 600, refund_id: `re_s_${randomUUID()}`, refund_amount_cents: p.row.amount_cents,
    refund_currency: p.row.currency, refund_charge_id: p.object.charge_id, refund_status: "succeeded", ...over };
}

describe("0359: the cumulative full-refund branch accepts the authenticated kind", () => {
  it("two succeeded parts that add up to the charge, sent with the new kind, complete the refund exactly as the signed kind does", async () => {
    const a = await prepared();
    expect((await bound(a, cumulative(a, AUTH))).rows[0].result).toBe("reconciled");
    expect(await read(a)).toMatchObject({ refund_status: "succeeded", refund_amount_cents: a.row.amount_cents, stripe_refund_id: null });
    const b = await prepared();
    expect((await bound(b, cumulative(b, "signed_event"))).rows[0].result).toBe("reconciled");
    expect(await read(b)).toMatchObject({ refund_status: "succeeded", refund_amount_cents: b.row.amount_cents });
  });
  it("a list AHEAD of the charge (parts above the charge) and a list BEHIND it (parts below, or the refunded total not the whole charge) are refused", async () => {
    const p = await prepared();
    const half = Math.floor(p.row.amount_cents / 2);
    expect((await bound(p, cumulative(p, AUTH, [half, p.row.amount_cents - half + 1]))).rows[0].result).toBe("refund_evidence_refused");
    expect((await bound(p, cumulative(p, AUTH, [half, p.row.amount_cents - half - 1]))).rows[0].result).toBe("refund_evidence_refused");
    expect((await bound(p, cumulative(p, AUTH, undefined, { charge_amount_refunded: p.row.amount_cents - 1 }))).rows[0].result).toBe("refund_evidence_refused");
    expect((await read(p)).refund_status).toBeNull();
  });
  it("an incomplete list claim is refused with the new kind", async () => {
    const p = await prepared();
    expect((await bound(p, cumulative(p, AUTH, undefined, { charge_refund_list_complete: false }))).rows[0].result).toBe("refund_evidence_refused");
    expect((await read(p)).refund_status).toBeNull();
  });
  it("replay is already_refunded and an older event is stale", async () => {
    const p = await prepared();
    const ev = cumulative(p, AUTH);
    const eventId = `evt_${randomUUID()}`;
    await bound(p, ev, "charge.refunded", eventId);
    expect((await bound(p, ev, "charge.refunded", eventId)).rows[0].result).toBe("already_refunded");
    expect((await bound(p, { ...ev, event_created: 599 })).rows[0].result).toBe("stale_observation");
  });
});

describe("0359: the single full-refund branch accepts the authenticated kind only with a complete-list claim", () => {
  it("one succeeded full-amount refund, new kind, complete list claimed: reconciled", async () => {
    const p = await prepared();
    expect((await bound(p, single(p, AUTH, { charge_refund_list_complete: true }))).rows[0].result).toBe("reconciled");
    expect(await read(p)).toMatchObject({ refund_status: "succeeded", refund_amount_cents: p.row.amount_cents });
  });
  it("the new kind without the complete-list claim (absent or false) is invalid_input and writes nothing", async () => {
    const p = await prepared();
    expect((await bound(p, single(p, AUTH))).rows[0].result).toBe("invalid_input");
    expect((await bound(p, single(p, AUTH, { charge_refund_list_complete: false }))).rows[0].result).toBe("invalid_input");
    expect((await read(p)).refund_status).toBeNull();
  });
  it("a refund of less than the whole charge is still refused (this command completes only a full refund)", async () => {
    const p = await prepared();
    expect((await bound(p, single(p, AUTH, { charge_refund_list_complete: true, refund_amount_cents: p.row.amount_cents - 1 }))).rows[0].result).toBe("refund_evidence_refused");
  });
});

describe("0359: the new kind is for charge.refunded only; nothing else about the command changes", () => {
  it.each(["refund.created", "refund.updated", "refund.failed", "refund.observed", "payment_intent.succeeded", "payment_intent.payment_failed"])("%s with the new kind is invalid_input", async (type) => {
    const p = await prepared();
    expect((await bound(p, single(p, AUTH, { charge_refund_list_complete: true }), type)).rows[0].result).toBe("invalid_input");
    expect((await read(p)).refund_status).toBeNull();
  });
  it("unknown kinds are still refused, and the signed kind behaves exactly as before", async () => {
    const p = await prepared();
    for (const kind of ["authenticated", "", "action_response"]) {
      expect((await bound(p, cumulative(p, kind))).rows[0].result).toBe("refund_evidence_refused");
    }
    expect((await bound(p, single(p, "signed_event"))).rows[0].result).toBe("reconciled");
  });
  it("identity is still bound: a wrong customer, payment intent, amount, currency or charge is refused with the new kind", async () => {
    for (const patch of [{ customer_id: "cus_other" }, { payment_intent_id: "pi_other" }, { amount_cents: 1 }, { charge_id: "ch_other" }]) {
      const p = await prepared();
      expect((await bound(p, { ...cumulative(p, AUTH), ...patch })).rows[0].result).toBe("identity_mismatch");
    }
  });
  it("only service_role can execute the command", async () => {
    const sig = "public.reconcile_bound_payment_event(uuid,text,text,uuid,text,boolean,jsonb)";
    const priv = async (role: string) => (await adminQuery(`select has_function_privilege($1,$2,'execute') x`, [role, sig])).rows[0].x;
    expect(await priv("service_role")).toBe(true);
    for (const role of ["anon", "authenticated", "public"]) expect(await priv(role)).toBe(false);
  });
});

// ---- Both commands on one event: replay, ordering and late events ----------------------------------------------------------------------
// The webhook records the refund history first and then completes a full refund; either step may need to be retried. These replay ONE event
// through both commands and send a late partial event after a completed full refund.
async function history(p: P, evt: string, comps: Array<{ id: string; amount: number; status?: string }>, created: number, refundedCents: number) {
  const r = await adminQuery(`select * from public.record_charge_refund_history($1,$2,'charge.refunded',$3,$4,$5,$6::jsonb)`, [
    p.row.id, evt, p.row.studio_id, p.row.stripe_account_id, p.row.stripe_livemode,
    JSON.stringify({ customer_id: p.row.stripe_customer_id, payment_intent_id: p.object.payment_intent_id, charge_id: p.object.charge_id, amount_cents: p.row.amount_cents,
      currency: p.row.currency, evidence_kind: AUTH, event_created: created, charge_amount_refunded: refundedCents, charge_refund_list_complete: true,
      components: comps.map((c) => ({ refund_id: c.id, amount_cents: c.amount, currency: p.row.currency, refund_status: c.status ?? "succeeded", charge_id: p.object.charge_id, payment_intent_id: p.object.payment_intent_id })) })]);
  return r.rows[0] as { result: string; out_succeeded_cents: number | null };
}
const refundRows = async (p: P) => (await adminQuery(`select count(*)::int n from public.payment_charge_refunds where attempt_id=$1`, [p.row.id])).rows[0].n as number;
const histSummary = async (p: P) => (await adminQuery(`select refunds_succeeded_cents s from public.payment_charge_attempts where id=$1`, [p.row.id])).rows[0].s as number | null;

describe("0359 + 0358: one event through both commands", () => {
  it("history recorded, the full-refund step fails and is retried: the retry sees already_recorded from the history and still completes the refund, once", async () => {
    const p = await prepared();
    const half = Math.floor(p.row.amount_cents / 2);
    const comps = [{ id: "re_x1", amount: half }, { id: "re_x2", amount: p.row.amount_cents - half }];
    const evt = `evt_both_${randomUUID()}`;
    expect((await history(p, evt, comps, 600, p.row.amount_cents)).result).toBe("recorded");
    // (the full-refund step fails here: the webhook answers 500 and the provider redelivers the same event)
    expect((await read(p)).refund_status).toBeNull();
    expect((await history(p, evt, comps, 600, p.row.amount_cents)).result).toBe("already_recorded");
    expect((await bound(p, cumulative(p, AUTH, comps.map((c) => c.amount), { event_created: 600 }), "charge.refunded", evt)).rows[0].result).toBe("reconciled");
    expect((await bound(p, cumulative(p, AUTH, comps.map((c) => c.amount), { event_created: 600 }), "charge.refunded", evt)).rows[0].result).toBe("already_refunded");
    expect(await read(p)).toMatchObject({ refund_status: "succeeded", refund_amount_cents: p.row.amount_cents });
    expect(await refundRows(p)).toBe(2);
    expect(await histSummary(p)).toBe(p.row.amount_cents);
  });
  it("a completed full refund, then a LATE event listing only the first partial: nothing is lowered or undone", async () => {
    const p = await prepared();
    const half = Math.floor(p.row.amount_cents / 2);
    const both = [{ id: "re_l1", amount: half }, { id: "re_l2", amount: p.row.amount_cents - half }];
    await history(p, `evt_new_${randomUUID()}`, both, 700, p.row.amount_cents);
    expect((await bound(p, cumulative(p, AUTH, both.map((c) => c.amount), { event_created: 700 }))).rows[0].result).toBe("reconciled");
    const late = await history(p, `evt_late_${randomUUID()}`, [both[0]], 650, half);
    expect(["recorded", "already_recorded", "refund_evidence_refused"]).toContain(late.result);
    expect(await histSummary(p)).toBe(p.row.amount_cents);
    expect(await refundRows(p)).toBe(2);
    // the full-refund command refuses a late partial total and leaves the completed refund as it is
    const lateFull = await bound(p, cumulative(p, AUTH, [half], { event_created: 650, charge_amount_refunded: half, charge_refunded: false }));
    expect(["refund_evidence_refused", "already_refunded", "stale_observation"]).toContain(lateFull.rows[0].result);
    expect(await read(p)).toMatchObject({ refund_status: "succeeded", refund_amount_cents: p.row.amount_cents });
  });
  it("a refund that FAILS replaces a pending one (nothing was refunded); a later success for that refund is a conflict and changes nothing", async () => {
    const p = await prepared();
    await history(p, `evt_pend_${randomUUID()}`, [{ id: "re_f1", amount: 2000, status: "pending" }], 800, 0);
    expect(await histSummary(p)).toBe(0);
    const failed = await history(p, `evt_fail_${randomUUID()}`, [{ id: "re_f1", amount: 2000, status: "failed" }], 801, 0);
    expect(failed.result).toBe("recorded");
    expect(await histSummary(p)).toBe(0);
    const inflight = (await adminQuery(`select refunds_inflight_count f from public.payment_charge_attempts where id=$1`, [p.row.id])).rows[0].f;
    expect(inflight).toBe(0);
    const flip = await history(p, `evt_flip_${randomUUID()}`, [{ id: "re_f1", amount: 2000, status: "succeeded" }], 802, 2000);
    expect(flip.result).toBe("terminal_refund_mismatch");
    expect(await histSummary(p)).toBe(0);
  });
});
