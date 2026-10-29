import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  adminQuery,
  adminTx,
  asRole,
  closePool,
  seedStudio,
  type SeededStudio,
} from "./helpers/harness";

// ===========================================================================
// 0257: initialize_studio_payment_jurisdiction_from_history_v2
// ===========================================================================
//
// A failed, terminal, claim-free live or unknown-mode provisioning attempt
// that named no account blocks 0214's command (F6 refuses a null account in
// those modes). v2 accepts it only when the operator acknowledges exactly
// those attempt ids with the fixed census evidence value. Everything else is
// 0214's behaviour. Synthetic data only.
//
// History has to exist before any jurisdiction row, which the live guards
// forbid, so fixtures write it as the owner role with
// session_replication_role = replica (CHECKs stay on), as the 0214 history
// suite does. The ids are random; the stack is single-use.

const EVIDENCE = "stripe_live_account_census_by_studio_metadata";

afterAll(async () => {
  await closePool();
});

const rid = () => randomUUID().replace(/-/g, "").slice(0, 14);

async function studio(label: string): Promise<SeededStudio> {
  return seedStudio(`j10-${label}`, { verifiedPaymentJurisdiction: false });
}

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

/** A live-bound CA studio with cad history: the baseline v1 accepts. */
async function activeCa(label: string): Promise<SeededStudio> {
  const s = await studio(label);
  await raw("studio_payment_settings", {
    studio_id: s.studioId,
    stripe_account_id: `acct_L${rid()}`,
    stripe_livemode: true,
    stripe_account_status: "enabled",
    stripe_account_country: "CA",
  });
  return s;
}

type AttemptOpts = {
  status?: "pending" | "processing" | "succeeded" | "failed";
  live?: boolean | null;
  terminal?: boolean;
  claim?: boolean;
  account?: string | null;
};

/** One provisioning attempt; defaults to the qualifying shape (failed, live, terminal, no claim, no account). */
async function attempt(s: SeededStudio, o: AttemptOpts = {}): Promise<string> {
  const id = randomUUID();
  const status = o.status ?? "failed";
  await raw("stripe_account_provisioning_attempts", {
    id,
    studio_id: s.studioId,
    status,
    idempotency_key: `idem_${rid()}`,
    stripe_account_id: o.account ?? null,
    stripe_livemode: o.live === undefined ? true : o.live,
    terminal_at: (o.terminal ?? status === "failed") ? new Date().toISOString() : null,
    processing_claim_token: o.claim ? randomUUID() : null,
  });
  return id;
}

const V1 = `select * from public.initialize_studio_payment_jurisdiction_from_history($1,$2,$3,$4,$5,$6,$7,$8::text[],$9::uuid[])`;
const V2 = `select * from public.initialize_studio_payment_jurisdiction_from_history_v2($1,$2,$3,$4,$5,$6,$7,$8::text[],$9::uuid[],$10::uuid[],$11)`;

type V2Opts = {
  country?: string;
  currency?: string;
  ackPrices?: boolean;
  testAccounts?: string[] | null;
  testAttempts?: string[] | null;
  failed?: string[] | null;
  evidence?: string | null;
};

function base(studioId: string, o: V2Opts) {
  return [
    studioId, o.country ?? "CA", o.currency ?? "cad", "operator:test", "verified pair over history",
    "fixture:verified-evidence", o.ackPrices ?? false, o.testAccounts ?? null, o.testAttempts ?? null,
  ];
}

async function v1(studioId: string, o: V2Opts = {}): Promise<string> {
  return (await adminQuery(V1, base(studioId, o))).rows[0].out_result as string;
}

async function v2(studioId: string, o: V2Opts = {}): Promise<string> {
  return (await adminQuery(V2, [...base(studioId, o), o.failed ?? null, o.evidence ?? null])).rows[0].out_result as string;
}

async function jurisdiction(studioId: string) {
  return (await adminQuery(
    `select payment_country, payment_currency from public.studio_payment_jurisdictions where studio_id=$1`, [studioId])).rows[0];
}

async function audit(studioId: string) {
  return (await adminQuery(
    `select to_country, to_currency, history_verified, unbound_test_attempts_acknowledged,
            failed_attempts_acknowledged, failed_attempts_evidence
       from public.studio_payment_jurisdiction_changes where studio_id=$1`, [studioId])).rows;
}

