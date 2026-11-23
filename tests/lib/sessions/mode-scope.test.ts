import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  MODE_FROZEN_MESSAGE,
  entryHasReadings,
  groupsForMode,
  isKnownMode,
  isOmniblend,
  modeChangeRefused,
  scopeToMode,
  type ScopableInput,
} from "@/lib/sessions/mode-scope";

// The server's rule for which reading fields belong to a mode. Pure and not wired to any write path yet: these tests pin the rule itself.

const FULL: ScopableInput = {
  apilusModality: "Apilus",
  energyLevel: 7,
  readings: {
    pulseCount: 3, pulseDelaySeconds: 0.5, galvanicMa: 2, galvanicDurationSeconds: 60,
    thermolysisIntensityPercent: 40, thermolysisDurationSeconds: 5, unitsOfLye: 4, probe: "x",
  },
};
const R = (i: ScopableInput) => i.readings as Record<string, unknown>;

describe("groupsForMode", () => {
  it.each([
    ["thermo", { thermolysis: true, galvanic: false, modality: true, energy: true, pulse: true }],
    ["galv", { thermolysis: false, galvanic: true, modality: false, energy: true, pulse: false }],
    ["blend", { thermolysis: true, galvanic: true, modality: true, energy: true, pulse: true }],
    ["", { thermolysis: false, galvanic: false, modality: false, energy: false, pulse: false }],
    ["other", { thermolysis: false, galvanic: false, modality: false, energy: false, pulse: false }],
    [" thermo ", { thermolysis: true, galvanic: false, modality: true, energy: true, pulse: true }],
  ])("%j", (m, g) => expect(groupsForMode(m)).toEqual(g));
  it("null and undefined mean no mode", () => {
    expect(groupsForMode(null)).toEqual(groupsForMode(""));
    expect(groupsForMode(undefined)).toEqual(groupsForMode(""));
  });
});

describe("scopeToMode drops what does not belong, whatever was sent", () => {
  it("no mode: no readings at all, shared entries untouched", () => {
    const o = scopeToMode({ ...FULL, mode: null });
    expect(o.apilusModality).toBeNull();
    expect(o.energyLevel).toBeNull();
    for (const k of ["pulseCount", "pulseDelaySeconds", "galvanicMa", "galvanicDurationSeconds", "thermolysisIntensityPercent", "thermolysisDurationSeconds", "unitsOfLye"]) expect(R(o)[k]).toBeNull();
    expect(R(o).probe).toBe("x");
  });
  it("thermolysis keeps modality, EL, thermolysis and pulse; drops galvanic and UL", () => {
    const o = scopeToMode({ ...FULL, mode: "thermo" });
    expect(o.apilusModality).toBe("Apilus");
    expect(o.energyLevel).toBe(7);
    expect(R(o)).toMatchObject({ thermolysisIntensityPercent: 40, thermolysisDurationSeconds: 5, pulseCount: 3, pulseDelaySeconds: 0.5, galvanicMa: null, galvanicDurationSeconds: null, unitsOfLye: null });
  });
  it("galvanic keeps galvanic, UL and EL (a deliberate change: it used to drop EL); drops modality, thermolysis and pulse", () => {
    const o = scopeToMode({ ...FULL, mode: "galv" });
    expect(o.apilusModality).toBeNull();
    expect(o.energyLevel).toBe(7);
    expect(R(o)).toMatchObject({ galvanicMa: 2, galvanicDurationSeconds: 60, unitsOfLye: 4, thermolysisIntensityPercent: null, thermolysisDurationSeconds: null, pulseCount: null, pulseDelaySeconds: null });
  });
  it("blend keeps everything", () => {
    const o = scopeToMode({ ...FULL, mode: "blend" });
    expect(o.apilusModality).toBe("Apilus");
    expect(R(o)).toMatchObject({ galvanicMa: 2, thermolysisDurationSeconds: 5, pulseCount: 3, unitsOfLye: 4 });
  });
  it("OmniBlend has no thermolysis duration, but keeps its intensity", () => {
    const o = scopeToMode({ ...FULL, mode: "blend", apilusModality: "OmniBlend" });
    expect(R(o).thermolysisDurationSeconds).toBeNull();
    expect(R(o).thermolysisIntensityPercent).toBe(40);
  });
  it("an unknown or forged mode keeps no readings", () => {
    const o = scopeToMode({ ...FULL, mode: "xcell-pur" });
    expect(o.energyLevel).toBeNull();
    expect(R(o).galvanicMa).toBeNull();
  });
  it("is pure: the input is not mutated and a missing readings object is fine", () => {
    const input = structuredClone({ ...FULL, mode: "galv" });
    const copy = structuredClone(input);
    scopeToMode(input);
    expect(input).toEqual(copy);
    expect(scopeToMode<ScopableInput>({ mode: "thermo" }).readings).toMatchObject({ pulseCount: null, thermolysisIntensityPercent: null });
  });
  it("scoping twice changes nothing more", () => {
    for (const mode of ["", "thermo", "galv", "blend"]) {
      const once = scopeToMode({ ...FULL, mode });
      expect(scopeToMode(once)).toEqual(once);
    }
  });
});

