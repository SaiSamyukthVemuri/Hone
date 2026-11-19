import { beforeEach, describe, expect, it, vi } from "vitest";

// W2 / W4 on the SERVER: the action is called directly with FORGED input (fields the browser would never send for the mode), and the arguments
// that reach the database command are read. Driving the form is not enough: a hidden field is a convenience, this is the guard.
const h = vi.hoisted(() => ({
  rollout: true,
  rpc: vi.fn(),
  last: null as unknown,
  filters: [] as Array<[string, string, unknown]>,
  stored: { block: { probe_key: null, probe_inventory_item_id: null, probe_lot_number: null, mode: "thermo" } as Record<string, unknown>, entry: null as Record<string, unknown> | null },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/rollouts/charting-rollout", () => ({ chartingRolloutFor: vi.fn(async () => h.rollout) }));
vi.mock("@/lib/sessions/session-lineage", () => ({
  assertSessionForClient: vi.fn(async () => undefined),
  SessionLineageError: class extends Error {},
}));
const who = { practitioner: { active: true, id: "p1" }, studio: { id: "st1" } };
vi.mock("@/lib/supabase/writing-identity", () => ({ resolveWritingIdentity: vi.fn(async () => ({ ok: true, value: who })) }));
vi.mock("@/lib/supabase/queries", () => ({ getCurrentPractitionerWithStudio: vi.fn(async () => who) }));
vi.mock("@/lib/record-keeping/probe-inventory-validation", () => ({
  resolveProbeInventorySelection: vi.fn(async () => ({ ok: true, probeLotNumber: null, probeInventoryItemId: null })),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc: (fn: string, args: Record<string, unknown>) => {
      h.rpc(fn, args);
      return Promise.resolve({ data: { block_id: "b1", entry_id: "e1", updated_at: "2026-11-19T10:00:00.000Z" }, error: null });
    },
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      for (const k of ["select", "is", "order", "limit"]) chain[k] = self;
      chain.eq = (c: string, v: unknown) => { h.filters.push([table, c, v]); return chain; };
      // A list read (the entries of a block) is awaited directly: it answers the stored entry rows.
      chain.then = (res: (v: unknown) => unknown) => res({ data: table === "electrolysis_entries" ? (h.stored.entry ? [h.stored.entry] : []) : [], error: null });
      chain.single = async () => ({ data: { id: "b1", updated_at: "2026-11-19T10:00:00.000Z" }, error: null });
      chain.maybeSingle = async () => ({ data: table === "session_blocks" ? h.stored.block : h.stored.entry, error: null });
      return chain;
    },
  }),
}));

const A = await import("@/app/(app)/clients/[id]/sessions/[sessionId]/block-actions");

const FORGED_READINGS = {
  thermolysisIntensityPercent: 55, thermolysisDurationSeconds: 1.5, galvanicMa: 2.5, galvanicDurationSeconds: 30,
  unitsOfLye: 4, pulseCount: 7, pulseDelaySeconds: 0.9, hairsTreated: 12, comments: "shared note",
};
const base = { clientId: "c1", sessionId: "s1", areas: [{ area: "Upper lip", laterality: "midline" }], minutesPerformed: 9 };
const create = async (o: Record<string, unknown>) => (h.last = await A.createTreatmentAreaWithEntryAction({ ...base, ...o, readings: { ...FORGED_READINGS, ...((o.readings as object) ?? {}) } } as never));
const update = async (o: Record<string, unknown>) => (h.last = await A.updateTreatmentAreaWithEntryAction({ ...base, blockId: "b1", firstEntryId: "e1", expectedUpdatedAt: "2026-11-19T10:00:00.000Z", ...o, readings: { ...FORGED_READINGS, ...((o.readings as object) ?? {}) } } as never));
const lastArgs = () => {
  const c = h.rpc.mock.calls.at(-1);
  if (!c) throw new Error("no rpc");
  return c[1] as Record<string, unknown>;
};
const readingArgs = (a: Record<string, unknown>) => ({
  ma: a.p_galvanic_ma, gdur: a.p_galvanic_duration_seconds, tint: a.p_thermolysis_intensity_percent, tdur: a.p_thermolysis_duration_seconds,
  ul: a.p_units_of_lye, mod: a.p_apilus_modality, el: a.p_energy_level, count: a.p_pulse_count, delay: a.p_pulse_delay_seconds,
  hairs: a.p_hairs_treated, minutes: a.p_minutes_performed, mode: a.p_mode,
});
const NONE = { ma: null, gdur: null, tint: null, tdur: null, ul: null, mod: null, el: null };

beforeEach(() => {
  h.rpc.mockReset();
  h.filters = [];
  h.rollout = true;
  h.stored.block = { probe_key: null, probe_inventory_item_id: null, probe_lot_number: null, mode: "thermo" };
  h.stored.entry = null;
});

