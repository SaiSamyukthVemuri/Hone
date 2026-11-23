import { describe, expect, it } from "vitest";
import { MACHINE_CATALOGUE } from "../../../lib/machines/catalogue";
import type { StudioDevice } from "../../../lib/machines/selection";
import { XCELL_PUR_PROFILE_ID } from "../../../lib/machines/xcell-pur";
import { xcellMultiplexSwitchRoute } from "../../../lib/machines/xcell-route";

// Product decision: MultiPlex follows the OWNER'S SWITCH, not the studio's old xCell history. After the owner
// enables the model, the unit record is created on the first SUCCESSFUL MultiPlex save, exactly once. A retired unit is never silently
// recreated: MultiPlex refuses and says so. These pin the DECISION; the once-only creation under a double save or a race is a database
// property and is pinned by the DB test of the new command.

const unit = (over: Partial<StudioDevice> = {}): StudioDevice => ({
  deviceId: "unit-b", studioId: "s", profileId: XCELL_PUR_PROFILE_ID, profileVersion: 1, displayName: "Dectro xCell", installedOptions: [], retiredAt: null, ...over,
});
const base = {
  modelEnabled: true,
  catalogue: MACHINE_CATALOGUE,
  devices: [] as StudioDevice[],
  publishedModes: ["multiplex"] as string[] | null,
  clientLastUnitId: null as string | null,
};

describe("the owner's switch decides, old xCell history is not read", () => {
  it("a studio with NO history and NO unit, model enabled: MultiPlex is offered and the unit will be created at the first save", () => {
    expect(xcellMultiplexSwitchRoute(base)).toEqual({ kind: "create-at-first-save", modeKey: "multiplex" });
  });
  it("the input has no history field at all, so history cannot influence the answer", () => {
    expect(Object.keys(base)).not.toContain("legacyOffered");
    expect(xcellMultiplexSwitchRoute({ ...base, legacyOffered: false } as typeof base)).toEqual({ kind: "create-at-first-save", modeKey: "multiplex" });
  });
  it("the model is not enabled by the owner: nothing is offered", () => {
    expect(xcellMultiplexSwitchRoute({ ...base, modelEnabled: false })).toBeNull();
  });
  it("the WRONG model is the enabled one (the switch is per model): nothing is offered; the input names the xCell Pur's own switch only", () => {
    // A studio that enabled another model passes modelEnabled=false for the xCell Pur; a live unit of another model never counts as an xCell unit.
    expect(xcellMultiplexSwitchRoute({ ...base, modelEnabled: false, devices: [unit({ profileId: "dectro-apilus:senior-3g" })] })).toBeNull();
    expect(xcellMultiplexSwitchRoute({ ...base, devices: [unit({ profileId: "dectro-apilus:senior-3g" })] })).toEqual({ kind: "create-at-first-save", modeKey: "multiplex" });
  });
  it.each([
    ["the contract row is not published", { publishedModes: [] as string[] }],
    ["the published read failed", { publishedModes: null }],
  ])("is not offered when %s", (_n, over) => {
    expect(xcellMultiplexSwitchRoute({ ...base, ...over })).toBeNull();
  });
});

describe("an existing live unit is reused, never duplicated", () => {
  it("one live unit: that unit, no creation", () => {
    expect(xcellMultiplexSwitchRoute({ ...base, devices: [unit()] })).toEqual({ kind: "use-unit", deviceId: "unit-b", modeKey: "multiplex" });
  });
  it("several live units: the client's last-used unit when it is live", () => {
    const devices = [unit({ deviceId: "unit-a" }), unit({ deviceId: "unit-b" }), unit({ deviceId: "unit-c" })];
    expect(xcellMultiplexSwitchRoute({ ...base, devices, clientLastUnitId: "unit-c" })).toEqual({ kind: "use-unit", deviceId: "unit-c", modeKey: "multiplex" });
  });
  it("several live units and no last-used unit: the lowest id", () => {
    const devices = [unit({ deviceId: "unit-b" }), unit({ deviceId: "unit-a" })];
    expect(xcellMultiplexSwitchRoute({ ...base, devices })).toEqual({ kind: "use-unit", deviceId: "unit-a", modeKey: "multiplex" });
  });
  it("the last-used unit is retired or belongs to another model: it is ignored and the lowest live id is used", () => {
    const devices = [unit({ deviceId: "unit-a" }), unit({ deviceId: "unit-r", retiredAt: "2026-11-01T00:00:00Z" })];
    expect(xcellMultiplexSwitchRoute({ ...base, devices, clientLastUnitId: "unit-r" })).toEqual({ kind: "use-unit", deviceId: "unit-a", modeKey: "multiplex" });
    expect(xcellMultiplexSwitchRoute({ ...base, devices, clientLastUnitId: "not-an-xcell" })).toEqual({ kind: "use-unit", deviceId: "unit-a", modeKey: "multiplex" });
  });
  it("a unit on another contract version is not this model's usable unit", () => {
    expect(xcellMultiplexSwitchRoute({ ...base, devices: [unit({ profileVersion: 9 })] })).toEqual({ kind: "create-at-first-save", modeKey: "multiplex" });
  });
});

describe("a retired unit is never silently recreated", () => {
  it("only retired units exist: MultiPlex refuses with the retired reason, and creates nothing", () => {
    const r = xcellMultiplexSwitchRoute({ ...base, devices: [unit({ retiredAt: "2026-11-01T00:00:00Z" })] });
    expect(r).toEqual({ kind: "refused", reason: "retired" });
  });
  it("a retired unit and a live one: the live one is used (retirement of one unit does not block the studio)", () => {
    const devices = [unit({ deviceId: "unit-r", retiredAt: "2026-11-01T00:00:00Z" }), unit({ deviceId: "unit-z" })];
    expect(xcellMultiplexSwitchRoute({ ...base, devices })).toEqual({ kind: "use-unit", deviceId: "unit-z", modeKey: "multiplex" });
  });
  it("the refusal wording tells the practitioner what to do and names no code", async () => {
    const { XCELL_MULTIPLEX_RETIRED_MESSAGE } = await import("../../../lib/machines/xcell-route");
    expect(XCELL_MULTIPLEX_RETIRED_MESSAGE).toMatch(/retired/i);
    expect(XCELL_MULTIPLEX_RETIRED_MESSAGE).toMatch(/owner/i);
    expect(XCELL_MULTIPLEX_RETIRED_MESSAGE).not.toMatch(/[_]{1}|\b0\d{3}\b|studio_machines/);
  });
});
