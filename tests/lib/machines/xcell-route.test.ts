import { describe, expect, it } from "vitest";
import { MACHINE_CATALOGUE } from "../../../lib/machines/catalogue";
import { XCELL_ONE_CHOICE_LABEL, machineModelLabel, registrableProfiles } from "../../../lib/machines/display-name";
import type { StudioDevice } from "../../../lib/machines/selection";
import { xcellMultiplexRoute } from "../../../lib/machines/xcell-route";
import { XCELL_PUR_PROFILE_ID } from "../../../lib/machines/xcell-pur";

// HON-71: MultiPlex is a MODE of the studio's one xCell choice. The route exists only when MultiPlex can really be saved, and no surface
// ever shows a second, separately selectable "xCell Pur".

const unit = (over: Partial<StudioDevice> = {}): StudioDevice => ({
  deviceId: "unit-1", studioId: "s", profileId: XCELL_PUR_PROFILE_ID, profileVersion: 1, displayName: "Dectro xCell", installedOptions: [], retiredAt: null, ...over,
});
const placeholder = (over: Partial<StudioDevice> = {}): StudioDevice => ({
  deviceId: "ph-1", studioId: "s", profileId: XCELL_PUR_PROFILE_ID, profileVersion: 1, displayName: "Machine not specified", installedOptions: [], retiredAt: null, isUnspecified: true, ...over,
});
const base = {
  legacyOffered: true, registeredUnitAllowed: true, catalogue: MACHINE_CATALOGUE, devices: [unit()], unspecifiedUnits: [] as StudioDevice[], studioId: "s",
  publishedModes: ["multiplex"] as string[] | null,
};

describe("MultiPlex is offered to EVERY studio once it can really be saved", () => {
  it("a studio with NO registered machine, NO xCell history and the rollout off still gets the route, on the placeholder", () => {
    const r = xcellMultiplexRoute({ ...base, legacyOffered: false, registeredUnitAllowed: false, devices: [] });
    expect(r).toEqual({ deviceId: "unspecified:xcell-pur", modeKey: "multiplex", unspecified: true });
  });
  it("uses the real placeholder row of the CURRENT version when it exists", () => {
    const r = xcellMultiplexRoute({ ...base, legacyOffered: false, devices: [], unspecifiedUnits: [placeholder({ deviceId: "old", profileVersion: 0 }), placeholder()] });
    expect(r).toEqual({ deviceId: "ph-1", modeKey: "multiplex", unspecified: true });
  });
  it("a registered xCell unit is the route only beside the existing xCell choice AND when the rollout allows it; otherwise the machine stays unspecified", () => {
    expect(xcellMultiplexRoute(base)).toEqual({ deviceId: "unit-1", modeKey: "multiplex", unspecified: false });
    expect(xcellMultiplexRoute({ ...base, registeredUnitAllowed: false })?.unspecified).toBe(true);
    expect(xcellMultiplexRoute({ ...base, legacyOffered: false })?.unspecified).toBe(true);
  });
  it("the machine is never silently a registered unit the person did not select: a studio with a unit but no xCell choice still gets the placeholder", () => {
    expect(xcellMultiplexRoute({ ...base, legacyOffered: false })).toMatchObject({ unspecified: true });
  });
  it("a SAVED placeholder area keeps recognising its own placeholder even when the studio has a registered unit and the xCell choice", () => {
    const r = xcellMultiplexRoute({ ...base, unspecifiedUnits: [placeholder()], savedUnitId: "ph-1" });
    expect(r).toEqual({ deviceId: "ph-1", modeKey: "multiplex", unspecified: true });
  });
  it("a placeholder is never picked as the registered unit", () => {
    const r = xcellMultiplexRoute({ ...base, devices: [placeholder()] });
    expect(r?.unspecified).toBe(true);
  });
  it.each([
    ["the contract row is not published", { publishedModes: [] }],
    ["another mode is published but not multiplex", { publishedModes: ["blend"] }],
    ["the published read failed", { publishedModes: null }],
  ])("is NOT offered when %s", (_n, over) => {
    expect(xcellMultiplexRoute({ ...base, ...over } as typeof base)).toBeNull();
    expect(xcellMultiplexRoute({ ...base, legacyOffered: false, devices: [], ...over } as typeof base)).toBeNull();
  });
  it("a retired or other-model or other-version registered unit is never the route's unit (the placeholder is)", () => {
    for (const d of [unit({ retiredAt: "2026-11-01T00:00:00Z" }), unit({ profileId: "dectro-apilus:senior-3g" }), unit({ profileVersion: 9 })]) {
      expect(xcellMultiplexRoute({ ...base, devices: [d] })?.unspecified).toBe(true);
    }
  });
  it("PROFILE ACTIVE is its own check: a blocked profile whose MultiPlex mode still reads active offers no route", () => {
    const blockedProfile = MACHINE_CATALOGUE.map((p) => (p.profileId === XCELL_PUR_PROFILE_ID ? { ...p, availability: "blocked" as const } : p));
    expect(blockedProfile.find((p) => p.profileId === XCELL_PUR_PROFILE_ID)!.modes.find((m) => m.key === "multiplex")!.availability).toBe("active");
    expect(xcellMultiplexRoute({ ...base, catalogue: blockedProfile })).toBeNull();
  });
  it("MODE ACTIVE is its own check (THE STOP): an active profile whose MultiPlex mode is withheld offers no route", () => {
    const withheld = MACHINE_CATALOGUE.map((p) => (p.profileId === XCELL_PUR_PROFILE_ID ? { ...p, modes: p.modes.map((m) => ({ ...m, availability: "blocked" as const })) } : p));
    expect(xcellMultiplexRoute({ ...base, catalogue: withheld })).toBeNull();
    expect(xcellMultiplexRoute({ ...base, legacyOffered: false, devices: [], catalogue: withheld })).toBeNull();
  });
  it("picks one registered unit deterministically when there are several", () => {
    expect(xcellMultiplexRoute({ ...base, devices: [unit({ deviceId: "b" }), unit({ deviceId: "a" })] })?.deviceId).toBe("a");
  });
});

