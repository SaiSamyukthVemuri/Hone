import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { randomUUID } from "node:crypto";
import { adminQuery, asUser, closePool } from "./helpers/harness";
import { cleanupPaymentScenario, seedQuickCheckoutScenario, type PaymentScenario } from "./helpers/payment-seed";

// 0394 studio_has_gone_live / card_counts_toward_capacity (Sam, 27 Nov 2026: Stripe TEST-mode money is not real money). A studio has "gone live" once it has a SUCCEEDED
// card attempt with stripe_livemode = true. Before that every card attempt counts toward a bill's capacity (test lanes, CI, dev and staging are unchanged); after it, a
// non-live attempt no longer does, so an old test charge can never block collecting real money. The mode is derived from rows: no command takes it as an input. Synthetic values only.

const created: string[] = [];
async function visit(): Promise<PaymentScenario> {
  const s = await seedQuickCheckoutScenario({ appointmentStatus: "completed", withSession: true, attempt: "none", bookedService: { name: "Synthetic service", priceCents: 22500 } });
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

const asOwner = <T,>(s: PaymentScenario, fn: (q: (t: string, p?: unknown[]) => Promise<{ rows: any[] }>) => Promise<T>) => asUser(s.practitionerUserId, fn);
const ensure = (s: PaymentScenario, final: number | null = null, reason: string | null = null) => asOwner(s, (q) => q(`select * from public.ensure_visit_bill($1,$2,$3,$4,false)`, [s.studioId, s.appointmentId, final, reason])).then((r) => r.rows[0]);
const cash = (s: PaymentScenario, cents: number) => asOwner(s, (q) => q(`select * from public.record_visit_external_payment($1,$2,'paid_cash',$3,$4,null)`, [s.studioId, s.appointmentId, cents, randomUUID()])).then((r) => r.rows[0]);
const position = (s: PaymentScenario) => asOwner(s, (q) => q(`select * from public.get_visit_payment_position($1,$2)`, [s.studioId, s.appointmentId])).then((r) => r.rows[0]);
let seq = 0;
const tok = () => `${Date.now().toString(36)}${(seq++).toString(36)}${randomUUID().slice(0, 6)}`;
// A card attempt as the application's admin client writes it; `live` picks the Stripe mode of the attempt.
const card = (s: PaymentScenario, cents: number, live: boolean, status: "ready" | "succeeded" = "succeeded") =>
  adminQuery(
    `insert into public.payment_charge_attempts
       (studio_id, charge_reason, client_id, session_id, appointment_id, created_by_practitioner_id, amount_cents, currency, status, stripe_livemode, stripe_account_id,
        client_payment_method_id, card_authorization_signature_id, stripe_payment_intent_id, stripe_charge_id, charged_at)
     select $1,'session_payment',$2,$3,$4,$5,$6,'cad',$7,$8,(case when $8 then 'acct_synthetic_live' else (select stripe_account_id from public.client_payment_methods where client_id=$2 and studio_id=$1 limit 1) end),
        (select id from public.client_payment_methods where client_id=$2 and studio_id=$1 limit 1),
        (select id from public.client_consent_signatures where client_id=$2 and studio_id=$1 order by template_version desc limit 1),
        $9,$10,$11
     returning id`,
    [s.studioId, s.clientId, s.sessionId, s.appointmentId, s.practitionerId, cents, status, live,
     status === "succeeded" ? `pi_${tok()}` : null, status === "succeeded" ? `ch_${tok()}` : null, status === "succeeded" ? new Date().toISOString() : null],
  ).then((r) => r.rows[0].id as string);
const goneLive = (s: PaymentScenario) => adminQuery(`select public.studio_has_gone_live($1) as v`, [s.studioId]).then((r) => r.rows[0].v as boolean);

// The studio's own LIVE charge, as a marker that the studio has gone live. It carries no appointment (the card wall ignores such a row), so it can be made at any point.
const goLive = (s: PaymentScenario) =>
  adminQuery(
    `insert into public.payment_charge_attempts
       (studio_id, charge_reason, client_id, session_id, created_by_practitioner_id, amount_cents, currency, status, stripe_livemode, stripe_account_id,
        client_payment_method_id, card_authorization_signature_id, stripe_payment_intent_id, stripe_charge_id, charged_at)
     select $1,'session_payment',$2,$3,$4,5000,'cad','succeeded',true,'acct_synthetic_live',
        (select id from public.client_payment_methods where client_id=$2 and studio_id=$1 limit 1),
        (select id from public.client_consent_signatures where client_id=$2 and studio_id=$1 order by template_version desc limit 1),
        $5,$6,now()`,
    [s.studioId, s.clientId, s.sessionId, s.practitionerId, `pi_${tok()}`, `ch_${tok()}`],
  );

// Sam, 28 Nov 2026: what is STILL TO COLLECT (outstanding_cents) counts REAL money only (cash, transfers, LIVE cards). A Stripe TEST payment never counts, in ANY studio. `card_cents` is live card money.
// The one use of the live distinction left is test_card_room_cents (the room for a new TEST card). These tests replace the earlier "test money counts until the studio is live" assertions, deliberately.
describe("0394 real money only: which money counts toward a bill's capacity", () => {
  it("a TEST-ONLY studio: a test card never reduces Still to collect, real cash does, and the over-collect cap holds", async () => {
    const s = await visit();
    await ensure(s);
    await card(s, 10000, false);
    expect(await goneLive(s)).toBe(false);
    expect(await position(s)).toMatchObject({ card_cents: 0, outstanding_cents: 22500, test_card_room_cents: 12500 });
    expect((await cash(s, 12500)).result).toBe("recorded");
    expect(await position(s)).toMatchObject({ outstanding_cents: 10000, test_card_room_cents: 0 });
    expect((await cash(s, 10001)).result).toBe("exceeds_balance");   // never more than the agreed balance minus REAL money
    expect((await cash(s, 10000)).result).toBe("recorded");
    expect(await position(s)).toMatchObject({ outstanding_cents: 0 });
  });

  it("an old test charge that covers the whole bill never blocks genuine cash, before or after the studio goes live", async () => {
    const s = await visit();
    await ensure(s);
    await card(s, 22500, false);                                   // the old pilot test charge
    expect(await position(s)).toMatchObject({ card_cents: 0, outstanding_cents: 22500 });
    await goLive(s);
    expect(await goneLive(s)).toBe(true);
    expect(await position(s)).toMatchObject({ card_cents: 0, outstanding_cents: 22500 });
    expect((await cash(s, 22500)).result).toBe("recorded");
    expect((await cash(s, 1)).result).toBe("exceeds_balance");
  });

  it("a mixed visit: only the live card plus cash or transfer count, and the cap still holds", async () => {
    const s = await visit();
    await ensure(s);
    await card(s, 10000, false);                                   // a test card
    await goLive(s);
    await card(s, 10000, true);                                    // a real $100 card on the same visit
    expect(await position(s)).toMatchObject({ card_cents: 10000, outstanding_cents: 12500 });
    expect((await cash(s, 5000)).result).toBe("recorded");
    expect(await position(s)).toMatchObject({ card_cents: 10000, confirmed_cents: 5000, outstanding_cents: 7500 });
    expect((await cash(s, 7501)).result).toBe("exceeds_balance"); // $100 live card + $50 cash + more than $75 is refused
    expect((await cash(s, 7500)).result).toBe("recorded");
    expect(await position(s)).toMatchObject({ outstanding_cents: 0 });
  });

  it("the card wall: a live card is judged on real money (an old test charge does not refuse it) and over the real balance is refused; a TEST card is judged on the test room", async () => {
    const s = await visit();
    await ensure(s);
    await card(s, 22500, false);
    await card(s, 22500, true);                                    // the whole real balance, accepted even in a studio that was not live (the row is live)
    await expect(card(s, 1, true)).rejects.toThrow(/exceeds_balance/);
    const t = await visit();
    await ensure(t);
    await card(t, 22500, false);
    await expect(card(t, 100, false)).rejects.toThrow(/exceeds_balance/);   // test money stacking past the bill in a trial studio is refused
  });

  it("a $60 test charge: the first live card may take the full remaining REAL balance, and one cent more is refused", async () => {
    const s = await visit();
    await ensure(s);
    await card(s, 6000, false);
    await expect(card(s, 22501, true)).rejects.toThrow(/exceeds_balance/);
    await card(s, 22500, true);
    expect(await position(s)).toMatchObject({ card_cents: 22500, outstanding_cents: 0 });
  });

  it("no command takes the mode as an input: the mode functions are not callable by the signed-in owner", async () => {
    const s = await visit();
    for (const sql of [`select public.studio_has_gone_live($1)`, `select public.card_counts_toward_capacity($1, false)`]) {
      await expect(asOwner(s, (q) => q(sql, [s.studioId]))).rejects.toThrow(/permission denied/);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// C (Sam, 28 Nov 2026): a studio is LIVE when it has a Stripe Connect settings row in LIVE mode with an account id (it connected live Stripe: no payment needed) OR a succeeded
// live card attempt. Derived from rows only. A trial studio (test row only) is not live and counts test money exactly as before.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------
let acct = 0;
const connectLive = (s: PaymentScenario) =>
  adminQuery(
    `insert into public.studio_payment_settings (studio_id, stripe_account_id, stripe_account_status, stripe_charges_enabled, stripe_payouts_enabled, stripe_livemode)
     values ($1, $2, 'pending', false, false, true)`,   // any bound live account counts, whatever its status: not required to be charges-enabled
    [s.studioId, `acct_live_${tok()}_${acct++}`],
  );
// A studio that never connected Stripe: no settings row, and so no customer or saved card either (they are bound to it).
const neverConnect = async (s: PaymentScenario) => {
  for (const t of ["client_payment_methods", "client_stripe_customers", "studio_payment_settings"]) await adminQuery(`delete from public.${t} where studio_id = $1`, [s.studioId]);
};
const transfer = async (s: PaymentScenario, cents: number) => {
  const r = (await asOwner(s, (q) => q(`select * from public.record_visit_external_payment($1,$2,'paid_e_transfer',$3,$4,null)`, [s.studioId, s.appointmentId, cents, randomUUID()]))).rows[0];
  await asOwner(s, (q) => q(`select * from public.confirm_visit_external_payment($1,$2)`, [s.studioId, r.payment_id]));
  return r;
};

describe("0394 live studio = a live Connect account (no live card needed); real-money acceptance cases", () => {
  it("a TRIAL studio (a test settings row only) is not live: a test card never counts, and an old test charge NEVER blocks genuine cash", async () => {
    const s = await visit();
    expect(await goneLive(s)).toBe(false);
    await ensure(s);
    await card(s, 22500, false);
    expect(await position(s)).toMatchObject({ card_cents: 0, outstanding_cents: 22500, test_card_room_cents: 0 });
    await expect(card(s, 100, false)).rejects.toThrow(/exceeds_balance/);        // a second TEST card has no room in a trial studio
    expect((await cash(s, 22500)).result).toBe("recorded");
    expect((await cash(s, 1)).result).toBe("exceeds_balance");
    expect(await position(s)).toMatchObject({ confirmed_cents: 22500, outstanding_cents: 0 });
  });

  it("CASH-FIRST: a studio that connects live Stripe before any payment records cash as its first real money, with no live card run", async () => {
    const s = await visit();
    await ensure(s);
    await card(s, 22500, false);                                   // an old pilot test charge
    await connectLive(s);                                          // live Stripe connected: no payment of any kind yet
    expect(await goneLive(s)).toBe(true);
    expect(await position(s)).toMatchObject({ card_cents: 0, outstanding_cents: 22500, test_card_room_cents: 22500 });
    expect((await cash(s, 22500)).result).toBe("recorded");
    expect(await position(s)).toMatchObject({ confirmed_cents: 22500, outstanding_cents: 0 });
    expect((await cash(s, 100)).result).toBe("exceeds_balance");
    expect((await adminQuery(`select count(*)::int as n from public.payment_charge_attempts where studio_id=$1 and stripe_livemode = true`, [s.studioId])).rows[0].n).toBe(0);
  });

  it("NEVER CONNECTED studio (no settings row at all), cash and transfer only: both recorded, totals right, no Stripe anywhere", async () => {
    const s = await visit();
    await neverConnect(s);
    expect(await goneLive(s)).toBe(false);
    await ensure(s, 12500, "Loyalty price");
    expect((await cash(s, 5000)).result).toBe("recorded");
    await transfer(s, 7500);
    expect(await position(s)).toMatchObject({ total_cents: 12500, card_cents: 0, confirmed_cents: 12500, outstanding_cents: 0 });
    expect((await cash(s, 100)).result).toBe("exceeds_balance");
    expect((await adminQuery(`select count(*)::int as n from public.payment_charge_attempts where studio_id=$1`, [s.studioId])).rows[0].n).toBe(0);
  });

  // ACCEPTANCE (Sam, 28 Nov 2026): a $225 visit, a $225 TEST charge, then $225 confirmed cash. Still to collect is $0 and a second real payment of ANY kind is refused with nothing written.
  // Three studios: a trial (test Connect), a live-connected one, and a studio with no Stripe connection (its binding cleared: a leftover test charge on a studio that is no longer connected).
  for (const kind of ["trial", "connected live", "no Stripe connection"] as const) {
    it(`ACCEPTANCE (${kind}): $225 test charge + $225 cash leaves $0 to collect; a second cash, transfer or live card is refused exceeds_balance and nothing is written`, async () => {
      const s = await visit();
      await ensure(s);
      if (kind === "no Stripe connection") {
        // A studio with no Stripe connection at all (no settings row, customer or saved card) that still carries a leftover TEST charge on the visit: the row is written bare.
        await neverConnect(s);
        await adminQuery(
          `insert into public.payment_charge_attempts (studio_id, charge_reason, client_id, session_id, appointment_id, created_by_practitioner_id, amount_cents, currency, status, stripe_livemode, stripe_payment_intent_id, stripe_charge_id, charged_at)
           values ($1,'session_payment',$2,$3,$4,$5,22500,'cad','succeeded',false,$6,$7,now())`,
          [s.studioId, s.clientId, s.sessionId, s.appointmentId, s.practitionerId, `pi_${tok()}`, `ch_${tok()}`],
        );
      } else await card(s, 22500, false);
      if (kind === "connected live") await connectLive(s);
      expect(await position(s)).toMatchObject({ card_cents: 0, outstanding_cents: 22500 });
      expect((await cash(s, 22500)).result).toBe("recorded");
      expect(await position(s)).toMatchObject({ confirmed_cents: 22500, card_cents: 0, outstanding_cents: 0 });
      const rows = async () => [
        (await adminQuery(`select count(*)::int as n from public.visit_external_payments where studio_id=$1`, [s.studioId])).rows[0].n,
        (await adminQuery(`select count(*)::int as n from public.payment_charge_attempts where studio_id=$1`, [s.studioId])).rows[0].n,
      ];
      const before = await rows();
      expect((await cash(s, 1)).result).toBe("exceeds_balance");
      const tr = (await asOwner(s, (q) => q(`select * from public.record_visit_external_payment($1,$2,'paid_e_transfer',$3,$4,null)`, [s.studioId, s.appointmentId, 1, randomUUID()]))).rows[0];
      expect(tr.result).toBe("exceeds_balance");
      await expect(card(s, 1, true)).rejects.toThrow(/exceeds_balance/);
      expect(await rows()).toEqual(before);
      expect(await position(s)).toMatchObject({ confirmed_cents: 22500, outstanding_cents: 0 });
    });
  }

  it("the mixed example ($100 test charge, $50 cash, $75 transfer on a $125 bill): only real money counts and the bill is paid, in a live studio and a trial one", async () => {
    for (const live of [true, false]) {
      const s = await visit();
      await ensure(s, 12500, "Loyalty price");
      await card(s, 10000, false);
      if (live) await connectLive(s);
      expect((await cash(s, 5000)).result).toBe("recorded");
      await transfer(s, 7500);
      expect(await position(s)).toMatchObject({ total_cents: 12500, card_cents: 0, confirmed_cents: 12500, outstanding_cents: 0 });
    }
  });

  it("connecting live changes NOTHING about Still to collect (a test charge never counted), and clearing the binding flips only the room for a test card", async () => {
    const s = await visit();
    await ensure(s);
    await card(s, 22500, false);
    expect(await position(s)).toMatchObject({ outstanding_cents: 22500, test_card_room_cents: 0 });
    await connectLive(s);
    expect(await position(s)).toMatchObject({ outstanding_cents: 22500, test_card_room_cents: 22500 });
    await expect(adminQuery(`update public.studio_payment_settings set stripe_account_id = null where studio_id = $1 and stripe_livemode = true`, [s.studioId])).rejects.toThrow(/account_mode_pair_check/);
    await adminQuery(`update public.studio_payment_settings set stripe_account_id = null, stripe_livemode = null where studio_id = $1 and stripe_livemode = true`, [s.studioId]);
    expect(await goneLive(s)).toBe(false);
    expect(await position(s)).toMatchObject({ outstanding_cents: 22500, test_card_room_cents: 0 });
    expect((await cash(s, 22500)).result).toBe("recorded");
  });

  it("an owner cannot make a studio live: no insert, update or delete on the settings table, and none of the provisioning functions is executable by authenticated", async () => {
    const s = await visit();
    for (const sql of [
      `insert into public.studio_payment_settings (studio_id, stripe_account_id, stripe_livemode) values ($1, 'acct_x_${tok()}', true)`,
      `update public.studio_payment_settings set stripe_livemode = true, stripe_account_id = 'acct_y_${tok()}' where studio_id = $1`,
      `delete from public.studio_payment_settings where studio_id = $1`,
    ]) {
      try { await asOwner(s, (q) => q(sql, [s.studioId])); } catch { /* refused outright (no privilege) is the strong outcome; a silent 0-row RLS no-op is checked below */ }
    }
    // Whatever the owner attempted, the studio's settings are exactly as seeded: no live row, and the seeded row is still there and unchanged.
    expect((await adminQuery(`select count(*)::int as n from public.studio_payment_settings where studio_id=$1`, [s.studioId])).rows[0].n).toBe(1);
    expect((await adminQuery(`select count(*)::int as n from public.studio_payment_settings where studio_id=$1 and stripe_livemode = true`, [s.studioId])).rows[0].n).toBe(0);
    for (const fn of [
      "public.complete_stripe_account_provisioning(uuid,uuid,text,boolean)", "public.create_or_claim_stripe_account_provisioning(uuid,boolean)",
      "public.sync_studio_account_status(uuid,text,boolean,text,boolean,boolean,timestamptz)",
    ]) {
      const r = await adminQuery(`select has_function_privilege('authenticated', $1, 'execute') as a, has_function_privilege('anon', $1, 'execute') as n`, [fn]);
      expect(r.rows[0], fn).toEqual({ a: false, n: false });
    }
  });
});

// Parity: the app's probe (lib/billing/studio-live.ts) must answer exactly what the database's studio_has_gone_live answers on the same rows. The probe's REAL queries run here against the
// real tables through a tiny supabase-js-shaped adapter (eq / not-is-null / limit), so a filter drift on either side shows up.
describe("the app probe and the SQL definition agree on the same fixtures", () => {
  type Filter = { col: string; op: "eq" | "notnull"; val?: unknown };
  const adapter = () => ({
    from(table: string) {
      const filters: Filter[] = []; let lim = 1000;
      const q: Record<string, unknown> = {
        select: () => q, limit: (n: number) => { lim = n; return q; },
        eq: (col: string, val: unknown) => { filters.push({ col, op: "eq", val }); return q; },
        not: (col: string, op: string, val: unknown) => { if (op === "is" && val === null) filters.push({ col, op: "notnull" }); return q; },
        then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => {
          const params: unknown[] = []; const where = filters.map((f) => f.op === "notnull" ? `${f.col} is not null` : `${f.col} = $${params.push(f.val)}`).join(" and ");
          return adminQuery(`select 1 from public.${table} where ${where} limit ${lim}`, params).then((r) => ({ data: r.rows, error: null })).then(res, rej);
        },
      };
      return q;
    },
  });
  it("trial, connected-live (any status), succeeded-live-attempt-only, and cleared binding", async () => {
    const { readStudioLive } = await import("@/lib/billing/studio-live");
    const probe = async (s: PaymentScenario) => readStudioLive(adapter() as never, s.studioId);
    const a = await visit(); const b = await visit(); const c = await visit(); const d = await visit();
    await connectLive(b);
    await goLive(c);
    await connectLive(d);
    await adminQuery(`update public.studio_payment_settings set stripe_account_id = null, stripe_livemode = null where studio_id = $1 and stripe_livemode = true`, [d.studioId]);
    for (const [name, s, want] of [["trial", a, false], ["connected live", b, true], ["live attempt only", c, true], ["binding cleared", d, false]] as const) {
      expect(await goneLive(s), `${name}: sql`).toBe(want);
      expect(await probe(s), `${name}: app`).toBe(want);
    }
  });
});

// Insurance P3 on #1827 (ACK final1681): a pre-bill card payment (no visit_bill_id) is counted on the statement when it is live money, but the SQL position only counts attempts that
// carry the bill. They can only disagree if a LIVE, un-refunded card payment can exist beside a bill without carrying it. These tests pin why that cannot happen.
describe("a pre-bill card payment and the bill: the statement and the position cannot disagree about live money", () => {
  const ensureAt = (s: PaymentScenario, livemode: boolean) =>
    asOwner(s, (q) => q(`select * from public.ensure_visit_bill($1,$2,null,null,$3)`, [s.studioId, s.appointmentId, livemode])).then((r) => r.rows[0]);
  const bills = async (s: PaymentScenario) => Number((await adminQuery(`select count(*)::int as n from public.visit_bills where studio_id=$1`, [s.studioId])).rows[0].n);
  const refund = (s: PaymentScenario, full: boolean) =>
    adminQuery(`update public.payment_charge_attempts set refund_status='succeeded', refund_amount_cents = amount_cents - $2 where studio_id=$1`, [s.studioId, full ? 0 : 1000]);

  it("on a LIVE deployment a pre-bill live card refuses a bill (card_payment_exists), and nothing is written", async () => {
    const s = await visit();
    await card(s, 22500, true);
    expect((await ensureAt(s, true)).result).toBe("card_payment_exists");
    expect(await bills(s)).toBe(0);
  });

  it("a PARTLY refunded live card still refuses (the refund does not cover the payment); only a FULLY refunded one lets a bill be made", async () => {
    const s = await visit();
    await card(s, 22500, true);
    await refund(s, false);                                          // $10 short of the whole payment
    expect((await ensureAt(s, true)).result).toBe("card_payment_exists");
    expect(await bills(s)).toBe(0);
    await adminQuery(`update public.payment_charge_attempts set refund_amount_cents = amount_cents where studio_id=$1`, [s.studioId]);
    expect((await ensureAt(s, true)).result).toBe("created");
    // The refunded payment is not part of the bill: the position never counts it, and the statement (fixed in #1827) does not add it back into the bill's coverage.
    expect(await position(s)).toMatchObject({ card_cents: 0, outstanding_cents: 22500 });
  });

  it("a pre-bill TEST card on a LIVE deployment does not block a bill, and both the position and the statement leave it out (neither counts test money)", async () => {
    const s = await visit();
    await card(s, 22500, false);
    expect((await ensureAt(s, true)).result).toBe("created");
    expect(await position(s)).toMatchObject({ card_cents: 0, outstanding_cents: 22500 });
    const row = (await adminQuery(`select visit_bill_id, stripe_livemode from public.payment_charge_attempts where studio_id=$1`, [s.studioId])).rows[0];
    expect(row.visit_bill_id).toBeNull();                            // pre-bill: not part of the bill
    expect(row.stripe_livemode).toBe(false);                         // the statement reads live attempts only, so it is left out there too
  });

  it("on a TEST deployment any pre-bill card refuses a bill, live or not", async () => {
    const s = await visit();
    await card(s, 22500, false);
    expect((await ensureAt(s, false)).result).toBe("card_payment_exists");
    expect(await bills(s)).toBe(0);
  });

  it("once a bill exists a new card payment is stamped with the bill, so no live payment can sit beside a bill without carrying it", async () => {
    const s = await visit();
    expect((await ensureAt(s, true)).result).toBe("created");
    await card(s, 5000, true);
    const row = (await adminQuery(`select a.visit_bill_id, b.id as bill_id from public.payment_charge_attempts a join public.visit_bills b on b.appointment_id = a.appointment_id where a.studio_id=$1`, [s.studioId])).rows[0];
    expect(row.visit_bill_id).toBe(row.bill_id);
    expect(await position(s)).toMatchObject({ card_cents: 5000, outstanding_cents: 17500 });
  });
});
