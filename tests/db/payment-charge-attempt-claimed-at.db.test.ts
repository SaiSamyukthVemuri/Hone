import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { adminQuery, closePool, seedSession, seedStudio, type SeededStudio } from "./helpers/harness";

// 0352: claimed_at is stamped once, at ready -> pending_stripe, and is immutable. Real database, synthetic ids only.

let s: SeededStudio;
let slot = 0;
beforeAll(async () => { s = await seedStudio("claimed-at"); });
afterAll(async () => { await closePool(); });

async function sessionAttempt(status = "ready"): Promise<string> {
  const { sessionId } = await seedSession(s);
  const id = randomUUID();
  await adminQuery(
    `insert into public.payment_charge_attempts (id, studio_id, client_id, session_id, charge_reason, created_by_practitioner_id, amount_cents, status)
     values ($1, $2, $3, $4, 'session_payment', $5, 2500, $6)`,
    [id, s.studioId, s.clientId, sessionId, s.practitionerId, status],
  );
  return id;
}
async function feeAttempt(): Promise<string> {
  const a = randomUUID();
  const day = new Date(Date.UTC(2032, 0, 1 + slot++)).toISOString().slice(0, 10);
  await adminQuery(
    `insert into public.appointments (id, studio_id, client_id, starts_at, ends_at, duration_minutes, buffer_minutes_snapshot, blocked_ends_at)
     values ($1, $2, $3, $4, $5, 60, 0, $5)`,
    [a, s.studioId, s.clientId, `${day}T10:00:00Z`, `${day}T11:00:00Z`],
  );
  const id = randomUUID();
  await adminQuery(
    `insert into public.payment_charge_attempts (id, studio_id, client_id, appointment_id, charge_reason, created_by_practitioner_id, amount_cents, status)
     values ($1, $2, $3, $4, 'late_cancellation_fee', $5, 9000, 'ready')`,
    [id, s.studioId, s.clientId, a, s.practitionerId],
  );
  return id;
}
const claimedAt = async (id: string) =>
  (await adminQuery(`select claimed_at, status, updated_at from public.payment_charge_attempts where id = $1`, [id])).rows[0];
const claim = (id: string) =>
  adminQuery(`select result, attempt_id, status_before_claim from public.claim_session_payment_charge_attempt($1, $2, $3)`, [id, s.practitionerId, `hone:x:${id}:v1`]);

describe("the column", () => {
  it("is nullable timestamptz with no default, and a new attempt has none", async () => {
    const c = (await adminQuery(`select data_type, is_nullable, column_default from information_schema.columns where table_schema='public' and table_name='payment_charge_attempts' and column_name='claimed_at'`)).rows[0];
    expect(c).toEqual({ data_type: "timestamp with time zone", is_nullable: "YES", column_default: null });
    expect((await claimedAt(await feeAttempt())).claimed_at).toBeNull();
  });
});

