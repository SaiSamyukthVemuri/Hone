// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

// WHAT A NEW AREA SENDS AFTER MULTIPLEX, AND WHAT IS PARKED FOR WHICH IDENTITY (Insurance mutants M1, M2, M6, M7, M9 on #1790).
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
const blockActions = vi.hoisted(() => ({
  updateTreatmentAreaWithEntryAction: vi.fn(),
  createTreatmentAreaWithEntryAction: vi.fn(async () => ({ ok: false, error: "stand-in: the payload is what is under test" })),
}));
vi.mock("@/app/(app)/clients/[id]/sessions/[sessionId]/block-actions", () => blockActions);

import { readFileSync } from "node:fs";
import { MACHINE_CATALOGUE } from "@/lib/machines/catalogue";
import type { StudioDevice } from "@/lib/machines/selection";

// ONE MODE CONTROL, on the REAL form: MultiPlex is a fourth pill in the existing Mode group, offered under the existing xCell
// choice on a NEW area. Choosing it binds the area to the registered unit and swaps the charting fields; choosing any other pill is
// exactly today's form. Senior and Junior units, legacy-valued areas and saved areas are unaffected. Synthetic records.

const SCOPE = { studioId: "studio-synthetic", practitionerId: "pract-synthetic" };
const PUR: StudioDevice = { deviceId: "unit-pur", studioId: "studio-synthetic", profileId: "dectro-apilus:xcell-pur", profileVersion: 1, displayName: "Dectro xCell", installedOptions: [], retiredAt: null };
const SENIOR: StudioDevice = { deviceId: "unit-senior", studioId: "studio-synthetic", profileId: "dectro-apilus:senior-3g", profileVersion: 3, displayName: "Senior room", installedOptions: [], retiredAt: null };

const { createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { BlockSetupForm } = await import("@/app/(app)/clients/[id]/sessions/[sessionId]/block-setup-form");
const { ChartingViewContext } = await import("@/components/charting-view-context");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CTX = {
  scope: SCOPE, devices: [PUR, SENIOR], inventoryReason: null, remembered: null as unknown, rememberedUnavailable: null as unknown,
  persistence: { kind: "database", persisted: true }, catalogue: MACHINE_CATALOGUE, canManageMachines: false, priorSetup: [], recordedSetup: [],
  priorSetupUnavailable: false, recordedSetupUnavailable: false, unitNames: {}, suggestedMachine: null, restoredSelection: null, clientLastMachine: null,
  legacyMachine: { profileId: "dectro-apilus:xcell", label: "Dectro xCell" },
  multiplexRoute: { deviceId: "unit-pur", modeKey: "multiplex" } as unknown,
};
const BLOCK = {
  id: "b1", studio_id: "st1", session_id: "s1", sort_order: 1, mode: null as string | null, apilus_modality: null, energy_level: null, minutes_performed: null,
  machine_frequency: null as string | null, primary_area: "Upper lip", side: "center", custom_area_detail: null, probe_key: null, probe_lot_number: null,
  probe_lot_confirmed: false, block_notes: null, machine_profile_id: null as string | null, studio_machine_id: null as string | null, machine_mode_key: null as string | null,
  updated_at: "2026-11-06T10:00:00.000Z", deleted_at: null,
};

let root: ReturnType<typeof createRoot> | null = null;
let host: HTMLElement | null = null;
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = host = null; ctxBox.ctx = { ...CTX }; vi.clearAllMocks(); });

