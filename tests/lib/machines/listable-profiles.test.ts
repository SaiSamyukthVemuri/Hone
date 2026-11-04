import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MACHINE_CATALOGUE } from "../../../lib/machines/catalogue";
import { listableProfiles } from "../../../lib/machines/listable-profiles";
import { activeModes, activeProfiles } from "../../../lib/machines/profile-contract";

describe("owner settings list needs a published contract (HON-8, no unfinished controls)", () => {
  const active = activeProfiles(MACHINE_CATALOGUE);
  it("the real catalogue has active Apilus profiles, so an ungated list WOULD show them", () => {
    expect(active.map((p) => p.profileId).sort()).toEqual(["dectro-apilus:junior-3g", "dectro-apilus:senior-3g"]);
  });
  it("lists nothing on hosted before publication (no rows, or a failed read)", () => {
    expect(listableProfiles(active, () => [])).toEqual([]);
    expect(listableProfiles(active, () => null)).toEqual([]);
  });
  it("lists a model only when every active mode is published at its version", () => {
    const [first, second] = active;
    const all = (p: typeof first) => activeModes(p).map((m) => m.key);
    expect(listableProfiles(active, (p) => (p === first ? all(p) : [])).map((p) => p.profileId)).toEqual([first.profileId]);
    expect(listableProfiles(active, (p) => (p === second ? all(p).slice(1) : all(p))).map((p) => p.profileId)).toEqual([first.profileId]);
  });
  it("the settings page uses it", () => {
    const page = readFileSync("app/(app)/settings/machines/page.tsx", "utf8");
    expect(page).toContain("listableProfiles(");
    expect(page).toContain("publishedModesFor(");
  });
});
