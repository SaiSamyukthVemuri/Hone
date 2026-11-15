import { describe, expect, it } from "vitest";
import { MACHINE_CATALOGUE } from "@/lib/machines/catalogue";
import { unsupportedModes } from "@/lib/machines/unsupported-modes";
import type { StudioDevice } from "@/lib/machines/selection";

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { MachineFirstSetupPanel } = await import("@/components/machines/machine-first-setup-panel");

const SCOPE = { studioId: "studio-synthetic", practitionerId: "pract-synthetic" };
const device = (profileId: string): StudioDevice => ({
  deviceId: "d1", studioId: SCOPE.studioId, profileId, profileVersion: 3, displayName: "Unit 1", installedOptions: [], retiredAt: null,
});
const render = (profileId: string) =>
  renderToStaticMarkup(createElement(MachineFirstSetupPanel, { scope: SCOPE, devices: [device(profileId)], initialDeviceId: "d1", catalogue: MACHINE_CATALOGUE }));
const v3 = (id: string) => MACHINE_CATALOGUE.find((p) => p.profileId === id && p.version === 3)!;

describe("uncertain modes are shown as unsupported, with the reason, and cannot be charted", () => {
  it("Junior: Thermolysis and OmniBlend are listed unsupported with the profile's own reason", () => {
    const u = unsupportedModes(v3("dectro-apilus:junior-3g"));
    expect(u.map((x) => x.key).sort()).toEqual(["omniblend", "thermolysis"]);
    expect(u.find((x) => x.key === "omniblend")!.reason).toContain("p20");
    expect(u.find((x) => x.key === "thermolysis")!.reason.length).toBeGreaterThan(10);
  });
  it("Senior has no unsupported mode in the first slice", () => {
    expect(unsupportedModes(v3("dectro-apilus:senior-3g"))).toEqual([]);
  });
  it("the Junior panel renders them under 'Not supported yet', outside the mode picker", () => {
    const html = render("dectro-apilus:junior-3g");
    expect(html).toContain("machine-unsupported-modes");
    expect(html).toContain("Not supported yet");
    expect(html).toContain('data-testid="machine-unsupported-thermolysis"');
    expect(html).toContain('data-testid="machine-unsupported-omniblend"');
    expect(html).toContain("unsupported, not capturable");
    expect(html).not.toContain('data-testid="machine-mode-thermolysis"');
    expect(html).not.toContain('data-testid="machine-mode-omniblend"');
    for (const key of ["flash", "blend", "electrolysis"]) expect(html).toContain(`data-testid="machine-mode-${key}"`);
  });
  it("the Senior panel shows no unsupported section", () => {
    expect(render("dectro-apilus:senior-3g")).not.toContain("machine-unsupported-modes");
  });
});
