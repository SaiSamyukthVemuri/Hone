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
function mountWithSaveInFlight(onRevisionUnresolved: (u: boolean) => void) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const onRecord = vi.fn(() => new Promise<never>(() => {}));
  const render = (extra: Record<string, unknown>) =>
    act(() => root!.render(createElement(MachineFirstSetupPanel, props({ onRecord, onRevisionUnresolved, ...extra }) as never)));
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
    const seen: boolean[] = [];
    const { onRecord } = mountWithSaveInFlight((u) => seen.push(u));
    expect(onRecord, "the save reached the recorder").toHaveBeenCalledTimes(1);
    expect(seen.at(-1), "the host was told the save is unresolved").toBe(true);
    const picker = host!.querySelector<HTMLSelectElement>('[data-testid="machine-select"]');
    expect(picker, "the machine picker is mounted").not.toBeNull();
    expect(picker!.disabled, "the identity control is frozen while the hold stands").toBe(true);
  });

  it("the hold is RELEASED when the record becomes unavailable and the entry unmounts", () => {
    const seen: boolean[] = [];
    const { render } = mountWithSaveInFlight((u) => seen.push(u));
    expect(seen.at(-1)).toBe(true);
    render({ recordedSetupUnavailable: true });
    expect(host!.querySelector('[data-testid="machine-reading-entry"]'), "the entry is gone").toBeNull();
    expect(seen.at(-1), "the host is told the hold is released").toBe(false);
    expect(host!.querySelector<HTMLSelectElement>('[data-testid="machine-select"]')!.disabled, "the picker is live again").toBe(false);
  });
});
