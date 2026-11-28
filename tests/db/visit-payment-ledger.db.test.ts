import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { adminQuery, asUser, closePool, seedMember } from "./helpers/harness";
import { cleanupPaymentScenario, seedEligibleQuickCheckoutScenario, type PaymentScenario } from "./helpers/payment-seed";

// 0393 — the visit payment ledger (HON-123 / HON-122), the TABLE half: what the database refuses on its own.
// The commands are 0394. Here every write is made as the table owner, to prove the constraints and guards that stand
// behind those commands: one live bill per visit, a transfer that is not "paid" until it is confirmed, no refund that
// exceeds its payment (also under a race), append-only history, and the legacy single refund kept true by the mirror.
// $225.00 is the synthetic fixture amount of the payment seed (Sam's acceptance example).

const created: string[] = [];
async function scenario(opts: Parameters<typeof seedEligibleQuickCheckoutScenario>[0] = {}): Promise<PaymentScenario> {
  const s = await seedEligibleQuickCheckoutScenario({ attempt: "succeeded", ...opts });
  created.push(s.studioId);
  return s;
}
afterAll(async () => {
  for (const id of created) await cleanupPaymentScenario(id).catch(() => undefined);
  await closePool();
});

const attemptOf = async (s: PaymentScenario) =>
  (await adminQuery(`select id, amount_cents, currency from public.payment_charge_attempts where studio_id=$1 and session_id=$2`, [s.studioId, s.sessionId])).rows[0] as {
    id: string; amount_cents: number; currency: string;
  };

async function bill(s: PaymentScenario, totalCents = 22500) {
  const r = await adminQuery(
    `insert into public.visit_bills (studio_id, appointment_id, currency, total_cents, created_by_practitioner_id)
     values ($1,$2,'cad',$3,$4) returning id`,
    [s.studioId, s.appointmentId, totalCents, s.practitionerId],
  );
  return r.rows[0].id as string;
}
async function external(s: PaymentScenario, billId: string, method: string, state: string, cents: number) {
  const confirmed = state === "confirmed";
  const r = await adminQuery(
    `insert into public.visit_external_payments
       (studio_id, appointment_id, bill_id, method, amount_cents, currency, state, submission_id, recorded_by_practitioner_id,
        confirmed_by_practitioner_id)
     values ($1,$2,$3,$4,$5,'cad',$6,$7,$8,$9) returning id`,
    [s.studioId, s.appointmentId, billId, method, cents, state, randomUUID(), s.practitionerId, confirmed ? s.practitionerId : null],
  );
  return r.rows[0].id as string;
}
async function refund(
  s: PaymentScenario,
  target: { attemptId?: string; externalId?: string },
  cents: number,
  extra: { status?: string; kind?: string; reducedBillId?: string | null; submission?: string | null } = {},
) {
  const external = !!target.externalId;
  return adminQuery(
    `insert into public.payment_refunds
       (studio_id, appointment_id, attempt_id, external_payment_id, amount_cents, currency, kind, reason, status,
        reduced_bill_id, submission_id, requested_by_practitioner_id, confirmed_by_practitioner_id)
     values ($1,$2,$3,$4,$5,'cad',$6,'synthetic test refund',$7,$8,$9,$10,$11) returning id`,
    [
      s.studioId, s.appointmentId, target.attemptId ?? null, target.externalId ?? null, cents, extra.kind ?? "payment_reversal",
      extra.status ?? (external ? "succeeded" : "pending_stripe"), extra.reducedBillId ?? null,
      extra.submission === undefined ? randomUUID() : extra.submission, s.practitionerId, external ? s.practitionerId : null,
    ],
  );
}
const refundable = async (attemptId: string | null, externalId: string | null) =>
  (await adminQuery(`select public.payment_refundable_cents($1,$2) as n`, [attemptId, externalId])).rows[0].n as number | null;

