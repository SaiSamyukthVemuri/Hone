// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { MACHINE_CATALOGUE } from "@/lib/machines/catalogue";
import type { StudioDevice } from "@/lib/machines/selection";

// HON-71, mounted: ONE xCell choice. The xCell Pur unit is reached through the xCell entry's mode and is never a second selectable
// "xCell Pur" in the charting selector; the existing xCell settings stay the default; MultiPlex is the added mode.

const { createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { MachineFirstSetupPanel } = await import("@/components/machines/machine-first-setup-panel");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const UNIT: StudioDevice = {
  deviceId: "unit-1", studioId: "studio-synthetic", profileId: "dectro-apilus:xcell-pur", profileVersion: 1,
  displayName: "Dectro xCell", installedOptions: [], retiredAt: null,
};
const SCOPE = { studioId: "studio-synthetic", practitionerId: "pract-synthetic" };
const LEGACY = { profileId: "dectro-apilus:xcell", label: "Dectro xCell" };
const ROUTE = { deviceId: "unit-1", modeKey: "multiplex" };

let host: HTMLElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;
afterEach(() => { act(() => root?.unmount()); host?.remove(); host = root = null; });

function mount(extra: Record<string, unknown> = {}) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(createElement(MachineFirstSetupPanel, {
    devices: [UNIT], scope: SCOPE, catalogue: MACHINE_CATALOGUE, legacyMachine: LEGACY, multiplexRoute: ROUTE, ...extra,
  } as never)));
}
const set = (el: HTMLSelectElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
  act(() => { setter.call(el, value); el.dispatchEvent(new Event("change", { bubbles: true })); });
};
const visibleOutsideProvenance = () => {
  const clone = host!.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('[data-testid="profile-provenance"] p:not(:first-child)').forEach((n) => n.remove());
  return clone.textContent ?? "";
};
const machineSelect = () => host!.querySelector<HTMLSelectElement>('[data-testid="machine-select"]')!;
const modeSelect = () => host!.querySelector<HTMLSelectElement>('[data-testid="xcell-mode-select"]');

describe("the charting selector offers ONE xCell", () => {
  it("lists the existing xCell once and never the Pur unit as a second choice", () => {
    mount();
    const labels = [...machineSelect().options].map((o) => o.textContent ?? "");
    expect(labels.filter((l) => /xcell/i.test(l))).toEqual(["Dectro xCell"]);
    expect([...machineSelect().options].map((o) => o.value)).not.toContain("unit-1");
    expect(visibleOutsideProvenance()).not.toMatch(/xCell Pur/i);
  });
  it("without a route nothing changes: the unit is just a unit and there is no mode switch", () => {
    mount({ multiplexRoute: null });
    expect(modeSelect()).toBeNull();
    expect([...machineSelect().options].map((o) => o.value)).toContain("unit-1");
  });
});

describe("MultiPlex is added alongside the existing xCell settings", () => {
  it("no machine chosen: no xCell mode control and no machine settings", () => {
    mount();
    expect(modeSelect()).toBeNull();
  });
  it("choosing xCell opens the existing settings, with MultiPlex offered as the added mode", () => {
    const kinds: string[] = [];
    mount({ onKindChange: (k: string) => kinds.push(k) });
    set(machineSelect(), "legacy:xcell");
    expect(kinds.at(-1)).toBe("legacy");
    expect(modeSelect()!.value).toBe("existing");
    expect([...modeSelect()!.options].map((o) => o.textContent)).toEqual(["Existing xCell settings", "MultiPlex"]);
  });
  it("choosing MultiPlex selects the routed unit with the multiplex mode (native), and the selector still reads xCell", async () => {
    const seen: unknown[] = []; const kinds: string[] = [];
    const onSelectMachine = vi.fn(async () => ({ ok: true }));
    mount({ onSelectMachine, onResolvedChoice: (c: unknown) => seen.push(c), onKindChange: (k: string) => kinds.push(k) });
    set(machineSelect(), "legacy:xcell");
    set(modeSelect()!, "multiplex");
    await act(async () => { await Promise.resolve(); });
    expect(onSelectMachine).toHaveBeenLastCalledWith(expect.objectContaining({ deviceId: "unit-1" }));
    expect(seen.at(-1)).toEqual({ deviceId: "unit-1", modeKey: "multiplex" });
    expect(kinds.at(-1)).toBe("native");
    expect(machineSelect().value).toBe("legacy:xcell");
    expect(modeSelect()!.value).toBe("multiplex");
    expect(visibleOutsideProvenance()).not.toMatch(/xCell Pur/i);
    // The ONE place the Pur name may appear: the provenance block's citation of the manufacturer's own product page (its title).
    // Its heading line still names the studio's xCell.
    expect(host!.querySelector('[data-testid="profile-provenance"] p')?.textContent).toMatch(/^Dectro xCell ·/);
  });
  it("going back to the existing settings returns to the existing workflow with no unit and no mode", async () => {
    const seen: unknown[] = []; const kinds: string[] = [];
    mount({ onSelectMachine: vi.fn(async () => ({ ok: true })), onResolvedChoice: (c: unknown) => seen.push(c), onKindChange: (k: string) => kinds.push(k) });
    set(machineSelect(), "legacy:xcell");
    set(modeSelect()!, "multiplex");
    await act(async () => { await Promise.resolve(); });
    set(modeSelect()!, "existing");
    await act(async () => { await Promise.resolve(); });
    expect(kinds.at(-1)).toBe("legacy");
    expect(seen.at(-1)).toEqual({ deviceId: null, modeKey: null, legacy: true });
  });
  it("a SAVED area keeps the identity it was saved with: the mode control is read-only", () => {
    mount({ blockId: "b1", initialLegacyChosen: true });
    expect(modeSelect()!.disabled).toBe(true);
  });
});

describe("Settings > Machines shows no second xCell", () => {
  it("the register list (built exactly as the page builds it, every row published) offers no xCell Pur", async () => {
    const { activeProfiles } = await import("@/lib/machines/profile-contract");
    const { listableProfiles } = await import("@/lib/machines/listable-profiles");
    const { machineModelLabel, registrableProfiles } = await import("@/lib/machines/display-name");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { MachineRegisterForm } = await import("@/components/machines/machine-register-form");
    const published = (p: { modes: { key: string; availability: string }[] }) => p.modes.filter((m) => m.availability === "active").map((m) => m.key);
    const listable = listableProfiles(activeProfiles(MACHINE_CATALOGUE), published as never);
    // The Pur IS listable by the generic rule (active, published): only the one-xCell rule removes it.
    expect(listable.map((p) => p.profileId)).toContain("dectro-apilus:xcell-pur");
    const models = registrableProfiles(listable).map((p) => ({ profileId: p.profileId, label: machineModelLabel(p) }));
    const html = renderToStaticMarkup(createElement(MachineRegisterForm, { models, register: async () => ({ ok: true }) } as never));
    expect(models.map((m) => m.profileId)).not.toContain("dectro-apilus:xcell-pur");
    expect(html).not.toMatch(/xCell Pur/i);
  });
  it("a registered unit is listed by its own name, which the publication step sets to the studio's xCell", async () => {
    const { readFileSync } = await import("node:fs");
    const page = readFileSync("app/(app)/settings/machines/page.tsx", "utf8");
    expect(page).toContain("<li key={m.deviceId}>{m.displayName}</li>");
    expect(page).not.toMatch(/xCell Pur/i);
  });
});
