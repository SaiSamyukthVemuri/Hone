import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { adminQuery, asUser, closePool, resolveLocalDbUrl } from "./helpers/harness";
import { cleanupPaymentScenario, seedQuickCheckoutScenario, type PaymentScenario } from "./helpers/payment-seed";

// 0394 — the visit payment commands (HON-123 / HON-122), proved on the real migrated database. Synthetic values only.
// The acceptance example: a $225.00 visit paid $100 by card, $50 cash and a $75 transfer. A PENDING TRANSFER RESERVES ITS
// AMOUNT from the moment it is recorded, so no click order lets a card charge take that money, and the total collected can
// never pass the bill. Existing single-payment visits (no bill) keep exactly their old behaviour.

const created: string[] = [];
async function visit(opts: { completed?: boolean; on?: boolean } = {}): Promise<PaymentScenario> {
  const s = await seedQuickCheckoutScenario({
    appointmentStatus: opts.completed === false ? "confirmed" : "completed",
    withSession: true,
    attempt: "none",
    bookedService: { name: "Synthetic service", priceCents: 22500 },
  });
  created.push(s.studioId);
  if (opts.on !== false) {
    await adminQuery(`update public.platform_rollouts set mode = 'pilot' where key = 'split_payments' and mode = 'off'`);
    await adminQuery(`insert into public.platform_rollout_studios (rollout_key, studio_id) values ('split_payments', $1) on conflict do nothing`, [s.studioId]);
  }
  return s;
}
afterAll(async () => {
  for (const id of created) await cleanupPaymentScenario(id).catch(() => undefined);
  await adminQuery(`delete from public.platform_rollout_studios where rollout_key = 'split_payments' and studio_id = any($1::uuid[])`, [created]).catch(() => undefined);
  await closePool();
});

const asOwner = <T,>(s: PaymentScenario, fn: (q: (t: string, p?: unknown[]) => Promise<{ rows: any[] }>) => Promise<T>) => asUser(s.practitionerUserId, fn);
const ensure = (s: PaymentScenario, final: number | null = null, reason: string | null = null) =>
  asOwner(s, (q) => q(`select * from public.ensure_visit_bill($1,$2,$3,$4,false)`, [s.studioId, s.appointmentId, final, reason])).then((r) => r.rows[0]);
const pay = (s: PaymentScenario, method: string, cents: number, submission = randomUUID()) =>
  asOwner(s, (q) => q(`select * from public.record_visit_external_payment($1,$2,$3,$4,$5,null)`, [s.studioId, s.appointmentId, method, cents, submission])).then((r) => r.rows[0]);
const confirm = (s: PaymentScenario, id: string) => asOwner(s, (q) => q(`select * from public.confirm_visit_external_payment($1,$2)`, [s.studioId, id])).then((r) => r.rows[0]);
const voidIt = (s: PaymentScenario, id: string, reason = "synthetic void") =>
  asOwner(s, (q) => q(`select * from public.void_visit_external_payment($1,$2,$3)`, [s.studioId, id, reason])).then((r) => r.rows[0]);
const refund = (s: PaymentScenario, target: { attempt?: string; external?: string }, cents: number, kind = "payment_reversal", submission = randomUUID()) =>
  asOwner(s, (q) =>
    q(`select * from public.request_payment_refund($1,$2,$3,$4,$5,$6,'synthetic refund',$7)`, [s.studioId, s.appointmentId, target.attempt ?? null, target.external ?? null, cents, kind, submission]),
  ).then((r) => r.rows[0]);
const position = (s: PaymentScenario) =>
  asOwner(s, (q) => q(`select * from public.get_visit_payment_position($1,$2)`, [s.studioId, s.appointmentId])).then((r) => r.rows[0]);