ctxBox.ctx = { ...CTX };
const BLOCK_NONE = null;
async function mount() {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(createElement(BlockSetupForm, {
      sessionId: "s1", clientId: "c1", previousBlock: null, block: BLOCK_NONE as never, firstEntry: null,
      initialAreas: [{ area: "Upper lip", side: "center" }] as never, defaultMachineFrequency: null, onCancel: () => undefined,
    }));
  });
}
const openPanel = () => act(async () => { host!.querySelector<HTMLButtonElement>('[data-testid="machine-first-open"]')?.click(); });
const pick = (value: string) => act(async () => {
  const sel = host!.querySelector<HTMLSelectElement>('[data-testid="machine-select"]')!;
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(sel, value);
  sel.dispatchEvent(new Event("change", { bubbles: true }));
});
const click = (el: Element | null) => act(async () => { (el as HTMLElement).click(); });
const setValue = (el: HTMLInputElement, v: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, v);
  el.dispatchEvent(new Event("input", { bubbles: true }));
});
const pill = (label: string) => Array.from(host!.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent?.trim() === label && !(b.getAttribute("data-testid") ?? "").startsWith("machine-mode-"))!;
const labelled = (text: string) => {
  const l = Array.from(host!.querySelectorAll<HTMLLabelElement>("label")).find((x) => x.textContent?.includes(text) && x.querySelector("input"));
  if (!l) throw new Error(`no input labelled ${text}`);
  return l.querySelector("input") as HTMLInputElement;
};
const draftInputs = () => Array.from(host!.querySelectorAll<HTMLInputElement>('[data-testid="machine-setting-draft"] input')).filter((i) => i.type !== "hidden" && i.type !== "checkbox");
const firstDraftValue = () => draftInputs().find((i) => i.type === "number" && i.value !== "")?.value ?? "";

describe("a NEW area saved on MultiPlex after Thermolysis was typed (M1, M2)", () => {
  it("the create carries NO mode, modality, energy level or legacy reading; the shared entries (areas, minutes) still travel", async () => {
    await mount();
    await openPanel();
    await pick("legacy:xcell");
    await click(pill("Thermolysis"));
    await setValue(labelled("Thermolysis intensity"), "42");
    await setValue(labelled("Thermolysis duration"), "1.5");
    await setValue(labelled("Energy level"), "9");
    await setValue(labelled("Minutes performed"), "12");
    await click(Array.from(host!.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent?.trim() === "Chin")!);
    await click(host!.querySelector('[data-testid="mode-multiplex"]'));
    await click(host!.querySelector('[data-testid="save-treatment-area"]'));
    expect(blockActions.createTreatmentAreaWithEntryAction).toHaveBeenCalledTimes(1);
    const sent = (blockActions.createTreatmentAreaWithEntryAction.mock.calls[0] as unknown[])[0] as Record<string, unknown> & { readings: Record<string, unknown> };
    expect(sent.mode, "M1").toBeNull();
    expect(sent.apilusModality).toBeNull();
    expect(sent.energyLevel).toBeNull();
    for (const k of ["thermolysisIntensityPercent", "thermolysisDurationSeconds", "galvanicMa", "galvanicDurationSeconds", "unitsOfLye", "pulseCount", "pulseDelaySeconds"]) {
      expect(sent.readings[k], `M2: legacy reading ${k} is not sent under MultiPlex`).toBeNull();
    }
    expect(sent.minutesPerformed, "a shared entry still travels").toBe(12);
    expect((sent.areas as Array<{ area: string }>).map((a) => a.area), "the chosen area travels").toContain("Chin");
  });
});

describe("Save pressed while the leave-MultiPlex request is HELD (M1, behavioural)", () => {
  it("a legacy pill click sets the draft's mode while the preference write is still settling (the kind is still native): the create still carries NO mode", async () => {
    await mount();
    await openPanel();
    await pick("legacy:xcell");
    await click(pill("Thermolysis"));
    await setValue(labelled("Thermolysis intensity"), "42");
    await click(Array.from(host!.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent?.trim() === "27.12 MHz")!);
    // the MultiPlex pick's preference write never settles, so the panel holds the next request (machine-first-setup-panel.tsx: `if (selectionPending) return;`)
    actions.rememberMachineSelectionAction.mockImplementationOnce(() => new Promise(() => undefined) as never);
    await click(host!.querySelector('[data-testid="mode-multiplex"]'));
    await click(pill("Blend"));
    // the form's draft now says Blend while the panel is still native; Save is not disabled by a pending PREFERENCE write
    await click(Array.from(host!.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent?.trim() === "Chin")!);
    await click(host!.querySelector('[data-testid="save-treatment-area"]'));
    expect(blockActions.createTreatmentAreaWithEntryAction).toHaveBeenCalledTimes(1);
    const sent = (blockActions.createTreatmentAreaWithEntryAction.mock.calls[0] as unknown[])[0] as Record<string, unknown> & { readings: Record<string, unknown> };
    expect(sent.mode, "M1: the held request cannot leak the legacy mode into a native create").toBeNull();
    expect(sent.apilusModality).toBeNull();
    expect(sent.machineFrequency, "the parked frequency restored by the Blend click is not sent under a native machine").toBeNull();
    expect(sent.energyLevel).toBeNull();
    expect(sent.readings.pulseDelaySeconds).toBeNull();
    expect(sent.readings.pulseCount).toBeNull();
    expect(sent.readings.thermolysisIntensityPercent).toBeNull();
  });
});

