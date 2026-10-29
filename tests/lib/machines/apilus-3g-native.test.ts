import { describe, expect, it } from "vitest";
import { APILUS_3G_PROFILES } from "../../../lib/machines/apilus-3g";
import { catalogueIntegrity, MACHINE_CATALOGUE, profileAtVersion, openEvidenceChecklist } from "../../../lib/machines/catalogue";
import { modeFields, type MachineProfile } from "../../../lib/machines/profile-contract";
import { nativeFieldGroups } from "../../../lib/machines/charting";
import { planContractPublication } from "../../../lib/machines/contract-publication";
import { validateReading } from "../../../lib/machines/validate-reading";
import { assembleGroupSubmissions, draftKey, firstGroup, groupReadiness, groupsFromRecorded } from "../../../lib/machines/setting-groups";

const [senior, junior] = APILUS_3G_PROFILES;
const sig = (p: MachineProfile, key: string) => modeFields(p.modes.find((m) => m.key === key)!).map(({ field: f, stageKey }) => [stageKey, f.key, f.unit, f.decimals, f.editable]);
const hf = (d: number, stage: string | null = null) => [[stage, "hf_pulse_time", "s", d, true], [stage, "hf_intensity", "%", 0, true], [stage, "pulse_count", "count", 0, true]];
const glv = () => [[null, "galvanic_time", "s", 0, true], [null, "galvanic_current", "mA", 2, true]];

describe("separate manufacturer-documented 3G v2 native contracts", () => {
  it("retains the historical v1 contracts, units and source status", () => {
    const old = profileAtVersion(senior.profileId, 1)!;
    expect(old.version).toBe(1);
    expect(old.modes.map((m) => m.key)).toEqual(["multiplex"]);
    const snap = modeFields(old.modes[0]).find(({ field }) => field.key === "snap_duration")!.field;
    expect(snap).toMatchObject({ unit: "ms", decimals: 0, verification: "pending-evidence" });
    expect(profileAtVersion(junior.profileId, 1)!.modes).toEqual([]);
    expect(catalogueIntegrity()).toEqual([]);
  });
  it("documents 13.56 MHz for each model without treating decimal formatting as a conflict", () => {
    for (const p of APILUS_3G_PROFILES) {
      expect(p.version).toBe(2);
      expect(p.frequency).toMatchObject({ kind: "fixed", mhz: 13.56, verification: "manufacturer-documented" });
      expect(p.availability).toBe("blocked"); // explicit activation hold
      expect(p.openQuestions.flatMap((q) => q.blocks)).not.toContain("@frequency");
      expect(p.evidence.every((e) => e.locator?.includes("SHA256"))).toBe(true);
    }
    expect(openEvidenceChecklist().filter((q) => q.profileId === senior.profileId).flatMap((q) => q.question.blocks)).not.toContain("@frequency");
  });
  it("matches Senior Flash, MicroFlash, warming and fast-pulse seconds independently", () => {
    expect(sig(senior, "flash")).toEqual(hf(2));
    expect(sig(senior, "microflash")).toEqual(hf(3));
    expect(sig(senior, "multiplex")).toEqual([
      ["slow_thermolysis", "warming_time", "s", 1, true],
      ["slow_thermolysis", "warming_intensity", "%", 0, true], ...hf(3, "snap"),
    ]);
    expect(sig(senior, "multiplex").some((f) => f[2] === "mA")).toBe(false);
  });
  it("keeps Senior Blend, OmniBlend, MultiBlend final pulse and Electrolysis distinct", () => {
    expect(sig(senior, "blend")).toEqual([...hf(2), ...glv()]);
    expect(sig(senior, "omniblend")).toEqual([...glv(), [null, "max_hf", "%", 0, true]]);
    expect(sig(senior, "multiblend")).toEqual([...glv(), [null, "max_hf", "%", 0, true], ["final_component", "final_pulse_time", "s", 3, true], ["final_component", "final_pulse_intensity", "%", 0, true]]);
    expect(sig(senior, "electrolysis")).toEqual(glv());
  });
  it("implements Junior's own five modes without sibling modes", () => {
    expect(junior.modes.map((m) => m.key)).toEqual(["thermolysis", "flash", "blend", "omniblend", "electrolysis"]);
    expect(sig(junior, "thermolysis")).toEqual(hf(1));
    expect(sig(junior, "flash")).toEqual(hf(2));
    expect(sig(junior, "blend")).toEqual([...hf(2), ...glv()]);
    expect(sig(junior, "omniblend")).toEqual([...glv(), [null, "max_hf", "%", 0, true]]);
    expect(sig(junior, "electrolysis")).toEqual(glv());
  });
  it("isolates the Junior time precision, order and current-bound conflicts", () => {
    expect(junior.modes[0].fields[0].unverified).toEqual(["decimals"]);
    expect(junior.modes.find((m) => m.key === "omniblend")!.captureHold).toContain("p20");
    expect(junior.modes.find((m) => m.key === "electrolysis")!.fields[1].note).toContain("1.99");
    for (const p of APILUS_3G_PROFILES) for (const m of p.modes) {
      expect(modeFields(m).flatMap(({ field }) => field.ranges ?? []).filter((r) => r.class === "hardware-enforced")).toEqual([]);
    }
  });
  it("the activation hold and incomplete categorical capture cannot be bypassed by publication", () => {
    expect(planContractPublication().publish).toEqual([]);
    for (const p of APILUS_3G_PROFILES) {
      // In-memory candidates test readiness only; they do not activate the catalogue.
      const candidate = structuredClone(p); candidate.availability = "active";
      for (const m of candidate.modes) {
        if (!m.captureHold && !modeFields(m).some(({ field }) => field.unverified?.length)) m.availability = "active";
      }
      expect(catalogueIntegrity([candidate])).toEqual([]);
      expect(planContractPublication([candidate]).publish.map((m) => m.p_mode_key)).toEqual(p === senior ? ["flash", "microflash", "multiplex", "electrolysis"] : ["flash", "electrolysis"]);
      const held = candidate.modes.find((m) => m.captureHold)!; held.availability = "active";
      expect(catalogueIntegrity([candidate]).some((v) => v.problem.includes("cannot capture"))).toBe(true);
      expect(planContractPublication([candidate]).publish.some((m) => m.p_mode_key === held.key)).toBe(false);
      const field = modeFields(held)[0];
      expect(validateReading({ profileId: candidate.profileId, version: 2, modeKey: held.key, stageKey: field.stageKey, fieldKey: field.field.key, source: field.field.expectedSource, value: { kind: "value", value: 0 } }, { catalogue: [candidate] })).toMatchObject({ ok: false, code: "mode_not_offered" });
    }
  });
});

