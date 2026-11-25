// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

// AUTOMATIC SELECTION vs THE USER'S ENTERED LEGACY SETTINGS.
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

import { MACHINE_CATALOGUE } from "@/lib/machines/catalogue";
import type { StudioDevice } from "@/lib/machines/selection";

// ONE MODE CONTROL (HON-71), on the REAL form: MultiPlex is a fourth pill in the existing Mode group, offered under the existing xCell
// choice on a NEW area. Choosing it binds the area to the registered unit and swaps the charting fields; choosing any other pill is
// exactly today's form. Senior and Junior units, legacy-valued areas and saved areas are unaffected. Synthetic records.

const SCOPE = { studioId: "studio-synthetic", practitionerId: "pract-synthetic" };
const PUR: StudioDevice = { deviceId: "unit-pur", studioId: "studio-synthetic", profileId: "dectro-apilus:xcell-pur", profileVersion: 1, displayName: "Dectro xCell", installedOptions: [], retiredAt: null };
const SENIOR: StudioDevice = { deviceId: "unit-senior", studioId: "studio-synthetic", profileId: "dectro-apilus:senior-3g", profileVersion: 3, displayName: "Senior room", installedOptions: [], retiredAt: null };

const { createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { BlockSetupForm } = await import("@/app/(app)/clients/[id]/sessions/[sessionId]/block-setup-form");
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

async function mount(block: Record<string, unknown> | null) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(createElement(BlockSetupForm, {
      sessionId: "s1", clientId: "c1", previousBlock: null, block: block as never, firstEntry: null,
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
// THE form's Mode group only: the structured panel has its own mode buttons (data-testid machine-mode-*), which are not this control.
const pills = () =>
  Array.from(host!.querySelectorAll<HTMLButtonElement>("button")).filter(
    (b) => ["Thermolysis", "Blend", "Galvanic", "MultiPlex"].includes(b.textContent?.trim() ?? "") && !(b.getAttribute("data-testid") ?? "").startsWith("machine-mode-"),
  );
const pillLabels = () => pills().map((b) => b.textContent!.trim());
const multiplexPill = () => host!.querySelector<HTMLButtonElement>('[data-testid="mode-multiplex"]');
const legacyFieldsShown = () => host!.textContent!.includes("Machine frequency");
const clickMultiplex = () => act(async () => { multiplexPill()!.click(); });
const clickPill = (label: string) => act(async () => { pills().find((b) => b.textContent?.trim() === label)!.click(); });

ctxBox.ctx = { ...CTX };

describe("MultiPlex in the ONE Mode control (new area)", () => {
  it("no machine chosen: the form is today's (three pills, legacy fields), no MultiPlex and no second selector", async () => {
    await mount(null);
    await openPanel();
    expect(pillLabels()).toEqual(["Thermolysis", "Blend", "Galvanic"]);
    expect(legacyFieldsShown()).toBe(true);
    expect(multiplexPill()).toBeNull();
    expect(host!.querySelector('[data-testid="xcell-mode-select"]')).toBeNull();
  });

  it("the xCell choice offers MultiPlex as a fourth pill; the other three are exactly today's form", async () => {
    await mount(null);
    await openPanel();
    await pick("legacy:xcell");
    expect(pillLabels()).toEqual(["Thermolysis", "Blend", "Galvanic", "MultiPlex"]);
    expect(multiplexPill()!.getAttribute("aria-pressed")).toBe("false");
    expect(legacyFieldsShown()).toBe(true);
    await clickPill("Thermolysis");
    expect(legacyFieldsShown()).toBe(true);
    expect(actions.recordBlockMachineIdentityAction).not.toHaveBeenCalled();
  });

  it("choosing MultiPlex binds the routed unit (the selector still reads xCell) and swaps the legacy fields for the structured ones", async () => {
    await mount(null);
    await openPanel();
    await pick("legacy:xcell");
    await clickMultiplex();
    expect(host!.querySelector<HTMLSelectElement>('[data-testid="machine-select"]')!.value).toBe("legacy:xcell");
    expect(multiplexPill()!.getAttribute("aria-pressed")).toBe("true");
    expect(pillLabels()).toEqual(["Thermolysis", "Blend", "Galvanic", "MultiPlex"]);
    expect(legacyFieldsShown(), "the old frequency/modality/readings are replaced").toBe(false);
    expect(host!.querySelector('[data-testid="machine-chosen"]')?.textContent).toContain("Dectro xCell");
    expect(host!.querySelector('[data-testid="machine-chosen"]')?.textContent).not.toMatch(/xCell Pur/i);
  });

  it("choosing another pill afterwards returns to today's form, with MultiPlex off", async () => {
    await mount(null);
    await openPanel();
    await pick("legacy:xcell");
    await clickMultiplex();
    await clickPill("Blend");
    expect(legacyFieldsShown()).toBe(true);
    expect(multiplexPill()!.getAttribute("aria-pressed")).toBe("false");
  });

  it(`Thermolysis typed, then MultiPlex, then Blend: BLEND is the mode, never the parked Thermolysis; Thermolysis keeps what was typed under it`, async () => {
      await mount(null);
      await openPanel();
      await pick("legacy:xcell");
      await clickPill("Thermolysis");
      const setValue = (el: HTMLInputElement, v: string) => act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, v);
        el.dispatchEvent(new Event("input", { bubbles: true }));
      });
      const intensity = () => Array.from(host!.querySelectorAll<HTMLLabelElement>("label")).find((l) => l.textContent?.includes("Thermolysis intensity"))!.querySelector("input") as HTMLInputElement;
      await setValue(intensity(), "42");
      await clickMultiplex();
      await clickPill("Blend");
      const selected = () => pills().filter((b) => b.className.includes("bg-neutral-900")).map((b) => b.textContent!.trim());
      expect(selected(), "the clicked mode is the one selected").toEqual(["Blend"]);
      await clickPill("Thermolysis");
      expect(selected()).toEqual(["Thermolysis"]);
      expect(intensity().value, "Thermolysis keeps what was typed under it").toBe("42");
  });

  it("no route (contract not published, no unit): the xCell choice offers no MultiPlex", async () => {
    ctxBox.ctx = { ...CTX, multiplexRoute: null };
    await mount(null);
    await openPanel();
    await pick("legacy:xcell");
    expect(pillLabels()).toEqual(["Thermolysis", "Blend", "Galvanic"]);
  });
});

describe("Junior and Senior are exactly what they were", () => {
  it("a Senior unit shows its structured form and neither the Mode group nor a MultiPlex pill; the route never touches it", async () => {
    await mount(null);
    await openPanel();
    await pick("unit-senior");
    expect(multiplexPill()).toBeNull();
    expect(pillLabels()).toEqual([]);
    expect(legacyFieldsShown()).toBe(false);
    // Moving between a Senior and the xCell never leaves a stale MultiPlex behind.
    await pick("legacy:xcell");
    expect(multiplexPill()!.getAttribute("aria-pressed")).toBe("false");
    await clickMultiplex();
    await pick("unit-senior");
    expect(multiplexPill()).toBeNull();
    expect(pillLabels()).toEqual([]);
  });
});

describe("saved areas", () => {
  it("an area already holding xCell values never offers MultiPlex (today's refusal stands)", async () => {
    await mount({ ...BLOCK, mode: "thermo", machine_profile_id: "dectro-apilus:xcell" });
    await openPanel();
    expect(multiplexPill()).toBeNull();
    expect(pillLabels()).toEqual(["Thermolysis", "Blend", "Galvanic"]);
    expect(legacyFieldsShown()).toBe(true);
  });

  it("P2: after the machine of a saved MultiPlex area is changed and written, MultiPlex is no longer treated as saved", async () => {
    actions.recordBlockMachineIdentityAction.mockResolvedValueOnce({ ok: true, identity: { profileId: "dectro-apilus:senior-3g", deviceId: "unit-senior", modeKey: "standard" } } as never);
    await mount({ ...BLOCK, studio_machine_id: "unit-pur", machine_mode_key: "multiplex" });
    await act(async () => { await Promise.resolve(); });
    expect(multiplexPill()!.disabled).toBe(true);
    await openPanel();
    await pick("unit-senior");
    await act(async () => { await Promise.resolve(); });
    // The record now holds the Senior unit: the stale "saved as MultiPlex" state must not linger as a frozen, pressed pill.
    expect(multiplexPill(), "no frozen MultiPlex pill after the machine changed").toBeNull();
    expect(pillLabels()).toEqual([]);
  });
  it("an area saved as MultiPlex shows it selected and frozen in the same Mode control, with the other modes unavailable", async () => {
    await mount({ ...BLOCK, studio_machine_id: "unit-pur", machine_mode_key: "multiplex" });
    await act(async () => { await Promise.resolve(); });
    expect(multiplexPill()!.getAttribute("aria-pressed")).toBe("true");
    expect(multiplexPill()!.disabled).toBe(true);
    expect(pills().every((b) => b.disabled)).toBe(true);
    expect(legacyFieldsShown()).toBe(false);
  });
});
