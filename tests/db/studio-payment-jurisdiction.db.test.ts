import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import {
  adminQuery,
  asRole,
  asUser,
  closePool,
  resolveLocalDbUrl,
  seedStudio,
  type SeededStudio,
} from "./helpers/harness";

// ===========================================================================
// 0214 — PAY-CCY-02 (#824): per-studio payment country and currency
// ===========================================================================
//
// Real database, real roles. Proves:
//   J1  unknown stays missing; only explicitly verified onboarding creates a pair;
//   J2  no browser role can read, write or call any of it;
//   J3  the protected change command: allowed pairs only, audited, and refused
//       once an account, money history or (unacknowledged) prices exist;
//   J4  a charge attempt is prepared in its studio's currency, on an account in
//       its studio's COUNTRY — country and currency are checked separately;
//   J5  a prepared attempt's amount and currency never change;
//   J6  a settlement is recorded in its studio's currency;
//   J7  what Stripe says about an account is recorded write-once for country;
//   J8  stale configuration fails closed under a real concurrent change.

const created: SeededStudio[] = [];

async function studio(label: string, verifiedPaymentJurisdiction = true): Promise<SeededStudio> {
  const s = await seedStudio(`ccy-${label}`, { verifiedPaymentJurisdiction });
  created.push(s);
  return s;
}

afterAll(async () => {
  for (const s of created) {
    for (const sql of [
      `delete from public.payment_charge_attempts where studio_id=$1`,
      `delete from public.studio_payment_settings where studio_id=$1`,
      `delete from public.stripe_account_provisioning_attempts where studio_id=$1`,
      `delete from public.services where studio_id=$1`,
      `delete from public.appointments where studio_id=$1`,
      `delete from public.studios where id=$1`,
    ]) {
      // Settlements are undeletable by design (0187), so a studio that holds
      // one stays behind, exactly as in appointment-settlement.db.test.ts.
      await adminQuery(sql, [s.studioId]).catch(() => undefined);
    }
  }
  await closePool();
});

async function jurisdiction(studioId: string) {
  const r = await adminQuery(
    `select payment_country, payment_currency, source
       from public.studio_payment_jurisdictions where studio_id=$1`,
    [studioId],
  );
  return r.rows[0] as
    | { payment_country: string; payment_currency: string; source: string }
    | undefined;
}

async function setJurisdiction(
  studioId: string,
  country: string,
  currency: string,
  ack = false,
  actor = "operator:test",
  reason = "verified business country and charge currency",
  verificationReference: string | null = "fixture:verified-owner-onboarding",
) {
  const r = await adminQuery(
    `select * from public.set_studio_payment_jurisdiction($1,$2,$3,$4,$5,$6,$7)`,
    [studioId, country, currency, actor, reason, ack, verificationReference],
  );
  return r.rows[0] as {
    out_result: string;
    out_payment_country: string | null;
    out_payment_currency: string | null;
  };
}

async function bindAccount(
  studioId: string,
  opts: { accountId?: string; country?: string | null } = {},
) {
  const accountId = opts.accountId ?? `acct_test_${randomUUID().slice(0, 12)}`;
  await adminQuery(
    `insert into public.studio_payment_settings
       (studio_id, stripe_account_id, stripe_account_status, stripe_charges_enabled,
        stripe_payouts_enabled, stripe_livemode, stripe_account_country)
     values ($1,$2,'enabled',true,true,false,$3)`,
    [studioId, accountId, opts.country ?? null],
  );
  return accountId;
}

// Each appointment gets its own past hour, so several on one practitioner never
// collide with the appointment overlap exclusion.
let slot = 0;
async function appointment(s: SeededStudio) {
  slot += 1;
  const base = Date.now() - slot * 2 * 3_600_000;
  const starts = new Date(base - 60 * 60_000).toISOString();
  const ends = new Date(base).toISOString();
  const r = await adminQuery(
    `insert into public.appointments
       (studio_id, practitioner_id, client_id, starts_at, ends_at, duration_minutes, status)
     values ($1,$2,$3,$4,$5,60,'completed') returning id`,
    [s.studioId, s.practitionerId, s.clientId, starts, ends],
  );
  return r.rows[0].id as string;
}

/** A no-show fee attempt: the smallest legal payment_charge_attempts row. */
async function insertAttempt(
  s: SeededStudio,
  currency: string,
  accountId: string | null = null,
  query: (t: string, p?: unknown[]) => Promise<{ rows: Array<{ id: string }> }> = adminQuery,
) {
  const appt = await appointment(s);
  const r = await query(
    `insert into public.payment_charge_attempts
       (studio_id, charge_reason, client_id, appointment_id, created_by_practitioner_id,
        amount_cents, currency, status, stripe_livemode, stripe_account_id)
     values ($1,'no_show_fee',$2,$3,$4,5000,$5,'ready',false,$6) returning id`,
    [s.studioId, s.clientId, appt, s.practitionerId, currency, accountId],
  );
  return r.rows[0].id;
}

