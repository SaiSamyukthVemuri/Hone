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
  const { ctx: ctxOverride, ...rest } = extra as { ctx?: Record<string, unknown> };
  const load = vi.fn(async () => ({ ...CTX, ...(ctxOverride ?? {}) }));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      createElement(MachineFirstSetupConnected, { clientId: "c", sessionId: "s", load, ...rest } as never),
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
      root!.render(createElement(MachineFirstSetupConnected, { clientId: "c", sessionId: "s", blockId: null, onIdentityDraft, savedIdentity: null, onSettingDraft: vi.fn(), load: vi.fn(async () => CTX) } as never));
    });
    // The LAST thing the host heard is what its Save records: the panel's own resolution pass must not clear it.
    expect(onIdentityDraft.mock.calls.at(-1)?.[0]).toEqual({ deviceId: null, modeKey: null, profileId: "dectro-apilus:xcell" });
  });
});

// ===========================================================================
// THE PANEL TRACKS ITS OWN SUCCESSFUL IDENTITY WRITES (Codex, #1369 4475581937; Photos R2)
// ===========================================================================
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