// ---------------------------------------------------------------------------
describe("J10-A the failed live null-account attempt", () => {
  it("A1 v1 refuses it, v2 refuses it without an acknowledgement, v2 with the exact id initializes", async () => {
    const s = await activeCa("a1");
    const id = await attempt(s);
    expect(await v1(s.studioId)).toBe("refused_account_unverified");
    expect(await v2(s.studioId)).toBe("refused_failed_attempt_unacknowledged");
    expect(await v2(s.studioId, { failed: [] })).toBe("refused_failed_attempt_unacknowledged");
    expect(await jurisdiction(s.studioId)).toBeUndefined();
    expect(await v2(s.studioId, { failed: [id], evidence: EVIDENCE })).toBe("initialized");
    expect(await jurisdiction(s.studioId)).toEqual({ payment_country: "CA", payment_currency: "cad" });
    expect(await audit(s.studioId)).toEqual([{
      to_country: "CA", to_currency: "cad", history_verified: true, unbound_test_attempts_acknowledged: [],
      failed_attempts_acknowledged: [id], failed_attempts_evidence: EVIDENCE,
    }]);
  });

  it("A2 an unknown-mode (NULL) failed attempt is handled the same way", async () => {
    const s = await activeCa("a2");
    const id = await attempt(s, { live: null });
    expect(await v1(s.studioId)).toBe("refused_account_unverified");
    expect(await v2(s.studioId)).toBe("refused_failed_attempt_unacknowledged");
    expect(await v2(s.studioId, { failed: [id], evidence: EVIDENCE })).toBe("initialized");
  });

  it("A3 two failed attempts need both ids; one, or one plus an extra, is stale", async () => {
    const s = await activeCa("a3");
    const a = await attempt(s);
    const b = await attempt(s);
    expect(await v2(s.studioId, { failed: [a], evidence: EVIDENCE })).toBe("refused_failed_attempt_acknowledgement_stale");
    expect(await v2(s.studioId, { failed: [a, b, randomUUID()], evidence: EVIDENCE })).toBe("refused_failed_attempt_acknowledgement_stale");
    expect(await v2(s.studioId, { failed: [a, randomUUID()], evidence: EVIDENCE })).toBe("refused_failed_attempt_acknowledgement_stale");
    expect(await jurisdiction(s.studioId)).toBeUndefined();
    expect(await v2(s.studioId, { failed: [b, a, a], evidence: EVIDENCE })).toBe("initialized");
    expect((await audit(s.studioId))[0].failed_attempts_acknowledged).toEqual([a, b].sort());
  });

  it("A4 an id given while nothing needs one is stale, and a wrong id is stale", async () => {
    const clean = await activeCa("a4-clean");
    expect(await v2(clean.studioId, { failed: [randomUUID()], evidence: EVIDENCE })).toBe("refused_failed_attempt_acknowledgement_stale");
    const s = await activeCa("a4");
    await attempt(s);
    expect(await v2(s.studioId, { failed: [randomUUID()], evidence: EVIDENCE })).toBe("refused_failed_attempt_acknowledgement_stale");
  });

  it("A5 ids without the evidence value, a wrong value, or the value without ids is invalid_input and writes nothing", async () => {
    const s = await activeCa("a5");
    const id = await attempt(s);
    expect(await v2(s.studioId, { failed: [id] })).toBe("invalid_input");
    expect(await v2(s.studioId, { failed: [id], evidence: "free text" })).toBe("invalid_input");
    expect(await v2(s.studioId, { evidence: EVIDENCE })).toBe("invalid_input");
    expect(await v2(s.studioId, { failed: [], evidence: EVIDENCE })).toBe("invalid_input");
    expect(await adminQuery(`select * from public.initialize_studio_payment_jurisdiction_from_history_v2($1,'CA','cad','a','r','ref',false,null,null,$2::uuid[],$3)`,
      [s.studioId, [id, null], EVIDENCE]).then((r) => r.rows[0].out_result)).toBe("invalid_input");
    expect(await jurisdiction(s.studioId)).toBeUndefined();
    expect((await audit(s.studioId)).length).toBe(0);
  });

  it("A6 a studio with no failed attempt initializes through v2 with an empty audit field", async () => {
    const s = await activeCa("a6");
    expect(await v2(s.studioId)).toBe("initialized");
    expect(await audit(s.studioId)).toEqual([{
      to_country: "CA", to_currency: "cad", history_verified: true, unbound_test_attempts_acknowledged: [],
      failed_attempts_acknowledged: [], failed_attempts_evidence: null,
    }]);
  });
});