// Pure form/payload checks. These are NOT a DB save, browser reload or physical-unit proof.
describe.each(APILUS_3G_PROFILES)("$model form payload", (profile) => {
  it.each(profile.modes)("preserves $key native numbers/stages/provenance through JSON", (mode) => {
    const fields = nativeFieldGroups(profile, mode);
    const groups = firstGroup();
    for (const fg of fields) for (const f of fg.fields) groups[0].values[draftKey(fg.key, f)] = f.decimals === 3 ? "0.047" : f.decimals === 2 ? "0.27" : f.decimals === 1 ? "1.3" : "7";
    expect(groupReadiness(fields, groups[0])).toBe("complete");
    const assembled = assembleGroupSubmissions(fields, groups);
    const reloaded = JSON.parse(JSON.stringify(assembled));
    expect(reloaded).toEqual(assembled);
    expect(reloaded[0].readings).toHaveLength(modeFields(mode).length);
    for (const r of assembled[0].readings) {
      expect(validateReading({ profileId: profile.profileId, version: 2, modeKey: mode.key, stageKey: r.stageKey, fieldKey: r.fieldKey, source: r.observationSource, value: r.value }, { allowNonOffered: true })).toMatchObject({ ok: true, recorded: r.value });
    }
    const remount = groupsFromRecorded([], { deviceId: "other-unit", profileId: profile.profileId, profileVersion: 2, modeKey: mode.key });
    expect(remount.every((g) => Object.keys(g.values).length === 0)).toBe(true);
    expect(MACHINE_CATALOGUE.find((p) => p.profileId === profile.profileId && p.version === 2)).toBe(profile);
  });
});
