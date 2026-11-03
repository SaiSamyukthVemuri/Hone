import { describe, expect, it } from "vitest";
import { APILUS_3G_TEXT_PROFILES, FIRST_SLICE_ACTIVE_MODES } from "../../../lib/machines/apilus-3g";
import { MACHINE_CATALOGUE } from "../../../lib/machines/catalogue";
import { planContractPublication } from "../../../lib/machines/contract-publication";
import { sliceViolations } from "../../../lib/machines/slice-gate";

describe("HON-8 first-slice activation candidate (software profile only)", () => {
  const junior = APILUS_3G_TEXT_PROFILES.find((p) => p.profileId === "dectro-apilus:junior-3g")!;
  const senior = APILUS_3G_TEXT_PROFILES.find((p) => p.profileId === "dectro-apilus:senior-3g")!;

  it("offers exactly the named modes and nothing else", () => {
    for (const p of [junior, senior]) {
      const active = p.modes.filter((m) => m.availability === "active").map((m) => m.key);
      expect(active).toEqual(p.modes.map((m) => m.key).filter((k) => FIRST_SLICE_ACTIVE_MODES[p.profileId].includes(k)));
    }
  });
  it("keeps Junior Thermolysis and Junior OmniBlend blocked", () => {
    for (const k of ["thermolysis", "omniblend"]) expect(junior.modes.find((m) => m.key === k)!.availability).not.toBe("active");
  });
  it("never prefills a value or enforces a range", () => {
    for (const p of [junior, senior]) for (const m of p.modes) for (const s of m.stages) for (const f of s.fields) {
      expect((f as { default?: unknown }).default).toBeUndefined();
      expect(f.ranges ?? []).toEqual([]);
    }
  });
  it("publishes only active, fully verified modes, and only v3", () => {
    const plan = planContractPublication();
    expect(plan.publish.every((m) => m.p_machine_profile_version === 3)).toBe(true);
    expect(plan.publish).toHaveLength(10);
  });
  it("leaves older versions of both models blocked", () => {
    for (const p of MACHINE_CATALOGUE.filter((x) => x.profileId.includes("apilus-3g") && x.version < 3)) expect(p.availability).toBe("blocked");
  });
  it("passes the slice gate for every ACTIVE mode; only the blocked modes violate it", () => {
    for (const p of [junior, senior]) {
      const active = new Set(p.modes.filter((m) => m.availability === "active").map((m) => m.key));
      expect(sliceViolations(p).filter((v) => active.has(v.modeKey))).toEqual([]);
    }
    expect([...new Set(sliceViolations(junior).map((v) => v.modeKey))].sort()).toEqual(["omniblend", "thermolysis"]);
  });
});
