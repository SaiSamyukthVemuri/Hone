// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const actions = vi.hoisted(() => ({
  recordSetupSubmissionAction: vi.fn(async () => ({ ok: true })),
  readingsForBlockAction: vi.fn(async () => ({ ok: true, readings: [], unitNames: {} })),
  recordBlockMachineIdentityAction: vi.fn(async () => ({ ok: true })),
  rememberMachineSelectionAction: vi.fn(async () => ({ ok: true })),
  clearMachineSelectionAction: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/app/(app)/clients/[id]/sessions/[sessionId]/machine-setup-actions", () => actions);


import { newViewRef, withRegistry } from "./helpers/draft-registry-probe";
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
    {
      key: "second",
      nativeLabel: "Second",
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



// The host's registry view, written on every render by the probe that wraps each mount (a stand-in for block-setup-form).
const view = newViewRef();
const connectedEl = (props: Record<string, unknown>) => withRegistry(view, createElement(MachineFirstSetupConnected, props as never));
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
  const { ctx: ctxOverride, ...rest } = extra as { ctx?: Record<string, unknown> };
  const load = vi.fn(async () => ({ ...CTX, ...(ctxOverride ?? {}) }));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      connectedEl({ clientId: "c", sessionId: "s", load, ...rest } as never),
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

  it("REGRESSION: choosing the existing workflow on a NEW area is still the draft after the panel finishes resolving", async () => {
    const onIdentityDraft = vi.fn();
    // A remembered unit is auto-selected first, so the panel resolves a native choice and THEN the practitioner switches.
    await mount({ blockId: null, onIdentityDraft, savedIdentity: null, onSettingDraft: vi.fn(), ctx: { remembered: { deviceId: "room-9", modeKey: "galvanic" } } });
    const open = host!.querySelector<HTMLButtonElement>('[data-testid="machine-first-open"]')!;
    await act(async () => open.click());
    const sel = host!.querySelector<HTMLSelectElement>('[data-testid="machine-select"]')!;
    const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
    await act(async () => {
      set.call(sel, "legacy:xcell");
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    });
    // A later render hands the panel a NEW callback and re-runs its resolution pass.
    await act(async () => {
      root!.render(connectedEl({ clientId: "c", sessionId: "s", blockId: null, onIdentityDraft, savedIdentity: null, onSettingDraft: vi.fn(), load: vi.fn(async () => CTX) } as never));
    });
    // The LAST thing the host heard is what its Save records: the panel's own resolution pass must not clear it.
    expect(onIdentityDraft.mock.calls.at(-1)?.[0]).toEqual({ deviceId: null, modeKey: null, profileId: "dectro-apilus:xcell" });
  });
});

// ===========================================================================
// THE PANEL TRACKS ITS OWN SUCCESSFUL IDENTITY WRITES (Codex, #1369 4475581937; Photos R2)
// ===========================================================================
// WHICH UNIT AND MODE OPEN (Codex #1369 4505565741): saved, restored and remembered are three sources of one decision, and a saved unit wins.
// Sources: connected `restoredSelection` (saved identity > loader's restored > none), `initialDeviceId`/`initialModeKey` (remembered; they
// only seed the PERSISTED preference once a restored selection exists) and the panel's seed (restored, else unusable, else initial).
describe("which unit opens: a saved unit always wins", () => {
  const DEVICE_B: StudioDevice = { ...DEVICE, deviceId: "room-7", displayName: "Room 7 unit" };
  const B_CTX = {
    devices: [DEVICE, DEVICE_B],
    remembered: { deviceId: "room-7", modeKey: "second" },
    restoredSelection: { deviceId: "room-7", modeKey: "second" },
  };
  const selected = () => host!.querySelector<HTMLSelectElement>('[data-testid="machine-select"]')!.value;
  const entry = () => host!.querySelector('[data-testid="machine-reading-entry"]');

  it("saved A with a NULL mode while B is remembered and restored: A is shown, mode unset, no reading form, nothing is written", async () => {
    await mount({ blockId: "b1", ctx: B_CTX, savedIdentity: { profileId: "fixture:mounted", deviceId: "room-9", modeKey: null } });
    expect(selected(), "the saved unit, not the remembered one").toBe("room-9");
    expect(host!.querySelector('[data-testid="machine-mode-unresolved"]'), "the mode-unset state is shown").not.toBeNull();
    expect(host!.textContent).toContain("No mode is recorded for this machine on this area");
    expect(entry(), "no reading form for ANY unit until a mode is chosen").toBeNull();
    expect(actions.recordBlockMachineIdentityAction, "opening writes nothing").not.toHaveBeenCalled();
    expect(actions.recordSetupSubmissionAction).not.toHaveBeenCalled();
  });

  it("saved A with a mode is unchanged: A and its mode, even with B remembered", async () => {
    await mount({ blockId: "b1", ctx: B_CTX, savedIdentity: { profileId: "fixture:mounted", deviceId: "room-9", modeKey: "galvanic" } });
    expect(selected()).toBe("room-9");
    expect(host!.querySelector('[data-testid="machine-mode-unresolved"]')).toBeNull();
    expect(entry(), "its reading form mounts").not.toBeNull();
  });

  it("no saved unit: the existing fallback still applies (restored, then remembered)", async () => {
    await mount({ blockId: "b1", ctx: B_CTX, savedIdentity: null });
    // an identity-less existing area opens only on a click; the fallback is the loader's restored selection
    await act(async () => host!.querySelector<HTMLButtonElement>('[data-testid="machine-first-open"]')!.click());
    expect(selected(), "restored selection wins over nothing").toBe("room-7");
    await act(async () => root!.unmount());
    host!.remove();
    await mount({ blockId: "b1", ctx: { ...B_CTX, restoredSelection: null }, savedIdentity: null });
    await act(async () => host!.querySelector<HTMLButtonElement>('[data-testid="machine-first-open"]')!.click());
    expect(selected(), "remembered applies when nothing is restored").toBe("room-7");
  });
});

// C1/C2 (Insurance final429): what follows the unset-mode state, and the legacy-only saved area now that restoredSelection is null there.
describe("a saved unit with a null mode: the click, the write, and the retired unit", () => {
  const DEVICE_B: StudioDevice = { ...DEVICE, deviceId: "room-7", displayName: "Room 7 unit" };
  const ONE_MODE: MachineProfile = { ...PROFILE, profileId: "fixture:single", modes: [PROFILE.modes[0]] };
  const DEVICE_ONE: StudioDevice = { ...DEVICE, deviceId: "room-3", profileId: "fixture:single", displayName: "Room 3 unit" };
  const B_CTX = { devices: [DEVICE, DEVICE_B, DEVICE_ONE], catalogue: [PROFILE, ONE_MODE], remembered: { deviceId: "room-7", modeKey: "second" }, restoredSelection: { deviceId: "room-7", modeKey: "second" } };
  const click = (id: string) => act(async () => host!.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!.click());

  it("C1: choosing a mode writes EXACTLY ONE identity, naming the SAVED unit and the chosen mode, never the remembered one", async () => {
    await mount({ blockId: "b1", ctx: B_CTX, savedIdentity: { profileId: "fixture:mounted", deviceId: "room-9", modeKey: null } });
    expect(actions.recordBlockMachineIdentityAction, "control: nothing is written before the click").not.toHaveBeenCalled();
    await click("machine-mode-second");
    expect(actions.recordBlockMachineIdentityAction).toHaveBeenCalledTimes(1);
    expect(actions.recordBlockMachineIdentityAction).toHaveBeenCalledWith(expect.objectContaining({ deviceId: "room-9", modeKey: "second" }));
    for (const call of actions.recordBlockMachineIdentityAction.mock.calls) expect(JSON.stringify(call)).not.toContain("room-7");
    expect(host!.querySelector<HTMLSelectElement>('[data-testid="machine-select"]')!.value, "still the saved unit").toBe("room-9");
    expect(host!.querySelector('[data-testid="machine-reading-entry"]'), "the reading form now mounts, for the saved unit").not.toBeNull();
    expect(host!.querySelector('[data-testid="machine-mode-unresolved"]')).toBeNull();
  });

  it("C1: a single-mode unit's ONE click leads to exactly one write", async () => {
    await mount({ blockId: "b1", ctx: B_CTX, savedIdentity: { profileId: "fixture:single", deviceId: "room-3", modeKey: null } });
    expect(host!.querySelector('[data-testid="machine-mode-unresolved"]'), "no silent first-mode guess").not.toBeNull();
    expect(host!.querySelector('[data-testid="machine-reading-entry"]')).toBeNull();
    expect(actions.recordBlockMachineIdentityAction).not.toHaveBeenCalled();
    await click("machine-mode-galvanic");
    expect(actions.recordBlockMachineIdentityAction).toHaveBeenCalledTimes(1);
    expect(actions.recordBlockMachineIdentityAction).toHaveBeenCalledWith(expect.objectContaining({ deviceId: "room-3", modeKey: "galvanic" }));
  });

  it("C1: a RETIRED saved unit with a null mode reaches savedUnavailable: no reading form, no mode prompt for another unit, no write", async () => {
    await mount({
      blockId: "b1",
      ctx: { ...B_CTX, devices: [DEVICE_B], unitNames: { "room-9": "Room 9 unit" } },
      savedIdentity: { profileId: "fixture:mounted", deviceId: "room-9", modeKey: null },
    });
    expect(host!.querySelector('[data-testid="machine-saved-unavailable"]'), "the saved-but-unavailable state").not.toBeNull();
    expect(host!.querySelector('[data-testid="machine-reading-entry"]'), "no reading form, for room-7 or anything").toBeNull();
    expect(actions.recordBlockMachineIdentityAction).not.toHaveBeenCalled();
  });
});

