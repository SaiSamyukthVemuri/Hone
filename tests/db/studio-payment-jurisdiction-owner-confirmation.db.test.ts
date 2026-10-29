import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { adminQuery, closePool, seedStudio, type SeededStudio } from "./helpers/harness";

// JURISDICTION-ONBOARDING PR-2. The owner-confirmation action calls the 0214
// command with these exact arguments; this proves the REAL command accepts
// them for a studio with no row, audits them, and refuses once a Stripe
// account exists. No new writer exists.

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

const ownerCall = (studioId: string, country: string, currency: string, who = "p1") =>
  adminQuery(`select * from public.set_studio_payment_jurisdiction($1,$2,$3,$4,$5,false,$6)`, [
    studioId,
    country,
    currency,
    `owner:${who}`,
    "owner onboarding confirmation",
    `owner-confirmed:${who}:2026-11-01T00:00:00.000Z:${country}/${currency}`,
  ]).then((r) => r.rows[0] as { out_result: string; out_payment_country: string | null });

describe("owner-style confirmation through the existing command", () => {
  it("initializes a studio with no row and audits the owner actor and reference", async () => {
    const s = await studio("init");
    expect((await ownerCall(s.studioId, "US", "usd")).out_result).toBe("initialized");
    const row = await adminQuery(
      `select payment_country, payment_currency from public.studio_payment_jurisdictions where studio_id=$1`,
      [s.studioId],
    );
    expect(row.rows[0]).toEqual({ payment_country: "US", payment_currency: "usd" });
    const audit = await adminQuery(
      `select actor, reason, verification_reference from public.studio_payment_jurisdiction_changes where studio_id=$1`,
      [s.studioId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].actor).toBe("owner:p1");
    expect(audit.rows[0].verification_reference).toContain("owner-confirmed:p1:");
  });

  it("repeating the same confirmation is unchanged and adds no history", async () => {
    const s = await studio("repeat");
    await ownerCall(s.studioId, "CA", "cad");
    expect((await ownerCall(s.studioId, "CA", "cad")).out_result).toBe("unchanged");
    const n = await adminQuery(
      `select count(*)::int as n from public.studio_payment_jurisdiction_changes where studio_id=$1`,
      [s.studioId],
    );
    expect(n.rows[0].n).toBe(1);
  });

  it("an unsupported pair is invalid input and writes nothing", async () => {
    const s = await studio("bad");
    expect((await ownerCall(s.studioId, "US", "cad")).out_result).toBe("invalid_input");
    const r = await adminQuery(`select 1 from public.studio_payment_jurisdictions where studio_id=$1`, [s.studioId]);
    expect(r.rows).toHaveLength(0);
  });

  it("is refused once a Stripe account exists", async () => {
    const s = await studio("acct");
    await adminQuery(
      `insert into public.studio_payment_settings
         (studio_id, stripe_account_id, stripe_account_status, stripe_charges_enabled,
          stripe_payouts_enabled, stripe_livemode)
       values ($1,$2,'enabled',true,true,false)`,
      [s.studioId, `acct_test_${randomUUID().slice(0, 12)}`],
    );
    expect((await ownerCall(s.studioId, "US", "usd")).out_result).toBe("refused_payment_account");
  });
});