let tokenSeq = 0;
const token = () => `${Date.now().toString(36)}${(tokenSeq++).toString(36)}${randomUUID().slice(0, 6)}`;
// What the application's admin client inserts when it prepares a card payment (the amount is the operator-confirmed amount).
const card = (s: PaymentScenario, cents: number, status: "ready" | "succeeded" = "succeeded", submission: string | null = null) =>
  adminQuery(
    `insert into public.payment_charge_attempts
       (studio_id, charge_reason, client_id, session_id, appointment_id, created_by_practitioner_id, amount_cents, currency, status, stripe_livemode,
        client_payment_method_id, card_authorization_signature_id, stripe_payment_intent_id, stripe_charge_id, charged_at, submission_id)
     select $1,'session_payment',$2,$3,$4,$5,$6,'cad',$7,false,
        (select id from public.client_payment_methods where client_id=$2 and studio_id=$1 limit 1),
        (select id from public.client_consent_signatures where client_id=$2 and studio_id=$1 order by template_version desc limit 1),
        $8,$9,$10,$11
     returning id`,
    [s.studioId, s.clientId, s.sessionId, s.appointmentId, s.practitionerId, cents, status,
     status === "succeeded" ? `pi_test_${token()}` : null, status === "succeeded" ? `ch_test_${token()}` : null,
     status === "succeeded" ? new Date().toISOString() : null, submission],
  ).then((r) => r.rows[0].id as string);
const attempts = (s: PaymentScenario) =>
  adminQuery(`select id, amount_cents, status from public.payment_charge_attempts where studio_id=$1 order by created_at`, [s.studioId]).then((r) => r.rows);
const collected = async (s: PaymentScenario) => {
  const p = await position(s);
  return p.confirmed_cents + p.pending_cents + p.card_cents - p.refunded_cents;
};

describe("0394 the rollout key and the bill", () => {
  it("is OFF by default: a studio that is not listed gets split_payments_off and no bill", async () => {
    const s = await visit({ on: false });
    expect((await ensure(s)).result).toBe("split_payments_off");
    expect((await adminQuery(`select 1 from public.visit_bills where studio_id=$1`, [s.studioId])).rowCount).toBe(0);
  });

  it("makes one bill for a completed visit from its quote, idempotently; an unfinished visit gets none", async () => {
    const s = await visit();
    const a = await ensure(s);
    expect(a).toMatchObject({ result: "created", total_cents: 22500, currency: "cad" });
    const b = await ensure(s);
    expect(b).toMatchObject({ result: "exists", bill_id: a.bill_id, total_cents: 22500 });
    expect((await adminQuery(`select 1 from public.visit_bills where studio_id=$1`, [s.studioId])).rowCount).toBe(1);
    const open = await visit({ completed: false });
    expect((await ensure(open)).result).toBe("not_completed");
  });

  it("a changed total needs a reason and keeps the booked fee as evidence", async () => {
    const s = await visit();
    expect((await ensure(s, 20000, null)).result).toBe("invalid_input");
    expect(await ensure(s, 20000, "Loyalty price")).toMatchObject({ result: "created", total_cents: 20000 });
    const row = (await adminQuery(`select reference_fee_cents, fee_adjustment_reason from public.visit_bills where studio_id=$1`, [s.studioId])).rows[0];
    expect(row).toEqual({ reference_fee_cents: 22500, fee_adjustment_reason: "Loyalty price" });
  });
});

