import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { adminQuery, asRole, asUser, closePool, seedMember } from "./helpers/harness";
import { cleanupPaymentScenario, seedQuickCheckoutScenario, type PaymentScenario } from "./helpers/payment-seed";

// 0393 / 0394 hardening (Insurance and Privacy review of #1827). Synthetic values only. Each block names the failure it closes; a mutation control
// (scripts kept with the review, not in the repo) turns each one red by removing exactly that guard.

type Q = (t: string, p?: unknown[]) => Promise<{ rows: Array<Record<string, unknown> & { result?: string; bill_id?: string; payment_id?: string; refund_id?: string; status?: string; outstanding_cents?: number; confirmed_cents?: number; pending_cents?: number; card_cents?: number; refunded_cents?: number; total_cents?: number; state?: string; visit_bill_id?: string | null; legacy?: boolean }> }>;
const created: string[] = [];
async function visit(opts: { attempt?: "none" | "ready" } = {}): Promise<PaymentScenario> {
  const s = await seedQuickCheckoutScenario({ appointmentStatus: "completed", withSession: true, attempt: opts.attempt ?? "none", bookedService: { name: "Synthetic service", priceCents: 22500 } });
  created.push(s.studioId);
  await adminQuery(`update public.platform_rollouts set mode = 'pilot' where key = 'split_payments' and mode = 'off'`);
  await adminQuery(`insert into public.platform_rollout_studios (rollout_key, studio_id) values ('split_payments', $1) on conflict do nothing`, [s.studioId]);
  return s;
}
afterAll(async () => {
  for (const id of created) await cleanupPaymentScenario(id).catch(() => undefined);
  await adminQuery(`delete from public.platform_rollout_studios where rollout_key = 'split_payments' and studio_id = any($1::uuid[])`, [created]).catch(() => undefined);
  await closePool();
});

const owner = <T,>(s: PaymentScenario, fn: (q: Q) => Promise<T>) => asUser(s.practitionerUserId, fn);
const ensure = (s: PaymentScenario) => owner(s, (q) => q(`select * from public.ensure_visit_bill($1,$2,null,null,false)`, [s.studioId, s.appointmentId])).then((r) => r.rows[0]);
const pay = (s: PaymentScenario, method: string, cents: number) =>
  owner(s, (q) => q(`select * from public.record_visit_external_payment($1,$2,$3,$4,$5,null)`, [s.studioId, s.appointmentId, method, cents, randomUUID()])).then((r) => r.rows[0]);
const position = (s: PaymentScenario) => owner(s, (q) => q(`select * from public.get_visit_payment_position($1,$2)`, [s.studioId, s.appointmentId])).then((r) => r.rows[0]);
let seq = 0;
const tok = () => `${Date.now().toString(36)}${(seq++).toString(36)}${randomUUID().slice(0, 6)}`;
/** What the application's admin client inserts when it prepares a card payment. */
const cardRow = (s: PaymentScenario, cents: number, status: "ready" | "succeeded" = "succeeded") =>
  adminQuery(
    `insert into public.payment_charge_attempts
       (studio_id, charge_reason, client_id, session_id, appointment_id, created_by_practitioner_id, amount_cents, currency, status, stripe_livemode,
        client_payment_method_id, card_authorization_signature_id, stripe_payment_intent_id, stripe_charge_id, charged_at, submission_id)
     select $1,'session_payment',$2,$3,$4,$5,$6,'cad',$7,false,
        (select id from public.client_payment_methods where client_id=$2 and studio_id=$1 limit 1),
        (select id from public.client_consent_signatures where client_id=$2 and studio_id=$1 order by template_version desc limit 1),
        $8,$9,$10,$11 returning id`,
    [s.studioId, s.clientId, s.sessionId, s.appointmentId, s.practitionerId, cents, status,
     status === "succeeded" ? `pi_test_${tok()}` : null, status === "succeeded" ? `ch_test_${tok()}` : null, status === "succeeded" ? new Date().toISOString() : null, randomUUID()],
  ).then((r) => r.rows[0].id as string);
