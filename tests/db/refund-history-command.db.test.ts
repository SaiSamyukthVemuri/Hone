import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { adminQuery, asRole, asUser, closePool } from "./helpers/harness";
import { cleanupPaymentScenario, seedEligibleQuickCheckoutScenario, type PaymentScenario } from "./helpers/payment-seed";

// HON-49 / 0358: the BEHAVIOURAL half of the refund-history command. The static half is tests/migrations/0358-payment-charge-refund-history.test.ts.
// WRITTEN, NOT YET RUN: it needs a local stack carrying 0358 (one fresh reset on the production-equivalent base, under an OPS GRANT, with the
// run-scoped E2E_SUPABASE_URL + HONE_LOCAL_DB_URL pair). Synthetic rows only; no provider call.

const created: string[] = [];
afterAll(async () => {
  for (const studioId of created) await cleanupPaymentScenario(studioId).catch(() => undefined);
  await closePool();
});

type Prepared = Awaited<ReturnType<typeof prepared>>;
// A succeeded card charge bound to original provider identity (the same setup the 0239 / 0240 tests use).
async function prepared() {
  const s: PaymentScenario = await seedEligibleQuickCheckoutScenario({ attempt: "ready" });
  created.push(s.studioId);
  const pi = `pi_hist_${randomUUID()}`;
  await adminQuery(`update public.payment_charge_attempts a
    set stripe_account_id=m.stripe_account_id, stripe_customer_id=m.stripe_customer_id, stripe_payment_intent_id=$2
    from public.client_payment_methods m where a.studio_id=$1 and m.id=a.client_payment_method_id`, [s.studioId, pi]);
  const row = (await adminQuery(`select * from public.payment_charge_attempts where studio_id=$1`, [s.studioId])).rows[0];
  const charge = `ch_hist_${randomUUID()}`;
  const ok = await adminQuery(`select * from public.reconcile_bound_payment_event($1,$2,'payment_intent.succeeded',$3,$4,$5,$6::jsonb)`, [
    row.id, `evt_pi_${randomUUID()}`, row.studio_id, row.stripe_account_id, row.stripe_livemode,
    JSON.stringify({ customer_id: row.stripe_customer_id, payment_intent_id: pi, charge_id: charge, amount_cents: row.amount_cents,
      currency: row.currency, evidence_kind: "signed_event", event_created: 100 })]);
  expect(ok.rows[0].result).toBe("reconciled");
  return { s, row, pi, charge };
}

const AUTH = "signed_event_with_authenticated_list";
type Comp = { id: string; amount: number; status?: string };
function evidence(p: Prepared, comps: Comp[], over: Record<string, unknown> = {}) {
  const succeeded = comps.filter((c) => (c.status ?? "succeeded") === "succeeded").reduce((n, c) => n + c.amount, 0);
  return {
    customer_id: p.row.stripe_customer_id, payment_intent_id: p.pi, charge_id: p.charge, amount_cents: p.row.amount_cents, currency: p.row.currency,
    event_created: 1000, evidence_kind: "signed_event", charge_amount_refunded: succeeded, charge_refund_list_complete: true,
    components: comps.map((c) => ({ refund_id: c.id, amount_cents: c.amount, currency: p.row.currency, refund_status: c.status ?? "succeeded",
      charge_id: p.charge, payment_intent_id: p.pi })),
    ...over,
  };
}
async function record(p: Prepared, object: Record<string, unknown>, o: { eventId?: string; type?: string; studio?: string; account?: string; mode?: boolean } = {}) {
  const r = await adminQuery(`select * from public.record_charge_refund_history($1,$2,$3,$4,$5,$6,$7::jsonb)`, [
    p.row.id, o.eventId ?? `evt_${randomUUID()}`, o.type ?? "charge.refunded", o.studio ?? p.row.studio_id,
    o.account ?? p.row.stripe_account_id, o.mode ?? p.row.stripe_livemode, JSON.stringify(object)]);
  return r.rows[0] as { result: string; out_succeeded_cents: number | null; out_inflight_count: number | null };
}
const summary = async (p: Prepared) => (await adminQuery(
  `select refunds_succeeded_cents s, refunds_inflight_count f, refund_history_event_id e from public.payment_charge_attempts where id=$1`, [p.row.id])).rows[0];
