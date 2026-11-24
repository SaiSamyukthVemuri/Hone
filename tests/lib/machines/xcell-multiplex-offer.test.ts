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
      route: { deviceId: "unit-1", modeKey: "multiplex" }, createAtFirstSave: false, refusal: null
    });
  });
  it("no history: nothing is offered, exactly as today", () => {
    expect(resolveXcellMultiplexOffer({ ...common, switchState: { available: false }, legacyOffered: false, devices: [unit()] })).toEqual({
      route: null, createAtFirstSave: false, refusal: null
    });
  });
});

describe("switch available: the owner's switch decides", () => {
  it("enabled, no history, no unit: offered, the unit is for the first save, and the xCell choice itself is offered by the switch", () => {
    expect(resolveXcellMultiplexOffer({ ...common, switchState: { available: true, enabled: true }, legacyOffered: false, devices: [] })).toEqual({
      route: null, createAtFirstSave: true, refusal: null
    });
  });
  it("enabled with a live unit: the unit routes it, history is irrelevant", () => {
    for (const legacyOffered of [true, false]) {
      expect(resolveXcellMultiplexOffer({ ...common, switchState: { available: true, enabled: true }, legacyOffered, devices: [unit()] })).toEqual({
        route: { deviceId: "unit-1", modeKey: "multiplex" }, createAtFirstSave: false, refusal: null
      });
    }
  });
  it("enabled, every unit retired: refused with the plain message, nothing created", () => {
    expect(resolveXcellMultiplexOffer({ ...common, switchState: { available: true, enabled: true }, legacyOffered: true, devices: [unit({ retiredAt: "2026-11-01T00:00:00Z" })] })).toEqual({
      route: null, createAtFirstSave: false, refusal: XCELL_MULTIPLEX_RETIRED_MESSAGE
    });
  });
  it("not enabled: nothing is offered by the switch, even with history and a unit", () => {
    expect(resolveXcellMultiplexOffer({ ...common, switchState: { available: true, enabled: false }, legacyOffered: true, devices: [unit()] })).toEqual({
      route: null, createAtFirstSave: false, refusal: null
    });
  });
});

describe("the switch seam", () => {
  const S = "11111111-1111-4111-8111-111111111111";
  const OTHER = "22222222-2222-4222-8222-222222222222";
  const PUR = "dectro-apilus:xcell-pur";
  const rows = (data: unknown, error: unknown = null) => ({ rpc: async () => ({ data, error }) });
  it("a failed read, a thrown read, a non-array and no row for the studio are all UNAVAILABLE (the old route)", async () => {
    await expect(readXcellModelSwitch(S, rows(null, { message: "x" }))).resolves.toEqual({ available: false });
    await expect(readXcellModelSwitch(S, { rpc: async () => { throw new Error("down"); } })).resolves.toEqual({ available: false });
    await expect(readXcellModelSwitch(S, rows({ studio_id: S }))).resolves.toEqual({ available: false });
    await expect(readXcellModelSwitch(S, rows([]))).resolves.toEqual({ available: false });
    await expect(readXcellModelSwitch(S, rows([{ studio_id: OTHER, profile_id: PUR, enabled: true }]))).resolves.toEqual({ available: false });
    await expect(readXcellModelSwitch("", rows([{ studio_id: S, profile_id: PUR, enabled: true }]))).resolves.toEqual({ available: false });
  });
  const row = (profile_id: string, enabled: boolean, studio_id = S) => ({ studio_id, profile_id, enabled });
  it("the xCell's switch decides: ON when its row is on, OFF when its row is off or only other models are on; another studio's rows never count", async () => {
    await expect(readXcellModelSwitch(S, rows([row(PUR, true), row("dectro-apilus:senior-3g", true)]))).resolves.toEqual({ available: true, enabled: true });
    await expect(readXcellModelSwitch(S, rows([row(PUR, false), row("dectro-apilus:senior-3g", true)]))).resolves.toEqual({ available: true, enabled: false });
    await expect(readXcellModelSwitch(S, rows([row(PUR, true, OTHER), row("dectro-apilus:junior-3g", true)]))).resolves.toEqual({ available: true, enabled: false });
  });
  it("EVERY model off is still AVAILABLE (and off), never the unavailable answer that restores the old unfiltered picker", async () => {
    const allOff = [row(PUR, false), row("dectro-apilus:senior-3g", false), row("dectro-apilus:junior-3g", false)];
    await expect(readXcellModelSwitch(S, rows(allOff))).resolves.toEqual({ available: true, enabled: false });
  });
});