async function rejection(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("expected the statement to be refused");
}

// ---------------------------------------------------------------------------
describe("J1 verified jurisdiction only", () => {
  it("a new studio remains UNKNOWN: no automatic country/currency row", async () => {
    const s = await studio("j1-unknown", false);
    expect(await jurisdiction(s.studioId)).toBeUndefined();
    const claim = adminQuery(`select * from public.create_or_claim_stripe_account_provisioning($1,false)`, [s.studioId]);
    expect(await rejection(claim)).toMatch(/payment_jurisdiction_missing/);
  });

  it("explicit pair without verification evidence changes nothing", async () => {
    const s = await studio("j1-unverified", false);
    expect((await setJurisdiction(s.studioId, "CA", "cad", false, "operator:test", "onboarding", null)).out_result).toBe("verification_required");
    expect(await jurisdiction(s.studioId)).toBeUndefined();
  });

  it.each([["CA", "cad"], ["US", "usd"]])("verified %s/%s initialization records actor/evidence without a guessed prior pair", async (country, currency) => {
    const s = await studio(`j1-${country}`, false);
    expect((await setJurisdiction(s.studioId, country, currency)).out_result).toBe("initialized");
    expect(await jurisdiction(s.studioId)).toEqual({ payment_country: country, payment_currency: currency, source: "operator" });
    const audit = await adminQuery(`select from_country, from_currency, actor, verification_reference from public.studio_payment_jurisdiction_changes where studio_id=$1`, [s.studioId]);
    expect(audit.rows).toEqual([{ from_country: null, from_currency: null, actor: "operator:test", verification_reference: "fixture:verified-owner-onboarding" }]);
  });

  it("even verified initialization refuses an existing account and leaves UNKNOWN", async () => {
    const s = await studio("j1-bound-unknown", false);
    await bindAccount(s.studioId, { country: "CA" });
    expect((await setJurisdiction(s.studioId, "CA", "cad")).out_result).toBe("refused_payment_account");
    expect(await jurisdiction(s.studioId)).toBeUndefined();
  });

  it("initialization never reinterprets recorded money", async () => {
    const s = await studio("j1-money-unknown");
    await insertAttempt(s, "cad");
    await adminQuery(`delete from public.studio_payment_jurisdictions where studio_id=$1`, [s.studioId]);
    expect((await setJurisdiction(s.studioId, "US", "usd")).out_result).toBe("refused_monetary_history");
    expect(await jurisdiction(s.studioId)).toBeUndefined();
    expect((await adminQuery(`select currency from public.payment_charge_attempts where studio_id=$1`, [s.studioId])).rows.map((r) => r.currency)).toEqual(["cad"]);
  });

  it("the pair CHECK refuses a mixed pair even for the owner role", async () => {
    const s = await studio("j1b");
    const msg = await rejection(
      adminQuery(
        `update public.studio_payment_jurisdictions
            set payment_country='US' where studio_id=$1`,
        [s.studioId],
      ),
    );
    expect(msg).toMatch(/studio_payment_jurisdictions_pair_check/);
  });
});

// ---------------------------------------------------------------------------
describe("J2 no browser role reaches the jurisdiction", () => {
  for (const role of ["anon", "authenticated"] as const) {
    it(`${role}: cannot read either table or call either command`, async () => {
      for (const sql of [
        `select 1 from public.studio_payment_jurisdictions limit 1`,
        `select 1 from public.studio_payment_jurisdiction_changes limit 1`,
        `select * from public.set_studio_payment_jurisdiction(gen_random_uuid(),'US','usd','x','y',false)`,
        `select * from public.record_stripe_account_jurisdiction(gen_random_uuid(),'acct_x',false,'US','usd')`,
      ]) {
        const msg = await rejection(asRole(role, (q) => q(sql)));
        expect(msg).toMatch(/permission denied/);
      }
    });
  }

  it("a signed-in OWNER cannot change their own studio's jurisdiction", async () => {
    const s = await studio("j2");
    const msg = await rejection(
      asUser(s.userId, (q) =>
        q(`update public.studio_payment_jurisdictions set payment_country='US',
             payment_currency='usd' where studio_id=$1`, [s.studioId]),
      ),
    );
    expect(msg).toMatch(/permission denied/);
    expect((await jurisdiction(s.studioId))?.payment_country).toBe("CA");
  });

  it("service_role may read and call; it may not write the tables directly", async () => {
    await asRole("service_role", async (q) => {
      await q(`select 1 from public.studio_payment_jurisdictions limit 1`);
      await q(
        `select * from public.set_studio_payment_jurisdiction(gen_random_uuid(),'US','usd','x','y',false)`,
      );
    });
    const msg = await rejection(
      asRole("service_role", (q) =>
        q(`update public.studio_payment_jurisdictions set source='operator'`),
      ),
    );
    expect(msg).toMatch(/permission denied/);
  });
});

