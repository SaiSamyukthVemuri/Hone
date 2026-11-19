import { beforeEach, describe, expect, it, vi } from "vitest";

// A pass with a reading outside the form's own bounds is REFUSED with a clear message and nothing is written, instead of the value being nulled or
// clamped and the pass reported as saved. Forged-form tests against the real action; the database command is a spy.
const h = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/supabase/queries", () => ({ getCurrentPractitionerWithStudio: vi.fn(async () => ({ practitioner: { active: true, id: "p1" }, studio: { id: "st1" } })) }));
vi.mock("@/lib/sessions/probe-lot-validation", () => ({ validateProbeLotId: vi.fn(async () => ({ ok: true, value: null })) }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc: (fn: string, args: Record<string, unknown>) => { h.rpc(fn, args); return Promise.resolve({ data: [{ entry_id: "e1" }], error: null }); },
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      for (const k of ["select", "eq", "is"]) chain[k] = () => chain;
      chain.maybeSingle = async () => ({ data: table === "sessions" ? { id: "s1" } : { observation_chips: [] }, error: null });
      return chain;
    },
  }),
}));
const { addElectrolysisEntryAction } = await import("@/app/(app)/clients/[id]/sessions/[sessionId]/actions");

const form = (o: Record<string, string>) => {
  const f = new FormData();
  const base: Record<string, string> = { session_id: "s1", client_id: "c1", block_id: "b1", areas: JSON.stringify(["Upper lip"]), observation_chips: "[]", mode: "blend", apilus_modality: "Picoblend", ...o };
  for (const [k, v] of Object.entries(base)) f.set(k, v);
  return f;
};
const args = () => h.rpc.mock.calls.at(-1)![1] as Record<string, unknown>;
beforeEach(() => h.rpc.mockReset());

const CASES: Array<[string, string, string, string]> = [
  // field, bad value, mode that owns it, label fragment
  ["thermolysis_intensity_percent", "101", "thermo", "Thermolysis intensity"],
  ["thermolysis_intensity_percent", "-1", "thermo", "Thermolysis intensity"],
  ["thermolysis_intensity_percent", "55.5", "thermo", "Thermolysis intensity"],
  ["thermolysis_duration_seconds", "-0.5", "thermo", "Thermolysis duration"],
  ["pulse_count", "11", "thermo", "Pulse count"],
  ["pulse_count", "0", "thermo", "Pulse count"],
  ["galvanic_ma", "-2", "galv", "Galvanic mA"],
  ["galvanic_duration_seconds", "-30", "galv", "Galvanic duration"],
  ["units_of_lye", "-1", "galv", "Units of lye"],
  ["energy_level", "-5", "thermo", "Energy level"],
  ["hairs_treated", "-1", "thermo", "Hairs treated"],
  ["minutes_performed", "-3", "thermo", "Minutes performed"],
  ["energy_level", "abc", "thermo", "Energy level"],
];
describe("an out-of-range reading is refused, with the field named and nothing written", () => {
  for (const [field, bad, mode, label] of CASES) {
    it(`${field}=${bad} (${mode})`, async () => {
      const res = await addElectrolysisEntryAction(form({ mode, [field]: bad }));
      expect(res.ok).toBe(false);
      expect((res as { error: string }).error).toContain(label);
      expect((res as { error: string }).error).toContain("Nothing was saved");
      expect(h.rpc).not.toHaveBeenCalled();
    });
  }
});

describe("controls: the bounds themselves, blanks, and fields the mode does not own", () => {
  it("the edges are accepted: intensity 0 and 100, pulse count 1 and 10, zero minutes", async () => {
    for (const v of ["0", "100"]) {
      h.rpc.mockReset();
      const res = await addElectrolysisEntryAction(form({ mode: "thermo", thermolysis_intensity_percent: v }));
      expect(res.ok, v).toBe(true);
      expect(args().p_thermolysis_intensity_percent).toBe(Number(v));
    }
    for (const v of ["1", "10"]) {
      h.rpc.mockReset();
      expect((await addElectrolysisEntryAction(form({ mode: "thermo", pulse_count: v, pulse_delay_seconds: "0.5" }))).ok, v).toBe(true);
    }
    h.rpc.mockReset();
    expect((await addElectrolysisEntryAction(form({ mode: "thermo", minutes_performed: "0" }))).ok).toBe(true);
  });
  it("blank readings are fine (everything is optional)", async () => {
    expect((await addElectrolysisEntryAction(form({ mode: "thermo", thermolysis_intensity_percent: "", hairs_treated: " " }))).ok).toBe(true);
  });
  it("a bad value in a field this mode does not own is ignored, as before (galvanic fields on a thermolysis pass)", async () => {
    const res = await addElectrolysisEntryAction(form({ mode: "thermo", galvanic_ma: "-9", units_of_lye: "-9" }));
    expect(res.ok).toBe(true);
    expect(args().p_galvanic_ma).toBeNull();
  });
  it("Galvanic ignores a forged intensity and pulse count (not its fields), and does not refuse for them", async () => {
    expect((await addElectrolysisEntryAction(form({ mode: "galv", thermolysis_intensity_percent: "999", pulse_count: "99" }))).ok).toBe(true);
  });
});
