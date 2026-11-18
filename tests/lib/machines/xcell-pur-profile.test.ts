import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MACHINE_CATALOGUE } from "../../../lib/machines/catalogue";
import { priorSetupView } from "../../../lib/machines/charting";
import { planContractPublication } from "../../../lib/machines/contract-publication";
import { legacyMachineOffer } from "../../../lib/machines/legacy-machine";
import { activeModes, modeFields, type MachineProfile, type ObservationSource } from "../../../lib/machines/profile-contract";
import { ROUTINE_REQUIRED_INPUT_BUDGET, routineRequiredInputs, sliceViolations } from "../../../lib/machines/slice-gate";
import { validateReading } from "../../../lib/machines/validate-reading";
import { XCELL_PUR_PROFILE_ID } from "../../../lib/machines/xcell-pur";

// HON-71 (linked to HON-8): the xCell Pur MultiPlex contract lands BLOCKED. These tests pin what it records, that values keep every digit
// the screen shows, that nothing calculates EL, that a blank UL is an absence and never 0, and that the publication plan is unchanged by it.

const pur = MACHINE_CATALOGUE.find((p) => p.profileId === XCELL_PUR_PROFILE_ID)!;
const multiplex = pur.modes[0]!;
const sha = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");

/** The profile and its mode switched on, in a throwaway copy only: the real entry is never mutated. */
function activeCopy(): MachineProfile {
  const copy = structuredClone(pur);
  copy.availability = "active";
  for (const m of copy.modes) m.availability = "active";
  return copy;
}

describe("xCell Pur: what the contract records", () => {
  it("is one blocked profile, version 1, with one blocked MultiPlex mode and an unverified frequency", () => {
    expect(pur).toBeDefined();
    expect([pur.family, pur.manufacturer, pur.model, pur.version, pur.availability]).toEqual(["Dectro/Apilus", "Dectro", "xCell Pur", 1, "blocked"]);
    expect(pur.frequency.kind).toBe("unverified");
    expect(pur.modes.map((m) => [m.key, m.nativeLabel, m.availability])).toEqual([["multiplex", "MultiPlex", "blocked"]]);
    expect(activeModes(pur)).toEqual([]);
  });

  it("carries the fields exactly as proposed, slow thermolysis first and flash second, mode-level readings first", () => {
    expect(
      modeFields(multiplex).map(({ field: f, stageKey }) => [stageKey, f.key, f.quantity, f.unit, f.decimals, f.optional]),
    ).toEqual([
      [null, "displayed_el", "energy-display", "device-display", 0, true],
      [null, "displayed_ul", "energy-display", "device-display", 0, true],
      ["slow_thermolysis", "slow_thermolysis_duration", "duration", "s", 2, false],
      ["slow_thermolysis", "slow_thermolysis_intensity", "intensity", "%", 0, false],
      ["snap", "snap_duration", "duration", "s", 3, false],
      ["snap", "snap_intensity", "intensity", "%", 0, false],
      ["snap", "snap_count", "count", "count", 0, false],
      ["snap", "snap_interval", "duration", "s", 2, true],
    ]);
    expect(multiplex.stages.map((s) => [s.key, s.nativeLabel])).toEqual([
      ["slow_thermolysis", "Slow thermolysis"],
      ["snap", "Flash thermolysis"],
    ]);
  });

  it("enforces no range anywhere, and every field cites evidence the profile carries", () => {
    const ids = new Set(pur.evidence.map((e) => e.id));
    for (const { field } of modeFields(multiplex)) {
      expect(field.ranges ?? [], field.key).toEqual([]);
      expect(field.evidence.length, field.key).toBeGreaterThan(0);
      for (const id of field.evidence) expect(ids.has(id), `${field.key} cites ${id}`).toBe(true);
    }
  });

  it("stays inside the routine-capture budget: only the five stage readings are required", () => {
    expect(routineRequiredInputs(multiplex)).toBe(5);
    expect(routineRequiredInputs(multiplex)).toBeLessThanOrEqual(ROUTINE_REQUIRED_INPUT_BUDGET);
  });

  it("is refused by the slice gate while blocked, so it cannot be offered by accident", () => {
    expect(sliceViolations(pur).length).toBeGreaterThan(0);
  });
});

