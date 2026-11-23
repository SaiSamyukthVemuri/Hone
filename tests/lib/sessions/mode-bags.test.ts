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
  type PulseTouched,
} from "@/lib/sessions/mode-bags";

const NONE: PulseTouched = { count: false, delay: false };
const BOTH: PulseTouched = { count: true, delay: true };
const base = () => ({ mode: "thermo", areas: ["upper lip"], hairsTreated: "40", comments: "note", ...emptyReadings() });

describe("switchMode: shared entries survive, each mode keeps its own readings", () => {
  it("keeps shared entries and parks the shown mode's readings", () => {
    const d = { ...base(), thermolysisIntensityPercent: "55", energyLevel: "12" };
    const s = switchMode({ draft: d, bags: {}, pulseTouched: NONE }, "galv");
    expect(s.draft.areas).toEqual(["upper lip"]);
    expect(s.draft.hairsTreated).toBe("40");
    expect(s.draft.comments).toBe("note");
    expect(s.draft.mode).toBe("galv");
    expect(s.draft.thermolysisIntensityPercent).toBe("");
    expect(s.bags.thermo.readings.thermolysisIntensityPercent).toBe("55");
  });
  it("restores a mode's bag when switching back, including the touched flag", () => {
    const d = { ...base(), thermolysisIntensityPercent: "55", pulseCount: "3" };
    const a = switchMode({ draft: d, bags: {}, pulseTouched: BOTH }, "galv");
    expect(a.pulseTouched).toEqual(NONE);
    const b = switchMode(a, "thermo");
    expect(b.draft.thermolysisIntensityPercent).toBe("55");
    expect(b.draft.pulseCount).toBe("3");
    expect(b.pulseTouched).toEqual(BOTH);
  });
  it("selecting alone adds no reading: a fresh mode is blank with untouched defaults", () => {
    const s = switchMode({ draft: { ...base(), mode: "" }, bags: {}, pulseTouched: NONE }, "blend");
    expect(s.draft).toMatchObject({ ...emptyReadings(), mode: "blend" });
    expect(s.pulseTouched).toEqual(NONE);
  });
  it("clearing the mode parks the readings and records no mode", () => {
    const d = { ...base(), energyLevel: "9" };
    const s = switchMode({ draft: d, bags: {}, pulseTouched: NONE }, "");
    expect(s.draft.mode).toBe("");
    expect(s.draft.energyLevel).toBe("");
    expect(s.bags.thermo.readings.energyLevel).toBe("9");
  });
  it("Hairs treated and Minutes performed are SHARED: four blocks' pairs survive every mode switch, there and back", () => {
    const pairs = [["31", "12"], ["47", "9"], ["58", "21"], ["64", "15"]];
    for (const [hairs, minutes] of pairs) {
      let st = { draft: { ...base(), hairsTreated: hairs, minutes }, bags: {} as ModeBags, pulseTouched: NONE };
      for (const to of ["galv", "blend", "", "thermo", "galv"]) {
        st = switchMode(st, to);
        expect(st.draft.hairsTreated).toBe(hairs);
        expect(st.draft.minutes).toBe(minutes);
      }
    }
  });
  it("same mode is a no-op", () => {
    const st = { draft: base(), bags: {}, pulseTouched: NONE };
    expect(switchMode(st, "thermo")).toBe(st);
  });
});

describe("hidden bags", () => {
  const bags: ModeBags = {
    thermo: { readings: { ...emptyReadings(), energyLevel: "5" }, pulseTouched: NONE },
    galv: { readings: emptyReadings(), pulseTouched: NONE },
    blend: { readings: emptyReadings(), pulseTouched: BOTH },
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

describe("each pulse control is recorded only once ITS OWN control was touched, and only with a thermolysis group", () => {
  it("untouched: neither is recorded", () => {
    expect(pulseRecordable("thermo", NONE)).toEqual({ count: false, delay: false });
    expect(pulseRecordable("blend", NONE)).toEqual({ count: false, delay: false });
  });
  it("count touched, delay untouched: the count is recorded and the untouched default delay is NOT", () => {
    expect(pulseRecordable("thermo", { count: true, delay: false })).toEqual({ count: true, delay: false });
    expect(pulseRecordable("blend", { count: false, delay: true })).toEqual({ count: false, delay: true });
  });
  it("galvanic and no mode record neither, even when touched", () => {
    expect(pulseRecordable("galv", BOTH)).toEqual({ count: false, delay: false });
    expect(pulseRecordable("", BOTH)).toEqual({ count: false, delay: false });
  });
  it("a parked bag with only the delay touched still counts as holding a value", () => {
    expect(bagHoldsValue({ readings: emptyReadings(), pulseTouched: { count: false, delay: true } })).toBe(true);
  });
});

describe("memory-only drafts (source guard)", () => {
  const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  const BAD = /localStorage|sessionStorage|indexedDB|document\.cookie|history\.(push|replace)State|beforeunload|console\.|sendBeacon|navigator\.|URLSearchParams|searchParams/;
  it("no storage, URL, beforeunload or logging in the bag code", () => {
    expect(strip(readFileSync("lib/sessions/mode-bags.ts", "utf8"))).not.toMatch(BAD);
  });
});
