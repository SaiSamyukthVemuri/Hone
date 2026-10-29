import { describe, expect, it } from "vitest";

import { MACHINE_CATALOGUE } from "@/lib/machines/catalogue";
import { suggestMachineFromPriorSetup } from "@/lib/machines/prior-setup-suggestion";
import type { StudioDevice } from "@/lib/machines/selection";

// HON-8 next-visit continuity, machine-first: with nothing remembered for the
// practitioner, the client's last recorded setup may OFFER the unit it was
// recorded on. It never selects, and it never guesses between units.
//
// Current schema only: the input is the `deviceId` that every recorded reading
// already carries, so no migration is involved.

const scope = { studioId: "studio-1", practitionerId: "pract-1" };
const profile = MACHINE_CATALOGUE.find((p) => p.availability === "active");

function device(over: Partial<StudioDevice> = {}): StudioDevice {
  return {
    deviceId: "dev-a",
    studioId: "studio-1",
    profileId: profile?.id ?? "synthetic",
    profileVersion: profile?.version ?? 1,
    displayName: "Room 1 unit",
    installedOptions: [],
    retiredAt: null,
    ...over,
  };
}

describe("suggestMachineFromPriorSetup", () => {
  it("is a pure offer: the result names the unit and never selects it", () => {
    const out = suggestMachineFromPriorSetup({
      scope,
      remembered: "none",
      priorDeviceIds: ["dev-a", "dev-a"],
      devices: [device()],
    });
    expect(out).toEqual({ deviceId: "dev-a", displayName: "Room 1 unit" });
  });

  it("offers nothing when the practitioner already has a remembered machine", () => {
    for (const remembered of ["selected", "unavailable", "not-verified"] as const) {
      expect(
        suggestMachineFromPriorSetup({
          scope,
          remembered,
          priorDeviceIds: ["dev-a"],
          devices: [device()],
        }),
      ).toBeNull();
    }
  });

  it("offers nothing when the prior capture spans more than one unit (no guessing)", () => {
    expect(
      suggestMachineFromPriorSetup({
        scope,
        remembered: "none",
        priorDeviceIds: ["dev-a", "dev-b"],
        devices: [device(), device({ deviceId: "dev-b", displayName: "Room 2 unit" })],
      }),
    ).toBeNull();
  });

  it("offers nothing for a retired unit, or one not in this studio", () => {
    expect(
      suggestMachineFromPriorSetup({
        scope,
        remembered: "none",
        priorDeviceIds: ["dev-a"],
        devices: [device({ retiredAt: "2026-10-01T00:00:00Z" })],
      }),
    ).toBeNull();
    expect(
      suggestMachineFromPriorSetup({
        scope,
        remembered: "none",
        priorDeviceIds: ["dev-a"],
        devices: [device({ studioId: "studio-2" })],
      }),
    ).toBeNull();
  });

  it("offers nothing when there is no prior setup or the unit is unknown", () => {
    expect(
      suggestMachineFromPriorSetup({ scope, remembered: "none", priorDeviceIds: [], devices: [device()] }),
    ).toBeNull();
    expect(
      suggestMachineFromPriorSetup({ scope, remembered: "none", priorDeviceIds: ["dev-zzz"], devices: [device()] }),
    ).toBeNull();
  });
});