describe("0393 structure and access", () => {
  it("the three tables hold read-only OWNER access and no write grant for any role", async () => {
    for (const table of ["visit_bills", "visit_external_payments", "payment_refunds"]) {
      const rls = await adminQuery(`select relrowsecurity from pg_class where oid = ('public.' || $1)::regclass`, [table]);
      expect(rls.rows[0].relrowsecurity, table).toBe(true);
      const g = await adminQuery(
        `select grantee, privilege_type from information_schema.role_table_grants
          where table_schema='public' and table_name=$1 and grantee in ('anon','authenticated','service_role','public')`,
        [table],
      );
      expect(g.rows.filter((r) => r.privilege_type !== "SELECT"), table).toEqual([]);
      expect(g.rows.filter((r) => r.grantee !== "authenticated"), table).toEqual([]);
    }
    for (const fn of ["visit_bills_guard()", "visit_external_payments_guard()", "payment_refunds_guard()", "payment_refunds_mirror_attempt()", "payment_refundable_cents(uuid,uuid)"]) {
      const a = await adminQuery(
        `select r.rolname, has_function_privilege(r.oid, ('public.' || $1)::regprocedure, 'execute') as can
           from pg_roles r where r.rolname in ('anon','authenticated','service_role')`,
        [fn],
      );
      expect(a.rows.filter((r) => r.can), fn).toEqual([]);
    }
  });

  it("the studio's owner reads only its own studio's rows, and another practitioner of the studio reads none (owner-only, as payment_charge_attempts)", async () => {
    const a = await scenario();
    const b = await scenario();
    const billA = await bill(a);
    await bill(b);
    const own = await asUser(a.practitionerUserId, (q) => q(`select id from public.visit_bills`));
    expect(own.rows.map((r) => r.id)).toEqual([billA]);
    await expect(asUser(a.practitionerUserId, (q) => q(`insert into public.visit_bills (studio_id) values ($1)`, [a.studioId]))).rejects.toThrow();
    const member = await seedMember({ studioId: a.studioId, userId: a.practitionerUserId, practitionerId: a.practitionerId, clientId: a.clientId }, "member");
    const asMember = await asUser(member.userId, (q) => q(`select id from public.visit_bills`));
    expect(asMember.rows).toEqual([]);
  });
});

describe("visit_bills", () => {
  it("allows one live bill per visit, versions by superseding, and is never edited or deleted", async () => {
    const s = await scenario();
    const first = await bill(s, 22500);
    await expect(bill(s, 10000)).rejects.toThrow(/visit_bills_one_live_per_appointment|duplicate key/);

    // A price reduction is a NEW version; the old one is retired once.
    const next = await adminQuery(
      `insert into public.visit_bills (studio_id, appointment_id, currency, total_cents, created_by_practitioner_id, supersedes_id, supersede_reason)
       select studio_id, appointment_id, currency, 18500, created_by_practitioner_id, id, 'goodwill' from public.visit_bills where id=$1 returning id`,
      [first],
    ).catch((e) => e);
    // The old version is still live until it is retired, so the unique index refuses the successor first: the command
    // (0394) retires and inserts in ONE transaction with the old row retired first.
    expect(next instanceof Error).toBe(true);
    await adminQuery("begin");
    try {
      const id = randomUUID();
      await adminQuery(`update public.visit_bills set superseded_at=now(), superseded_by_id=$2 where id=$1`, [first, id]);
      await adminQuery(
        `insert into public.visit_bills (id, studio_id, appointment_id, currency, total_cents, created_by_practitioner_id, supersedes_id, supersede_reason)
         select $2, studio_id, appointment_id, currency, 18500, created_by_practitioner_id, id, 'goodwill' from public.visit_bills where id=$1`,
        [first, id],
      );
      await adminQuery("commit");
    } catch (e) {
      await adminQuery("rollback").catch(() => undefined);
      throw e;
    }
    const live = await adminQuery(`select total_cents from public.visit_bills where studio_id=$1 and superseded_at is null`, [s.studioId]);
    expect(live.rows).toEqual([{ total_cents: 18500 }]);

    await expect(adminQuery(`update public.visit_bills set total_cents=1 where id=$1`, [first])).rejects.toThrow(/never edited/);
    await expect(adminQuery(`delete from public.visit_bills where id=$1`, [first])).rejects.toThrow(/never deleted/);
    await expect(adminQuery(`update public.visit_bills set superseded_at=now() where id=$1`, [first])).rejects.toThrow(/retired once/);
  });

  it("refuses a bill above the cap, a bad currency and half-written fee evidence", async () => {
    const s = await scenario();
    const ins = (total: number, ccy: string, ref: number | null, why: string | null) =>
      adminQuery(
        `insert into public.visit_bills (studio_id, appointment_id, currency, total_cents, created_by_practitioner_id, reference_fee_cents, fee_adjustment_reason)
         values ($1,$2,$3,$4,$5,$6,$7)`,
        [s.studioId, s.appointmentId, ccy, total, s.practitionerId, ref, why],
      );
    await expect(ins(200001, "cad", null, null)).rejects.toThrow(/visit_bills_total_check/);
    await expect(ins(1000, "eur", null, null)).rejects.toThrow(/visit_bills_currency_check/);
    await expect(ins(1000, "cad", 5000, null)).rejects.toThrow(/visit_bills_reference_check/);
  });
});

