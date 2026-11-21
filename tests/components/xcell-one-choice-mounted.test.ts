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
  it("without a route there is STILL one xCell: the existing choice is offered and the unit is not listed beside it", () => {
    mount({ multiplexRoute: null });
    expect(modeSelect()).toBeNull();
    const labels = [...machineSelect().options].map((o) => o.textContent ?? "");
    expect(labels.filter((l) => /xcell/i.test(l))).toEqual(["Dectro xCell"]);
    expect([...machineSelect().options].map((o) => o.value)).not.toContain("unit-1");
  });
  it("a second xCell unit (should one ever exist) is not listed either", () => {
    mount({ devices: [UNIT, { ...UNIT, deviceId: "unit-2", displayName: "Dectro xCell 2" }] });
    expect([...machineSelect().options].map((o) => o.textContent ?? "").filter((l) => /xcell/i.test(l))).toEqual(["Dectro xCell"]);
  });
  it("a studio with the unit and no existing xCell history sees exactly one xCell: the unit", () => {
    mount({ legacyMachine: null, multiplexRoute: null });
    expect([...machineSelect().options].map((o) => o.textContent ?? "").filter((l) => /xcell/i.test(l)).length).toBe(1);
    expect([...machineSelect().options].map((o) => o.value)).toContain("unit-1");
  });
  it("other machines are listed as before beside the xCell", () => {
    const other: StudioDevice = { deviceId: "unit-3g", studioId: "studio-synthetic", profileId: "dectro-apilus:senior-3g", profileVersion: 3, displayName: "Room 2", installedOptions: [], retiredAt: null };
    mount({ devices: [UNIT, other] });
    expect([...machineSelect().options].map((o) => o.value)).toContain("unit-3g");
  });
});

