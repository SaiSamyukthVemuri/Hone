import { describe, expect, it } from "vitest";
import { MACHINE_CATALOGUE } from "../../../lib/machines/catalogue";
import type { StudioDevice } from "../../../lib/machines/selection";
import { XCELL_PUR_PROFILE_ID } from "../../../lib/machines/xcell-pur";
import { resolveXcellMultiplexOffer } from "../../../lib/machines/xcell-route";
import { readXcellModelSwitch } from "../../../lib/machines/xcell-switch-seam";

// MultiPlex is ALWAYS offered (placeholder unit by default). The owner's switch governs ONLY the registered-unit path:
//  - unavailable: exactly the production route;  - off: the placeholder, never a registered unit;
//  - on: a live registered unit binds (the client's last-used live unit, else the lowest id); a studio that never had a unit keeps the placeholder
//    and the create-at-first-save flag is carried; a studio whose only units are retired keeps the placeholder (no refusal, nothing recreated).

const S = "studio-1";
const unit = (over: Partial<StudioDevice> = {}): StudioDevice => ({
  deviceId: "unit-1", studioId: S, profileId: XCELL_PUR_PROFILE_ID, profileVersion: 1, displayName: "Dectro xCell", installedOptions: [], retiredAt: null, ...over,
});
const PLACEHOLDER_ID = "unspecified:xcell-pur";
const route = (over: Record<string, unknown> = {}) => ({
  legacyOffered: true,
  registeredUnitAllowed: true,
  catalogue: MACHINE_CATALOGUE,
  devices: [] as StudioDevice[],
  unspecifiedUnits: [] as StudioDevice[],
  studioId: S,
  publishedModes: ["multiplex"] as string[] | null,
  ...over,
});
const offer = (switchState: Parameters<typeof resolveXcellMultiplexOffer>[0]["switchState"], r: Record<string, unknown> = {}, extra: { clientLastUnitId?: string | null; allPurUnits?: StudioDevice[] } = {}) =>
  resolveXcellMultiplexOffer({ switchState, clientLastUnitId: extra.clientLastUnitId ?? null, allPurUnits: extra.allPurUnits ?? [], route: route(r) as never });
const bound = (id: string) => ({ deviceId: id, modeKey: "multiplex", unspecified: false });
const placeholder = { deviceId: expect.stringContaining("unspecified") as unknown as string, modeKey: "multiplex", unspecified: true };

describe("switch unavailable: the production route, unchanged", () => {
  it("history and a unit: the registered unit; no history: the placeholder", () => {
    expect(offer({ available: false }, { devices: [unit()] })).toEqual({ route: bound("unit-1"), createAtFirstSave: false });
    expect(offer({ available: false }, { legacyOffered: false, devices: [unit()] })).toEqual({ route: placeholder, createAtFirstSave: false });
  });
});

describe("switch available: it governs only the registered-unit path", () => {
  it("OFF: MultiPlex is still offered, with the placeholder, even with history and a live unit", () => {
    expect(offer({ available: true, enabled: false }, { devices: [unit()] })).toEqual({ route: placeholder, createAtFirstSave: false });
  });
  it("ON with a live unit: the unit binds; the client's last-used live unit wins, else the lowest id", () => {
    const two = [unit({ deviceId: "unit-b" }), unit({ deviceId: "unit-a" })];
    expect(offer({ available: true, enabled: true }, { devices: two }).route).toEqual(bound("unit-a"));
    expect(offer({ available: true, enabled: true }, { devices: two }, { clientLastUnitId: "unit-b" }).route).toEqual(bound("unit-b"));
    expect(offer({ available: true, enabled: true }, { devices: two }, { clientLastUnitId: "gone" }).route).toEqual(bound("unit-a"));
  });
  it("ON, no unit ever registered: the placeholder route and the create-at-first-save flag", () => {
    expect(offer({ available: true, enabled: true }, { legacyOffered: false })).toEqual({ route: placeholder, createAtFirstSave: true });
  });
  it("ON, every unit retired: the placeholder, NO refusal, and nothing is created at the first save", () => {
    const retired = unit({ retiredAt: "2026-11-01T00:00:00Z" });
    expect(offer({ available: true, enabled: true }, { devices: [] }, { allPurUnits: [retired] })).toEqual({ route: placeholder, createAtFirstSave: false });
  });
  it("a placeholder row is not 'a unit that once existed': it does not stop create-at-first-save", () => {
    expect(offer({ available: true, enabled: true }, {}, { allPurUnits: [unit({ isUnspecified: true })] }).createAtFirstSave).toBe(true);
  });
  it("the contract unpublished or its read failed: no route and nothing to create, whatever the switch says", () => {
    for (const publishedModes of [[] as string[], null]) {
      expect(offer({ available: true, enabled: true }, { publishedModes })).toEqual({ route: null, createAtFirstSave: false });
    }
  });
  it("the placeholder id before its row exists is the sentinel", () => {
    expect(offer({ available: true, enabled: false }).route?.deviceId).toBe(PLACEHOLDER_ID);
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
