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
const base = { legacyOffered: true, catalogue: MACHINE_CATALOGUE, devices: [unit()], publishedModes: ["multiplex"] as string[] | null };

describe("the route exists only when MultiPlex can really be saved", () => {
  it("is offered with the existing choice, an active profile, a PUBLISHED row and a usable unit", () => {
    expect(xcellMultiplexRoute(base)).toEqual({ deviceId: "unit-1", modeKey: "multiplex" });
  });
  it.each([
    ["no existing xCell choice (no history)", { legacyOffered: false }],
    ["the contract row is not published", { publishedModes: [] }],
    ["another mode is published but not multiplex", { publishedModes: ["blend"] }],
    ["the published read failed", { publishedModes: null }],
    ["no unit exists", { devices: [] }],
    ["the only unit is retired", { devices: [unit({ retiredAt: "2026-11-01T00:00:00Z" })] }],
    ["the unit is another model", { devices: [unit({ profileId: "dectro-apilus:senior-3g" })] }],
    ["the unit is on another contract version", { devices: [unit({ profileVersion: 9 })] }],
  ])("is NOT offered when %s, so Chloe's form is exactly as it was", (_n, over) => {
    expect(xcellMultiplexRoute({ ...base, ...over } as typeof base)).toBeNull();
  });
  it("PROFILE ACTIVE is its own check: a blocked profile whose MultiPlex mode still reads active offers no route", () => {
    const blockedProfile = MACHINE_CATALOGUE.map((p) => (p.profileId === XCELL_PUR_PROFILE_ID ? { ...p, availability: "blocked" as const } : p));
    expect(blockedProfile.find((p) => p.profileId === XCELL_PUR_PROFILE_ID)!.modes.find((m) => m.key === "multiplex")!.availability).toBe("active");
    expect(xcellMultiplexRoute({ ...base, catalogue: blockedProfile })).toBeNull();
  });
  it("MODE ACTIVE is its own check: an active profile whose MultiPlex mode is withheld offers no route", () => {
    const withheld = MACHINE_CATALOGUE.map((p) => (p.profileId === XCELL_PUR_PROFILE_ID ? { ...p, modes: p.modes.map((m) => ({ ...m, availability: "blocked" as const })) } : p));
    expect(xcellMultiplexRoute({ ...base, catalogue: withheld })).toBeNull();
  });
  it("is not offered when the catalogue does not carry an active profile", () => {
    const blocked = MACHINE_CATALOGUE.map((p) => (p.profileId === XCELL_PUR_PROFILE_ID ? { ...p, availability: "blocked" as const } : p));
    expect(xcellMultiplexRoute({ ...base, catalogue: blocked })).toBeNull();
  });
  it("picks one unit deterministically when there are several", () => {
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
  it("is not in the list an owner registers from: the unit is created by the reviewed publication step", () => {
    const ids = registrableProfiles(MACHINE_CATALOGUE).map((p) => p.profileId);
    expect(ids).not.toContain(XCELL_PUR_PROFILE_ID);
    expect(ids.length).toBe(MACHINE_CATALOGUE.length - 1);
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
