import { beforeEach, describe, expect, it, vi } from "vitest";

// B-ii: a MultiPlex (native) area is NOT offered in the copy-settings preview; a legacy area in the same earlier session still is.
// Copying a native area needs a database change (copy_session_setup writes a legacy block and the default pulse_count 1) and is tracked separately.

const state = vi.hoisted(() => ({ blocks: [] as Array<Record<string, unknown>>, selects: [] as string[] }));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/sessions/session-lineage", () => ({
  assertSessionForClient: vi.fn(async () => undefined),
  SessionLineageError: class extends Error {},
}));
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: vi.fn(async () => ({ practitioner: { id: "p1", active: true }, studio: { id: "st1" } })),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    rpc: async () => ({
      data: { eligible: true, source_session_id: "src", source_fingerprint: "fp", source_started_at: "2026-11-01T00:00:00Z" },
      error: null,
    }),
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      const rows = () => {
        if (table === "session_blocks") return state.blocks;
        return [];
      };
      const done = Promise.resolve({ data: rows(), error: null });
      for (const m of ["eq", "is", "in", "order"]) chain[m] = () => chain;
      chain.select = (cols: string) => {
        if (table === "session_blocks") state.selects.push(cols);
        return chain;
      };
      chain.then = done.then.bind(done);
      return chain;
    },
  })),
}));

import { getWholeSessionCopySourceAction } from "@/app/(app)/clients/[id]/sessions/[sessionId]/whole-session-copy-actions";

const block = (id: string, extra: Record<string, unknown> = {}) => ({ id, sort_order: 1, mode: "thermo", primary_area: "Chin", side: "left", machine_profile_id: null, ...extra });

beforeEach(() => {
  state.blocks = [];
  state.selects = [];
});

describe("copy-settings preview source", () => {
  it("omits a native area and still offers the legacy area of the same earlier visit", async () => {
    state.blocks = [block("legacy-1"), block("native-1", { mode: null, machine_profile_id: "dectro-apilus:xcell-pur", machine_mode_key: "multiplex", studio_machine_id: "u1" })];
    const res = await getWholeSessionCopySourceAction({ clientId: "c1", sessionId: "s1" });
    expect(res.ok).toBe(true);
    if (!res.ok || !res.eligible) throw new Error("expected an eligible preview");
    expect(res.source.map((b) => b.blockId)).toEqual(["legacy-1"]);
    expect(state.selects[0]).toContain("machine_profile_id");
    expect(state.selects[0]).toContain("machine_mode_key");
    expect(state.selects[0]).toContain("studio_machine_id");
  });

  it("the existing xCell workflow (its model on the block, readings in the legacy columns) is still offered", async () => {
    state.blocks = [block("legacy-xcell", { machine_profile_id: "dectro-apilus:xcell", machine_mode_key: null, studio_machine_id: null }), block("native-1", { mode: null, machine_profile_id: "dectro-apilus:xcell-pur", machine_mode_key: "multiplex", studio_machine_id: "u1" })];
    const res = await getWholeSessionCopySourceAction({ clientId: "c1", sessionId: "s1" });
    if (!res.ok || !res.eligible) throw new Error("expected an eligible preview");
    expect(res.source.map((b) => b.blockId)).toEqual(["legacy-xcell"]);
  });

  it("an earlier visit with ONLY a native area offers nothing to copy", async () => {
    state.blocks = [block("native-1", { mode: null, machine_profile_id: "dectro-apilus:xcell-pur", machine_mode_key: "multiplex", studio_machine_id: "u1" })];
    const res = await getWholeSessionCopySourceAction({ clientId: "c1", sessionId: "s1" });
    expect(res.ok && res.eligible).toBe(false);
    expect(res.ok && res.source).toEqual([]);
  });
});
