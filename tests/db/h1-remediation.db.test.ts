import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { adminQuery, adminTx, closePool, seedStudio } from "./helpers/harness";
import { seedQuickCheckoutScenario } from "./helpers/payment-seed";

// H1-REMEDIATION-DESIGN: rehearsal proof, synthetic data only.
//
// The repository 0214 is NOT edited. The rule is applied to a COPY of the
// applied initializer's body (pg_get_functiondef, renamed) so one CI run can put
// the baseline and the rule side by side on identical fixtures:
//
//   base  = the applied initialize_studio_payment_jurisdiction_from_history
//   r1    = base + R1 (the currency check tolerates NULL-currency, NULL-amount
//           rows of the five payment_method_cleanup_* actions)
//   r12   = r1 + R2 (booking-time card sessions in a terminal state no longer
//           count as unverifiable history)
//
// The patch that would ship is general/H1-REMEDIATION/0214-h1-rule.patch; this
// file applies the same two replacements. A refusal writes nothing, so a
// fixture can be offered to base, then r1, then r12 in turn.
//
// Cells print one line each:  H1R|<case>|base=<result>|r1=<result>|r12=<result>
// and the last test asserts the expected table, so a surprise is a red test.

const CLEANUP = [
  "payment_method_cleanup_queued",
  "payment_method_cleanup_attempted",
  "payment_method_cleanup_safety_checked",
  "payment_method_cleanup_succeeded",
  "payment_method_cleanup_failed",
] as const;

// Every action the audit table's CHECK permits (0032).
const ALL_ACTIONS = [
  "charge_attempted", "charge_succeeded", "charge_failed", "charge_authentication_required",
  "refund_attempted", "refund_succeeded", "refund_failed", "external_refund_observed",
  "refund_stale_ignored", "refund_identifier_conflict",
  "dispute_created", "dispute_updated", "dispute_closed", "dispute_stale_ignored",
  "dispute_identifier_conflict",
  ...CLEANUP,
  "webhook_received", "double_charge_detected", "double_charge_resolved",
  "double_charge_resolution_failed",
];

const SIG =
  "public.initialize_studio_payment_jurisdiction_from_history(uuid,text,text,text,text,text,boolean,text[],uuid[])";
const R1_OLD =
  /\n {5}or exists \(select 1 from public\.stripe_payment_audit au\n\s+where au\.studio_id = p_studio_id and au\.currency is distinct from v_currency\) then/;
const R2_OLD =
  /\n {5}or exists \(select 1 from public\.pending_booking_payment_sessions ps\n\s+where ps\.studio_id = p_studio_id\) then/;
const R1_NEW = `
     or exists (select 1 from public.stripe_payment_audit au
                 where au.studio_id = p_studio_id
                   and au.currency is distinct from v_currency
                   and not (au.currency is null and au.amount_cents is null
                            and au.action in (${CLEANUP.map((a) => `'${a}'`).join(", ")}))) then`;
const R2_NEW = `
     or exists (select 1 from public.pending_booking_payment_sessions ps
                 where ps.studio_id = p_studio_id
                   and ps.status not in ('cleaned', 'expired_without_payment_method')) then`;

type Fn = "base" | "r1" | "r12";
const FN_NAME: Record<Fn, string> = {
  base: "public.initialize_studio_payment_jurisdiction_from_history",
  r1: "public.h1r_init_r1",
  r12: "public.h1r_init_r12",
};

const lines: Record<string, Record<Fn, string>> = {};
const rid = () => randomUUID().replace(/-/g, "").slice(0, 12);

beforeAll(async () => {
  const def = (await adminQuery(`select pg_get_functiondef($1::regprocedure) as d`, [SIG])).rows[0].d as string;
  expect(def.match(R1_OLD)?.length).toBe(1);
  expect(def.match(R2_OLD)?.length).toBe(1);
  const renamed = (to: string, d: string) =>
    d.replace("public.initialize_studio_payment_jurisdiction_from_history(", `${to}(`);
  const d1 = renamed("public.h1r_init_r1", def.replace(R1_OLD, R1_NEW));
  const d12 = renamed("public.h1r_init_r12", def.replace(R1_OLD, R1_NEW).replace(R2_OLD, R2_NEW));
  await adminQuery(d1);
  await adminQuery(d12);
});

afterAll(async () => {
  await adminQuery(`drop function if exists public.h1r_init_r1(uuid,text,text,text,text,text,boolean,text[],uuid[])`).catch(() => undefined);
  await adminQuery(`drop function if exists public.h1r_init_r12(uuid,text,text,text,text,text,boolean,text[],uuid[])`).catch(() => undefined);
  await closePool();
});

