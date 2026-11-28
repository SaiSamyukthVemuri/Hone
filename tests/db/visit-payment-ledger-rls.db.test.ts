import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHmac, randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { adminQuery, asRole, asUser, closePool, seedMember } from "./helpers/harness";
import { cleanupPaymentScenario, seedQuickCheckoutScenario, type PaymentScenario } from "./helpers/payment-seed";
import { readMoneyForAppointments } from "@/lib/finance/statement-money-read";
import { buildStatement } from "@/lib/finance/statement";

vi.mock("server-only", () => ({}));

// A real PostgREST client carrying one seeded user's JWT (the stack's own development signing secret), so row-level security decides every row.
const API = process.env.E2E_SUPABASE_URL ?? "http://127.0.0.1:54321";
const LOCAL_JWT_SECRET = process.env.HONE_LOCAL_JWT_SECRET ?? "super-secret-jwt-token-with-at-least-32-characters-long";
function jwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ iss: "supabase-demo", aud: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600, ...claims });
  return `${head}.${body}.${createHmac("sha256", LOCAL_JWT_SECRET).update(`${head}.${body}`).digest("base64url")}`;
}
const restAs = (userId: string): SupabaseClient =>
  createClient(API, jwt({ role: "anon" }), { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${jwt({ role: "authenticated", sub: userId })}` } } });

// HON-123 / HON-122: who can READ the three split-payments ledger tables (0393). Synthetic values only.
// The owner of the studio reads its own bill, cash/transfer and refund rows. A front-desk receptionist, another practitioner, the owner of ANOTHER studio and the anonymous
// and service roles read nothing. Rows are never writable by any of them directly (every write is a 0394 command).

const TABLES = ["visit_bills", "visit_external_payments", "payment_refunds"] as const;
let mine: PaymentScenario;
let other: PaymentScenario;
let desk: string;
let colleague: { userId: string };

beforeAll(async () => {
  mine = await seedQuickCheckoutScenario({ appointmentStatus: "completed", withSession: true, attempt: "none", bookedService: { name: "Synthetic service", priceCents: 22500 } });
  other = await seedQuickCheckoutScenario({ appointmentStatus: "completed", withSession: true, attempt: "none", bookedService: { name: "Other studio service", priceCents: 10000 } });
  for (const s of [mine, other]) {
    await adminQuery(`update public.platform_rollouts set mode = 'pilot' where key = 'split_payments' and mode = 'off'`);
    await adminQuery(`insert into public.platform_rollout_studios (rollout_key, studio_id) values ('split_payments', $1) on conflict do nothing`, [s.studioId]);
  }
  desk = randomUUID();
  await adminQuery("insert into auth.users (id,email) values ($1,$2)", [desk, `${desk}@harness.local`]);
  await adminQuery("insert into public.studio_receptionists (studio_id,user_id,display_name,active) values ($1,$2,'Front desk',true)", [mine.studioId, desk]);
  colleague = await seedMember({ studioId: mine.studioId } as never, "colleague");

  // One bill, one confirmed cash payment and a refund of part of it, in each studio, through the real commands as that studio's owner.
  for (const s of [mine, other]) {
    await asUser(s.practitionerUserId, (q) => q(`select * from public.ensure_visit_bill($1,$2,null,null,false)`, [s.studioId, s.appointmentId]));
    const pay = await asUser(s.practitionerUserId, (q) => q(`select * from public.record_visit_external_payment($1,$2,'paid_cash',5000,$3,null)`, [s.studioId, s.appointmentId, randomUUID()]));
    await asUser(s.practitionerUserId, (q) =>
      q(`select * from public.request_payment_refund($1,$2,null,$3,2000,'payment_reversal','synthetic',$4)`, [s.studioId, s.appointmentId, pay.rows[0].payment_id, randomUUID()]),
    );
  }
});
afterAll(async () => {
  for (const s of [mine, other]) {
    if (!s) continue;
    await cleanupPaymentScenario(s.studioId).catch(() => undefined);
    await adminQuery(`delete from public.platform_rollout_studios where rollout_key = 'split_payments' and studio_id = $1`, [s.studioId]).catch(() => undefined);
  }
  await closePool();
});

const count = (userId: string, table: string, studioId?: string) =>
  asUser(userId, (q) => q(`select count(*)::int as n from public.${table}${studioId ? " where studio_id = $1" : ""}`, studioId ? [studioId] : [])).then((r) => r.rows[0].n as number);

describe("0393 read access to the ledger", () => {
  it("the rows exist (seed check)", async () => {
    for (const t of TABLES) expect((await adminQuery(`select count(*)::int n from public.${t} where studio_id = $1`, [mine.studioId])).rows[0].n).toBeGreaterThan(0);
  });
  it("the studio's owner reads its own rows from all three tables", async () => {
    for (const t of TABLES) expect(await count(mine.practitionerUserId, t, mine.studioId)).toBeGreaterThan(0);
  });
  it("the owner of ANOTHER studio reads none of them, with or without a studio filter", async () => {
    for (const t of TABLES) {
      expect(await count(other.practitionerUserId, t, mine.studioId)).toBe(0);
      const all = await asUser(other.practitionerUserId, (q) => q(`select studio_id from public.${t}`));
      expect(all.rows.every((r) => r.studio_id === other.studioId)).toBe(true);
    }
  });
  it("a front-desk receptionist reads ZERO rows from all three tables", async () => {
    for (const t of TABLES) expect(await count(desk, t)).toBe(0);
  });
  it("the anonymous and service roles have no access at all", async () => {
    for (const t of TABLES) for (const role of ["anon", "service_role"] as const) {
      await expect(asRole(role, (q) => q(`select 1 from public.${t} limit 1`))).rejects.toMatchObject({ code: "42501" });
    }
  });
  it("nobody can write a ledger row directly", async () => {
    for (const t of TABLES) {
      await expect(asUser(mine.practitionerUserId, (q) => q(`delete from public.${t} where studio_id = $1`, [mine.studioId]))).rejects.toMatchObject({ code: "42501" });
      await expect(asUser(mine.practitionerUserId, (q) => q(`update public.${t} set studio_id = studio_id where studio_id = $1`, [mine.studioId]))).rejects.toMatchObject({ code: "42501" });
    }
  });
  it("another practitioner of the same studio reads ZERO rows: the policies are owner-only, as payment_charge_attempts (0254)", async () => {
    for (const t of TABLES) expect(await count(colleague.userId, t, mine.studioId)).toBe(0);
  });
  it("...and gets nothing from the position read either", async () => {
    const r = await asUser(colleague.userId, (q) => q(`select * from public.get_visit_payment_position($1,$2)`, [mine.studioId, mine.appointmentId]));
    expect(r.rows).toEqual([]);
    const own = await asUser(mine.practitionerUserId, (q) => q(`select * from public.get_visit_payment_position($1,$2)`, [mine.studioId, mine.appointmentId]));
    expect(own.rows).toHaveLength(1);
  });

  it("the statement read, through the real REST layer, itemises the owner's visit and reads NOTHING for a receptionist or another studio", async () => {
    const read = (userId: string, studioId: string, ids: string[]) => readMoneyForAppointments(restAs(userId), studioId, ids);
    const ownerRead = await read(mine.practitionerUserId, mine.studioId, [mine.appointmentId]);
    expect(ownerRead.ok).toBe(true);
    if (!ownerRead.ok) return;
    const st = buildStatement({ studioCurrency: "cad", appointments: [{ id: mine.appointmentId, practitionerId: null, startsAt: new Date().toISOString() }], cardRows: ownerRead.cardRows, settlementRows: ownerRead.settlementRows, legacyFeeRows: ownerRead.legacyFeeRows });
    expect(st.all.kinds.collected_cash).toEqual({ count: 1, cents: 5000 });
    expect(st.all.kinds.refunded_partial).toEqual({ count: 1, cents: 2000 });
    expect(st.all.kinds.bill_note.count).toBe(1);
    expect(st.all.collectedCents).toBe(5000); // the refund is not taken off it
    // Another studio's owner and the receptionist see the visit's money as NOTHING (the ledger rows are invisible to them), never as someone else's figures.
    for (const who of [other.practitionerUserId, desk]) {
      const r = await read(who, mine.studioId, [mine.appointmentId]);
      if (r.ok) expect(r.settlementRows).toEqual([]);
    }
  });
});
