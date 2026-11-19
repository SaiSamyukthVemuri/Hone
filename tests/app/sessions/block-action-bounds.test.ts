import { beforeEach, describe, expect, it, vi } from "vitest";

// Server-side bounds for the block-write actions: the action is called directly with FORGED input (fields the browser would never send for the mode), and the arguments
// that reach the database command are read. Driving the form is not enough: a hidden field is a convenience, this is the guard.
const h = vi.hoisted(() => ({
  rollout: true,
  rpc: vi.fn(),
  last: null as unknown,
  filters: [] as Array<[string, string, unknown]>,
  stored: { block: { probe_key: null, probe_inventory_item_id: null, probe_lot_number: null, mode: "thermo" } as Record<string, unknown>, entry: null as Record<string, unknown> | null, entries: undefined as Array<Record<string, unknown>> | undefined },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
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
      let liveOnly = false;
      for (const k of ["select", "order", "limit"]) chain[k] = self;
      // The mock HONOURS the live-only filter, so a read that forgets it is visible: removed rows come back unless `.is("deleted_at", null)` was asked for.
      chain.is = (c: string, v: unknown) => { if (c === "deleted_at" && v === null) liveOnly = true; return chain; };
      chain.eq = (c: string, v: unknown) => { h.filters.push([table, c, v]); return chain; };
      // A list read (the entries of a block) is awaited directly: it answers the stored entry rows.
      chain.then = (res: (v: unknown) => unknown) => res({ data: table === "electrolysis_entries" ? ((h.stored.entries ?? (h.stored.entry ? [h.stored.entry] : [])) as Array<Record<string, unknown>>).filter((r) => !liveOnly || r.deleted_at == null) : [], error: null });
      chain.single = async () => ({ data: { id: "b1", updated_at: "2026-11-19T10:00:00.000Z" }, error: null });
      chain.maybeSingle = async () => ({ data: table === "session_blocks" ? h.stored.block : h.stored.entry, error: null });
      return chain;
    },
  }),
}));

const A = await import("@/app/(app)/clients/[id]/sessions/[sessionId]/block-actions");

const base = { clientId: "c1", sessionId: "s1", areas: [{ area: "Upper lip", laterality: "midline" }] };
const create = (o: Record<string, unknown>, readings: Record<string, unknown> = {}) =>
  A.createTreatmentAreaWithEntryAction({ ...base, mode: "thermo", ...o, readings } as never);
const update = (o: Record<string, unknown>, readings: Record<string, unknown> = {}) =>
  A.updateTreatmentAreaWithEntryAction({ ...base, blockId: "b1", firstEntryId: "e1", expectedUpdatedAt: "2026-11-19T10:00:00.000Z", mode: "thermo", ...o, readings } as never);
beforeEach(() => {
  h.rpc.mockReset();
  h.filters = [];
  h.stored.block = { probe_key: null, probe_inventory_item_id: null, probe_lot_number: null, mode: "thermo" };
  h.stored.entry = null;
  h.stored.entries = undefined;
});