// ---------------------------------------------------------------------------
describe("J10-B nothing else is cured", () => {
  it.each([
    ["pending", { status: "pending" as const }],
    ["processing", { status: "processing" as const, claim: true }],
  ])("B1 a %s live null-account attempt still refuses, even acknowledged", async (_n, o) => {
    const s = await activeCa(`b1-${_n}`);
    const id = await attempt(s, o);
    expect(await v2(s.studioId)).toBe("refused_account_unverified");
    expect(await v2(s.studioId, { failed: [id], evidence: EVIDENCE })).toBe("refused_account_unverified");
    expect(await jurisdiction(s.studioId)).toBeUndefined();
  });

  it("B2 a failed attempt that is not terminal, or that holds a claim token, still refuses", async () => {
    for (const [label, o] of [["open", { terminal: false }], ["claimed", { claim: true }]] as const) {
      const s = await activeCa(`b2-${label}`);
      const id = await attempt(s, o);
      expect(await v2(s.studioId, { failed: [id], evidence: EVIDENCE }), label).toBe("refused_account_unverified");
    }
  });

  it("B3 a qualifying attempt does not excuse a second, non-qualifying one", async () => {
    const s = await activeCa("b3");
    const ok = await attempt(s);
    await attempt(s, { status: "pending" });
    expect(await v2(s.studioId, { failed: [ok], evidence: EVIDENCE })).toBe("refused_account_unverified");
  });

  it("B4 a live attempt that DID name an account is not covered", async () => {
    const s = await activeCa("b4");
    const id = await attempt(s, { account: `acct_L${rid()}` });
    expect(await v2(s.studioId, { failed: [id], evidence: EVIDENCE })).toBe("refused_account_unverified");
  });

  it("B5 other 0214 refusals are unchanged: usd history, and an observed US account", async () => {
    const a = await activeCa("b5-usd");
    const id = await attempt(a);
    await raw("payment_charge_attempts", {
      studio_id: a.studioId, charge_reason: "no_show_fee", client_id: a.clientId,
      created_by_practitioner_id: a.practitionerId, appointment_id: randomUUID(), amount_cents: 5000,
      currency: "usd", status: "ready", stripe_livemode: false, stripe_account_id: null,
    });
    expect(await v2(a.studioId, { failed: [id], evidence: EVIDENCE })).toBe("refused_currency_history");
    const b = await studio("b5-us");
    await raw("studio_payment_settings", {
      studio_id: b.studioId, stripe_account_id: `acct_L${rid()}`, stripe_livemode: true,
      stripe_account_status: "enabled", stripe_account_country: "US",
    });
    const bid = await attempt(b);
    expect(await v2(b.studioId, { failed: [bid], evidence: EVIDENCE })).toBe("refused_account_mismatch");
  });
});