// ---------------------------------------------------------------------------
describe("J3 the protected change command", () => {
  it.each([
    ["CA", "usd"],
    ["US", "cad"],
    ["MX", "mxn"],
    ["", ""],
  ])("refuses the pair %s/%s as invalid_input", async (country, currency) => {
    const s = await studio("j3-invalid");
    expect((await setJurisdiction(s.studioId, country, currency)).out_result).toBe(
      "invalid_input",
    );
  });

  it("requires an actor and a reason", async () => {
    const s = await studio("j3-actor");
    expect((await setJurisdiction(s.studioId, "US", "usd", false, " ", "r")).out_result).toBe(
      "invalid_input",
    );
    expect((await setJurisdiction(s.studioId, "US", "usd", false, "a", "")).out_result).toBe(
      "invalid_input",
    );
  });

  it("not_found for a studio that does not exist", async () => {
    expect((await setJurisdiction(randomUUID(), "US", "usd")).out_result).toBe("not_found");
  });

  it("changes a clean studio to US/usd, audited, and is idempotent", async () => {
    const s = await studio("j3-clean");
    expect(await setJurisdiction(s.studioId, "us", "USD")).toEqual({
      out_result: "changed",
      out_payment_country: "US",
      out_payment_currency: "usd",
    });
    expect(await jurisdiction(s.studioId)).toEqual({
      payment_country: "US",
      payment_currency: "usd",
      source: "operator",
    });
    const audit = await adminQuery(
      `select from_country, from_currency, to_country, to_currency, actor, prices_acknowledged
         from public.studio_payment_jurisdiction_changes where studio_id=$1 and actor='operator:test'`,
      [s.studioId],
    );
    expect(audit.rows).toEqual([
      {
        from_country: "CA",
        from_currency: "cad",
        to_country: "US",
        to_currency: "usd",
        actor: "operator:test",
        prices_acknowledged: false,
      },
    ]);
    expect((await setJurisdiction(s.studioId, "US", "usd", true, "operator:other", "reconfirmed", "fixture:new-reference")).out_result).toBe("unchanged");
    const count = await adminQuery(
      `select count(*)::int as n from public.studio_payment_jurisdiction_changes where studio_id=$1 and actor='operator:test'`,
      [s.studioId],
    );
    expect(count.rows[0].n).toBe(1);
    const unchangedEvidence = await adminQuery(`select verification_reference from public.studio_payment_jurisdictions where studio_id=$1`, [s.studioId]);
    expect(unchangedEvidence.rows[0].verification_reference).toBe("fixture:verified-owner-onboarding");
  });

  it("configured prices refuse unless explicitly acknowledged", async () => {
    const s = await studio("j3-prices");
    await adminQuery(
      `insert into public.services (studio_id, name, default_duration_minutes, price_cents, active, modality)
       values ($1,'Electrolysis 30',30,9000,true,'electrolysis')`,
      [s.studioId],
    );
    expect((await setJurisdiction(s.studioId, "US", "usd")).out_result).toBe(
      "refused_priced_configuration",
    );
    expect((await jurisdiction(s.studioId))?.payment_country).toBe("CA");
    expect((await setJurisdiction(s.studioId, "US", "usd", true)).out_result).toBe("changed");
    const audit = await adminQuery(
      `select prices_acknowledged from public.studio_payment_jurisdiction_changes where studio_id=$1 and actor='operator:test'`,
      [s.studioId],
    );
    expect(audit.rows).toEqual([{ prices_acknowledged: true }]);
  });

  it("a bound Stripe account (any mode) refuses, even with prices acknowledged", async () => {
    const s = await studio("j3-account");
    await bindAccount(s.studioId);
    expect((await setJurisdiction(s.studioId, "US", "usd", true)).out_result).toBe(
      "refused_payment_account",
    );
  });

  it("a provisioning attempt alone refuses", async () => {
    const s = await studio("j3-prov");
    await adminQuery(
      `insert into public.stripe_account_provisioning_attempts (studio_id, status, idempotency_key)
       values ($1,'failed',$2)`,
      [s.studioId, `idem-${randomUUID()}`],
    );
    expect((await setJurisdiction(s.studioId, "US", "usd", true)).out_result).toBe(
      "refused_payment_account",
    );
  });

  it("a charge attempt refuses as monetary history", async () => {
    const s = await studio("j3-attempt");
    await insertAttempt(s, "cad");
    expect((await setJurisdiction(s.studioId, "US", "usd", true)).out_result).toBe(
      "refused_monetary_history",
    );
  });

  it("a settlement refuses as monetary history", async () => {
    const s = await studio("j3-settle");
    const appt = await appointment(s);
    await asUser(s.userId, (q) =>
      q(`select * from public.record_appointment_settlement($1,$2,'paid_cash',4500,null,false)`, [
        s.studioId,
        appt,
      ]),
    );
    expect((await setJurisdiction(s.studioId, "US", "usd", true)).out_result).toBe(
      "refused_monetary_history",
    );
  });
});

