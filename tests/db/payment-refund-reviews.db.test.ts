import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { adminQuery, asRole, asUser, closePool, resolveLocalDbUrl, seedMember } from "./helpers/harness";
import { cleanupPaymentScenario, seedQuickCheckoutScenario, type PaymentScenario } from "./helpers/payment-seed";

// v1 refund truth (r4): one definition of money returned per payment, and the review of a refund Stripe reports that Hone did not make.
// Synthetic values only. Each block names the failure it closes.

type Row = Record<string, unknown>;
type Q = (t: string, p?: unknown[]) => Promise<{ rows: Row[] }>;
const created: string[] = [];
async function visit(): Promise<PaymentScenario> {
  const s = await seedQuickCheckoutScenario({ appointmentStatus: "completed", withSession: true, attempt: "none", bookedService: { name: "Synthetic service", priceCents: 22500 } });
  created.push(s.studioId);
  await adminQuery(`update public.platform_rollouts set mode = 'pilot' where key = 'split_payments' and mode = 'off'`);
  await adminQuery(`insert into public.platform_rollout_studios (rollout_key, studio_id) values ('split_payments', $1) on conflict do nothing`, [s.studioId]);
  return s;
}
afterAll(async () => {
  for (const id of created) {
    await adminQuery(`alter table public.payment_refund_reviews disable trigger payment_refund_reviews_guard_trg`).catch(() => undefined);
    await adminQuery(`alter table public.payment_refunds disable trigger payment_refunds_guard_trg`).catch(() => undefined);
    await adminQuery(`delete from public.payment_refund_reviews where studio_id = $1`, [id]).catch(() => undefined);
    await adminQuery(`delete from public.payment_refunds where studio_id = $1`, [id]).catch(() => undefined);
    await adminQuery(`alter table public.payment_refund_reviews enable trigger payment_refund_reviews_guard_trg`).catch(() => undefined);
    await adminQuery(`alter table public.payment_refunds enable trigger payment_refunds_guard_trg`).catch(() => undefined);
    await cleanupPaymentScenario(id).catch(() => undefined);
  }
  await adminQuery(`delete from public.platform_rollout_studios where rollout_key = 'split_payments' and studio_id = any($1::uuid[])`, [created]).catch(() => undefined);
  await closePool();
});

let seq = 0;
const tok = () => `${Date.now().toString(36)}${(seq++).toString(36)}${randomUUID().replace(/-/g, "").slice(0, 8)}`;
const owner = <T,>(s: PaymentScenario, fn: (q: Q) => Promise<T>) => asUser(s.practitionerUserId, fn);
const ensure = (s: PaymentScenario) => owner(s, (q) => q(`select * from public.ensure_visit_bill($1,$2,null,null,false)`, [s.studioId, s.appointmentId])).then((r) => r.rows[0]);
const cardRow = (s: PaymentScenario, cents: number) =>
  adminQuery(
    `insert into public.payment_charge_attempts
       (studio_id, charge_reason, client_id, session_id, appointment_id, created_by_practitioner_id, amount_cents, currency, status, stripe_livemode,
        client_payment_method_id, card_authorization_signature_id, stripe_payment_intent_id, stripe_charge_id, charged_at, submission_id)
     select $1,'session_payment',$2,$3,$4,$5,$6,'cad','succeeded',false,
        (select id from public.client_payment_methods where client_id=$2 and studio_id=$1 limit 1),
        (select id from public.client_consent_signatures where client_id=$2 and studio_id=$1 order by template_version desc limit 1),
        $7,$8,now(),$9 returning id`,
    [s.studioId, s.clientId, s.sessionId, s.appointmentId, s.practitionerId, cents, `pi_test_${tok()}`, `ch_test_${tok()}`, randomUUID()],
  ).then((r) => r.rows[0].id as string);
const refund = (s: PaymentScenario, attempt: string, cents: number) =>
  owner(s, (q) => q(`select * from public.request_payment_refund($1,$2,$3,null,$4,'payment_reversal','synthetic',$5)`, [s.studioId, s.appointmentId, attempt, cents, randomUUID()])).then((r) => r.rows[0]);
