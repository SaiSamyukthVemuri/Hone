import { beforeEach, describe, expect, it, vi } from "vitest";

// R5: the action carries the term in its POST body; every failure is the same fixed state.

let identityError: Error | null = null;
const rpcCalls: Array<Record<string, unknown>> = [];
let rpcResult: { data: unknown; error: unknown } = { data: [], error: null };

vi.mock("@/lib/desk/guard", () => ({
  getReceptionistWithStudio: async () => {
    if (identityError) throw identityError;
    return { studioId: "studio-1", receptionistId: "r1", displayName: "Desk" };
  },
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc: async (_fn: string, args: Record<string, unknown>) => {
      rpcCalls.push(args);
      return rpcResult;
    },
  }),
}));

import { searchDeskClientsAction, type DeskDirectoryState } from "@/app/(desk)/desk/clients/actions";

const idle: DeskDirectoryState = { status: "idle" };
const form = (entries: Array<[string, string]>) => {
  const f = new FormData();
  for (const [k, v] of entries) f.append(k, v);
  return f;
};

beforeEach(() => {
  identityError = null;
  rpcCalls.length = 0;
  rpcResult = { data: [], error: null };
});

describe("searchDeskClientsAction", () => {
  it("searches with the posted term and returns one page", async () => {
    rpcResult = { data: [{ client_id: "c1", display_name: "Janie", name_on_file: false, total_count: 1, intake_state: "not_submitted", consent_signed: false }], error: null };
    const out = await searchDeskClientsAction(idle, form([["q", "jan"], ["page", "1"], ["filter", "no_upcoming"], ["sort", "next"]]));
    expect(out.status).toBe("ok");
    expect(rpcCalls[0]).toMatchObject({ p_studio_id: "studio-1", p_query: "jan", p_filters: ["no_upcoming"], p_sort: "next", p_offset: 0 });
  });

  it("R2 holds through the action: page 3 with a one-character term is page 1", async () => {
    await searchDeskClientsAction(idle, form([["q", "j"], ["page", "3"]]));
    expect(rpcCalls[0].p_offset).toBe(0);
  });

  it("an identity failure never reaches the database and returns the fixed state", async () => {
    identityError = new Error("No active receptionist membership");
    expect(await searchDeskClientsAction(idle, form([["q", "jane smith"]]))).toEqual({ status: "unavailable" });
    expect(rpcCalls).toEqual([]);
  });

  it("a database failure returns the fixed state with no term in it", async () => {
    rpcResult = { data: null, error: { message: "relation x for jane smith" } };
    const out = await searchDeskClientsAction(idle, form([["q", "jane smith"]]));
    expect(out).toEqual({ status: "unavailable" });
    expect(JSON.stringify(out)).not.toMatch(/jane|smith/i);
  });
});