describe("xCell Pur: exact values, never rounded", () => {
  const input = (stageKey: string | null, fieldKey: string, value: number, source: ObservationSource = "practitioner-entered") => ({
    profileId: XCELL_PUR_PROFILE_ID, version: 1, modeKey: "multiplex", stageKey, fieldKey,
    value: { kind: "value" as const, value }, source,
  });
  const catalogue = [activeCopy()];

  it.each([
    ["slow thermolysis duration", "slow_thermolysis", "slow_thermolysis_duration", 1.82],
    ["slow thermolysis intensity", "slow_thermolysis", "slow_thermolysis_intensity", 11],
    ["flash thermolysis duration", "snap", "snap_duration", 0.043],
    ["flash thermolysis intensity", "snap", "snap_intensity", 76],
    ["flash pulse count", "snap", "snap_count", 2],
    ["interval between flash pulses", "snap", "snap_interval", 0.5],
  ])("records the screen's %s exactly", (_name, stage, key, value) => {
    const outcome = validateReading(input(stage, key, value), { catalogue });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.recorded).toEqual({ kind: "value", value });
    if (outcome.ok && outcome.recorded.kind === "value") expect(Object.is(outcome.recorded.value, value)).toBe(true);
  });

  it("records the displayed EL exactly, as shown", () => {
    const outcome = validateReading(input(null, "displayed_el", 717, "machine-displayed"), { catalogue });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.recorded).toEqual({ kind: "value", value: 717 });
  });

  it.each([
    ["slow thermolysis duration, a third decimal", "slow_thermolysis", "slow_thermolysis_duration", 1.825],
    ["flash thermolysis duration, a fourth decimal", "snap", "snap_duration", 0.0431],
    ["interval, a third decimal", "snap", "snap_interval", 0.505],
    ["an intensity with a decimal", "snap", "snap_intensity", 76.5],
    ["a fractional pulse count", "snap", "snap_count", 2.5],
  ])("refuses %s instead of rounding it", (_name, stage, key, value) => {
    const outcome = validateReading(input(stage, key, value), { catalogue });
    expect(outcome.ok).toBe(false);
  });

  it("names the precision reason when a value has more digits than the screen shows", () => {
    const outcome = validateReading(input("slow_thermolysis", "slow_thermolysis_duration", 1.825), { catalogue });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe("precision_beyond_contract");
  });

  it("is also valid as a retained historical contract, which is how a blocked profile's rows are still read", () => {
    const outcome = validateReading(input("snap", "snap_duration", 0.043), { allowNonOffered: true });
    expect(outcome.ok).toBe(true);
  });

  it("shows 1.82, 0.043 and 0.50 with every digit, padded to the contract and never altered, and 717 as shown", () => {
    const view = priorSetupView({
      profileId: XCELL_PUR_PROFILE_ID, profileVersion: 1, modeKey: "multiplex", recordedAt: "2026-11-16T13:29:00Z", sessionId: "s",
      groups: [{ groupId: "g1", channels: [], readings: {
        slow_thermolysis_duration: { kind: "value", value: 1.82 }, slow_thermolysis_intensity: { kind: "value", value: 11 },
        snap_duration: { kind: "value", value: 0.043 }, snap_intensity: { kind: "value", value: 76 },
        snap_count: { kind: "value", value: 2 }, snap_interval: { kind: "value", value: 0.5 },
        displayed_el: { kind: "value", value: 717 },
      } }],
    });
    if ("unavailable" in view) throw new Error(view.unavailable);
    const shown = Object.fromEntries(view.groups[0]!.rows.map((r) => [r.key, `${r.display}${r.unit ? ` ${r.unit}` : ""}`.trim()]));
    expect(shown.slow_thermolysis_duration).toMatch(/^1\.82\b/);
    expect(shown.snap_duration).toMatch(/^0\.043\b/);
    expect(shown.snap_interval).toMatch(/^0\.50\b/);
    expect(shown.displayed_el).toMatch(/^717\b/);
    expect(view.groups[0]!.rows.map((r) => r.label)).toEqual([
      "Duration", "Intensity", "Duration", "Intensity", "Pulse count", "Interval between flash pulses", "EL",
    ]);
  });
});