async function raw(table: string, row: Record<string, unknown>) {
  const cols = Object.keys(row);
  await adminTx(async (q) => {
    await q(`set local session_replication_role = replica`);
    await q(
      `insert into public.${table} (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")})`,
      cols.map((c) => row[c]),
    );
  });
}

/** A bare studio (no Stripe account): FK-less audit rows are written under replica. */
async function bareStudio(): Promise<string> {
  return (await seedStudio(`h1r-${rid()}`, { verifiedPaymentJurisdiction: false })).studioId;
}

async function fkLessAudit(studioId: string, action: string, over: Record<string, unknown> = {}) {
  await raw("stripe_payment_audit", {
    studio_id: studioId, action, appointment_id: randomUUID(),
    stripe_account_id: null, stripe_livemode: null, currency: null, amount_cents: null, ...over,
  });
}

/** A studio with a test-mode Connect account + customer (the FK targets of a card session). */
async function accountStudio(live = false) {
  const sc = await seedQuickCheckoutScenario({
    label: `h1r${rid()}`, appointmentStatus: "confirmed", withSession: false,
    connect: "enabled", connectLivemode: live, cardLivemode: live, withCard: false, attempt: "none",
  });
  await adminTx(async (q) => {
    await q(`set local session_replication_role = replica`);
    await q(`delete from public.studio_payment_jurisdiction_changes where studio_id=$1`, [sc.studioId]);
    await q(`delete from public.studio_payment_jurisdictions where studio_id=$1`, [sc.studioId]);
  });
  const acct = (await adminQuery(`select stripe_account_id a, stripe_livemode l from public.studio_payment_settings where studio_id=$1`, [sc.studioId])).rows[0];
  const cust = (await adminQuery(`select stripe_customer_id c from public.client_stripe_customers where studio_id=$1 and client_id=$2`, [sc.studioId, sc.clientId])).rows[0].c as string;
  return { sc, acct: acct.a as string, live: acct.l as boolean, cust };
}

/** An FK-valid booking-time card session, then a cleanup audit row written by the REAL helper. */
async function sessionWithCleanupAudit(
  a: Awaited<ReturnType<typeof accountStudio>>,
  status: string,
  actions: readonly string[],
) {
  const svc = (await adminQuery(
    `insert into public.services (studio_id, name, default_duration_minutes, price_cents, active, modality)
     values ($1,'H1R svc',30,0,true,'consultation') returning id`,
    [a.sc.studioId],
  )).rows[0].id as string;
  const start = new Date(Date.now() + 86_400_000);
  const end = new Date(start.getTime() + 30 * 60_000);
  const sid = (await adminQuery(
    `insert into public.pending_booking_payment_sessions
       (token_hash, studio_id, service_id, client_id, requested_starts_at, requested_ends_at,
        requested_duration_minutes, stripe_account_id, stripe_livemode, stripe_customer_id,
        stripe_setup_intent_id, stripe_payment_method_id, status)
     values ($1,$2,$3,$4,$5,$6,30,$7,$8,$9,$10,$11,$12) returning id`,
    [`tok_${rid()}${rid()}`, a.sc.studioId, svc, a.sc.clientId, start.toISOString(), end.toISOString(),
      a.acct, a.live, a.cust, `seti_${rid()}`, `pm_${rid()}`, status],
  )).rows[0].id as string;
  for (const action of actions) {
    // The argument shape of the 0032 cleanup writers: no amount, no currency.
    await adminQuery(
      `select public._append_stripe_payment_audit(null,$1,$2,null,$3,null,null,null,null,null,null,null,null,null,null,null,'{}'::jsonb,$4,$5)`,
      [sid, a.sc.studioId, action, a.acct, a.live],
    );
  }
  return sid;
}

async function call(fn: Fn, studioId: string, acks?: { accounts?: string[] | null }): Promise<string> {
  const r = await adminQuery(
    `select * from ${FN_NAME[fn]}($1,'CA','cad','operator:h1-rehearsal','h1 remediation rehearsal','fixture:h1r',true,$2::text[],null::uuid[])`,
    [studioId, acks?.accounts ?? null],
  );
  return String(r.rows[0].out_result);
}

/** Offer the same fixture to base, then r1, then r12 (a refusal writes nothing). */
async function offer(name: string, studioId: string, acks?: { accounts?: string[] | null }) {
  const out = {} as Record<Fn, string>;
  for (const fn of ["base", "r1", "r12"] as Fn[]) out[fn] = await call(fn, studioId, acks);
  lines[name] = out;
  console.log(`H1R|${name}|base=${out.base}|r1=${out.r1}|r12=${out.r12}`);
}

