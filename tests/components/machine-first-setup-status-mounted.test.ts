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

const reading = (field: string, n: number, revision = 1, groupKey = "g1") => ({
  blockId: "block-synthetic",
  captureId: `capture-${groupKey}-${revision}`,
  revision,
  deviceId: "room-9",
  profileId: "fixture:mounted",
  profileVersion: 1,
  modeKey: "galvanic",
  groupKey,
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
    expect(s.readings).toContain("2 settings saved to this block's machine record");
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

  it("a REVISED group is not double counted: three fields revised once is 3 settings, not 6", () => {
    const rows = [
      reading("current", 100, 1), reading("duration", 1, 1), reading("rate", 5, 1),
      reading("current", 110, 2), reading("duration", 2, 2), reading("rate", 6, 2),
    ];
    const s = mount({ initialDeviceId: "room-9", savedDeviceId: "room-9", savedModeKey: "galvanic", recordedSetup: rows });
    expect(s.readings).toContain("3 settings saved");
    expect(s.readings).toContain("(earlier versions kept)");
    expect(s.readings).not.toContain("6");
  });

  it("an ABSENCE-only row is not a setting: only the values count, and absence alone reads none yet", () => {
    const absent = (field: string, revision = 1) => ({ ...reading(field, 0, revision), value: { kind: "absent", reason: "not-shown" } });
    const mixed = mount({
      initialDeviceId: "room-9", savedDeviceId: "room-9", savedModeKey: "galvanic",
      recordedSetup: [reading("current", 120), absent("duration")],
    });
    expect(mixed.readings).toContain("1 setting saved");
    act(() => root?.unmount());
    host?.remove();
    const only = mount({
      initialDeviceId: "room-9", savedDeviceId: "room-9", savedModeKey: "galvanic",
      recordedSetup: [absent("current"), absent("duration")],
    });
    expect(only.readings).toContain("no values yet");
    expect(only.readings).not.toContain("none yet");
  });

  describe("after a save in THIS visit the list is the old snapshot until the host refreshes it", () => {
    async function savedThen(extra: Record<string, unknown>, before: unknown[]) {
      host = document.createElement("div");
      document.body.appendChild(host);
      root = createRoot(host);
      const onRecord = async () => ({ ok: true as const, written: 3 });
      const render = (more: Record<string, unknown>) =>
        act(() =>
          root!.render(
            withRegistry(
              newViewRef(),
              createElement(MachineFirstSetupPanel, {
                devices: [DEVICE], scope: SCOPE, catalogue: [PROFILE],
                initialModeKey: "galvanic", initialDeviceId: "room-9", savedDeviceId: "room-9", savedModeKey: "galvanic",
                blockId: "block-synthetic", onRecord, recordedSetup: before, ...extra, ...more,
              } as never),
            ),
          ),
        );
      render({});
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      for (const [id, v] of [["reading-current", "120"], ["reading-duration", "1.5"]] as const) {
        const input = host.querySelector<HTMLInputElement>(`[data-testid="${id}"]`)!;
        act(() => { set.call(input, v); input.dispatchEvent(new Event("input", { bubbles: true })); });
      }
      await act(async () => { host!.querySelector<HTMLButtonElement>('[data-testid="machine-reading-save"]')!.click(); });
      return { render, text: () => host!.querySelector('[data-testid="machine-first-status-readings"]')!.textContent ?? "" };
    }
    const earlier = () => [reading("current", 1, 1, "g0"), reading("duration", 1, 1, "g0")];

    it("the list has NOT refreshed: no number at all", async () => {
      const { text } = await savedThen({}, earlier());
      expect(text()).toContain("saved this visit. The count will update when the list refreshes");
      expect(text()).not.toMatch(/\d settings? saved/);
      expect(text()).not.toContain("at least");
    });

    it("the SAME array handed back again is still not a refresh", async () => {
      const list = earlier();
      const { render, text } = await savedThen({}, list);
      render({ recordedSetup: list });
      expect(text()).toContain("saved this visit. The count will update");
      expect(text()).not.toMatch(/\d/);
    });

    it("the refresh LANDS (a new list): exact again", async () => {
      const { render, text } = await savedThen({}, earlier());
      render({ recordedSetup: [...earlier(), reading("current", 120, 1, "g1"), reading("duration", 1.5, 1, "g1")] });
      expect(text()).toContain("4 settings saved");
      expect(text()).not.toContain("at least");
    });

    it("the post-save refresh FAILED (submissionBlocked): still no number", async () => {
      const { render, text } = await savedThen({}, earlier());
      render({ recordedSetup: [...earlier()], submissionBlocked: true });
      expect(text()).toContain("saved this visit. The count will update");
      expect(text()).not.toMatch(/\d/);
    });

    it("an empty list that has not refreshed says it saved, not none", async () => {
      const { text } = await savedThen({}, []);
      expect(text()).toContain("saved this visit. The count will update");
      expect(text()).not.toContain("none yet");
    });

    it("a revision with FEWER fields than the one before: the old count is not shown as if it were a floor", async () => {
      const before = [reading("current", 1, 1, "g0"), reading("duration", 1, 1, "g0"), reading("rate", 1, 1, "g0")];
      const { text } = await savedThen({}, before);
      expect(text()).not.toMatch(/\d/);
      expect(text()).toContain("saved this visit");
    });

    it("the list became unreadable after the save: saved this visit, no count claimed", async () => {
      const { render, text } = await savedThen({}, earlier());
      render({ recordedSetupUnavailable: true });
      expect(text()).toContain("saved this visit");
      expect(text()).not.toMatch(/\d settings? saved/);
    });
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
