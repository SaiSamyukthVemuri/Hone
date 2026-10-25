import { afterAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Pool, type PoolClient } from "pg";
import {
  adminQuery,
  adminTx,
  asRole,
  closePool,
  resolveLocalDbUrl,
  seedStudio,
  type SeededStudio,
} from "./helpers/harness";

// ===========================================================================
// J9 — T-0214-1 (R-2(c1)): initialize_studio_payment_jurisdiction_from_history
// ===========================================================================
//
// Validates draft v3 (v3.1 changes only its placement notes). On the U tree
// (the UNAMENDED 0214) the command comes from 0257, applied in chain order; on
// the A tree (the amended 0214) the same command comes from 0214 and 0257 is a
// no-op over it (J9-H). Plan: general/F1-TESTMODE-DESIGN-NOTE.md groups A-F.
// Synthetic data only.
//
// History has to exist BEFORE any jurisdiction row, which the live guards
// forbid, so fixtures write it as the owner role with
// session_replication_role = replica (FK and trigger enforcement off, CHECKs
// still on). That is exactly the state a pre-0214 studio is in at S1.

const created: SeededStudio[] = [];

afterAll(async () => {
  // Rows written under replica mode are left for the stack teardown (OPS):
  // this stack is single-use and the ids are random.
  await closePool();
});

async function studio(label: string): Promise<SeededStudio> {
  const s = await seedStudio(`j9-${label}`, { verifiedPaymentJurisdiction: false });
  created.push(s);
  return s;
}

const rid = () => randomUUID().replace(/-/g, "").slice(0, 14);

/** Insert one row with FK/trigger enforcement off (CHECKs stay on). */
async function raw(table: string, row: Record<string, unknown>): Promise<void> {
  const cols = Object.keys(row);
  await adminTx(async (q) => {
    await q(`set local session_replication_role = replica`);
    await q(
      `insert into public.${table} (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")})`,
      cols.map((c) => row[c]),
    );
  });
}

type Mode = { acct: string; live: boolean };

async function bind(s: SeededStudio, live: boolean, country: string | null): Promise<Mode> {
  const acct = `acct_${live ? "L" : "T"}${rid()}`;
  await raw("studio_payment_settings", {
    studio_id: s.studioId,
    stripe_account_id: acct,
    stripe_livemode: live,
    stripe_account_status: "enabled",
    stripe_account_country: country,
  });
  return { acct, live };
}

async function conflict(acct: string, other: string) {
  await adminQuery(
    `update public.studio_payment_settings set stripe_account_country_conflict=$2,
       stripe_account_country_conflict_at=now() where stripe_account_id=$1`,
    [acct, other],
  );
}