const BAD: Array<[string, Record<string, unknown>, Record<string, unknown>, string]> = [
  ["negative energy level", { energyLevel: -1 }, {}, "Energy level must be 0 or more"],
  ["minutes over 1440", { minutesPerformed: 1441 }, {}, "Minutes must be between 0 and 1440"],
  ["negative minutes", { minutesPerformed: -1 }, {}, "Minutes must be between 0 and 1440"],
  ["negative hairs treated", {}, { hairsTreated: -4 }, "Hairs treated"],
  ["pulse count 11", {}, { pulseCount: 11 }, "Pulse count must be between 1 and 10"],
  ["pulse count 0", {}, { pulseCount: 0 }, "Pulse count must be between 1 and 10"],
  ["intensity 101", {}, { thermolysisIntensityPercent: 101 }, "Thermolysis intensity must be between 0 and 100 (a whole number)"],
  ["negative thermolysis duration", {}, { thermolysisDurationSeconds: -1 }, "Thermolysis duration must be 0 or more"],
  ["decimal energy level (integer column)", { energyLevel: 2.5 }, {}, "Energy level must be 0 or more (a whole number)"],
  ["decimal minutes", { minutesPerformed: 10.5 }, {}, "Minutes must be between 0 and 1440 (a whole number)"],
  ["decimal hairs treated", {}, { hairsTreated: 1.5 }, "Hairs treated must be 0 or more (a whole number)"],
  ["decimal pulse count", {}, { pulseCount: 2.5 }, "Pulse count must be between 1 and 10 (a whole number)"],
  ["decimal intensity (integer column)", {}, { thermolysisIntensityPercent: 55.5 }, "Thermolysis intensity must be between 0 and 100 (a whole number)"],
  ["decimal galvanic duration (integer column)", {}, { galvanicDurationSeconds: 1.5 }, "Galvanic duration must be 0 or more (a whole number)"],
  ["negative galvanic mA", {}, { galvanicMa: -1 }, "Galvanic mA must be 0 or more"],
  ["not a number", { energyLevel: Number.NaN }, {}, "Energy level"],
];
describe("CREATE refuses an out-of-range value, names it, and writes nothing", () => {
  for (const [name, input, readings, text] of BAD) {
    it(name, async () => {
      const res = await create(input, readings);
      expect(res.ok).toBe(false);
      expect((res as { error: string }).error).toContain(text);
      expect(h.rpc).not.toHaveBeenCalled();
    });
  }
});
describe("UPDATE refuses the same values, and writes nothing", () => {
  for (const [name, input, readings, text] of BAD) {
    it(name, async () => {
      const res = await update(input, readings);
      expect(res.ok).toBe(false);
      expect((res as { error: string }).error).toContain(text);
      expect(h.rpc).not.toHaveBeenCalled();
    });
  }
});
describe("the refusal says nothing was saved, and never echoes the submitted value", () => {
  const SUBMITTED: Array<[string, Record<string, unknown>, Record<string, unknown>, string]> = [
    ["minutes 1441", { minutesPerformed: 1441 }, {}, "1441"],
    ["intensity 101", {}, { thermolysisIntensityPercent: 101 }, "101"],
    ["pulse count 11", {}, { pulseCount: 11 }, "11"],
    ["energy level -7", { energyLevel: -7 }, {}, "-7"],
    ["hairs -4", {}, { hairsTreated: -4 }, "-4"],
  ];
  for (const [name, input, readings, value] of SUBMITTED) {
    for (const [which, run] of [["create", create], ["update", update]] as const) {
      it(`${which}: ${name}`, async () => {
        const res = (await run(input, readings)) as { ok: boolean; error: string };
        expect(res.ok).toBe(false);
        expect(res.error).toMatch(/Nothing was saved\.$/);
        expect(res.error.replace(/between \d+ and \d+/g, "")).not.toContain(value);
        expect(h.rpc).not.toHaveBeenCalled();
      });
    }
  }
});
describe("controls: numeric columns keep their decimals (thermolysis duration, mA, units of lye are numeric)", () => {
  it("0.733 s, 7.5 mA and 2.5 units of lye are accepted on create and update", async () => {
    const readings = { thermolysisDurationSeconds: 0.733, galvanicMa: 7.5, unitsOfLye: 2.5 };
    expect((await create({ mode: "blend" }, readings)).ok).toBe(true);
    h.rpc.mockReset();
    expect((await update({ mode: "blend" }, readings)).ok).toBe(true);
  });
});
describe("controls: the edges and blanks save", () => {
  it("energy 0, minutes 0 and 1440, hairs 0, pulse count 1 and 10, intensity 0 and 100", async () => {
    for (const [input, readings] of [
      [{ energyLevel: 0, minutesPerformed: 0 }, { hairsTreated: 0, pulseCount: 1, thermolysisIntensityPercent: 0 }],
      [{ minutesPerformed: 1440 }, { pulseCount: 10, pulseDelaySeconds: 0.5, thermolysisIntensityPercent: 100 }],
    ] as Array<[Record<string, unknown>, Record<string, unknown>]>) {
      h.rpc.mockReset();
      expect((await create(input, readings)).ok).toBe(true);
      h.rpc.mockReset();
      expect((await update(input, readings)).ok).toBe(true);
    }
  });
  it("everything blank saves", async () => {
    expect((await create({}, {})).ok).toBe(true);
  });
});