describe("C2: a legacy-only saved area (profileId set, no deviceId)", () => {
  const DEVICE_B: StudioDevice = { ...DEVICE, deviceId: "room-7", displayName: "Room 7 unit" };
  const LEGACY = { profileId: "dectro-apilus:xcell", deviceId: null, modeKey: null };

  it("shows the existing workflow, reports the legacy kind, mounts no native reading form and writes nothing, with B remembered", async () => {
    const onKindChange = vi.fn();
    await mount({
      blockId: "b1",
      onKindChange,
      ctx: { devices: [DEVICE, DEVICE_B], remembered: { deviceId: "room-7", modeKey: "second" }, restoredSelection: { deviceId: "room-7", modeKey: "second" } },
      savedIdentity: LEGACY,
    });
    expect(host!.querySelector<HTMLSelectElement>('[data-testid="machine-select"]')!.value).toBe("legacy:xcell");
    expect(onKindChange.mock.calls.at(-1)?.[0], "the host is told this is the existing workflow").toBe("legacy");
    expect(host!.querySelector('[data-testid="machine-reading-entry"]'), "no native reading form for the remembered unit").toBeNull();
    expect(host!.querySelector('[data-testid="machine-mode-unresolved"]')).toBeNull();
    expect(actions.recordBlockMachineIdentityAction).not.toHaveBeenCalled();
    expect(actions.rememberMachineSelectionAction).not.toHaveBeenCalled();
  });

  it("with the remembered unit UNAVAILABLE the legacy display is unchanged, NO remembered-unavailable note is shown, and nothing is written", async () => {
    await mount({
      blockId: "b1",
      ctx: { remembered: null, rememberedUnavailable: { deviceId: "gone-1", reason: "That machine was retired." } },
      savedIdentity: LEGACY,
    });
    expect(host!.querySelector<HTMLSelectElement>('[data-testid="machine-select"]')!.value).toBe("legacy:xcell");
    expect(host!.querySelector('[data-testid="machine-selection-not-remembered"]'), "the note is about the preference, not this area").toBeNull();
    expect(actions.recordBlockMachineIdentityAction).not.toHaveBeenCalled();
  });

  it("and UNCHANGED elsewhere: an area with no saved identity still states the note", async () => {
    await mount({
      blockId: "b1",
      ctx: { remembered: null, rememberedUnavailable: { deviceId: "gone-1", reason: "That machine was retired." } },
      savedIdentity: null,
    });
    await act(async () => host!.querySelector<HTMLButtonElement>('[data-testid="machine-first-open"]')!.click());
    expect(host!.querySelector('[data-testid="machine-selection-not-remembered"]')?.textContent).toBe("That machine was retired.");
  });
});

describe("the component follows its own identity writes", () => {
  const pick = async (value: string) => {
    const sel = host!.querySelector<HTMLSelectElement>('[data-testid="machine-select"]')!;
    const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
    await act(async () => {
      set.call(sel, value);
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    });
  };

  it("an area that started with NO identity cannot be 'cleared' once it recorded one: refused, nothing cleared, nothing claimed saved", async () => {
    await mount({ blockId: "b1", savedIdentity: null });
    await act(async () => host!.querySelector<HTMLButtonElement>('[data-testid="machine-first-open"]')!.click());
    await pick("room-9");
    expect(actions.recordBlockMachineIdentityAction).toHaveBeenCalledTimes(1);
    actions.clearMachineSelectionAction.mockClear();
    actions.rememberMachineSelectionAction.mockClear();
    await pick("");
    // No new write, the preference is untouched, and the refusal is visible.
    expect(actions.recordBlockMachineIdentityAction).toHaveBeenCalledTimes(1);
    expect(actions.clearMachineSelectionAction).not.toHaveBeenCalled();
    expect(actions.rememberMachineSelectionAction).not.toHaveBeenCalled();
    expect(host!.textContent).toMatch(/cannot be cleared/i);
  });

  it("NEGATIVE CONTROL: an area that never recorded an identity can still clear its (preference-only) choice", async () => {
    await mount({ blockId: "b1", savedIdentity: null });
    await act(async () => host!.querySelector<HTMLButtonElement>('[data-testid="machine-first-open"]')!.click());
    // Nothing was written for this area, so clearing is only the remembered preference.
    await pick("");
    expect(actions.recordBlockMachineIdentityAction).not.toHaveBeenCalled();
    expect(host!.textContent).not.toMatch(/cannot be cleared/i);
  });

  it("the write's new block version reaches the host, and the held version goes out with the write", async () => {
    actions.recordBlockMachineIdentityAction.mockResolvedValueOnce({ ok: true, updatedAt: "v2" } as never);
    const onBlockVersion = vi.fn();
    await mount({
      blockId: "b1",
      savedIdentity: { profileId: "dectro-apilus:xcell", deviceId: null, modeKey: null },
      blockVersion: "v1",
      onBlockVersion,
    });
    await pick("room-9");
    expect(actions.recordBlockMachineIdentityAction).toHaveBeenCalledWith(
      expect.objectContaining({ blockId: "b1", expectedUpdatedAt: "v1" }),
    );
    expect(onBlockVersion).toHaveBeenCalledWith("v2");
  });

  it("NEGATIVE CONTROL: a write that returns no version (the block had changed elsewhere) hands the host nothing", async () => {
    const onBlockVersion = vi.fn();
    await mount({
      blockId: "b1",
      savedIdentity: { profileId: "dectro-apilus:xcell", deviceId: null, modeKey: null },
      blockVersion: "v1",
      onBlockVersion,
    });
    await pick("room-9");
    expect(onBlockVersion).not.toHaveBeenCalled();
  });
});

// Photos R2 finding 2 (#1369): a NEW area starts on THIS CLIENT's last machine, ahead of the practitioner's remembered preference.
describe("a new area starts on the client's own last machine", () => {
  it("the client's last machine outranks the remembered preference; the existing workflow is pre-chosen when that was the client's last", async () => {
    await mount({
      blockId: null,
      savedIdentity: null,
      onIdentityDraft: vi.fn(),
      onSettingDraft: vi.fn(),
      ctx: {
        remembered: { deviceId: "room-9", modeKey: "galvanic" },
        clientLastMachine: { deviceId: null, modeKey: null, legacy: true },
      },
    });
    await act(async () => host!.querySelector<HTMLButtonElement>('[data-testid="machine-first-open"]')!.click());
    expect(host!.querySelector<HTMLSelectElement>('[data-testid="machine-select"]')!.value).toBe("legacy:xcell");
  });
  it("NEGATIVE CONTROL: a client with no last machine falls back to the remembered preference", async () => {
    await mount({
      blockId: null,
      savedIdentity: null,
      onIdentityDraft: vi.fn(),
      onSettingDraft: vi.fn(),
      ctx: { remembered: { deviceId: "room-9", modeKey: "galvanic" }, clientLastMachine: null },
    });
    await act(async () => host!.querySelector<HTMLButtonElement>('[data-testid="machine-first-open"]')!.click());
    expect(host!.querySelector<HTMLSelectElement>('[data-testid="machine-select"]')!.value).toBe("room-9");
  });
  it("a client's last native unit is pre-chosen over a different remembered one", async () => {
    await mount({
      blockId: null,
      savedIdentity: null,
      onIdentityDraft: vi.fn(),
      onSettingDraft: vi.fn(),
      ctx: { remembered: null, clientLastMachine: { deviceId: "room-9", modeKey: "galvanic", legacy: false } },
    });
    await act(async () => host!.querySelector<HTMLButtonElement>('[data-testid="machine-first-open"]')!.click());
    expect(host!.querySelector<HTMLSelectElement>('[data-testid="machine-select"]')!.value).toBe("room-9");
  });
});

describe("Insurance N-7: an existing area without a saved identity opens exactly as before", () => {
  it("the client's last machine is NOT pre-chosen on an existing (pre-0301) area", async () => {
    await mount({
      blockId: "b-old",
      savedIdentity: null,
      ctx: { remembered: null, clientLastMachine: { deviceId: "room-9", modeKey: "galvanic", legacy: false } },
    });
    // No saved identity: the panel stays closed behind its trigger and nothing is pre-chosen or written.
    expect(host!.querySelector('[data-testid="machine-first-open"]')).not.toBeNull();
    expect(actions.recordBlockMachineIdentityAction).not.toHaveBeenCalled();
    await act(async () => host!.querySelector<HTMLButtonElement>('[data-testid="machine-first-open"]')!.click());
    expect(host!.querySelector<HTMLSelectElement>('[data-testid="machine-select"]')!.value).toBe("");
  });
});