describe("the panel acts on the host form's MultiPlex request (there is no second selector here)", () => {
  const rerender = (extra: Record<string, unknown>) =>
    act(() => root!.render(createElement(MachineFirstSetupPanel, { devices: [UNIT], scope: SCOPE, catalogue: MACHINE_CATALOGUE, legacyMachine: LEGACY, multiplexRoute: ROUTE, ...extra } as never)));
  it("no xCell-mode selector exists at all", () => {
    mount();
    set(machineSelect(), "legacy:xcell");
    expect(modeSelect()).toBeNull();
  });
  it("a request for MultiPlex selects the routed unit with the multiplex mode (native) while the selector still reads xCell", async () => {
    const seen: unknown[] = []; const kinds: string[] = [];
    const onSelectMachine = vi.fn(async () => ({ ok: true }));
    mount({ onSelectMachine, onResolvedChoice: (c: unknown) => seen.push(c), onKindChange: (k: string) => kinds.push(k) });
    set(machineSelect(), "legacy:xcell");
    await act(async () => { await Promise.resolve(); }); // the pick settles first: a request during a pending pick is dropped (P1)
    rerender({ onSelectMachine, onResolvedChoice: (c: unknown) => seen.push(c), onKindChange: (k: string) => kinds.push(k), multiplexRequest: { seq: 1, want: true } });
    await act(async () => { await Promise.resolve(); });
    expect(seen.at(-1)).toEqual({ deviceId: "unit-1", modeKey: "multiplex" });
    expect(kinds.at(-1)).toBe("native");
    expect(machineSelect().value).toBe("legacy:xcell");
    expect(visibleOutsideProvenance()).not.toMatch(/xCell Pur/i);
    expect(host!.querySelector('[data-testid="profile-provenance"] p')?.textContent).toMatch(/^Dectro xCell ·/);
  });
  it("the same sequence again changes nothing; a request to leave returns to the existing workflow", async () => {
    const seen: unknown[] = []; const kinds: string[] = [];
    const common = { onSelectMachine: vi.fn(async () => ({ ok: true })), onResolvedChoice: (c: unknown) => seen.push(c), onKindChange: (k: string) => kinds.push(k) };
    mount(common);
    set(machineSelect(), "legacy:xcell");
    await act(async () => { await Promise.resolve(); });
    rerender({ ...common, multiplexRequest: { seq: 1, want: true } });
    await act(async () => { await Promise.resolve(); });
    rerender({ ...common, multiplexRequest: { seq: 2, want: false } });
    await act(async () => { await Promise.resolve(); });
    expect(kinds.at(-1)).toBe("legacy");
    expect(seen.at(-1)).toEqual({ deviceId: null, modeKey: null, legacy: true });
  });
  it("THE FREEZE WINS (P1): a request made while a save is pending is dropped, and is not applied when the freeze lifts", async () => {
    const seen: unknown[] = []; const kinds: string[] = [];
    const common = { onSelectMachine: vi.fn(async () => ({ ok: true })), onResolvedChoice: (c: unknown) => seen.push(c), onKindChange: (k: string) => kinds.push(k) };
    mount({ ...common, settingDraftFrozen: true });
    set(machineSelect(), "legacy:xcell");
    rerender({ ...common, settingDraftFrozen: true, multiplexRequest: { seq: 1, want: true } });
    await act(async () => { await Promise.resolve(); });
    expect(kinds.at(-1)).toBe("legacy");
    expect(seen.some((c) => (c as { modeKey?: string } | null)?.modeKey === "multiplex")).toBe(false);
    rerender({ ...common, settingDraftFrozen: false, multiplexRequest: { seq: 1, want: true } });
    await act(async () => { await Promise.resolve(); });
    expect(kinds.at(-1), "the dropped request is not replayed").toBe("legacy");
  });
  // INSURANCE (#1603): each half of the freeze guard is pinned on its own, so removing either one fails a test.
  it("HALF 1 (selectionPending): a request made while a machine pick is still pending is dropped", async () => {
    const seen: unknown[] = []; const kinds: string[] = [];
    const common = { onSelectMachine: vi.fn(() => new Promise(() => undefined)), onResolvedChoice: (c: unknown) => seen.push(c), onKindChange: (k: string) => kinds.push(k) };
    mount(common);
    set(machineSelect(), "legacy:xcell"); // the pick never settles
    rerender({ ...common, multiplexRequest: { seq: 1, want: true } });
    await act(async () => { await Promise.resolve(); });
    expect(seen.some((c) => (c as { modeKey?: string } | null)?.modeKey === "multiplex")).toBe(false);
    expect(kinds.at(-1)).not.toBe("native");
  });
  it("HALF 2 (identityFrozen via revisionUnresolved): a request made while a save is unresolved is dropped", async () => {
    const { DraftRegistryProvider, useDraftRegistryState } = await import("@/components/machines/draft-registry");
    function UnresolvedHost({ children }: { children?: unknown }) {
      const { api } = useDraftRegistryState();
      return createElement(DraftRegistryProvider, { api, view: { anyDraft: true, anyUnresolved: true }, children } as never);
    }
    const seen: unknown[] = []; const kinds: string[] = [];
    const common = { onSelectMachine: vi.fn(async () => ({ ok: true })), onResolvedChoice: (c: unknown) => seen.push(c), onKindChange: (k: string) => kinds.push(k) };
    const render = (extra: Record<string, unknown>) =>
      act(() => root!.render(createElement(UnresolvedHost, null, createElement(MachineFirstSetupPanel, {
        devices: [UNIT], scope: SCOPE, catalogue: MACHINE_CATALOGUE, legacyMachine: LEGACY, multiplexRoute: ROUTE, ...common, ...extra,
      } as never)) as never));
    host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
    render({});
    await act(async () => { await Promise.resolve(); });
    // the machine picker is held while a save is unresolved, so reach legacy through the saved-identity prop instead of the select
    render({ initialLegacyChosen: true });
    await act(async () => { await Promise.resolve(); });
    render({ initialLegacyChosen: true, multiplexRequest: { seq: 1, want: true } });
    await act(async () => { await Promise.resolve(); });
    expect(seen.some((c) => (c as { modeKey?: string } | null)?.modeKey === "multiplex")).toBe(false);
    expect(kinds.at(-1)).not.toBe("native");
  });
  it("a SAVED area ignores a request: it keeps the identity it was saved with", async () => {
    const onSelectMachine = vi.fn(async () => ({ ok: true }));
    mount({ blockId: "b1", initialLegacyChosen: true, onSelectMachine });
    rerender({ blockId: "b1", initialLegacyChosen: true, onSelectMachine, multiplexRequest: { seq: 1, want: true } });
    await act(async () => { await Promise.resolve(); });
    expect(onSelectMachine).not.toHaveBeenCalled();
  });
});

