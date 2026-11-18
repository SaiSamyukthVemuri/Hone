import { describe, expect, it } from "vitest";
import { MACHINE_CATALOGUE } from "../../../lib/machines/catalogue";
import { planContractPublication } from "../../../lib/machines/contract-publication";
import { modeFields, type MachineProfile } from "../../../lib/machines/profile-contract";
import { sliceViolations } from "../../../lib/machines/slice-gate";

// The slice gate checks the profile's FREQUENCY directly. Before this, an unverified frequency was refused only through an open question
// naming '@frequency': deleting or resolving that question while the frequency stayed unverified would have passed the gate.
const pur = MACHINE_CATALOGUE.find((p) => p.profileId === "dectro-apilus:xcell-pur")!;

/** Everything evidenced EXCEPT the frequency, and with every open question resolved. */
function allButFrequency(): MachineProfile {
  const p = structuredClone(pur);
  p.openQuestions = [];
  p.modes[0]!.verification = "manufacturer-documented";
  for (const { field } of modeFields(p.modes[0]!)) { field.verification = "manufacturer-documented"; delete field.unverified; }
  return p;
}

describe("the slice gate refuses an unverified frequency directly", () => {
  it("resolved questions are not enough: an unverified frequency alone refuses the mode", () => {
    const p = allButFrequency();
    expect(p.frequency.kind).toBe("unverified");
    expect(sliceViolations(p).map((v) => v.reason)).toEqual(["frequency is unverified"]);
  });

  it("a fixed or selectable frequency whose own verification is unverified or pending is refused", () => {
    for (const verification of ["unverified", "pending-evidence"] as const) {
      const fixed = allButFrequency(); fixed.frequency = { kind: "fixed", mhz: 27.12, verification, evidence: [fixed.evidence[0]!.id] };
      const selectable = allButFrequency(); selectable.frequency = { kind: "selectable", mhz: [13.56, 27.12], verification, evidence: [selectable.evidence[0]!.id] };
      for (const p of [fixed, selectable]) expect(sliceViolations(p).map((v) => v.reason), `${p.frequency.kind} ${verification}`).toEqual([`frequency verification is ${verification}`]);
    }
  });

  it("a documented frequency passes, so evidence is what enables it", () => {
    const p = allButFrequency();
    p.frequency = { kind: "fixed", mhz: 27.12, verification: "manufacturer-documented", evidence: [p.evidence[0]!.id] };
    expect(sliceViolations(p)).toEqual([]);
  });

  it("the real xCell Pur entry is refused for the frequency as well as for its other evidence", () => {
    expect(sliceViolations(pur).map((v) => v.reason)).toContain("frequency is unverified");
  });
});

describe("tightening the gate changes nothing that is offered or published today", () => {
  it("every ACTIVE mode of every catalogue profile still passes the gate cleanly", () => {
    for (const p of MACHINE_CATALOGUE) {
      const active = new Set(p.modes.filter((m) => m.availability === "active").map((m) => m.key));
      const refused = sliceViolations(p).filter((v) => active.has(v.modeKey));
      expect(refused, `${p.profileId}@${p.version}`).toEqual([]);
    }
  });

  it("the Senior and Junior 3G v3 first-slice modes are still active", () => {
    const active = (id: string) => MACHINE_CATALOGUE.find((p) => p.profileId === id && p.version === 3)!.modes.filter((m) => m.availability === "active").map((m) => m.key);
    expect(active("dectro-apilus:senior-3g")).toEqual(["flash", "microflash", "multiplex", "blend", "omniblend", "multiblend", "electrolysis"]);
    expect(active("dectro-apilus:junior-3g")).toEqual(["flash", "blend", "electrolysis"]);
  });

  it("the plan publishes exactly the rows it did before (pinned in xcell-unchanged-guard)", () => {
    const rows = planContractPublication().publish.filter((r) => r.p_machine_profile_id !== "dectro-apilus:xcell-pur");
    expect(rows.length).toBe(10);
  });
});