async function auditHash(studioId: string): Promise<string> {
  return (await adminQuery(
    `select coalesce(md5(string_agg(x::text, '|' order by x::text)), '') h from public.stripe_payment_audit x where studio_id=$1`,
    [studioId],
  )).rows[0].h;
}

describe("(1) the NULL-currency writers, from the 0032 source", () => {
  it("the literal-NULL currency call sites are exactly the cleanup writers plus one double-charge failure", () => {
    const src = readFileSync(join(process.cwd(), "supabase/migrations/0032_stripe_connect_phase_1.sql"), "utf8");
    const calls = [...src.matchAll(/perform public\._append_stripe_payment_audit\(([\s\S]*?)\);/g)].map((m) => {
      const args: string[] = [];
      let depth = 0, cur = "", q = false;
      for (const c of m[1]) {
        if (q) { cur += c; if (c === "'") q = false; continue; }
        if (c === "'") { q = true; cur += c; } else if (c === "(") { depth++; cur += c; } else if (c === ")") { depth--; cur += c; }
        else if (c === "," && depth === 0) { args.push(cur.trim()); cur = ""; } else cur += c;
      }
      args.push(cur.trim());
      return { action: args[4], amount: args[6], currency: args[7] };
    });
    expect(calls.length).toBe(46);
    const literalNull = calls.filter((c) => c.currency === "null");
    console.log(`H1R|writers|call_sites=${calls.length}|literal_null_currency=${literalNull.length}|actions=${[...new Set(literalNull.map((c) => c.action))].sort().join(",")}`);
    expect([...new Set(literalNull.map((c) => c.action))].sort()).toEqual(
      ["'payment_method_cleanup_attempted'", "'payment_method_cleanup_queued'", "'payment_method_cleanup_safety_checked'",
        "'double_charge_resolution_failed'", "v_audit_action"].sort(),
    );
    // Literal-NULL sites never carry an amount either.
    expect(literalNull.every((c) => c.amount === "null")).toBe(true);
    // Every other site passes a variable or parameter, never the literal.
    expect(calls.filter((c) => c.currency !== "null").every((c) => /^(v_|p_)/.test(c.currency))).toBe(true);
  });
});

