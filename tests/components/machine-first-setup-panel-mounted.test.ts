// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MachineProfile } from "@/lib/machines/profile-contract";
import type { StudioDevice } from "@/lib/machines/selection";

// A MOUNTED test of the panel's transport-hold release (Codex #1205 4400713832).
//
// The sibling suites render with react-dom/server, which never runs effects, so
// "the hold dies with the entry that owned it" was guarded only by a source
// regex (machine-setting-draft.test.ts). This mounts the real component in
// jsdom (this file only; every other suite stays on the node environment) and
// watches what the host is told and what the controls do. Synthetic records.

const { createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { newViewRef, withRegistry } = await import("./helpers/draft-registry-probe");
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

function props(extra: Record<string, unknown>) {
  return {
    devices: [DEVICE],
    scope: SCOPE,
    catalogue: [PROFILE],
    initialDeviceId: "room-9",
    initialModeKey: "galvanic",
    blockId: "block-synthetic",
    ...extra,
  };
}

function fill(testId: string, value: string) {
  const input = host!.querySelector<HTMLInputElement>(`[data-testid="${testId}"]`);
  expect(input, `input ${testId} is mounted`).not.toBeNull();
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    set.call(input, value);
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** Mount, enter a reading, press Save, and leave the save UNANSWERED. */
function mountWithSaveInFlight(viewRef: ReturnType<typeof newViewRef>) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const onRecord = vi.fn(() => new Promise<never>(() => {}));
  const render = (extra: Record<string, unknown>) =>
    act(() => root!.render(withRegistry(viewRef, createElement(MachineFirstSetupPanel, props({ onRecord, ...extra }) as never))));
  render({});
  fill("reading-current", "120");
  fill("reading-duration", "1.5");
  const save = host.querySelector<HTMLButtonElement>('[data-testid="machine-reading-save"]');
  expect(save, "the revision entry is mounted").not.toBeNull();
  act(() => save!.click());
  return { onRecord, render };
}

describe("the revision save hold, mounted", () => {
  it("control: an unanswered save HOLDS, tells the host, and freezes the machine picker", () => {
    const view = newViewRef();
    const { onRecord } = mountWithSaveInFlight(view);
    expect(onRecord, "the save reached the recorder").toHaveBeenCalledTimes(1);
    expect(view.current.anyUnresolved, "the host sees the save is unresolved").toBe(true);
    const picker = host!.querySelector<HTMLSelectElement>('[data-testid="machine-select"]');
    expect(picker, "the machine picker is mounted").not.toBeNull();
    expect(picker!.disabled, "the identity control is frozen while the hold stands").toBe(true);
  });

  it("the hold is RELEASED when the record becomes unavailable and the entry unmounts", () => {
    const view = newViewRef();
    const { render } = mountWithSaveInFlight(view);
    expect(view.current.anyUnresolved).toBe(true);
    render({ recordedSetupUnavailable: true });
    expect(host!.querySelector('[data-testid="machine-reading-entry"]'), "the entry is gone").toBeNull();
    expect(view.current.anyUnresolved, "the hold is released with the entry").toBe(false);
    expect(host!.querySelector<HTMLSelectElement>('[data-testid="machine-select"]')!.disabled, "the picker is live again").toBe(false);
  });
});

describe("a stored mode the unit does not offer is never re-sent, mounted (#1369 E-2)", () => {
  it("shows the unresolved state, mounts no entry form, reports NO resolved choice, and writes nothing", () => {
    const onRecord = vi.fn(async () => ({ ok: true }));
    const onSelectMachine = vi.fn(async () => ({ ok: true }));
    const onResolvedChoice = vi.fn();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(createElement(MachineFirstSetupPanel, props({ initialModeKey: "not-offered", onRecord, onSelectMachine, onResolvedChoice }) as never)));
    expect(host.querySelector('[data-testid="machine-mode-unresolved"]'), "the unresolved state is shown").not.toBeNull();
    expect(host.querySelector('[data-testid="machine-reading-entry"]'), "no entry form for a mode that is not offered").toBeNull();
    expect(onResolvedChoice, "the host is told there is no resolved choice").toHaveBeenLastCalledWith(null);
    expect(onSelectMachine, "mounting writes no identity").not.toHaveBeenCalled();
    expect(onRecord, "mounting records nothing").not.toHaveBeenCalled();
    for (const call of onResolvedChoice.mock.calls) expect(JSON.stringify(call)).not.toContain("not-offered");
  });

  // Insurance PEER-1369-UI-MODE-UNRESOLVED F1: the notice says "choose a mode", so on a single-mode unit a picker must exist.
  it("F1: a single-mode unit with an unoffered stored key renders the picker, with nothing pressed, and choosing the offered mode resolves it", async () => {
    const onRecord = vi.fn(async () => ({ ok: true }));
    const onSelectMachine = vi.fn(async () => ({ ok: true }));
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(createElement(MachineFirstSetupPanel, props({ initialModeKey: "not-offered", onRecord, onSelectMachine }) as never)));
    const button = host.querySelector<HTMLButtonElement>('[data-testid="machine-mode-galvanic"]');
    expect(host.querySelector('[data-testid="machine-mode-picker"]'), "the picker is rendered while the mode is unresolved").not.toBeNull();
    expect(button, "the offered mode is a button").not.toBeNull();
    expect(button!.getAttribute("aria-pressed"), "no mode is shown as chosen").toBe("false");
    expect(host.querySelector('[data-testid="machine-reading-entry"]'), "still no entry form").toBeNull();
    await act(async () => {
      button!.click();
    });
    expect(host.querySelector('[data-testid="machine-mode-unresolved"]'), "choosing the mode resolves the state").toBeNull();
    expect(host.querySelector('[data-testid="machine-reading-entry"]'), "the entry form mounts for the chosen mode").not.toBeNull();
  });

  // F2: an empty-string key is set and not offered; truthiness used to let it fall back to the first mode.
  it("F2: an empty-string stored key is unresolved, not the first mode", () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(createElement(MachineFirstSetupPanel, props({ initialModeKey: "" }) as never)));
    expect(host.querySelector('[data-testid="machine-mode-unresolved"]'), "the unresolved state is shown").not.toBeNull();
    expect(host.querySelector('[data-testid="machine-reading-entry"]'), "no entry form is mounted for the first mode").toBeNull();
  });
});

