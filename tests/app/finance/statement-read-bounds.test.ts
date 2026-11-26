import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

// HON-64 Slice A, Insurance F2: two mutations the first tests did not catch.
//   1. The 1000-row ceiling: PostgREST truncates at max_rows WITHOUT an error, so a response of EXACTLY 1000 rows may be truncated and must
//      fail closed. `>=` versus `>` is the whole difference.
//   2. Settlements are read with `superseded_at IS NULL`. A superseded settlement is an old version of the same disposition; counting it as
//      well as its replacement would double-count. (The database proof of the single-live-row index comes at the stacked rehearsal.)

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));

type Result = { data: unknown[] | null; error: unknown };
type Call = { table: string; method: string; args: unknown[] };

function recording(results: Record<string, Result>) {
  const calls: Call[] = [];
  const client = {
    from: (table: string) => {
      const chain: unknown = new Proxy(() => undefined, {
        get: (_x, prop) => {
          if (prop === "then") return (res: (v: unknown) => void) => res(results[table]);
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

const ok = (data: unknown[]): Result => ({ data, error: null });
const appt = (i: number) => ({ id: `a${i}`, starts_at: "2026-11-03T15:00:00Z", practitioner_id: "p1", service_id: null, clients: null });
const studio = { id: "s1", timezone: "America/Toronto" };
const healthy = (): Record<string, Result> => ({
  appointments: ok([appt(1)]),
  sessions: ok([{ id: "s1", appointment_id: "a1" }]),
  payment_charge_attempts: ok([]),
  appointment_settlements: ok([]),
  manual_fee_charge_attempts: ok([]),
  services: ok([]),
  practitioners: ok([]),
});

describe("the 1000-row ceiling: exactly 1000 is a possibly truncated read", () => {
  it("999 appointments are read; exactly 1000 is refused as too many; neither is shown as a partial month", async () => {
    const { loadStatementView } = await import("@/lib/finance/statement-read");
    const many = (n: number) => Array.from({ length: n }, (_, i) => appt(i + 1));
    const at999 = await loadStatementView({ role: "owner" }, studio, "2026-11", "cad", recording({ ...healthy(), appointments: ok(many(999)) }).client);
    expect(at999).toMatchObject({ access: "granted", ok: true });
    const at1000 = await loadStatementView({ role: "owner" }, studio, "2026-11", "cad", recording({ ...healthy(), appointments: ok(many(1000)) }).client);
    expect(at1000).toEqual({ access: "granted", ok: false, reason: "too_many_appointments" });
  });
  it("a money table that returns exactly 1000 rows fails the whole statement; 999 does not", async () => {
    const { loadStatementView } = await import("@/lib/finance/statement-read");
    const charge = (i: number) => ({
      id: `c${i}`, charge_reason: "session_payment", status: "succeeded", amount_cents: 100, currency: "cad", refund_status: null, refund_amount_cents: null,
      stripe_refund_status: null, stripe_refund_id: null, stripe_charge_refund_event_id: null, stripe_livemode: true, appointment_id: null, session_id: "s1",
    });
    const rows = (n: number) => Array.from({ length: n }, (_, i) => charge(i));
    for (const table of ["payment_charge_attempts", "appointment_settlements", "manual_fee_charge_attempts", "sessions"] as const) {
      const filler = table === "sessions" ? (n: number) => Array.from({ length: n }, (_, i) => ({ id: `s${i}`, appointment_id: "a1" })) : (n: number) => rows(n);
      const under = await loadStatementView({ role: "owner" }, studio, "2026-11", "cad", recording({ ...healthy(), [table]: ok(filler(999)) }).client);
      expect(under, `${table} at 999`).toMatchObject({ access: "granted", ok: true });
      const at = await loadStatementView({ role: "owner" }, studio, "2026-11", "cad", recording({ ...healthy(), [table]: ok(filler(1000)) }).client);
      expect(at, `${table} at 1000`).toEqual({ access: "granted", ok: false, reason: "read_failed" });
    }
  });
});

describe("settlements: only the live disposition is read (superseded_at IS NULL)", () => {
  it("the settlements query filters superseded rows out, and no other table is given that filter by mistake", async () => {
    const { loadStatementView } = await import("@/lib/finance/statement-read");
    const { client, calls } = recording(healthy());
    await loadStatementView({ role: "owner" }, studio, "2026-11", "cad", client);
    const settlement = calls.filter((c) => c.table === "appointment_settlements");
    expect(settlement.some((c) => c.method === "is" && c.args[0] === "superseded_at" && c.args[1] === null)).toBe(true);
    expect(settlement.some((c) => c.method === "eq" && c.args[0] === "studio_id")).toBe(true);
    for (const c of calls) if (c.table !== "appointment_settlements") expect(c.args[0] === "superseded_at" && c.method === "is", c.table).toBe(false);
  });
  it("source pin: the filter is in the read module, so a refactor that drops it fails here", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("lib/finance/statement-read.ts", "utf8");
    expect(src).toMatch(/from\("appointment_settlements"\)[\s\S]{0,300}\.is\("superseded_at", null\)/);
  });
});