const rows = async (p: Prepared) => (await adminQuery(
  `select stripe_refund_id id, amount_cents a, status, evidence_kind k from public.payment_charge_refunds where attempt_id=$1 order by stripe_refund_id`, [p.row.id])).rows;

describe("0358 record_charge_refund_history: recording", () => {
  it("a partial refund (2000 of the charge) is recorded and the summary is established from the rows", async () => {
    const p = await prepared();
    const r = await record(p, evidence(p, [{ id: "re_a", amount: 2000 }]));
    expect(r).toMatchObject({ result: "recorded", out_succeeded_cents: 2000, out_inflight_count: 0 });
    expect(await summary(p)).toMatchObject({ s: 2000, f: 0 });
    expect(await rows(p)).toEqual([{ id: "re_a", a: 2000, status: "succeeded", k: "signed_event" }]);
  });
  it("partial then remainder, and two partials: the summary is the sum and never exceeds the charge", async () => {
    const p = await prepared();
    await record(p, evidence(p, [{ id: "re_a", amount: 2000 }]));
    const r = await record(p, evidence(p, [{ id: "re_a", amount: 2000 }, { id: "re_b", amount: p.row.amount_cents - 2000 }], { event_created: 1001 }));
    expect(r).toMatchObject({ result: "recorded", out_succeeded_cents: p.row.amount_cents });
    const over = await record(p, evidence(p, [{ id: "re_c", amount: 1 }], { event_created: 1002, charge_amount_refunded: 1 }));
    expect(over.result).toBe("refund_evidence_refused");
    expect((await summary(p)).s).toBe(p.row.amount_cents);
  });
  it("the same event again is already_recorded and writes nothing", async () => {
    const p = await prepared();
    const ev = evidence(p, [{ id: "re_a", amount: 2000 }]);
    const eventId = `evt_${randomUUID()}`;
    expect((await record(p, ev, { eventId })).result).toBe("recorded");
    const before = await rows(p);
    expect((await record(p, ev, { eventId })).result).toBe("already_recorded");
    expect(await rows(p)).toEqual(before);
  });
  it("a pending refund counts as in flight; a later succeeded event moves it to succeeded; a terminal status never changes", async () => {
    const p = await prepared();
    expect(await record(p, evidence(p, [{ id: "re_a", amount: 2000, status: "pending" }], { charge_amount_refunded: 0 }))).toMatchObject({ out_succeeded_cents: 0, out_inflight_count: 1 });
    expect(await record(p, evidence(p, [{ id: "re_a", amount: 2000 }], { event_created: 1001 }))).toMatchObject({ result: "recorded", out_succeeded_cents: 2000, out_inflight_count: 0 });
    const conflict = await record(p, evidence(p, [{ id: "re_a", amount: 2000, status: "failed" }], { event_created: 1002, charge_amount_refunded: 0 }));
    expect(conflict.result).toBe("terminal_refund_mismatch");
    expect((await rows(p))[0].status).toBe("succeeded");
  });
  it("a changed amount for a known refund is refused", async () => {
    const p = await prepared();
    await record(p, evidence(p, [{ id: "re_a", amount: 2000 }]));
    expect((await record(p, evidence(p, [{ id: "re_a", amount: 2500 }], { event_created: 1001 }))).result).toBe("refund_evidence_refused");
  });
  it.each(["studio", "account", "mode", "customer", "intent", "amount", "currency", "charge"])("refuses a mismatching %s and writes nothing", async (key) => {
    const p = await prepared();
    const scope = key === "studio" ? { studio: randomUUID() } : key === "account" ? { account: "acct_other" } : key === "mode" ? { mode: !p.row.stripe_livemode } : {};
    const patch = key === "customer" ? { customer_id: "cus_other" } : key === "intent" ? { payment_intent_id: "pi_other" }
      : key === "amount" ? { amount_cents: p.row.amount_cents + 1 } : key === "currency" ? { currency: p.row.currency === "usd" ? "cad" : "usd" }
      : key === "charge" ? { charge_id: "ch_other" } : {};
    expect((await record(p, evidence(p, [{ id: "re_a", amount: 2000 }], patch), scope)).result).toBe("identity_mismatch");
    expect(await rows(p)).toEqual([]);
    expect((await summary(p)).s).toBeNull();
  });
  it("an incomplete list records its refunds but does NOT establish the history (the summary stays null)", async () => {
    const p = await prepared();
    const r = await record(p, evidence(p, [{ id: "re_a", amount: 2000 }], { charge_refund_list_complete: false }));
    expect(r.result).toBe("recorded");
    expect(await summary(p)).toMatchObject({ s: null, e: null });
  });
  it("a refund event for another currency or charge on a component is refused", async () => {
    const p = await prepared();
    const ev = evidence(p, [{ id: "re_a", amount: 2000 }]);
    (ev.components[0] as Record<string, unknown>).charge_id = "ch_other";
    expect((await record(p, ev)).result).toBe("refund_evidence_refused");
  });
});