describe("CREATE with the rollout ON drops every field that does not belong to the submitted mode", () => {
  it("NO MODE: forged readings of every group, modality and EL are all dropped; shared entries survive", async () => {
    await create({ mode: null, apilusModality: "Picoflash", energyLevel: 9 });
    expect(readingArgs(lastArgs())).toMatchObject({ ...NONE, hairs: 12, minutes: 9, mode: null });
  });
  it("THERMOLYSIS: galvanic group and UL dropped; thermolysis, modality, EL kept", async () => {
    await create({ mode: "thermo", apilusModality: "Picoflash", energyLevel: 9 });
    expect(readingArgs(lastArgs())).toMatchObject({ ma: null, gdur: null, ul: null, tint: 55, tdur: 1.5, mod: "Picoflash", el: 9, count: 7, delay: 0.9 });
  });
  it("GALVANIC: thermolysis group, modality and pulse dropped; galvanic group, UL and EL KEPT (Galvanic saves EL)", async () => {
    await create({ mode: "galv", apilusModality: "Picoflash", energyLevel: 9 });
    const r = readingArgs(lastArgs());
    expect(r).toMatchObject({ tint: null, tdur: null, mod: null, ma: 2.5, gdur: 30, ul: 4, el: 9 });
    expect(r.count, "no forged pulse count is recorded").not.toBe(7);
    expect(r.delay).toBeNull();
  });
  it("BLEND keeps everything; OMNIBLEND drops thermolysis duration only", async () => {
    await create({ mode: "blend", apilusModality: "Multiblend", energyLevel: 9 });
    expect(readingArgs(lastArgs())).toMatchObject({ tint: 55, tdur: 1.5, ma: 2.5, ul: 4 });
    await create({ mode: "blend", apilusModality: "Omniblend", energyLevel: 9 });
    expect(readingArgs(lastArgs())).toMatchObject({ tint: 55, tdur: null, ma: 2.5, ul: 4 });
  });
});

describe("a forged MODE value is refused before anything else (rollout on)", () => {
  for (const mode of ["multiplex", "THERMO", "x'; drop", "thermolysis"]) {
    it(`create and edit with mode ${JSON.stringify(mode)}: refused, nothing written`, async () => {
      expect((await create({ mode })).ok).toBe(false);
      expect((await update({ mode })).ok).toBe(false);
      expect(h.rpc).not.toHaveBeenCalled();
    });
  }
});

describe("EDIT with the rollout ON: the same rule, and the freeze", () => {
  it("forged thermolysis fields on a galvanic edit are dropped", async () => {
    h.stored.block = { ...h.stored.block, mode: "galv" };
    await update({ mode: "galv", apilusModality: "Picoflash", energyLevel: 9 });
    expect(readingArgs(lastArgs())).toMatchObject({ tint: null, tdur: null, mod: null, ma: 2.5, el: 9 });
  });
  it("forged readings on a NO-MODE edit are dropped", async () => {
    h.stored.block = { ...h.stored.block, mode: null };
    await update({ mode: null, apilusModality: "Picoflash", energyLevel: 9 });
    expect(readingArgs(lastArgs())).toMatchObject({ ...NONE, hairs: 12 });
  });
  it("FREEZE: changing the mode of a block that holds readings is REFUSED, and nothing is written", async () => {
    h.stored.block = { ...h.stored.block, mode: "thermo" };
    h.stored.entry = { thermolysis_intensity_percent: 40 };
    const res = await update({ mode: "galv" });
    expect(res.ok).toBe(false);
    expect(h.rpc).not.toHaveBeenCalled();
  });
  it("FREEZE cannot be skipped by FORGING the entry id: omitted, swapped or foreign, the block's own readings still refuse the change", async () => {
    h.stored.block = { ...h.stored.block, mode: "thermo" };
    h.stored.entry = { thermolysis_intensity_percent: 40 };
    for (const firstEntryId of [null, undefined, "11111111-1111-1111-1111-111111111111"]) {
      h.rpc.mockReset();
      const res = await update({ mode: "galv", firstEntryId });
      expect(res.ok, `firstEntryId=${String(firstEntryId)}`).toBe(false);
      expect(h.rpc).not.toHaveBeenCalled();
    }
  });
  it("the freeze reads the entries BY BLOCK and STUDIO (not the client's entry id), and ANY live entry with readings freezes", async () => {
    h.stored.block = { ...h.stored.block, mode: "thermo" };
    h.stored.entry = { thermolysis_intensity_percent: 40 };
    await update({ mode: "galv", firstEntryId: "someone-elses-entry" });
    const f = h.filters.filter((x) => x[0] === "electrolysis_entries");
    expect(f).toContainEqual(["electrolysis_entries", "block_id", "b1"]);
    expect(f).toContainEqual(["electrolysis_entries", "studio_id", "st1"]);
    expect(f.some((x) => x[1] === "id"), "never filtered by a client-supplied entry id").toBe(false);
  });
  it("a block that holds ONLY pulse values is not frozen (stated rule)", async () => {
    h.stored.block = { ...h.stored.block, mode: "thermo" };
    h.stored.entry = { thermolysis_intensity_percent: null, galvanic_ma: null };
    expect((await update({ mode: "galv" })).ok).toBe(true);
  });
  it("FREEZE control: the SAME mode on a block with readings saves", async () => {
    h.stored.block = { ...h.stored.block, mode: "thermo" };
    h.stored.entry = { thermolysis_intensity_percent: 40 };
    const res = await update({ mode: "thermo" });
    expect(res.ok).toBe(true);
    expect(h.rpc).toHaveBeenCalledTimes(1);
  });
  it("a block with NO readings may still get its first mode", async () => {
    h.stored.block = { ...h.stored.block, mode: null };
    h.stored.entry = { thermolysis_intensity_percent: null };
    expect((await update({ mode: "thermo" })).ok).toBe(true);
  });
});