describe("isOmniblend / isKnownMode", () => {
  it("OmniBlend only in blend, any case", () => {
    expect(isOmniblend("blend", "OmniBlend")).toBe(true);
    expect(isOmniblend("blend", " omniblend ")).toBe(true);
    expect(isOmniblend("thermo", "OmniBlend")).toBe(false);
    expect(isOmniblend("blend", "Apilus")).toBe(false);
    expect(isOmniblend(null, null)).toBe(false);
  });
  it("the only modes are none, thermo, galv and blend", () => {
    for (const m of ["", "thermo", "galv", "blend", null, undefined, "  "]) expect(isKnownMode(m)).toBe(true);
    for (const m of ["xcell", "Thermo", "galvanic", "blend2", "thermo;"]) expect(isKnownMode(m)).toBe(false);
  });
});

describe("the freeze rule", () => {
  it("any reading column counts; pulse alone does not", () => {
    for (const k of ["thermolysis_intensity_percent", "thermolysis_duration_seconds", "galvanic_ma", "galvanic_duration_seconds", "units_of_lye", "energy_level", "apilus_modality"])
      expect(entryHasReadings({ [k]: 1 })).toBe(true);
    expect(entryHasReadings({ pulse_count: 1, pulse_delay_seconds: 0.5 })).toBe(false);
    expect(entryHasReadings({ galvanic_ma: null })).toBe(false);
    expect(entryHasReadings(null)).toBe(false);
    expect(entryHasReadings(undefined)).toBe(false);
  });
  it("a block with readings cannot change mode; one without can; same mode is fine; none equals empty", () => {
    expect(modeChangeRefused({ storedMode: "thermo", submittedMode: "galv", hasReadings: true })).toBe(true);
    expect(modeChangeRefused({ storedMode: "thermo", submittedMode: "galv", hasReadings: false })).toBe(false);
    expect(modeChangeRefused({ storedMode: "thermo", submittedMode: "thermo", hasReadings: true })).toBe(false);
    expect(modeChangeRefused({ storedMode: null, submittedMode: "", hasReadings: true })).toBe(false);
    expect(modeChangeRefused({ storedMode: "", submittedMode: "thermo", hasReadings: true })).toBe(true);
    expect(modeChangeRefused({ storedMode: "thermo", submittedMode: null, hasReadings: true })).toBe(true);
  });
  it("the message names the way forward", () => {
    expect(MODE_FROZEN_MESSAGE).toContain("Add a new settings block");
  });
});

describe("the module is pure", () => {
  it("imports nothing and touches no environment", () => {
    const src = readFileSync("lib/sessions/mode-scope.ts", "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    expect(src).not.toMatch(/^import /m);
    expect(src).not.toMatch(/process\.|window\.|document\.|fetch\(/);
  });
});