describe("visit_external_payments", () => {
  it("cash is confirmed on entry; a transfer is pending until confirmed once, or voided; a confirmed payment is final", async () => {
    const s = await scenario();
    const b = await bill(s);
    await expect(external(s, b, "paid_cash", "pending_confirmation", 5000)).rejects.toThrow(/visit_external_payments_cash_check/);
    const cash = await external(s, b, "paid_cash", "confirmed", 5000);
    const row = (await adminQuery(`select state, confirmed_at from public.visit_external_payments where id=$1`, [cash])).rows[0];
    expect(row.state).toBe("confirmed");
    expect(row.confirmed_at).not.toBeNull();

    const transfer = await external(s, b, "paid_other_external", "pending_confirmation", 7500);
    await adminQuery(
      `update public.visit_external_payments set state='confirmed', confirmed_by_practitioner_id=$2 where id=$1`,
      [transfer, s.practitionerId],
    );
    expect((await adminQuery(`select state, confirmed_at is not null as c from public.visit_external_payments where id=$1`, [transfer])).rows[0]).toEqual({ state: "confirmed", c: true });
    // Final: neither a void nor an edit of a confirmed payment.
    await expect(
      adminQuery(`update public.visit_external_payments set state='voided', voided_by_practitioner_id=$2, void_reason='x' where id=$1`, [transfer, s.practitionerId]),
    ).rejects.toThrow(/not allowed/);
    await expect(adminQuery(`update public.visit_external_payments set amount_cents=1 where id=$1`, [transfer])).rejects.toThrow(/never edited/);

    const unpaid = await external(s, b, "paid_e_transfer", "pending_confirmation", 1000);
    await adminQuery(
      `update public.visit_external_payments set state='voided', voided_by_practitioner_id=$2, void_reason='never arrived' where id=$1`,
      [unpaid, s.practitionerId],
    );
    await expect(
      adminQuery(`update public.visit_external_payments set state='confirmed', confirmed_by_practitioner_id=$2 where id=$1`, [unpaid, s.practitionerId]),
    ).rejects.toThrow(/not allowed/);
    await expect(adminQuery(`delete from public.visit_external_payments where id=$1`, [cash])).rejects.toThrow(/never deleted/);
  });

  it("one submission id is one payment, and the amount is bounded", async () => {
    const s = await scenario();
    const b = await bill(s);
    const submission = randomUUID();
    const ins = (cents: number, sub: string) =>
      adminQuery(
        `insert into public.visit_external_payments
           (studio_id, appointment_id, bill_id, method, amount_cents, currency, state, submission_id, recorded_by_practitioner_id, confirmed_by_practitioner_id)
         values ($1,$2,$3,'paid_cash',$4,'cad','confirmed',$5,$6,$6)`,
        [s.studioId, s.appointmentId, b, cents, sub, s.practitionerId],
      );
    await ins(5000, submission);
    await expect(ins(5000, submission)).rejects.toThrow(/visit_external_payments_submission_key|duplicate key/);
    await expect(ins(0, randomUUID())).rejects.toThrow(/amount_check/);
    await expect(ins(200001, randomUUID())).rejects.toThrow(/amount_check/);
  });
});

