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

describe("0394 which card money counts toward a bill's capacity", () => {
  it("a TEST-ONLY studio behaves as before: a succeeded test card reduces the balance, and the over-collect cap holds", async () => {
    const s = await visit();
    await ensure(s);
    await card(s, 10000, false);
    expect(await goneLive(s)).toBe(false);
    expect(await position(s)).toMatchObject({ card_cents: 10000, outstanding_cents: 12500 });
    expect((await cash(s, 12500)).result).toBe("recorded");
    expect((await cash(s, 100)).result).toBe("exceeds_balance");
  });

  it("a studio with a LIVE charge: an old test charge that covers the whole bill no longer blocks real money", async () => {
    const s = await visit();
    await ensure(s);
    await card(s, 22500, false);                                   // the old pilot test charge
    expect(await position(s)).toMatchObject({ card_cents: 22500, outstanding_cents: 0 });
    expect((await cash(s, 100)).result).toBe("exceeds_balance");   // before going live it counts, as it always did
    await goLive(s);
    expect(await goneLive(s)).toBe(true);
    expect(await position(s)).toMatchObject({ card_cents: 0, outstanding_cents: 22500 });
    expect((await cash(s, 22500)).result).toBe("recorded");
  });

  it("a mixed visit after going live: only the live card plus cash or transfer count, and the cap still holds", async () => {
    const s = await visit();
    await ensure(s);
    await card(s, 10000, false);                                   // test card, made before the studio went live
    await goLive(s);
    await card(s, 10000, true);                                    // a real $100 card on the same visit
    expect(await position(s)).toMatchObject({ card_cents: 10000, outstanding_cents: 12500 });
    expect((await cash(s, 5000)).result).toBe("recorded");
    expect(await position(s)).toMatchObject({ card_cents: 10000, confirmed_cents: 5000, outstanding_cents: 7500 });
    expect((await cash(s, 7501)).result).toBe("exceeds_balance"); // never over-collect: $100 live card + $50 cash + more than $75 is refused
    expect((await cash(s, 7500)).result).toBe("recorded");
    expect(await position(s)).toMatchObject({ outstanding_cents: 0 });
  });

  it("the card wall: after going live, a real card is accepted over an old test charge, and a card over the real balance is still refused", async () => {
    const s = await visit();
    await ensure(s);
    await card(s, 22500, false);
    await goLive(s);
    await card(s, 20000, true);                                    // fits: the test charge no longer counts
    await expect(card(s, 5000, true)).rejects.toThrow(/exceeds_balance/); // $200 live + $50 > $225: refused
  });

  it("the FIRST real card of a not-yet-live studio: a $100 test charge on a $100 bill does not refuse it, and the studio then reads live", async () => {
    const s = await visit();
    await ensure(s);
    await card(s, 22500, false);                                   // the whole $225 bill was paid with a TEST card
    expect(await goneLive(s)).toBe(false);
    await card(s, 22500, true);                                    // the row being inserted is live: the position is computed as if the studio had gone live
    expect(await goneLive(s)).toBe(true);
    expect(await position(s)).toMatchObject({ card_cents: 22500, outstanding_cents: 0 });
    expect((await cash(s, 100)).result).toBe("exceeds_balance");   // over-collection on live money is still refused
  });

  it("a $60 test charge: the first live card may take the full remaining REAL balance, and one cent more is refused", async () => {
    const s = await visit();
    await ensure(s);
    await card(s, 6000, false);
    await expect(card(s, 22501, true)).rejects.toThrow(/exceeds_balance/);   // over the bill: refused even for a live row
    await card(s, 22500, true);                                              // the whole real balance, not $165
    expect(await position(s)).toMatchObject({ card_cents: 22500, outstanding_cents: 0 });
  });

  it("a TEST row still cannot claim the assumption: a second test card is judged with the test charge counted", async () => {
    const s = await visit();
    await ensure(s);
    await card(s, 22500, false);
    await expect(card(s, 100, false)).rejects.toThrow(/exceeds_balance/);
  });

  it("no command takes the mode as an input: the mode functions are not callable by the signed-in owner", async () => {
    const s = await visit();
    for (const sql of [`select public.studio_has_gone_live($1)`, `select public.card_counts_toward_capacity($1, false, false)`]) {
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
const transfer = async (s: PaymentScenario, cents: number) => {
  const r = (await asOwner(s, (q) => q(`select * from public.record_visit_external_payment($1,$2,'paid_e_transfer',$3,$4,null)`, [s.studioId, s.appointmentId, cents, randomUUID()]))).rows[0];
  await asOwner(s, (q) => q(`select * from public.confirm_visit_external_payment($1,$2)`, [s.studioId, r.id]));
  return r;
};

describe("0394 live studio = a live Connect account (no live card needed)", () => {
  it("a TRIAL studio (a test settings row only) is not live and counts test money exactly as before", async () => {
    const s = await visit();
    expect(await goneLive(s)).toBe(false);
    await ensure(s);
    await card(s, 22500, false);
    expect(await position(s)).toMatchObject({ card_cents: 22500, outstanding_cents: 0 });
    expect((await cash(s, 100)).result).toBe("exceeds_balance");
  });

  it("CASH-FIRST: a studio that connects live Stripe before any payment records cash as its first real money, with no live card run", async () => {
    const s = await visit();
    await ensure(s);
    await card(s, 22500, false);                                   // an old pilot test charge covers the bill
    expect((await cash(s, 22500)).result).toBe("exceeds_balance"); // still a trial studio
    await connectLive(s);                                          // live Stripe connected: no payment of any kind yet
    expect(await goneLive(s)).toBe(true);
    expect(await position(s)).toMatchObject({ card_cents: 0, outstanding_cents: 22500 });
    expect((await cash(s, 22500)).result).toBe("recorded");        // the first REAL money is cash
    expect(await position(s)).toMatchObject({ confirmed_cents: 22500, outstanding_cents: 0 });
    expect((await cash(s, 100)).result).toBe("exceeds_balance");   // the over-collect cap still holds
    expect((await adminQuery(`select count(*)::int as n from public.payment_charge_attempts where studio_id=$1 and stripe_livemode = true`, [s.studioId])).rows[0].n).toBe(0);
  });

  it("the mixed example ($100 test charge, $50 cash, $75 transfer on a $125 bill) in a live studio: only real money counts and the bill is paid", async () => {
    const s = await visit();
    await ensure(s, 12500, "Loyalty price");
    await card(s, 10000, false);
    await connectLive(s);
    expect((await cash(s, 5000)).result).toBe("recorded");
    await transfer(s, 7500);
    expect(await position(s)).toMatchObject({ total_cents: 12500, card_cents: 0, confirmed_cents: 12500, outstanding_cents: 0 });
  });

  it("REOPEN pinned: connecting live while a visit is held ONLY by a test card reopens that balance by the test amount", async () => {
    const s = await visit();
    await ensure(s);
    await card(s, 22500, false);
    expect(await position(s)).toMatchObject({ outstanding_cents: 0 });
    await connectLive(s);
    expect(await position(s)).toMatchObject({ outstanding_cents: 22500 });
  });

  it("a live row with no account is not a binding (the pair check forbids it), and clearing the binding flips the studio back to trial: test money counts again", async () => {
    const s = await visit();
    await ensure(s);
    await card(s, 22500, false);
    await connectLive(s);
    expect(await position(s)).toMatchObject({ outstanding_cents: 22500 });
    await expect(adminQuery(`update public.studio_payment_settings set stripe_account_id = null where studio_id = $1 and stripe_livemode = true`, [s.studioId])).rejects.toThrow(/account_mode_pair_check/);
    await adminQuery(`update public.studio_payment_settings set stripe_account_id = null, stripe_livemode = null where studio_id = $1 and stripe_livemode = true`, [s.studioId]); // the only shape the CHECK allows
    expect(await goneLive(s)).toBe(false);
    expect(await position(s)).toMatchObject({ outstanding_cents: 0 });                // the test charge counts again: a cash-first visit is held by it
    expect((await cash(s, 100)).result).toBe("exceeds_balance");
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