describe("xCell Pur's legacy modes are REFUSED once the redesign is on, never saved under the old xCell identity", () => {
  for (const mode of ["thermo", "blend", "galv"]) {
    it(`create ${mode} with the Pur model chosen: refused with the clear message, nothing written`, async () => {
      const res = await create({ mode, machineIdentity: { machineId: null, modeKey: null, profileId: "dectro-apilus:xcell-pur" } });
      expect(res.ok).toBe(false);
      expect((res as { error: string }).error).toMatch(/xCell Pur's Thermolysis, Blend and Galvanic can't be recorded yet\. Nothing was saved/);
      expect(h.rpc).not.toHaveBeenCalled();
    });
  }
});

describe("the rollout OFF: the request is used exactly as it always was", () => {
  it("create: forged fields pass through the legacy rules unchanged (thermolysis group on a galvanic entry still nulled by the OLD mode-gating, EL still dropped)", async () => {
    h.rollout = false;
    await create({ mode: "galv", apilusModality: "Picoflash", energyLevel: 9 });
    const r = readingArgs(lastArgs());
    expect(r).toMatchObject({ tint: null, tdur: null, ma: 2.5, el: null, mod: null });
    expect(r.count).toBe(7); // the old path never dropped a pulse count: Off is byte-for-byte today
  });
  it("create with no mode: the old path stores what it was sent", async () => {
    h.rollout = false;
    await create({ mode: null, apilusModality: "Picoflash", energyLevel: 9 });
    expect(readingArgs(lastArgs())).toMatchObject({ mod: "Picoflash", el: 9, count: 7 });
  });
  it("edit: no freeze when off", async () => {
    h.rollout = false;
    h.stored.entry = { thermolysis_intensity_percent: 40 };
    expect((await update({ mode: "galv" })).ok).toBe(true);
  });
});

describe("minutes: the action writes the SAME absolute value however many times it is saved (rollout on and off)", () => {
  for (const on of [true, false]) {
    it(`edit saved twice with minutes 9 (rollout ${on ? "on" : "off"}): both writes carry exactly 9 on the block and the entry, never 18`, async () => {
      h.rollout = on;
      h.stored.block = { ...h.stored.block, mode: "thermo" };
      await update({ mode: "thermo", minutesPerformed: 9 });
      await update({ mode: "thermo", minutesPerformed: 9 });
      const calls = h.rpc.mock.calls.filter((c) => c[0] === "update_block_with_entry").map((c) => c[1] as Record<string, unknown>);
      expect(calls).toHaveLength(2);
      for (const a of calls) {
        expect(a.p_minutes_performed).toBe(9);
        expect((a.p_block as Record<string, unknown>).minutes_performed).toBe(9);
      }
    });
  }
  it("editing 9 to 25 sends 25 (a replacement, not an addition)", async () => {
    await update({ mode: "thermo", minutesPerformed: 9 });
    await update({ mode: "thermo", minutesPerformed: 25 });
    const a = lastArgs();
    expect(a.p_minutes_performed).toBe(25);
    expect((a.p_block as Record<string, unknown>).minutes_performed).toBe(25);
  });
});

describe("W4/W2 source pins", () => {
  it("both write paths scope before shaping, and only behind the rollout", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("app/(app)/clients/[id]/sessions/[sessionId]/block-actions.ts", "utf8");
    expect((src.match(/if \(redesignOn\) input = scopeToMode\(input\);/g) ?? []).length).toBe(2);
    expect((src.match(/keepGalvanicEnergy: redesignOn,/g) ?? []).length).toBe(2);
  });
});