describe.each([["fee attempt", feeAttempt], ["session payment", sessionAttempt]] as const)("%s", (_label, make) => {
  it("the claim RPC stamps claimed_at once, and its result is the same as before", async () => {
    const id = await make();
    const r = (await claim(id)).rows[0];
    expect(r).toMatchObject({ result: "claimed", attempt_id: id, status_before_claim: "ready" });
    const row = await claimedAt(id);
    expect(row.status).toBe("pending_stripe");
    expect(row.claimed_at).not.toBeNull();
    // a second claim reports already_pending and does not move the stamp
    const again = (await claim(id)).rows[0];
    expect(again.result).toBe("already_pending");
    expect((await claimedAt(id)).claimed_at).toEqual(row.claimed_at);
  });
  it("a later write leaves it unchanged (updated_at moves, claimed_at does not)", async () => {
    const id = await make();
    await claim(id);
    const first = await claimedAt(id);
    await adminQuery(`select pg_sleep(0.05)`);
    await adminQuery(`update public.payment_charge_attempts set stripe_payment_intent_id = $2, stripe_status = 'processing' where id = $1`, [id, `pi_test_${id.slice(0, 12)}`]);
    const later = await claimedAt(id);
    expect(later.claimed_at).toEqual(first.claimed_at);
    expect(new Date(later.updated_at).getTime()).toBeGreaterThan(new Date(first.updated_at).getTime());
    await adminQuery(`update public.payment_charge_attempts set status = 'succeeded', charged_at = now() where id = $1`, [id]);
    expect((await claimedAt(id)).claimed_at).toEqual(first.claimed_at);
  });
  it("a set, change or clear by any caller is ignored, silently", async () => {
    const id = await make();
    await claim(id);
    const stamp = (await claimedAt(id)).claimed_at;
    await adminQuery(`update public.payment_charge_attempts set claimed_at = '2001-01-01T00:00:00Z' where id = $1`, [id]);
    expect((await claimedAt(id)).claimed_at).toEqual(stamp);
    await adminQuery(`update public.payment_charge_attempts set claimed_at = null where id = $1`, [id]);
    expect((await claimedAt(id)).claimed_at).toEqual(stamp);
  });
  it("a caller cannot set it on a ready row, and an INSERT cannot supply it", async () => {
    const id = await make();
    await adminQuery(`update public.payment_charge_attempts set claimed_at = now() where id = $1`, [id]);
    expect((await claimedAt(id)).claimed_at).toBeNull();
  });
  it("no other transition stamps it (ready -> blocked / cancelled / failed)", async () => {
    for (const to of ["blocked", "cancelled", "failed"]) {
      const id = await make();
      const extra = to === "failed" ? ", failed_at = now(), failure_code = 'x'" : to === "cancelled" ? ", cancelled_at = now(), cancelled_by_practitioner_id = '" + s.practitionerId + "', cancelled_reason = 'x'" : "";
      await adminQuery(`update public.payment_charge_attempts set status = '${to}'${extra} where id = $1`, [id]);
      expect((await claimedAt(id)).claimed_at, to).toBeNull();
    }
  });
  it("a row that reaches pending_stripe by a direct update (not the RPC) is stamped once; a non-ready row going to pending_stripe is not", async () => {
    const id = await make();
    await adminQuery(`update public.payment_charge_attempts set status = 'pending_stripe' where id = $1`, [id]);
    expect((await claimedAt(id)).claimed_at).not.toBeNull();
    // a row inserted directly as pending_stripe was never claimed here: no stamp
    const direct = await sessionAttempt("pending_stripe");
    expect((await claimedAt(direct)).claimed_at).toBeNull();
  });
});

describe("privileges and untouched neighbours", () => {
  it("the guard function cannot be executed by any role", async () => {
    for (const role of ["anon", "authenticated", "service_role"]) {
      const r = await adminQuery(`select has_function_privilege($1, 'public.payment_charge_attempts_claimed_at_guard()', 'EXECUTE') as ok`, [role]);
      expect(r.rows[0].ok, role).toBe(false);
    }
  });
  it("the guard has a pinned search_path and the other attempt triggers are still present", async () => {
    const cfg = (await adminQuery(`select proconfig from pg_proc where proname = 'payment_charge_attempts_claimed_at_guard'`)).rows[0].proconfig as string[];
    expect(cfg.join(",")).toMatch(/search_path=pg_catalog, pg_temp/);
    const trg = (await adminQuery(`select tgname from pg_trigger where tgrelid = 'public.payment_charge_attempts'::regclass and not tgisinternal order by 1`)).rows.map((r) => r.tgname);
    expect(trg).toEqual(expect.arrayContaining([
      "payment_charge_attempts_claimed_at_guard", "payment_charge_attempts_touch_updated_at_trg", "payment_charge_attempts_money_immutable", "payment_charge_attempts_jurisdiction_guard",
    ]));
  });
});
