import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { buildTreatmentSetupDraftPatch } from "@/lib/sessions/treatment-setup-snapshot";
import { normalizeWholeSessionCopy } from "@/lib/sessions/whole-session-copy-normalize";
import { readingFieldOrder } from "@/lib/sessions/reading-field-order";

// W6: every place Galvanic EL used to be dropped changes TOGETHER, only with the redesign on. Off is today's behaviour.
const block = { mode: "galv", apilus_modality: null, energy_level: 14, probe_key: null, machine_frequency: null, probe_lot_number: null, probe_inventory_item_id: null, probe_lot_confirmed: false } as never;
const entry = { mode: "galv", galvanic_ma: 2, galvanic_duration_seconds: 30, units_of_lye: 3, pulse_count: 1, pulse_delay_seconds: null } as never;
const setup = { mode: "galv", apilusModality: "", energyLevel: "14", probeKey: "", machineFrequency: "", thermolysisIntensityPercent: "", thermolysisDurationSeconds: "", galvanicMa: "2", galvanicDurationSeconds: "30", unitsOfLye: "3", pulseCount: "1", pulseDelay: "" };
const draft = [{ areas: [{ area: "Upper lip", laterality: "midline" }], customAreaDetail: null, setup }];

describe("copy-settings patch (the chart form)", () => {
  it("on: the Galvanic EL is copied", () => expect(buildTreatmentSetupDraftPatch(block, entry, undefined, { keepGalvanicEnergy: true }).energyLevel).toBe("14"));
  it("off (default): cleared exactly as before", () => {
    expect(buildTreatmentSetupDraftPatch(block, entry).energyLevel).toBe("");
    expect(buildTreatmentSetupDraftPatch(block, entry, undefined, {}).energyLevel).toBe("");
  });
});
describe("whole-session copy normaliser (server)", () => {
  const el = (opts?: { keepGalvanicEnergy?: boolean }) => {
    const r = normalizeWholeSessionCopy(draft, opts);
    if (!r.ok) throw new Error(r.error);
    return { block: (r.specs[0].block as Record<string, unknown>).energy_level, entry: (r.specs[0].entry as Record<string, unknown> | null)?.energy_level };
  };
  it("on: EL survives on the block and the entry", () => expect(el({ keepGalvanicEnergy: true })).toEqual({ block: 14, entry: 14 }));
  it("off (default): null, as before", () => expect(el()).toEqual({ block: null, entry: null }));
  it("a non-galvanic copy is unaffected either way", () => {
    const d = [{ ...draft[0], setup: { ...setup, mode: "thermo", apilusModality: "Picoflash", thermolysisIntensityPercent: "40", thermolysisDurationSeconds: "0.5" } }];
    for (const keep of [true, false]) {
      const r = normalizeWholeSessionCopy(d, { keepGalvanicEnergy: keep });
      expect(r.ok && (r.specs[0].block as Record<string, unknown>).energy_level).toBe(14);
    }
  });
});
describe("reading order", () => {
  it("on: Galvanic lists EL; off: it does not (today)", () => {
    expect(readingFieldOrder("galv", { keepGalvanicEnergy: true })).toContain("energyLevel");
    expect(readingFieldOrder("galv")).not.toContain("energyLevel");
  });
});
describe("the list of places is pinned (a new place cannot be added silently)", () => {
  const places: Array<[string, RegExp]> = [
    ["app/(app)/clients/[id]/sessions/[sessionId]/block-actions.ts", /keepGalvanicEnergy: redesignOn,/],
    ["app/(app)/clients/[id]/sessions/[sessionId]/actions.ts", /keepsEnergyLevel = redesignOn \? Boolean\(passGroups\.energy\) : mode !== "galv"/],
    ["lib/sessions/treatment-setup-snapshot.ts", /isGalv && !opts\.keepGalvanicEnergy/],
    ["lib/sessions/whole-session-copy-normalize.ts", /isGalv && !keepGalvanicEnergy/],
    ["app/(app)/clients/[id]/sessions/[sessionId]/whole-session-copy-actions.ts", /keepGalvanicEnergy: await chartingRolloutFor\(studio\.id\)/],
    ["app/(app)/clients/[id]/sessions/[sessionId]/CopyPreviousAreasPanel.tsx", /keepGalvanicEnergy: rollout/],
    ["app/(app)/clients/[id]/sessions/[sessionId]/block-setup-form.tsx", /keepGalvanicEnergy: rollout/],
    ["components/copy-draft-card.tsx", /keepGalvanicEnergy && s\.mode === "galv"/],
    ["lib/sessions/reading-field-order.ts", /opts\.keepGalvanicEnergy === true/],
  ];
  for (const [f, re] of places) it(`${f} carries the rollout-gated Galvanic EL rule`, () => expect(readFileSync(f, "utf8")).toMatch(re));
  it("READ-ONLY displays that still drop Galvanic EL are listed, not forgotten (point-of-care memory, history card)", () => {
    expect(readFileSync("lib/sessions/point-of-care-memory.ts", "utf8")).toMatch(/energyLevel: mode === "galv" \? null/);
  });
});
