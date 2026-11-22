import { describe, expect, it } from "vitest";
import { withholdXcellUnits } from "@/lib/machines/xcell-withhold";
import type { StudioDevice } from "@/lib/machines/selection";
import { XCELL_PUR_PROFILE_ID } from "@/lib/machines/xcell-pur";

const dev = (deviceId: string, profileId: string) => ({ deviceId, profileId, profileVersion: 1, studioId: "s", displayName: deviceId, installedOptions: [], retiredAt: null }) as unknown as StudioDevice;
const PUR = dev("unit-pur", XCELL_PUR_PROFILE_ID);
const OTHER = dev("unit-other", "some:other-model");
type In = {
  rollout: "available" | "off" | "unavailable"; devices: StudioDevice[];
  remembered: { deviceId: string; modeKey: string | null } | null;
  suggestedMachine: { deviceId: string; displayName: string } | null;
  restoredSelection: { deviceId: string; modeKey: string } | null;
  clientLastMachine: { deviceId: string | null; modeKey: string | null; legacy: boolean } | null;
};
const base = (over: Partial<In> = {}): In => ({
  rollout: "unavailable",
  devices: [PUR, OTHER],
  remembered: null,
  suggestedMachine: null,
  restoredSelection: null,
  clientLastMachine: null,
  ...over,
});

describe("a failed rollout read withholds the xCell unit and every selection pointing at it", () => {
  it("the unit leaves the device list; another machine stays", () => {
    expect(withholdXcellUnits(base()).devices.map((d) => d.deviceId)).toEqual(["unit-other"]);
  });
  it("a REMEMBERED selection of the unit is null", () => {
    expect(withholdXcellUnits(base({ remembered: { deviceId: "unit-pur", modeKey: "multiplex" } })).remembered).toBeNull();
  });
  it("a SUGGESTED machine that is the unit is null", () => {
    expect(withholdXcellUnits(base({ suggestedMachine: { deviceId: "unit-pur", displayName: "x" } })).suggestedMachine).toBeNull();
  });
  it("a RESTORED selection of the unit is null", () => {
    expect(withholdXcellUnits(base({ restoredSelection: { deviceId: "unit-pur", modeKey: "multiplex" } })).restoredSelection).toBeNull();
  });
  it("a CLIENT-LAST machine that is the unit is null", () => {
    expect(withholdXcellUnits(base({ clientLastMachine: { deviceId: "unit-pur", modeKey: "multiplex", legacy: false } })).clientLastMachine).toBeNull();
  });
  it("selections of OTHER machines (and a legacy last-machine with no unit) are kept", () => {
    const r = withholdXcellUnits(base({
      remembered: { deviceId: "unit-other", modeKey: null },
      suggestedMachine: { deviceId: "unit-other", displayName: "o" },
      restoredSelection: { deviceId: "unit-other", modeKey: "m" },
      clientLastMachine: { deviceId: null, modeKey: null, legacy: true },
    }));
    expect(r.remembered?.deviceId).toBe("unit-other");
    expect(r.suggestedMachine?.deviceId).toBe("unit-other");
    expect(r.restoredSelection?.deviceId).toBe("unit-other");
    expect(r.clientLastMachine?.legacy).toBe(true);
  });
  it("with the rollout available nothing is changed, including a selection of the unit", () => {
    const input = base({ rollout: "available", remembered: { deviceId: "unit-pur", modeKey: "multiplex" } });
    const r = withholdXcellUnits(input);
    expect(r.devices).toHaveLength(2);
    expect(r.remembered?.deviceId).toBe("unit-pur");
  });
});

describe("with the rollout OFF for a new setup, the unit is not offered and nothing may preselect it", () => {
  const off = (over: Partial<In> = {}) => withholdXcellUnits(base({ rollout: "off", ...over }));
  it("the unit leaves the list; another machine stays", () => {
    expect(off().devices.map((d) => d.deviceId)).toEqual(["unit-other"]);
  });
  it("a remembered selection of the unit is cleared", () => {
    expect(off({ remembered: { deviceId: "unit-pur", modeKey: "multiplex" } }).remembered).toBeNull();
  });
  it("a suggested machine that is the unit is cleared", () => {
    expect(off({ suggestedMachine: { deviceId: "unit-pur", displayName: "x" } }).suggestedMachine).toBeNull();
  });
  it("a last-used machine that is the unit is cleared", () => {
    expect(off({ clientLastMachine: { deviceId: "unit-pur", modeKey: "multiplex", legacy: false } }).clientLastMachine).toBeNull();
  });
  it("a restored selection (an existing block's own record) is kept", () => {
    expect(off({ restoredSelection: { deviceId: "unit-pur", modeKey: "multiplex" } }).restoredSelection?.deviceId).toBe("unit-pur");
  });
  it("selections of other machines are kept", () => {
    const r = off({ remembered: { deviceId: "unit-other", modeKey: null }, suggestedMachine: { deviceId: "unit-other", displayName: "o" }, clientLastMachine: { deviceId: "unit-other", modeKey: null, legacy: false } });
    expect([r.remembered?.deviceId, r.suggestedMachine?.deviceId, r.clientLastMachine?.deviceId]).toEqual(["unit-other", "unit-other", "unit-other"]);
  });
});