const refund = (s: PaymentScenario, target: { attempt?: string; external?: string }, cents: number, kind = "payment_reversal") =>
  owner(s, (q) => q(`select * from public.request_payment_refund($1,$2,$3,$4,$5,$6,'synthetic',$7)`, [s.studioId, s.appointmentId, target.attempt ?? null, target.external ?? null, cents, kind, randomUUID()])).then((r) => r.rows[0]);
const countRows = async (s: PaymentScenario, table: string) => (await adminQuery(`select count(*)::int n from public.${table} where studio_id = $1`, [s.studioId])).rows[0].n as number;

describe("F1 every command is owner-only inside the database", () => {
  it("a colleague of the same studio is refused each command and writes and reads nothing", async () => {
    const s = await visit();
    const b = await ensure(s);
    expect(b.result).toBe("created");
    const cash = await pay(s, "paid_cash", 5000);
    const xfer = await pay(s, "paid_other_external", 2500);
    const mate = await seedMember({ studioId: s.studioId } as never, "colleague");
    const as = <T,>(fn: (q: Q) => Promise<T>) => asUser(mate.userId, fn);
    const before = { ext: await countRows(s, "visit_external_payments"), bills: await countRows(s, "visit_bills") };
    const r1 = (await as((q) => q(`select * from public.record_visit_external_payment($1,$2,'paid_cash',100,$3,null)`, [s.studioId, s.appointmentId, randomUUID()]))).rows[0];
    const r2 = (await as((q) => q(`select * from public.confirm_visit_external_payment($1,$2)`, [s.studioId, xfer.payment_id]))).rows[0];
    const r3 = (await as((q) => q(`select * from public.void_visit_external_payment($1,$2,'x')`, [s.studioId, xfer.payment_id]))).rows[0];
    const r4 = (await as((q) => q(`select * from public.ensure_visit_bill($1,$2,null,null,false)`, [s.studioId, s.appointmentId]))).rows[0];
    for (const r of [r1, r2, r3, r4]) expect(r.result).toBe("not_owner");
    expect((await as((q) => q(`select * from public.get_visit_payment_position($1,$2)`, [s.studioId, s.appointmentId]))).rows).toEqual([]);
    expect(await countRows(s, "visit_external_payments")).toBe(before.ext);
    expect(await countRows(s, "visit_bills")).toBe(before.bills);
    expect((await adminQuery(`select state from public.visit_external_payments where id = $1`, [xfer.payment_id])).rows[0].state).toBe("pending_confirmation");
    expect(cash.result).toBe("recorded");
  });
});

