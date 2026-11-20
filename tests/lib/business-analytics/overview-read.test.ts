import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));

type Result = { data: unknown; error: unknown };
type Call = { table: string; method: string; args: unknown[] };

function recording(results: Record<string, Result | Result[]>) {
  const calls: Call[] = [];
  const queues = new Map<string, Result[]>();
  for (const [t, r] of Object.entries(results)) queues.set(t, Array.isArray(r) ? [...r] : [r]);
  const client = {
    from: (table: string) => {
      const chain: unknown = new Proxy(() => undefined, {
        get: (_x, prop) => {
          if (prop === "then")
            return (res: (v: unknown) => void) => {
              const q = queues.get(table) ?? [{ data: [], error: null }];
              res(q.length > 1 ? q.shift() : q[0]);
            };
          return (...args: unknown[]) => {
            calls.push({ table, method: String(prop), args });
            return chain;
          };
        },
      });
      return chain;
    },
  } as unknown as SupabaseClient;
  return { client, calls };
}
const ok = (data: unknown): Result => ({ data, error: null });
const studio = { id: "22222222-2222-4222-8222-222222222222", timezone: "America/Toronto" };
const NOW = new Date("2026-11-19T18:00:00Z");
const healthy = (): Record<string, Result | Result[]> => ({
  practitioners: ok([{ id: "pr-1", display_name: "Ada Example", active: true }]),
  appointments: ok([{ id: "a1", client_id: "c1", starts_at: "2026-11-03T15:00:00+00:00", status: "completed", practitioner_id: "pr-1", service_id: null, duration_minutes: 30 }]),
  sessions: ok([]), payment_charge_attempts: ok([]), appointment_settlements: ok([]), manual_fee_charge_attempts: ok([]), services: ok([]),
});
const load = async (role: string, client: SupabaseClient, raw: Record<string, string | string[]> = {}, strict = false, currency: string | null = "cad") => {
  const { loadOverview } = await import("@/lib/business-analytics/server/overview-read");
  return loadOverview({ role }, studio, currency, raw, { strict }, NOW, client);
};

describe("the Overview read: owner gate before any query", () => {
  it("every non-owner role is refused and NO query is made", async () => {
    for (const role of ["practitioner", "assistant", "admin", "", "OWNER"]) {
      const { client, calls } = recording(healthy());
      expect(await load(role, client)).toEqual({ access: "refused" });
      expect(calls, role).toEqual([]);
    }
  });
});

describe("the Overview read: whole or nothing, studio-scoped, never writing", () => {
  it("an owner gets a view; the unread online-booking table is never queried", async () => {
    const { client, calls } = recording(healthy());
    const r = await load("owner", client);
    expect(r).toMatchObject({ access: "granted", ok: true });
    expect(calls.map((c) => c.table)).not.toContain("appointment_payments");
  });
  it("every query is scoped to the studio and none writes", async () => {
    const { client, calls } = recording(healthy());
    await load("owner", client);
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(["insert", "update", "upsert", "delete", "rpc"]).not.toContain(c.method);
    const tables = new Set(calls.map((c) => c.table));
    for (const t of tables) {
      const eqs = calls.filter((c) => c.table === t && c.method === "eq" && c.args[0] === "studio_id");
      expect(eqs.length, t).toBeGreaterThan(0);
      for (const e of eqs) expect(e.args[1]).toBe(studio.id);
    }
  });
  it("a failed practitioner read fails the whole page, as labels must not be guessed", async () => {
    const res = healthy();
    res.practitioners = { data: null, error: { message: "boom" } };
    expect(await load("owner", recording(res).client)).toEqual({ access: "granted", ok: false, reason: "read_failed", notices: [] });
  });
  it("a failed appointments read makes the figures unavailable with the reason, not zero", async () => {
    const res = healthy();
    res.appointments = { data: null, error: { message: "boom" } };
    const r = await load("owner", recording(res).client);
    expect(r).toMatchObject({ access: "granted", ok: true });
    if (r.access === "granted" && r.ok) {
      expect(r.view.collected).toEqual({ available: false, reason: "read_failed" });
      expect(r.view.completedVisits).toEqual({ available: false, reason: "read_failed" });
    }
  });
  it("no payment currency: no money, visits still shown", async () => {
    const r = await load("owner", recording(healthy()).client, {}, false, null);
    if (r.access === "granted" && r.ok) {
      expect(r.view.collected).toEqual({ available: false, reason: "currency_unknown" });
      expect(r.view.completedVisits.available).toBe(true);
    } else throw new Error("expected a view");
  });
});

describe("the Overview read: parameters", () => {
  it("a page with a bad value shows the default with a notice; a strict route is refused, with no data query", async () => {
    const page = await load("owner", recording(healthy()).client, { period: "week" });
    expect(page).toMatchObject({ access: "granted", ok: true, notices: [expect.any(String)] });
    const s = recording(healthy());
    expect(await load("owner", s.client, { period: "week" }, true)).toEqual({ access: "granted", ok: false, reason: "bad_request", notices: [] });
    expect(s.calls.map((c) => c.table).filter((t) => t !== "practitioners")).toEqual([]);
  });
  it("a practitioner id is accepted only when it belongs to this studio's practitioner list", async () => {
    const r = await load("owner", recording(healthy()).client, { practitioner: "pr-1" });
    expect(r).toMatchObject({ ok: true, params: { practitioner: { kind: "one", practitionerId: "pr-1" } } });
    const other = await load("owner", recording(healthy()).client, { practitioner: "someone-elses" });
    expect(other).toMatchObject({ ok: true, params: { practitioner: { kind: "all" } }, notices: [expect.any(String)] });
  });
  it("a custom range that is not allowed says why on a page and is refused on a route", async () => {
    const raw = { period: "custom", from: "2026-12-01", to: "2026-12-31" };
    expect(await load("owner", recording(healthy()).client, raw)).toMatchObject({ access: "granted", ok: false, reason: "period_invalid" });
    expect(await load("owner", recording(healthy()).client, raw, true)).toMatchObject({ access: "granted", ok: false, reason: "bad_request" });
  });
});