describe("what is parked belongs to ONE identity: unit, profile, version AND mode (M7, M9)", () => {
  it("two modes of one unit: values typed in each come back to their own mode, never the other's", async () => {
    ctxBox.ctx = { ...CTX };
    await mount();
    await openPanel();
    await pick("unit-senior");
    await click(host!.querySelector('[data-testid="machine-mode-flash"]'));
    const a = draftInputs().find((i) => i.type === "number")!;
    await setValue(a, "11");
    await click(host!.querySelector('[data-testid="machine-mode-microflash"]'));
    expect(firstDraftValue(), "a different mode starts empty (nothing is carried across)").toBe("");
    await setValue(draftInputs().find((i) => i.type === "number")!, "22");
    await click(host!.querySelector('[data-testid="machine-mode-flash"]'));
    expect(firstDraftValue(), "Flash gets its own 11 back").toBe("11");
    await click(host!.querySelector('[data-testid="machine-mode-microflash"]'));
    expect(firstDraftValue(), "MicroFlash gets its own 22 back").toBe("22");
  });
  it("two units: the Senior's parked value and the xCell's MultiPlex value are never swapped", async () => {
    await mount();
    await openPanel();
    await pick("unit-senior");
    await click(host!.querySelector('[data-testid="machine-mode-flash"]'));
    await setValue(draftInputs().find((i) => i.type === "number")!, "33");
    await pick("legacy:xcell");
    await click(host!.querySelector('[data-testid="mode-multiplex"]'));
    await setValue(draftInputs().find((i) => i.type === "number")!, "44");
    await pick("unit-senior");
    await click(host!.querySelector('[data-testid="machine-mode-flash"]'));
    expect(firstDraftValue(), "the Senior's own value").toBe("33");
    await pick("legacy:xcell");
    await click(host!.querySelector('[data-testid="mode-multiplex"]'));
    expect(firstDraftValue(), "the xCell's own value").toBe("44");
  });
});

describe("saving the area drops what was parked for it (M6)", () => {
  it("once the area has a block (saved) the park is cleared: coming back to a new area shows nothing from before", async () => {
    await mount();
    await openPanel();
    await pick("unit-senior");
    await click(host!.querySelector('[data-testid="machine-mode-flash"]'));
    await setValue(draftInputs().find((i) => i.type === "number")!, "55");
    await pick("legacy:xcell"); // the Senior draft is parked under its own identity
    const rerender = (block: Record<string, unknown> | null) => act(async () => {
      root!.render(createElement(BlockSetupForm, {
        sessionId: "s1", clientId: "c1", previousBlock: null, block: block as never, firstEntry: null,
        initialAreas: [{ area: "Upper lip", side: "center" }] as never, defaultMachineFrequency: null, onCancel: () => undefined,
      }));
    });
    await rerender(BLOCK); // the area is saved: a block exists, so the park dies with it
    await rerender(null); // and a NEW area in the same panel starts clean
    await pick("unit-senior");
    await click(host!.querySelector('[data-testid="machine-mode-flash"]'));
    expect(firstDraftValue(), "nothing parked before the save comes back").toBe("");
  });
});

describe("the create guard's mode line (M1) is defence in depth, so it is pinned by source", () => {
  it("the create payload's mode, modality and energy level are each gated on the native kind", () => {
    // Under a native machine the switch has already cleared the draft's mode (the Mode pills EXIT MultiPlex, they never set a mode beside it),
    // so a behavioural test cannot tell this line from its absence. The guard exists for the paths that reach the save with a stale draft.
    const FORM = readFileSync("app/(app)/clients/[id]/sessions/[sessionId]/block-setup-form.tsx", "utf8");
    expect(FORM).toMatch(/mode: nativeCreate \? null : \(\(draft\.mode \|\| null\) as ElectrolysisMode \| null\),/);
    expect(FORM).toMatch(/apilusModality: nativeCreate \? null : \(\(draft\.apilusModality \|\| null\) as ApilusModality \| null\),/);
    expect(FORM).toMatch(/energyLevel: nativeCreate \? null : elNum,/);
  });
});