describe("payment_refunds", () => {
  it("$225 card payment: $40 refund leaves $185; refunds add up to the payment and no further; a failed refund consumes nothing", async () => {
    const s = await scenario();
    const a = await attemptOf(s);
    expect(a.amount_cents).toBe(22500);
    expect(await refundable(a.id, null)).toBe(22500);

    // One refund is in flight per card payment at a time (0393 one-pending index): this one settles before the next is asked for.
    await refund(s, { attemptId: a.id }, 4000, { status: "succeeded" });
    expect(await refundable(a.id, null)).toBe(18500);
    // More than is left: refused by the database.
    await expect(refund(s, { attemptId: a.id }, 18501)).rejects.toThrow(/more than the 18500 cents still refundable/);
    // A failed refund holds nothing back ...
    await refund(s, { attemptId: a.id }, 18500, { status: "failed" });
    expect(await refundable(a.id, null)).toBe(18500);
    // ... so the exact remainder can still be refunded, and then nothing is left.
    await refund(s, { attemptId: a.id }, 18500);
    expect(await refundable(a.id, null)).toBe(0);
    await expect(refund(s, { attemptId: a.id }, 1)).rejects.toThrow(/still refundable/);
  });

  it("two refunds racing for the same remainder: exactly one is recorded", async () => {
    const s = await scenario();
    const a = await attemptOf(s);
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => refund(s, { attemptId: a.id }, 15000)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await refundable(a.id, null)).toBe(7500);
    const total = await adminQuery(`select sum(amount_cents)::int n from public.payment_refunds where attempt_id=$1 and status in ('pending_stripe','succeeded')`, [a.id]);
    expect(total.rows[0].n).toBe(15000);
  });

  it("an external payment is refundable only once confirmed, and the repayment is recorded as succeeded", async () => {
    const s = await scenario();
    const b = await bill(s);
    const pending = await external(s, b, "paid_other_external", "pending_confirmation", 7500);
    expect(await refundable(null, pending)).toBeNull();
    await expect(refund(s, { externalId: pending }, 1000)).rejects.toThrow(/not a settled payment/);
    const cash = await external(s, b, "paid_cash", "confirmed", 5000);
    await refund(s, { externalId: cash }, 2000);
    expect(await refundable(null, cash)).toBe(3000);
    await expect(refund(s, { externalId: cash }, 3001)).rejects.toThrow(/still refundable/);
    // Cash cannot be "pending" or "failed": it was handed back or it was not.
    await expect(refund(s, { externalId: cash }, 100, { status: "pending_stripe" })).rejects.toThrow(/confirmed_check|external_status_check/);
    // Stripe-only evidence cannot ride on an external refund.
    await expect(
      adminQuery(
        `insert into public.payment_refunds (studio_id, appointment_id, external_payment_id, amount_cents, currency, kind, reason, status, submission_id, stripe_refund_id, confirmed_by_practitioner_id)
         values ($1,$2,$3,100,'cad','payment_reversal','x','succeeded',$4,'re_x',$5)`,
        [s.studioId, s.appointmentId, cash, randomUUID(), s.practitionerId],
      ),
    ).rejects.toThrow(/external_stripe_check/);
  });

  it("names exactly one payment, never mixes studios, and a price reduction must name the bill version that records it", async () => {
    const s = await scenario();
    const other = await scenario();
    const a = await attemptOf(s);
    const b = await bill(s);
    const cash = await external(s, b, "paid_cash", "confirmed", 5000);
    await expect(
      adminQuery(
        `insert into public.payment_refunds (studio_id, appointment_id, attempt_id, external_payment_id, amount_cents, currency, kind, reason, status, submission_id, confirmed_by_practitioner_id, confirmed_at)
         values ($1,$2,$3,$4,100,'cad','payment_reversal','x','succeeded',$5,$6,now())`,
        [s.studioId, s.appointmentId, a.id, cash, randomUUID(), s.practitionerId],
      ),
    ).rejects.toThrow(/one_payment_check/);
    // A refund filed under another studio's id for this payment is refused.
    await expect(
      adminQuery(
        `insert into public.payment_refunds (studio_id, appointment_id, attempt_id, amount_cents, currency, kind, reason, status, submission_id)
         values ($1,$2,$3,100,'cad','payment_reversal','x','pending_stripe',$4)`,
        [other.studioId, s.appointmentId, a.id, randomUUID()],
      ),
    ).rejects.toThrow();
    await expect(refund(s, { attemptId: a.id }, 100, { kind: "price_reduction" })).rejects.toThrow(/reduction_check/);
    await refund(s, { attemptId: a.id }, 100, { kind: "price_reduction", reducedBillId: b });
  });

  it("a retried submit (same submission id) cannot create a second refund; a refund is never edited, settled refunds are final, nothing is deleted", async () => {
    const s = await scenario();
    const a = await attemptOf(s);
    const submission = randomUUID();
    const first = await refund(s, { attemptId: a.id }, 1000, { submission });
    await expect(refund(s, { attemptId: a.id }, 1000, { submission })).rejects.toThrow(/payment_refunds_submission_key|duplicate key/);
    const id = first.rows[0].id as string;
    await expect(adminQuery(`update public.payment_refunds set amount_cents=2000 where id=$1`, [id])).rejects.toThrow(/amount is fixed/);
    await expect(adminQuery(`update public.payment_refunds set reason='other' where id=$1`, [id])).rejects.toThrow(/never edited/);
    await adminQuery(`update public.payment_refunds set status='succeeded', stripe_refund_id=$2, platform_fee_returned_cents=5 where id=$1`, [id, `re_test_${randomUUID().slice(0, 8)}`]);
    await expect(adminQuery(`update public.payment_refunds set status='failed' where id=$1`, [id])).rejects.toThrow(/settled refund is final/);
    await expect(adminQuery(`update public.payment_refunds set platform_fee_returned_cents=6 where id=$1`, [id])).rejects.toThrow(/written once/);
    await expect(adminQuery(`delete from public.payment_refunds where id=$1`, [id])).rejects.toThrow(/never deleted/);
    // A fee returned can never exceed the refund it came with.
    const second = await refund(s, { attemptId: a.id }, 100);
    await expect(adminQuery(`update public.payment_refunds set platform_fee_returned_cents=101 where id=$1`, [second.rows[0].id])).rejects.toThrow(/payment_refunds_fee_check/);
  });
});

