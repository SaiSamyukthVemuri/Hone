import { afterEach, describe, expect, it, vi } from "vitest";
import { deskEntryAvailable, type EntrySupabase } from "@/lib/desk/entry";

const db = (result: { data: unknown[] | null; error: unknown } | "throws", allowed: unknown = "all") => {
  const reads: string[] = [];
  const supabase = {
    rpc: async (fn: string) => {
      reads.push(`rpc:${fn}`);
      const ids = allowed === "all" ? ((result === "throws" ? [] : (result.data ?? [])) as { studio_id?: string }[]).map((r) => r.studio_id) : allowed;
      return { data: ids, error: null };
    },
    from: (t: string) => ({
      select: () => {
        const q = {
          eq: () => q,
          limit: async () => {
            reads.push(t);
            if (result === "throws") throw new Error("x");
            return result;
          },
        };
        return q;
      },
    }),
  } as unknown as EntrySupabase;
  return { supabase, reads };
};
afterEach(() => vi.unstubAllEnvs());

describe("the /no-access way into the desk", () => {
  it("flag off: false and no read at all", async () => {
    vi.stubEnv("HONE_RECEPTIONIST_DESK_ENABLED", "");
    const { supabase, reads } = db({ data: [{ id: "r", studio_id: "s" }], error: null });
    expect(await deskEntryAvailable(supabase, "u")).toBe(false);
    expect(reads).toEqual([]);
  });
  it("flag on: true only for an active receptionist row; none, an error or a throw is false", async () => {
    vi.stubEnv("HONE_RECEPTIONIST_DESK_ENABLED", "true");
    expect(await deskEntryAvailable(db({ data: [{ id: "r", studio_id: "s" }], error: null }).supabase, "u")).toBe(true);
    expect(await deskEntryAvailable(db({ data: [], error: null }).supabase, "u")).toBe(false);
    expect(await deskEntryAvailable(db({ data: null, error: { message: "x" } }).supabase, "u")).toBe(false);
    expect(await deskEntryAvailable(db("throws").supabase, "u")).toBe(false);
  });
  it("flag on: an active receptionist row in a studio with the Front Desk off, or with no seat, is false (0390)", async () => {
    vi.stubEnv("HONE_RECEPTIONIST_DESK_ENABLED", "true");
    expect(await deskEntryAvailable(db({ data: [{ id: "r", studio_id: "s" }], error: null }, []).supabase, "u")).toBe(false);
    expect(await deskEntryAvailable(db({ data: [{ id: "r", studio_id: "s" }], error: null }, ["other"]).supabase, "u")).toBe(false);
    expect(await deskEntryAvailable(db({ data: [{ id: "r", studio_id: "s" }], error: null }, ["s"]).supabase, "u")).toBe(true);
  });
});