describe("0358 evidence kinds", () => {
  it("the authenticated kind is accepted only for charge.refunded with a complete list", async () => {
    const p = await prepared();
    const ok = await record(p, evidence(p, [{ id: "re_a", amount: 2000 }], { evidence_kind: AUTH }));
    expect(ok.result).toBe("recorded");
    const q = await prepared();
    expect((await record(q, evidence(q, [{ id: "re_a", amount: 2000 }], { evidence_kind: AUTH }), { type: "refund.updated" })).result).toBe("invalid_input");
    expect((await record(q, evidence(q, [{ id: "re_a", amount: 2000 }], { evidence_kind: AUTH, charge_refund_list_complete: false }))).result).toBe("invalid_input");
    const missing = evidence(q, [{ id: "re_a", amount: 2000 }], { evidence_kind: AUTH }) as Record<string, unknown>;
    delete missing.charge_refund_list_complete;
    expect((await record(q, missing)).result).toBe("invalid_input");
    expect(await rows(q)).toEqual([]);
  });
  it("an unknown or action-response kind is still refused", async () => {
    const p = await prepared();
    for (const kind of ["action_response", "authenticated", "", null, "SIGNED_EVENT"]) {
      expect((await record(p, evidence(p, [{ id: "re_a", amount: 2000 }], { evidence_kind: kind }))).result).toBe("invalid_input");
    }
    expect(await rows(p)).toEqual([]);
  });
  it("the kind is stored with each row, a later event of another kind does not change it, and a direct change is refused", async () => {
    const p = await prepared();
    await record(p, evidence(p, [{ id: "re_a", amount: 2000, status: "pending" }], { charge_amount_refunded: 0 }));
    await record(p, evidence(p, [{ id: "re_a", amount: 2000 }, { id: "re_b", amount: 1000 }], { evidence_kind: AUTH, event_created: 1001, charge_amount_refunded: 3000 }));
    expect(await rows(p)).toEqual([
      { id: "re_a", a: 2000, status: "succeeded", k: "signed_event" },          // established by the first kind, advanced by the second: kind unchanged
      { id: "re_b", a: 1000, status: "succeeded", k: AUTH },
    ]);
    await expect(adminQuery(`update public.payment_charge_refunds set evidence_kind='signed_event' where attempt_id=$1 and stripe_refund_id='re_b'`, [p.row.id]))
      .rejects.toThrow(/never change/);
  });
});

describe("0358 accept ahead, refuse behind", () => {
  it("authenticated: a list AHEAD of the signed total is accepted; BEHIND is refused", async () => {
    const p = await prepared();
    const ahead = await record(p, evidence(p, [{ id: "re_a", amount: 2000 }, { id: "re_b", amount: 1000 }], { evidence_kind: AUTH, charge_amount_refunded: 2000 }));
    expect(ahead).toMatchObject({ result: "recorded", out_succeeded_cents: 3000 });
    const q = await prepared();
    const behind = await record(q, evidence(q, [{ id: "re_a", amount: 2000 }], { evidence_kind: AUTH, charge_amount_refunded: 3000 }));
    expect(behind.result).toBe("refund_evidence_refused");
    expect(await rows(q)).toEqual([]);
  });
  it("signed_event: ahead is refused as well as behind (the list inside the event must match its own total)", async () => {
    const p = await prepared();
    expect((await record(p, evidence(p, [{ id: "re_a", amount: 2000 }, { id: "re_b", amount: 1000 }], { charge_amount_refunded: 2000 }))).result).toBe("refund_evidence_refused");
    expect((await record(p, evidence(p, [{ id: "re_a", amount: 2000 }], { charge_amount_refunded: 3000 }))).result).toBe("refund_evidence_refused");
  });
  it("a refunded total above the charge is refused for both kinds", async () => {
    const p = await prepared();
    for (const kind of ["signed_event", AUTH]) {
      expect((await record(p, evidence(p, [{ id: "re_a", amount: 2000 }], { evidence_kind: kind, charge_amount_refunded: p.row.amount_cents + 1 }))).result).toBe("refund_evidence_refused");
    }
  });
});