const settle = (refundId: string) => adminQuery(`select * from public.finish_payment_refund($1,'succeeded',$2,'succeeded',null,null,null)`, [refundId, `re_${tok()}`]);
const money = async (attempt: string) => (await adminQuery(`select * from public.payment_refund_money($1,null)`, [attempt])).rows[0] as { payment_cents: number; succeeded_cents: number; reserved_cents: number };
const refundable = async (attempt: string) => (await adminQuery(`select public.payment_refundable_cents($1,null) n`, [attempt])).rows[0].n as number;
const position = (s: PaymentScenario) => owner(s, (q) => q(`select * from public.get_visit_payment_position($1,$2)`, [s.studioId, s.appointmentId])).then((r) => r.rows[0]);
/** Exactly what 0240 writes to the attempt when a cumulative full charge.refunded is accepted. */
const dashboardFull = (attempt: string) =>
  adminQuery(`update public.payment_charge_attempts set refund_status='succeeded', refund_amount_cents=amount_cents, stripe_refund_id=$2, stripe_refund_status='succeeded', stripe_refund_event_id=$3, stripe_refund_event_created=extract(epoch from now())::bigint where id=$1`, [attempt, `re_${tok()}`, `evt_${tok()}`]);
const flag = async (a: string, o: { refund?: string; status?: string; cents?: number; ccy?: string; reason?: string; hone?: string | null; event?: string } = {}) =>
  (await adminQuery(`select * from public.flag_payment_refund_review($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [a, o.refund ?? `re_${tok()}`, o.status ?? "succeeded", o.cents ?? 3000, o.ccy ?? "cad", o.event ?? `evt_${tok()}`, 1700000000, o.reason ?? "partial_dashboard_refund", o.hone ?? null])).rows[0] as { result: string; review_id: string | null };
const reviews = async (a: string) => (await adminQuery(`select * from public.payment_refund_reviews where attempt_id=$1 order by opened_at`, [a])).rows;
const resolve = (s: PaymentScenario, id: string, userId = s.practitionerUserId) => asUser(userId, (q) => q(`select * from public.resolve_payment_refund_review($1)`, [id])).then((r) => r.rows[0]?.result as string | undefined);
async function billed(cents = 10000) {
  const s = await visit();
  await ensure(s);
  const a = await cardRow(s, cents);
  return { s, a };
}

describe("G1 one definition of money returned (the attempt's own aggregate and the itemised rows are the same money)", () => {
  it("$100 payment: Hone refunds $40, the owner refunds the rest in the Stripe dashboard (cumulative full): returned is $100, not $40; position agrees", async () => {
    const { s, a } = await billed(10000);
    const r = await refund(s, a, 4000);
    expect(r.result).toBe("requested");
    await settle(r.refund_id as string);
    expect(await money(a)).toMatchObject({ payment_cents: 10000, succeeded_cents: 4000, reserved_cents: 0 });
    await dashboardFull(a);
    expect(await money(a)).toMatchObject({ succeeded_cents: 10000, reserved_cents: 0 });
    expect(await refundable(a)).toBe(0);
    expect((await position(s)).refunded_cents).toBe(10000);
    expect((await refund(s, a, 1)).result).toBe("exceeds_refundable");
  });

  it("an attempt-level pending whole-payment refund reserves the capacity: a split request is refused", async () => {
    const { s, a } = await billed(10000);
    await adminQuery(`update public.payment_charge_attempts set refund_status='pending_stripe', refund_amount_cents=amount_cents where id=$1`, [a]);
    expect(await money(a)).toMatchObject({ succeeded_cents: 0, reserved_cents: 10000 });
    expect(await refundable(a)).toBe(0);
    expect((await refund(s, a, 1000)).result).toBe("exceeds_refundable");
  });

  it("G2: the helper never reads a partial attempt-level 'succeeded' as full, it takes the greater honestly; production must hold none (pre-seal count query)", async () => {
    const { a } = await billed(10000);
    // This state must NOT occur in production (0078/0240 write full amounts only); the database does not forbid it, so the pre-seal check is the count below.
    await adminQuery(`update public.payment_charge_attempts set refund_status='succeeded', refund_amount_cents=3000 where id=$1`, [a]);
    expect((await money(a)).succeeded_cents).toBe(3000);
    const bad = await adminQuery(`select count(*)::int n from public.payment_charge_attempts where refund_status='succeeded' and coalesce(refund_amount_cents, amount_cents) <> amount_cents and id = $1`, [a]);
    expect(bad.rows[0].n, "the pre-seal query counts this attempt, so production data with such a row would block the seal").toBe(1);
  });
});

describe("flag_payment_refund_review: known vs unknown", () => {
  it("an unknown partial dashboard refund opens ONE review, freezes refundable at 0 and writes an operator-only alert with no studio, client or visit", async () => {
    const { s, a } = await billed();
    const f = await flag(a, { cents: 3000 });
    expect(f.result).toBe("flagged");
    expect((await reviews(a))).toHaveLength(1);
    expect(await refundable(a)).toBe(0);
    expect((await refund(s, a, 100)).result).toBe("review_open");
    expect((await position(s)).review_open).toBe(true);
    const alert = (await adminQuery(`select studio_id, client_id, appointment_id, route, resolution_note, event, message, safe_details from public.ops_alerts where safe_details->>'review_id' = $1`, [f.review_id])).rows[0];
    expect(alert).toMatchObject({ studio_id: null, client_id: null, appointment_id: null, route: "/api/stripe/webhook", resolution_note: null, event: "payment_refund_review_opened" });
    expect(Object.keys(alert.safe_details as object).sort()).toEqual(["amount_cents", "attempt_id", "currency", "reason_code", "review_id", "stripe_refund_id"]);
  });

  it("a replay is already_flagged and opens nothing new; a newer succeeded event updates the stored status", async () => {
    const { a } = await billed();
    const id = `re_${tok()}`;
    expect((await flag(a, { refund: id, status: "pending" })).result).toBe("flagged");
    expect((await flag(a, { refund: id, status: "pending" })).result).toBe("already_flagged");
    expect((await flag(a, { refund: id, status: "succeeded" })).result).toBe("already_flagged");
    const rows = await reviews(a);
    expect(rows).toHaveLength(1);
    expect(rows[0].stripe_refund_status).toBe("succeeded");
  });

  it("a refund already in the ledger (by Stripe id) or on the attempt is KNOWN and flags nothing", async () => {
    const { s, a } = await billed();
    const r = await refund(s, a, 4000);
    const id = `re_${tok()}`;
    await adminQuery(`select * from public.finish_payment_refund($1,'succeeded',$2,'succeeded',null,null,null)`, [r.refund_id, id]);
    expect((await flag(a, { refund: id, cents: 4000 })).result).toBe("known");
    expect(await reviews(a)).toHaveLength(0);
  });

  it("the strict metadata locator makes a PENDING Hone row known; an equal amount alone does NOT (pending Hone $40 + dashboard $40 is flagged)", async () => {
    const { s, a } = await billed();
    const r = await refund(s, a, 4000);
    expect((await flag(a, { cents: 4000, hone: r.refund_id as string })).result).toBe("known");
    expect((await flag(a, { cents: 3999, hone: r.refund_id as string })).result).toBe("flagged"); // locator with a different amount is not the same refund
    expect(await reviews(a)).toHaveLength(1);
    const { s: s2, a: a2 } = await billed();
    await refund(s2, a2, 4000);
    expect((await flag(a2, { cents: 4000 })).result).toBe("flagged"); // no locator: a $40 dashboard refund beside a pending Hone $40
  });

  it("a locator naming another attempt's row, or a settled row, is not a match", async () => {
    const { s, a } = await billed();
    const { s: s2, a: a2 } = await billed();
    const r2 = await refund(s2, a2, 4000);
    expect((await flag(a, { cents: 4000, hone: r2.refund_id as string })).result).toBe("flagged");
    await settle(r2.refund_id as string);
    expect((await flag(a2, { cents: 4000, hone: r2.refund_id as string })).result).toBe("flagged");
    void s;
  });

  it("closed no-row codes: not_billed (legacy visit), unknown_payment, billed (incomplete list / refused evidence), covered, ignored (failed), invalid_input", async () => {
    const { s, a } = await billed();
    expect((await flag(a, { reason: "list_incomplete" })).result).toBe("billed");
    expect((await flag(a, { reason: "refund_evidence_refused" })).result).toBe("billed");
    expect((await flag(a, { status: "failed" })).result).toBe("ignored");
    expect((await flag(a, { ccy: "usd" })).result).toBe("unknown_payment");
    expect((await flag(a, { cents: 10001 })).result).toBe("unknown_payment");
    expect((await flag(randomUUID())).result).toBe("unknown_payment");
    expect((await flag(a, { reason: "free text reason" })).result).toBe("invalid_input");
    expect((await flag(a, { refund: "re_bad id" })).result).toBe("invalid_input");
    expect((await flag(a, { event: "not-an-event" })).result).toBe("invalid_input");
    expect(await reviews(a)).toHaveLength(0);
    await dashboardFull(a);
    expect((await flag(a, { cents: 3000 })).result).toBe("covered");
    expect(await reviews(a)).toHaveLength(0);
    // a legacy visit (no bill): the older path and its alert stay as they are
    const legacy = await visit();
    const la = await adminQuery(
      `insert into public.payment_charge_attempts (studio_id, charge_reason, client_id, session_id, appointment_id, created_by_practitioner_id, amount_cents, currency, status, stripe_livemode,
         client_payment_method_id, card_authorization_signature_id, stripe_payment_intent_id, stripe_charge_id, charged_at)
       select $1,'session_payment',$2,$3,$4,$5,5000,'cad','succeeded',false,
         (select id from public.client_payment_methods where client_id=$2 and studio_id=$1 limit 1),
         (select id from public.client_consent_signatures where client_id=$2 and studio_id=$1 order by template_version desc limit 1), $6,$7,now() returning id`,
      [legacy.studioId, legacy.clientId, legacy.sessionId, legacy.appointmentId, legacy.practitionerId, `pi_test_${tok()}`, `ch_test_${tok()}`]);
    expect((await flag(la.rows[0].id as string, { cents: 1000 })).result).toBe("not_billed");
    void s;
  });

  it("a later failed or canceled event auto-closes the review (auto_failed / auto_canceled) and frees the capacity", async () => {
    const { a } = await billed();
    const id = `re_${tok()}`;
    await flag(a, { refund: id, status: "pending" });
    expect(await refundable(a)).toBe(0);
    const f = await adminQuery(`select * from public.flag_payment_refund_review($1,$2,'failed',3000,'cad',$3,1700000100,'partial_dashboard_refund',null)`, [a, id, `evt_${tok()}`]);
    expect(f.rows[0].result).toBe("auto_closed");
    expect((await reviews(a))[0]).toMatchObject({ closed_code: "auto_failed", resolved_by_practitioner_id: null });
    expect(await refundable(a)).toBe(10000);
    const id2 = `re_${tok()}`;
    await flag(a, { refund: id2, status: "pending" });
    await adminQuery(`select * from public.flag_payment_refund_review($1,$2,'canceled',3000,'cad',$3,1700000100,'partial_dashboard_refund',null)`, [a, id2, `evt_${tok()}`]);
    expect((await reviews(a)).map((r) => r.closed_code).sort()).toEqual(["auto_canceled", "auto_failed"]);
  });

  it("an older event cannot overwrite a newer one on an open review", async () => {
    const { a } = await billed();
    const id = `re_${tok()}`;
    await flag(a, { refund: id, status: "succeeded" });
    await adminQuery(`select * from public.flag_payment_refund_review($1,$2,'pending',3000,'cad',$3,1600000000,'partial_dashboard_refund',null)`, [a, id, `evt_${tok()}`]);
    expect((await reviews(a))[0].stripe_refund_status).toBe("succeeded");
  });
});

describe("H3 a cumulative full refund closes the reviews it covers", () => {
  it("owner $30 in the dashboard is flagged, then $70 more: 0240 writes succeeded/100, the review closes auto_recorded, returned $100, refundable 0, no observed row", async () => {
    const { s, a } = await billed(10000);
    expect((await flag(a, { cents: 3000 })).result).toBe("flagged");
    await dashboardFull(a);
    const rv = (await reviews(a))[0];
    expect(rv).toMatchObject({ closed_code: "auto_recorded", resolved_by_practitioner_id: null });
    expect(rv.resolved_at).not.toBeNull();
    expect(await refundable(a)).toBe(0);
    expect((await money(a)).succeeded_cents).toBe(10000);
    expect((await position(s)).review_open).toBe(false);
    expect((await adminQuery(`select count(*)::int n from public.payment_refunds where attempt_id=$1 and source='stripe_dashboard'`, [a])).rows[0].n).toBe(0);
  });

  it("the cover trigger closes only OPEN reviews of THIS attempt, once", async () => {
    const { a } = await billed();
    const { a: other } = await billed();
    await flag(a, { cents: 1000 });
    await flag(other, { cents: 1000 });
    await dashboardFull(a);
    await dashboardFull(a); // a replay
    expect((await reviews(a))[0].closed_code).toBe("auto_recorded");
    expect((await reviews(other))[0].closed_code).toBeNull();
  });
});

describe("resolve_payment_refund_review: the owner acknowledges, no amount, once", () => {
  it("resolved: ONE observed ledger row (source stripe_dashboard) with Stripe's amount, review closed acknowledged by the owner; returned and position agree; a second call changes nothing", async () => {
    const { s, a } = await billed(10000);
    const f = await flag(a, { cents: 3000 });
    expect(await resolve(s, f.review_id as string)).toBe("resolved");
    const rows = (await adminQuery(`select amount_cents, source, kind, status, stripe_refund_id, legacy, reason from public.payment_refunds where attempt_id=$1`, [a])).rows;
    // Privacy: the reason of an observed row is EXACTLY the fixed Hone sentence (equality, not a pattern).
    expect(rows.map((r) => r.reason)).toEqual(["Refunded in the Stripe dashboard"]);
    expect(rows).toEqual([expect.objectContaining({ amount_cents: 3000, source: "stripe_dashboard", kind: "payment_reversal", status: "succeeded", legacy: false })]);
    expect(rows[0].stripe_refund_id).toBe((await reviews(a))[0].stripe_refund_id);
    expect((await reviews(a))[0]).toMatchObject({ closed_code: "acknowledged" });
    expect((await reviews(a))[0].resolved_by_practitioner_id).not.toBeNull();
    expect(await refundable(a)).toBe(7000);
    expect((await position(s)).refunded_cents).toBe(3000);
    expect(await resolve(s, f.review_id as string)).toBe("already_resolved");
    expect((await adminQuery(`select count(*)::int n from public.payment_refunds where attempt_id=$1`, [a])).rows[0].n).toBe(1);
  });

  it("not_settled while Stripe still reports pending; refund_pending while a Hone refund is in flight (none is failed to make room)", async () => {
    const { s, a } = await billed(10000);
    const f = await flag(a, { cents: 3000, status: "pending" });
    expect(await resolve(s, f.review_id as string)).toBe("not_settled");
    await adminQuery(`select * from public.flag_payment_refund_review($1,$2,'succeeded',3000,'cad',$3,1700000100,'partial_dashboard_refund',null)`, [a, (await reviews(a))[0].stripe_refund_id, `evt_${tok()}`]);
    const r = await refund({ ...s }, a, 1000).catch(() => undefined); // frozen by the open review: refused
    expect(r?.result).toBe("review_open");
    // a Hone refund started BEFORE the review is the in-flight one
    const { s: s2, a: a2 } = await billed(10000);
    const hr = await refund(s2, a2, 2000);
    const f2 = await flag(a2, { cents: 3000 });
    expect(f2.result).toBe("flagged");
    expect(await resolve(s2, f2.review_id as string)).toBe("refund_pending");
    expect((await adminQuery(`select status from public.payment_refunds where id=$1`, [hr.refund_id])).rows[0].status).toBe("pending_stripe");
  });

  it("over_capacity is left open: succeeded + reserved + the review amount above the payment", async () => {
    const { s, a } = await billed(10000);
    const r = await refund(s, a, 8000);
    await settle(r.refund_id as string);
    const f = await flag(a, { cents: 3000 });
    expect(await resolve(s, f.review_id as string)).toBe("over_capacity");
    expect((await reviews(a))[0].resolved_at).toBeNull();
  });

  it("already_covered when the whole payment came back first; the review closes auto_recorded without a ledger row", async () => {
    const { s, a } = await billed(10000);
    const f = await flag(a, { cents: 3000 });
    await adminQuery(`alter table public.payment_charge_attempts disable trigger payment_refund_reviews_cover_trg`);
    try { await dashboardFull(a); } finally { await adminQuery(`alter table public.payment_charge_attempts enable trigger payment_refund_reviews_cover_trg`); }
    expect(await resolve(s, f.review_id as string)).toBe("already_covered");
    expect((await reviews(a))[0].closed_code).toBe("auto_recorded");
  });

  it("not_found for a colleague, a stranger, anon and a missing id (indistinguishable); nothing is written", async () => {
    const { s, a } = await billed(10000);
    const f = await flag(a, { cents: 3000 });
    const mate = await seedMember({ studioId: s.studioId } as never, "colleague");
    const other = await visit();
    expect(await resolve(s, f.review_id as string, mate.userId)).toBe("not_found");
    expect(await resolve(s, f.review_id as string, other.practitionerUserId)).toBe("not_found");
    expect(await resolve(s, randomUUID())).toBe("not_found");
    await expect(asRole("anon", (q) => q(`select * from public.resolve_payment_refund_review($1)`, [f.review_id]))).rejects.toThrow(/permission denied/);
    expect((await reviews(a))[0].resolved_at).toBeNull();
    expect((await adminQuery(`select count(*)::int n from public.payment_refunds where attempt_id=$1`, [a])).rows[0].n).toBe(0);
  });
});

describe("the review table: closed fields, owner-only, append-only, grants", () => {
  it("reads: the owner sees the review; a colleague, a stranger and anon read zero rows; nobody can write or delete", async () => {
    const { s, a } = await billed();
    const f = await flag(a, { cents: 3000 });
    const mate = await seedMember({ studioId: s.studioId } as never, "colleague");
    const other = await visit();
    expect((await owner(s, (q) => q(`select id from public.payment_refund_reviews where id=$1`, [f.review_id]))).rows).toHaveLength(1);
    expect((await asUser(mate.userId, (q) => q(`select id from public.payment_refund_reviews where id=$1`, [f.review_id]))).rows).toHaveLength(0);
    expect((await asUser(other.practitionerUserId, (q) => q(`select id from public.payment_refund_reviews where id=$1`, [f.review_id]))).rows).toHaveLength(0);
    await expect(asRole("anon", (q) => q(`select id from public.payment_refund_reviews`))).rejects.toThrow(/permission denied/);
    await expect(owner(s, (q) => q(`update public.payment_refund_reviews set closed_code='acknowledged' where id=$1`, [f.review_id]))).rejects.toThrow(/permission denied/);
    await expect(owner(s, (q) => q(`delete from public.payment_refund_reviews where id=$1`, [f.review_id]))).rejects.toThrow(/permission denied/);
    await expect(adminQuery(`delete from public.payment_refund_reviews where id=$1`, [f.review_id])).rejects.toThrow(/never deleted/);
    await expect(adminQuery(`update public.payment_refund_reviews set amount_cents = 1 where id=$1`, [f.review_id])).rejects.toThrow(/never edited/);
  });

  it("closed fields: only the allowed reason codes, ids and statuses can be stored; a closed review is final", async () => {
    const { a } = await billed();
    const f = await flag(a, { cents: 3000 });
    const ins = (over: Record<string, string>) =>
      adminQuery(`insert into public.payment_refund_reviews (studio_id, attempt_id, appointment_id, stripe_refund_id, stripe_refund_status, amount_cents, currency, stripe_event_id, stripe_event_created, reason_code)
        select studio_id, attempt_id, appointment_id, $2, 'succeeded', 100, 'cad', $3, 1, $4 from public.payment_refund_reviews where id = $1`, [f.review_id, over.refund ?? `re_${tok()}`, over.event ?? `evt_${tok()}`, over.reason ?? "partial_dashboard_refund"]);
    await expect(ins({ reason: "note: client said so" })).rejects.toThrow(/reason_check/);
    await expect(ins({ refund: "re_ bad" })).rejects.toThrow(/refund_id_check/);
    await expect(ins({ event: "x" })).rejects.toThrow(/event_id_check/);
    await adminQuery(`update public.payment_refund_reviews set resolved_at=now(), closed_code='auto_failed' where id=$1`, [f.review_id]);
    await expect(adminQuery(`update public.payment_refund_reviews set stripe_refund_status='pending' where id=$1`, [f.review_id])).rejects.toThrow(/final/);
  });

  it("grants: flag and record_refund_sent service_role only; resolve and the batch read authenticated only; nothing for anon or public", async () => {
    const can = async (role: string, fn: string) => (await adminQuery(`select has_function_privilege($1, $2, 'execute') ok`, [role, fn])).rows[0].ok as boolean;
    const flagFn = "public.flag_payment_refund_review(uuid,text,text,integer,text,text,bigint,text,text)";
    const sentFn = "public.record_refund_sent(uuid,text)";
    const resolveFn = "public.resolve_payment_refund_review(uuid)";
    const batchFn = "public.get_visit_payment_positions(uuid,uuid[])";
    expect([await can("service_role", flagFn), await can("authenticated", flagFn), await can("anon", flagFn)]).toEqual([true, false, false]);
    expect([await can("service_role", sentFn), await can("authenticated", sentFn), await can("anon", sentFn)]).toEqual([true, false, false]);
    expect([await can("authenticated", resolveFn), await can("service_role", resolveFn), await can("anon", resolveFn)]).toEqual([true, false, false]);
    expect([await can("authenticated", batchFn), await can("service_role", batchFn), await can("anon", batchFn)]).toEqual([true, false, false]);
    for (const fn of ["public.payment_refund_money(uuid,uuid)", "public.payment_refund_reviews_guard()", "public.payment_refund_reviews_cover()"]) {
      expect([await can("authenticated", fn), await can("service_role", fn), await can("anon", fn)], fn).toEqual([false, false, false]);
    }
    const sd = await adminQuery(`select p.proname, p.prosecdef, p.proconfig::text cfg from pg_proc p where p.pronamespace='public'::regnamespace and p.proname in ('flag_payment_refund_review','resolve_payment_refund_review','get_visit_payment_positions','record_refund_sent','payment_refund_reviews_cover')`);
    expect(sd.rows).toHaveLength(5);
    for (const r of sd.rows) { expect(r.prosecdef, String(r.proname)).toBe(true); expect(r.cfg, String(r.proname)).toContain("search_path=pg_catalog, pg_temp"); }
  });

  it("the batch read: owner only, returns review_open per visit, at most 200 ids", async () => {
    const { s, a } = await billed();
    await flag(a, { cents: 3000 });
    const rows = (await owner(s, (q) => q(`select * from public.get_visit_payment_positions($1,$2::uuid[])`, [s.studioId, [s.appointmentId, randomUUID()]]))).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ appointment_id: s.appointmentId, review_open: true });
    const mate = await seedMember({ studioId: s.studioId } as never, "colleague");
    expect((await asUser(mate.userId, (q) => q(`select * from public.get_visit_payment_positions($1,$2::uuid[])`, [s.studioId, [s.appointmentId]]))).rows).toHaveLength(0);
    await expect(owner(s, (q) => q(`select * from public.get_visit_payment_positions($1,$2::uuid[])`, [s.studioId, Array.from({ length: 201 }, () => randomUUID())]))).rejects.toThrow(/at most 200/);
  });

  it("record_refund_sent stores the Stripe id once; a different id conflicts; a second pending refund on one attempt is refused by the index", async () => {
    const { s, a } = await billed();
    const r = await refund(s, a, 2000);
    const id = `re_${tok()}`;
    expect((await adminQuery(`select * from public.record_refund_sent($1,$2)`, [r.refund_id, id])).rows[0].result).toBe("recorded");
    expect((await adminQuery(`select * from public.record_refund_sent($1,$2)`, [r.refund_id, id])).rows[0].result).toBe("already_recorded");
    expect((await adminQuery(`select * from public.record_refund_sent($1,$2)`, [r.refund_id, `re_${tok()}`])).rows[0].result).toBe("conflict");
    expect((await adminQuery(`select * from public.record_refund_sent($1,'bad')`, [r.refund_id])).rows[0].result).toBe("invalid_input");
    await expect(refund(s, a, 1000)).rejects.toThrow(/one_pending_per_attempt/);
  });
});

describe("deterministic lock tests (the two paths that used to be probabilistic)", () => {
  async function withVisitLock<T>(appointmentId: string, fn: () => Promise<T>): Promise<{ blockedWhileHeld: boolean; result: T }> {
    const holder = new Client({ connectionString: resolveLocalDbUrl() });
    await holder.connect();
    try {
      await holder.query("begin");
      await holder.query("select pg_advisory_xact_lock(public.appointment_settlement_lock_key($1))", [appointmentId]);
      let done = false;
      const p = fn().then((v) => { done = true; return v; });
      await new Promise((r) => setTimeout(r, 800));
      const blockedWhileHeld = !done;
      await holder.query("commit");
      return { blockedWhileHeld, result: await p };
    } finally {
      await holder.query("rollback").catch(() => undefined);
      await holder.end();
    }
  }

  it("flag takes the visit lock first: it waits for whoever holds it and then decides", async () => {
    const { a, s } = await billed();
    const out = await withVisitLock(s.appointmentId, () => flag(a, { cents: 3000 }));
    expect(out.blockedWhileHeld).toBe(true);
    expect(out.result.result).toBe("flagged");
  });

  it("resolve takes the visit lock first, and a Hone refund requested under the lock is seen by it (refund_pending), never overtaken", async () => {
    const { a, s } = await billed(10000);
    const f = await flag(a, { cents: 3000 });
    // the review freezes new requests, so put the pending Hone row in BEFORE the review exists instead: drive the race on a second payment
    const { a: a2, s: s2 } = await billed(10000);
    const hr = await refund(s2, a2, 2000);
    const f2 = await flag(a2, { cents: 3000 });
    const out = await withVisitLock(s2.appointmentId, () => resolve(s2, f2.review_id as string));
    expect(out.blockedWhileHeld).toBe(true);
    expect(out.result).toBe("refund_pending");
    expect((await adminQuery(`select status from public.payment_refunds where id=$1`, [hr.refund_id])).rows[0].status).toBe("pending_stripe");
    expect(await resolve(s, f.review_id as string)).toBe("resolved");
  });

  it("a flag and a cumulative full refund landing together end consistent in either order: no open review on a fully refunded payment", async () => {
    for (let i = 0; i < 4; i++) {
      const { a } = await billed(10000);
      await Promise.allSettled([flag(a, { cents: 3000 }), dashboardFull(a)]);
      const open = (await reviews(a)).filter((r) => r.resolved_at === null);
      expect(open, `round ${i}`).toHaveLength(0);
    }
  });
});