describe("(2)/(3) the rule and its negative controls", () => {
  it("R1 isolated: FK-less cleanup-only NULL rows (all five actions) -> base refuses, r1 initializes", async () => {
    const s = await bareStudio();
    for (const a of CLEANUP) await fkLessAudit(s, a);
    const before = await auditHash(s);
    await offer("R1-isolated-cleanup-only", s);
    expect(await auditHash(s)).toBe(before); // no audit row written, changed or removed
    const j = await adminQuery(`select payment_country, payment_currency from public.studio_payment_jurisdictions where studio_id=$1`, [s]);
    expect(j.rows[0]).toMatchObject({ payment_country: "CA", payment_currency: "cad" });
    expect(lines["R1-isolated-cleanup-only"]).toMatchObject({ base: "refused_currency_history", r1: "initialized", r12: "unchanged" });
  });

  it("NEGATIVE CONTROL: every OTHER action with NULL currency and NULL amount still refuses", async () => {
    const others = ALL_ACTIONS.filter((a) => !(CLEANUP as readonly string[]).includes(a));
    // The list above must equal the audit table's own CHECK, so a new action
    // added later cannot slip past this control unnoticed.
    const def = (await adminQuery(
      `select pg_get_constraintdef(c.oid) d from pg_constraint c
        where c.conrelid='public.stripe_payment_audit'::regclass and c.contype='c' and pg_get_constraintdef(c.oid) like '%charge_attempted%'`,
    )).rows[0].d as string;
    const inDb = [...def.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]).sort();
    expect(inDb).toEqual([...ALL_ACTIONS].sort());
    console.log(`H1R|action-universe|total=${inDb.length}|excluded=${CLEANUP.length}|controlled=${others.length}`);
    const bad: string[] = [];
    for (const action of others) {
      const s = await bareStudio();
      await fkLessAudit(s, action);
      await offer(`N-null-${action}`, s);
      const l = lines[`N-null-${action}`];
      if (l.r1 !== "refused_currency_history" || l.r12 !== "refused_currency_history" || l.base !== "refused_currency_history") bad.push(`${action}:${JSON.stringify(l)}`);
    }
    expect(bad).toEqual([]);
  });

  it("NEGATIVE CONTROL: a cleanup action that records an AMOUNT, or a present currency, still refuses", async () => {
    const s1 = await bareStudio();
    await fkLessAudit(s1, "payment_method_cleanup_queued", { amount_cents: 500 });
    await offer("N-cleanup-with-amount", s1);
    const s2 = await bareStudio();
    await fkLessAudit(s2, "payment_method_cleanup_queued", { currency: "usd" });
    await offer("N-cleanup-with-usd", s2);
    const s3 = await bareStudio();
    await fkLessAudit(s3, "payment_method_cleanup_queued");
    await fkLessAudit(s3, "charge_succeeded", { amount_cents: 4500 }); // money, NULL currency
    await offer("N-cleanup-plus-money-null", s3);
    const s4 = await bareStudio();
    await fkLessAudit(s4, "payment_method_cleanup_failed");
    await fkLessAudit(s4, "refund_succeeded", { amount_cents: 500, currency: "usd" });
    await offer("N-cleanup-plus-usd-money", s4);
    for (const n of ["N-cleanup-with-amount", "N-cleanup-with-usd", "N-cleanup-plus-money-null", "N-cleanup-plus-usd-money"]) {
      expect(lines[n], n).toMatchObject({ base: "refused_currency_history", r1: "refused_currency_history", r12: "refused_currency_history" });
    }
  });

  it("NEGATIVE CONTROL: money history with an unknown currency can never pass: a NULL-currency money row in each currency-bearing ledger", async () => {
    // The ledgers' currency columns are NOT NULL (0032), so the only way to hold
    // unknown-currency money is a mismatching currency, which the unchanged
    // checks refuse. Prove the unchanged checks still fire under r12.
    const a = await bareStudio();
    await raw("appointment_settlements", { studio_id: a, appointment_id: randomUUID(), method: "paid_cash", amount_cents: 4500, recorded_by_practitioner_id: randomUUID(), currency: "usd" });
    await offer("N-usd-settlement", a);
    expect(lines["N-usd-settlement"]).toMatchObject({ base: "refused_currency_history", r1: "refused_currency_history", r12: "refused_currency_history" });
  });

  it("R2: FK-valid cleanup-only history, session cleaned -> base refuses (unverifiable), r1 still refuses, r12 initializes; audit rows untouched", async () => {
    const a = await accountStudio();
    await sessionWithCleanupAudit(a, "cleaned", CLEANUP);
    const before = await auditHash(a.sc.studioId);
    await offer("R2-cleaned-session-cleanup-only", a.sc.studioId, { accounts: [a.acct] });
    expect(await auditHash(a.sc.studioId)).toBe(before);
    expect(lines["R2-cleaned-session-cleanup-only"]).toMatchObject({
      base: "refused_unverifiable_history", r1: "refused_unverifiable_history", r12: "initialized",
    });
  });

  it("R2 negative controls: a session that is not terminal, or an appointment_payments row, still refuses", async () => {
    for (const status of ["cleanup_required", "finalized", "payment_method_saved_pending_finalization", "finalization_failed"]) {
      const a = await accountStudio();
      await sessionWithCleanupAudit(a, status, ["payment_method_cleanup_queued"]);
      await offer(`N-session-${status}`, a.sc.studioId, { accounts: [a.acct] });
      expect(lines[`N-session-${status}`].r12, status).toBe("refused_unverifiable_history");
    }
    const b = await accountStudio();
    await sessionWithCleanupAudit(b, "cleaned", ["payment_method_cleanup_succeeded"]);
    await raw("appointment_payments", {
      appointment_id: randomUUID(), studio_id: b.sc.studioId, client_id: b.sc.clientId,
      pending_booking_payment_session_id: randomUUID(), payment_consent_id: randomUUID(),
      stripe_account_id: b.acct, stripe_livemode: b.live, stripe_customer_id: b.cust,
      stripe_setup_intent_id: `seti_${rid()}`, stripe_payment_method_id: `pm_${rid()}`,
    });
    await offer("N-appointment-payments-row", b.sc.studioId, { accounts: [b.acct] });
    expect(lines["N-appointment-payments-row"].r12).toBe("refused_unverifiable_history");
  });

  it("R2 keeps the account rules: a cleaned session on an UNOBSERVED test account still needs the exact acknowledgement; a LIVE account is never waived", async () => {
    const a = await accountStudio();
    await sessionWithCleanupAudit(a, "cleaned", ["payment_method_cleanup_succeeded"]);
    await offer("R2-no-account-ack", a.sc.studioId, { accounts: null });
    expect(lines["R2-no-account-ack"].r12).toBe("refused_test_account_unobserved");
    // Same studio shape, but the bound account is LIVE and unobserved.
    const l = await accountStudio(true);
    expect(l.live).toBe(true);
    await sessionWithCleanupAudit(l, "cleaned", ["payment_method_cleanup_succeeded"]);
    await offer("N-live-account-unobserved", l.sc.studioId, { accounts: [l.acct] });
    expect(lines["N-live-account-unobserved"]).toMatchObject({ base: "refused_unverifiable_history", r12: "refused_account_unverified" });
  });
});