// One factory per account-naming table: the minimum CHECK-valid row.
const NAMING: Record<string, (s: SeededStudio, acct: string | null, live: boolean, currency?: string) => Record<string, unknown>> = {
  stripe_account_provisioning_attempts: (s, acct, live) => ({
    studio_id: s.studioId, status: acct ? "succeeded" : "failed", idempotency_key: `idem_${rid()}`,
    stripe_account_id: acct, stripe_livemode: live,
  }),
  client_payment_methods: (s, acct, live) => ({
    studio_id: s.studioId, client_id: s.clientId, stripe_account_id: acct, stripe_livemode: live,
    stripe_customer_id: `cus_${rid()}`, stripe_payment_method_id: `pm_${rid()}`,
    stripe_setup_intent_id: `seti_${rid()}`, brand: "visa", last4: "4242", exp_month: 12, exp_year: 2030,
  }),
  client_stripe_customers: (s, acct, live) => ({
    client_id: s.clientId, studio_id: s.studioId, stripe_account_id: acct, stripe_livemode: live,
    stripe_customer_id: `cus_${rid()}`,
  }),
  payment_charge_attempts: (s, acct, live, currency = "cad") => ({
    studio_id: s.studioId, charge_reason: "no_show_fee", client_id: s.clientId,
    created_by_practitioner_id: s.practitionerId, appointment_id: randomUUID(), amount_cents: 5000,
    currency, status: "ready", stripe_livemode: live, stripe_account_id: acct,
  }),
  manual_fee_charge_attempts: (s, acct, live, currency = "cad") => ({
    studio_id: s.studioId, appointment_id: randomUUID(), client_id: s.clientId,
    confirmed_by_practitioner_id: s.practitionerId, charge_type: "no_show", amount_cents: 5000,
    currency, client_payment_method_id: randomUUID(), card_authorization_signature_id: randomUUID(),
    appointment_policy_acknowledgement_id: randomUUID(), policy_snapshot_hash: "h", internal_note: "n",
    stripe_account_id: acct, stripe_livemode: live,
  }),
  stripe_charge_attempts: (s, acct, live, currency = "cad") => ({
    appointment_id: randomUUID(), studio_id: s.studioId, stripe_account_id: acct, stripe_livemode: live,
    amount_cents: 5000, currency, status: "pending", idempotency_key: `idem_${rid()}`,
  }),
  stripe_refunds: (s, acct, live, currency = "cad") => ({
    studio_id: s.studioId, stripe_account_id: acct, stripe_livemode: live, appointment_id: randomUUID(),
    charge_attempt_id: randomUUID(), source: "stripe_dashboard_observed", stripe_refund_id: `re_${rid()}`,
    stripe_charge_id: `ch_${rid()}`, amount_cents: 500, currency, status: "succeeded",
  }),
  stripe_refund_attempts: (s, acct, live, currency = "cad") => ({
    appointment_id: randomUUID(), studio_id: s.studioId, stripe_account_id: acct, stripe_livemode: live,
    charge_attempt_id: randomUUID(), target_stripe_charge_id: `ch_${rid()}`, amount_cents: 500, currency,
    stripe_payment_intent_id: `pi_${rid()}`, status: "pending", idempotency_key: `idem_${rid()}`,
  }),
  stripe_disputes: (s, acct, live, currency = "cad") => ({
    studio_id: s.studioId, stripe_account_id: acct, stripe_livemode: live, appointment_id: randomUUID(),
    charge_attempt_id: randomUUID(), stripe_dispute_id: `dp_${rid()}`, stripe_charge_id: `ch_${rid()}`,
    amount_cents: 500, currency, status: "won",
  }),
  stripe_payment_audit: (s, acct, live, currency = "cad") => ({
    studio_id: s.studioId, action: "charge_attempted", appointment_id: randomUUID(),
    stripe_account_id: acct, stripe_livemode: acct ? live : null, currency,
  }),
  payment_recovery_tokens: (s, acct, live) => ({
    token_hash: `tok_${rid()}`, charge_attempt_id: randomUUID(), appointment_id: randomUUID(),
    studio_id: s.studioId, stripe_account_id: acct, stripe_livemode: live,
  }),
  stripe_customer_provisioning_attempts: (s, acct, live) => ({
    client_id: s.clientId, studio_id: s.studioId, stripe_account_id: acct, stripe_livemode: live,
    status: "succeeded", idempotency_key: `idem_${rid()}`,
  }),
};
const NAMING_TABLES = Object.keys(NAMING);
// 0065: manual_fee_charge_attempts is CHECK-pinned to test mode.
const LIVE_NAMING_TABLES = NAMING_TABLES.filter((t) => t !== "manual_fee_charge_attempts");
const CURRENCY_TABLES = [
  "payment_charge_attempts", "manual_fee_charge_attempts", "stripe_charge_attempts",
  "stripe_refunds", "stripe_refund_attempts", "stripe_disputes", "stripe_payment_audit",
];

async function name(table: string, s: SeededStudio, acct: string | null, live: boolean, currency?: string) {
  await raw(table, NAMING[table](s, acct, live, currency));
}

async function settlement(s: SeededStudio, currency: string) {
  await raw("appointment_settlements", {
    studio_id: s.studioId, appointment_id: randomUUID(), method: "paid_cash", amount_cents: 4500,
    recorded_by_practitioner_id: s.practitionerId, currency,
  });
}

type Opts = {
  country?: string; currency?: string; ackPrices?: boolean;
  accounts?: string[] | null; attempts?: string[] | null; actor?: string; reference?: string | null;
};

const INIT = `select * from public.initialize_studio_payment_jurisdiction_from_history($1,$2,$3,$4,$5,$6,$7,$8::text[],$9::uuid[])`;
function initArgs(studioId: string, o: Opts = {}) {
  return [
    studioId, o.country ?? "CA", o.currency ?? "cad", o.actor ?? "operator:test", "verified pair over history",
    o.reference === undefined ? "fixture:verified-evidence" : o.reference, o.ackPrices ?? false,
    o.accounts ?? null, o.attempts ?? null,
  ];
}

async function init(studioId: string, o: Opts = {}): Promise<string> {
  const r = await adminQuery(INIT, initArgs(studioId, o));
  return r.rows[0].out_result as string;
}

async function jurisdiction(studioId: string) {
  return (await adminQuery(`select payment_country, payment_currency from public.studio_payment_jurisdictions where studio_id=$1`, [studioId])).rows[0];
}

async function audit(studioId: string) {
  return (await adminQuery(
    `select from_country, to_country, to_currency, history_verified,
            unobserved_test_accounts_acknowledged, unbound_test_attempts_acknowledged
       from public.studio_payment_jurisdiction_changes where studio_id=$1`, [studioId])).rows;
}

async function moneyHash(studioId: string): Promise<string> {
  const parts: string[] = [];
  for (const t of [...CURRENCY_TABLES, "appointment_settlements"]) {
    const r = await adminQuery(`select coalesce(md5(string_agg(x::text, '|' order by x::text)), '') h from public.${t} x where studio_id=$1`, [studioId]);
    parts.push(`${t}:${r.rows[0].h}`);
  }
  return parts.join(",");
}

async function rejection(p: Promise<unknown>): Promise<string> {
  try { await p; } catch (e) { return (e as Error).message; }
  throw new Error("expected the statement to be refused");
}

