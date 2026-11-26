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
import { multiplexPill as multiplexPillOf, ensureThermolysis, modalitySelect } from "./helpers/multiplex-modality";

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

async function mount(block: Record<string, unknown> | null, offer?: { deviceId: string } | null) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(createElement(BlockSetupForm, {
      sessionId: "s1", clientId: "c1", previousBlock: null, block: block as never, firstEntry: null,
      initialAreas: [{ area: "Upper lip", side: "center" }] as never, defaultMachineFrequency: null, onCancel: () => undefined,
      // the page reads the offer on the server and hands it down, so the pill is there from the first visit.
      ...(offer === undefined ? {} : { multiplexOffer: offer }),
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
// The MultiPlex pill carries a small "xCell Pur" model label; its NAME is the text before it.
const pillName = (b: HTMLButtonElement) => b.textContent?.trim() ?? "";
const pills = () =>
  Array.from(host!.querySelectorAll<HTMLButtonElement>("button")).filter(
    (b) => ["Thermolysis", "Blend", "Galvanic"].includes(pillName(b)) && !(b.getAttribute("data-testid") ?? "").startsWith("machine-mode-"),
  );
const pillLabels = () => pills().map(pillName);
const multiplexPill = () => multiplexPillOf(host!);
const multiplexOn = () => multiplexPill()?.getAttribute("aria-pressed") === "true";
// The way out of MultiPlex that stays on Thermolysis: another modality (here the empty choice).
const leaveMultiplex = () => act(async () => { multiplexPill()!.click(); });
const legacyFieldsShown = () => host!.textContent!.includes("Machine frequency");
const clickMultiplex = async () => { await ensureThermolysis(host!); await act(async () => { multiplexPill()!.click(); }); };
const clickPill = (label: string) => act(async () => { pills().find((b) => pillName(b) === label)!.click(); });

ctxBox.ctx = { ...CTX };

describe("MultiPlex in the ONE Mode control (new area)", () => {
  it("no machine chosen and MultiPlex NOT offered to the studio: the form is today's (three pills, legacy fields), no MultiPlex and no second selector", async () => {
    ctxBox.ctx = { ...CTX, multiplexRoute: null };
    await mount(null);
    await openPanel();
    expect(pillLabels()).toEqual(["Thermolysis", "Blend", "Galvanic"]);
    expect(legacyFieldsShown()).toBe(true);
    expect(multiplexPill()).toBeNull();
    expect(host!.querySelector('[data-testid="xcell-mode-select"]')).toBeNull();
  });

  it("no machine chosen, MultiPlex offered: there is NO fourth pill; MultiPlex is under Thermolysis's Modality choice from the first visit, labelled xCell Pur, with the panel still closed", async () => {
    await mount(null, { deviceId: "unspecified:xcell-pur" });
    expect(host!.querySelector('[data-testid="machine-first-open"]')).toBeTruthy();
    expect(pillLabels()).toEqual(["Thermolysis", "Blend", "Galvanic"]);
    expect(host!.querySelector('[data-testid="mode-multiplex"]'), "the standalone pill is gone").toBeNull();
    expect(multiplexPill(), "no Modality choice until Thermolysis is chosen").toBeNull();
    await ensureThermolysis(host!);
    expect(multiplexPill()!.textContent).toContain("xCell Pur");
    expect(multiplexOn()).toBe(false);
    expect(legacyFieldsShown()).toBe(true);
    expect(actions.loadMachineSetupContext).not.toHaveBeenCalled();
  });

  it("the xCell choice offers MultiPlex under Thermolysis only; Blend and Galvanic have none and the form is exactly today's", async () => {
    await mount(null);
    await openPanel();
    await pick("legacy:xcell");
    expect(pillLabels()).toEqual(["Thermolysis", "Blend", "Galvanic"]);
    await clickPill("Blend");
    expect(multiplexPill(), "Blend's modalities carry no MultiPlex").toBeNull();
    await clickPill("Galvanic");
    expect(multiplexPill()).toBeNull();
    await clickPill("Thermolysis");
    expect(multiplexOn()).toBe(false);
    expect(legacyFieldsShown()).toBe(true);
    expect(Array.from(modalitySelect(host!)!.options).map((o) => o.value)).toEqual(["", "Picoflash", "Meloflash", "Multiplex", "Synchro", "Microflash", "Thermoflash"]);
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
    const readings = host!.querySelector('section[aria-label="Treatment readings"]')!;
    expect(readings.querySelector('[data-testid="machine-setting-draft"]')).toBeTruthy();
    expect(readings.textContent).toContain("Pulse count");
    expect(host!.querySelectorAll('[data-testid="machine-setting-draft"]')).toHaveLength(1);
    expect(pillLabels()).toEqual(["Thermolysis", "Blend", "Galvanic"]);
    expect(pills().filter((b) => b.className.includes("bg-neutral-900")).map(pillName), "Thermolysis stays the pressed mode while MultiPlex is chosen").toEqual(["Thermolysis"]);
    expect(modalitySelect(host!)!.value).toBe("Multiplex");
    expect(legacyFieldsShown(), "the old frequency/readings are replaced").toBe(false);
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
    expect(multiplexOn()).toBe(false);
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

  // ENABLING A STUDIO makes the Current/New toggle visible (the per-studio rollout, ChartingViewContext.rolloutOn): the chart's form code is the same, so
  // the same round trip must hold there. It deliberately does NOT assert what Blend shows (it carries the typed value, as it does today for every studio).
  it("the same round trip with the studio's rollout ON (New view available): Thermolysis 42, MultiPlex, Blend, back to Thermolysis shows 42 and Blend is the selected mode", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(createElement(ChartingViewContext.Provider, { value: { view: "new", setView: () => undefined, notice: null, rolloutOn: true } as never },
        createElement(BlockSetupForm, {
          sessionId: "s1", clientId: "c1", previousBlock: null, block: null, firstEntry: null,
          initialAreas: [{ area: "Upper lip", side: "center" }] as never, defaultMachineFrequency: null, onCancel: () => undefined,
        })));
    });
    await openPanel();
    await pick("legacy:xcell");
    await clickPill("Thermolysis");
    const intensity = () => Array.from(host!.querySelectorAll<HTMLLabelElement>("label")).find((l) => l.textContent?.includes("Thermolysis intensity"))!.querySelector("input") as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(intensity(), "42");
      intensity().dispatchEvent(new Event("input", { bubbles: true }));
    });
    await clickMultiplex();
    await clickPill("Blend");
    const selected = () => pills().filter((b) => b.className.includes("bg-neutral-900")).map((b) => b.textContent!.trim());
    expect(selected()).toEqual(["Blend"]);
    await clickPill("Thermolysis");
    expect(selected()).toEqual(["Thermolysis"]);
    expect(intensity().value).toBe("42");
  });

  // CODEX #1790: the parked Thermolysis snapshot must never be restored OVER a value typed after it was parked. Clearing the machine ("Choose machine…")
  // shows the legacy fields again; whatever she types there is newer than the parked 42, so a later return to the existing xCell keeps it.
  it("parked 42, MultiPlex, machine cleared, 40 typed in the legacy fields, xCell chosen again: 40 stays (the parked 42 is never restored over it)", async () => {
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
    await pick("");
    // the legacy fields are editable again (no machine): make sure Thermolysis is the mode, then type the NEWER value
    const selected = () => pills().filter((b) => b.className.includes("bg-neutral-900")).map((b) => b.textContent!.trim());
    if (!selected().includes("Thermolysis")) await clickPill("Thermolysis");
    await setValue(intensity(), "40");
    await pick("legacy:xcell");
    expect(intensity().value, "the newer value is not overwritten by the parked one").toBe("40");
    await clickMultiplex();
    await leaveMultiplex();
    expect(intensity().value, "and a MultiPlex round trip afterwards still returns what is typed now").toBe("40");
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
    expect(multiplexOn()).toBe(false);
    await clickMultiplex();
    await pick("unit-senior");
    expect(multiplexPill()).toBeNull();
    expect(pillLabels()).toEqual([]);
  });
});