describe("the host save and the reading save never overlap, mounted (#1369 Codex 4505116958)", () => {
  it("readings typed while the host save is pending: Save is disabled, nothing is sent, and the typed readings are kept and usable afterwards", () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    const onRecord = vi.fn(() => new Promise<never>(() => {}));
    const render = (extra: Record<string, unknown>) =>
      act(() => root!.render(createElement(MachineFirstSetupPanel, props({ onRecord, ...extra }) as never)));
    render({ settingDraftFrozen: true });
    fill("reading-current", "120");
    fill("reading-duration", "1.5");
    const save = () => host!.querySelector<HTMLButtonElement>('[data-testid="machine-reading-save"]')!;
    expect(save().disabled, "Save these settings is held while the host save is pending").toBe(true);
    act(() => save().click());
    expect(onRecord, "a held save sends nothing").not.toHaveBeenCalled();
    render({ settingDraftFrozen: false });
    expect(host!.querySelector<HTMLInputElement>('[data-testid="reading-current"]')!.value, "the typed reading was not discarded").toBe("120");
    expect(host!.querySelector<HTMLInputElement>('[data-testid="reading-duration"]')!.value).toBe("1.5");
    expect(save().disabled, "the hold lifts when the host save settles").toBe(false);
    act(() => save().click());
    expect(onRecord, "after the hold lifts the save goes out once").toHaveBeenCalledTimes(1);
  });
});
