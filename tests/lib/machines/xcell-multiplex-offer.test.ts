import { describe, expect, it } from "vitest";
import { MACHINE_CATALOGUE } from "../../../lib/machines/catalogue";
import type { StudioDevice } from "../../../lib/machines/selection";
import { XCELL_PUR_PROFILE_ID } from "../../../lib/machines/xcell-pur";
import { XCELL_MULTIPLEX_RETIRED_MESSAGE, resolveXcellMultiplexOffer } from "../../../lib/machines/xcell-route";
import { readXcellModelSwitch } from "../../../lib/machines/xcell-switch-seam";

// The picker's decision, in one place. Until the owner's switch exists in the database the switch is UNAVAILABLE, and the studio's route is
// EXACTLY what it was (history path). Once it is available it decides, and old history is not read. The create-at-first-save step is a
// carried flag only: nothing in app code creates a unit.

const unit = (over: Partial<StudioDevice> = {}): StudioDevice => ({
  deviceId: "unit-1", studioId: "s", profileId: XCELL_PUR_PROFILE_ID, profileVersion: 1, displayName: "Dectro xCell", installedOptions: [], retiredAt: null, ...over,
});
const common = { catalogue: MACHINE_CATALOGUE, publishedModes: ["multiplex"] as string[] | null, clientLastUnitId: null as string | null };

describe("switch unavailable: the history path, unchanged", () => {
  it("history and a unit: the same route as before, nothing else", () => {
    expect(resolveXcellMultiplexOffer({ ...common, switchState: { available: false }, legacyOffered: true, devices: [unit()] })).toEqual({
      route: { deviceId: "unit-1", modeKey: "multiplex" }, createAtFirstSave: false, refusal: null, legacyOfferedBySwitch: false,
    });
  });
  it("no history: nothing is offered, exactly as today", () => {
    expect(resolveXcellMultiplexOffer({ ...common, switchState: { available: false }, legacyOffered: false, devices: [unit()] })).toEqual({
      route: null, createAtFirstSave: false, refusal: null, legacyOfferedBySwitch: false,
    });
  });
});

describe("switch available: the owner's switch decides", () => {
  it("enabled, no history, no unit: offered, the unit is for the first save, and the xCell choice itself is offered by the switch", () => {
    expect(resolveXcellMultiplexOffer({ ...common, switchState: { available: true, enabled: true }, legacyOffered: false, devices: [] })).toEqual({
      route: null, createAtFirstSave: true, refusal: null, legacyOfferedBySwitch: true,
    });
  });
  it("enabled with a live unit: the unit routes it, history is irrelevant", () => {
    for (const legacyOffered of [true, false]) {
      expect(resolveXcellMultiplexOffer({ ...common, switchState: { available: true, enabled: true }, legacyOffered, devices: [unit()] })).toEqual({
        route: { deviceId: "unit-1", modeKey: "multiplex" }, createAtFirstSave: false, refusal: null, legacyOfferedBySwitch: true,
      });
    }
  });
  it("enabled, every unit retired: refused with the plain message, nothing created", () => {
    expect(resolveXcellMultiplexOffer({ ...common, switchState: { available: true, enabled: true }, legacyOffered: true, devices: [unit({ retiredAt: "2026-11-01T00:00:00Z" })] })).toEqual({
      route: null, createAtFirstSave: false, refusal: XCELL_MULTIPLEX_RETIRED_MESSAGE, legacyOfferedBySwitch: true,
    });
  });
  it("not enabled: nothing is offered by the switch, even with history and a unit", () => {
    expect(resolveXcellMultiplexOffer({ ...common, switchState: { available: true, enabled: false }, legacyOffered: true, devices: [unit()] })).toEqual({
      route: null, createAtFirstSave: false, refusal: null, legacyOfferedBySwitch: false,
    });
  });
});

describe("the switch seam", () => {
  it("reports UNAVAILABLE until the migration and its command exist, and reads nothing", async () => {
    await expect(readXcellModelSwitch("11111111-1111-4111-8111-111111111111")).resolves.toEqual({ available: false });
  });
});