// Codex P2 4476240831 (#1369): an EXISTING area's reading entry reports its unsaved values to the host, so the status stops saying Saved and the leave guard arms.
describe("an existing area's reading entry reports its unsaved draft to the host", () => {
  const type = async (el: HTMLInputElement, value: string) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      set.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const mountExisting = async () =>
    mount({
      blockId: "b1",
      savedIdentity: { profileId: "fixture:mounted", deviceId: "room-9", modeKey: "galvanic" },
    });

  it("typing a value reports a draft; clearing it reports none", async () => {
    await mountExisting();
    const input = host!.querySelector<HTMLInputElement>('input[inputmode="decimal"], input[type="text"], input[type="number"]');
    expect(input, "the entry's first field is mounted").not.toBeNull();
    expect(view.current.anyDraft).toBe(false);
    await type(input!, "120");
    expect(view.current.anyDraft).toBe(true);
    await type(input!, "");
    expect(view.current.anyDraft).toBe(false);
  });

  it("NEGATIVE CONTROL: nothing typed never reports a draft", async () => {
    await mountExisting();
    expect(view.current.anyDraft).toBe(false);
  });

  // Codex 4480035425: a refused pick on a saved native area must not unmount the reading entry (its typed readings would be lost).
  it("a REFUSED 'Choose machine…' leaves the typed readings in place (no unmount, no remount)", async () => {
    await mountExisting();
    const input = host!.querySelector<HTMLInputElement>('input[inputmode="decimal"], input[type="text"], input[type="number"]')!;
    await type(input, "120");
    const pickEmpty = async (value: string) => {
      const sel = host!.querySelector<HTMLSelectElement>('[data-testid="machine-select"]')!;
      const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
      await act(async () => {
        set.call(sel, value);
        sel.dispatchEvent(new Event("change", { bubbles: true }));
      });
    };
    await pickEmpty("");
    const after = host!.querySelector<HTMLInputElement>('input[inputmode="decimal"], input[type="text"], input[type="number"]')!;
    expect(after, "the same field node is still mounted").toBe(input);
    expect(after.value).toBe("120");
    expect(host!.textContent).toMatch(/cannot be cleared/i);
  });

  // Privacy FH-2: a write that THROWS (server failure), not one that is refused, must not move the panel either.
  it("a THROWN identity write leaves the panel on the saved machine, keeps the typed readings, and says so", async () => {
    // EVERY attempt throws: the first write and both same-key replays, so the pick is unconfirmed (Codex 4488743493).
    for (let i = 0; i < 3; i += 1) actions.recordBlockMachineIdentityAction.mockRejectedValueOnce(new Error("network") as never);
    await mountExisting();
    const input = host!.querySelector<HTMLInputElement>('input[inputmode="decimal"], input[type="text"], input[type="number"]')!;
    await type(input, "120");
    const sel = host!.querySelector<HTMLSelectElement>('[data-testid="machine-select"]')!;
    const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
    await act(async () => {
      set.call(sel, "legacy:xcell");
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 700));
    });
    expect(sel.value).toBe("room-9");
    const after = host!.querySelector<HTMLInputElement>('input[inputmode="decimal"], input[type="text"], input[type="number"]')!;
    expect(after).toBe(input);
    expect(after.value).toBe("120");
    expect(host!.textContent).toMatch(/could not confirm/i);
  });

  // Codex 4480784741: a MODE change on a saved area is written first too. A refusal leaves the mode and the readings alone.
  const clickMode = async (label: string) => {
    const btn = [...host!.querySelectorAll<HTMLButtonElement>('[data-testid="machine-mode-picker"] button')].find((b) => b.textContent === label)!;
    await act(async () => btn.click());
  };
  const entryField = () => host!.querySelector<HTMLInputElement>('input[inputmode="decimal"], input[type="text"], input[type="number"]')!;
  it("a REFUSED mode change keeps the mode and the typed readings (same field node, same value)", async () => {
    actions.recordBlockMachineIdentityAction.mockResolvedValueOnce({ ok: false, error: "changed elsewhere" } as never);
    await mountExisting();
    const input = entryField();
    await type(input, "120");
    await clickMode("Second");
    expect(entryField(), "not remounted").toBe(input);
    expect(entryField().value).toBe("120");
    const active = [...host!.querySelectorAll('[data-testid="machine-mode-picker"] button')].map((b) => b.textContent);
    expect(active).toContain("Second");
    expect(host!.textContent).toMatch(/changed elsewhere/);
  });
  it("NEGATIVE CONTROL: an ACKNOWLEDGED mode change applies (the entry is for the new mode)", async () => {
    actions.recordBlockMachineIdentityAction.mockResolvedValueOnce({ ok: true, updatedAt: "v2" } as never);
    await mountExisting();
    const input = entryField();
    await type(input, "120");
    await clickMode("Second");
    expect(entryField(), "remounted for the new mode").not.toBe(input);
  });

  it("a REFUSED pick of ANOTHER machine (stale tab) also keeps the typed readings", async () => {
    actions.recordBlockMachineIdentityAction.mockResolvedValueOnce({ ok: false, error: "changed elsewhere" } as never);
    await mountExisting();
    const input = host!.querySelector<HTMLInputElement>('input[inputmode="decimal"], input[type="text"], input[type="number"]')!;
    await type(input, "120");
    const sel = host!.querySelector<HTMLSelectElement>('[data-testid="machine-select"]')!;
    const other = [...sel.options].map((o) => o.value).find((v) => v && v !== "room-9" && v !== "legacy:xcell");
    if (other) {
      const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
      await act(async () => {
        set.call(sel, other);
        sel.dispatchEvent(new Event("change", { bubbles: true }));
      });
      const after = host!.querySelector<HTMLInputElement>('input[inputmode="decimal"], input[type="text"], input[type="number"]')!;
      expect(after).toBe(input);
      expect(after.value).toBe("120");
    } else {
      // Only the existing-workflow option exists besides the saved unit in this fixture: it is the same refusal path.
      const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
      await act(async () => {
        set.call(sel, "legacy:xcell");
        sel.dispatchEvent(new Event("change", { bubbles: true }));
      });
      const after = host!.querySelector<HTMLInputElement>('input[inputmode="decimal"], input[type="text"], input[type="number"]')!;
      expect(after).toBe(input);
      expect(after.value).toBe("120");
    }
  });

  const fields = () => [...host!.querySelectorAll<HTMLInputElement>('input[inputmode="decimal"], input[type="text"], input[type="number"]')];
  const saveEntry = async () =>
    act(async () => {
      host!.querySelector<HTMLButtonElement>('[data-testid="machine-reading-save"]')!.click();
    });

  it("Codex P2 4477412918: after an ACKNOWLEDGED save the draft is released, so the page stops saying Unsaved", async () => {
    actions.recordSetupSubmissionAction.mockResolvedValueOnce({ ok: true, submissionId: "sub-1", captures: 1, written: 2, reused: false } as never);
    await mountExisting();
    for (const [i, el] of fields().entries()) await type(el, String(10 + i));
    expect(view.current.anyDraft).toBe(true);
    await saveEntry();
    expect(host!.querySelector('[data-testid="machine-reading-saved"]'), "the saved view is showing").not.toBeNull();
    expect(view.current.anyDraft).toBe(false);
  });

  it("OPS (shard 1): after a CONFIRMED save a FAILED refresh keeps 'Saved', adds the plain note, and repeats nothing", async () => {
    actions.recordSetupSubmissionAction.mockClear();
    actions.recordSetupSubmissionAction.mockResolvedValueOnce({ ok: true, submissionId: "sub-1", captures: 1, written: 2, reused: false } as never);
    actions.readingsForBlockAction.mockResolvedValueOnce({ ok: false } as never);
    await mountExisting();
    for (const [i, el] of fields().entries()) await type(el, String(10 + i));
    await saveEntry();
    expect(host!.querySelector('[data-testid="machine-reading-saved"]'), "the saved confirmation stays").not.toBeNull();
    const note = host!.querySelector('[data-testid="machine-saved-refresh-note"]');
    expect(note?.textContent).toBe("Saved. The latest readings couldn't be refreshed; reload to see them.");
    expect(host!.textContent).not.toContain("could not be read just now");
    expect(actions.recordSetupSubmissionAction, "the save was not repeated").toHaveBeenCalledTimes(1);
    expect(actions.readingsForBlockAction).toHaveBeenCalledTimes(1);
  });

  it("the same, when the refresh THROWS", async () => {
    actions.recordSetupSubmissionAction.mockClear();
    actions.recordSetupSubmissionAction.mockResolvedValueOnce({ ok: true, submissionId: "sub-1", captures: 1, written: 2, reused: false } as never);
    actions.readingsForBlockAction.mockRejectedValueOnce(new Error("network down") as never);
    await mountExisting();
    for (const [i, el] of fields().entries()) await type(el, String(10 + i));
    await saveEntry();
    expect(host!.querySelector('[data-testid="machine-reading-saved"]')).not.toBeNull();
    expect(host!.querySelector('[data-testid="machine-saved-refresh-note"]')).not.toBeNull();
    expect(actions.recordSetupSubmissionAction).toHaveBeenCalledTimes(1);
  });

  // Codex 4487911008: write-first on a saved area leaves the OLD machine's entry mounted while the change is pending. If the identity
  // write has landed (A -> B) and the preference request is still pending, "Save these settings" would submit A's readings under B.
  const saveButton = () => host!.querySelector<HTMLButtonElement>('[data-testid="machine-reading-save"]')!;
  it("Codex 4487911008: while an identity change is pending (identity landed, preference not yet) the old entry cannot submit; it works again once the change settles", async () => {
    actions.recordSetupSubmissionAction.mockClear();
    actions.recordBlockMachineIdentityAction.mockResolvedValueOnce({ ok: true } as never);
    let settlePreference!: (v: unknown) => void;
    actions.rememberMachineSelectionAction.mockImplementationOnce((() => new Promise((r) => (settlePreference = r))) as never);
    await mountExisting();
    for (const [i, el] of fields().entries()) await type(el, String(10 + i));
    expect(saveButton().disabled, "ready to save before the change").toBe(false);
    await clickMode("Second");
    expect(actions.recordBlockMachineIdentityAction, "the identity write has gone out").toHaveBeenCalledTimes(1);
    expect(saveButton().disabled, "held while the change is pending").toBe(true);
    await act(async () => {
      saveButton().click();
    });
    expect(actions.recordSetupSubmissionAction, "A's readings were NOT submitted under the new machine").not.toHaveBeenCalled();
    await act(async () => {
      settlePreference({ ok: true });
    });
    expect(host!.querySelector('[data-testid="machine-reading-saved"]')).toBeNull();
    expect(actions.recordSetupSubmissionAction).not.toHaveBeenCalled();
    const entryAfter = host!.querySelector('[data-testid="machine-reading-save"]') as HTMLButtonElement | null;
    expect(entryAfter, "the entry for the new mode is mounted").not.toBeNull();
    expect(fields().every((el) => el.value === ""), "the new mode's entry starts empty, not carrying the old mode's draft").toBe(true);
  });

  it("Codex 4487911008 NEGATIVE CONTROL: with no change pending the entry submits as before", async () => {
    actions.recordSetupSubmissionAction.mockClear();
    actions.recordSetupSubmissionAction.mockResolvedValueOnce({ ok: true, submissionId: "sub-1", captures: 1, written: 2, reused: false } as never);
    await mountExisting();
    for (const [i, el] of fields().entries()) await type(el, String(10 + i));
    expect(saveButton().disabled).toBe(false);
    await saveEntry();
    expect(actions.recordSetupSubmissionAction).toHaveBeenCalledTimes(1);
  });

  it("R3-2: a DEFINITIVE refusal on the refresh shows the access notice and leaves no readings or Saved view on screen", async () => {
    actions.recordSetupSubmissionAction.mockClear();
    actions.recordSetupSubmissionAction.mockResolvedValueOnce({ ok: true, submissionId: "sub-1", captures: 1, written: 2, reused: false } as never);
    actions.readingsForBlockAction.mockResolvedValueOnce({ ok: false, refused: "access" } as never);
    await mountExisting();
    for (const [i, el] of fields().entries()) await type(el, String(10 + i));
    await saveEntry();
    const notice = host!.querySelector('[data-testid="machine-access-refused"]');
    expect(notice?.textContent).toBe("Saved. You no longer have access to this treatment record, so its readings are not shown.");
    expect(host!.querySelector('[data-testid="machine-reading-saved"]'), "the old entry is gone").toBeNull();
    expect(host!.querySelectorAll("input").length, "no reading field stays on screen").toBe(0);
    expect(host!.querySelector('[data-testid="machine-saved-refresh-note"]'), "not the gentle note").toBeNull();
    expect(actions.recordSetupSubmissionAction, "the save was not repeated").toHaveBeenCalledTimes(1);
  });

  // Codex 4488223260: a save that succeeded but whose refresh was REFUSED unmounts the panel; every hold it reported to the host
  // (revision unresolved, draft) must be cleared, or "Save settings block" and Cancel stay disabled for ever.
  for (const refused of ["unavailable", "access"] as const) {
    it(`Codex 4488223260: a ${refused} refresh after a save that first LOST its answer clears every hold the host was given`, async () => {
      actions.recordSetupSubmissionAction.mockClear();
      actions.recordSetupSubmissionAction
        .mockRejectedValueOnce(new Error("lost") as never)
        .mockResolvedValueOnce({ ok: true, submissionId: "sub-1", captures: 1, written: 2, reused: false } as never);
      actions.readingsForBlockAction.mockResolvedValueOnce({ ok: false, refused } as never);
      await mount({
        blockId: "b1",
        savedIdentity: { profileId: "fixture:mounted", deviceId: "room-9", modeKey: "galvanic" },
      });
      for (const [i, el] of fields().entries()) await type(el, String(10 + i));
      await saveEntry();
      expect(view.current.anyUnresolved, "the lost answer held the host").toBe(true);
      expect(view.current.anyDraft).toBe(true);
      await saveEntry();
      expect(actions.recordSetupSubmissionAction).toHaveBeenCalledTimes(2);
      expect(host!.querySelector(`[data-testid="${refused === "access" ? "machine-access-refused" : "machine-record-unavailable"}"]`)).not.toBeNull();
      expect(view.current.anyUnresolved, "the unresolved hold is released").toBe(false);
      expect(view.current.anyDraft, "the draft hold is released").toBe(false);
    });
  }

  it("Codex 4488223260: unmounting the wrapper by ANY path releases the holds", async () => {
    actions.recordSetupSubmissionAction.mockRejectedValueOnce(new Error("lost") as never);
    await mount({
      blockId: "b1",
      savedIdentity: { profileId: "fixture:mounted", deviceId: "room-9", modeKey: "galvanic" },
    });
    for (const [i, el] of fields().entries()) await type(el, String(10 + i));
    await saveEntry();
    expect(view.current.anyUnresolved).toBe(true);
    // The wrapper goes (the host and its registry stay): the owner removes its own flags.
    await act(async () => root!.render(withRegistry(view, createElement("div"))));
    expect(view.current.anyUnresolved).toBe(false);
    expect(view.current.anyDraft).toBe(false);
  });

  // THE HOST'S REAL CONTRACT, mounted: block-setup-form disables "Save settings block" and Cancel while `revisionUnresolved` is set (pinned
  // against its source below) and passes setRevisionUnresolved to this wrapper. A harness with the same wiring proves that a refused refresh
  // after a successful save leaves BOTH enabled.
  it("Codex 4488223260 REGRESSION: a refused refresh after a successful save leaves the host's Save and Cancel ENABLED", async () => {
    const form = readFileSync(path.resolve(__dirname, "../../app/(app)/clients/[id]/sessions/[sessionId]/block-setup-form.tsx"), "utf8");
    expect(form).toMatch(/const revisionUnresolved = draftRegistry\.view\.anyUnresolved;/);
    for (const testid of ["save-treatment-area", "cancel-treatment-area"]) {
      const at = form.indexOf(`data-testid="${testid}"`);
      expect(at, testid).toBeGreaterThan(0);
      expect(form.slice(Math.max(0, at - 1600), at + 200), `${testid} is disabled by revisionUnresolved`).toContain("revisionUnresolved ||");
    }
    const { DraftRegistryProvider, useDraftRegistryState } = await import("@/components/machines/draft-registry");
    function Host(props: Record<string, unknown>) {
      const registry = useDraftRegistryState();
      const unresolved = registry.view.anyUnresolved;
      return createElement(
        DraftRegistryProvider,
        { api: registry.api, view: registry.view },
        createElement(
          "div",
          null,
          createElement(MachineFirstSetupConnected, props as never),
          createElement("button", { "data-testid": "save-treatment-area", disabled: unresolved }, "Save settings block"),
          createElement("button", { "data-testid": "cancel-treatment-area", disabled: unresolved }, "Cancel"),
        ),
      );
    }
    actions.recordSetupSubmissionAction.mockClear();
    actions.recordSetupSubmissionAction
      .mockRejectedValueOnce(new Error("lost") as never)
      .mockResolvedValueOnce({ ok: true, submissionId: "sub-1", captures: 1, written: 2, reused: false } as never);
    actions.readingsForBlockAction.mockResolvedValueOnce({ ok: false, refused: "unavailable" } as never);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    const load = vi.fn(async () => ({ ...CTX }));
    await act(async () => {
      root!.render(
        createElement(Host, {
          clientId: "c",
          sessionId: "s",
          load,
          blockId: "b1",
          savedIdentity: { profileId: "fixture:mounted", deviceId: "room-9", modeKey: "galvanic" },
        }),
      );
    });
    const btn = (id: string) => host!.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!;
    for (const [i, el] of fields().entries()) await type(el, String(10 + i));
    await saveEntry();
    expect(btn("save-treatment-area").disabled && btn("cancel-treatment-area").disabled, "held while the answer is unknown").toBe(true);
    await saveEntry();
    expect(host!.querySelector('[data-testid="machine-record-unavailable"]')).not.toBeNull();
    expect(btn("save-treatment-area").disabled, "Save is enabled").toBe(false);
    expect(btn("cancel-treatment-area").disabled, "Cancel is enabled").toBe(false);
  });

  it("Codex 4488223260 NEGATIVE CONTROL: with no refusal the holds follow the entry (a lost answer still holds)", async () => {
    actions.recordSetupSubmissionAction.mockRejectedValueOnce(new Error("lost") as never);
    await mount({
      blockId: "b1",
      savedIdentity: { profileId: "fixture:mounted", deviceId: "room-9", modeKey: "galvanic" },
    });
    for (const [i, el] of fields().entries()) await type(el, String(10 + i));
    await saveEntry();
    expect(view.current.anyUnresolved).toBe(true);
  });

  it("F6-2: an UNAVAILABLE record (transient lineage error, block deleted in another tab) gets neutral wording, not an access accusation", async () => {
    actions.recordSetupSubmissionAction.mockClear();
    actions.recordSetupSubmissionAction.mockResolvedValueOnce({ ok: true, submissionId: "sub-1", captures: 1, written: 2, reused: false } as never);
    actions.readingsForBlockAction.mockResolvedValueOnce({ ok: false, refused: "unavailable" } as never);
    await mountExisting();
    for (const [i, el] of fields().entries()) await type(el, String(10 + i));
    await saveEntry();
    const notice = host!.querySelector('[data-testid="machine-record-unavailable"]');
    expect(notice?.textContent).toBe("Saved. This treatment record could not be loaded just now; reload to try again.");
    expect(host!.textContent).not.toContain("no longer have access");
    expect(host!.querySelector('[data-testid="machine-access-refused"]')).toBeNull();
    expect(host!.querySelector('[data-testid="machine-reading-saved"]'), "stale readings are not left on screen").toBeNull();
    expect(actions.recordSetupSubmissionAction).toHaveBeenCalledTimes(1);
  });

  // RC-1 (Privacy, integrity). After a confirmed save whose refresh failed, the readings on screen are stale. The server compares only
  // the SET of group keys (recordedGroupsMoved), which a same-group revision leaves unchanged, so it would not refuse a second save made
  // against that stale baseline. The panel therefore blocks further saves until a reload.
  it("RC-1: after a FAILED refresh a second save is blocked (no new capture can be started or submitted), and a successful refresh does not block", async () => {
    actions.recordSetupSubmissionAction.mockClear();
    actions.recordSetupSubmissionAction.mockResolvedValueOnce({ ok: true, submissionId: "sub-1", captures: 1, written: 2, reused: false } as never);
    actions.readingsForBlockAction.mockResolvedValueOnce({ ok: false } as never);
    await mountExisting();
    for (const [i, el] of fields().entries()) await type(el, String(10 + i));
    await saveEntry();
    const another = host!.querySelector<HTMLButtonElement>('[data-testid="machine-reading-record-change"]')!;
    expect(another.disabled, "cannot start a second capture from stale readings").toBe(true);
    await act(async () => {
      another.click();
    });
    expect(host!.querySelector('[data-testid="machine-reading-save"]'), "no editable form opened").toBeNull();
    expect(actions.recordSetupSubmissionAction, "no second save").toHaveBeenCalledTimes(1);
    expect(host!.querySelector('[data-testid="machine-saved-refresh-note"]')).not.toBeNull();
  });

  it("RC-1 NEGATIVE CONTROL: after a SUCCESSFUL refresh a second capture can be started and saved", async () => {
    actions.recordSetupSubmissionAction.mockClear();
    actions.recordSetupSubmissionAction.mockResolvedValue({ ok: true, submissionId: "sub-x", captures: 1, written: 2, reused: false } as never);
    await mountExisting();
    for (const [i, el] of fields().entries()) await type(el, String(10 + i));
    await saveEntry();
    const another = host!.querySelector<HTMLButtonElement>('[data-testid="machine-reading-record-change"]')!;
    expect(another.disabled).toBe(false);
    await act(async () => {
      another.click();
    });
    for (const [i, el] of fields().entries()) await type(el, String(20 + i));
    await saveEntry();
    expect(actions.recordSetupSubmissionAction).toHaveBeenCalledTimes(2);
  });

  it("R3-2 NEGATIVE CONTROL: a transient failure (no refusal flag) keeps the entry and shows no access notice", async () => {
    actions.recordSetupSubmissionAction.mockResolvedValueOnce({ ok: true, submissionId: "sub-1", captures: 1, written: 2, reused: false } as never);
    actions.readingsForBlockAction.mockResolvedValueOnce({ ok: false } as never);
    await mountExisting();
    for (const [i, el] of fields().entries()) await type(el, String(10 + i));
    await saveEntry();
    expect(host!.querySelector('[data-testid="machine-access-refused"]')).toBeNull();
    expect(host!.querySelector('[data-testid="machine-reading-saved"]')).not.toBeNull();
  });

  it("NEGATIVE CONTROL: a refresh that SUCCEEDS shows Saved and no note", async () => {
    actions.recordSetupSubmissionAction.mockResolvedValueOnce({ ok: true, submissionId: "sub-1", captures: 1, written: 2, reused: false } as never);
    await mountExisting();
    for (const [i, el] of fields().entries()) await type(el, String(10 + i));
    await saveEntry();
    expect(host!.querySelector('[data-testid="machine-reading-saved"]')).not.toBeNull();
    expect(host!.querySelector('[data-testid="machine-saved-refresh-note"]')).toBeNull();
  });

  it("NEGATIVE CONTROL: a REFUSED save keeps the draft (it is still unsaved)", async () => {
    actions.recordSetupSubmissionAction.mockResolvedValueOnce({ ok: false, code: "rejected", error: "Refused." } as never);
    await mountExisting();
    for (const [i, el] of fields().entries()) await type(el, String(10 + i));
    await saveEntry();
    expect(host!.querySelector('[data-testid="machine-reading-saved"]')).toBeNull();
    expect(view.current.anyDraft).toBe(true);
  });

  it("the draft is released when the entry unmounts", async () => {
    await mountExisting();
    const input = host!.querySelector<HTMLInputElement>('input[inputmode="decimal"], input[type="text"], input[type="number"]')!;
    await type(input, "7");
    expect(view.current.anyDraft).toBe(true);
    await act(async () => root!.render(withRegistry(view, createElement("div"))));
    expect(view.current.anyDraft).toBe(false);
  });
});