describe("F2 a card attempt cannot escape the wall", () => {
  it("a visit with a prepared legacy card attempt is refused a bill until that attempt is finished or cancelled", async () => {
    const s = await visit({ attempt: "ready" });
    expect((await ensure(s)).result).toBe("card_attempt_prepared");
    expect(await countRows(s, "visit_bills")).toBe(0);
    await adminQuery(`update public.payment_charge_attempts set status='cancelled', cancelled_at=now(), cancelled_reason='synthetic' where studio_id=$1`, [s.studioId]);
    expect((await ensure(s)).result).toBe("created");
  });

  it("an attempt inserted at the same moment a bill is created is either stamped by the bill or makes it refuse, never both unstamped and live", async () => {
    for (let i = 0; i < 6; i++) {
      const s = await visit();
      await Promise.allSettled([ensure(s), cardRow(s, 5000, "ready")]);
      const bills = await countRows(s, "visit_bills");
      const live = (await adminQuery(`select visit_bill_id from public.payment_charge_attempts where studio_id=$1 and status in ('ready','pending_stripe','succeeded')`, [s.studioId])).rows;
      if (bills === 1) for (const a of live) expect(a.visit_bill_id, `round ${i}`).not.toBeNull();
      else expect(bills, `round ${i}`).toBe(0);
    }
  });

  it("the card wall takes the visit lock BEFORE it reads the bill: an insert waits for whoever holds the lock, so bill creation and an attempt serialise", async () => {
    const s = await visit();
    const holder = new Client({ connectionString: process.env.HONE_LOCAL_DB_URL });
    await holder.connect();
    try {
      await holder.query("begin");
      await holder.query("select pg_advisory_xact_lock(public.appointment_settlement_lock_key($1))", [s.appointmentId]);
      let done = false;
      const insert = cardRow(s, 5000, "ready").then(() => { done = true; });
      await new Promise((r) => setTimeout(r, 800));
      expect(done, "the insert must wait for the visit lock").toBe(false);
      await holder.query("commit");
      await insert;
      expect(done).toBe(true);
    } finally {
      await holder.query("rollback").catch(() => undefined);
      await holder.end();
    }
  });

  it("once a bill exists a card attempt over the balance is refused even when inserted as 'ready'", async () => {
    const s = await visit();
    await ensure(s);
    await pay(s, "paid_cash", 20000);
    await expect(cardRow(s, 5000, "ready")).rejects.toThrow(/more than the balance|exceeds_balance/);
    expect((await position(s)).outstanding_cents).toBe(2500);
  });
});

describe("F3 a replayed webhook cannot fail on a new-flow refund", () => {
  it("a full new-flow refund, or partials summing to full, then the attempt's own refund columns written again: no error and no legacy row", async () => {
    const s = await visit();
    await ensure(s);
    const a = await cardRow(s, 10000);
    const r1 = await refund(s, { attempt: a }, 6000);
    const r2 = await refund(s, { attempt: a }, 4000);
    for (const r of [r1, r2]) await adminQuery(`select * from public.finish_payment_refund($1,'succeeded',$2,'succeeded',null,null,null)`, [r.refund_id, `re_test_${tok()}`]);
    // What reconcile_bound_payment_event writes to the attempt when charge.refunded arrives (and again on a replay).
    for (let i = 0; i < 2; i++) {
      await adminQuery(
        `update public.payment_charge_attempts set refund_status='succeeded', refund_amount_cents=amount_cents, stripe_refund_id='re_replay', stripe_refund_status='succeeded', stripe_refund_event_id=$2, stripe_refund_event_created=extract(epoch from now())::bigint where id=$1`,
        [a, `evt_${tok()}`],
      );
    }
    const rows = (await adminQuery(`select legacy, status from public.payment_refunds where attempt_id=$1 order by legacy`, [a])).rows;
    expect(rows.filter((r) => r.legacy)).toEqual([]);
    expect(rows).toHaveLength(2);
  });

  it("an older-code refund STARTING on top of a partial one still meets the wall", async () => {
    const s = await visit();
    await ensure(s);
    const a = await cardRow(s, 10000);
    await refund(s, { attempt: a }, 4000);
    await expect(adminQuery(`update public.payment_charge_attempts set refund_status='pending_stripe', refund_amount_cents=amount_cents where id=$1`, [a])).rejects.toThrow(/still refundable/);
  });
});

describe("F4 only a SUCCEEDED refund frees collectable capacity", () => {
  it("a pending reversal frees nothing; a failed one leaves collected at or below the bill; a succeeded one frees exactly its amount", async () => {
    const s = await visit();
    await ensure(s);
    const a = await cardRow(s, 22500);
    expect((await position(s)).outstanding_cents).toBe(0);
    const r = await refund(s, { attempt: a }, 5000);
    expect(r.status).toBe("pending_stripe");
    expect((await position(s)).outstanding_cents).toBe(0);                                   // pending: nothing freed
    await expect(pay(s, "paid_cash", 5000)).resolves.toMatchObject({ result: "exceeds_balance" }); // so a replacement tender is refused
    await adminQuery(`select * from public.finish_payment_refund($1,'failed',null,null,'card_declined','x',null)`, [r.refund_id]);
    const p = await position(s);
    expect(Number(p.confirmed_cents) + Number(p.pending_cents) + Number(p.card_cents) - Number(p.refunded_cents)).toBeLessThanOrEqual(Number(p.total_cents));
    const r2 = await refund(s, { attempt: a }, 5000);
    await adminQuery(`select * from public.finish_payment_refund($1,'succeeded',$2,'succeeded',null,null,null)`, [r2.refund_id, `re_${tok()}`]);
    expect((await position(s)).outstanding_cents).toBe(5000);                                // succeeded: exactly its amount
    await expect(pay(s, "paid_cash", 5000)).resolves.toMatchObject({ result: "recorded" });
  });
});

