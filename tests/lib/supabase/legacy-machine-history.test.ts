import { describe, expect, it, vi } from "vitest";

// ===========================================================================
// THE xCell CHOICE SURVIVES A FAILING HISTORY QUERY (Privacy EH-2).
//
// studioHasLegacyMachineHistory asks the 0301 columns first. Without 0301 that
// query fails as a whole; it then asks the older schema's question, and if even
// that fails the existing workflow is still offered, because hiding the
// studio's own default is the worse error.
// ===========================================================================

type Answer = { count: number | null; error: { code?: string } | null };
const answers: Answer[] = [];
const filters: string[] = [];

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    const chain: Record<string, unknown> = {};
    const next = async () => answers.shift() ?? { count: 0, error: null };
    for (const m of ["select", "eq", "is", "not"]) {
      chain[m] = (...a: unknown[]) => {
        filters.push(`${m}:${a.join(",")}`);
        return chain;
      };
    }
    chain.or = (...a: unknown[]) => {
      filters.push(`or:${a.join(",")}`);
      return next();
    };
    // the fallback query ends at .not(...), awaited directly
    chain.then = (res: (v: unknown) => unknown) => next().then(res);
    return { from: () => chain };
  },
}));

const { studioHasLegacyMachineHistory } = await import("@/lib/supabase/queries");

const reset = (...a: Answer[]) => {
  answers.length = 0;
  filters.length = 0;
  answers.push(...a);
};

describe("studioHasLegacyMachineHistory", () => {
  it("with 0301: history by the identity column or a recorded mode", async () => {
    reset({ count: 3, error: null });
    expect(await studioHasLegacyMachineHistory("s", "dectro-apilus:xcell")).toBe(true);
    reset({ count: 0, error: null });
    expect(await studioHasLegacyMachineHistory("s", "dectro-apilus:xcell")).toBe(false);
  });

  it("without 0301: the identity-column query fails, the older question answers", async () => {
    reset({ count: null, error: { code: "42703" } }, { count: 2, error: null });
    expect(await studioHasLegacyMachineHistory("s", "dectro-apilus:xcell")).toBe(true);
    reset({ count: null, error: { code: "42703" } }, { count: 0, error: null });
    expect(await studioHasLegacyMachineHistory("s", "dectro-apilus:xcell")).toBe(false);
  });

  it("if EVERY query fails the existing workflow is still offered", async () => {
    reset({ count: null, error: { code: "42703" } }, { count: null, error: { code: "57014" } });
    expect(await studioHasLegacyMachineHistory("s", "dectro-apilus:xcell")).toBe(true);
  });
});