describe("0394 splitting one visit: $100 card, $50 cash, $75 transfer", () => {
  it("a double-submitted $50 cash payment is one row and leaves $175 collectable", async () => {
    const s = await visit();
    await ensure(s);
    const sub = randomUUID();
    const first = await pay(s, "paid_cash", 5000, sub);
    const again = await pay(s, "paid_cash", 5000, sub);
    expect(first).toMatchObject({ result: "recorded", state: "confirmed" });
    expect(again).toMatchObject({ result: "already_recorded", payment_id: first.payment_id });
    expect((await adminQuery(`select 1 from public.visit_external_payments where studio_id=$1`, [s.studioId])).rowCount).toBe(1);
    expect((await position(s)).outstanding_cents).toBe(17500);
    expect((await pay(s, "paid_cash", 5000, sub)).result).toBe("already_recorded");
    expect((await pay(s, "paid_cash", 6000, sub)).result).toBe("submission_reused");
  });

  it("the whole split: card $100 + cash $50 + a pending $75 transfer reserves the rest; confirming settles it; $225 collected, never more", async () => {
    const s = await visit();
    await ensure(s);
    await card(s, 10000);
    expect((await pay(s, "paid_cash", 5000)).result).toBe("recorded");
    const t = await pay(s, "paid_e_transfer", 7500);
    expect(t).toMatchObject({ result: "recorded", state: "pending_confirmation" });
    let p = await position(s);
    expect(p).toMatchObject({ total_cents: 22500, confirmed_cents: 5000, pending_cents: 7500, card_cents: 10000, outstanding_cents: 0 });
    expect((await confirm(s, t.payment_id)).result).toBe("confirmed");
    expect((await confirm(s, t.payment_id)).result).toBe("already_confirmed");
    p = await position(s);
    expect(p).toMatchObject({ confirmed_cents: 12500, pending_cents: 0, outstanding_cents: 0 });
    expect(await collected(s)).toBe(22500);
  });

  it("more than the balance is refused (cash and card alike), and nothing is written", async () => {
    const s = await visit();
    await ensure(s);
    await card(s, 10000);
    expect((await pay(s, "paid_cash", 12501)).result).toBe("exceeds_balance");
    await expect(card(s, 12501)).rejects.toMatchObject({ code: "PY002" });
    expect((await attempts(s)).length).toBe(1);
    expect(await collected(s)).toBe(10000);
  });
});