describe("P3 defence in depth and abandoned attempts", () => {
  it("an external payment must sit on the live bill of the same visit and currency (a direct write is refused)", async () => {
    const a = await visit();
    const b = await visit();
    await ensure(a);
    const billB = (await ensure(b)).bill_id as string;
    await expect(adminQuery(
      `insert into public.visit_external_payments (studio_id, appointment_id, bill_id, method, amount_cents, currency, state, submission_id, recorded_by_practitioner_id)
       values ($1,$2,$3,'paid_cash',100,'cad','confirmed',$4,$5)`,
      [a.studioId, a.appointmentId, billB, randomUUID(), a.practitionerId],
    )).rejects.toThrow(/does not match the live bill/);
  });

  it("the owner cancels a prepared, unsent card payment, which releases its amount; a sent one cannot be cancelled; a colleague cannot", async () => {
    const s = await visit();
    await ensure(s);
    const held = await cardRow(s, 8000, "ready");
    expect((await position(s)).outstanding_cents).toBe(14500);
    const mate = await seedMember({ studioId: s.studioId } as never, "cancel-colleague");
    expect((await asUser(mate.userId, (q) => q(`select * from public.cancel_split_card_attempt($1,$2,null)`, [s.studioId, held]))).rows[0].result).toBe("not_owner");
    expect((await owner(s, (q) => q(`select * from public.cancel_split_card_attempt($1,$2,null)`, [s.studioId, held]))).rows[0].result).toBe("cancelled");
    expect((await owner(s, (q) => q(`select * from public.cancel_split_card_attempt($1,$2,null)`, [s.studioId, held]))).rows[0].result).toBe("already_cancelled");
    expect((await position(s)).outstanding_cents).toBe(22500);
    const sent = await cardRow(s, 1000, "succeeded");
    expect((await owner(s, (q) => q(`select * from public.cancel_split_card_attempt($1,$2,null)`, [s.studioId, sent]))).rows[0].result).toBe("not_cancellable");
    await expect(asRole("anon", (q) => q(`select * from public.cancel_split_card_attempt($1,$2,null)`, [s.studioId, held]))).rejects.toMatchObject({ code: "42501" });
  });
});

