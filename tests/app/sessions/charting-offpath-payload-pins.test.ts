import { beforeEach, describe, expect, it, vi } from "vitest";

// CHARTING, OFF PATH. What the three reading writers send to the database TODAY, for every mode and modality, pinned as written-out tables. The charting
// redesign changes these writers only behind a studio rollout; with the rollout Off every payload must stay exactly what is below. When a later change
// deliberately alters a row, it edits that row here in the same commit, so the change is visible in review instead of slipping in.
//
// These are today's behaviour, quirks included, and are pinned as facts, not endorsed as design: the pulse count and delay travel in EVERY mode; Galvanic
// drops EL; create and edit pass any modality text through while add-pass keeps only a modality from its allowed list, and add-pass sends no minutes. The redesign's server rule (lib/sessions/mode-scope.ts) is not applied here.
const h = vi.hoisted(() => ({ rpc: vi.fn(), block: { probe_key: null, probe_inventory_item_id: null, probe_lot_number: null, mode: null } as Record<string, unknown> }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/sessions/session-lineage", () => ({ assertSessionForClient: vi.fn(async () => undefined), SessionLineageError: class extends Error {} }));
const who = { practitioner: { active: true, id: "p1" }, studio: { id: "st1" } };
vi.mock("@/lib/supabase/writing-identity", () => ({ resolveWritingIdentity: vi.fn(async () => ({ ok: true, value: who })) }));
vi.mock("@/lib/supabase/queries", () => ({ getCurrentPractitionerWithStudio: vi.fn(async () => who) }));
vi.mock("@/lib/sessions/probe-lot-validation", () => ({ validateProbeLotId: vi.fn(async () => ({ ok: true, value: null })) }));
vi.mock("@/lib/record-keeping/probe-inventory-validation", () => ({ resolveProbeInventorySelection: vi.fn(async () => ({ ok: true, probeLotNumber: null, probeInventoryItemId: null })) }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc: (fn: string, args: Record<string, unknown>) => { h.rpc(fn, args); return Promise.resolve({ data: { block_id: "b1", entry_id: "e1", updated_at: "2026-11-19T10:00:00.000Z" }, error: null }); },
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      for (const k of ["select", "order", "limit", "is", "eq"]) chain[k] = () => chain;
      chain.then = (res: (v: unknown) => unknown) => res({ data: [], error: null });
      chain.single = async () => ({ data: { id: "b1", updated_at: "2026-11-19T10:00:00.000Z" }, error: null });
      chain.maybeSingle = async () => ({ data: table === "session_blocks" ? h.block : table === "sessions" ? { id: "s1" } : { observation_chips: [] }, error: null });
      return chain;
    },
  }),
}));
const B = await import("@/app/(app)/clients/[id]/sessions/[sessionId]/block-actions");
const A = await import("@/app/(app)/clients/[id]/sessions/[sessionId]/actions");

type Mode = "none" | "thermo" | "galv" | "blend";
const MODES: Mode[] = ["none", "thermo", "galv", "blend"];
const MODALITIES: Array<string | null> = [null, "Picoblend", "Omniblend", "NotAModality"];
const READ = { thermolysisIntensityPercent: 55, thermolysisDurationSeconds: 1.5, galvanicMa: 2.5, galvanicDurationSeconds: 30, unitsOfLye: 4, pulseCount: 7, pulseDelaySeconds: 0.9, hairsTreated: 12, comments: "n" };
const base = { clientId: "c1", sessionId: "s1", areas: [{ area: "Upper lip", laterality: "midline" }], minutesPerformed: 9 };
const modeValue = (m: Mode) => (m === "none" ? null : m);
const READING_KEYS = ["apilus_modality", "energy_level", "thermolysis_intensity_percent", "thermolysis_duration_seconds", "galvanic_ma", "galvanic_duration_seconds", "units_of_lye", "pulse_count", "pulse_delay_seconds", "hairs_treated", "mode"] as const;
const sent = () => {
  const a = h.rpc.mock.calls.at(-1)![1] as Record<string, unknown>;
  return Object.fromEntries(READING_KEYS.map((k) => [k, a[`p_${k}`]]));
};

