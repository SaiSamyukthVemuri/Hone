// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MachineProfile } from "@/lib/machines/profile-contract";
import type { StudioDevice } from "@/lib/machines/selection";

// HON-8 ONE MACHINE SELECTOR, mounted: the existing workflow as an option in THE selector, the kind reported to the host,
// a machine the panel resolves on its own carried to a new area's Save, and a saved area's pick written as its record.
//
// The sibling suites render with react-dom/server, which never runs effects, so
// "the hold dies with the entry that owned it" was guarded only by a source
// regex (machine-setting-draft.test.ts). This mounts the real component in
// jsdom (this file only; every other suite stays on the node environment) and
// watches what the host is told and what the controls do. Synthetic records.

const { createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { MachineFirstSetupPanel } = await import("@/components/machines/machine-first-setup-panel");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PROFILE: MachineProfile = {
  profileId: "fixture:mounted",
  version: 1,
  family: "Synthetic/Demo",
  manufacturer: "Fixture",
  model: "Mounted",
  availability: "active",
  verification: "device-confirmed",
  frequency: { kind: "not-applicable" },
  evidence: [{ id: "p", kind: "studio-device-photo", consultedOn: "2026-10-12", establishes: "A synthetic unit." }],
  openQuestions: [],
  channels: { count: 1, nativeLabel: "Channel", associationRequired: false, supportsDistinctSettingGroups: false, verification: "device-confirmed", evidence: ["p"] },
  modes: [
    {
      key: "galvanic",
      nativeLabel: "Galvanic",
      family: "galvanic",
      availability: "active",
      verification: "device-confirmed",
      evidence: ["p"],
      stages: [],
      fields: [
        { key: "current", nativeLabel: "Current", quantity: "current", unit: "µA", decimals: 0, optional: false, expectedSource: "practitioner-entered", editable: true, verification: "device-confirmed", evidence: ["p"] },
        { key: "duration", nativeLabel: "Time", quantity: "duration", unit: "s", decimals: 1, optional: false, expectedSource: "practitioner-entered", editable: true, verification: "device-confirmed", evidence: ["p"] },
      ],
    },
  ],
};

const DEVICE: StudioDevice = {
  deviceId: "room-9",
  studioId: "studio-synthetic",
  profileId: "fixture:mounted",
  profileVersion: 1,
  displayName: "Room 9 unit",
  installedOptions: [],
  retiredAt: null,
};
const SCOPE = { studioId: "studio-synthetic", practitionerId: "pract-synthetic" };


let host: HTMLElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  host = root = null;
});

const LEGACY = { profileId: "dectro-apilus:xcell", label: "Dectro xCell" };

function mount(extra: Record<string, unknown>) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      createElement(MachineFirstSetupPanel, {
        devices: [DEVICE],
        scope: SCOPE,
        catalogue: [PROFILE],
        legacyMachine: LEGACY,
        ...extra,
      } as never),
    ),
  );
}