/** A clean payment-active CA studio: live account observed CA, cad history. */
async function activeCa(label: string) {
  const s = await studio(label);
  const live = await bind(s, true, "CA");
  await name("payment_charge_attempts", s, live.acct, true, "cad");
  await settlement(s, "cad");
  return { s, live };
}

// ---------------------------------------------------------------------------
describe("J9-A outcomes", () => {
  it("A1 CA studio with cad history and an observed CA account initializes, rewriting nothing", async () => {
    const { s } = await activeCa("a1");
    const before = await moneyHash(s.studioId);
    expect(await init(s.studioId)).toBe("initialized");
    expect(await jurisdiction(s.studioId)).toEqual({ payment_country: "CA", payment_currency: "cad" });
    expect(await audit(s.studioId)).toEqual([{
      from_country: null, to_country: "CA", to_currency: "cad", history_verified: true,
      unobserved_test_accounts_acknowledged: [], unbound_test_attempts_acknowledged: [],
    }]);
    expect(await moneyHash(s.studioId)).toBe(before);
  });

  it("A2 a usd row refuses CA/cad", async () => {
    const s = await studio("a2");
    await name("payment_charge_attempts", s, null, false, "usd");
    expect(await init(s.studioId)).toBe("refused_currency_history");
    expect(await jurisdiction(s.studioId)).toBeUndefined();
  });

  it("A3 cad history refuses US/usd", async () => {
    const { s } = await activeCa("a3");
    expect(await init(s.studioId, { country: "US", currency: "usd" })).toBe("refused_currency_history");
  });

  it("A4 a NULL-currency audit row refuses", async () => {
    const s = await studio("a4");
    await raw("stripe_payment_audit", { ...NAMING.stripe_payment_audit(s, null, false), currency: null });
    expect(await init(s.studioId)).toBe("refused_currency_history");
  });

  it.each(["stripe_refunds", "stripe_refund_attempts", "stripe_disputes", "stripe_charge_attempts", "appointment_settlements"])(
    "A5 a foreign-currency row in %s refuses", async (table) => {
      const s = await studio(`a5-${table}`);
      if (table === "appointment_settlements") await settlement(s, "usd");
      else await name(table, s, `acct_T${rid()}`, false, "eur");
      expect(await init(s.studioId)).toBe("refused_currency_history");
    });

  it.each(["appointment_payments", "pending_booking_payment_sessions"])("A6 any %s row is unverifiable", async (table) => {
    const s = await studio(`a6-${table}`);
    const starts = new Date(Date.now() + 86_400_000);
    const row = table === "appointment_payments"
      ? { appointment_id: randomUUID(), studio_id: s.studioId, client_id: s.clientId,
          pending_booking_payment_session_id: randomUUID(), payment_consent_id: randomUUID(),
          stripe_account_id: `acct_T${rid()}`, stripe_livemode: false, stripe_customer_id: `cus_${rid()}`,
          stripe_setup_intent_id: `seti_${rid()}`, stripe_payment_method_id: `pm_${rid()}` }
      : { token_hash: `tok_${rid()}`, studio_id: s.studioId, service_id: randomUUID(), client_id: s.clientId,
          requested_starts_at: starts.toISOString(),
          requested_ends_at: new Date(starts.getTime() + 3_600_000).toISOString(),
          requested_duration_minutes: 60, stripe_account_id: `acct_T${rid()}`, stripe_livemode: false,
          stripe_customer_id: `cus_${rid()}` };
    await raw(table, row);
    expect(await init(s.studioId)).toBe("refused_unverifiable_history");
  });

  it("A7 a live account observed US, or with a recorded conflict, refuses as a mismatch", async () => {
    const s1 = await studio("a7-us");
    await bind(s1, true, "US");
    expect(await init(s1.studioId)).toBe("refused_account_mismatch");
    const s2 = await studio("a7-conflict");
    const a = await bind(s2, true, "CA");
    await conflict(a.acct, "US");
    expect(await init(s2.studioId)).toBe("refused_account_mismatch");
  });

  it("A8 a test account observed US refuses even with a correct acknowledgement", async () => {
    const { s } = await activeCa("a8");
    const t = await bind(s, false, "US");
    expect(await init(s.studioId, { accounts: [t.acct] })).toBe("refused_account_mismatch");
  });

  it("A9 an initialized studio: same pair unchanged, different pair refused, one audit row", async () => {
    const { s } = await activeCa("a9");
    expect(await init(s.studioId)).toBe("initialized");
    expect(await init(s.studioId)).toBe("unchanged");
    expect(await init(s.studioId, { country: "US", currency: "usd" })).toBe("refused_already_initialized");
    expect(await audit(s.studioId)).toHaveLength(1);
  });

  it("A10 prices refuse unless acknowledged", async () => {
    const { s } = await activeCa("a10");
    await adminQuery(`update public.studios set no_show_fee_cents=2500 where id=$1`, [s.studioId]);
    expect(await init(s.studioId)).toBe("refused_priced_configuration");
    expect(await init(s.studioId, { ackPrices: true })).toBe("initialized");
  });

  it("A11 not_found, invalid input and a missing reference", async () => {
    expect(await init(randomUUID())).toBe("not_found");
    const s = await studio("a11");
    expect(await init(s.studioId, { country: "CA", currency: "usd" })).toBe("invalid_input");
    expect(await init(s.studioId, { actor: " " })).toBe("invalid_input");
    expect(await init(s.studioId, { accounts: ["acct_x", null as unknown as string] })).toBe("invalid_input");
    expect(await init(s.studioId, { attempts: [null as unknown as string] })).toBe("invalid_input");
    expect(await init(s.studioId, { reference: null })).toBe("verification_required");
    expect(await jurisdiction(s.studioId)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
describe("J9-B live or unknown mode is never waived", () => {
  it("B1 an unobserved LIVE account refuses even when listed in the acknowledgement", async () => {
    const s = await studio("b1");
    const l = await bind(s, true, null);
    expect(await init(s.studioId)).toBe("refused_account_unverified");
    expect(await init(s.studioId, { accounts: [l.acct] })).toBe("refused_account_unverified");
  });

  it("B2 a NULL-mode bound account cannot exist (0032 pairing CHECK)", async () => {
    const s = await studio("b2");
    const msg = await rejection(raw("studio_payment_settings", {
      studio_id: s.studioId, stripe_account_id: `acct_${rid()}`, stripe_livemode: null, stripe_account_status: "enabled",
    }));
    expect(msg).toMatch(/studio_payment_settings_account_mode_pair_check/);
  });

  it("B3 a provisioning attempt with NULL mode refuses, with or without an account id", async () => {
    for (const withAcct of [false, true]) {
      const s = await studio(`b3-${withAcct}`);
      await raw("stripe_account_provisioning_attempts", {
        studio_id: s.studioId, status: "pending", idempotency_key: `idem_${rid()}`,
        stripe_account_id: withAcct ? `acct_${rid()}` : null, stripe_livemode: null,
      });
      expect(await init(s.studioId)).toBe("refused_account_unverified");
      expect(await init(s.studioId, { attempts: [] })).toBe("refused_account_unverified");
    }
  });

  it.each(LIVE_NAMING_TABLES)("B4 a LIVE %s row naming an unbound account refuses", async (table) => {
    const s = await studio(`b4-${table}`);
    await bind(s, true, "CA");
    await name(table, s, `acct_L${rid()}`, true);
    expect(await init(s.studioId)).toBe("refused_account_unverified");
  });

  it("B4 manual_fee_charge_attempts cannot hold a live row (0065 CHECK)", async () => {
    const s = await studio("b4-manual");
    const msg = await rejection(name("manual_fee_charge_attempts", s, `acct_L${rid()}`, true));
    expect(msg).toMatch(/manual_fee_charge_attempts_livemode_false_check/);
  });
  it("B5 the helper itself never accepts an unobserved LIVE account, even when asked to accept unobserved", async () => {
    const s = await studio("b5");
    const l = await bind(s, true, null);
    const r = await adminQuery(
      `select public.studio_account_acceptable_for_jurisdiction($1,$2,true,'CA',true) live_ok,
              public.studio_account_acceptable_for_jurisdiction($1,$2,true,'CA',false) live_strict`,
      [s.studioId, l.acct],
    );
    expect(r.rows[0]).toEqual({ live_ok: false, live_strict: false });
  });
});

// ---------------------------------------------------------------------------
describe("J9-C test mode (F-1, F2, F3, F6)", () => {
  async function withTest(label: string) {
    const { s, live } = await activeCa(label);
    const test = await bind(s, false, null);
    return { s, live, test };
  }

  it("C1 an unobserved test account with no acknowledgement", async () => {
    const { s } = await withTest("c1");
    expect(await init(s.studioId)).toBe("refused_test_account_unobserved");
  });

  it("C2 acknowledging exactly that account initializes and audits it", async () => {
    const { s, test } = await withTest("c2");
    expect(await init(s.studioId, { accounts: [test.acct] })).toBe("initialized");
    expect((await audit(s.studioId))[0].unobserved_test_accounts_acknowledged).toEqual([test.acct]);
  });

  it("C3 a different, superset or subset acknowledgement is stale", async () => {
    const { s, test } = await withTest("c3");
    const other = await bind(s, false, null).catch(() => null);
    // A studio holds one row per mode, so a second test account is a naming
    // row instead; the computed set is still {test}.
    expect(other).toBeNull();
    expect(await init(s.studioId, { accounts: [`acct_T${rid()}`] })).toBe("refused_test_acknowledgement_stale");
    expect(await init(s.studioId, { accounts: [test.acct, `acct_T${rid()}`] })).toBe("refused_test_acknowledgement_stale");
    expect(await init(s.studioId, { accounts: [test.acct], attempts: [randomUUID()] })).toBe("refused_test_acknowledgement_stale");
    expect(await jurisdiction(s.studioId)).toBeUndefined();
  });

  it("C4 an acknowledgement given while nothing needs one is stale", async () => {
    const { s } = await activeCa("c4");
    expect(await init(s.studioId, { accounts: [`acct_T${rid()}`] })).toBe("refused_test_acknowledgement_stale");
    expect(await init(s.studioId, { attempts: [randomUUID()] })).toBe("refused_test_acknowledgement_stale");
  });

  it("C5 an unbound test-mode provisioning attempt: none / exact / wrong", async () => {
    const { s } = await activeCa("c5");
    const attemptId = randomUUID();
    await raw("stripe_account_provisioning_attempts", {
      id: attemptId, studio_id: s.studioId, status: "failed", idempotency_key: `idem_${rid()}`,
      stripe_account_id: null, stripe_livemode: false,
    });
    expect(await init(s.studioId)).toBe("refused_test_account_unobserved");
    expect(await init(s.studioId, { attempts: [randomUUID()] })).toBe("refused_test_acknowledgement_stale");
    expect(await init(s.studioId, { attempts: [attemptId] })).toBe("initialized");
    expect((await audit(s.studioId))[0].unbound_test_attempts_acknowledged).toEqual([attemptId]);
  });

  it.each(NAMING_TABLES)("C6 a TEST %s row naming an UNBOUND account refuses as unverified, never unobserved", async (table) => {
    const { s } = await activeCa(`c6-${table}`);
    await name(table, s, `acct_T${rid()}`, false);
    expect(await init(s.studioId)).toBe("refused_account_unverified");
  });

  it.each(NAMING_TABLES)("C7 a TEST %s row naming the acknowledged test account initializes", async (table) => {
    const { s, test } = await withTest(`c7-${table}`);
    await name(table, s, test.acct, false);
    expect(await init(s.studioId, { accounts: [test.acct] })).toBe("initialized");
  });

  it("C8 duplicate ids in the acknowledgement are a set", async () => {
    const { s, test } = await withTest("c8");
    expect(await init(s.studioId, { accounts: [test.acct, test.acct] })).toBe("initialized");
  });
});

// ---------------------------------------------------------------------------
let slot = 0;
describe("J9-D after initialization the 0214 guard still governs", () => {
  async function attempt(s: SeededStudio, acct: string, currency: string) {
    const appt = randomUUID();
    slot += 1;
    const base = Date.now() - slot * 3 * 3_600_000;
    await adminQuery(
      `insert into public.appointments
         (id, studio_id, practitioner_id, client_id, starts_at, ends_at, duration_minutes, status)
       values ($1,$2,$3,$4,$5,$6,60,'completed')`,
      [appt, s.studioId, s.practitionerId, s.clientId,
       new Date(base).toISOString(), new Date(base + 3_600_000).toISOString()],
    );
    return adminQuery(
      `insert into public.payment_charge_attempts
         (studio_id, charge_reason, client_id, appointment_id, created_by_practitioner_id,
          amount_cents, currency, status, stripe_livemode, stripe_account_id)
       values ($1,'no_show_fee',$2,$3,$4,5000,$5,'ready',false,$6)`,
      [s.studioId, s.clientId, appt, s.practitionerId, currency, acct],
    );
  }

  it("D1 CA: a test cad attempt on the acknowledged unobserved account is accepted", async () => {
    const { s } = await activeCa("d1");
    const t = await bind(s, false, null);
    expect(await init(s.studioId, { accounts: [t.acct] })).toBe("initialized");
    await expect(attempt(s, t.acct, "cad")).resolves.toBeTruthy();
  });

  it("D1 US: a test usd attempt on an acknowledged unobserved account is refused", async () => {
    const s = await studio("d1-us");
    await bind(s, true, "US");
    const t = await bind(s, false, null);
    expect(await init(s.studioId, { country: "US", currency: "usd", accounts: [t.acct] })).toBe("initialized");
    expect(await rejection(attempt(s, t.acct, "usd"))).toMatch(/payment_account_country_unverified/);
  });

  it("D2 a later test-mode observation that disagrees is enforced", async () => {
    const { s } = await activeCa("d2");
    const t = await bind(s, false, null);
    expect(await init(s.studioId, { accounts: [t.acct] })).toBe("initialized");
    const r = await adminQuery(`select * from public.record_stripe_account_jurisdiction($1,$2,false,'US','usd')`, [s.studioId, t.acct]);
    expect(r.rows[0].out_result).toBe("recorded");
    expect(await rejection(attempt(s, t.acct, "cad"))).toMatch(/payment_account_country_mismatch/);
  });
});

// ---------------------------------------------------------------------------
describe("J9-E privileges (F1)", () => {
  const CMD = "public.initialize_studio_payment_jurisdiction_from_history(uuid,text,text,text,text,text,boolean,text[],uuid[])";
  const HELPERS = [
    "public.studio_account_acceptable_for_jurisdiction(uuid,text,boolean,text,boolean)",
    "public.studio_named_stripe_accounts(uuid)",
  ];

  it("E1 only service_role may execute the command; PUBLIC holds nothing", async () => {
    const r = await adminQuery(`select role_name, has_function_privilege(role_name, $1, 'EXECUTE') ok
      from unnest(array['anon','authenticated','service_role']) role_name`, [CMD]);
    expect(r.rows).toEqual([
      { role_name: "anon", ok: false }, { role_name: "authenticated", ok: false }, { role_name: "service_role", ok: true },
    ]);
    const acl = await adminQuery(`select array_to_string(proacl, ',') acl from pg_proc where oid = $1::regprocedure`, [CMD]);
    expect(acl.rows[0].acl).not.toMatch(/(^|,)=X/); // no PUBLIC entry
  });

  it("E2 no role may execute either helper", async () => {
    for (const fn of HELPERS) {
      const r = await adminQuery(`select bool_or(has_function_privilege(role_name, $1, 'EXECUTE')) any_ok
        from unnest(array['anon','authenticated','service_role']) role_name`, [fn]);
      expect(r.rows[0].any_ok, fn).toBe(false);
      const acl = await adminQuery(`select array_to_string(proacl, ',') acl from pg_proc where oid = $1::regprocedure`, [fn]);
      expect(acl.rows[0].acl, fn).toBe("postgres=X/postgres");
    }
  });

  it.each(["anon", "authenticated"] as const)("E3 %s cannot call the command", async (role) => {
    const msg = await rejection(asRole(role, (q) => q(
      `select * from public.initialize_studio_payment_jurisdiction_from_history(gen_random_uuid(),'CA','cad','a','r','ref',false,null,null)`)));
    expect(msg).toMatch(/permission denied/);
  });

  it("E4 service_role can call it but cannot write either table directly", async () => {
    await asRole("service_role", (q) => q(
      `select * from public.initialize_studio_payment_jurisdiction_from_history(gen_random_uuid(),'CA','cad','a','r','ref',false,null,null)`));
    for (const sql of [
      `insert into public.studio_payment_jurisdictions (studio_id, payment_country, payment_currency, source, verification_reference) values (gen_random_uuid(),'CA','cad','operator','x')`,
      `update public.studio_payment_jurisdiction_changes set history_verified = true`,
    ]) {
      expect(await rejection(asRole("service_role", (q) => q(sql)))).toMatch(/permission denied/);
    }
  });
});

// ---------------------------------------------------------------------------
// F: two real connections. A holds the command's transaction open; B's
// statement must be seen WAITING on a lock (pg_stat_activity), never a sleep.
describe("J9-F concurrency", () => {
  const pools: Pool[] = [];
  afterAll(async () => { for (const p of pools) await p.end(); });
  async function conn(): Promise<PoolClient> {
    const p = new Pool({ connectionString: resolveLocalDbUrl(), max: 1 });
    pools.push(p);
    return p.connect();
  }
  /** pid is waiting on a lock, and `by` is one of the sessions blocking it. */
  async function waitUntilBlocked(pid: number, by: number) {
    for (let i = 0; i < 200; i++) {
      const r = await adminQuery(
        `select wait_event_type, $2::int = any (pg_blocking_pids($1)) by_other from pg_stat_activity where pid=$1`,
        [pid, by],
      );
      if (r.rows[0]?.wait_event_type === "Lock") {
        expect(r.rows[0].by_other, `pid ${pid} blocked by ${by}`).toBe(true);
        return;
      }
      await new Promise((res) => setImmediate(res));
    }
    throw new Error(`pid ${pid} never blocked on a lock`);
  }
  /**
   * The waiter holds the tuple lock on a studio_payment_settings row and waits
   * only for the holder's transaction: it is queued behind the holder's ROW
   * lock on settings, not a relation, advisory or other lock the holder has.
   */
  async function expectWaitingOnSettingsRow(waiter: number, holder: number) {
    const r = await adminQuery(
      `select
         exists (select 1 from pg_locks t where t.pid = $1 and t.granted and t.locktype = 'tuple'
                  and t.relation = 'public.studio_payment_settings'::regclass) tuple_on_settings,
         array(select w.locktype from pg_locks w where w.pid = $1 and not w.granted) waiting_on,
         exists (select 1 from pg_locks w join pg_locks h
                   on h.locktype = 'transactionid' and h.transactionid = w.transactionid
                  where w.pid = $1 and not w.granted and w.locktype = 'transactionid'
                    and h.pid = $2 and h.granted) on_holder_xact`,
      [waiter, holder],
    );
    expect(r.rows[0]).toEqual({ tuple_on_settings: true, waiting_on: ["transactionid"], on_holder_xact: true });
  }
  async function pidOf(c: PoolClient): Promise<number> {
    return (await c.query(`select pg_backend_pid() pid`)).rows[0].pid as number;
  }

  it("F1 a binding committed by a writer that held the studio first is seen by the command", async () => {
    const { s } = await activeCa("f1");
    const a = await conn();
    const b = await conn();
    try {
      await b.query("begin");
      await b.query(`insert into public.studio_payment_settings (studio_id, stripe_account_id, stripe_livemode, stripe_account_status)
                     values ($1,$2,false,'enabled')`, [s.studioId, `acct_T${rid()}`]);
      const aPid = await pidOf(a);
      const bPid = await pidOf(b);
      const pending = a.query(INIT, initArgs(s.studioId));
      await waitUntilBlocked(aPid, bPid);
      await b.query("commit");
      expect((await pending).rows[0].out_result).toBe("refused_test_account_unobserved");
    } finally { a.release(); b.release(); }
  });

  it("F1b a writer arriving while the command holds the studio waits, then commits after it", async () => {
    const { s } = await activeCa("f1b");
    const a = await conn();
    const b = await conn();
    try {
      await a.query("begin");
      expect((await a.query(INIT, initArgs(s.studioId))).rows[0].out_result).toBe("initialized");
      const bPid = await pidOf(b);
      const pending = b.query(`insert into public.studio_payment_settings (studio_id, stripe_account_id, stripe_livemode, stripe_account_status)
                               values ($1,$2,false,'enabled')`, [s.studioId, `acct_T${rid()}`]);
      await waitUntilBlocked(bPid, await pidOf(a));
      await a.query("commit");
      await pending;
      expect(await jurisdiction(s.studioId)).toEqual({ payment_country: "CA", payment_currency: "cad" });
    } finally { a.release(); b.release(); }
  });

  it.each([["same pair", "CA", "cad", "unchanged"], ["different pair", "US", "usd", "changed"]])(
    "F2 set_studio_payment_jurisdiction racing the command (%s) never yields two rows", async (_l, country, currency, expected) => {
      const s = await studio(`f2-${country}`); // clean studio: both commands can initialize it
      const a = await conn();
      const b = await conn();
      try {
        await a.query("begin");
        expect((await a.query(INIT, initArgs(s.studioId))).rows[0].out_result).toBe("initialized");
        const bPid = await pidOf(b);
        const pending = b.query(`select * from public.set_studio_payment_jurisdiction($1,$2,$3,'op','r',false,'ref')`,
          [s.studioId, country, currency]);
        await waitUntilBlocked(bPid, await pidOf(a));
        await a.query("commit");
        expect((await pending).rows[0].out_result).toBe(expected);
        const n = await adminQuery(`select count(*)::int n from public.studio_payment_jurisdictions where studio_id=$1`, [s.studioId]);
        expect(n.rows[0].n).toBe(1);
      } finally { a.release(); b.release(); }
    });

  it("F3/F4 an observation of a settings row waits for the command's commit (rows stay share-locked)", async () => {
    const { s } = await activeCa("f4");
    const t = await bind(s, false, null);
    const a = await conn();
    const b = await conn();
    try {
      await a.query("begin");
      expect((await a.query(INIT, initArgs(s.studioId, { accounts: [t.acct] }))).rows[0].out_result).toBe("initialized");
      const bPid = await pidOf(b);
      const aPid = await pidOf(a);
      const pending = b.query(`select * from public.record_stripe_account_jurisdiction($1,$2,false,'CA','cad')`, [s.studioId, t.acct]);
      await waitUntilBlocked(bPid, aPid);
      await expectWaitingOnSettingsRow(bPid, aPid);
      await a.query("commit");
      expect((await pending).rows[0].out_result).toBe("recorded");
      expect((await audit(s.studioId))[0].unobserved_test_accounts_acknowledged).toEqual([t.acct]);
    } finally { a.release(); b.release(); }
  });

  // F5 (Willow's F3 request): the one case only the SECOND settings share lock
  // covers. B's settings row is uncommitted when A takes the first share lock,
  // so only the share lock after the studio FOR UPDATE can hold it. Without
  // that lock (mutant H5) A still sees the row and initializes, but C's
  // observation of it does not wait.
  it("F5 a settings row committed while the command waits for the studio stays share-locked until the command commits", async () => {
    const { s } = await activeCa("f5");
    const acct = `acct_T${rid()}`;
    const a = await conn();
    const b = await conn();
    const c = await conn();
    try {
      const [aPid, bPid, cPid] = [await pidOf(a), await pidOf(b), await pidOf(c)];
      await b.query("begin");
      await b.query(`insert into public.studio_payment_settings (studio_id, stripe_account_id, stripe_livemode, stripe_account_status)
                     values ($1,$2,false,'enabled')`, [s.studioId, acct]);
      await a.query("begin");
      const initializing = a.query(INIT, initArgs(s.studioId, { accounts: [acct] }));
      await waitUntilBlocked(aPid, bPid);
      await b.query("commit");
      expect((await initializing).rows[0].out_result).toBe("initialized");
      const observing = c.query(`select * from public.record_stripe_account_jurisdiction($1,$2,false,'CA','cad')`, [s.studioId, acct]);
      await waitUntilBlocked(cPid, aPid);
      await expectWaitingOnSettingsRow(cPid, aPid);
      await a.query("commit");
      expect((await observing).rows[0].out_result).toBe("recorded");
      expect((await audit(s.studioId))[0].unobserved_test_accounts_acknowledged).toEqual([acct]);
    } finally { a.release(); b.release(); c.release(); }
  });
});

// ---------------------------------------------------------------------------
describe("J9-G the money-table universe fails closed (F5)", () => {
  it("an unlisted public table with a currency column refuses initialization", async () => {
    const { s } = await activeCa("g-unlisted");
    const t = `zz_j9_scratch_${rid()}`;
    await adminQuery(`create table public.${t} (id int, currency text)`);
    try {
      expect(await init(s.studioId)).toBe("refused_unlisted_money_table");
    } finally {
      await adminQuery(`drop table public.${t}`);
    }
    expect(await init(s.studioId)).toBe("initialized");
  });
});

// ---------------------------------------------------------------------------
// H: 0257 itself. The command is reused text; what is new is that it arrives in
// its own migration, so prove it is idempotent, leaves history alone, and does
// not disturb audit rows written before it.
describe("J9-H 0257 follow-up", () => {
  const SQL_0257 = readFileSync(
    path.resolve(__dirname, "../../supabase/migrations/0257_payment_jurisdiction_history_init.sql"), "utf8");
  const FNS = [
    "public.initialize_studio_payment_jurisdiction_from_history(uuid,text,text,text,text,text,boolean,text[],uuid[])",
    "public.studio_account_acceptable_for_jurisdiction(uuid,text,boolean,text,boolean)",
    "public.studio_named_stripe_accounts(uuid)",
  ];
  async function catalogue(): Promise<string> {
    const out: string[] = [];
    for (const fn of FNS) {
      const r = await adminQuery(
        `select md5(pg_get_functiondef($1::regprocedure)) def, array_to_string(proacl, ',') acl,
                prosecdef, array_to_string(proconfig, ',') cfg from pg_proc where oid = $1::regprocedure`, [fn]);
      out.push(JSON.stringify(r.rows[0]));
    }
    const cols = await adminQuery(
      `select column_name, data_type, is_nullable, column_default from information_schema.columns
        where table_schema='public' and table_name='studio_payment_jurisdiction_changes'
          and column_name in ('history_verified','unobserved_test_accounts_acknowledged','unbound_test_attempts_acknowledged')
        order by column_name`);
    out.push(JSON.stringify(cols.rows));
    return createHash("sha256").update(out.join("\n")).digest("hex");
  }

  it("H1 a NULL-currency audit row is refused and left exactly as it was", async () => {
    const s = await studio("h1");
    await raw("stripe_payment_audit", { ...NAMING.stripe_payment_audit(s, null, false), currency: null });
    const before = await adminQuery(
      `select md5(string_agg(x::text, '|' order by x::text)) h, count(*)::int n from public.stripe_payment_audit x where studio_id=$1`, [s.studioId]);
    expect(await init(s.studioId)).toBe("refused_currency_history");
    expect(await init(s.studioId, { country: "US", currency: "usd" })).toBe("refused_currency_history");
    const after = await adminQuery(
      `select md5(string_agg(x::text, '|' order by x::text)) h, count(*)::int n from public.stripe_payment_audit x where studio_id=$1`, [s.studioId]);
    expect(after.rows[0]).toEqual(before.rows[0]);
    expect(after.rows[0].n).toBe(1);
    const nul = await adminQuery(`select count(*)::int n from public.stripe_payment_audit where studio_id=$1 and currency is null`, [s.studioId]);
    expect(nul.rows[0].n).toBe(1);
    expect(await jurisdiction(s.studioId)).toBeUndefined();
    expect(await audit(s.studioId)).toEqual([]);
  });

  it("H2 re-applying 0257 is a no-op: same definitions, ACLs, columns, and existing audit rows", async () => {
    const { s } = await activeCa("h2");
    expect(await init(s.studioId)).toBe("initialized");
    const rows = await audit(s.studioId);
    const before = await catalogue();
    await adminQuery(SQL_0257);
    await adminQuery(SQL_0257);
    expect(await catalogue()).toBe(before);
    expect(await audit(s.studioId)).toEqual(rows);
    expect(await init(s.studioId)).toBe("unchanged");
    expect(await audit(s.studioId)).toEqual(rows);
  });

  it("H3 an audit row written by the 0214 writer, before the command ran, reads history_verified=false", async () => {
    const s = await studio("h3");
    await adminQuery(
      `select * from public.set_studio_payment_jurisdiction($1::uuid,'CA','cad','operator:test','plain init',false,'fixture:evidence')`,
      [s.studioId]);
    expect(await audit(s.studioId)).toEqual([{
      from_country: null, to_country: "CA", to_currency: "cad", history_verified: false,
      unobserved_test_accounts_acknowledged: [], unbound_test_attempts_acknowledged: [],
    }]);
  });

  it("H4 the three helpers' grants are the 0214 posture after 0257: command to service_role only, helpers to nobody", async () => {
    for (const [i, fn] of FNS.entries()) {
      const r = await adminQuery(
        `select role_name, has_function_privilege(role_name, $1, 'EXECUTE') ok
           from unnest(array['anon','authenticated','service_role']) role_name`, [fn]);
      expect(r.rows.filter((x) => x.ok).map((x) => x.role_name), fn).toEqual(i === 0 ? ["service_role"] : []);
    }
  });
});
