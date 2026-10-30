import type { MachineProfile } from "../../lib/machines/profile-contract";

/** Fabricated verification evidence; makes no claim about any real model. */
export function publicationFixture(profileId = "synthetic:publication-proof"): MachineProfile {
  return {
    profileId, version: 1, family: "Synthetic/Demo", manufacturer: "Synthetic",
    model: "Publication proof", availability: "active", verification: "device-confirmed",
    frequency: { kind: "not-applicable" }, openQuestions: [],
    evidence: [{ id: "fixture", kind: "studio-device-photo", consultedOn: "2026-10-19", establishes: "Fabricated fixture only; no real hardware claims." }],
    modes: [{
      key: "galvanic", nativeLabel: "Synthetic mode", family: "galvanic",
      availability: "active", verification: "device-confirmed", evidence: ["fixture"], stages: [],
      fields: [{
        key: "current", nativeLabel: "Synthetic current", quantity: "current", unit: "µA",
        decimals: 1, optional: false, expectedSource: "practitioner-entered", editable: true,
        verification: "device-confirmed", evidence: ["fixture"],
      }],
    }],
  };
}