// ---------------------------------------------------------------------------
describe("J4 attempts follow the studio's currency AND its account's country", () => {
  it("Canadian regression: a cad attempt with no account (legacy) is accepted", async () => {
    const s = await studio("j4-ca");
    await expect(insertAttempt(s, "cad")).resolves.toBeTruthy();
  });

  it("Canadian regression: a cad attempt on an UNOBSERVED account is accepted", async () => {
    const s = await studio("j4-ca-legacy");
    const acct = await bindAccount(s.studioId, { country: null });
    await expect(insertAttempt(s, "cad", acct)).resolves.toBeTruthy();
  });

  it("a usd attempt is refused for a Canadian studio", async () => {
    const s = await studio("j4-ca-usd");
    expect(await rejection(insertAttempt(s, "usd"))).toMatch(/payment_currency_mismatch/);
  });

  it("a US studio prepares usd on an account observed as US", async () => {
    const s = await studio("j4-us");
    await setJurisdiction(s.studioId, "US", "usd");
    const acct = await bindAccount(s.studioId, { country: "US" });
    await expect(insertAttempt(s, "usd", acct)).resolves.toBeTruthy();
  });

  it("a US studio cannot prepare cad (stale or wrong configuration)", async () => {
    const s = await studio("j4-us-cad");
    await setJurisdiction(s.studioId, "US", "usd");
    const acct = await bindAccount(s.studioId, { country: "US" });
    expect(await rejection(insertAttempt(s, "cad", acct))).toMatch(/payment_currency_mismatch/);
  });

  it("COUNTRY IS CHECKED ON ITS OWN: right currency, account in the wrong country", async () => {
    const s = await studio("j4-us-ca-acct");
    await setJurisdiction(s.studioId, "US", "usd");
    const acct = await bindAccount(s.studioId, { country: "CA" });
    expect(await rejection(insertAttempt(s, "usd", acct))).toMatch(
      /payment_account_country_mismatch/,
    );
  });

  it("a Canadian studio on an account observed as US is refused", async () => {
    const s = await studio("j4-ca-us-acct");
    const acct = await bindAccount(s.studioId, { country: "US" });
    expect(await rejection(insertAttempt(s, "cad", acct))).toMatch(
      /payment_account_country_mismatch/,
    );
  });

  it("a US studio on an account Hone has never observed is refused", async () => {
    const s = await studio("j4-us-unobserved");
    await setJurisdiction(s.studioId, "US", "usd");
    const acct = await bindAccount(s.studioId, { country: null });
    expect(await rejection(insertAttempt(s, "usd", acct))).toMatch(
      /payment_account_country_unverified/,
    );
    expect(await rejection(insertAttempt(s, "usd", null))).toMatch(
      /payment_account_country_unverified/,
    );
  });
});

// ---------------------------------------------------------------------------
describe("J5 a prepared attempt's money is immutable", () => {
  it("refuses a changed amount or currency; status writes are untouched", async () => {
    const s = await studio("j5");
    const id = await insertAttempt(s, "cad");
    expect(
      await rejection(
        adminQuery(`update public.payment_charge_attempts set amount_cents=5001 where id=$1`, [id]),
      ),
    ).toMatch(/fixed when the attempt is prepared/);
    expect(
      await rejection(
        adminQuery(`update public.payment_charge_attempts set currency='usd' where id=$1`, [id]),
      ),
    ).toMatch(/fixed when the attempt is prepared/);
    await adminQuery(
      `update public.payment_charge_attempts set status='cancelled', cancelled_at=now(),
              cancelled_reason='test' where id=$1`,
      [id],
    ).catch(async () => {
      // Whatever the cancel shape requires, an ordinary non-money update works.
      await adminQuery(`update public.payment_charge_attempts set internal_note='n' where id=$1`, [id]);
    });
    const row = await adminQuery(
      `select amount_cents, currency from public.payment_charge_attempts where id=$1`,
      [id],
    );
    expect(row.rows[0]).toEqual({ amount_cents: 5000, currency: "cad" });
  });
});

