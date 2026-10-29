import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { adminQuery, closePool, resolveLocalDbUrl, seedStudio, type SeededStudio } from "./helpers/harness";

// JURISDICTION-ONBOARDING PR-2 / migration 0270. The owner confirmation calls
// the INITIALIZE-ONLY command. It must never update a stored pair (the 0214
// command does), so two racing confirmations leave exactly one row and one
// audit row, and the loser is told 'already_set'.

const created: SeededStudio[] = [];
async function studio(label: string): Promise<SeededStudio> {
  const s = await seedStudio(`ownconf-${label}`, { verifiedPaymentJurisdiction: false });
  created.push(s);
  return s;
}

afterAll(async () => {
  for (const s of created) {
    for (const sql of [
      `delete from public.studio_payment_settings where studio_id=$1`,
      `delete from public.studios where id=$1`,
    ]) await adminQuery(sql, [s.studioId]).catch(() => undefined);
  }
  await closePool();
});

type Result = { out_result: string; out_payment_country: string | null; out_payment_currency: string | null };

const NEW_CMD = `select * from public.initialize_studio_payment_jurisdiction_owner($1,$2,$3,$4,$5,$6)`;
const OLD_CMD = `select * from public.set_studio_payment_jurisdiction($1,$2,$3,$4,$5,false,$6)`;
const args = (studioId: string, country: string, currency: string, who = "p1") => [
  studioId,
  country,
  currency,
  `owner:${who}`,
  "owner onboarding confirmation",
  `owner-confirmed:${who}:2026-11-01T00:00:00.000Z:${country}/${currency}`,
];
const ownerCall = (studioId: string, country: string, currency: string, who = "p1") =>
  adminQuery(NEW_CMD, args(studioId, country, currency, who)).then((r) => r.rows[0] as Result);

const auditCount = async (studioId: string) =>
  (
    await adminQuery(
      `select count(*)::int as n from public.studio_payment_jurisdiction_changes where studio_id=$1`,
      [studioId],
    )
  ).rows[0].n as number;

describe("initialize-only owner confirmation", () => {
  it("initializes a studio with no row and audits the owner actor and reference", async () => {
    const s = await studio("init");
    expect((await ownerCall(s.studioId, "US", "usd")).out_result).toBe("initialized");
    const row = await adminQuery(
      `select payment_country, payment_currency from public.studio_payment_jurisdictions where studio_id=$1`,
      [s.studioId],
    );
    expect(row.rows[0]).toEqual({ payment_country: "US", payment_currency: "usd" });
    const audit = await adminQuery(
      `select actor, reason, verification_reference, from_country from public.studio_payment_jurisdiction_changes where studio_id=$1`,
      [s.studioId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].actor).toBe("owner:p1");
    expect(audit.rows[0].from_country).toBeNull();
    expect(audit.rows[0].verification_reference).toContain("owner-confirmed:p1:");
  });

  it("the same pair again is unchanged and adds no history", async () => {
    const s = await studio("repeat");
    await ownerCall(s.studioId, "CA", "cad");
    expect((await ownerCall(s.studioId, "CA", "cad")).out_result).toBe("unchanged");
    expect(await auditCount(s.studioId)).toBe(1);
  });

  it("a different pair is already_set and NEVER updates the row (0214 would return changed)", async () => {
    const s = await studio("differs");
    await ownerCall(s.studioId, "CA", "cad");
    const second = await ownerCall(s.studioId, "US", "usd");
    expect(second.out_result).toBe("already_set");
    expect(second.out_payment_country).toBe("CA");
    const row = await adminQuery(
      `select payment_country, payment_currency from public.studio_payment_jurisdictions where studio_id=$1`,
      [s.studioId],
    );
    expect(row.rows[0]).toEqual({ payment_country: "CA", payment_currency: "cad" });
    expect(await auditCount(s.studioId)).toBe(1);
  });

  it("two connections racing different pairs: one row, the loser is already_set, one audit row", async () => {
    const s = await studio("race");
    const pool = new Pool({ connectionString: resolveLocalDbUrl(), max: 2 });
    const a = await pool.connect();
    const b = await pool.connect();
    try {
      // A holds its transaction open after initializing, so B blocks on the
      // studio-row lock and runs only once A has committed.
      await a.query("begin");
      const first = await a.query(NEW_CMD, args(s.studioId, "CA", "cad", "a"));
      expect(first.rows[0].out_result).toBe("initialized");
      const pending = b.query(NEW_CMD, args(s.studioId, "US", "usd", "b")).then((r) => r.rows[0] as Result);
      await new Promise((r) => setTimeout(r, 300));
      await a.query("commit");
      const loser = await pending;
      expect(loser.out_result).toBe("already_set");
      expect(loser.out_payment_country).toBe("CA");
    } finally {
      await a.query("rollback").catch(() => undefined);
      a.release();
      b.release();
      await pool.end();
    }
    const rows = await adminQuery(
      `select payment_country from public.studio_payment_jurisdictions where studio_id=$1`,
      [s.studioId],
    );
    expect(rows.rows).toEqual([{ payment_country: "CA" }]);
    expect(await auditCount(s.studioId)).toBe(1);
  }, 20_000);
});