// PLACEMENT PIN: only the ROUTED unit in the ROUTED mode (MultiPlex) is moved under Mode > Treatment readings. Any other native choice keeps its settings in
// the Machine panel. Dropping the deviceId or the modeKey condition in the panel's placeReadings moves these too, and these fail.
describe("the readings placement is for MultiPlex only", () => {
  const inReadings = () => host!.querySelector('section[aria-label="Treatment readings"] [data-testid="machine-setting-draft"]');
  const inPanel = () => host!.querySelector('[data-testid="machine-first-panel"] [data-testid="machine-setting-draft"]');
  it("a Senior 3G unit's structured settings stay in the Machine panel and nothing is placed under Treatment readings", async () => {
    await mount(null);
    await openPanel();
    await pick("unit-senior");
    expect(inReadings()).toBeNull();
    expect(inPanel()).toBeTruthy();
    expect(host!.querySelectorAll('[data-testid="machine-setting-draft"]')).toHaveLength(1);
  });
  // Each condition is pinned ALONE: the route is set so that exactly one of (unit, mode) matches the Senior unit's panel, so dropping either condition
  // moves the Senior's settings under Treatment readings and one of these fails.
  it("the SAME MODE KEY (a Senior flash mode) on another unit is not placed (the unit condition alone holds it back)", async () => {
    ctxBox.ctx = { ...CTX, multiplexRoute: { deviceId: "unit-pur", modeKey: "flash" } };
    await mount(null);
    await openPanel();
    await pick("unit-senior");
    expect(inReadings()).toBeNull();
    expect(inPanel()).toBeTruthy();
  });
  it("the SAME UNIT in another mode is not placed (the mode condition alone holds it back)", async () => {
    ctxBox.ctx = { ...CTX, multiplexRoute: { deviceId: "unit-senior", modeKey: "multiplex" } };
    await mount(null);
    await openPanel();
    await pick("unit-senior");
    expect(inReadings()).toBeNull();
    expect(inPanel()).toBeTruthy();
  });
  it("the MultiPlex pick places the editor under Treatment readings, once, and none in the Machine panel", async () => {
    await mount(null);
    await openPanel();
    await pick("legacy:xcell");
    await clickMultiplex();
    expect(inReadings()).toBeTruthy();
    expect(inPanel()).toBeNull();
    expect(host!.querySelectorAll('[data-testid="machine-setting-draft"]')).toHaveLength(1);
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

describe("MultiPlex under Thermolysis: reopening what was saved", () => {
  // THE RULE: a native area is recognised by its stored machine identity (the routed unit + the mode key), NEVER by the text "Multiplex". A legacy entry
  // that only stored the label reopens exactly as it always did.
  it("a LEGACY entry that stored only the label 'Multiplex' reopens as a legacy label entry: Thermolysis, the Modality choice reading MultiPlex, legacy fields editable, no native load", async () => {
    await mount({ ...BLOCK, mode: "thermo", apilus_modality: "Multiplex", machine_frequency: "27.12 MHz", energy_level: 12 }, { deviceId: "unit-pur" });
    await act(async () => { await Promise.resolve(); });
    expect(pills().filter((b) => b.className.includes("bg-neutral-900")).map(pillName)).toEqual(["Thermolysis"]);
    expect(modalitySelect(host!)!.value).toBe("Multiplex");
    expect(modalitySelect(host!)!.disabled).toBe(false);
    expect(multiplexPill(), "not offered as a native choice on an existing entry").toBeNull();
    expect(legacyFieldsShown()).toBe(true);
    expect(host!.querySelector('[data-testid="machine-setting-draft"]')).toBeNull();
    expect(actions.loadMachineSetupContext).not.toHaveBeenCalled();
  });

  it("the same label with NO route offered is the plain label it has always been", async () => {
    ctxBox.ctx = { ...CTX, multiplexRoute: null };
    await mount(null);
    await openPanel();
    await ensureThermolysis(host!);
    const sel = modalitySelect(host!)!;
    expect(Array.from(sel.options).find((o) => o.value === "Multiplex")!.textContent).toBe("MultiPlex");
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(sel, "Multiplex"); sel.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(sel.value).toBe("Multiplex");
    expect(legacyFieldsShown(), "still the legacy form, nothing native started").toBe(true);
    expect(host!.querySelector('[data-testid="machine-setting-draft"]')).toBeNull();
  });

  it("a saved NATIVE area (stored unit + mode key, no modality label at all) reopens as Thermolysis -> MultiPlex, frozen, with no standalone pill", async () => {
    await mount({ ...BLOCK, studio_machine_id: "unit-pur", machine_mode_key: "multiplex" });
    await act(async () => { await Promise.resolve(); });
    expect(host!.querySelector('[data-testid="mode-multiplex"]')).toBeNull();
    expect(pillLabels()).toEqual(["Thermolysis", "Blend", "Galvanic"]);
    expect(pills().filter((b) => b.className.includes("bg-neutral-900")).map(pillName)).toEqual(["Thermolysis"]);
    expect(modalitySelect(host!)!.value).toBe("Multiplex");
    expect(modalitySelect(host!)!.disabled).toBe(true);
    expect(pills().every((b) => b.disabled)).toBe(true);
  });

  it("a native area is recognised by identity, not by label: the label 'Multiplex' beside a Senior unit stays a legacy-style entry, and a native unit with no label is native", async () => {
    await mount({ ...BLOCK, mode: "thermo", apilus_modality: "Multiplex", studio_machine_id: "unit-senior", machine_mode_key: "standard" });
    await act(async () => { await Promise.resolve(); });
    expect(multiplexOn()).toBe(false);
    act(() => root?.unmount()); host?.remove(); root = host = null;
    await mount({ ...BLOCK, studio_machine_id: "unit-pur", machine_mode_key: "multiplex" });
    await act(async () => { await Promise.resolve(); });
    expect(multiplexOn()).toBe(true);
  });

  it("choosing another modality leaves MultiPlex on Thermolysis: the parked readings return, the chosen modality is set, the pill never moves", async () => {
    await mount(null);
    await openPanel();
    await pick("legacy:xcell");
    await clickPill("Thermolysis");
    const intensity = () => Array.from(host!.querySelectorAll<HTMLLabelElement>("label")).find((l) => l.textContent?.includes("Thermolysis intensity"))!.querySelector("input") as HTMLInputElement;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(intensity(), "42"); intensity().dispatchEvent(new Event("input", { bubbles: true })); });
    await clickMultiplex();
    expect(multiplexOn()).toBe(true);
    await clickPill("Thermolysis");
    expect(multiplexOn(), "pressing Thermolysis again changes nothing").toBe(true);
    const sel = modalitySelect(host!)!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(sel, "Picoflash"); sel.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(multiplexOn()).toBe(false);
    expect(modalitySelect(host!)!.value).toBe("Picoflash");
    expect(intensity().value).toBe("42");
    expect(pills().filter((b) => b.className.includes("bg-neutral-900")).map(pillName)).toEqual(["Thermolysis"]);
  });
});

// MultiPlex with NO registered machine. The route's unit is the inert "Machine not specified" placeholder (a real row, or the sentinel before
// it exists); it is chosen by the pill, never listed in the picker, never remembered, and no legacy xCell choice stands in for it.
describe("MultiPlex in a studio with no registered machine", () => {
  const PLACEHOLDER: StudioDevice = {
    deviceId: "unspecified:xcell-pur", studioId: "studio-synthetic", profileId: "dectro-apilus:xcell-pur", profileVersion: 1,
    displayName: "Machine not specified", installedOptions: [], retiredAt: null, isUnspecified: true,
  };
  const ZERO = () => ({ ...CTX, devices: [PLACEHOLDER], legacyMachine: null, multiplexRoute: { deviceId: PLACEHOLDER.deviceId, modeKey: "multiplex", unspecified: true } });

  it("a click on the pill BEFORE the panel was ever opened opens it and applies that click: MultiPlex is selected, the eight inputs sit once under Treatment readings", async () => {
    ctxBox.ctx = ZERO();
    await mount(null, { deviceId: PLACEHOLDER.deviceId });
    expect(actions.loadMachineSetupContext).not.toHaveBeenCalled();
    await clickMultiplex();
    expect(actions.loadMachineSetupContext).toHaveBeenCalledTimes(1);
    expect(multiplexPill()!.getAttribute("aria-pressed")).toBe("true");
    const readings = host!.querySelector('section[aria-label="Treatment readings"]')!;
    expect(readings.querySelector('[data-testid="machine-setting-draft"]')).toBeTruthy();
    expect(readings.textContent).toContain("Pulse count");
    expect(host!.querySelectorAll('[data-testid="machine-setting-draft"]')).toHaveLength(1);
    expect(legacyFieldsShown()).toBe(false);
  });

  it("no machine is named as chosen but the placeholder's own wording; no legacy choice is shown; the picker never lists it; nothing is remembered", async () => {
    ctxBox.ctx = ZERO();
    await mount(null, { deviceId: PLACEHOLDER.deviceId });
    await clickMultiplex();
    const sel = host!.querySelector<HTMLSelectElement>('[data-testid="machine-select"]')!;
    expect(sel.value).toBe("");
    expect(Array.from(sel.options).map((o) => o.textContent ?? "").join("|")).not.toContain("Machine not specified");
    expect(Array.from(sel.options).some((o) => o.value === PLACEHOLDER.deviceId)).toBe(false);
    expect(Array.from(sel.options).some((o) => o.value === "legacy:xcell")).toBe(false);
    expect(host!.querySelector('[data-testid="machine-chosen"]')?.textContent).toContain("Machine not specified");
    expect(actions.rememberMachineSelectionAction).not.toHaveBeenCalled();
    expect(actions.clearMachineSelectionAction).not.toHaveBeenCalled();
  });

  it("leaving MultiPlex by choosing a legacy mode returns today's form and the placeholder is not chosen", async () => {
    ctxBox.ctx = ZERO();
    await mount(null, { deviceId: PLACEHOLDER.deviceId });
    await clickMultiplex();
    await clickPill("Blend");
    expect(multiplexOn()).toBe(false);
    expect(legacyFieldsShown()).toBe(true);
    expect(host!.querySelector('[data-testid="machine-chosen"]')).toBeNull();
  });

  // A MULTIPLEX CLICK ON A PANEL THAT WAS NEVER OPENED STARTS AN ASYNC LOAD. A Save pressed while it runs would read the previous machine and save a
  // legacy area, so Save is held (and says why); a failed load refuses Save with a plain message and keeps the draft.
  const saveButton = () => host!.querySelector<HTMLButtonElement>('[data-testid="save-treatment-area"]')!;
  const createAction = async () => (await import("@/app/(app)/clients/[id]/sessions/[sessionId]/block-actions")).createTreatmentAreaWithEntryAction as unknown as ReturnType<typeof vi.fn>;

  it("Save is HELD while the MultiPlex load is in flight: the button is disabled and says so, and no save request is sent; after release the area saves as MultiPlex, never legacy", async () => {
    const create = await createAction();
    create.mockClear();
    create.mockResolvedValue({ ok: true, blockId: "new-b1" });
    let release: (v: unknown) => void = () => undefined;
    actions.loadMachineSetupContext.mockImplementationOnce(() => new Promise((r) => { release = r; }) as never);
    await mount(null, { deviceId: PLACEHOLDER.deviceId });
    await clickMultiplex();
    expect(saveButton().disabled).toBe(true);
    expect(saveButton().textContent).toContain("Loading MultiPlex");
    await act(async () => { saveButton().click(); saveButton().form?.requestSubmit?.(); });
    expect(create, "no save request while the load is held").not.toHaveBeenCalled();

    await act(async () => { release(ZERO()); });
    expect(multiplexPill()!.getAttribute("aria-pressed")).toBe("true");
    expect(saveButton().disabled).toBe(false);
    expect(saveButton().textContent).not.toContain("Loading MultiPlex");
    await act(async () => { saveButton().click(); });
    expect(create).toHaveBeenCalledTimes(1);
    const sent = JSON.stringify(create.mock.calls[0]);
    expect(sent).toContain("multiplex");
    expect(sent).not.toMatch(/"mode":"(thermo|blend|galv)"/);
  });

  it("a FAILED MultiPlex load never saves a legacy area: Save refuses with a plain message and the draft stays; picking a legacy mode clears it", async () => {
    const create = await createAction();
    create.mockClear();
    actions.loadMachineSetupContext.mockImplementationOnce((() => Promise.reject(new Error("network"))) as never);
    await mount(null, { deviceId: PLACEHOLDER.deviceId });
    await clickPill("Thermolysis");
    await clickMultiplex();
    expect(multiplexOn()).toBe(false);
    await act(async () => { saveButton().click(); });
    expect(create, "no save request after a failed load").not.toHaveBeenCalled();
    expect(host!.textContent).toContain("MultiPlex could not be loaded");
    expect(host!.textContent).toContain("Machine frequency");

    await clickPill("Blend");
    await act(async () => { saveButton().click(); });
    expect(host!.textContent).not.toContain("MultiPlex could not be loaded");
  });

  it("a failed load is retried by a NEW click, not by the failure itself", async () => {
    actions.loadMachineSetupContext.mockClear();
    actions.loadMachineSetupContext.mockImplementationOnce((() => Promise.reject(new Error("network"))) as never);
    await mount(null, { deviceId: PLACEHOLDER.deviceId });
    await clickMultiplex();
    expect(actions.loadMachineSetupContext).toHaveBeenCalledTimes(1);
    ctxBox.ctx = ZERO();
    await clickMultiplex();
    expect(actions.loadMachineSetupContext).toHaveBeenCalledTimes(2);
    expect(multiplexPill()!.getAttribute("aria-pressed")).toBe("true");
    expect(saveButton().disabled).toBe(false);
  });

  // A STALE ANSWER: MultiPlex is clicked (its load is pending), THEN a legacy mode is chosen, THEN the load answers. The answer belongs to a request she
  // has replaced, so it must neither refuse the Save she is now entitled to make nor select MultiPlex over the mode she chose.
  it("a load that REJECTS after a legacy mode was chosen does not strand Save: no refusal message, and the legacy area saves", async () => {
    const create = await createAction();
    create.mockClear();
    create.mockResolvedValue({ ok: true, blockId: "new-b1" });
    let fail: (e: unknown) => void = () => undefined;
    actions.loadMachineSetupContext.mockImplementationOnce(() => new Promise((_r, rej) => { fail = rej; }) as never);
    await mount(null, { deviceId: PLACEHOLDER.deviceId });
    await clickMultiplex();
    expect(saveButton().disabled).toBe(true);
    await clickPill("Thermolysis");
    expect(saveButton().disabled, "choosing a legacy mode ends the hold").toBe(false);
    await act(async () => { fail(new Error("network")); });
    expect(host!.textContent).not.toContain("MultiPlex could not be loaded");
    expect(multiplexOn()).toBe(false);
    await act(async () => { saveButton().click(); });
    expect(create, "the legacy area saves").toHaveBeenCalledTimes(1);
    expect(host!.textContent).not.toContain("MultiPlex could not be loaded");
  });

  it("a load that SUCCEEDS after a legacy mode was chosen does not select MultiPlex over it", async () => {
    let release: (v: unknown) => void = () => undefined;
    actions.loadMachineSetupContext.mockImplementationOnce(() => new Promise((r) => { release = r; }) as never);
    await mount(null, { deviceId: PLACEHOLDER.deviceId });
    await clickMultiplex();
    await clickPill("Blend");
    await act(async () => { release(ZERO()); });
    expect(multiplexOn()).toBe(false);
    expect(legacyFieldsShown()).toBe(true);
    expect(saveButton().disabled).toBe(false);
  });

  it("MultiPlex clicked again while the first load is pending still loads once and then selects MultiPlex", async () => {
    actions.loadMachineSetupContext.mockClear();
    let release: (v: unknown) => void = () => undefined;
    actions.loadMachineSetupContext.mockImplementationOnce(() => new Promise((r) => { release = r; }) as never);
    await mount(null, { deviceId: PLACEHOLDER.deviceId });
    await clickMultiplex();
    await clickPill("Blend");
    await clickMultiplex();
    await act(async () => { release(ZERO()); });
    expect(actions.loadMachineSetupContext).toHaveBeenCalledTimes(1);
    expect(multiplexPill()!.getAttribute("aria-pressed")).toBe("true");
    expect(saveButton().disabled).toBe(false);
  });

  // EVERY LOAD REPORTS ITS OUTCOME. "Choose machine" starts the load; a MultiPlex click during it ADOPTS that load, so the outcome must come from the
  // load itself, not from the path a MultiPlex click starts, or the hold below never lifts.
  it("MultiPlex clicked while a 'Choose machine' load is running: when that load finishes the hold lifts, MultiPlex is applied and the area saves as MultiPlex", async () => {
    const create = await createAction();
    create.mockClear();
    create.mockResolvedValue({ ok: true, blockId: "new-b1" });
    let release: (v: unknown) => void = () => undefined;
    actions.loadMachineSetupContext.mockImplementationOnce(() => new Promise((r) => { release = r; }) as never);
    await mount(null, { deviceId: PLACEHOLDER.deviceId });
    await openPanel();
    await clickMultiplex();
    expect(saveButton().disabled, "held while the adopted load runs").toBe(true);
    await act(async () => { release(ZERO()); });
    expect(multiplexPill()!.getAttribute("aria-pressed")).toBe("true");
    expect(saveButton().disabled, "the hold lifts when the load the click adopted finishes").toBe(false);
    expect(saveButton().textContent).not.toContain("Loading MultiPlex");
    await act(async () => { saveButton().click(); });
    expect(create).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(create.mock.calls[0])).toContain("multiplex");
  });

  // A LOAD THAT RESOLVES BUT CANNOT APPLY MULTIPLEX (no route: the contract could not be read) is a FAILED MultiPlex load: it must not release the hold
  // into a Save that records the previous legacy mode without a word.
  it("a load that resolves with NO MultiPlex route is a failed load: Save refuses with the plain message and sends nothing; choosing another mode clears it", async () => {
    const create = await createAction();
    create.mockClear();
    create.mockResolvedValue({ ok: true, blockId: "new-b1" });
    actions.loadMachineSetupContext.mockImplementationOnce((async () => ({ ...ZERO(), multiplexRoute: null })) as never);
    await mount(null, { deviceId: PLACEHOLDER.deviceId });
    await clickMultiplex();
    expect(multiplexPill()?.getAttribute("aria-pressed") ?? "false").toBe("false");
    await act(async () => { saveButton().click(); });
    expect(create, "nothing is saved while MultiPlex is not applied").not.toHaveBeenCalled();
    expect(host!.textContent).toContain("MultiPlex could not be loaded");
    await clickPill("Thermolysis");
    await act(async () => { saveButton().click(); });
    expect(create, "another mode is a deliberate choice and saves").toHaveBeenCalledTimes(1);
  });

  // CODEX (4th round): a route-less answer used to remove the pill and strand the retry. The pill the server offered stays, and clicking it reloads.
  it("a ROUTE-LESS load keeps the MultiPlex pill: Save refuses, the pill is still there, and clicking it reloads and applies once the database recovers", async () => {
    const create = await createAction();
    create.mockClear();
    create.mockResolvedValue({ ok: true, blockId: "new-b1" });
    actions.loadMachineSetupContext.mockClear();
    actions.loadMachineSetupContext.mockImplementationOnce((async () => ({ ...ZERO(), multiplexRoute: null })) as never);
    await mount(null, { deviceId: PLACEHOLDER.deviceId });
    await clickMultiplex();
    expect(multiplexPill(), "the pill the server offered is still offered").not.toBeNull();
    expect(multiplexOn()).toBe(false);
    await act(async () => { saveButton().click(); });
    expect(create).not.toHaveBeenCalled();
    expect(host!.textContent).toContain("Pick MultiPlex again, or choose another mode");
    await clickMultiplex();
    expect(actions.loadMachineSetupContext, "the retry loads again").toHaveBeenCalledTimes(2);
    expect(multiplexPill()!.getAttribute("aria-pressed")).toBe("true");
    expect(saveButton().disabled).toBe(false);
    await act(async () => { saveButton().click(); });
    expect(create).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(create.mock.calls[0])).toContain("multiplex");
  });

  it("a FAILED (rejected) load stays retryable the same way: the pill is there and the next click loads again", async () => {
    actions.loadMachineSetupContext.mockClear();
    actions.loadMachineSetupContext.mockImplementationOnce((() => Promise.reject(new Error("network"))) as never);
    await mount(null, { deviceId: PLACEHOLDER.deviceId });
    await clickMultiplex();
    expect(multiplexPill()).not.toBeNull();
    await clickMultiplex();
    expect(actions.loadMachineSetupContext).toHaveBeenCalledTimes(2);
    expect(multiplexPill()!.getAttribute("aria-pressed")).toBe("true");
  });

  // CACHE: a good context is reused. off -> MultiPlex again does not load a second time and is still applied (and the hold lifts).
  it("MultiPlex, a legacy mode, then MultiPlex again REUSES the loaded context: one load in total, and the second choice is applied", async () => {
    actions.loadMachineSetupContext.mockClear();
    await mount(null, { deviceId: PLACEHOLDER.deviceId });
    await clickMultiplex();
    expect(multiplexPill()!.getAttribute("aria-pressed")).toBe("true");
    await clickPill("Blend");
    expect(multiplexOn()).toBe(false);
    // a SECOND load would now come back without a route (the contract unreadable), so only a reused context ends with MultiPlex applied
    ctxBox.ctx = { ...ZERO(), multiplexRoute: null };
    await clickMultiplex();
    await act(async () => { await new Promise((r) => setTimeout(r, 300)); });
    expect(actions.loadMachineSetupContext, "no second load").toHaveBeenCalledTimes(1);
    expect(multiplexPill()!.getAttribute("aria-pressed")).toBe("true");
    expect(saveButton().disabled).toBe(false);
  });

  // A SAVED MULTIPLEX AREA NEVER GATES SAVE ON A LOAD: its panel opens itself (a saved identity), but only a click mints the token that holds Save.
  it("a SAVED MultiPlex area is never held by the panel's own load: Save stays enabled while it is still loading", async () => {
    let release: (v: unknown) => void = () => undefined;
    actions.loadMachineSetupContext.mockImplementationOnce(() => new Promise((r) => { release = r; }) as never);
    await mount({ ...BLOCK, studio_machine_id: "unit-pur", machine_mode_key: "multiplex" });
    await act(async () => { await Promise.resolve(); });
    expect(saveButton().disabled, "not held by a load nobody clicked").toBe(false);
    expect(saveButton().textContent).not.toContain("Loading MultiPlex");
    await act(async () => { release(CTX); });
    expect(saveButton().disabled).toBe(false);
  });
});
