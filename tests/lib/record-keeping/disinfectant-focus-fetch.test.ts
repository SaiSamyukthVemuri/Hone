import { beforeEach, describe, expect, it, vi } from "vitest";

// HON-12 / #1172 Codex P2: when the notice's record is not among the newest 200
// rows, the Records page fetches THAT one record with the same RLS-scoped server
// client, scoped to this studio and to not-yet-discarded (the notice's own
// condition). Anything else (unknown id, other studio's id, malformed id) renders
// the page exactly as before. Synthetic ids only.

const state = vi.hoisted(() => ({
  created: 0,
  calls: [] as Array<[string, ...unknown[]]>,
  result: { data: null as unknown, error: null as unknown },
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    state.created += 1;
    const proxy: unknown = new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === "then") return undefined;
          return (...args: unknown[]) => {
            state.calls.push([prop, ...args]);
            return prop === "maybeSingle" ? Promise.resolve(state.result) : proxy;
          };
        },
      },
    );
    return proxy;
  },
}));

import { getDisinfectantRecordForNotice } from "@/lib/record-keeping/queries";

const STUDIO = "11111111-1111-4111-8111-111111111111";
const REC = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  state.created = 0;
  state.calls = [];
  state.result = { data: null, error: null };
});

describe("getDisinfectantRecordForNotice", () => {
  it("reads exactly one record, scoped to the studio and to not-discarded", async () => {
    state.result = { data: { id: REC, studio_id: STUDIO, date_discarded: null }, error: null };
    const row = await getDisinfectantRecordForNotice(STUDIO, REC);
    expect(row?.id).toBe(REC);
    expect(state.calls).toContainEqual(["from", "record_keeping_disinfectants"]);
    expect(state.calls).toContainEqual(["eq", "studio_id", STUDIO]);
    expect(state.calls).toContainEqual(["eq", "id", REC]);
    expect(state.calls).toContainEqual(["is", "date_discarded", null]);
    expect(state.calls.some((c) => c[0] === "maybeSingle")).toBe(true);
  });
  it("a malformed id never reaches the database", async () => {
    for (const bad of ["not-a-uuid", "' or 1=1 --", "", "22222222-2222-4222-8222-22222222222"]) {
      expect(await getDisinfectantRecordForNotice(STUDIO, bad)).toBeNull();
    }
    expect(state.created).toBe(0);
  });
  it("an id with no row for this studio (unknown, or another studio's under RLS) is null", async () => {
    state.result = { data: null, error: null };
    expect(await getDisinfectantRecordForNotice(STUDIO, REC)).toBeNull();
  });
  it("a failed read is null: the page renders as before", async () => {
    state.result = { data: null, error: { code: "57014" } };
    expect(await getDisinfectantRecordForNotice(STUDIO, REC)).toBeNull();
  });
});
