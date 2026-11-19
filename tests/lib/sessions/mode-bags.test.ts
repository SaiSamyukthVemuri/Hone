import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  bagHoldsValue,
  emptyReadings,
  hiddenBagsNotice,
  hiddenModesWithValues,
  pulseRecordable,
  switchMode,
  type ModeBags,
} from "@/lib/sessions/mode-bags";

const base = () => ({ mode: "thermo", areas: ["upper lip"], hairsTreated: "40", comments: "note", ...emptyReadings() });

describe("switchMode: shared entries survive, each mode keeps its own readings", () => {
  it("keeps shared entries and parks the shown mode's readings", () => {
    const d = { ...base(), thermolysisIntensityPercent: "55", energyLevel: "12" };
    const s = switchMode({ draft: d, bags: {}, pulseTouched: false }, "galv");
    expect(s.draft.areas).toEqual(["upper lip"]);
    expect(s.draft.hairsTreated).toBe("40");
    expect(s.draft.comments).toBe("note");
    expect(s.draft.mode).toBe("galv");
    expect(s.draft.thermolysisIntensityPercent).toBe("");
    expect(s.bags.thermo.readings.thermolysisIntensityPercent).toBe("55");
  });
  it("restores a mode's bag when switching back, including the touched flag", () => {
    const d = { ...base(), thermolysisIntensityPercent: "55", pulseCount: "3" };
    const a = switchMode({ draft: d, bags: {}, pulseTouched: true }, "galv");
    expect(a.pulseTouched).toBe(false);
    const b = switchMode(a, "thermo");
    expect(b.draft.thermolysisIntensityPercent).toBe("55");
    expect(b.draft.pulseCount).toBe("3");
    expect(b.pulseTouched).toBe(true);
  });
  it("selecting alone adds no reading: a fresh mode is blank with untouched defaults", () => {
    const s = switchMode({ draft: { ...base(), mode: "" }, bags: {}, pulseTouched: false }, "blend");
    expect(s.draft).toMatchObject({ ...emptyReadings(), mode: "blend" });
    expect(s.pulseTouched).toBe(false);
  });
  it("clearing the mode parks the readings and records no mode", () => {
    const d = { ...base(), energyLevel: "9" };
    const s = switchMode({ draft: d, bags: {}, pulseTouched: false }, "");
    expect(s.draft.mode).toBe("");
    expect(s.draft.energyLevel).toBe("");
    expect(s.bags.thermo.readings.energyLevel).toBe("9");
  });
  it("same mode is a no-op", () => {
    const st = { draft: base(), bags: {}, pulseTouched: false };
    expect(switchMode(st, "thermo")).toBe(st);
  });
});

describe("hidden bags", () => {
  const bags: ModeBags = {
    thermo: { readings: { ...emptyReadings(), energyLevel: "5" }, pulseTouched: false },
    galv: { readings: emptyReadings(), pulseTouched: false },
    blend: { readings: emptyReadings(), pulseTouched: true },
  };
  it("a blank bag or one at untouched defaults holds no value", () => {
    expect(bagHoldsValue(bags.galv)).toBe(false);
    expect(bagHoldsValue(undefined)).toBe(false);
    expect(bagHoldsValue(bags.thermo)).toBe(true);
    expect(bagHoldsValue(bags.blend)).toBe(true);
  });
  it("lists only OTHER modes holding values", () => {
    expect(hiddenModesWithValues(bags, "thermo")).toEqual(["blend"]);
    expect(hiddenModesWithValues(bags, "galv").sort()).toEqual(["blend", "thermo"]);
  });
  it("the notice carries mode names only, never values", () => {
    expect(hiddenBagsNotice(["blend", "thermo"])).toBe("Blend and Thermolysis readings are kept in this draft and will not be saved.");
    expect(hiddenBagsNotice([])).toBeNull();
    expect(hiddenBagsNotice(["thermo"])).not.toMatch(/\d/);
  });
});

describe("pulse is recorded only once touched, and only with a thermolysis group", () => {
  it("untouched: never recorded", () => {
    expect(pulseRecordable("thermo", false)).toBe(false);
    expect(pulseRecordable("blend", false)).toBe(false);
  });
  it("touched: thermo and blend only", () => {
    expect(pulseRecordable("thermo", true)).toBe(true);
    expect(pulseRecordable("blend", true)).toBe(true);
    expect(pulseRecordable("galv", true)).toBe(false);
    expect(pulseRecordable("", true)).toBe(false);
  });
});

describe("memory-only drafts (source guard)", () => {
  const src = readFileSync("lib/sessions/mode-bags.ts", "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  it("no storage, URL, beforeunload or logging in the bag code", () => {
    expect(src).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie|history\.(push|replace)State|location\.|beforeunload|console\.|sendBeacon|fetch\(/);
  });
});

describe("Off path is the old behaviour (source guard)", () => {
  const f = readFileSync("app/(app)/clients/[id]/sessions/[sessionId]/block-setup-form.tsx", "utf8");
  it("every bag behaviour is gated on the rollout", () => {
    expect(f).toMatch(/if \(rollout\) \{\s*const next = switchMode/);
    expect(f).toMatch(/\} else update\("mode", selected \? "" : m\.value\)/);
    expect(f).toMatch(/const pulseHeld = rollout && !pulseRecordable/);
    expect(f).toMatch(/const hiddenModes = rollout \? hiddenModesWithValues/);
    expect(f.match(/if \(rollout\) setPulseTouched\(true\)/g)?.length).toBe(3);
  });
});
