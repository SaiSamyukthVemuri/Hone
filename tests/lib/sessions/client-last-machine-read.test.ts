import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const calls: string[] = [];
let results: Array<{ data: unknown; error: unknown }> = [];
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    const chain: Record<string, unknown> = {};
    const q = results.shift() ?? { data: [], error: null };
    for (const m of ["select", "eq", "is", "neq", "not", "or", "order"]) {
      chain[m] = (...a: unknown[]) => {
        calls.push(`${m}:${a.map(String).join(",")}`);
        return chain;
      };
    }
    chain.limit = async () => q;
    return { from: () => chain };
  },
}));

import { readClientLastMachine } from "@/lib/sessions/client-last-machine";

// OPS/Photos R2: a client last charted on xCell Pur showed no suggestion because only blocks with a saved identity were read.
beforeEach(() => {
  calls.length = 0;
  results = [];
});

describe("readClientLastMachine", () => {
  it("a most recent block with NO identity but a legacy mode is the existing xCell workflow", async () => {
    results = [{ data: [{ machine_profile_id: null, studio_machine_id: null, machine_mode_key: null, mode: "thermo" }], error: null }];
    expect(await readClientLastMachine("c1")).toEqual({ profileId: "dectro-apilus:xcell", deviceId: null, modeKey: null });
    expect(calls.join(" ")).toContain("or:machine_profile_id.not.is.null,mode.not.is.null");
  });
  it("a saved identity still wins as itself", async () => {
    results = [{ data: [{ machine_profile_id: "p", studio_machine_id: "u1", machine_mode_key: "flash", mode: null }], error: null }];
    expect(await readClientLastMachine("c1")).toEqual({ profileId: "p", deviceId: "u1", modeKey: "flash" });
  });
  it("no block at all is null (NEGATIVE CONTROL: nothing is invented)", async () => {
    results = [{ data: [], error: null }];
    expect(await readClientLastMachine("c1")).toBeNull();
  });
  it("0301 unapplied: falls back to the legacy-only question the old schema can answer", async () => {
    results = [
      { data: null, error: { code: "42703" } },
      { data: [{ mode: "galv" }], error: null },
    ];
    expect(await readClientLastMachine("c1")).toEqual({ profileId: "dectro-apilus:xcell", deviceId: null, modeKey: null });
    results = [
      { data: null, error: { code: "42703" } },
      { data: [], error: null },
    ];
    expect(await readClientLastMachine("c1")).toBeNull();
  });
});
