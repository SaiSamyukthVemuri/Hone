import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";

// HON-64 Slice A, group 5 (owner-only) at the unit level. The DB/RLS and browser halves need an owned stack and run at the stacked rehearsal.
const ROOT = path.resolve(__dirname, "../../..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");

vi.mock("server-only", () => ({}));
const createClient = vi.fn(async () => {
  throw new Error("a client must NOT be constructed for a non-owner");
});
vi.mock("@/lib/supabase/server", () => ({ createClient: () => createClient() }));

describe("a non-owner is refused before any client or query exists", () => {
  it("every non-owner role gets { access: 'refused' } and no Supabase client is built", async () => {
    const { loadStatementView } = await import("@/lib/finance/statement-read");
    for (const role of ["practitioner", "staff", "member", "", "OWNER", "owner "]) {
      createClient.mockClear();
      const v = await loadStatementView({ role }, { id: "s1", timezone: "America/Toronto" }, "2026-11", "cad");
      expect(v).toEqual({ access: "refused" });
      expect(createClient).not.toHaveBeenCalled();
    }
  });
  it("the owner gate is the first statement of the loader and of the page's export", () => {
    const src = read("lib/finance/statement-read.ts");
    const body = src.slice(src.indexOf("export async function loadStatementView"));
    expect(body.indexOf('practitioner.role !== "owner"')).toBeGreaterThan(-1);
    expect(body.indexOf('practitioner.role !== "owner"')).toBeLessThan(body.indexOf("createClient"));
    const page = read("app/(app)/financials/statement/page.tsx");
    expect(page.indexOf('practitioner.role !== "owner"')).toBeLessThan(page.indexOf("getStudioPaymentJurisdiction("));
  });
  it("an owner whose money read errors gets an unavailable view, never an empty statement", async () => {
    const { loadStatementView } = await import("@/lib/finance/statement-read");
    const failing = { from: () => ({ select: () => ({ eq: () => ({ gte: () => ({ lt: () => ({ order: () => ({ limit: async () => ({ data: null, error: { message: "boom" } }) }) }) }) }) }) }) } as unknown as SupabaseClient;
    const v = await loadStatementView({ role: "owner" }, { id: "s1", timezone: "America/Toronto" }, "2026-11", "cad", failing);
    expect(v).toEqual({ access: "granted", ok: false, reason: "read_failed" });
  });
  it("a failed read of ANY money table, the legacy manual-fee ledger included, makes the whole statement unavailable, never a partial month", async () => {
    const { loadStatementView } = await import("@/lib/finance/statement-read");
    const ok = (data: unknown[]) => ({ data, error: null });
    const fake = (results: Record<string, { data: unknown[] | null; error: unknown }>) =>
      ({
        from: (t: string) => {
          const chain: unknown = new Proxy(() => undefined, {
            get: (_x, prop) => (prop === "then" ? (res: (v: unknown) => void) => res(results[t]) : () => chain),
          });
          return chain;
        },
      }) as unknown as SupabaseClient;
    const healthy = {
      appointments: ok([{ id: "a1", starts_at: "2026-11-03T15:00:00Z", practitioner_id: "p1", service_id: null, clients: null }]),
      sessions: ok([{ id: "s1", appointment_id: "a1" }]),
      payment_charge_attempts: ok([]),
      appointment_settlements: ok([]),
      manual_fee_charge_attempts: ok([]),
      services: ok([]),
    };
    const good = await loadStatementView({ role: "owner" }, { id: "s1", timezone: "America/Toronto" }, "2026-11", "cad", fake(healthy));
    expect(good).toMatchObject({ access: "granted", ok: true });
    for (const t of ["sessions", "payment_charge_attempts", "appointment_settlements", "manual_fee_charge_attempts"] as const) {
      const v = await loadStatementView({ role: "owner" }, { id: "s1", timezone: "America/Toronto" }, "2026-11", "cad", fake({ ...healthy, [t]: { data: null, error: { message: "boom" } } }));
      expect(v, t).toEqual({ access: "granted", ok: false, reason: "read_failed" });
    }
  });
  it("an owner of a studio with no payment currency gets nothing totalled", async () => {
    const { loadStatementView } = await import("@/lib/finance/statement-read");
    expect(await loadStatementView({ role: "owner" }, { id: "s1", timezone: "America/Toronto" }, "2026-11", null)).toEqual({ access: "granted", ok: false, reason: "currency_unknown" });
  });
});

describe("source guards", () => {
  const files = [
    "lib/finance/statement.ts",
    "lib/finance/statement-period.ts",
    "lib/finance/statement-copy.ts",
    "lib/finance/statement-read.ts",
    "app/(app)/financials/statement/page.tsx",
    "app/(app)/financials/statement/statement-view.tsx",
  ];
  it("reads through the invoker client only: no admin client, no service role, no RPC, no write, no Stripe", () => {
    for (const f of files) {
      const src = read(f);
      expect(src, f).not.toMatch(/createAdminClient|service_role|SERVICE_ROLE|\.rpc\(|\.insert\(|\.update\(|\.upsert\(|\.delete\(|from "stripe"|@\/lib\/stripe/);
    }
  });
  it("the page is never cached", () => {
    expect(read("app/(app)/financials/statement/page.tsx")).toContain('export const dynamic = "force-dynamic"');
  });
  it("/financials (FIN-01A) is untouched by this surface: none of its files imports or links the statement", () => {
    for (const f of ["app/(app)/financials/page.tsx", "app/(app)/financials/financial-spine.tsx", "lib/finance/financial-briefing.ts", "lib/finance/financial-briefing-model.ts"]) {
      expect(read(f), f).not.toMatch(/finance\/statement|financials\/statement|\.\/statement/);
    }
  });
  it("no print, export, download or mutation surface exists on the statement", () => {
    const src = files.map(read).join("\n");
    expect(src).not.toMatch(/window\.print|text\/csv|download=|Content-Disposition|"use server"|<form|<button/i);
  });
  it("the money tables it reads are exactly the owner-readable ones, plus appointments, sessions and services", () => {
    const src = read("lib/finance/statement-read.ts");
    const tables = [...src.matchAll(/\.from\("([a-z_]+)"\)/g)].map((m) => m[1]).sort();
    expect([...new Set(tables)]).toEqual(["appointment_settlements", "appointments", "manual_fee_charge_attempts", "payment_charge_attempts", "services", "sessions"]);
  });
});