// ---------------------------------------------------------------------------
describe("J6 settlements are recorded in the studio's currency", () => {
  it.each([
    ["CA", "cad"],
    ["US", "usd"],
  ])("%s studio -> %s", async (country, currency) => {
    const s = await studio(`j6-${country}`);
    if (country === "US") await setJurisdiction(s.studioId, "US", "usd");
    const appt = await appointment(s);
    const out = await asUser(s.userId, async (q) => {
      const r = await q(
        `select * from public.record_appointment_settlement($1,$2,'paid_cash',4500,null,false)`,
        [s.studioId, appt],
      );
      return r.rows[0] as { result: string; settlement_id: string };
    });
    expect(out.result).toBe("recorded");
    const row = await adminQuery(
      `select currency, amount_cents from public.appointment_settlements where id=$1`,
      [out.settlement_id],
    );
    expect(row.rows[0]).toEqual({ currency, amount_cents: 4500 });
  });
});

// ---------------------------------------------------------------------------
describe("J7 recording what Stripe says about an account", () => {
  async function record(studioId: string, acct: string, country: string, currency: string | null) {
    const r = await adminQuery(
      `select * from public.record_stripe_account_jurisdiction($1,$2,false,$3,$4)`,
      [studioId, acct, country, currency],
    );
    return r.rows[0];
  }

  it("not_bound for an account the studio does not hold", async () => {
    const s = await studio("j7-unbound");
    expect((await record(s.studioId, "acct_nobody", "CA", "cad")).out_result).toBe("not_bound");
  });

  it("records once, refreshes the currency, and never overwrites the country", async () => {
    const s = await studio("j7");
    await setJurisdiction(s.studioId, "US", "usd");
    const acct = await bindAccount(s.studioId);
    expect(await record(s.studioId, acct, "us", "USD")).toEqual({
      out_result: "recorded",
      out_account_country: "US",
      out_payment_country: "US",
      out_matches: true,
    });
    expect((await record(s.studioId, acct, "US", "usd")).out_result).toBe("refreshed");
    expect(await record(s.studioId, acct, "CA", "cad")).toMatchObject({
      out_result: "country_conflict",
      out_account_country: "US",
      out_matches: false,
    });
    const row = await adminQuery(
      `select stripe_account_country, stripe_account_country_conflict,
              stripe_account_country_conflict_at is not null as conflict_dated
         from public.studio_payment_settings where stripe_account_id=$1`,
      [acct],
    );
    expect(row.rows[0]).toEqual({
      stripe_account_country: "US",
      stripe_account_country_conflict: "CA",
      conflict_dated: true,
    });
  });

  // Codex P1 4244834151: the conflict used to be returned and then forgotten,
  // so the recorded country (which matched) kept every charge path open.
  it("A PERSISTED CONFLICT STOPS CHARGING, even though the recorded country matches", async () => {
    const s = await studio("j7-conflict-blocks");
    await setJurisdiction(s.studioId, "US", "usd");
    const acct = await bindAccount(s.studioId);
    expect((await record(s.studioId, acct, "US", "usd")).out_matches).toBe(true);
    // Negative control: before the conflict, the same insert is accepted.
    await expect(insertAttempt(s, "usd", acct)).resolves.toBeTruthy();

    expect((await record(s.studioId, acct, "CA", "cad")).out_result).toBe("country_conflict");
    expect(await rejection(insertAttempt(s, "usd", acct))).toMatch(
      /payment_account_country_conflict/,
    );

    // A later report that agrees again does not clear it.
    expect(await record(s.studioId, acct, "US", "usd")).toMatchObject({
      out_result: "country_conflict",
      out_account_country: "US",
      out_matches: false,
    });
    expect(await rejection(insertAttempt(s, "usd", acct))).toMatch(
      /payment_account_country_conflict/,
    );
  });

  it("a conflict on a legacy Canadian account blocks it too", async () => {
    const s = await studio("j7-conflict-ca");
    const acct = await bindAccount(s.studioId);
    expect((await record(s.studioId, acct, "CA", "cad")).out_result).toBe("recorded");
    expect((await record(s.studioId, acct, "US", "usd")).out_result).toBe("country_conflict");
    expect(await rejection(insertAttempt(s, "cad", acct))).toMatch(
      /payment_account_country_conflict/,
    );
  });

  it("the conflict column is bound to a recorded, different country", async () => {
    const s = await studio("j7-conflict-shape");
    const acct = await bindAccount(s.studioId, { country: "CA" });
    for (const [conflict, at] of [
      ["US", null],
      ["CA", "now()"],
      [null, "now()"],
    ] as const) {
      expect(
        await rejection(
          adminQuery(
            `update public.studio_payment_settings
                set stripe_account_country_conflict = $2,
                    stripe_account_country_conflict_at = ${at ?? "null"}
              where stripe_account_id = $1`,
            [acct, conflict],
          ),
        ),
      ).toMatch(/studio_payment_settings_account_country_conflict_check/);
    }
  });

  it("reports a mismatch with the studio's country without hiding it", async () => {
    const s = await studio("j7-mismatch");
    const acct = await bindAccount(s.studioId);
    expect(await record(s.studioId, acct, "US", "usd")).toMatchObject({
      out_result: "recorded",
      out_payment_country: "CA",
      out_matches: false,
    });
  });

  it("refuses malformed input", async () => {
    const s = await studio("j7-bad");
    const acct = await bindAccount(s.studioId);
    expect((await record(s.studioId, acct, "USA", "usd")).out_result).toBe("invalid_input");
    expect((await record(s.studioId, acct, "US", "dollars")).out_result).toBe("invalid_input");
  });
});

