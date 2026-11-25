import { describe, expect, it } from "vitest";
import { applyEnabledMachines } from "../../../lib/machines/enabled-machines";
import type { StudioDevice } from "../../../lib/machines/selection";

const PUR = "dectro-apilus:xcell-pur";
const SEN = "dectro-apilus:senior-3g";
const JUN = "dectro-apilus:junior-3g";
const dev = (deviceId: string, profileId: string, over: Partial<StudioDevice> = {}): StudioDevice => ({ deviceId, studioId: "s", profileId, profileVersion: 3, displayName: deviceId, installedOptions: [], retiredAt: null, ...over });
const base = { devices: [dev("u-pur", PUR), dev("u-sen", SEN), dev("u-jun", JUN), dev("u-other", "other:model")], legacyOffered: true, remembered: null, suggestedMachine: null, clientLastMachine: null };
const ch = (enabled: string[], defaultProfileId: string | null) => ({ enabled: new Set(enabled), defaultProfileId });

describe("the owner's switches applied to a new area's picker", () => {
  it("no switches (null) or an existing block: nothing changes, no default", () => {
    for (const r of [applyEnabledMachines({ ...base, choices: null, creating: true }), applyEnabledMachines({ ...base, choices: ch([SEN], SEN), creating: false })]) {
      expect(r.devices).toHaveLength(4);
      expect(r.legacyOffered).toBe(true);
      expect(r.defaultMachine).toBeNull();
    }
  });
  it("a model that is off leaves the list; a unit of an unlisted profile is never touched; xCell off removes the existing xCell entry", () => {
    const r = applyEnabledMachines({ ...base, choices: ch([SEN], SEN), creating: true });
    expect(r.devices.map((d) => d.deviceId)).toEqual(["u-sen", "u-other"]);
    expect(r.legacyOffered).toBe(false);
  });
  it("THE DEFAULT UNIT is chosen among the SELECTABLE units: a lowest-id unit the picker would hide (outdated version) is skipped, and with none selectable there is no default", () => {
    const devices = [dev("a-old", SEN), dev("b-ok", SEN), dev("u-pur", PUR)];
    const only = (ids: string[]) => (d: { deviceId: string }) => ids.includes(d.deviceId);
    const r = applyEnabledMachines({ ...base, devices, choices: ch([PUR, SEN], SEN), creating: true, isSelectable: only(["b-ok", "u-pur"]) });
    expect(r.defaultMachine).toEqual({ kind: "native", deviceId: "b-ok" });
    expect(applyEnabledMachines({ ...base, devices, choices: ch([PUR, SEN], SEN), creating: true }).defaultMachine, "without the predicate every unit counts").toEqual({ kind: "native", deviceId: "a-old" });
    expect(applyEnabledMachines({ ...base, devices, choices: ch([PUR, SEN], SEN), creating: true, isSelectable: only([]) }).defaultMachine).toBeNull();
  });
  it("EVERY model off (an empty set): no switchable unit and no existing xCell entry is offered, there is no default, and an unlisted profile is untouched", () => {
    const r = applyEnabledMachines({ ...base, choices: ch([], null), creating: true });
    expect(r.devices.map((d) => d.deviceId)).toEqual(["u-other"]);
    expect(r.legacyOffered).toBe(false);
    expect(r.defaultMachine).toBeNull();
  });
  it("xCell on keeps the existing xCell entry and its units", () => {
    const r = applyEnabledMachines({ ...base, choices: ch([PUR, JUN], PUR), creating: true });
    expect(r.devices.map((d) => d.deviceId)).toEqual(["u-pur", "u-jun", "u-other"]);
    expect(r.legacyOffered).toBe(true);
  });
  it("a remembered, suggested or client-last pointer at a switched-off unit is cleared; a pointer at an enabled unit stays", () => {
    const r = applyEnabledMachines({ ...base, choices: ch([SEN], SEN), creating: true, remembered: { deviceId: "u-jun" }, suggestedMachine: { deviceId: "u-pur" }, clientLastMachine: { deviceId: "u-sen" } });
    expect(r.remembered).toBeNull();
    expect(r.suggestedMachine).toBeNull();
    expect(r.clientLastMachine).toEqual({ deviceId: "u-sen" });
  });
  it("the default: xCell is the existing xCell entry; another model is its lowest-id live unit; a default that is off or has no unit offers none", () => {
    expect(applyEnabledMachines({ ...base, choices: ch([PUR, SEN], PUR), creating: true }).defaultMachine).toEqual({ kind: "legacy" });
    expect(applyEnabledMachines({ ...base, choices: ch([PUR, SEN], SEN), creating: true }).defaultMachine).toEqual({ kind: "native", deviceId: "u-sen" });
    expect(applyEnabledMachines({ ...base, choices: ch([PUR, SEN], null), creating: true }).defaultMachine).toBeNull();
    expect(applyEnabledMachines({ ...base, choices: ch([PUR], JUN), creating: true }).defaultMachine).toBeNull();
    expect(applyEnabledMachines({ ...base, devices: [dev("u-sen", SEN, { retiredAt: "2026-01-01" })], choices: ch([SEN], SEN), creating: true }).defaultMachine).toBeNull();
    expect(applyEnabledMachines({ ...base, legacyOffered: false, choices: ch([PUR], PUR), creating: true }).defaultMachine).toBeNull();
  });
});

import { readFileSync } from "node:fs";
describe("the loader resolves the default among the units the picker offers", () => {
  it("passes the selectable-unit predicate (selectableDevices) into applyEnabledMachines", () => {
    const src = readFileSync("app/(app)/clients/[id]/sessions/[sessionId]/machine-setup-actions.ts", "utf8");
    expect(src).toContain("const selectableIds = new Set(selectableDevices(scope, offered.devices, catalogue)");
    expect(src).toContain("isSelectable: (d) => selectableIds.has(d.deviceId),");
  });
});