// ---------------------------------------------------------------------------
describe("J10-C test mode and other countries", () => {
  it("C1 a failed TEST-mode null-account attempt is acknowledged through the test array, not the failed array", async () => {
    const s = await activeCa("c1");
    const id = await attempt(s, { live: false });
    expect(await v2(s.studioId)).toBe("refused_test_account_unobserved");
    expect(await v2(s.studioId, { failed: [id], evidence: EVIDENCE })).toBe("refused_failed_attempt_acknowledgement_stale");
    expect(await v2(s.studioId, { testAttempts: [id] })).toBe("initialized");
    expect((await audit(s.studioId))[0]).toMatchObject({
      unbound_test_attempts_acknowledged: [id], failed_attempts_acknowledged: [], failed_attempts_evidence: null,
    });
  });

  it("C2 test and live failed attempts together need both acknowledgements", async () => {
    const s = await activeCa("c2");
    const t = await attempt(s, { live: false });
    const l = await attempt(s);
    expect(await v2(s.studioId, { testAttempts: [t] })).toBe("refused_failed_attempt_unacknowledged");
    expect(await v2(s.studioId, { failed: [l], evidence: EVIDENCE })).toBe("refused_test_account_unobserved");
    expect(await v2(s.studioId, { testAttempts: [t], failed: [l], evidence: EVIDENCE })).toBe("initialized");
  });

  it("C3 a US/usd studio is unaffected, and v2 repeats unchanged / refused_already_initialized like v1", async () => {
    const s = await studio("c3");
    await raw("studio_payment_settings", {
      studio_id: s.studioId, stripe_account_id: `acct_L${rid()}`, stripe_livemode: true,
      stripe_account_status: "enabled", stripe_account_country: "US",
    });
    expect(await v2(s.studioId, { country: "US", currency: "usd" })).toBe("initialized");
    expect(await v2(s.studioId, { country: "US", currency: "usd" })).toBe("unchanged");
    expect(await v2(s.studioId, { country: "CA", currency: "cad" })).toBe("refused_already_initialized");
    expect(await audit(s.studioId)).toEqual([{
      to_country: "US", to_currency: "usd", history_verified: true, unbound_test_attempts_acknowledged: [],
      failed_attempts_acknowledged: [], failed_attempts_evidence: null,
    }]);
  });

  it("C4 v1 behaves as before: a studio with a failed live null-account attempt stays refused and v1 has no knowledge of the new fields", async () => {
    const s = await activeCa("c4");
    const id = await attempt(s);
    expect(await v1(s.studioId, { testAttempts: [id] })).toBe("refused_account_unverified");
    expect(await jurisdiction(s.studioId)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
describe("J10-D audit columns", () => {
  it("D1 the check constraint pairs the ids with the fixed evidence value", async () => {
    const s = await activeCa("d1");
    const ins = (ids: string[], ev: string | null) => adminQuery(
      `insert into public.studio_payment_jurisdiction_changes
         (studio_id, to_country, to_currency, actor, reason, verification_reference, failed_attempts_acknowledged, failed_attempts_evidence)
       values ($1,'CA','cad','a','r','ref',$2::uuid[],$3)`, [s.studioId, ids, ev]);
    for (const [ids, ev] of [
      [[randomUUID()], null],
      [[randomUUID()], "free text"],
      [[], EVIDENCE],
    ] as const) {
      await expect(ins([...ids], ev)).rejects.toThrow(/studio_payment_jurisdiction_changes_failed_evidence_check/);
    }
    await ins([], null);
    await ins([randomUUID()], EVIDENCE);
  });
});

// ---------------------------------------------------------------------------
describe("J10-E privileges", () => {
  const V2SIG = "public.initialize_studio_payment_jurisdiction_from_history_v2(uuid,text,text,text,text,text,boolean,text[],uuid[],uuid[],text)";
  const V1SIG = "public.initialize_studio_payment_jurisdiction_from_history(uuid,text,text,text,text,text,boolean,text[],uuid[])";
  const HELPERS = [
    "public.studio_account_acceptable_for_jurisdiction(uuid,text,boolean,text,boolean)",
    "public.studio_named_stripe_accounts(uuid)",
  ];

  it("E1 only service_role may execute v2, PUBLIC holds nothing, and v2 is security definer with a pinned search_path", async () => {
    const r = await adminQuery(`select role_name, has_function_privilege(role_name, $1, 'EXECUTE') ok
      from unnest(array['anon','authenticated','service_role']) role_name`, [V2SIG]);
    expect(r.rows).toEqual([
      { role_name: "anon", ok: false }, { role_name: "authenticated", ok: false }, { role_name: "service_role", ok: true },
    ]);
    const p = await adminQuery(
      `select array_to_string(proacl, ',') acl, prosecdef, array_to_string(proconfig, ',') cfg
         from pg_proc where oid = $1::regprocedure`, [V2SIG]);
    expect(p.rows[0].acl).not.toMatch(/(^|,)=X/);
    expect(p.rows[0].prosecdef).toBe(true);
    expect(p.rows[0].cfg).toMatch(/search_path=pg_catalog, pg_temp/);
  });

  it("E2 v1 is still granted to service_role only, and no role may execute either 0214 helper", async () => {
    const r = await adminQuery(`select role_name, has_function_privilege(role_name, $1, 'EXECUTE') ok
      from unnest(array['anon','authenticated','service_role']) role_name`, [V1SIG]);
    expect(r.rows.map((x) => x.ok)).toEqual([false, false, true]);
    for (const fn of HELPERS) {
      const h = await adminQuery(`select bool_or(has_function_privilege(role_name, $1, 'EXECUTE')) any_ok
        from unnest(array['anon','authenticated','service_role']) role_name`, [fn]);
      expect(h.rows[0].any_ok, fn).toBe(false);
      const acl = await adminQuery(`select array_to_string(proacl, ',') acl from pg_proc where oid = $1::regprocedure`, [fn]);
      expect(acl.rows[0].acl, fn).toBe("postgres=X/postgres");
    }
  });

  it.each(["anon", "authenticated"] as const)("E3 %s cannot call v2", async (role) => {
    let msg = "";
    try {
      await asRole(role, (q) => q(
        `select * from public.initialize_studio_payment_jurisdiction_from_history_v2(gen_random_uuid(),'CA','cad','a','r','ref',false,null,null,null,null)`));
    } catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/permission denied/);
  });

  it("E4 service_role can call v2 and still cannot call a helper or write the audit table", async () => {
    await asRole("service_role", (q) => q(
      `select * from public.initialize_studio_payment_jurisdiction_from_history_v2(gen_random_uuid(),'CA','cad','a','r','ref',false,null,null,null,null)`));
    for (const sql of [
      `select public.studio_named_stripe_accounts(gen_random_uuid())`,
      `update public.studio_payment_jurisdiction_changes set failed_attempts_evidence = null`,
    ]) {
      let msg = "";
      try { await asRole("service_role", (q) => q(sql)); } catch (e) { msg = (e as Error).message; }
      expect(msg, sql).toMatch(/permission denied/);
    }
  });
});