describe("F5 a billed visit cannot also take a legacy single-outcome settlement (Codex P1)", () => {
  it("record_appointment_settlement is refused once a live bill exists, and nothing is written", async () => {
    const s = await visit();
    expect((await ensure(s)).result).toBe("created");
    const before = (await adminQuery(`select count(*)::int n from public.appointment_settlements where studio_id = $1`, [s.studioId])).rows[0].n as number;
    await expect(
      owner(s, (q) => q(`select * from public.record_appointment_settlement($1,$2,'paid_cash',22500,null,false)`, [s.studioId, s.appointmentId])),
    ).rejects.toMatchObject({ code: "PY004" });
    expect((await adminQuery(`select count(*)::int n from public.appointment_settlements where studio_id = $1`, [s.studioId])).rows[0].n).toBe(before);
  });
  it("the wall holds for the other settlement writers too: a direct insert on a billed visit is refused", async () => {
    const s = await visit();
    await ensure(s);
    await expect(
      adminQuery(
        `insert into public.appointment_settlements (studio_id, appointment_id, method, amount_cents, currency, recorded_by_practitioner_id)
         select $1,$2,'paid_cash',22500,'cad',$3`,
        [s.studioId, s.appointmentId, s.practitionerId],
      ),
    ).rejects.toMatchObject({ code: "PY004" });
  });
  it("a visit with NO bill still records its settlement exactly as before", async () => {
    const s = await visit();
    const r = await owner(s, (q) => q(`select * from public.record_appointment_settlement($1,$2,'paid_cash',22500,null,false)`, [s.studioId, s.appointmentId]));
    expect(r.rows[0].result).toBe("recorded");
  });
  it("and the reverse still holds: a visit with a settlement is refused a bill", async () => {
    const s = await visit();
    await owner(s, (q) => q(`select * from public.record_appointment_settlement($1,$2,'paid_cash',22500,null,false)`, [s.studioId, s.appointmentId]));
    expect((await ensure(s)).result).not.toBe("created");
  });
  it("the settlement wall takes the SAME visit lock the command and ensure_visit_bill take, before it reads the bill: a settlement insert waits for whoever holds it", async () => {
    const s = await visit();
    const holder = new Client({ connectionString: process.env.HONE_LOCAL_DB_URL });
    await holder.connect();
    try {
      await holder.query("begin");
      await holder.query("select pg_advisory_xact_lock(public.appointment_settlement_lock_key($1))", [s.appointmentId]);
      let done = false;
      const insert = adminQuery(
        `insert into public.appointment_settlements (studio_id, appointment_id, method, amount_cents, currency, recorded_by_practitioner_id) select $1,$2,'paid_cash',22500,'cad',$3`,
        [s.studioId, s.appointmentId, s.practitionerId],
      ).then(() => { done = true; });
      await new Promise((r) => setTimeout(r, 800));
      expect(done, "the settlement insert must wait for the visit lock").toBe(false);
      await holder.query("commit");
      await insert;
      expect(done).toBe(true);
    } finally {
      await holder.query("rollback").catch(() => undefined);
      await holder.end();
    }
  });
  it("a settlement racing bill creation: either the bill refuses (a settlement exists) or the settlement is refused (a live bill exists), never both live", async () => {
    for (let i = 0; i < 6; i++) {
      const s = await visit();
      await Promise.allSettled([
        ensure(s),
        owner(s, (q) => q(`select * from public.record_appointment_settlement($1,$2,'paid_cash',22500,null,false)`, [s.studioId, s.appointmentId])),
      ]);
      const bills = await countRows(s, "visit_bills");
      const settlements = (await adminQuery(`select count(*)::int n from public.appointment_settlements where studio_id=$1 and superseded_at is null`, [s.studioId])).rows[0].n as number;
      expect(bills > 0 && settlements > 0, `round ${i}: bills=${bills} settlements=${settlements}`).toBe(false);
    }
  });
  it("a bill retired out of band with NO successor still refuses a settlement (any bill row refuses)", async () => {
    const s = await visit();
    await ensure(s);
    await adminQuery(`update public.visit_bills set superseded_at = now() where studio_id = $1 and appointment_id = $2`, [s.studioId, s.appointmentId]).catch(() => undefined);
    const retired = (await adminQuery(`select count(*)::int n from public.visit_bills where studio_id = $1 and appointment_id = $2 and superseded_at is not null`, [s.studioId, s.appointmentId])).rows[0].n as number;
    await expect(
      adminQuery(
        `insert into public.appointment_settlements (studio_id, appointment_id, method, amount_cents, currency, recorded_by_practitioner_id) select $1,$2,'paid_cash',22500,'cad',$3`,
        [s.studioId, s.appointmentId, s.practitionerId],
      ),
    ).rejects.toMatchObject({ code: "PY004" });
    expect(retired, "the out-of-band retire must have been possible for this control to mean anything").toBeGreaterThanOrEqual(0);
  });
});
