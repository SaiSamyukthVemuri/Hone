import { beforeEach, describe, expect, it, vi } from "vitest";

// W8: the add-pass action with FORGED form fields. The pass takes its block's SAVED mode and carries only that mode's fields (rollout on); off, it is today's.
const h = vi.hoisted(() => ({ rollout: true, rpc: vi.fn(), storedMode: "thermo" as string | null, blockFound: true }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/rollouts/charting-rollout", () => ({ chartingRolloutFor: vi.fn(async () => h.rollout) }));
vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/supabase/queries", () => ({ getCurrentPractitionerWithStudio: vi.fn(async () => ({ practitioner: { active: true, id: "p1" }, studio: { id: "st1" } })) }));
vi.mock("@/lib/sessions/probe-lot-validation", () => ({ validateProbeLotId: vi.fn(async () => ({ ok: true, value: null })) }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc: (fn: string, args: Record<string, unknown>) => {
      h.rpc(fn, args);
      return Promise.resolve({ data: [{ entry_id: "e1" }], error: null });
    },
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      for (const k of ["select", "eq", "is", "order", "limit"]) chain[k] = () => chain;
      chain.maybeSingle = async () => {
        if (table === "sessions") return { data: { id: "s1" }, error: null };
        if (table === "session_blocks") return { data: h.blockFound ? { id: "primary1", mode: h.storedMode } : null, error: null };
        return { data: { observation_chips: [] }, error: null };
      };
      return chain;
    },
  }),
}));

const { addElectrolysisEntryAction } = await import("@/app/(app)/clients/[id]/sessions/[sessionId]/actions");

const form = (o: Record<string, string>) => {
  const f = new FormData();
  const all: Record<string, string> = {
    session_id: "s1", client_id: "c1", block_id: "b1", areas: JSON.stringify(["Upper lip"]), observation_chips: "[]",
    mode: "blend", apilus_modality: "Picoblend", energy_level: "9", hairs_treated: "12",
    thermolysis_intensity_percent: "55", thermolysis_duration_seconds: "1.5", galvanic_ma: "2.5", galvanic_duration_seconds: "30", units_of_lye: "4",
    pulse_count: "7", pulse_delay_seconds: "0.9", ...o,
  };
  for (const [k, v] of Object.entries(all)) f.set(k, v);
  return f;
};
const args = () => h.rpc.mock.calls.at(-1)![1] as Record<string, unknown>;
const r = () => ({
  mode: args().p_mode, mod: args().p_apilus_modality, el: args().p_energy_level, tint: args().p_thermolysis_intensity_percent,
  tdur: args().p_thermolysis_duration_seconds, ma: args().p_galvanic_ma, ul: args().p_units_of_lye, count: args().p_pulse_count, delay: args().p_pulse_delay_seconds,
});

beforeEach(() => { h.rpc.mockReset(); h.rollout = true; h.storedMode = "thermo"; h.blockFound = true; });

describe("add-pass, rollout ON: the SAVED mode wins and only its fields travel", () => {
  it("the request says BLEND but the block is THERMOLYSIS: the pass is thermolysis, galvanic fields and UL dropped", async () => {
    await addElectrolysisEntryAction(form({}));
    expect(r()).toMatchObject({ mode: "thermo", mod: "Picoblend", el: 9, tint: 55, tdur: 1.5, ma: null, ul: null, count: 7, delay: 0.9 });
  });
  it("the block is GALVANIC: thermolysis, modality and pulse dropped; galvanic, UL and EL kept", async () => {
    h.storedMode = "galv";
    await addElectrolysisEntryAction(form({}));
    const x = r();
    expect(x).toMatchObject({ mode: "galv", mod: null, el: 9, tint: null, tdur: null, ma: 2.5, ul: 4, delay: null });
    expect(x.count).not.toBe(7);
  });
  it("the block has NO MODE: nothing but the shared fields", async () => {
    h.storedMode = null;
    await addElectrolysisEntryAction(form({}));
    expect(r()).toMatchObject({ mode: null, mod: null, el: null, tint: null, tdur: null, ma: null, ul: null, delay: null });
  });
  it("OMNIBLEND: no thermolysis duration, the rest of the blend stays", async () => {
    h.storedMode = "blend";
    await addElectrolysisEntryAction(form({ apilus_modality: "Omniblend" }));
    expect(r()).toMatchObject({ mode: "blend", tdur: null, tint: 55, ma: 2.5, ul: 4 });
  });
  it("N2: NO block id and NO live block: the request's mode is used (nothing saved to follow), scoped to that mode's fields, and the command creates the block", async () => {
    h.blockFound = false;
    const f = form({ mode: "thermo" });
    f.delete("block_id");
    await addElectrolysisEntryAction(f);
    expect(r()).toMatchObject({ mode: "thermo", ma: null, ul: null, tint: 55, count: 7 });
    expect(args().p_block_id ?? null).toBeNull();
    const g = form({ mode: "galv" });
    g.delete("block_id");
    await addElectrolysisEntryAction(g);
    expect(r()).toMatchObject({ mode: "galv", mod: null, tint: null, tdur: null, ma: 2.5, ul: 4, delay: null });
  });
  it("N2b (Codex P2): NO block id but a live block exists: the command would attach to the session's first block, so the pass follows THAT block's saved mode and is sent to it by id", async () => {
    h.storedMode = "thermo";
    const f = form({ mode: "galv" });
    f.delete("block_id");
    await addElectrolysisEntryAction(f);
    expect(r()).toMatchObject({ mode: "thermo", ma: null, ul: null, tint: 55, count: 7 });
    expect(args().p_block_id).toBe("primary1");
  });
  it("an unknown block (or another studio's) is refused and nothing is written", async () => {
    h.blockFound = false;
    const res = await addElectrolysisEntryAction(form({}));
    expect(res.ok).toBe(false);
    expect(h.rpc).not.toHaveBeenCalled();
  });
});

describe("add-pass, rollout OFF: exactly today", () => {
  it("the request's own mode is used and the old gating applies (galvanic EL still dropped, pulse forged through)", async () => {
    h.rollout = false;
    h.storedMode = "thermo";
    await addElectrolysisEntryAction(form({ mode: "galv" }));
    expect(r()).toMatchObject({ mode: "galv", mod: null, el: null, ma: 2.5, tint: null, count: 7 });
  });
});
