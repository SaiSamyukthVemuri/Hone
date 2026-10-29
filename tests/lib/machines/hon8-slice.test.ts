import { describe, expect, it } from "vitest";
import { APILUS_3G_PROFILES, APILUS_3G_TEXT_PROFILES } from "../../../lib/machines/apilus-3g";
import { APILUS_3G_NATIVE_FIXTURES, APILUS_3G_TEXT_FIXTURES } from "../../../lib/machines/apilus-3g-fixtures";
import { modeFields, type MachineField, type MachineMode } from "../../../lib/machines/profile-contract";
import { ROUTINE_REQUIRED_INPUT_BUDGET, budgetViolations, routineRequiredInputs, sliceViolations } from "../../../lib/machines/slice-gate";

// HON-8 23 Nov slice: Senior/Junior 3G create/save/reload/next-visit, manufacturer-agreed fields only (OPS ruling 2026-10-27).
const f = (key: string, optional = false): MachineField => ({
  key, nativeLabel: key, quantity: "count", unit: "count", decimals: 0, optional, expectedSource: "practitioner-entered", editable: true,
  verification: "manufacturer-documented", evidence: ["e"],
});
const mode = (fields: MachineField[], stages: MachineMode["stages"] = []): MachineMode => ({
  key: "m", nativeLabel: "m", family: "thermolysis", fields, stages, availability: "active", verification: "manufacturer-documented", evidence: ["e"],
});
const slice = [...APILUS_3G_NATIVE_FIXTURES, ...APILUS_3G_TEXT_FIXTURES];

describe("routine-capture budget: native fields only, at most 6 required inputs per group", () => {
  it("is 6", () => expect(ROUTINE_REQUIRED_INPUT_BUDGET).toBe(6));
  it("holds for every mode the slice offers (native v2 and text v3 Senior/Junior fixtures)", () => {
    expect(slice.length).toBe(4);
    expect(budgetViolations(slice)).toEqual([]);
  });
  it("holds for every mode of the real v2 and v3 contracts, held ones included, so releasing a hold cannot break it", () => {
    expect(budgetViolations([...APILUS_3G_PROFILES, ...APILUS_3G_TEXT_PROFILES])).toEqual([]);
  });
  it("is tight: the largest real group needs exactly 6, so one more required field anywhere reds this suite", () => {
    const max = Math.max(...[...APILUS_3G_PROFILES, ...APILUS_3G_TEXT_PROFILES].flatMap((p) => p.modes.map(routineRequiredInputs)));
    expect(max).toBe(6);
  });
  it("counts stage fields with the mode's own, and never counts optional fields", () => {
    expect(routineRequiredInputs(mode([f("a"), f("b")], [{ key: "s", nativeLabel: "s", fields: [f("c"), f("d", true)] }]))).toBe(3);
    expect(routineRequiredInputs(mode([f("a", true), f("b", true)]))).toBe(0);
  });
  // NEGATIVE CONTROL: the check must fail on a real violation, or a green result proves nothing.
  it("NEGATIVE CONTROL: a 7th required input is flagged, 7 optional ones are not, a 6-required mode passes", () => {
    const prof = (m: MachineMode) => ({ ...structuredClone(slice[0]), profileId: "control", modes: [m] });
    const seven = mode(["a", "b", "c", "d", "e", "f", "g"].map((k) => f(k)));
    expect(budgetViolations([prof(seven)])).toEqual([{ profileId: "control", modeKey: "m", required: 7 }]);
    expect(budgetViolations([prof(mode(["a", "b", "c", "d", "e", "f", "g"].map((k) => f(k, true))))])).toEqual([]);
    expect(budgetViolations([prof(mode(["a", "b", "c", "d", "e", "f"].map((k) => f(k))))])).toEqual([]);
    const real = structuredClone(slice[2]);                               // a real text fixture mode, pushed one over
    real.modes[0].fields.push(f("extra_required"), f("extra_required_2"), f("extra_required_3"), f("extra_required_4"));
    expect(budgetViolations([real]).length).toBeGreaterThan(0);
  });
});

