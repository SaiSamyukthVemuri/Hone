// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

// AUTOMATIC SELECTION vs THE USER'S ENTERED LEGACY SETTINGS (Codex #1369 4506474412, Insurance final448; census CENSUS-AUTO-SELECT-1369.md).
// The REAL form, the real connected wrapper and panel, one mocked loader. Synthetic records.
const nav = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: nav.replace, push: nav.push, refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/clients/c1/sessions/s1",
}));
const ctxBox = vi.hoisted(() => ({ ctx: null as unknown }));
const actions = vi.hoisted(() => ({
  loadMachineSetupContext: vi.fn(async () => ctxBox.ctx),
  lookupAreaCreateClaimAction: vi.fn(async () => ({ ok: true, status: "absent" })),
  recordSetupSubmissionAction: vi.fn(async () => ({ ok: true })),
  readingsForBlockAction: vi.fn(async () => ({ ok: true, readings: [], unitNames: {} })),
  recordBlockMachineIdentityAction: vi.fn(async () => ({ ok: true })),
  rememberMachineSelectionAction: vi.fn(async () => ({ ok: true })),
  clearMachineSelectionAction: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/app/(app)/clients/[id]/sessions/[sessionId]/machine-setup-actions", () => actions);
vi.mock("@/app/(app)/clients/[id]/sessions/[sessionId]/block-actions", () => ({
  updateTreatmentAreaWithEntryAction: vi.fn(),
  createTreatmentAreaWithEntryAction: vi.fn(),
}));

import type { MachineProfile } from "@/lib/machines/profile-contract";
import type { StudioDevice } from "@/lib/machines/selection";

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

const { createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { BlockSetupForm } = await import("@/app/(app)/clients/[id]/sessions/[sessionId]/block-setup-form");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CTX = {
  scope: SCOPE,
  devices: [DEVICE],
  inventoryReason: null,
  remembered: { deviceId: "room-9", modeKey: "galvanic" } as unknown,
  rememberedUnavailable: null as unknown,
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
  clientLastMachine: null,
  legacyMachine: { profileId: "dectro-apilus:xcell", label: "Dectro xCell" },
};
const BLOCK = {
  id: "b1", studio_id: "st1", session_id: "s1", sort_order: 1, mode: null, apilus_modality: null, energy_level: null, minutes_performed: null,
  machine_frequency: null as string | null, primary_area: "Upper lip", side: "center", custom_area_detail: null, probe_key: null, probe_lot_number: null,
  probe_lot_confirmed: false, block_notes: null, machine_profile_id: null, studio_machine_id: null, machine_mode_key: null,
  updated_at: "2026-11-06T10:00:00.000Z", deleted_at: null,
};

let root: ReturnType<typeof createRoot> | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = null;
  ctxBox.ctx = { ...CTX };
  vi.clearAllMocks();
});

async function mount(o: { existing: boolean; persistedFrequency?: string | null; defaultFrequency?: string | null }) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      createElement(BlockSetupForm, {
        sessionId: "s1",
        clientId: "c1",
        previousBlock: null,
        block: o.existing ? ({ ...BLOCK, machine_frequency: o.persistedFrequency ?? null } as never) : null,
        firstEntry: null,
        initialAreas: [{ area: "Upper lip", side: "center" }] as never,
        defaultMachineFrequency: o.defaultFrequency ?? null,
        onCancel: () => undefined,
      }),
    );
  });
}
const clickText = (text: string) =>
  act(async () => {
    Array.from(host!.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent?.trim() === text)!.click();
  });
const openPanel = () =>
  act(async () => {
    host!.querySelector<HTMLButtonElement>('[data-testid="machine-first-open"]')!.click();
  });
const selectValue = () => host!.querySelector<HTMLSelectElement>('[data-testid="machine-select"]')?.value;
const legacyFieldsShown = () => host!.textContent!.includes("Machine frequency");
const freqSelected = (f: string) =>
  Array.from(host!.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent?.trim() === f)!.className.includes("bg-neutral-900");

ctxBox.ctx = { ...CTX };

describe("an EXISTING area with no saved unit: automatic selection yields to entered legacy settings", () => {
  it("entered frequency + remembered native machine: NOTHING is selected, the entered value stays, the legacy fields stay", async () => {
    await mount({ existing: true });
    await clickText("13.56 MHz");
    expect(freqSelected("13.56 MHz"), "control: entered").toBe(true);
    await openPanel();
    expect(selectValue(), "no machine was chosen on her behalf").toBe("");
    expect(host!.querySelector('[data-testid="machine-reading-entry"]')).toBeNull();
    expect(legacyFieldsShown(), "the kind switch did not run").toBe(true);
    expect(freqSelected("13.56 MHz"), "her entered value was not cleared").toBe(true);
    expect(actions.recordBlockMachineIdentityAction).not.toHaveBeenCalled();
  });

  it("F2: a PERSISTED frequency equal to the studio default counts as entered: nothing selected", async () => {
    await mount({ existing: true, persistedFrequency: "13.56 MHz", defaultFrequency: "13.56 MHz" });
    await openPanel();
    expect(selectValue()).toBe("");
    expect(legacyFieldsShown()).toBe(true);
    expect(freqSelected("13.56 MHz")).toBe(true);
  });

  it("F2 (remount): a fresh mount with the entered value persisted stays held", async () => {
    await mount({ existing: true, persistedFrequency: "13.56 MHz", defaultFrequency: "13.56 MHz" });
    await openPanel();
    act(() => root!.unmount());
    host!.remove();
    await mount({ existing: true, persistedFrequency: "13.56 MHz", defaultFrequency: "13.56 MHz" });
    await openPanel();
    expect(selectValue()).toBe("");
    expect(legacyFieldsShown()).toBe(true);
  });

  it("NOTHING entered: the remembered machine still auto-selects, as before (fallback unchanged)", async () => {
    await mount({ existing: true });
    await openPanel();
    expect(selectValue()).toBe("room-9");
    expect(legacyFieldsShown(), "a native machine in force hides the legacy fields").toBe(false);
  });

  it("a prefilled studio default that is NOT persisted is not entered work: the remembered machine still auto-selects", async () => {
    await mount({ existing: true, defaultFrequency: "13.56 MHz" });
    await openPanel();
    expect(selectValue()).toBe("room-9");
  });

  it("F3: while held the retired remembered-machine note is not shown (nothing was selected)", async () => {
    ctxBox.ctx = { ...CTX, remembered: null, rememberedUnavailable: { deviceId: "gone-1", reason: "That machine was retired." } };
    await mount({ existing: true });
    await clickText("13.56 MHz");
    await openPanel();
    expect(host!.querySelector('[data-testid="machine-selection-not-remembered"]')).toBeNull();
  });
});

describe("a NEW area", () => {
  it("entered values hold the remembered machine too (regression of 4479490063)", async () => {
    await mount({ existing: false });
    await clickText("13.56 MHz");
    await openPanel();
    expect(selectValue()).toBe("");
    expect(freqSelected("13.56 MHz")).toBe(true);
  });

  it("F1: an EXPLICIT native pick with entered values still clears them, and the panel and the host AGREE (native, legacy fields gone)", async () => {
    await mount({ existing: false });
    await clickText("13.56 MHz");
    await openPanel();
    const sel = host!.querySelector<HTMLSelectElement>('[data-testid="machine-select"]')!;
    const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
    await act(async () => {
      set.call(sel, "room-9");
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(selectValue(), "the panel shows the native machine").toBe("room-9");
    expect(legacyFieldsShown(), "and the host agrees: its legacy fields are gone").toBe(false);
  });
});