describe("Settings > Machines shows no second xCell", () => {
  async function registerModels(publishedFor: (p: { profileId: string; modes: { key: string; availability: string }[] }) => string[], live: { profileId: string }[], allowed = true) {
    const { activeProfiles } = await import("@/lib/machines/profile-contract");
    const { listableProfiles } = await import("@/lib/machines/listable-profiles");
    const { machineModelLabel, registrableProfiles } = await import("@/lib/machines/display-name");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { MachineRegisterForm } = await import("@/components/machines/machine-register-form");
    const listable = listableProfiles(activeProfiles(MACHINE_CATALOGUE), publishedFor as never);
    const models = registrableProfiles(listable, live, allowed).map((p) => ({ profileId: p.profileId, label: machineModelLabel(p) }));
    const html = renderToStaticMarkup(createElement(MachineRegisterForm, { models, register: async () => ({ ok: true }) } as never));
    return { models, html };
  }
  const allPublished = (p: { modes: { key: string; availability: string }[] }) => p.modes.filter((m) => m.availability === "active").map((m) => m.key);
  it("PUBLISHED and none registered: the owner is offered ONE model, labelled 'Dectro xCell' (never 'xCell Pur')", async () => {
    const { models, html } = await registerModels(allPublished, []);
    expect(models.filter((m) => m.profileId === "dectro-apilus:xcell-pur").map((m) => m.label)).toEqual(["Dectro xCell"]);
    expect(html).toContain("Dectro xCell");
    expect(html).not.toMatch(/xCell Pur/i);
  });
  it("UNPUBLISHED: stays hidden", async () => {
    const { models } = await registerModels((p) => (p.profileId === "dectro-apilus:xcell-pur" ? [] : allPublished(p)), []);
    expect(models.map((m) => m.profileId)).not.toContain("dectro-apilus:xcell-pur");
    expect(models.length).toBeGreaterThan(0); // the other models are unaffected
  });
  it("a studio that already has its xCell unit is not offered a second", async () => {
    const { models } = await registerModels(allPublished, [{ profileId: "dectro-apilus:xcell-pur" }]);
    expect(models.map((m) => m.profileId)).not.toContain("dectro-apilus:xcell-pur");
  });
  it("a studio that is not on the rollout allowlist is offered no xCell even though it is published", async () => {
    const { models } = await registerModels(allPublished, [], false);
    expect(models.map((m) => m.profileId)).not.toContain("dectro-apilus:xcell-pur");
    expect(models.map((m) => m.profileId)).toContain("dectro-apilus:senior-3g");
  });
  it("existing 3G models are offered exactly as before", async () => {
    const { models } = await registerModels(allPublished, []);
    const ids = models.map((m) => m.profileId);
    expect(ids).toContain("dectro-apilus:senior-3g");
    expect(ids).toContain("dectro-apilus:junior-3g");
  });
  it("a registered unit is listed by its own name, which the publication step sets to the studio's xCell", async () => {
    const { readFileSync } = await import("node:fs");
    const page = readFileSync("app/(app)/settings/machines/page.tsx", "utf8");
    expect(page).toContain("<li key={m.deviceId}>{m.displayName}</li>");
    expect(page).not.toMatch(/xCell Pur/i);
  });
});
