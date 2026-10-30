import { describe, expect, it } from "vitest";

import { SYNTHETIC_DEMO_PROFILE } from "@/lib/machines/synthetic-profile";
import { suggestMachineFromPriorSetup } from "@/lib/machines/prior-setup-suggestion";
import type { StudioDevice } from "@/lib/machines/selection";

// HON-8 next-visit continuity, machine-first: with nothing remembered for the
// practitioner, the client's last recorded setup may OFFER the unit it was
// recorded on. It never selects, and it never guesses between units.
//
// Current schema only: the input is the `deviceId` that every recorded reading
// already carries, so no migration is involved.

const scope = { studioId: "studio-1", practitionerId: "pract-1" };
// The shipped catalogue has no active profile yet, so the usability rule is
// exercised through an injected one (the synthetic demo profile).
const profile = SYNTHETIC_DEMO_PROFILE;
const catalogue = [profile];

function device(over: Partial<StudioDevice> = {}): StudioDevice {
  return {
    deviceId: "dev-a",
    studioId: "studio-1",
    profileId: profile.profileId,
    profileVersion: profile.version,
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
      catalogue,
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
          catalogue,
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
        catalogue,
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
        catalogue,
      }),
    ).toBeNull();
    expect(
      suggestMachineFromPriorSetup({
        scope,
        remembered: "none",
        priorDeviceIds: ["dev-a"],
        devices: [device({ studioId: "studio-2" })],
        catalogue,
      }),
    ).toBeNull();
  });

  it("offers nothing when there is no prior setup or the unit is unknown", () => {
    expect(
      suggestMachineFromPriorSetup({ scope, remembered: "none", priorDeviceIds: [], devices: [device()], catalogue }),
    ).toBeNull();
    expect(
      suggestMachineFromPriorSetup({ scope, remembered: "none", priorDeviceIds: ["dev-zzz"], devices: [device()], catalogue }),
    ).toBeNull();
  });
});