// Codex P2 4477716784 (#1369): while a SAVED area's machine choice is being written, the host's Save is held, so a block save cannot commit first
// and turn the choice into a silent stale refusal.
describe("a saved area's machine write holds the host's Save while it is pending", () => {
  const pickValue = async (value: string) => {
    const sel = host!.querySelector<HTMLSelectElement>('[data-testid="machine-select"]')!;
    const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
    await act(async () => {
      set.call(sel, value);
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    });
  };
  const legacySaved = { profileId: "dectro-apilus:xcell", deviceId: null, modeKey: null };

  it("pending is reported true while the write is in flight and false once it settles", async () => {
    let release!: (v: { ok: boolean; updatedAt?: string }) => void;
    actions.recordBlockMachineIdentityAction.mockImplementationOnce(
      () => new Promise((res) => { release = res as typeof release; }) as never,
    );
    const onIdentityWritePending = vi.fn();
    await mount({ blockId: "b1", savedIdentity: legacySaved, blockVersion: "v1", onIdentityWritePending });
    await pickValue("room-9");
    expect(onIdentityWritePending).toHaveBeenLastCalledWith(true);
    await act(async () => release({ ok: true, updatedAt: "v2" }));
    expect(onIdentityWritePending).toHaveBeenLastCalledWith(false);
  });

  it("a REFUSED write also releases the hold", async () => {
    actions.recordBlockMachineIdentityAction.mockResolvedValueOnce({ ok: false, error: "changed elsewhere" } as never);
    const onIdentityWritePending = vi.fn();
    await mount({ blockId: "b1", savedIdentity: legacySaved, blockVersion: "v1", onIdentityWritePending });
    await pickValue("room-9");
    expect(onIdentityWritePending).toHaveBeenCalledWith(true);
    expect(onIdentityWritePending).toHaveBeenLastCalledWith(false);
  });

  it("NEGATIVE CONTROL: a NEW area writes nothing here, so it never holds the host's Save", async () => {
    const onIdentityWritePending = vi.fn();
    await mount({ blockId: undefined, savedIdentity: null, onIdentityWritePending });
    await act(async () => host!.querySelector<HTMLButtonElement>('[data-testid="machine-first-open"]')!.click());
    await pickValue("room-9");
    expect(onIdentityWritePending).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Codex #1369 4471593271 (P1) and 4471593277 (P2).
// ---------------------------------------------------------------------------
describe("a saved area that already holds xCell Pur readings takes no native machine", () => {
  const SAVED_LEGACY = { profileId: "dectro-apilus:xcell", deviceId: null, modeKey: null };
  const open = async () => {
    const btn = host!.querySelector<HTMLButtonElement>('[data-testid="machine-first-open"]');
    if (btn) await act(async () => btn.click());
  };
  const choose = async (value: string) => {
    await open();
    const sel = host!.querySelector<HTMLSelectElement>('[data-testid="machine-select"]')!;
    const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
    await act(async () => {
      set.call(sel, value);
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    });
    return sel;
  };

  it("the native unit is listed but cannot be chosen, and the area says why", async () => {
    await mount({ blockId: "b1", savedIdentity: SAVED_LEGACY, legacyReadingsLocked: true });
    await open();
    const sel = host!.querySelector<HTMLSelectElement>('[data-testid="machine-select"]')!;
    const unit = [...sel.options].find((o) => o.value === "room-9")!;
    expect(unit.disabled).toBe(true);
    expect([...sel.options].find((o) => o.value === "legacy:xcell")!.disabled).toBe(false);
    expect(host!.querySelector('[data-testid="machine-native-locked"]')).not.toBeNull();
  });

  it("a native pick that gets through anyway (keyboard, script) is refused BEFORE anything is written, and the selector does not move", async () => {
    await mount({ blockId: "b1", savedIdentity: SAVED_LEGACY, legacyReadingsLocked: true });
    const sel = await choose("room-9");
    expect(actions.recordBlockMachineIdentityAction).not.toHaveBeenCalled();
    expect(actions.rememberMachineSelectionAction).not.toHaveBeenCalled();
    expect(actions.recordSetupSubmissionAction).not.toHaveBeenCalled();
    expect(sel.value).toBe("legacy:xcell");
    expect(host!.textContent).toContain("This area already has xCell Pur readings");
  });

  it("NEGATIVE CONTROL: the same pick on an area WITHOUT legacy readings is written", async () => {
    await mount({ blockId: "b1", savedIdentity: SAVED_LEGACY, legacyReadingsLocked: false });
    await choose("room-9");
    expect(actions.recordBlockMachineIdentityAction).toHaveBeenCalledWith(
      expect.objectContaining({ blockId: "b1", deviceId: "room-9" }),
    );
  });

  it("NEGATIVE CONTROL: choosing the existing workflow itself on a locked area is still written", async () => {
    await mount({ blockId: "b1", savedIdentity: { profileId: null, deviceId: null, modeKey: null }, legacyReadingsLocked: true });
    await choose("legacy:xcell");
    expect(actions.recordBlockMachineIdentityAction).toHaveBeenCalledWith(
      expect.objectContaining({ blockId: "b1", profileId: "dectro-apilus:xcell", deviceId: null }),
    );
  });

  it("Insurance LK-3: a DATABASE refusal (readings the page did not know about) is a reverted pick: the selector stays, nothing is remembered", async () => {
    actions.recordBlockMachineIdentityAction.mockResolvedValueOnce({
      ok: false,
      error: "This area already holds xCell Pur readings; add a new area for another machine.",
    } as never);
    await mount({ blockId: "b1", savedIdentity: SAVED_LEGACY, legacyReadingsLocked: false });
    const sel = await choose("room-9");
    expect(actions.recordBlockMachineIdentityAction).toHaveBeenCalledTimes(1);
    expect(actions.rememberMachineSelectionAction).not.toHaveBeenCalled();
    expect(sel.value).toBe("legacy:xcell");
    expect(host!.textContent).toContain("already holds xCell Pur readings");
  });

  it("Insurance V-3: when the PREFERENCE write fails after the RECORD was written, the record stands and the panel keeps the pick, saying so", async () => {
    actions.rememberMachineSelectionAction.mockResolvedValueOnce({ ok: false, error: "The preference did not save." } as never);
    await mount({ blockId: "b1", savedIdentity: SAVED_LEGACY, legacyReadingsLocked: false });
    const sel = await choose("room-9");
    expect(actions.recordBlockMachineIdentityAction).toHaveBeenCalledWith(expect.objectContaining({ blockId: "b1", deviceId: "room-9" }));
    expect(sel.value, "the area's own record was written, so the panel is on that machine").toBe("room-9");
    expect(host!.textContent).toContain("The preference did not save.");
  });

  it("Codex 4487384231: a preference request that THROWS after the record was committed keeps the committed choice and shows a quiet note", async () => {
    actions.rememberMachineSelectionAction.mockRejectedValueOnce(new Error("network down") as never);
    await mount({ blockId: "b1", savedIdentity: SAVED_LEGACY, legacyReadingsLocked: false });
    const sel = await choose("room-9");
    expect(actions.recordBlockMachineIdentityAction).toHaveBeenCalledTimes(1);
    expect(sel.value, "the record was committed, so the panel stays on that machine").toBe("room-9");
    expect(host!.textContent).toContain("not remembered for your next visit");
  });

  it("NEGATIVE CONTROL: a throw from the RECORD itself (nothing committed) still does not leave the panel on the new machine", async () => {
    actions.recordBlockMachineIdentityAction.mockRejectedValueOnce(new Error("network down") as never);
    await mount({ blockId: "b1", savedIdentity: SAVED_LEGACY, legacyReadingsLocked: false });
    const sel = await choose("room-9").catch(() => host!.querySelector<HTMLSelectElement>('[data-testid="machine-select"]')!);
    expect(actions.rememberMachineSelectionAction).not.toHaveBeenCalled();
    expect(sel.value).not.toBe("room-9");
  });

  it("NEGATIVE CONTROL: a NEW area (no block) is never locked, whatever the flag says", async () => {
    await mount({ blockId: null, legacyReadingsLocked: true });
    await open();
    const sel = host!.querySelector<HTMLSelectElement>('[data-testid="machine-select"]')!;
    expect([...sel.options].find((o) => o.value === "room-9")!.disabled).toBe(false);
    expect(host!.querySelector('[data-testid="machine-native-locked"]')).toBeNull();
  });
});

describe("a studio with xCell Pur history and no registered native unit can still choose xCell", () => {
  it("the selector is ENABLED when only the existing workflow is available (it used to be disabled)", async () => {
    await mount({ blockId: null, ctx: { devices: [] } });
    const btn = host!.querySelector<HTMLButtonElement>('[data-testid="machine-first-open"]');
    if (btn) await act(async () => btn.click());
    const sel = host!.querySelector<HTMLSelectElement>('[data-testid="machine-select"]')!;
    expect(sel.disabled).toBe(false);
    expect([...sel.options].map((o) => o.value)).toContain("legacy:xcell");
  });

  it("NEGATIVE CONTROL: with no unit and no history the selector stays disabled", async () => {
    await mount({ blockId: null, ctx: { devices: [], legacyMachine: null } });
    const btn = host!.querySelector<HTMLButtonElement>('[data-testid="machine-first-open"]');
    if (btn) await act(async () => btn.click());
    const sel = host!.querySelector<HTMLSelectElement>('[data-testid="machine-select"]')!;
    expect(sel.disabled).toBe(true);
  });
});

describe("Codex 4488516837: the panel cannot be opened while a create is unresolved", () => {
  it("'Choose machine' is disabled while the host's draft is frozen, and enabled otherwise (negative control)", async () => {
    await mount({ blockId: null, settingDraftFrozen: true, onIdentityDraft: vi.fn(), onSettingDraft: vi.fn() });
    expect(host!.querySelector<HTMLButtonElement>('[data-testid="machine-first-open"]')!.disabled).toBe(true);
    await act(async () => root!.unmount());
    host!.remove();
    await mount({ blockId: null, settingDraftFrozen: false, onIdentityDraft: vi.fn(), onSettingDraft: vi.fn() });
    expect(host!.querySelector<HTMLButtonElement>('[data-testid="machine-first-open"]')!.disabled).toBe(false);
  });

  // Codex 4492927325: a DIFFERENT identity under the same create key is refused by the database. Here is the app's half: while the
  // create is unresolved nothing can change the identity the retry will send, so the same key can only ever carry the same identity.
  it("a click on a disabled 'Choose machine' neither loads the panel nor reports any identity draft (the retry keeps its identity)", async () => {
    const onIdentityDraft = vi.fn();
    const load = await mount({ blockId: null, settingDraftFrozen: true, onIdentityDraft, onSettingDraft: vi.fn() });
    await act(async () => host!.querySelector<HTMLButtonElement>('[data-testid="machine-first-open"]')!.click());
    expect(load).not.toHaveBeenCalled();
    expect(onIdentityDraft).not.toHaveBeenCalled();
    expect(host!.querySelector('[data-testid="machine-select"]')).toBeNull();
  });
  it("the host sends only the snapshotted identity on every attempt of one key, and a refusal after a lost answer keeps the key", () => {
    const src = readFileSync(path.join(process.cwd(), "app/(app)/clients/[id]/sessions/[sessionId]/block-setup-form.tsx"), "utf8");
    expect(src).toMatch(/machineIdentity: attemptIdentity/);
    expect(src).toMatch(/if \(createAttemptRef\.current !== null\) return;\s*identityDraftRef\.current = choice;/);
    expect(src).toMatch(/CREATE_REFUSED_AFTER_LOST_ANSWER/);
  });
});

// ===========================================================================
// A LOST ANSWER IS SETTLED BY THE PICK'S KEY (Codex 4488743493 and 4488743496, Sam 6 Nov 2026).
// The identity write committed and its reply was lost: the editor asks again with the SAME key, is answered with the version
// THAT write produced and the identity it stored, keeps unrelated typed edits, and can save again. A different version than the
// write's own is never adopted (Insurance N-8): the host only ever receives what the receipt returns.
// ===========================================================================
describe("a lost identity-write answer is recovered by its key", () => {
  // An earlier test's replay timer may still be pending; let it fire (and fail) before this file's mocks are reset.
  beforeEach(async () => {
    await new Promise((r) => setTimeout(r, 700));
  });
  const pickValue = async (value: string) => {
    const sel = host!.querySelector<HTMLSelectElement>('[data-testid="machine-select"]')!;
    const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
    await act(async () => {
      set.call(sel, value);
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 700));
    });
  };
  const STORED = { profileId: "fixture:mounted", deviceId: "room-9", modeKey: "galvanic" };
  const unknown = { ok: false, code: "unknown", error: "We could not confirm that your machine choice was saved." } as never;
  const keysOf = () => (actions.recordBlockMachineIdentityAction.mock.calls as unknown as [{ idempotencyKey: string }][]).map((c) => c[0].idempotencyKey);

  it("(a) commit, lose the answer, recover: the panel shows the saved machine, the host holds the stored version, the typed edit stays, the key is reused", async () => {
    actions.recordBlockMachineIdentityAction.mockReset();
    actions.recordBlockMachineIdentityAction
      .mockResolvedValueOnce(unknown)
      .mockResolvedValueOnce({ ok: true, reused: true, updatedAt: "v2-own", identity: STORED } as never);
    const onBlockVersion = vi.fn();
    await mount({ blockId: "b1", savedIdentity: { profileId: "dectro-apilus:xcell", deviceId: null, modeKey: null }, blockVersion: "v1", onBlockVersion });
    await pickValue("room-9");
    const keys = keysOf();
    expect(keys).toHaveLength(2);
    expect(keys[1], "the retry reuses the pick's key").toBe(keys[0]);
    expect((actions.recordBlockMachineIdentityAction.mock.calls as unknown as unknown[][])[1][0]).toMatchObject({ expectedUpdatedAt: "v1" });
    expect(onBlockVersion).toHaveBeenCalledWith("v2-own");
    expect(host!.querySelector<HTMLSelectElement>('[data-testid="machine-select"]')!.value).toBe("room-9");
    expect(host!.textContent).not.toMatch(/could not confirm|did not save/i);
  });

  it("(a) the recovery touches only the identity write and the host's version: no other action, no draft callback, no clear", async () => {
    actions.recordBlockMachineIdentityAction.mockReset();
    actions.recordBlockMachineIdentityAction
      .mockResolvedValueOnce(unknown)
      .mockResolvedValueOnce({ ok: true, reused: true, updatedAt: "v2-own", identity: STORED } as never);
    actions.recordSetupSubmissionAction.mockClear();
    const onBlockVersion = vi.fn();
    await mount({ blockId: "b1", savedIdentity: STORED, blockVersion: "v1", onBlockVersion });
    expect(view.current.anyDraft, "nothing is typed").toBe(false);
    await pickValue("room-9");
    expect(onBlockVersion).toHaveBeenCalledTimes(1);
    expect(view.current.anyDraft, "the recovery does not invent a draft hold").toBe(false);
    expect(actions.recordSetupSubmissionAction).not.toHaveBeenCalled();
  });

  it("an unconfirmed pick after every replay keeps the panel on the saved machine, says so, and asking again REUSES the key and settles it", async () => {
    actions.recordBlockMachineIdentityAction.mockReset();
    actions.recordBlockMachineIdentityAction
      .mockResolvedValueOnce(unknown)
      .mockResolvedValueOnce(unknown)
      .mockResolvedValueOnce(unknown)
      .mockResolvedValueOnce({ ok: true, reused: true, updatedAt: "v2-own", identity: { profileId: "dectro-apilus:xcell", deviceId: null, modeKey: null } } as never);
    const onBlockVersion = vi.fn();
    await mount({ blockId: "b1", savedIdentity: STORED, blockVersion: "v1", onBlockVersion });
    await pickValue("legacy:xcell");
    expect(host!.textContent).toMatch(/could not confirm/i);
    // RC-1: the screen says the shown machine is only the last CONFIRMED one and offers the reload, never presents it as current.
    expect(host!.textContent).toMatch(/last one confirmed/i);
    expect(host!.textContent).toMatch(/reload the page/i);
    expect(onBlockVersion).not.toHaveBeenCalled();
    await pickValue("legacy:xcell");
    const keys = keysOf();
    expect(keys).toHaveLength(4);
    expect(new Set(keys).size, "one key for the whole pick").toBe(1);
    expect(onBlockVersion).toHaveBeenCalledWith("v2-own");
  });

  it("NEGATIVE CONTROL: a definitive refusal releases the key, so the next pick is a NEW write with a new key", async () => {
    actions.recordBlockMachineIdentityAction.mockReset();
    actions.recordBlockMachineIdentityAction
      .mockResolvedValueOnce({ ok: false, code: "rejected", error: "changed elsewhere" } as never)
      .mockResolvedValueOnce({ ok: true, updatedAt: "v2", identity: STORED } as never);
    await mount({ blockId: "b1", savedIdentity: { profileId: "dectro-apilus:xcell", deviceId: null, modeKey: null }, blockVersion: "v1", onBlockVersion: vi.fn() });
    await pickValue("room-9");
    await pickValue("room-9");
    const keys = keysOf();
    expect(keys).toHaveLength(2);
    expect(keys[1]).not.toBe(keys[0]);
  });

  it("a DIFFERENT pick while an earlier one is unconfirmed first settles the earlier one by its own key, and writes against the version that returns", async () => {
    actions.recordBlockMachineIdentityAction.mockReset();
    actions.recordBlockMachineIdentityAction
      .mockResolvedValueOnce(unknown)
      .mockResolvedValueOnce(unknown)
      .mockResolvedValueOnce(unknown) // first pick unconfirmed after its replays
      .mockResolvedValueOnce({ ok: true, reused: true, updatedAt: "v2-own", identity: { profileId: "dectro-apilus:xcell", deviceId: null, modeKey: null } } as never)
      .mockResolvedValueOnce({ ok: true, updatedAt: "v3", identity: STORED } as never);
    const onBlockVersion = vi.fn();
    await mount({ blockId: "b1", savedIdentity: STORED, blockVersion: "v1", onBlockVersion });
    await pickValue("legacy:xcell");
    await pickValue("room-9"); // a different choice
    const calls = (actions.recordBlockMachineIdentityAction.mock.calls as unknown as [{ idempotencyKey: string; expectedUpdatedAt: string | null }][]).map((c) => c[0]);
    expect(calls).toHaveLength(5);
    expect(calls[3].idempotencyKey, "the earlier pick is settled by its own key").toBe(calls[0].idempotencyKey);
    expect(calls[4].idempotencyKey).not.toBe(calls[0].idempotencyKey);
    expect(calls[4].expectedUpdatedAt, "the new pick goes against the version the earlier write produced").toBe("v2-own");
  });

  // Codex #1369 4493827101: A->B committed with every reply lost; C is picked; B is recovered and adopted; C is then REFUSED. The
  // panel used to go back to A (the machine from before the call) while the database and the host's version held B.
  const XCELL = { profileId: "dectro-apilus:xcell", deviceId: null, modeKey: null };
  const settledB = { ok: true, reused: true, updatedAt: "v2-own", identity: XCELL } as never;
  async function lostThenRefused(...afterB: unknown[]) {
    actions.recordBlockMachineIdentityAction.mockReset();
    actions.recordBlockMachineIdentityAction
      .mockResolvedValueOnce(unknown)
      .mockResolvedValueOnce(unknown)
      .mockResolvedValueOnce(unknown) // B unconfirmed after its replays
      .mockResolvedValueOnce(settledB); // C's pick settles B first
    for (const a of afterB) actions.recordBlockMachineIdentityAction.mockResolvedValueOnce(a as never); // then C
    // The host adopts whatever version is reported, as block-setup-form does.
    let rerender: (v: string) => void = () => undefined;
    const onBlockVersion = vi.fn((v: string) => rerender(v));
    await mount({ blockId: "b1", savedIdentity: STORED, blockVersion: "v1", onBlockVersion });
    rerender = (v) =>
      act(() => {
        root!.render(
          connectedEl({ clientId: "c", sessionId: "s", load: vi.fn(async () => CTX), blockId: "b1", savedIdentity: STORED, blockVersion: v, onBlockVersion } as never),
        );
      }) as unknown as void;
    await pickValue("legacy:xcell"); // B
    await pickValue("room-9"); // C (the unit A was)
    return onBlockVersion;
  }
  const shown = () => host!.querySelector<HTMLSelectElement>('[data-testid="machine-select"]')!.value;

  it("A->B lost, pick C, C REFUSED: the panel shows B (not A), holds B's version, says why, and the next save is written against B's version", async () => {
    const onBlockVersion = await lostThenRefused({ ok: false, code: "rejected", error: "That machine was retired." });
    expect(shown(), "the confirmed identity is B").toBe("legacy:xcell");
    expect(host!.textContent).toMatch(/retired/i);
    expect(onBlockVersion).toHaveBeenLastCalledWith("v2-own");
    actions.recordBlockMachineIdentityAction.mockResolvedValueOnce({ ok: true, updatedAt: "v3", identity: STORED } as never);
    await pickValue("room-9");
    const calls = (actions.recordBlockMachineIdentityAction.mock.calls as unknown as [{ expectedUpdatedAt: string | null }][]).map((c) => c[0]);
    expect(calls[calls.length - 1].expectedUpdatedAt).toBe("v2-own");
    expect(shown()).toBe("room-9");
  });

  it("A->B lost, pick C, C itself UNCONFIRMED: the panel still shows B, the machine already confirmed", async () => {
    const onBlockVersion = await lostThenRefused(unknown, unknown, unknown); // C's own write is unconfirmed after its replays
    expect(onBlockVersion).toHaveBeenCalledWith("v2-own");
    expect(shown()).toBe("legacy:xcell");
  });

  // Codex #1369 4494175930: the FAKES MUST ANSWER AS THE PRODUCTION RPC DOES. A native pick carries no profile id (the unit's profile is derived
  // server-side) and the record's reply names the unit's REAL profile id, so a comparison that included the profile read every successful
  // native change as "a different machine" and returned before the remembered preference was written.
  const REAL_NATIVE = (modeKey: string) => ({ profileId: "fixture:mounted", deviceId: "room-9", modeKey });
  const SETTLED_DIFFERENT = /already settled as a different machine/i;

  it("REALISTIC REPLY: a native unit change succeeds, says nothing about a different machine, and remembers the unit once", async () => {
    actions.recordBlockMachineIdentityAction.mockReset();
    actions.recordBlockMachineIdentityAction.mockResolvedValueOnce({ ok: true, updatedAt: "v2", identity: REAL_NATIVE("galvanic") } as never);
    actions.rememberMachineSelectionAction.mockClear();
    await mount({ blockId: "b1", savedIdentity: { profileId: "dectro-apilus:xcell", deviceId: null, modeKey: null }, blockVersion: "v1", onBlockVersion: vi.fn() });
    await pickValue("room-9");
    expect(host!.textContent).not.toMatch(SETTLED_DIFFERENT);
    expect(shown()).toBe("room-9");
    expect(actions.rememberMachineSelectionAction).toHaveBeenCalledTimes(1);
    expect(actions.rememberMachineSelectionAction).toHaveBeenCalledWith(expect.objectContaining({ deviceId: "room-9" }));
  });

  it("REALISTIC REPLY: a native MODE change succeeds, says nothing about a different machine, and remembers the mode once", async () => {
    actions.recordBlockMachineIdentityAction.mockReset();
    actions.recordBlockMachineIdentityAction.mockResolvedValueOnce({ ok: true, updatedAt: "v2", identity: REAL_NATIVE("second") } as never);
    actions.rememberMachineSelectionAction.mockClear();
    await mount({ blockId: "b1", savedIdentity: STORED, blockVersion: "v1", onBlockVersion: vi.fn() });
    await act(async () => {
      host!.querySelector<HTMLButtonElement>('[data-testid="machine-mode-second"]')!.click();
    });
    expect(host!.textContent).not.toMatch(SETTLED_DIFFERENT);
    expect(actions.recordBlockMachineIdentityAction).toHaveBeenCalledTimes(1);
    expect(actions.rememberMachineSelectionAction).toHaveBeenCalledTimes(1);
    expect(actions.rememberMachineSelectionAction).toHaveBeenCalledWith(expect.objectContaining({ deviceId: "room-9", modeKey: "second" }));
  });

  it("REALISTIC REPLY on the lost-answer recovery: B recovered with its real profile, then C picked and succeeds with no message", async () => {
    actions.recordBlockMachineIdentityAction.mockReset();
    actions.recordBlockMachineIdentityAction
      .mockResolvedValueOnce(unknown)
      .mockResolvedValueOnce(unknown)
      .mockResolvedValueOnce(unknown)
      .mockResolvedValueOnce(settledB)
      .mockResolvedValueOnce({ ok: true, updatedAt: "v3", identity: REAL_NATIVE("galvanic") } as never);
    actions.rememberMachineSelectionAction.mockClear();
    await mount({ blockId: "b1", savedIdentity: STORED, blockVersion: "v1", onBlockVersion: vi.fn() });
    await pickValue("legacy:xcell");
    await pickValue("room-9");
    expect(host!.textContent).not.toMatch(SETTLED_DIFFERENT);
    expect(shown()).toBe("room-9");
    expect(actions.rememberMachineSelectionAction).toHaveBeenCalledTimes(1);
  });

  it("a GENUINELY different settled identity still shows the message, shows what is saved, and does not remember the unasked unit", async () => {
    actions.recordBlockMachineIdentityAction.mockReset();
    actions.recordBlockMachineIdentityAction.mockResolvedValueOnce({ ok: true, updatedAt: "v2", identity: XCELL } as never);
    actions.rememberMachineSelectionAction.mockClear();
    await mount({ blockId: "b1", savedIdentity: { profileId: "dectro-apilus:xcell", deviceId: null, modeKey: null }, blockVersion: "v1", onBlockVersion: vi.fn() });
    await pickValue("room-9");
    expect(host!.textContent).toMatch(SETTLED_DIFFERENT);
    expect(shown()).toBe("legacy:xcell");
    expect(actions.rememberMachineSelectionAction).not.toHaveBeenCalled();
  });

  it("a different MODE of the same unit is also a different settled identity", async () => {
    actions.recordBlockMachineIdentityAction.mockReset();
    actions.recordBlockMachineIdentityAction.mockResolvedValueOnce({ ok: true, updatedAt: "v2", identity: REAL_NATIVE("galvanic") } as never);
    await mount({ blockId: "b1", savedIdentity: STORED, blockVersion: "v1", onBlockVersion: vi.fn() });
    await act(async () => {
      host!.querySelector<HTMLButtonElement>('[data-testid="machine-mode-second"]')!.click();
    });
    expect(host!.textContent).toMatch(SETTLED_DIFFERENT);
  });

  it("NEGATIVE CONTROL: with no earlier recovery, a refused pick still leaves the panel on the saved machine A", async () => {
    actions.recordBlockMachineIdentityAction.mockReset();
    actions.recordBlockMachineIdentityAction.mockResolvedValueOnce({ ok: false, code: "rejected", error: "That machine was retired." } as never);
    await mount({ blockId: "b1", savedIdentity: STORED, blockVersion: "v1", onBlockVersion: vi.fn() });
    await pickValue("legacy:xcell");
    expect(shown()).toBe("room-9");
  });

  // Codex, #1369 4498767101: the action now refuses a unit/mode pair the model does not offer, before anything is written.
  it("a refused unit/mode pick shows the action's clear copy and leaves the panel on the saved machine, never on the refused one", async () => {
    const COPY = "That machine does not offer that mode. Choose the machine and mode again. Nothing was saved.";
    actions.recordBlockMachineIdentityAction.mockReset();
    actions.recordBlockMachineIdentityAction.mockResolvedValueOnce({ ok: false, code: "rejected", error: COPY } as never);
    await mount({ blockId: "b1", savedIdentity: STORED, blockVersion: "v1", onBlockVersion: vi.fn() });
    await pickValue("legacy:xcell");
    expect(host!.textContent).toContain(COPY);
    expect(shown()).toBe("room-9");
    expect(actions.recordBlockMachineIdentityAction).toHaveBeenCalledTimes(1);
  });
});

describe("(b) a lost readings answer: the replay's stored version reaches the host, and a replay with none is not adopted", () => {
  it("the version in a REUSED reply is handed to the host (the stored one)", async () => {
    actions.recordSetupSubmissionAction.mockReset();
    actions.recordSetupSubmissionAction.mockResolvedValueOnce({ ok: true, reused: true, captures: 1, written: 1, updatedAt: "v2-own" } as never);
    const onBlockVersion = vi.fn();
    const load = await mount({ blockId: "b1", savedIdentity: { profileId: "fixture:mounted", deviceId: "room-9", modeKey: "galvanic" }, blockVersion: "v1", onBlockVersion });
    expect(load).toHaveBeenCalled();
    const src = readFileSync(path.join(process.cwd(), "components/machines/machine-first-setup-connected.tsx"), "utf8");
    expect(src).toMatch(/if \(out\.ok && out\.updatedAt\) onBlockVersion\?\.\(out\.updatedAt\)/);
  });
  it("LEGACY: a reused reply with NO version (a submission made before the receipts) adopts nothing: the source never falls back to a read or a guess", () => {
    const src = readFileSync(path.join(process.cwd(), "components/machines/machine-first-setup-connected.tsx"), "utf8");
    const onRecord = src.slice(src.indexOf("const onRecord"), src.indexOf("const selectMachineInner"));
    // The only adoption is the reply's own updatedAt; nothing reads session_blocks, the readings or `new Date()` for a version.
    expect(onRecord.match(/onBlockVersion\?\./g)).toHaveLength(1);
    expect(onRecord).not.toMatch(/updated_at|new Date|Date\.now/);
  });
});

// ===========================================================================
// SAM'S NAMED ASSERTION (6 Nov 2026): an UNRELATED draft field holds the SAME value after a lost-answer recovery, and the next
// save then succeeds. The host form's own note is rendered beside the wrapper, owned by the host (not by the panel), and the host
// holds the block version the way block-setup-form does (it adopts whatever onBlockVersion reports).
// ===========================================================================
describe("an unrelated draft field survives each lost-answer recovery, and the next save then succeeds", () => {
  const STORED = { profileId: "fixture:mounted", deviceId: "room-9", modeKey: "galvanic" };
  const note = () => host!.querySelector<HTMLInputElement>('[data-testid="host-note"]')!;
  const held = () => host!.querySelector('[data-testid="host-held-version"]')!.textContent;
  const typeNote = async (value: string) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      set.call(note(), value);
      note().dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 700)); });

  async function mountHost() {
    const { useState } = await import("react");
    function HostForm() {
      const [text, setText] = useState("");
      const [version, setVersion] = useState<string>("v1");
      return createElement(
        "div",
        null,
        createElement("input", { "data-testid": "host-note", type: "text", "aria-label": "note", value: text, onChange: (e: { target: { value: string } }) => setText(e.target.value) }),
        createElement("span", { "data-testid": "host-held-version" }, version),
        connectedEl({
          clientId: "c",
          sessionId: "s",
          blockId: "b1",
          load: vi.fn(async () => ({ ...CTX })),
          savedIdentity: STORED,
          blockVersion: version,
          onBlockVersion: setVersion,
        } as never),
      );
    }
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(createElement(HostForm));
    });
  }
  const modeButton = (label: string) =>
    [...host!.querySelectorAll<HTMLButtonElement>('[data-testid="machine-mode-picker"] button')].find((b) => b.textContent === label)!;
  const typeReadings = async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    for (const [i, el] of [...host!.querySelectorAll<HTMLInputElement>('input[inputmode="decimal"], input[type="number"]')].entries()) {
      await act(async () => {
        set.call(el, String(10 + i));
        el.dispatchEvent(new Event("input", { bubbles: true }));
      });
    }
  };
  const saveReadings = () =>
    act(async () => {
      host!.querySelector<HTMLButtonElement>('[data-testid="machine-reading-save"]')!.click();
    });
  beforeEach(settle);

  it("LOST IDENTITY ANSWER: the host's note holds the same value, the host holds the STORED version, and the next save goes out with it and succeeds", async () => {
    actions.recordBlockMachineIdentityAction.mockReset();
    actions.recordSetupSubmissionAction.mockReset();
    actions.recordBlockMachineIdentityAction
      .mockResolvedValueOnce({ ok: false, code: "unknown", error: "We could not confirm that your machine choice was saved." } as never)
      .mockResolvedValueOnce({ ok: true, reused: true, updatedAt: "v2-own", identity: STORED } as never);
    actions.recordSetupSubmissionAction.mockResolvedValue({ ok: true, submissionId: "sub-n", captures: 1, written: 2, reused: false, updatedAt: "v3" } as never);
    await mountHost();
    await typeNote("keep this note exactly");
    expect(held()).toBe("v1");
    await act(async () => modeButton("Second").click());
    await settle();
    expect(note().value, "the unrelated field holds the SAME value after the recovery").toBe("keep this note exactly");
    expect(held(), "the host adopted the version the lost write produced").toBe("v2-own");
    expect(host!.textContent).not.toMatch(/could not confirm|did not save/i);

    await typeReadings();
    await saveReadings();
    expect(actions.recordSetupSubmissionAction).toHaveBeenCalledTimes(1);
    expect((actions.recordSetupSubmissionAction.mock.calls as unknown as unknown[][])[0][0]).toMatchObject({ expectedUpdatedAt: "v2-own" });
    expect(host!.querySelector('[data-testid="machine-reading-saved"]'), "the next save succeeded").not.toBeNull();
    expect(note().value).toBe("keep this note exactly");
    expect(held()).toBe("v3");
  });

  it("LOST READINGS ANSWER: the host's note holds the same value, the host holds the STORED version from the replay, and the next write goes out with it and succeeds", async () => {
    actions.recordBlockMachineIdentityAction.mockReset();
    actions.recordSetupSubmissionAction.mockReset();
    actions.recordSetupSubmissionAction
      .mockResolvedValueOnce({ ok: false, code: "unknown", error: "no answer" } as never)
      .mockResolvedValueOnce({ ok: true, submissionId: "sub-1", captures: 1, written: 2, reused: true, updatedAt: "v2-own" } as never);
    actions.recordBlockMachineIdentityAction.mockResolvedValue({ ok: true, updatedAt: "v3", identity: STORED } as never);
    await mountHost();
    await typeNote("another unrelated draft");
    await typeReadings();
    await saveReadings(); // the answer is lost: unknown
    expect(held(), "nothing is adopted from an unknown answer").toBe("v1");
    expect(note().value).toBe("another unrelated draft");
    await saveReadings(); // the retry, same key
    const keys = (actions.recordSetupSubmissionAction.mock.calls as unknown as [{ idempotencyKey: string }][]).map((c) => c[0].idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(keys[1], "the retry reuses the save's key").toBe(keys[0]);
    expect(note().value, "the unrelated field holds the SAME value after the recovery").toBe("another unrelated draft");
    expect(held(), "the host adopted the version the lost submission produced").toBe("v2-own");

    await act(async () => modeButton("Second").click());
    await settle();
    expect(actions.recordBlockMachineIdentityAction).toHaveBeenCalledTimes(1);
    expect((actions.recordBlockMachineIdentityAction.mock.calls as unknown as unknown[][])[0][0]).toMatchObject({ expectedUpdatedAt: "v2-own" });
    expect(held(), "the next write succeeded").toBe("v3");
    expect(note().value).toBe("another unrelated draft");
  });

  it("NEGATIVE CONTROL: a refusal (stale) after the recovery adopts nothing and the unrelated field still holds its value", async () => {
    actions.recordBlockMachineIdentityAction.mockReset();
    actions.recordBlockMachineIdentityAction.mockResolvedValueOnce({ ok: false, code: "rejected", error: "This settings block was changed elsewhere. Reload." } as never);
    await mountHost();
    await typeNote("still here");
    await act(async () => modeButton("Second").click());
    await settle();
    expect(held()).toBe("v1");
    expect(note().value).toBe("still here");
    expect(host!.textContent).toMatch(/changed elsewhere/i);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// INSURANCE T1/T2 (#1369 9febb15ca, PEER-1369-9FEBB15CA): THE IN-SESSION HALF OF THE STALE-SNAPSHOT PROPERTY.
//
// create-mode step 11 used to prove this in a browser by clearing the machine and re-picking it. Since HON-8 a saved native area refuses a
// clear and the saved view has no entry element, so that step now reloads (a server-fresh snapshot, step 10's path) and can no longer reach a
// remount that keeps the panel's OWN in-memory snapshot. A MODE change on a saved area still remounts the entry (its key includes the mode),
// without a reload, so it is the real in-session remount: save two groups, change the mode, change back, and the entry must be seeded from the
// snapshot the post-save refresh installed. If the refresh stopped updating `ctx.recordedSetup`, the entry would offer ONE fresh g1 while the
// screen showed two probes' captures, and a change to the former g2 would be filed as a revision of g1.
// ---------------------------------------------------------------------------------------------------------------------------------
describe("an in-session remount of the entry is seeded from the snapshot the post-save refresh installed (Insurance T1, T2)", () => {
  const GROUPS_PROFILE: MachineProfile = {
    ...PROFILE,
    profileId: "fixture:groups",
    channels: { count: 2, nativeLabel: "Channel", associationRequired: false, supportsDistinctSettingGroups: true, verification: "device-confirmed", evidence: ["p"] },
  };
  const GROUPS_DEVICE: StudioDevice = { ...DEVICE, profileId: "fixture:groups" };
  const reading = (groupKey: string, fieldKey: string, value: number) => ({
    blockId: "b1",
    captureId: "cap-1",
    revision: 1,
    deviceId: "room-9",
    profileId: "fixture:groups",
    profileVersion: 1,
    modeKey: "galvanic",
    groupKey,
    channels: [groupKey === "g1" ? 1 : 2],
    stageKey: null,
    fieldKey,
    value: { kind: "value", value },
    nativeUnit: fieldKey === "current" ? "µA" : "s",
    decimals: fieldKey === "current" ? 0 : 1,
    observationSource: null,
    recordedAt: "2026-11-11T10:00:00Z",
  });
  const TWO_GROUPS = [
    reading("g1", "current", 111),
    reading("g1", "duration", 300.5),
    reading("g2", "current", 222),
    reading("g2", "duration", 300.5),
  ];
  const type = async (testid: string, value: string) => {
    const el = host!.querySelector<HTMLInputElement>(`[data-testid="${testid}"]`)!;
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      set.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const click = async (testid: string) =>
    act(async () => {
      host!.querySelector<HTMLButtonElement>(`[data-testid="${testid}"]`)!.click();
    });
  const clickMode = async (label: string) => {
    const btn = [...host!.querySelectorAll<HTMLButtonElement>('[data-testid="machine-mode-picker"] button')].find((b) => b.textContent === label)!;
    await act(async () => btn.click());
  };
  const groupsShown = () => ["g1", "g2"].map((g) => host!.querySelector(`[data-testid="setting-group-${g}"]`) !== null);

  async function saveTwoGroups() {
    actions.recordSetupSubmissionAction.mockResolvedValueOnce({ ok: true, submissionId: "sub-1", captures: 1, written: 4, reused: false } as never);
    actions.readingsForBlockAction.mockResolvedValue({ ok: true, readings: TWO_GROUPS, unitNames: {} } as never);
    actions.recordBlockMachineIdentityAction.mockResolvedValue({ ok: true, updatedAt: "v2" } as never);
    await mount({
      blockId: "b1",
      savedIdentity: { profileId: "fixture:groups", deviceId: "room-9", modeKey: "galvanic" },
      ctx: { devices: [GROUPS_DEVICE], catalogue: [GROUPS_PROFILE], recordedSetup: [] },
    });
    await click("setting-group-add");
    expect(groupsShown(), "the form offers two groups before the save").toEqual([true, true]);
    await type("reading-g1-current", "111");
    await type("reading-g1-duration", "300.5");
    await type("reading-g2-current", "222");
    await type("reading-g2-duration", "300.5");
    await click("machine-reading-save");
    expect(host!.querySelector('[data-testid="machine-reading-saved"]'), "the save is confirmed").not.toBeNull();
  }

  it("T2 (step 9's half): 'Record a setting change' right after the save offers BOTH groups, because the refresh replaced the snapshot", async () => {
    await saveTwoGroups();
    await click("machine-reading-record-change");
    expect(groupsShown(), "both recorded groups are back; a stale snapshot would offer one fresh g1").toEqual([true, true]);
  });

  it("T1 (step 11's half): a mode change and back remounts the entry IN SESSION, with no reload, and it is seeded from the refreshed snapshot", async () => {
    await saveTwoGroups();
    await clickMode("Second");
    await clickMode("Galvanic");
    expect(host!.querySelector('[data-testid="machine-reading-entry"]'), "the entry is mounted afresh for the mode").not.toBeNull();
    expect(groupsShown(), "both groups survive an in-session remount; the entry must not read a never-refreshed copy").toEqual([true, true]);
  });

  it("NEGATIVE CONTROL: with nothing recorded (a snapshot that was never refreshed) the remounted entry offers only ONE group", async () => {
    actions.recordBlockMachineIdentityAction.mockResolvedValue({ ok: true, updatedAt: "v2" } as never);
    actions.readingsForBlockAction.mockResolvedValue({ ok: true, readings: [], unitNames: {} } as never);
    await mount({
      blockId: "b1",
      savedIdentity: { profileId: "fixture:groups", deviceId: "room-9", modeKey: "galvanic" },
      ctx: { devices: [GROUPS_DEVICE], catalogue: [GROUPS_PROFILE], recordedSetup: [] },
    });
    await clickMode("Second");
    await clickMode("Galvanic");
    expect(groupsShown()).toEqual([true, false]);
  });
});