// ---------------------------------------------------------------------------
describe("J8 stale configuration fails closed under a concurrent change", () => {
  it("payment jurisdiction SHARE then parent FK KEY SHARE cannot deadlock the setter", async () => {
    const s = await studio("j8-parent-keyshare");
    const appt = await appointment(s);
    const pool = new Pool({ connectionString: resolveLocalDbUrl(), max: 2 });
    const payer = await pool.connect();
    const setter = await pool.connect();
    let pending: Promise<{ result: string | null; error: unknown }> | undefined;
    try {
      await payer.query("begin isolation level read committed");
      await setter.query("begin isolation level read committed");
      await payer.query("set local statement_timeout = '3s'");
      await setter.query("set local statement_timeout = '5s'");
      const payerPid = (await payer.query("select pg_backend_pid() pid")).rows[0].pid as number;
      const setterPid = (await setter.query("select pg_backend_pid() pid")).rows[0].pid as number;
      await payer.query("select 1 from public.studio_payment_jurisdictions where studio_id=$1 for share", [s.studioId]);
      pending = setter.query(
        "select * from public.set_studio_payment_jurisdiction($1,'US','usd','operator:test','race',false,'fixture:parent-keyshare')",
        [s.studioId],
      ).then((r) => ({ result: r.rows[0].out_result as string, error: null }), (error: unknown) => ({ result: null, error }));

      // Observe the setter actually waiting on this payer, not a timing guess.
      // It has passed its parent lock and is blocked at jurisdiction FOR UPDATE.
      const deadline = Date.now() + 2_000;
      let blocked = false;
      while (Date.now() < deadline) {
        const blockers = (await adminQuery("select pg_blocking_pids($1) pids", [setterPid])).rows[0].pids as number[];
        if (blockers.includes(payerPid)) { blocked = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked, "setter must reach the payer-held jurisdiction lock").toBe(true);
      // The FK now needs studio KEY SHARE. Old parent FOR UPDATE creates a
      // cycle here; NO KEY UPDATE lets this matching old-currency insert commit.
      await payer.query(
        `insert into public.payment_charge_attempts
           (studio_id,charge_reason,client_id,appointment_id,created_by_practitioner_id,
            amount_cents,currency,status,stripe_livemode)
         values($1,'no_show_fee',$2,$3,$4,5000,'cad','ready',false)`,
        [s.studioId, s.clientId, appt, s.practitionerId],
      );
      await payer.query("commit");
      expect(await pending).toEqual({ result: "refused_monetary_history", error: null });
      await setter.query("commit");
      expect((await jurisdiction(s.studioId))?.payment_currency).toBe("cad");
    } finally {
      await payer.query("rollback").catch(() => undefined);
      await setter.query("rollback").catch(() => undefined);
      await pending;
      payer.release(); setter.release(); await pool.end();
    }
  }, 15_000);

  it.each(["service", "client-price"] as const)("an in-flight %s insert must be visible before the unacknowledged change", async (kind) => {
    const s = await studio(`j8-price-${kind}`);
    const pool = new Pool({ connectionString: resolveLocalDbUrl(), max: 2 });
    const writer = await pool.connect();
    const setter = await pool.connect();
    let pending: Promise<{ result: string | null; error: unknown }> | undefined;
    try {
      await writer.query("begin isolation level read committed");
      await setter.query("begin isolation level read committed");
      await writer.query("set local statement_timeout = '3s'");
      await setter.query("set local statement_timeout = '5s'");
      const writerPid = (await writer.query("select pg_backend_pid() pid")).rows[0].pid as number;
      const setterPid = (await setter.query("select pg_backend_pid() pid")).rows[0].pid as number;
      if (kind === "service") {
        await writer.query(
          `insert into public.services (studio_id,name,default_duration_minutes,price_cents,active,modality)
           values ($1,'Concurrent price',30,9000,true,'electrolysis')`, [s.studioId],
        );
      } else {
        await writer.query(
          `insert into public.client_pricing (studio_id,client_id,service_name,price_cents)
           values ($1,$2,'Concurrent price',9000)`, [s.studioId, s.clientId],
        );
      }
      // The uncommitted price holds the parent FK KEY SHARE; the setter must
      // wait for it, then read its committed row in a fresh READ COMMITTED query.
      pending = setter.query(
        "select * from public.set_studio_payment_jurisdiction($1,'US','usd','operator:test','price race',false,'fixture:price-race')",
        [s.studioId],
      ).then((r) => ({ result: r.rows[0].out_result as string, error: null }), (error: unknown) => ({ result: null, error }));
      const deadline = Date.now() + 2_000;
      let blocked = false;
      while (Date.now() < deadline) {
        const blockers = (await adminQuery("select pg_blocking_pids($1) pids", [setterPid])).rows[0].pids as number[];
        if (blockers.includes(writerPid)) { blocked = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked, "setter must wait for the uncommitted price FK lock").toBe(true);
      await writer.query("commit");
      expect(await pending).toEqual({ result: "refused_priced_configuration", error: null });
      await setter.query("commit");
      expect((await jurisdiction(s.studioId))?.payment_currency).toBe("cad");
      const audit = await adminQuery(
        "select count(*)::int n from public.studio_payment_jurisdiction_changes where studio_id=$1 and reason='price race'", [s.studioId],
      );
      expect(audit.rows[0].n).toBe(0);
      // A legitimate explicit acknowledgement still works after serialization.
      expect((await setJurisdiction(s.studioId, "US", "usd", true)).out_result).toBe("changed");
    } finally {
      await writer.query("rollback").catch(() => undefined);
      await setter.query("rollback").catch(() => undefined);
      await pending;
      writer.release(); setter.release(); await pool.end();
    }
  }, 15_000);

  it("an attempt prepared against the old currency waits for the change and is refused", async () => {
    const s = await studio("j8");
    const appt = await appointment(s);
    // Two real connections of their own, so the race is between transactions.
    const pool = new Pool({ connectionString: resolveLocalDbUrl(), max: 2 });
    const changer = await pool.connect();
    const preparer = await pool.connect();
    try {
      await changer.query("begin");
      const changed = await changer.query(
        `select * from public.set_studio_payment_jurisdiction($1,'US','usd','operator:test','race',false,'fixture:verified-race')`,
        [s.studioId],
      );
      expect(changed.rows[0].out_result).toBe("changed");

      // The preparer read "cad" before the change committed. Its insert blocks
      // on the jurisdiction row lock the change command holds.
      const pending = preparer
        .query(
          `insert into public.payment_charge_attempts
             (studio_id, charge_reason, client_id, appointment_id, created_by_practitioner_id,
              amount_cents, currency, status, stripe_livemode)
           values ($1,'no_show_fee',$2,$3,$4,5000,'cad','ready',false)`,
          [s.studioId, s.clientId, appt, s.practitionerId],
        )
        .then(
          () => "inserted",
          (e: Error) => e.message,
        );
      await new Promise((r) => setTimeout(r, 300));
      await changer.query("commit");
      expect(await pending).toMatch(/payment_currency_mismatch/);
    } finally {
      await changer.query("rollback").catch(() => undefined);
      changer.release();
      preparer.release();
      await pool.end();
    }
    const n = await adminQuery(
      `select count(*)::int as n from public.payment_charge_attempts where studio_id=$1`,
      [s.studioId],
    );
    expect(n.rows[0].n).toBe(0);
  });

  it("a first attempt committed before the change makes the change refuse", async () => {
    const s = await studio("j8b");
    await insertAttempt(s, "cad");
    expect((await setJurisdiction(s.studioId, "US", "usd", true)).out_result).toBe(
      "refused_monetary_history",
    );
    expect((await jurisdiction(s.studioId))?.payment_currency).toBe("cad");
  });
});

// ---------------------------------------------------------------------------
// Codex P1 4244982189. The Stripe account is created in the country stamped on
// the provisioning claim, and that stamp serializes with the change command.
describe("J9 account provisioning is stamped with the country it is created in", () => {
  type Q = (t: string, p?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
  async function claim(q: Q, studioId: string) {
    const r = await q(
      `select * from public.create_or_claim_stripe_account_provisioning($1,false)`,
      [studioId],
    );
    return r.rows[0] as { attempt_id: string; should_execute_stripe_call: boolean };
  }
  async function stamped(attemptId: string) {
    const r = await adminQuery(
      `select payment_country from public.stripe_account_provisioning_attempts where id=$1`,
      [attemptId],
    );
    return r.rows[0]?.payment_country as string | null;
  }

  it("a claim stamps the explicitly verified studio country (CA fixture, US after a change)", async () => {
    const ca = await studio("j9-ca");
    expect(await stamped((await claim(adminQuery, ca.studioId)).attempt_id)).toBe("CA");
    const us = await studio("j9-us");
    await setJurisdiction(us.studioId, "US", "usd");
    expect(await stamped((await claim(adminQuery, us.studioId)).attempt_id)).toBe("US");
  });

  it("A CHANGE IN FLIGHT IS WAITED FOR: the claim is stamped with the NEW country", async () => {
    const s = await studio("j9-change-first");
    const pool = new Pool({ connectionString: resolveLocalDbUrl(), max: 2 });
    const changer = await pool.connect();
    const claimer = await pool.connect();
    try {
      await changer.query("begin");
      const changed = await changer.query(
        `select * from public.set_studio_payment_jurisdiction($1,'US','usd','operator:test','race',false,'fixture:verified-race')`,
        [s.studioId],
      );
      expect(changed.rows[0].out_result).toBe("changed");
      // The owner's onboarding claim starts while the change is uncommitted.
      let settled = false;
      const pending = claim((t, p) => claimer.query(t, p), s.studioId).finally(() => {
        settled = true;
      });
      await new Promise((r) => setTimeout(r, 300));
      expect(settled).toBe(false); // waiting on the jurisdiction row lock
      await changer.query("commit");
      const c = await pending;
      expect(c.should_execute_stripe_call).toBe(true);
      expect(await stamped(c.attempt_id)).toBe("US");
    } finally {
      await changer.query("rollback").catch(() => undefined);
      changer.release();
      claimer.release();
      await pool.end();
    }
  });

  it("A CLAIM IN FLIGHT WINS: the change waits for it, then refuses", async () => {
    const s = await studio("j9-claim-first");
    const pool = new Pool({ connectionString: resolveLocalDbUrl(), max: 2 });
    const changer = await pool.connect();
    const claimer = await pool.connect();
    try {
      await claimer.query("begin");
      const c = await claim((t, p) => claimer.query(t, p), s.studioId);
      let settled = false;
      const pending = changer
        .query(
          `select * from public.set_studio_payment_jurisdiction($1,'US','usd','operator:test','race',false,'fixture:verified-race')`,
          [s.studioId],
        )
        .finally(() => {
          settled = true;
        });
      await new Promise((r) => setTimeout(r, 300));
      expect(settled).toBe(false); // waiting behind the claim's share lock
      await claimer.query("commit");
      expect((await pending).rows[0].out_result).toBe("refused_payment_account");
      expect(await stamped(c.attempt_id)).toBe("CA");
      expect((await jurisdiction(s.studioId))?.payment_country).toBe("CA");
    } finally {
      await claimer.query("rollback").catch(() => undefined);
      changer.release();
      claimer.release();
      await pool.end();
    }
  });

  it("a pre-0214 stale claim is stamped when it is taken over, and not by a status-only update", async () => {
    const s = await studio("j9-legacy");
    const first = await claim(adminQuery, s.studioId);
    // Simulate a row written before 0214: unstamped, its claim abandoned.
    await adminQuery(
      `alter table public.stripe_account_provisioning_attempts
         disable trigger stripe_account_provisioning_payment_country`,
    );
    try {
      await adminQuery(
        `update public.stripe_account_provisioning_attempts
            set payment_country = null,
                processing_started_at = now() - interval '10 minutes'
          where id = $1`,
        [first.attempt_id],
      );
    } finally {
      await adminQuery(
        `alter table public.stripe_account_provisioning_attempts
           enable trigger stripe_account_provisioning_payment_country`,
      );
    }
    // Negative control: an update that issues no new claim does not stamp.
    await adminQuery(
      `update public.stripe_account_provisioning_attempts set error_message = 'x' where id = $1`,
      [first.attempt_id],
    );
    expect(await stamped(first.attempt_id)).toBeNull();
    const again = await claim(adminQuery, s.studioId);
    expect(again.attempt_id).toBe(first.attempt_id);
    expect(again.should_execute_stripe_call).toBe(true);
    expect(await stamped(again.attempt_id)).toBe("CA");
  });
});
