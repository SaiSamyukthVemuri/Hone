import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { adminQuery, closePool } from "./helpers/harness";
import { cleanupPaymentScenario, seedEligibleQuickCheckoutScenario, type PaymentScenario } from "./helpers/payment-seed";
import { loadOverview, readSetsSeparately, readSetsShared } from "@/lib/business-analytics/server/overview-read";
import { resolvePeriod } from "@/lib/business-analytics/period";
import { localDateString } from "@/lib/booking/tz";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));

// HON-109 slice 1 against the REAL REST layer: the Overview and Clients-tab loader reads the studio's appointments once and cuts the five ranges in memory
// where it used to read each range on its own. The unit tests prove it against a fake that implements the keyset query; this proves it against PostgREST
// itself (the real timestamp format, the keyset `or(...)` filter, the API's row cap and row-level security as the signed-in owner), on a studio whose
// appointments straddle now, include tied start times, and run over several pages. Synthetic data only; the studio is removed afterwards.

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

const created: string[] = [];
let s: PaymentScenario;
let tz: string;
const TOTAL = 1100; // three keyset pages of 500
const NOW = new Date();

beforeAll(async () => {
  s = await seedEligibleQuickCheckoutScenario({ label: "overview-shared" });
  created.push(s.studioId);
  tz = ((await adminQuery(`select timezone from public.studios where id = $1`, [s.studioId])).rows[0] as { timezone: string }).timezone;
  // 1,100 completed/other visits for the studio's client, two per start time (a tie on starts_at), every 12 hours, centred on now. No overlap constraint is
  // hit because the two share a practitioner only when the scenario allows it, so the second of each pair is a block-free walk-in status ("no_show").
  await adminQuery(
    `insert into public.appointments (studio_id, practitioner_id, client_id, starts_at, ends_at, duration_minutes, status)
     select $1, $2, $3, ts, ts + interval '30 minutes', 30,
            case when n % 6 = 0 then 'cancelled' when n % 5 = 0 then 'no_show' when ts > now() then 'confirmed' else 'completed' end
       from (select n, date_trunc('hour', now()) + (n - $4 / 2) * interval '12 hours' as ts from generate_series(1, $4) n) g`,
    [s.studioId, s.practitionerId, s.clientId, TOTAL],
  ).catch(async () => {
    // a studio whose rule forbids two at once: spread them one per slot instead (still more than two pages, still straddling now)
    await adminQuery(
      `insert into public.appointments (studio_id, practitioner_id, client_id, starts_at, ends_at, duration_minutes, status)
       select $1, $2, $3, ts, ts + interval '30 minutes', 30, case when n % 6 = 0 then 'cancelled' when ts > now() then 'confirmed' else 'completed' end
         from (select n, date_trunc('hour', now()) + (n - $4 / 2) * interval '3 hours' as ts from generate_series(1, $4) n) g`,
      [s.studioId, s.practitionerId, s.clientId, TOTAL],
    );
  });
  await adminQuery(
    `insert into public.appointment_settlements (studio_id, appointment_id, method, amount_cents, currency, quoted_amount_cents, recorded_by_practitioner_id)
     select a.studio_id, a.id, case when abs(hashtext(a.id::text)) % 2 = 0 then 'paid_cash' else 'paid_e_transfer' end, 6000 + (abs(hashtext(a.id::text)) % 9) * 1000, 'cad', 6000 + (abs(hashtext(a.id::text)) % 9) * 1000, $2
       from public.appointments a where a.studio_id = $1 and a.status = 'completed'
     on conflict do nothing`,
    [s.studioId, s.practitionerId],
  );
}, 300_000);

afterAll(async () => {
  for (const id of created) await cleanupPaymentScenario(id).catch(() => undefined);
  await closePool();
}, 300_000);

const PERIODS: Array<[string, Record<string, string>]> = [
  ["month to date", {}],
  ["previous month", { period: "previous_month" }],
  ["year to date", { period: "year_to_date" }],
];

describe("the Overview read through the real REST layer: shared and separate appointment reads agree", () => {
  it("the five sets are row-for-row identical, and the studio really has more than two pages", async () => {
    const client = restAs(s.practitionerUserId);
    const studio = { id: s.studioId, timezone: tz };
    const r = resolvePeriod({ kind: "previous_month", today: localDateString(NOW, tz), from: undefined, to: undefined, customComparison: "preceding" });
    if (!r.ok) throw new Error("period");
    const separate = await readSetsSeparately(client, studio.id, tz, r.period, NOW);
    const shared = await readSetsShared(client, studio.id, tz, r.period, NOW);
    expect(shared).not.toBeNull();
    expect(shared).toEqual(separate);
    const rows = (x: unknown) => (x as { ok: true; rows: unknown[] }).rows.length;
    const sh = shared as NonNullable<typeof shared>;
    expect(rows(sh.history) + rows(sh.future)).toBeGreaterThan(TOTAL / 2);
    expect(rows(sh.past)).toBeGreaterThan(500); // more than one keyset page
    expect(rows(sh.future)).toBeGreaterThan(0);
  }, 120_000);

  for (const [label, raw] of PERIODS) {
    it(`Overview and Clients tab, ${label}: the whole output is identical`, async () => {
      const client = restAs(s.practitionerUserId);
      const studio = { id: s.studioId, timezone: tz };
      const clients = { sort: "spend" as const, chip: "all" as const, page: 1 };
      for (const withClients of [false, true]) {
        const opts = (appointmentReads: "shared" | "separate") => ({ strict: false, appointmentReads, ...(withClients ? { clients } : {}) });
        const separate = await loadOverview({ role: "owner" }, studio, "cad", raw, opts("separate"), NOW, client);
        const shared = await loadOverview({ role: "owner" }, studio, "cad", raw, opts("shared"), NOW, client);
        expect(shared).toMatchObject({ access: "granted", ok: true });
        expect(JSON.stringify(shared).length).toBeGreaterThan(2000);
        expect(shared).toEqual(separate);
      }
    }, 120_000);
  }
});