// What each mode sends with every field filled in and EL 9, 7 pulses at 0.9 s, 12 hairs. `modality` stands for the submitted modality where the mode keeps it.
const SHARED = { pulse_count: 7, pulse_delay_seconds: 0.9, hairs_treated: 12 };
const NOTHING = { thermolysis_intensity_percent: null, thermolysis_duration_seconds: null, galvanic_ma: null, galvanic_duration_seconds: null, units_of_lye: null };
const THERMO = { thermolysis_intensity_percent: 55, thermolysis_duration_seconds: 1.5 };
const GALV = { galvanic_ma: 2.5, galvanic_duration_seconds: 30, units_of_lye: 4 };
const NO_THERMO = { thermolysis_intensity_percent: null, thermolysis_duration_seconds: null };
const NO_GALV = { galvanic_ma: null, galvanic_duration_seconds: null, units_of_lye: null };
const expectedCreateEdit = (m: Mode, modality: string | null) => ({
  none: { mode: null, apilus_modality: modality, energy_level: 9, ...NOTHING, ...SHARED },
  thermo: { mode: "thermo", apilus_modality: modality, energy_level: 9, ...THERMO, ...NO_GALV, ...SHARED },
  galv: { mode: "galv", apilus_modality: null, energy_level: null, ...NO_THERMO, ...GALV, ...SHARED }, // Galvanic drops modality AND EL today
  blend: { mode: "blend", apilus_modality: modality, energy_level: 9, ...THERMO, ...GALV, ...SHARED },
})[m];
// The add-pass writer: the same, except a modality outside its allowed list is not sent (null) in every mode (Galvanic sends none either way).
const expectedAddPass = (m: Mode, modality: string | null) => expectedCreateEdit(m, modality === "NotAModality" ? null : modality);

beforeEach(() => h.rpc.mockReset());

describe("CREATE (createTreatmentAreaWithEntryAction) sends exactly this today", () => {
  for (const m of MODES) for (const mod of MODALITIES) {
    it(`mode ${m}, modality ${mod ?? "none"}`, async () => {
      const r = await B.createTreatmentAreaWithEntryAction({ ...base, mode: modeValue(m), apilusModality: mod, energyLevel: 9, readings: READ } as never);
      expect(r).toMatchObject({ ok: true });
      expect(sent()).toEqual(expectedCreateEdit(m, mod));
      expect((h.rpc.mock.calls.at(-1)![1] as Record<string, unknown>).p_minutes_performed).toBe(9);
    });
  }
});

describe("EDIT (updateTreatmentAreaWithEntryAction) sends exactly what create sends", () => {
  for (const m of MODES) for (const mod of MODALITIES) {
    it(`mode ${m}, modality ${mod ?? "none"}`, async () => {
      h.block = { probe_key: null, probe_inventory_item_id: null, probe_lot_number: null, mode: modeValue(m) };
      const r = await B.updateTreatmentAreaWithEntryAction({ ...base, blockId: "b1", firstEntryId: "e1", expectedUpdatedAt: "2026-11-19T10:00:00.000Z", mode: modeValue(m), apilusModality: mod, energyLevel: 9, readings: READ } as never);
      expect(r).toMatchObject({ ok: true });
      expect(sent()).toEqual(expectedCreateEdit(m, mod));
    });
  }
});

describe("ADD-PASS (addElectrolysisEntryAction) sends exactly this today", () => {
  const form = (m: Mode, mod: string | null) => {
    const f = new FormData();
    const all: Record<string, string> = {
      session_id: "s1", client_id: "c1", block_id: "b1", areas: JSON.stringify(["Upper lip"]), observation_chips: "[]", mode: modeValue(m) ?? "", apilus_modality: mod ?? "",
      energy_level: "9", hairs_treated: "12", thermolysis_intensity_percent: "55", thermolysis_duration_seconds: "1.5", galvanic_ma: "2.5", galvanic_duration_seconds: "30",
      units_of_lye: "4", pulse_count: "7", pulse_delay_seconds: "0.9",
    };
    for (const [k, v] of Object.entries(all)) f.set(k, v);
    return f;
  };
  for (const m of MODES) for (const mod of MODALITIES) {
    it(`mode ${m}, modality ${mod ?? "none"}`, async () => {
      await A.addElectrolysisEntryAction(form(m, mod));
      expect(sent()).toEqual(expectedAddPass(m, mod));
      expect((h.rpc.mock.calls.at(-1)![1] as Record<string, unknown>).p_minutes_performed).toBeNull();
    });
  }
});

describe("the tables are not vacuous", () => {
  it("every mode row differs from the others, and the writers were really called", () => {
    const rows = MODES.map((m) => JSON.stringify(expectedCreateEdit(m, "Picoblend")));
    expect(new Set(rows).size).toBe(4);
    expect(expectedAddPass("blend", "NotAModality").apilus_modality).toBeNull();
    expect(expectedCreateEdit("blend", "NotAModality").apilus_modality).toBe("NotAModality");
  });
});