function pick(value: string) {
  const sel = host!.querySelector<HTMLSelectElement>('[data-testid="machine-select"]')!;
  const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
  act(() => {
    set.call(sel, value);
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("one selector for the units and the existing workflow", () => {
  it("lists the unit and the existing workflow in the SAME select", () => {
    mount({});
    const sel = host!.querySelector<HTMLSelectElement>('[data-testid="machine-select"]')!;
    const values = [...sel.options].map((o) => o.value);
    expect(values).toContain("room-9");
    expect(values).toContain("legacy:xcell");
    expect(host!.querySelectorAll("select").length).toBe(1);
  });

  it("no existing-workflow history means no such option", () => {
    mount({ legacyMachine: null });
    const sel = host!.querySelector<HTMLSelectElement>('[data-testid="machine-select"]')!;
    expect([...sel.options].map((o) => o.value)).not.toContain("legacy:xcell");
  });

  it("reports the kind in force: native for a unit with a mode, legacy for the existing workflow, none for nothing", () => {
    const kinds: string[] = [];
    mount({ onKindChange: (k: string) => kinds.push(k), initialDeviceId: "room-9", initialModeKey: "galvanic" });
    expect(kinds.at(-1)).toBe("native");
    pick("legacy:xcell");
    expect(kinds.at(-1)).toBe("legacy");
    expect(host!.querySelector('[data-testid="machine-chosen"]')).toBeNull();
    pick("");
    expect(kinds.at(-1)).toBe("none");
  });

  it("choosing the existing workflow asks the host to save THAT, with no unit and no mode", () => {
    const onSelectMachine = vi.fn(async () => ({ ok: true }));
    mount({ onSelectMachine });
    pick("legacy:xcell");
    expect(onSelectMachine).toHaveBeenCalledWith({ deviceId: null, modeKey: null, legacy: true });
  });

  it("opens on the existing workflow when the area was saved as it", () => {
    const kinds: string[] = [];
    mount({ initialLegacyChosen: true, onKindChange: (k: string) => kinds.push(k) });
    expect(kinds.at(-1)).toBe("legacy");
    const sel = host!.querySelector<HTMLSelectElement>('[data-testid="machine-select"]')!;
    expect(sel.value).toBe("legacy:xcell");
  });

  it("a machine resolved on its own is reported to the host, so what is shown is what Save records", () => {
    const seen: unknown[] = [];
    mount({ initialDeviceId: "room-9", initialModeKey: "galvanic", blockId: null, onResolvedChoice: (c: unknown) => seen.push(c) });
    expect(seen.at(-1)).toEqual({ deviceId: "room-9", modeKey: "galvanic" });
  });

  it("Change machine is one control that moves focus to the one selector", () => {
    mount({ initialDeviceId: "room-9", initialModeKey: "galvanic" });
    const btn = host!.querySelector<HTMLButtonElement>('[data-testid="machine-change"]');
    expect(btn).not.toBeNull();
    act(() => btn!.click());
    expect(document.activeElement).toBe(host!.querySelector('[data-testid="machine-select"]'));
  });
});

// Codex #1369 4485874041: the kind comes from the SAVED identity, not from selectability.
describe("a saved area whose native unit is no longer selectable is still a native area", () => {
  const RETIRED = { ...DEVICE, retiredAt: "2026-10-01T00:00:00Z" };

  it("reports native (so the host keeps the legacy fields hidden) and shows the unit read-only as the saved machine", () => {
    const kinds: string[] = [];
    mount({ devices: [RETIRED], blockId: "b1", savedDeviceId: "room-9", initialDeviceId: "room-9", initialModeKey: "galvanic", legacyMachine: null, unitNames: { "room-9": "Room 9 unit" }, onKindChange: (k: string) => kinds.push(k) });
    expect(kinds.at(-1)).toBe("native");
    const note = host!.querySelector('[data-testid="machine-saved-unavailable"]');
    expect(note?.textContent).toContain("Room 9 unit");
    const sel = host!.querySelector<HTMLSelectElement>('[data-testid="machine-select"]')!;
    const saved = [...sel.options].find((o) => o.value === "room-9")!;
    expect(saved.disabled).toBe(true);
    expect(sel.value).toBe("room-9");
  });

  it("NEGATIVE CONTROL (Insurance W-1): an identity-less SAVED legacy area with a retired REMEMBERED unit keeps its legacy form: kind none, no unavailable note", () => {
    const kinds: string[] = [];
    // A pre-0301 saved area: blockId set, NO saved unit on its record, while the practitioner's remembered preference names a retired unit.
    mount({ devices: [RETIRED], blockId: "b1", savedDeviceId: null, initialDeviceId: "room-9", initialModeKey: "galvanic", legacyMachine: null, onKindChange: (k: string) => kinds.push(k) });
    expect(kinds.at(-1), "no saved native unit, so the host keeps the existing fields").toBe("none");
    expect(host!.querySelector('[data-testid="machine-saved-unavailable"]')).toBeNull();
  });

  it("NEGATIVE CONTROL: a NEW area with an unavailable remembered unit is not a saved native area (reports none)", () => {
    const kinds: string[] = [];
    mount({ devices: [RETIRED], blockId: null, initialDeviceId: "room-9", initialModeKey: "galvanic", legacyMachine: null, onKindChange: (k: string) => kinds.push(k) });
    expect(kinds.at(-1)).toBe("none");
    expect(host!.querySelector('[data-testid="machine-saved-unavailable"]')).toBeNull();
  });

  it("NEGATIVE CONTROL: an area saved as the existing workflow still reports legacy", () => {
    const kinds: string[] = [];
    mount({ devices: [RETIRED], blockId: "b1", initialLegacyChosen: true, onKindChange: (k: string) => kinds.push(k) });
    expect(kinds.at(-1)).toBe("legacy");
    expect(host!.querySelector('[data-testid="machine-saved-unavailable"]')).toBeNull();
  });

  it("NEGATIVE CONTROL: a saved area whose unit IS selectable shows no unavailable note", () => {
    mount({ blockId: "b1", initialDeviceId: "room-9", initialModeKey: "galvanic" });
    expect(host!.querySelector('[data-testid="machine-saved-unavailable"]')).toBeNull();
  });
});
