// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

const actions = vi.hoisted(() => ({
  recordSetupSubmissionAction: vi.fn(async () => ({ ok: true })),
  readingsForBlockAction: vi.fn(async () => ({ ok: true, readings: [], unitNames: {} })),
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
  const mountExisting = async (onRevisionDraft: (d: boolean) => void) =>
    mount({
      blockId: "b1",
      savedIdentity: { profileId: "fixture:mounted", deviceId: "room-9", modeKey: "galvanic" },
      onRevisionDraft,
    });

  it("typing a value reports a draft; clearing it reports none", async () => {
    const onRevisionDraft = vi.fn();
    await mountExisting(onRevisionDraft);
    const input = host!.querySelector<HTMLInputElement>('input[inputmode="decimal"], input[type="text"], input[type="number"]');
    expect(input, "the entry's first field is mounted").not.toBeNull();
    expect(onRevisionDraft).toHaveBeenLastCalledWith(false);
    await type(input!, "120");
    expect(onRevisionDraft).toHaveBeenLastCalledWith(true);
    await type(input!, "");
    expect(onRevisionDraft).toHaveBeenLastCalledWith(false);
  });

  it("NEGATIVE CONTROL: nothing typed never reports a draft", async () => {
    const onRevisionDraft = vi.fn();
    await mountExisting(onRevisionDraft);
    expect(onRevisionDraft).not.toHaveBeenCalledWith(true);
  });

  // Codex 4480035425: a refused pick on a saved native area must not unmount the reading entry (its typed readings would be lost).
  it("a REFUSED 'Choose machine…' leaves the typed readings in place (no unmount, no remount)", async () => {
    const onRevisionDraft = vi.fn();
    await mountExisting(onRevisionDraft);
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
    actions.recordBlockMachineIdentityAction.mockRejectedValueOnce(new Error("network") as never);
    await mountExisting(vi.fn());
    const input = host!.querySelector<HTMLInputElement>('input[inputmode="decimal"], input[type="text"], input[type="number"]')!;
    await type(input, "120");
    const sel = host!.querySelector<HTMLSelectElement>('[data-testid="machine-select"]')!;
    const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
    await act(async () => {
      set.call(sel, "legacy:xcell");
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(sel.value).toBe("room-9");
    const after = host!.querySelector<HTMLInputElement>('input[inputmode="decimal"], input[type="text"], input[type="number"]')!;
    expect(after).toBe(input);
    expect(after.value).toBe("120");
    expect(host!.textContent).toMatch(/did not save/i);
  });

  // Codex 4480784741: a MODE change on a saved area is written first too. A refusal leaves the mode and the readings alone.
  const clickMode = async (label: string) => {
    const btn = [...host!.querySelectorAll<HTMLButtonElement>('[data-testid="machine-mode-picker"] button')].find((b) => b.textContent === label)!;
    await act(async () => btn.click());
  };
  const entryField = () => host!.querySelector<HTMLInputElement>('input[inputmode="decimal"], input[type="text"], input[type="number"]')!;
  it("a REFUSED mode change keeps the mode and the typed readings (same field node, same value)", async () => {
    actions.recordBlockMachineIdentityAction.mockResolvedValueOnce({ ok: false, error: "changed elsewhere" } as never);
    await mountExisting(vi.fn());
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
    await mountExisting(vi.fn());
    const input = entryField();
    await type(input, "120");
    await clickMode("Second");
    expect(entryField(), "remounted for the new mode").not.toBe(input);
  });

  it("a REFUSED pick of ANOTHER machine (stale tab) also keeps the typed readings", async () => {
    actions.recordBlockMachineIdentityAction.mockResolvedValueOnce({ ok: false, error: "changed elsewhere" } as never);
    await mountExisting(vi.fn());
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
    const onRevisionDraft = vi.fn();
    await mountExisting(onRevisionDraft);
    for (const [i, el] of fields().entries()) await type(el, String(10 + i));
    expect(onRevisionDraft).toHaveBeenLastCalledWith(true);
    await saveEntry();
    expect(host!.querySelector('[data-testid="machine-reading-saved"]'), "the saved view is showing").not.toBeNull();
    expect(onRevisionDraft).toHaveBeenLastCalledWith(false);
  });

  it("OPS (shard 1): after a CONFIRMED save a FAILED refresh keeps 'Saved', adds the plain note, and repeats nothing", async () => {
    actions.recordSetupSubmissionAction.mockClear();
    actions.recordSetupSubmissionAction.mockResolvedValueOnce({ ok: true, submissionId: "sub-1", captures: 1, written: 2, reused: false } as never);
    actions.readingsForBlockAction.mockResolvedValueOnce({ ok: false } as never);
    await mountExisting(vi.fn());
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
    await mountExisting(vi.fn());
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
    await mountExisting(vi.fn());
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
    await mountExisting(vi.fn());
    for (const [i, el] of fields().entries()) await type(el, String(10 + i));
    expect(saveButton().disabled).toBe(false);
    await saveEntry();
    expect(actions.recordSetupSubmissionAction).toHaveBeenCalledTimes(1);
  });

  it("R3-2: a DEFINITIVE refusal on the refresh shows the access notice and leaves no readings or Saved view on screen", async () => {
    actions.recordSetupSubmissionAction.mockClear();
    actions.recordSetupSubmissionAction.mockResolvedValueOnce({ ok: true, submissionId: "sub-1", captures: 1, written: 2, reused: false } as never);
    actions.readingsForBlockAction.mockResolvedValueOnce({ ok: false, refused: "access" } as never);
    await mountExisting(vi.fn());
    for (const [i, el] of fields().entries()) await type(el, String(10 + i));
    await saveEntry();
    const notice = host!.querySelector('[data-testid="machine-access-refused"]');
    expect(notice?.textContent).toBe("Saved. You no longer have access to this treatment record, so its readings are not shown.");
    expect(host!.querySelector('[data-testid="machine-reading-saved"]'), "the old entry is gone").toBeNull();
    expect(host!.querySelectorAll("input").length, "no reading field stays on screen").toBe(0);
    expect(host!.querySelector('[data-testid="machine-saved-refresh-note"]'), "not the gentle note").toBeNull();
    expect(actions.recordSetupSubmissionAction, "the save was not repeated").toHaveBeenCalledTimes(1);
  });

  it("F6-2: an UNAVAILABLE record (transient lineage error, block deleted in another tab) gets neutral wording, not an access accusation", async () => {
    actions.recordSetupSubmissionAction.mockClear();
    actions.recordSetupSubmissionAction.mockResolvedValueOnce({ ok: true, submissionId: "sub-1", captures: 1, written: 2, reused: false } as never);
    actions.readingsForBlockAction.mockResolvedValueOnce({ ok: false, refused: "unavailable" } as never);
    await mountExisting(vi.fn());
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
    await mountExisting(vi.fn());
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
    await mountExisting(vi.fn());
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
    await mountExisting(vi.fn());
    for (const [i, el] of fields().entries()) await type(el, String(10 + i));
    await saveEntry();
    expect(host!.querySelector('[data-testid="machine-access-refused"]')).toBeNull();
    expect(host!.querySelector('[data-testid="machine-reading-saved"]')).not.toBeNull();
  });

  it("NEGATIVE CONTROL: a refresh that SUCCEEDS shows Saved and no note", async () => {
    actions.recordSetupSubmissionAction.mockResolvedValueOnce({ ok: true, submissionId: "sub-1", captures: 1, written: 2, reused: false } as never);
    await mountExisting(vi.fn());
    for (const [i, el] of fields().entries()) await type(el, String(10 + i));
    await saveEntry();
    expect(host!.querySelector('[data-testid="machine-reading-saved"]')).not.toBeNull();
    expect(host!.querySelector('[data-testid="machine-saved-refresh-note"]')).toBeNull();
  });

  it("NEGATIVE CONTROL: a REFUSED save keeps the draft (it is still unsaved)", async () => {
    actions.recordSetupSubmissionAction.mockResolvedValueOnce({ ok: false, code: "rejected", error: "Refused." } as never);
    const onRevisionDraft = vi.fn();
    await mountExisting(onRevisionDraft);
    for (const [i, el] of fields().entries()) await type(el, String(10 + i));
    await saveEntry();
    expect(host!.querySelector('[data-testid="machine-reading-saved"]')).toBeNull();
    expect(onRevisionDraft).toHaveBeenLastCalledWith(true);
  });

  it("the draft is released when the entry unmounts", async () => {
    const onRevisionDraft = vi.fn();
    await mountExisting(onRevisionDraft);
    const input = host!.querySelector<HTMLInputElement>('input[inputmode="decimal"], input[type="text"], input[type="number"]')!;
    await type(input, "7");
    expect(onRevisionDraft).toHaveBeenLastCalledWith(true);
    await act(async () => root!.unmount());
    expect(onRevisionDraft).toHaveBeenLastCalledWith(false);
    root = null;
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