describe("refusal parity with the 0214 command (owner path, no price acknowledgement)", () => {
  it("an unsupported pair, a missing reference and an unknown studio", async () => {
    const s = await studio("bad");
    expect((await ownerCall(s.studioId, "US", "cad")).out_result).toBe("invalid_input");
    const noRef = await adminQuery(NEW_CMD, [s.studioId, "US", "usd", "owner:p1", "r", " "]);
    expect(noRef.rows[0].out_result).toBe("verification_required");
    expect((await ownerCall(randomUUID(), "US", "usd")).out_result).toBe("not_found");
    const none = await adminQuery(`select 1 from public.studio_payment_jurisdictions where studio_id=$1`, [s.studioId]);
    expect(none.rows).toHaveLength(0);
  });

  it("a Stripe account refuses, exactly as 0214 does", async () => {
    const s = await studio("acct");
    await adminQuery(
      `insert into public.studio_payment_settings
         (studio_id, stripe_account_id, stripe_account_status, stripe_charges_enabled,
          stripe_payouts_enabled, stripe_livemode)
       values ($1,$2,'enabled',true,true,false)`,
      [s.studioId, `acct_test_${randomUUID().slice(0, 12)}`],
    );
    const old = (await adminQuery(OLD_CMD, args(s.studioId, "US", "usd"))).rows[0] as Result;
    expect((await ownerCall(s.studioId, "US", "usd")).out_result).toBe(old.out_result);
    expect(old.out_result).toBe("refused_payment_account");
    expect(await auditCount(s.studioId)).toBe(0);
  });

  it("configured prices refuse, exactly as 0214 does without the acknowledgement", async () => {
    const s = await studio("priced");
    await adminQuery(`update public.studios set no_show_fee_cents = 5000 where id=$1`, [s.studioId]);
    const old = (await adminQuery(OLD_CMD, args(s.studioId, "US", "usd"))).rows[0] as Result;
    expect(old.out_result).toBe("refused_priced_configuration");
    expect((await ownerCall(s.studioId, "US", "usd")).out_result).toBe("refused_priced_configuration");
    expect(await auditCount(s.studioId)).toBe(0);
  });
});

describe("grants: service_role only, by name", () => {
  it("only service_role may EXECUTE the new command", async () => {
    const r = await adminQuery(
      `select role_name,
         has_function_privilege(role_name, 'public.initialize_studio_payment_jurisdiction_owner(uuid,text,text,text,text,text)', 'EXECUTE') allowed
       from unnest(array['anon','authenticated','service_role']) role_name`,
    );
    expect(r.rows).toEqual([
      { role_name: "anon", allowed: false },
      { role_name: "authenticated", allowed: false },
      { role_name: "service_role", allowed: true },
    ]);
    const pub = await adminQuery(
      `select exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
         where p.oid = 'public.initialize_studio_payment_jurisdiction_owner(uuid,text,text,text,text,text)'::regprocedure
           and a.grantee = 0) as public_has`,
    );
    expect(pub.rows[0].public_has).toBe(false);
  });
});