describe("23 Nov slice: only manufacturer-agreed fields are offered; conflicting or firmware-dependent ones stay identity-only", () => {
  it("offers exactly the reviewed modes per model and version", () => {
    expect(APILUS_3G_NATIVE_FIXTURES.map((p) => p.modes.map((m) => m.key))).toEqual([["flash", "microflash", "multiplex", "electrolysis"], ["flash", "electrolysis"]]);
    expect(APILUS_3G_TEXT_FIXTURES.map((p) => p.modes.map((m) => m.key))).toEqual([
      ["flash", "microflash", "multiplex", "blend", "omniblend", "multiblend", "electrolysis"], ["flash", "blend", "electrolysis"]]);
  });
  it("every offered mode is free of holds, unverified aspects, open questions, enforced ranges and missing evidence", () => {
    for (const p of slice) expect(sliceViolations(p), p.profileId).toEqual([]);
  });
  it("what is NOT offered stays out: Junior Thermolysis (precision unresolved) and Junior OmniBlend (starting-current contradiction), in v2 and v3", () => {
    for (const p of slice.filter((x) => x.profileId.includes("junior"))) {
      expect(p.modes.map((m) => m.key)).not.toContain("thermolysis");
      expect(p.modes.map((m) => m.key)).not.toContain("omniblend");
    }
    for (const real of [...APILUS_3G_PROFILES, ...APILUS_3G_TEXT_PROFILES].filter((x) => x.model === "Junior 3G")) {
      const th = real.modes.find((m) => m.key === "thermolysis")!;
      expect(modeFields(th).some(({ field }) => field.unverified?.includes("decimals"))).toBe(true);
      expect(sliceViolations({ ...real, modes: [th] }).length).toBeGreaterThan(0);
    }
  });
  it("the real held modes would be refused by the slice gate (v2 Blend/OmniBlend/MultiBlend carry a starting-current hold)", () => {
    for (const real of APILUS_3G_PROFILES) {
      const held = real.modes.filter((m) => m.captureHold);
      expect(held.length).toBeGreaterThan(0);
      for (const m of held) expect(sliceViolations({ ...real, modes: [m] }).some((v) => v.reason === "capture hold")).toBe(true);
    }
  });
  it("disputed bounds stay visible as notes and are never enforced: no range on any slice field; max_hf and Junior galvanic current keep their conflict note", () => {
    for (const p of slice) for (const m of p.modes) for (const { field } of modeFields(m)) expect(field.ranges, `${p.profileId}/${m.key}/${field.key}`).toBeUndefined();
    const note = (p: (typeof slice)[number], key: string) => p.modes.flatMap((m) => modeFields(m)).find(({ field }) => field.key === key)?.field.note ?? "";
    expect(note(APILUS_3G_TEXT_FIXTURES[0], "max_hf")).toMatch(/19%.*29%/);
    expect(note(APILUS_3G_NATIVE_FIXTURES[1], "galvanic_current")).toMatch(/0\.99.*1\.99/);
  });
  // NEGATIVE CONTROLS for the slice gate itself.
  it("NEGATIVE CONTROL: a mode with a hold, an unverified aspect, an enforced range, a missing evidence id or an open question is flagged", () => {
    const base = structuredClone(APILUS_3G_TEXT_FIXTURES[0]);
    const withMode = (mutate: (m: MachineMode) => void) => { const p = structuredClone(base); mutate(p.modes[0]); return sliceViolations(p); };
    expect(withMode((m) => { m.captureHold = "hold"; }).map((v) => v.reason)).toContain("capture hold");
    expect(withMode((m) => { m.fields[0].unverified = ["decimals"]; }).some((v) => /unverified decimals/.test(v.reason))).toBe(true);
    expect(withMode((m) => { m.fields[0].ranges = [{ min: 0, max: 1 } as never]; }).some((v) => /enforces a range/.test(v.reason))).toBe(true);
    expect(withMode((m) => { m.fields[0].evidence = ["nope"]; }).some((v) => /evidence missing/.test(v.reason))).toBe(true);
    expect(withMode((m) => { m.fields[0].evidence = []; }).some((v) => /evidence missing/.test(v.reason))).toBe(true);
    expect(withMode((m) => { m.fields[0].verification = "unverified" as never; }).some((v) => /verification/.test(v.reason))).toBe(true);
    const q = structuredClone(base); q.openQuestions = [{ id: "q", question: "?", resolvedBy: "x", blocks: [q.modes[0].key] }];
    expect(sliceViolations(q).some((v) => v.reason === "open question blocks it")).toBe(true);
    const star = structuredClone(base); star.openQuestions = [{ id: "q", question: "?", resolvedBy: "x", blocks: ["*"] }];
    expect(sliceViolations(star).length).toBeGreaterThan(0);
  });
});
