import { describe, expect, it } from "vitest";
import { APILUS_3G_PROFILES, APILUS_3G_TEXT_PROFILES, FIRST_SLICE_ACTIVE_MODES, applyFirstSlice } from "../../../lib/machines/apilus-3g";
import { MACHINE_CATALOGUE } from "../../../lib/machines/catalogue";
import { planContractPublication } from "../../../lib/machines/contract-publication";
import { modeFields } from "../../../lib/machines/profile-contract";
import { validateReading } from "../../../lib/machines/validate-reading";
import { listableProfiles } from "../../../lib/machines/listable-profiles";
import { activeProfiles } from "../../../lib/machines/profile-contract";
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

  describe("the allowlist can never override a hold (intersected with the slice gate)", () => {
    const fresh = () => structuredClone(APILUS_3G_PROFILES.find((p) => p.profileId === "dectro-apilus:senior-3g")!);
    const allKeys = ["flash", "microflash", "multiplex", "electrolysis"];
    const activeOf = (p: ReturnType<typeof fresh>) => p.modes.filter((m) => m.availability === "active").map((m) => m.key);
    it("control: with no hold every allowed mode activates", () => {
      const p = fresh(); applyFirstSlice(p, allKeys);
      expect(activeOf(p)).toEqual(allKeys);
    });
    it("an open question blocking an allowed mode keeps it blocked", () => {
      const p = fresh();
      p.openQuestions = [{ id: "q", question: "x", blocks: ["flash"] } as never];
      applyFirstSlice(p, allKeys);
      expect(activeOf(p)).not.toContain("flash");
      expect(activeOf(p)).toContain("microflash");
    });
    it("a capture hold keeps an allowed mode blocked", () => {
      const p = fresh(); p.modes.find((m) => m.key === "microflash")!.captureHold = "held";
      applyFirstSlice(p, allKeys);
      expect(activeOf(p)).not.toContain("microflash");
    });
    it("an unverified field aspect keeps an allowed mode blocked", () => {
      const p = fresh();
      modeFields(p.modes.find((m) => m.key === "multiplex")!)[0].field.unverified = ["decimals"];
      applyFirstSlice(p, allKeys);
      expect(activeOf(p)).not.toContain("multiplex");
    });
  });

  describe("the real reversal: a catalogue release that blocks the modes (published rows are immutable and stay)", () => {
    const reading = (p: { profileId: string; version: number }, modeKey: string) => ({
      profileId: p.profileId, version: p.version, modeKey, fieldKey: "program_identifier",
      source: "practitioner-entered" as const, value: { kind: "text" as const, value: "003i" },
    });
    const blockedCopy = (p: typeof senior) => { const c = structuredClone(p); c.availability = "blocked"; for (const m of c.modes) m.availability = "blocked"; return c; };
    it("control: while active, a new reading is accepted", () => {
      expect(validateReading(reading(senior, "flash"), { catalogue: [senior] }).ok).toBe(true);
    });
    it("after the release: nothing is offered, nothing is listed, and a NEW reading is refused", () => {
      const reverted = blockedCopy(senior);
      expect(activeProfiles([reverted])).toEqual([]);
      expect(listableProfiles(activeProfiles([reverted]), () => ["flash"])).toEqual([]);
      expect(validateReading(reading(senior, "flash"), { catalogue: [reverted] }).ok).toBe(false);
    });
    it("publishing a blocked catalogue publishes nothing (it is NOT a reversal); the release is", () => {
      expect(planContractPublication([blockedCopy(senior)]).publish).toEqual([]);
    });
  });
});
