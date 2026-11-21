import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));
// The directory model reports a failed document build; the loader must treat that as a failed read, never as an empty or partial month.
vi.mock("@/lib/finance/statement-directory", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/finance/statement-directory")>()),
  buildDirectory: () => ({ ok: false as const, error: "invalid_scope" }),
}));

const ok = (data: unknown) => ({ data, error: null });
function fake(results: Record<string, unknown>): SupabaseClient {
  return {
    from: (table: string) => {
      const chain: unknown = new Proxy(() => undefined, {
        get: (_x, prop) => (prop === "then" ? (res: (v: unknown) => void) => res(results[table] ?? ok([])) : () => chain),
      });
      return chain;
    },
  } as unknown as SupabaseClient;
}

describe("a failed document build fails the whole directory read", () => {
  it("returns read_failed, not an empty or partial month", async () => {
    const { loadStatementDirectory } = await import("@/lib/finance/statement-directory-read");
    const appt = { id: "a1", client_id: "c1", starts_at: "2026-11-03T15:00:00+00:00", status: "completed", practitioner_id: null, service_id: null, duration_minutes: 30 };
    const client = fake({ appointments: ok([appt]), clients: ok([{ id: "c1", name: "Ada", preferred_name: null }]) });
    const r = await loadStatementDirectory({ role: "owner" }, { id: "s1", timezone: "America/Toronto" }, "cad", "2026-11", new Date("2026-11-19T18:00:00Z"), client);
    expect(r).toEqual({ access: "granted", ok: false, reason: "read_failed" });
  });
});
