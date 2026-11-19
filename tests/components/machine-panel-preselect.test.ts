// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { MACHINE_CATALOGUE } from "@/lib/machines/catalogue";
import { selectableDevices, type StudioDevice } from "@/lib/machines/selection";
import { preselectOnlyChoice } from "@/lib/machines/preselect";

const { createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { MachineFirstSetupPanel } = await import("@/components/machines/machine-first-setup-panel");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SCOPE = { studioId: "studio-synthetic", practitionerId: "pract-synthetic" };
const LEGACY = { profileId: "dectro-apilus:xcell", label: "Dectro xCell" };
const unit = (id: string, profileId: string): StudioDevice => ({ deviceId: id, studioId: "studio-synthetic", profileId, profileVersion: MACHINE_CATALOGUE.find((p) => p.profileId === profileId && p.availability === "active")!.version, displayName: `Unit ${id}`, installedOptions: [], retiredAt: null });
const PUR = "dectro-apilus:xcell-pur";
const OTHER = MACHINE_CATALOGUE.find((p) => p.availability === "active" && p.profileId !== PUR && p.profileId !== LEGACY.profileId)!;

let host: HTMLElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;
afterEach(() => { act(() => root?.unmount()); host?.remove(); host = root = null; });

const DB = { kind: "database", persisted: true };
function mount(devices: StudioDevice[], legacy: boolean, route: { deviceId: string; modeKey: string } | null = null) {
  const legacyMachine = legacy ? LEGACY : null;
  const onlyChoice = preselectOnlyChoice(selectableDevices(SCOPE, devices, MACHINE_CATALOGUE), legacyMachine !== null, route !== null && legacyMachine !== null);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(createElement(MachineFirstSetupPanel, { devices, scope: SCOPE, catalogue: MACHINE_CATALOGUE, legacyMachine, multiplexRoute: route, onlyChoice, persistence: DB } as never)));
  const sel = host.querySelector<HTMLSelectElement>('[data-testid="machine-select"]');
  const options = sel ? Array.from(sel.options).filter((o) => o.value !== "") : [];
  return { onlyChoice, options, value: sel?.value ?? "" };
}

describe("the preselect counts exactly what the picker renders", () => {
  const cases: Array<[string, () => ReturnType<typeof mount>]> = [
    ["the existing xCell alone", () => mount([], true)],
    ["the existing xCell and one Pur unit", () => mount([unit("p1", PUR)], true)],
    ["the existing xCell and several Pur units", () => mount([unit("p1", PUR), unit("p2", PUR), unit("p3", PUR)], true)],
    ["the existing xCell, Pur units and a routed MultiPlex", () => mount([unit("p1", PUR), unit("p2", PUR)], true, { deviceId: "p1", modeKey: "multiplex" })],
    ["the existing xCell and another unit", () => mount([unit("o1", OTHER.profileId)], true)],
    ["one Pur unit, no existing xCell offer", () => mount([unit("p1", PUR)], false)],
    ["several units, no existing xCell offer", () => mount([unit("o1", OTHER.profileId), unit("o2", OTHER.profileId)], false)],
    ["one other unit, no existing xCell offer", () => mount([unit("o1", OTHER.profileId)], false)],
  ];
  it.each(cases)("%s", (_name, run) => {
    const { onlyChoice, options, value } = run();
    // A preselect exists exactly when the picker renders ONE entry, and it is that entry.
    expect(options.length, "control: the case renders at least one entry").toBeGreaterThan(0);
    expect(onlyChoice !== null, `rendered ${options.map((o) => o.value).join(",")}`).toBe(options.length === 1);
    if (onlyChoice) expect(value).toBe(options[0].value);
    else expect(value).toBe("");
  });
});

describe("a preselect is not a remembered choice", () => {
  it("the status says nothing is remembered yet, never 'yes'", () => {
    mount([unit("o1", OTHER.profileId)], false);
    const status = host!.querySelector('[data-testid="machine-first-status"]')!.textContent!;
    expect(status).not.toContain("yes, for you");
    expect(status).toContain("nothing yet");
  });
  it("control: an explicitly remembered unit still says yes", () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(createElement(MachineFirstSetupPanel, { devices: [unit("o1", OTHER.profileId)], scope: SCOPE, catalogue: MACHINE_CATALOGUE, initialDeviceId: "o1", persistence: { kind: "database", persisted: true } } as never)));
    expect(host.querySelector('[data-testid="machine-first-status"]')!.textContent).toContain("yes, for you");
  });
});

describe("the panel itself: a preselect never beats a remembered, restored or retired identity", () => {
  const LIVE = unit("live1", OTHER.profileId);
  const NATIVE = { kind: "native", deviceId: "live1" } as const;
  function panel(props: Record<string, unknown>, devices: StudioDevice[] = [LIVE]) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(createElement(MachineFirstSetupPanel, { devices, scope: SCOPE, catalogue: MACHINE_CATALOGUE, persistence: DB, ...props } as never)));
    const sel = host.querySelector<HTMLSelectElement>('[data-testid="machine-select"]');
    return { value: sel?.value ?? null, text: host.textContent ?? "" };
  }
  it("control: with nothing else, the native preselect applies", () => {
    expect(panel({ onlyChoice: NATIVE }).value).toBe("live1");
  });
  it("an initialDeviceId wins", () => {
    const other = unit("live2", OTHER.profileId);
    expect(panel({ onlyChoice: NATIVE, initialDeviceId: "live2" }, [LIVE, other]).value).toBe("live2");
  });
  it("a restored selection wins", () => {
    const other = unit("live2", OTHER.profileId);
    const r = panel({ onlyChoice: NATIVE, restoredSelection: { deviceId: "live2", modeKey: "x" } }, [LIVE, other]);
    expect(r.value).toBe("live2");
  });
  it("KEY CASE: a retired remembered unit plus ONE other live unit shows the unusable state and does NOT preselect the live unit", () => {
    const r = panel({ onlyChoice: NATIVE, unavailableSelection: { deviceId: "gone1", reason: "retired" }, initialDeviceId: "gone1", unitNames: { gone1: "Old unit" } });
    expect(r.value).not.toBe("live1");
    expect(r.value).toBe("");
  });
  it("control: the legacy preselect applies when nothing else chooses", () => {
    expect(panel({ onlyChoice: { kind: "legacy" }, legacyMachine: LEGACY }, []).value).toBe("legacy:xcell");
  });
  it("the same for the legacy preselect: a retired remembered unit blocks it", () => {
    const r = panel({ onlyChoice: { kind: "legacy" }, legacyMachine: LEGACY, unavailableSelection: { deviceId: "gone1", reason: "retired" }, initialDeviceId: "gone1" }, []);
    expect(r.value).not.toBe("legacy:xcell");
    expect(r.value).toBe("");
  });
  it("the legacy preselect yields to an initialDeviceId and to a restored selection", () => {
    expect(panel({ onlyChoice: { kind: "legacy" }, legacyMachine: LEGACY, initialDeviceId: "live1" }, [LIVE]).value).toBe("live1");
    expect(panel({ onlyChoice: { kind: "legacy" }, legacyMachine: LEGACY, restoredSelection: { deviceId: "live1", modeKey: "x" } }, [LIVE]).value).toBe("live1");
  });
});