describe("0394 a pending transfer RESERVES its amount (both click orders and a real race)", () => {
  async function reserved() {
    const s = await visit();
    await ensure(s);
    await card(s, 10000);
    await pay(s, "paid_cash", 5000);
    const t = await pay(s, "paid_e_transfer", 7500);
    return { s, transferId: t.payment_id as string };
  }

  it("(a) the card is clicked first, then the transfer is confirmed: the card is refused with the reserved message, $225 ends collected", async () => {
    const { s, transferId } = await reserved();
    const before = (await attempts(s)).length;
    await expect(card(s, 7500, "ready")).rejects.toMatchObject({ code: "PY001", message: expect.stringContaining("This amount is reserved for a pending transfer") });
    expect((await confirm(s, transferId)).result).toBe("confirmed");
    expect((await attempts(s)).length).toBe(before);   // no attempt row, so there was nothing to send to Stripe
    expect(await collected(s)).toBe(22500);
  });

  it("(b) the transfer is confirmed first, then the card is clicked: refused (nothing left to collect), $225 ends collected", async () => {
    const { s, transferId } = await reserved();
    await confirm(s, transferId);
    await expect(card(s, 7500, "ready")).rejects.toMatchObject({ code: "PY002" });
    expect(await collected(s)).toBe(22500);
    expect((await attempts(s)).length).toBe(1);
  });

  it("truly concurrent: confirm and card at the same instant, many times: the card never gets in and the bill never passes $225", async () => {
    for (let i = 0; i < 4; i += 1) {
      const { s, transferId } = await reserved();
      const [c, k] = await Promise.allSettled([confirm(s, transferId), card(s, 7500, "ready")]);
      expect(c.status).toBe("fulfilled");
      expect(k.status).toBe("rejected");
      expect(["PY001", "PY002"]).toContain((k as PromiseRejectedResult).reason.code);
      expect(await collected(s)).toBe(22500);
      expect((await attempts(s)).length).toBe(1);
    }
  });

  it("two cards racing for the last $75 of a visit: exactly one is made", async () => {
    const s = await visit();
    await ensure(s);
    await card(s, 15000);
    const results = await Promise.allSettled([card(s, 7500, "ready"), card(s, 7500, "ready"), card(s, 7500, "ready")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await collected(s)).toBe(22500);
  });

  it("overlap is FORCED, not hoped for: while another transaction holds the visit's lock, a card waits behind it, then is refused", async () => {
    const { s, transferId } = await reserved();
    const holder = new Client({ connectionString: resolveLocalDbUrl() });
    await holder.connect();
    try {
      await holder.query("begin");
      await holder.query("select pg_advisory_xact_lock(public.appointment_settlement_lock_key($1))", [s.appointmentId]);
      let settled = false;
      const attempt = card(s, 7500, "ready").then(() => "made", (e) => e.code as string).finally(() => { settled = true; });
      await new Promise((r) => setTimeout(r, 700));
      expect(settled).toBe(false);                 // the card is queued behind the lock: nothing decided yet
      await holder.query("update public.visit_external_payments set state = 'confirmed', confirmed_by_practitioner_id = recorded_by_practitioner_id where id = $1", [transferId]);
      await holder.query("commit");
      expect(await attempt).toBe("PY002");         // it then sees the settled position and is refused
      expect(await collected(s)).toBe(22500);
      expect((await attempts(s)).length).toBe(1);
    } finally {
      await holder.end();
    }
  });

  it("a void releases the $75: one $75 card then succeeds, exactly once", async () => {
    const { s, transferId } = await reserved();
    expect((await voidIt(s, transferId)).result).toBe("voided");
    expect((await voidIt(s, transferId)).result).toBe("already_voided");
    expect((await confirm(s, transferId)).result).toBe("voided");
    expect((await position(s)).outstanding_cents).toBe(7500);
    await card(s, 7500, "ready");
    await expect(card(s, 7500, "ready")).rejects.toMatchObject({ code: "PY002" });
    expect(await collected(s)).toBe(22500);
  });

  it("a confirmed payment is final: it cannot be voided (money returned later is a refund)", async () => {
    const { s, transferId } = await reserved();
    await confirm(s, transferId);
    expect((await voidIt(s, transferId)).result).toBe("confirmed_is_final");
  });

  it("a cash payment that would take reserved money is refused with the reserved reason", async () => {
    const { s } = await reserved();
    expect((await pay(s, "paid_cash", 7500)).result).toBe("reserved_for_pending_transfer");
    expect((await pay(s, "paid_cash", 1)).result).toBe("reserved_for_pending_transfer");
    expect((await pay(s, "paid_cash", 7501)).result).toBe("exceeds_balance");
  });
});

describe("0394 refunds against a selected payment", () => {
  it("an external refund is recorded at once; a payment_reversal raises the balance due; the cap is per payment", async () => {
    const s = await visit();
    await ensure(s);
    const cash = (await pay(s, "paid_cash", 10000)).payment_id as string;
    const r = await refund(s, { external: cash }, 4000);
    expect(r).toMatchObject({ result: "requested", status: "succeeded" });
    expect((await position(s)).outstanding_cents).toBe(22500 - 10000 + 4000);
    expect((await refund(s, { external: cash }, 6001)).result).toBe("exceeds_refundable");
    expect((await refund(s, { external: cash }, 6000)).result).toBe("requested");
    expect((await refund(s, { external: cash }, 1)).result).toBe("exceeds_refundable");
  });

  it("a price_reduction lowers the bill by the amount and leaves the balance unchanged; the old bill is kept, superseded", async () => {
    const s = await visit();
    await ensure(s);
    const cash = (await pay(s, "paid_cash", 10000)).payment_id as string;
    const before = await position(s);
    const r = await refund(s, { external: cash }, 3000, "price_reduction");
    expect(r.result).toBe("requested");
    const after = await position(s);
    expect(after.total_cents).toBe(19500);
    expect(after.outstanding_cents).toBe(before.outstanding_cents);
    const bills = (await adminQuery(`select total_cents, superseded_at is not null as old from public.visit_bills where studio_id=$1 order by created_at`, [s.studioId])).rows;
    expect(bills).toEqual([{ total_cents: 22500, old: true }, { total_cents: 19500, old: false }]);
  });

  it("a retried refund submission returns the first refund and changes nothing", async () => {
    const s = await visit();
    await ensure(s);
    const cash = (await pay(s, "paid_cash", 10000)).payment_id as string;
    const sub = randomUUID();
    const a = await refund(s, { external: cash }, 2500, "payment_reversal", sub);
    const b = await refund(s, { external: cash }, 2500, "payment_reversal", sub);
    expect(b).toMatchObject({ result: "already_requested", refund_id: a.refund_id });
    expect((await refund(s, { external: cash }, 2600, "payment_reversal", sub)).result).toBe("submission_reused");
    expect((await adminQuery(`select 1 from public.payment_refunds where studio_id=$1 and not legacy`, [s.studioId])).rowCount).toBe(1);
  });

  it("a card refund is pending, settled once by Stripe's outcome (replays change nothing); $40 of $100 leaves $60 refundable", async () => {
    const s = await visit();
    await ensure(s);
    const a = await card(s, 10000);
    const r = await refund(s, { attempt: a }, 4000);
    expect(r).toMatchObject({ result: "requested", status: "pending_stripe" });
    const fin = (outcome: string, extra: Partial<{ id: string; fee: number | null }> = {}) =>
      // The function is SECURITY DEFINER and only service_role may execute it (proved in the privileges test); asRole rolls back, so run it as the owner here.
      adminQuery(`select * from public.finish_payment_refund($1,$2,$3,'succeeded',null,null,$4)`, [r.refund_id, outcome, extra.id ?? `re_test_${token()}`, extra.fee ?? null]).then((x) => x.rows[0]);
    const done = await fin("succeeded", { id: `re_${token()}`, fee: 20 });
    expect(done.result).toBe("succeeded");
    expect((await fin("succeeded")).result).toBe("already_settled");
    expect((await adminQuery(`select status, platform_fee_returned_cents from public.payment_refunds where id=$1`, [r.refund_id])).rows[0]).toEqual({ status: "succeeded", platform_fee_returned_cents: 20 });
    expect(await adminQuery(`select public.payment_refundable_cents($1, null) as n`, [a]).then((x) => x.rows[0].n)).toBe(6000);
    expect((await refund(s, { attempt: a }, 6001)).result).toBe("exceeds_refundable");
  });

  it("a failed card refund consumes nothing and is retried as a NEW row; a failed price reduction gives the price back", async () => {
    const s = await visit();
    await ensure(s);
    const a = await card(s, 10000);
    const r = await refund(s, { attempt: a }, 4000, "price_reduction");
    expect((await position(s)).total_cents).toBe(18500);
    const failed = await adminQuery(`select * from public.finish_payment_refund($1,'failed',null,'failed','card_declined','Declined',null)`, [r.refund_id]).then((x) => x.rows[0]);
    expect(failed.result).toBe("failed");
    expect((await position(s)).total_cents).toBe(22500);
    expect(await adminQuery(`select public.payment_refundable_cents($1, null) as n`, [a]).then((x) => x.rows[0].n)).toBe(10000);
    expect((await refund(s, { attempt: a }, 4000)).result).toBe("requested");
  });

  it("the payment must be settled: a ready (unpaid) card attempt cannot be refunded", async () => {
    const s = await visit();
    await ensure(s);
    const a = await card(s, 5000, "ready");
    expect((await refund(s, { attempt: a }, 1000)).result).toBe("payment_not_refundable");
  });
});

describe("0394 who can run what", () => {
  it("anon and public run nothing; authenticated cannot run the Stripe outcome; service_role cannot run the staff commands", async () => {
    const r = await adminQuery(`
      select f,
             has_function_privilege('anon', f, 'execute') as anon,
             has_function_privilege('authenticated', f, 'execute') as auth,
             has_function_privilege('service_role', f, 'execute') as svc
        from unnest(array[
          'public.ensure_visit_bill(uuid,uuid,integer,text,boolean)',
          'public.record_visit_external_payment(uuid,uuid,text,integer,uuid,text)',
          'public.confirm_visit_external_payment(uuid,uuid)',
          'public.void_visit_external_payment(uuid,uuid,text)',
          'public.request_payment_refund(uuid,uuid,uuid,uuid,integer,text,text,uuid)',
          'public.get_visit_payment_position(uuid,uuid)',
          'public.finish_payment_refund(uuid,text,text,text,text,text,integer)',
          'public.visit_payment_position(uuid,uuid)',
          'public.visit_payment_refusal(uuid,uuid,integer)',
          'public.visit_bill_supersede(uuid,uuid,integer,text,uuid)',
          'public.payment_charge_attempts_visit_bill_guard()']) f`);
    for (const row of r.rows) expect(row.anon, row.f).toBe(false);
    const by = Object.fromEntries(r.rows.map((x) => [x.f.split("(")[0].replace("public.", ""), x]));
    for (const staff of ["ensure_visit_bill", "record_visit_external_payment", "confirm_visit_external_payment", "void_visit_external_payment", "request_payment_refund", "get_visit_payment_position"]) {
      expect(by[staff].auth, staff).toBe(true);
      expect(by[staff].svc, staff).toBe(false);
    }
    expect(by.finish_payment_refund).toMatchObject({ auth: false, svc: true });
    for (const internal of ["visit_payment_position", "visit_payment_refusal", "visit_bill_supersede", "payment_charge_attempts_visit_bill_guard"]) {
      expect(by[internal], internal).toMatchObject({ anon: false, auth: false, svc: false });
    }
  });

  it("a member of ANOTHER studio is refused every staff command and reads no position", async () => {
    const mine = await visit();
    const other = await visit();
    await ensure(mine);
    await expect(
      asUser(other.practitionerUserId, (q) => q(`select * from public.ensure_visit_bill($1,$2,null,null,false)`, [mine.studioId, mine.appointmentId])),
    ).rejects.toBeTruthy();
    const read = await asUser(other.practitionerUserId, (q) => q(`select * from public.get_visit_payment_position($1,$2)`, [mine.studioId, mine.appointmentId]));
    expect(read.rows).toEqual([]);
  });
});

describe("0394 a visit without a bill behaves exactly as before", () => {
  it("the one-active-card-attempt-per-session rule still holds, and no bill is stamped", async () => {
    const s = await visit();
    const a = await card(s, 22500, "ready");
    expect((await adminQuery(`select visit_bill_id from public.payment_charge_attempts where id=$1`, [a])).rows[0].visit_bill_id).toBeNull();
    await expect(card(s, 22500, "ready")).rejects.toMatchObject({ code: "23505" });
  });

  it("a repeated prepare with the same submission id returns the first attempt (unique per studio)", async () => {
    const s = await visit();
    const sub = randomUUID();
    await card(s, 5000, "ready", sub);
    await expect(card(s, 5000, "ready", sub)).rejects.toMatchObject({ code: "23505" });
  });

  it("ensure_visit_bill refuses a visit that already has a card payment", async () => {
    const s = await visit();
    await card(s, 22500, "succeeded");
    expect((await ensure(s)).result).toBe("card_payment_exists");
    expect((await adminQuery(`select 1 from public.visit_bills where studio_id=$1`, [s.studioId])).rowCount).toBe(0);
  });

  it("ensure_visit_bill refuses a visit that already has a settlement (paid another way), and writes no bill", async () => {
    const s = await visit();
    const rec = await asOwner(s, (q) => q(`select * from public.record_appointment_settlement($1,$2,'paid_cash',22500,null,false)`, [s.studioId, s.appointmentId]));
    expect(rec.rows[0].result).toBe("recorded");
    expect((await ensure(s)).result).toBe("already_settled");
    expect((await adminQuery(`select 1 from public.visit_bills where studio_id=$1`, [s.studioId])).rowCount).toBe(0);
  });
});
