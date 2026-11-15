// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import type { MachineProfile } from "@/lib/machines/profile-contract";
import type { StudioDevice } from "@/lib/machines/selection";

// The panel's status block says two separate things (Privacy record-accuracy note on #1369): whether the BLOCK holds a saved machine
// and mode, and how many readings are saved for the BLOCK. It used to say "Recorded: nothing from this panel yet" whenever THIS VISIT's
// save count was 0, which was wrong after a machine is chosen (the block saves the identity) and on reopen beside the saved list.
// Mounted in jsdom; synthetic records only.

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

const reading = (field: string, n: number) => ({
  blockId: "block-synthetic",
  captureId: "capture-1",
  revision: 1,
  deviceId: "room-9",
  profileId: "fixture:mounted",
  profileVersion: 1,
  modeKey: "galvanic",
  groupKey: "g1",
  channels: [1],
  stageKey: null,
  fieldKey: field,
  value: { kind: "value", value: n },
  nativeUnit: "µA",
  decimals: 0,
  observationSource: "practitioner-entered",
  recordedAt: "2026-11-15T10:00:00.000Z",
});

function mount(extra: Record<string, unknown>) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const view = newViewRef();
  act(() =>
    root!.render(
      withRegistry(
        view,
        createElement(MachineFirstSetupPanel, {
          devices: [DEVICE],
          scope: SCOPE,
          catalogue: [PROFILE],
          initialModeKey: "galvanic",
          blockId: "block-synthetic",
          ...extra,
        } as never),
      ),
    ),
  );
  const text = (id: string) => host!.querySelector(`[data-testid="${id}"]`)?.textContent ?? null;
  return {
    identity: text("machine-first-status-identity"),
    readings: text("machine-first-status-readings"),
    all: host.querySelector('[data-testid="machine-first-status"]')?.textContent ?? "",
  };
}

describe("the status block says the machine and the readings separately", () => {
  it("a saved machine and mode, no readings: the identity is saved, the readings are none yet", () => {
    const s = mount({ initialDeviceId: "room-9", savedDeviceId: "room-9", savedModeKey: "galvanic" });
    expect(s.identity).toBe("Machine:saved to this block. Mode: saved.");
    expect(s.readings).toContain("Readings from this panel:none yet");
    expect(s.all).not.toContain("nothing from this panel");
  });

  it("reopened beside saved readings: the count is the BLOCK's, with no readings saved this visit", () => {
    const s = mount({
      initialDeviceId: "room-9",
      savedDeviceId: "room-9",
      savedModeKey: "galvanic",
      recordedSetup: [reading("current", 120), reading("duration", 2)],
    });
    expect(s.identity).toBe("Machine:saved to this block. Mode: saved.");
    expect(s.readings).toContain("2 saved to this block's machine record");
    expect(s.readings).not.toContain("none yet");
  });

  it("a unit saved WITHOUT a mode claims the machine only, never the mode", () => {
    for (const savedModeKey of [null, ""]) {
      const s = mount({ initialDeviceId: "room-9", savedDeviceId: "room-9", savedModeKey });
      expect(s.identity).toBe("Machine:saved to this block.");
      expect(s.all).not.toContain("Mode: saved");
      act(() => root?.unmount());
      host?.remove();
    }
  });

  it("when the list could not be read but this visit saved readings, the count is a floor: at least N", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    const onRecord = async () => ({ ok: true as const, written: 2 });
    const render = (extra: Record<string, unknown>) =>
      act(() =>
        root!.render(
          withRegistry(
            newViewRef(),
            createElement(MachineFirstSetupPanel, {
              devices: [DEVICE],
              scope: SCOPE,
              catalogue: [PROFILE],
              initialModeKey: "galvanic",
              initialDeviceId: "room-9",
              savedDeviceId: "room-9",
              savedModeKey: "galvanic",
              blockId: "block-synthetic",
              onRecord,
              ...extra,
            } as never),
          ),
        ),
      );
    render({});
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    for (const [id, v] of [["reading-current", "120"], ["reading-duration", "1.5"]] as const) {
      const input = host.querySelector<HTMLInputElement>(`[data-testid="${id}"]`)!;
      act(() => {
        set.call(input, v);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    }
    await act(async () => {
      host!.querySelector<HTMLButtonElement>('[data-testid="machine-reading-save"]')!.click();
    });
    render({ recordedSetupUnavailable: true });
    const text = host.querySelector('[data-testid="machine-first-status-readings"]')!.textContent;
    expect(text).toContain("at least 2 saved");
    expect(text).not.toContain("none yet");
  });

  it("an area saved as the existing workflow reports its identity as saved too", () => {
    const s = mount({
      initialLegacyChosen: true,
      legacyMachine: { profileId: "dectro-apilus:xcell", label: "Dectro xCell" },
    });
    expect(s.identity).toBe("Machine:saved to this block.");
    expect(s.identity).not.toContain("Mode");
  });

  it("a NEW area (no block) states no saved identity and no readings", () => {
    const s = mount({ blockId: undefined, initialDeviceId: "room-9" });
    expect(s.identity).toBeNull();
    expect(s.readings).toContain("none yet");
  });

  it("a remembered machine on an area that never saved an identity is NOT reported as saved", () => {
    const s = mount({ initialDeviceId: "room-9", savedDeviceId: null });
    expect(s.identity).toBeNull();
  });

  it("when the recorded readings could not be read, it says so and does not claim none", () => {
    const s = mount({ initialDeviceId: "room-9", savedDeviceId: "room-9", recordedSetupUnavailable: true });
    expect(s.readings).toContain("could not be checked");
    expect(s.readings).not.toContain("none yet");
  });

  it("never prints the old combined sentence", () => {
    for (const extra of [{}, { savedDeviceId: "room-9", initialDeviceId: "room-9" }]) {
      const s = mount(extra);
      expect(s.all).not.toContain("Recorded:");
      expect(s.all).not.toContain("nothing from this panel");
      act(() => root?.unmount());
      host?.remove();
    }
  });
});
