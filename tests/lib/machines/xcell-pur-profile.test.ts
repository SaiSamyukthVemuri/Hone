import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MACHINE_CATALOGUE, catalogueIntegrity } from "../../../lib/machines/catalogue";
import { priorSetupView } from "../../../lib/machines/charting";
import { planContractPublication } from "../../../lib/machines/contract-publication";
import { legacyMachineOffer } from "../../../lib/machines/legacy-machine";
import { activeModes, modeFields, type MachineProfile, type ObservationSource } from "../../../lib/machines/profile-contract";
import { ROUTINE_REQUIRED_INPUT_BUDGET, routineRequiredInputs, sliceViolations } from "../../../lib/machines/slice-gate";
import { validateReading } from "../../../lib/machines/validate-reading";
import { applyFirstSlice } from "../../../lib/machines/apilus-3g";
import { XCELL_PUR_ACTIVE_MODES, XCELL_PUR_PROFILE_ID, XCELL_PUR_RECORDED_LIMITS, applyXcellPurSlice } from "../../../lib/machines/xcell-pur";

// HON-71 (linked to HON-8): the xCell Pur MultiPlex contract, enabled on device-observed evidence. These tests pin what it records, that values keep every digit
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
  it("is one profile, version 1, active with its one MultiPlex mode, with a fixed 27.12 MHz taken from Dectro's chart", () => {
    expect(pur).toBeDefined();
    expect([pur.family, pur.manufacturer, pur.model, pur.version, pur.availability]).toEqual(["Dectro/Apilus", "Dectro", "xCell Pur", 1, "active"]);
    expect(pur.frequency).toEqual({
      kind: "fixed", mhz: 27.12, verification: "manufacturer-documented",
      evidence: ["xcell-pur-dectro-cross-reference-chart-en26", "xcell-pur-dectro-product-page"],
    });
    expect(pur.modes.map((m) => [m.key, m.nativeLabel, m.availability])).toEqual([["multiplex", "MultiPlex", "active"]]);
    expect(activeModes(pur).map((m) => m.key)).toEqual(["multiplex"]);
  });

  it("records the evidence as device-observed, never as the manual, and states its limits in the chart's own entry", () => {
    for (const { field } of modeFields(multiplex)) expect(field.verification, field.key).toBe("device-confirmed");
    expect(pur.evidence.some((e) => e.kind === "manufacturer-manual")).toBe(false);
    const chart = pur.evidence.find((e) => e.id === "xcell-pur-dectro-cross-reference-chart-en26")!;
    expect(chart.kind).toBe("manufacturer-comparison-matrix");
    expect(chart.url).toBe("https://www.dectro.com/img/product/description/tableau-comparatif_11x17_en26.pdf");
    expect(chart.doesNotEstablish).toMatch(/not the user manual/);
    expect(chart.doesNotEstablish).toMatch(/slow-thermolysis component/);
    expect(pur.availabilityReason).toMatch(/software version unknown/);
  });

  it("keeps its limits as recorded data and holds nothing: no open question, and the optional evidence is named", () => {
    expect(pur.openQuestions).toEqual([]);
    expect(XCELL_PUR_RECORDED_LIMITS.map((l) => l.id)).toEqual([
      "xcell-pur-software-version", "xcell-pur-multiplex-frequency", "xcell-pur-multiplex-display-precision", "xcell-pur-ul-populated-format",
    ]);
    const freq = XCELL_PUR_RECORDED_LIMITS.find((l) => l.id === "xcell-pur-multiplex-frequency")!;
    expect(freq.question).toMatch(/not the manual/);
    expect(freq.question).not.toMatch(/lists both 13\.56 and 27\.12/);
  });

  it("carries the fields exactly as proposed, slow thermolysis first and flash second, mode-level readings first", () => {
    expect(
      modeFields(multiplex).map(({ field: f, stageKey }) => [stageKey, f.key, f.quantity, f.unit, f.decimals, f.optional]),
    ).toEqual([
      [null, "displayed_el", "energy-display", "device-display", 0, true],
      [null, "displayed_ul", "energy-display", "none", 0, true],
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

  it("passes the slice gate only when the gate is told to accept device-confirmed; the default gate stays strict", () => {
    expect(sliceViolations(pur, { acceptDeviceConfirmed: true })).toEqual([]);
    expect(sliceViolations(pur).length).toBeGreaterThan(0);
    expect(sliceViolations(pur).every((v) => /verification device-confirmed/.test(v.reason))).toBe(true);
  });

  it("a 3G mode whose fields are only device-confirmed is STILL refused, and stays blocked through the 3G slice applier", () => {
    const senior = structuredClone(MACHINE_CATALOGUE.find((p) => p.profileId === "dectro-apilus:senior-3g" && p.version === 3)!);
    const flash = senior.modes.find((m) => m.key === "flash")!;
    flash.availability = "blocked";
    for (const { field } of modeFields(flash)) field.verification = "device-confirmed";
    expect(sliceViolations(senior).some((v) => v.modeKey === "flash")).toBe(true);
    applyFirstSlice(senior, ["flash"]);
    expect(flash.availability).toBe("blocked");
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

  it("records a populated UL as the exact text displayed, refuses an empty one, and a blank stores nothing", () => {
    const ul = (value: { kind: "text"; value: string } | { kind: "absent"; reason: "not-recorded" }) =>
      validateReading({ profileId: XCELL_PUR_PROFILE_ID, version: 1, modeKey: "multiplex", stageKey: null, fieldKey: "displayed_ul", value, source: "machine-displayed" }, { catalogue });
    for (const text of ["43", "43.5", "04", "--"]) {
      const o = ul({ kind: "text", value: text });
      expect(o.ok, text).toBe(true);
      if (o.ok) expect(o.recorded).toEqual({ kind: "text", value: text });
    }
    expect(ul({ kind: "text", value: "   " }).ok).toBe(false);
    const blank = ul({ kind: "absent", reason: "not-recorded" });
    expect(blank.ok).toBe(true);
    if (blank.ok) expect(blank.recorded.kind).toBe("absent");
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
    const allowed = new Set(["key", "nativeLabel", "quantity", "unit", "decimals", "optional", "expectedSource", "editable", "verification", "unverified", "evidence", "note", "valueKind"]);
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
    expect([ul.valueKind, ul.unit, ul.decimals]).toEqual(["text", "none", 0]);
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
  const others = MACHINE_CATALOGUE.filter((p) => p.profileId !== XCELL_PUR_PROFILE_ID);

  it("publishes exactly one row, the MultiPlex mode at version 1, and skips nothing for it", () => {
    const plan = planContractPublication();
    const rows = plan.publish.filter((r) => r.p_machine_profile_id === XCELL_PUR_PROFILE_ID);
    expect(rows.map((r) => `${r.p_machine_profile_id}@${r.p_machine_profile_version}:${r.p_mode_key}`)).toEqual(["dectro-apilus:xcell-pur@1:multiplex"]);
    expect(plan.skipped.filter((s) => s.profileId === XCELL_PUR_PROFILE_ID)).toEqual([]);
  });

  it("adds no row for any other profile and changes none: the rest of the plan is identical to the plan without the profile", () => {
    const without = planContractPublication(others);
    const rest = planContractPublication().publish.filter((r) => r.p_machine_profile_id !== XCELL_PUR_PROFILE_ID);
    expect(sha(rest)).toBe(sha(without.publish));
    expect(rest).toEqual(without.publish);
  });

  it("is refused again if a field falls back to pending evidence", () => {
    const pending = structuredClone(pur);
    modeFields(pending.modes[0]!)[0]!.field.verification = "pending-evidence";
    expect(sliceViolations(pending, { acceptDeviceConfirmed: true }).some((v) => /verification pending-evidence/.test(v.reason))).toBe(true);
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

describe("xCell Pur enablement: the slice gate decides, and the allow-list only names the MultiPlex mode", () => {
  it("the gate is clean for the real entry (device-confirmed accepted for this profile only) and the catalogue integrity holds", () => {
    expect(sliceViolations(pur, { acceptDeviceConfirmed: true })).toEqual([]);
    expect(catalogueIntegrity(MACHINE_CATALOGUE)).toEqual([]);
  });

  it("publishes the exact fields, units, decimals and requiredness the screen showed (UL as text)", () => {
    const rows = planContractPublication().publish.filter((r) => r.p_machine_profile_id === XCELL_PUR_PROFILE_ID);
    expect(rows[0]!.p_fields.map((f) => [f.stage_key, f.field_key, f.native_unit, f.decimals, f.quantity, f.optional])).toEqual([
      ["", "displayed_el", "device-display", 0, "energy-display", true],
      ["", "displayed_ul", "none", 0, "energy-display", true],
      ["slow_thermolysis", "slow_thermolysis_duration", "s", 2, "duration", false],
      ["slow_thermolysis", "slow_thermolysis_intensity", "%", 0, "intensity", false],
      ["snap", "snap_duration", "s", 3, "duration", false],
      ["snap", "snap_intensity", "%", 0, "intensity", false],
      ["snap", "snap_count", "count", 0, "count", false],
      ["snap", "snap_interval", "s", 2, "duration", true],
    ]);
  });

  it("the allow-list names only the MultiPlex mode, and applying it again changes nothing", () => {
    expect(XCELL_PUR_ACTIVE_MODES).toEqual(["multiplex"]);
    const copy = structuredClone(pur);
    applyXcellPurSlice(copy, XCELL_PUR_ACTIVE_MODES);
    expect(copy.modes[0]!.availability).toBe("active");
  });
});