describe("one xCell, one name", () => {
  const pur = MACHINE_CATALOGUE.find((p) => p.profileId === XCELL_PUR_PROFILE_ID)!;
  it("shows the xCell Pur contract as the studio's xCell everywhere a model is named", () => {
    expect(machineModelLabel(pur)).toBe(XCELL_ONE_CHOICE_LABEL);
    expect(machineModelLabel(pur)).not.toMatch(/pur/i);
  });
  it("leaves every other model's label exactly as it was", () => {
    for (const p of MACHINE_CATALOGUE.filter((x) => x.profileId !== XCELL_PUR_PROFILE_ID)) {
      expect(machineModelLabel(p), p.profileId).toBe(`${p.manufacturer} ${p.model}${p.variant ? ` (${p.variant})` : ""}`);
    }
  });
  it("is offered for registration while the studio has no live xCell unit, and only then (one xCell, no duplicate)", () => {
    const none = registrableProfiles(MACHINE_CATALOGUE, [], true).map((p) => p.profileId);
    expect(none).toContain(XCELL_PUR_PROFILE_ID);
    expect(none.length).toBe(MACHINE_CATALOGUE.length);
    const has = registrableProfiles(MACHINE_CATALOGUE, [{ profileId: XCELL_PUR_PROFILE_ID }], true).map((p) => p.profileId);
    expect(has).not.toContain(XCELL_PUR_PROFILE_ID);
    expect(has.length).toBe(MACHINE_CATALOGUE.length - 1);
    // another model's unit does not hide it
    expect(registrableProfiles(MACHINE_CATALOGUE, [{ profileId: "dectro-apilus:senior-3g" }], true).map((p) => p.profileId)).toContain(XCELL_PUR_PROFILE_ID);
  });
  it("a studio NOT on the rollout allowlist is never offered the xCell, whatever else is true", () => {
    expect(registrableProfiles(MACHINE_CATALOGUE, [], false).map((p) => p.profileId)).not.toContain(XCELL_PUR_PROFILE_ID);
    expect(registrableProfiles(MACHINE_CATALOGUE, [], false).length).toBe(MACHINE_CATALOGUE.length - 1);
  });
  it("the settings page builds its list from the PUBLISHED models and the studio's live units", async () => {
    const { readFileSync } = await import("node:fs");
    const page = readFileSync("app/(app)/settings/machines/page.tsx", "utf8");
    expect(page).toMatch(/registrableProfiles\(\s*listableProfiles\(/);
    expect(page).toMatch(/listed\.ok \? listed\.value : \[\]/);
    expect(page).toContain("await xcellRegistrationAllowed(studio.id)");
  });
  it("no user-facing file composes a model name by hand any more", async () => {
    const { readFileSync } = await import("node:fs");
    const files = [
      "components/machines/machine-first-setup-panel.tsx", "components/machines/machine-prior-setup.tsx", "app/(app)/settings/machines/page.tsx",
      "lib/machines/charting.ts", "lib/machines/profile-provenance.ts", "lib/machines/selection.ts", "app/(app)/clients/[id]/sessions/[sessionId]/machine-setup-actions.ts",
    ];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/\$\{[a-z.]*profile\.manufacturer\} \$\{[a-z.]*profile\.model\}|profile\.manufacturer\} \{[a-z.]*profile\.model/);
    }
    expect(readFileSync("app/(app)/settings/machines/page.tsx", "utf8")).toContain("registrableProfiles(");
  });
});
