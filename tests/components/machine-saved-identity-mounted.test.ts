// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

const actions = vi.hoisted(() => ({
  recordBlockMachineIdentityAction: vi.fn(async () => ({ ok: true })),
  rememberMachineSelectionAction: vi.fn(async () => ({ ok: true })),
  clearMachineSelectionAction: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/app/(app)/clients/[id]/sessions/[sessionId]/machine-setup-actions", () => actions);


import type { MachineProfile } from "@/lib/machines/profile-contract";
import type { StudioDevice } from "@/lib/machines/selection";

// HON-8 SAVED MACHINE IDENTITY through the connected wrapper, mounted: the existing workflow as an option in THE selector, the kind reported to the host,
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
const { MachineFirstSetupConnected } = await import("@/components/machines/machine-first-setup-connected");

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
  vi.clearAllMocks();
});

const CTX = {
  scope: SCOPE,
  devices: [DEVICE],
  inventoryReason: null,
  remembered: null,
  rememberedUnavailable: null,
  persistence: { kind: "database", persisted: true },
  catalogue: [PROFILE],
  canManageMachines: false,
  priorSetup: [],
  recordedSetup: [],
  priorSetupUnavailable: false,
  recordedSetupUnavailable: false,
  unitNames: {},
  suggestedMachine: null,
  restoredSelection: null,
  legacyMachine: { profileId: "dectro-apilus:xcell", label: "Dectro xCell" },
};

async function mount(extra: Record<string, unknown>) {
  const load = vi.fn(async () => CTX);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      createElement(MachineFirstSetupConnected, { clientId: "c", sessionId: "s", load, ...extra } as never),
    );
  });
  return load;
}

describe("a saved machine identity, through the connected wrapper", () => {
  it("an area with NO saved identity makes no request on mount (the charting paths stay quiet)", async () => {
    const load = await mount({ blockId: "b1", savedIdentity: null });
    expect(load).not.toHaveBeenCalled();
    expect(host!.querySelector('[data-testid="machine-first-open"]')).not.toBeNull();
  });

  it("an area saved with a unit opens on it at once, with that unit and mode selected", async () => {
    const load = await mount({
      blockId: "b1",
      savedIdentity: { profileId: "fixture:mounted", deviceId: "room-9", modeKey: "galvanic" },
    });
    expect(load).toHaveBeenCalledTimes(1);
    const sel = host!.querySelector<HTMLSelectElement>('[data-testid="machine-select"]')!;
    expect(sel.value).toBe("room-9");
  });

  it("an area saved as the existing workflow opens on that choice", async () => {
    await mount({
      blockId: "b1",
      savedIdentity: { profileId: "dectro-apilus:xcell", deviceId: null, modeKey: null },
    });
    const sel = host!.querySelector<HTMLSelectElement>('[data-testid="machine-select"]')!;
    expect(sel.value).toBe("legacy:xcell");
  });

  it("picking on a SAVED area writes the area's own record, apart from the remembered preference", async () => {
    await mount({
      blockId: "b1",
      savedIdentity: { profileId: "dectro-apilus:xcell", deviceId: null, modeKey: null },
    });
    const sel = host!.querySelector<HTMLSelectElement>('[data-testid="machine-select"]')!;
    const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
    await act(async () => {
      set.call(sel, "room-9");
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(actions.recordBlockMachineIdentityAction).toHaveBeenCalledWith(
      expect.objectContaining({ blockId: "b1", deviceId: "room-9", profileId: null }),
    );
    expect(actions.rememberMachineSelectionAction).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: "room-9" }),
    );
  });

  it("choosing the existing workflow saves the model and leaves the remembered preference alone", async () => {
    await mount({ blockId: "b1", savedIdentity: { profileId: "fixture:mounted", deviceId: "room-9", modeKey: "galvanic" } });
    const sel = host!.querySelector<HTMLSelectElement>('[data-testid="machine-select"]')!;
    const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
    await act(async () => {
      set.call(sel, "legacy:xcell");
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(actions.recordBlockMachineIdentityAction).toHaveBeenCalledWith(
      expect.objectContaining({ blockId: "b1", deviceId: null, modeKey: null, profileId: "dectro-apilus:xcell" }),
    );
    expect(actions.rememberMachineSelectionAction).not.toHaveBeenCalled();
    expect(actions.clearMachineSelectionAction).not.toHaveBeenCalled();
  });

  it("a NEW area hands an explicit pick to the host's Save and writes nothing itself", async () => {
    const onIdentityDraft = vi.fn();
    await mount({ blockId: null, onIdentityDraft, savedIdentity: null, onSettingDraft: vi.fn() });
    const open = host!.querySelector<HTMLButtonElement>('[data-testid="machine-first-open"]')!;
    await act(async () => open.click());
    const sel = host!.querySelector<HTMLSelectElement>('[data-testid="machine-select"]')!;
    const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
    await act(async () => {
      set.call(sel, "room-9");
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onIdentityDraft).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: "room-9", profileId: null }),
      true,
    );
    expect(actions.recordBlockMachineIdentityAction).not.toHaveBeenCalled();
  });
});