describe("0358 replay and advance", () => {
  it("a replay is already_recorded; a later event with a longer list advances the summary and an older list never lowers it", async () => {
    const p = await prepared();
    const eventId = `evt_${randomUUID()}`;
    const first = evidence(p, [{ id: "re_a", amount: 2000 }], { evidence_kind: AUTH });
    expect((await record(p, first, { eventId })).result).toBe("recorded");
    expect((await record(p, first, { eventId })).result).toBe("already_recorded");
    expect((await record(p, evidence(p, [{ id: "re_a", amount: 2000 }, { id: "re_b", amount: 500 }], { evidence_kind: AUTH, event_created: 1001, charge_amount_refunded: 2500 }))).out_succeeded_cents).toBe(2500);
    const older = await record(p, evidence(p, [{ id: "re_a", amount: 2000 }], { evidence_kind: AUTH, event_created: 999 }));
    expect(older.out_succeeded_cents).toBe(2500);
    expect((await summary(p)).s).toBe(2500);
  });
});

describe("0358 privileges and isolation", () => {
  it("only service_role can execute the command; no role can write the table; owners read only their own studio's rows", async () => {
    const sig = "public.record_charge_refund_history(uuid,text,text,uuid,text,boolean,jsonb)";
    const priv = async (role: string) => (await adminQuery(`select has_function_privilege($1,$2,'execute') x`, [role, sig])).rows[0].x;
    expect(await priv("service_role")).toBe(true);
    for (const role of ["anon", "authenticated", "public"]) expect(await priv(role)).toBe(false);
    for (const role of ["anon", "authenticated", "service_role"]) {
      for (const op of ["insert", "update", "delete"]) {
        expect((await adminQuery(`select has_table_privilege($1,'public.payment_charge_refunds',$2) x`, [role, op])).rows[0].x).toBe(false);
      }
    }
    const a = await prepared();
    const b = await prepared();
    await record(a, evidence(a, [{ id: "re_a", amount: 2000 }]));
    await record(b, evidence(b, [{ id: "re_b", amount: 1000 }]));
    const own = await asUser(a.s.practitionerUserId, (q) => q(`select stripe_refund_id from public.payment_charge_refunds`));
    expect(own.rows.map((r: { stripe_refund_id: string }) => r.stripe_refund_id)).toEqual(["re_a"]);
    const anon = await asRole("anon", (q) => q(`select count(*)::int n from public.payment_charge_refunds`)).catch(() => ({ rows: [{ n: 0 }] }));
    expect(anon.rows[0].n).toBe(0);
  });
  it("rows are never deleted and the identity of a refund never changes", async () => {
    const p = await prepared();
    await record(p, evidence(p, [{ id: "re_a", amount: 2000 }]));
    await expect(adminQuery(`delete from public.payment_charge_refunds where attempt_id=$1`, [p.row.id])).rejects.toThrow(/never deleted/);
    await expect(adminQuery(`update public.payment_charge_refunds set amount_cents=1 where attempt_id=$1`, [p.row.id])).rejects.toThrow(/never change/);
  });
});

describe("0358 concurrency", () => {
  it("two simultaneous deliveries of the same list record it once, with no deadlock", async () => {
    const p = await prepared();
    const ev = evidence(p, [{ id: "re_a", amount: 2000 }, { id: "re_b", amount: 1000 }], { charge_amount_refunded: 3000 });
    const results = await Promise.all([record(p, ev, { eventId: "evt_same_1" }), record(p, ev, { eventId: "evt_same_2" })]);
    expect(results.map((r) => r.result).sort()).toEqual(["already_recorded", "recorded"]);
    expect((await rows(p))).toHaveLength(2);
    expect((await summary(p)).s).toBe(3000);
  });
});