describe("the legacy single refund", () => {
  it("is mirrored into one row while the older code still writes the attempt's refund columns, and it counts against the cap", async () => {
    const s = await scenario();
    const a = await attemptOf(s);
    // The older code: full refund claimed, then settled.
    await adminQuery(`update public.payment_charge_attempts set refund_status='pending_stripe', refund_amount_cents=amount_cents, refund_idempotency_key=$2 where id=$1`, [a.id, `hone:payment_refund:${a.id}`]);
    let rows = (await adminQuery(`select amount_cents, status, legacy, kind from public.payment_refunds where attempt_id=$1`, [a.id])).rows;
    expect(rows).toEqual([{ amount_cents: 22500, status: "pending_stripe", legacy: true, kind: "payment_reversal" }]);
    await adminQuery(`update public.payment_charge_attempts set refund_status='succeeded', stripe_refund_id=$2, refunded_at=now() where id=$1`, [a.id, `re_test_${randomUUID().slice(0, 8)}`]);
    rows = (await adminQuery(`select amount_cents, status, legacy from public.payment_refunds where attempt_id=$1`, [a.id])).rows;
    expect(rows).toEqual([{ amount_cents: 22500, status: "succeeded", legacy: true }]);
    expect(await refundable(a.id, null)).toBe(0);
    await expect(refund(s, { attemptId: a.id }, 1)).rejects.toThrow(/still refundable/);
    // A legacy row is written only by the mirror.
    await expect(adminQuery(`update public.payment_refunds set status='failed' where attempt_id=$1`, [a.id])).rejects.toThrow(/written only by the mirror/);
  });

  it("a legacy refund that failed frees the amount; a later partial refund then a (legacy) full claim is refused by the cap", async () => {
    const s = await scenario();
    const a = await attemptOf(s);
    await adminQuery(`update public.payment_charge_attempts set refund_status='pending_stripe', refund_amount_cents=amount_cents where id=$1`, [a.id]);
    await adminQuery(`update public.payment_charge_attempts set refund_status='failed' where id=$1`, [a.id]);
    expect(await refundable(a.id, null)).toBe(22500);
    await refund(s, { attemptId: a.id }, 4000);
    // The older code now tries a FULL refund of an attempt that already has a partial one: the cap refuses the mirror,
    // and with it the legacy write (the money was never asked for twice).
    await expect(
      adminQuery(`update public.payment_charge_attempts set refund_status='pending_stripe', refund_amount_cents=amount_cents where id=$1`, [a.id]),
    ).rejects.toThrow(/still refundable/);
  });

  it("an attempt that is not a settled payment cannot be refunded", async () => {
    const s = await scenario({ attempt: "failed" });
    const a = await attemptOf(s);
    expect(await refundable(a.id, null)).toBeNull();
    await expect(refund(s, { attemptId: a.id }, 100)).rejects.toThrow(/not a settled payment/);
  });
});
