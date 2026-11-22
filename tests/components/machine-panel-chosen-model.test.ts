// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { MACHINE_CATALOGUE } from "@/lib/machines/catalogue";
import type { StudioDevice } from "@/lib/machines/selection";

const { createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { MachineFirstSetupPanel } = await import("@/components/machines/machine-first-setup-panel");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SCOPE = { studioId: "studio-synthetic", practitionerId: "pract-synthetic" };
const RETIRED: StudioDevice = {
  deviceId: "unit-9", studioId: "studio-synthetic", profileId: "dectro-apilus:xcell-pur", profileVersion: 1,
  displayName: "Room 9 unit", installedOptions: [], retiredAt: "2026-01-01T00:00:00.000Z",
};
let host: HTMLElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;
afterEach(() => { act(() => root?.unmount()); host?.remove(); host = root = null; });

function report(extra: Record<string, unknown>) {
  const spy = vi.fn();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(createElement(MachineFirstSetupPanel, {
    devices: [RETIRED], scope: SCOPE, catalogue: MACHINE_CATALOGUE, unitNames: { "unit-9": "Room 9 unit" }, onChosenModel: spy, ...extra,
  } as never)));
  return spy.mock.calls.map((c) => c[0] as string | null);
}

describe("the panel's reported machine for a retired unit", () => {
  it("a SAVED block (blockId present) reports the retired unit by name, as no longer available", () => {
    const calls = report({ blockId: "b1", savedDeviceId: "unit-9", savedModeKey: "multiplex" });
    expect(calls.at(-1)).toBe("Room 9 unit (no longer available)");
  });
  it("a NEW block (no blockId) never reads as no longer available, even if a saved id reaches the panel", () => {
    const calls = report({ blockId: null, savedDeviceId: "unit-9" });
    expect(calls.every((c) => c === null)).toBe(true);
  });
  it("a new block whose remembered unit is retired reports no machine", () => {
    const calls = report({ blockId: null, initialDeviceId: "unit-9" });
    expect(calls.every((c) => c === null || !/no longer available/.test(c))).toBe(true);
  });
});