describe("xCell Pur: EL is displayed, never calculated; a blank UL is an absence, never 0", () => {
  it("declares EL as read off the machine's display, optional, and with no derivation of any kind on any field", () => {
    const el = modeFields(multiplex).find(({ field }) => field.key === "displayed_el")!.field;
    expect([el.expectedSource, el.optional, el.valueKind ?? "number"]).toEqual(["machine-displayed", true, "number"]);
    // A field may only carry the keys the contract type defines. A formula, a derivedFrom or a default would be a new key and fails here.
    const allowed = new Set(["key", "nativeLabel", "quantity", "unit", "decimals", "optional", "expectedSource", "editable", "verification", "unverified", "evidence", "note"]);
    for (const { field } of modeFields(multiplex)) {
      for (const k of Object.keys(field)) expect(allowed.has(k), `${field.key} has unexpected key '${k}'`).toBe(true);
    }
  });

  it("has no arithmetic over the readings anywhere in the profile's source", () => {
    const source = readFileSync(new URL("../../../lib/machines/xcell-pur.ts", import.meta.url), "utf8")
      .split("\n").filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join("\n");
    expect(source).not.toMatch(/Math\.|\*\*|\bpow\b|\* *(?:intensity|duration|count)|(?:intensity|duration|count) *\*/i);
  });

  it("accepts any EL on its own: nothing checks it against the other readings", () => {
    const catalogue = [activeCopy()];
    for (const value of [0, 1, 717, 9999]) {
      const outcome = validateReading(
        { profileId: XCELL_PUR_PROFILE_ID, version: 1, modeKey: "multiplex", stageKey: null, fieldKey: "displayed_el", value: { kind: "value", value }, source: "machine-displayed" },
        { catalogue },
      );
      expect(outcome.ok, `EL ${value}`).toBe(true);
    }
  });

  it("makes UL optional with no default, and a blank UL is a missing reading, not a stored 0", () => {
    const ul = modeFields(multiplex).find(({ field }) => field.key === "displayed_ul")!.field;
    expect(ul.optional).toBe(true);
    expect("default" in ul).toBe(false);
    const view = priorSetupView({
      profileId: XCELL_PUR_PROFILE_ID, profileVersion: 1, modeKey: "multiplex", recordedAt: "2026-11-16T13:29:00Z", sessionId: "s",
      groups: [{ groupId: "g1", channels: [], readings: { slow_thermolysis_duration: { kind: "value", value: 1.82 } } }],
    });
    if ("unavailable" in view) throw new Error(view.unavailable);
    expect(view.groups[0]!.rows.map((r) => r.key)).toEqual(["slow_thermolysis_duration"]);
  });
});

describe("xCell Pur: the publication plan and the existing workflow are unchanged", () => {
  it("does NOT publish the profile while it is blocked, and says why", () => {
    const plan = planContractPublication();
    expect(plan.publish.some((r) => r.p_machine_profile_id === XCELL_PUR_PROFILE_ID)).toBe(false);
    const skipped = plan.skipped.filter((s) => s.profileId === XCELL_PUR_PROFILE_ID);
    expect(skipped.map((s) => s.mode)).toEqual(["multiplex"]);
    const reasons = skipped[0]!.reasons.join(" | ");
    expect(reasons).toMatch(/profile is blocked/);
    expect(reasons).toMatch(/mode is blocked/);
    expect(reasons).toMatch(/frequency is unverified/);
    expect(reasons).toMatch(/held by an open question/);
  });

  it("leaves the publication plan byte-identical to the plan without the profile", () => {
    const without = planContractPublication(MACHINE_CATALOGUE.filter((p) => p.profileId !== XCELL_PUR_PROFILE_ID));
    expect(sha(planContractPublication().publish)).toBe(sha(without.publish));
    expect(planContractPublication().publish).toEqual(without.publish);
  });

  it("cannot be published by switching availability alone: the evidence and the frequency still refuse it", () => {
    const others = MACHINE_CATALOGUE.filter((p) => p.profileId !== XCELL_PUR_PROFILE_ID);
    const plan = planContractPublication([...others, activeCopy()]);
    expect(plan.publish.some((r) => r.p_machine_profile_id === XCELL_PUR_PROFILE_ID)).toBe(false);
    expect(plan.skipped.find((s) => s.profileId === XCELL_PUR_PROFILE_ID)!.reasons.join(" | ")).toMatch(/frequency is unverified|lacks complete evidence/);
  });

  it("leaves the existing xCell workflow's selector offer exactly as it was", () => {
    expect(legacyMachineOffer(MACHINE_CATALOGUE)).toEqual({ profileId: "dectro-apilus:xcell", label: "Dectro xCell" });
  });

  it("is a different profile from Senior and Junior 3G, whose published contracts it does not touch", () => {
    expect(pur.profileId).not.toMatch(/senior|junior/);
    for (const p of MACHINE_CATALOGUE.filter((p) => /apilus:(senior|junior)-3g/.test(p.profileId))) {
      expect(p.evidence.some((e) => pur.evidence.some((x) => x.id === e.id)), p.profileId).toBe(false);
    }
  });
});
