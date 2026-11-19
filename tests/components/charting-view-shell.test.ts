// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

// The Current / New view switch over the REAL form, the real connected wrapper and panel. Synthetic records.
// (Fixtures follow block-setup-auto-select-mounted.test.ts.)
const prefAction = vi.hoisted(() => ({ setChartingViewAction: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/app/(app)/charting-view-actions", () => prefAction);
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
const { ChartingViewShell, ChartingViewToggle, ChartingVisitSummary } = await import("@/components/charting-view-shell");
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

function tree(initialView: "current" | "new") {
  const children = createElement(
    "div",
    null,
    createElement("h1", null, "Electrolysis session"),
    createElement(ChartingViewToggle),
    // A real form with a real submit control, like the page's next-visit and notes forms: if the switch ever submitted
    // "a form", this is one it could reach.
    createElement(
      "form",
      { "data-testid": "sibling-form", onSubmit: (e: { preventDefault: () => void }) => e.preventDefault() },
      createElement("input", { name: "note", defaultValue: "x" }),
      createElement("button", { type: "submit" }, "Save"),
    ),
    createElement(BlockSetupForm, {
      sessionId: "s1",
      clientId: "c1",
      previousBlock: null,
      block: BLOCK as never,
      firstEntry: null,
      initialAreas: [{ area: "Upper lip", side: "center" }] as never,
      onCancel: () => undefined,
    }),
  );
  return createElement(ChartingViewShell, {
    initialView,
    summary: createElement(ChartingVisitSummary, { clientName: "Avery Example", kind: "electrolysis", areas: ["Upper lip"], count: 1, nextVisitNoteRecorded: false }),
    children,
  });
}
async function mount(initialView: "current" | "new" = "current") {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(tree(initialView)));
}
const toggle = () => host!.querySelector<HTMLButtonElement>('[data-testid="charting-view-toggle"]')!;
const content = () => host!.querySelector<HTMLElement>('[data-testid="charting-view-content"]')!;
const rootEl = () => host!.querySelector<HTMLElement>('[data-testid="charting-view-root"]')!;
const click = (el: Element) => act(async () => (el as HTMLElement).click());
const setInput = async (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const set = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  await act(async () => {
    set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const notes = () => host!.querySelector<HTMLTextAreaElement>('[data-testid="additional-notes"]')!;
const reading = () => host!.querySelector<HTMLInputElement>('[data-testid="machine-reading-entry"] input')!;
const machineSelect = () => host!.querySelector<HTMLSelectElement>('[data-testid="machine-select"]')!;
const openPanel = () => click(host!.querySelector('[data-testid="machine-first-open"]')!);
const saveCalls = () =>
  actions.recordSetupSubmissionAction.mock.calls.length +
  actions.recordBlockMachineIdentityAction.mock.calls.length +
  actions.rememberMachineSelectionAction.mock.calls.length +
  actions.clearMachineSelectionAction.mock.calls.length;

ctxBox.ctx = { ...CTX };

describe("the switch itself", () => {
  it("is a small 'New view' switch: Current by default, a real switch role, outside every form, a button that cannot submit", async () => {
    await mount();
    expect(toggle().getAttribute("role")).toBe("switch");
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    expect(toggle().textContent).toContain("New view");
    expect(toggle().type).toBe("button");
    expect(toggle().closest("form")).toBeNull();
    expect(rootEl().getAttribute("data-charting-view")).toBe("current");
    expect(host!.querySelector('[data-testid="charting-view-summary"]')).toBeNull();
  });
  it("turns New view on and off, shows the summary only in New view, and remembers each choice", async () => {
    await mount();
    await click(toggle());
    expect(toggle().getAttribute("aria-checked")).toBe("true");
    expect(rootEl().getAttribute("data-charting-view")).toBe("new");
    expect(host!.querySelector('[data-testid="charting-view-summary"]')!.textContent).toContain("Upper lip");
    expect(prefAction.setChartingViewAction).toHaveBeenLastCalledWith("new");
    await click(toggle());
    expect(rootEl().getAttribute("data-charting-view")).toBe("current");
    expect(host!.querySelector('[data-testid="charting-view-summary"]')).toBeNull();
    expect(prefAction.setChartingViewAction).toHaveBeenLastCalledWith("current");
  });
  it("shows a laser-appropriate summary for a laser visit", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () =>
      root!.render(
        createElement(ChartingViewShell, {
          initialView: "new",
          summary: createElement(ChartingVisitSummary, { clientName: "Avery Example", kind: "laser", areas: ["Legs"], count: 2, nextVisitNoteRecorded: true }),
          children: createElement("div", null, "x"),
        }),
      ),
    );
    const text = host!.querySelector('[data-testid="charting-view-summary"]')!.textContent!;
    expect(text).toContain("Zones treated");
    expect(text).toContain("Passes saved");
    expect(text).toContain("Legs");
    expect(text).not.toContain("None saved yet");
    expect(text).not.toContain("Settings blocks saved");
  });
  it("starts in New view when that is the saved choice", async () => {
    await mount("new");
    expect(toggle().getAttribute("aria-checked")).toBe("true");
  });
  it("is a native, enabled button with a 44px touch target (so Enter and Space work as on any button)", async () => {
    await mount();
    expect(toggle().tagName).toBe("BUTTON");
    expect(toggle().disabled).toBe(false);
    expect(toggle().className).toContain("min-h-[44px]");
  });
});

describe("switching never loses or sends anything", () => {
  it("keeps the very same content node, and an unsaved note, through a round trip", async () => {
    await mount();
    const before = content();
    await setInput(notes(), "an unsaved note");
    await click(toggle());
    expect(content(), "the content was not remounted").toBe(before);
    expect(notes().value).toBe("an unsaved note");
    await click(toggle());
    expect(content()).toBe(before);
    expect(notes().value).toBe("an unsaved note");
  });

  it("keeps the machine panel's typed settings and the machine pick, in both directions", async () => {
    await mount();
    await openPanel();
    expect(machineSelect().value, "control: the remembered unit auto-selected").toBe("room-9");
    const field = reading();
    expect(field, "the settings entry is mounted").not.toBeNull();
    await setInput(field, "120");
    const select = machineSelect();
    await click(toggle());
    expect(machineSelect(), "the same select node").toBe(select);
    expect(machineSelect().value).toBe("room-9");
    expect(reading(), "the same settings field node").toBe(field);
    expect(reading().value).toBe("120");
    await click(toggle());
    expect(reading()).toBe(field);
    expect(reading().value).toBe("120");
    expect(machineSelect().value).toBe("room-9");
  });

  it("keeps a typed probe lot (and its provenance) through a switch", async () => {
    await mount();
    const lot = host!.querySelector<HTMLInputElement>('[data-testid="probe-lot-input"]');
    if (lot === null) {
      // The lot field appears once a probe is chosen: choose the first available probe.
      const probe = host!.querySelector<HTMLSelectElement>("select[name='probeKey'], [data-testid='probe-picker'] select");
      expect(probe, "a probe picker is present").not.toBeNull();
    }
    const field = host!.querySelector<HTMLInputElement>('[data-testid="probe-lot-input"]')!;
    expect(field, "the lot field is present").not.toBeNull();
    await setInput(field, "LOT-ABC-123");
    const source = host!.querySelector('[data-testid="probe-lot-source"]')?.textContent ?? null;
    await click(toggle());
    expect(host!.querySelector<HTMLInputElement>('[data-testid="probe-lot-input"]')).toBe(field);
    expect(field.value).toBe("LOT-ABC-123");
    expect(host!.querySelector('[data-testid="probe-lot-source"]')?.textContent ?? null).toBe(source);
  });

  it("a toggle click submits nothing: no submit event, no form.submit() or requestSubmit(), with a real form in the DOM", async () => {
    await mount();
    expect(host!.querySelectorAll("form").length, "a real form is mounted").toBeGreaterThan(0);
    const submits: Event[] = [];
    const onSubmit = (e: Event) => submits.push(e);
    document.addEventListener("submit", onSubmit, true);
    const requestSubmit = vi.spyOn(HTMLFormElement.prototype, "requestSubmit");
    const submit = vi.spyOn(HTMLFormElement.prototype, "submit").mockImplementation(() => undefined);
    try {
      await click(toggle());
      await click(toggle());
      expect(submits).toEqual([]);
      expect(requestSubmit).not.toHaveBeenCalled();
      expect(submit).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("submit", onSubmit, true);
      requestSubmit.mockRestore();
      submit.mockRestore();
    }
  });

  it("sends nothing: no save, no machine write, no machine memory change, whichever way it switches", async () => {
    await mount();
    await openPanel();
    await setInput(reading(), "120");
    await setInput(notes(), "n");
    const callsBefore = saveCalls();
    await click(toggle());
    await click(toggle());
    await click(toggle());
    expect(saveCalls()).toBe(callsBefore);
    expect(prefAction.setChartingViewAction).toHaveBeenCalledTimes(3);
  });

  it("a failed 'remember my choice' shows the notice, switches anyway, and leaves the charting untouched", async () => {
    prefAction.setChartingViewAction.mockResolvedValueOnce({ ok: false } as never);
    await mount();
    await setInput(notes(), "kept");
    await click(toggle());
    expect(rootEl().getAttribute("data-charting-view")).toBe("new");
    expect(host!.querySelector('[data-testid="charting-view-notice"]')!.textContent).toMatch(/wasn't remembered/);
    expect(host!.querySelector('[data-testid="charting-view-notice"]')!.getAttribute("role")).toBe("status");
    expect(notes().value).toBe("kept");
  });

  it("leaving the page discards everything: a fresh mount starts empty and on the saved view", async () => {
    await mount();
    await setInput(notes(), "left behind");
    await click(toggle());
    act(() => root!.unmount());
    host!.remove();
    root = host = null;
    await mount("current");
    expect(notes().value).toBe("");
    expect(rootEl().getAttribute("data-charting-view")).toBe("current");
  });
});

// ---- Block editing in New view: the same editor, the New order, nothing remounted ----------------------------------
const step = (n: number) => host!.querySelector(`[data-testid="new-view-step-${n}"]`);
const areasEl = () => host!.querySelector('[data-testid="selected-areas"]') as HTMLElement;
const machineOpenEl = () => host!.querySelector('[data-testid="machine-first-open"]') as HTMLElement;
const before = (a: Node, b: Node) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

describe("the This visit card follows the open form", () => {
  const sum = () => host!.querySelector<HTMLElement>('[data-testid="charting-view-summary"]')!;
  const row = (id: string) => sum().querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
  it("lists the five steps in the reference order, with Record response optional", async () => {
    await mount("new");
    const lis = Array.from(sum().querySelectorAll('[data-testid="visit-steps"] li'));
    expect(lis.map((li) => li.querySelectorAll("span")[1].textContent)).toEqual(["Choose areas", "Enter settings", "Record response", "Review & finish", "Session payment"]);
    expect(lis.map((li) => li.textContent!.includes("Optional"))).toEqual([false, false, true, false, false]);
  });
  it("shows the machine the form actually has selected, and the save status, without saving anything", async () => {
    await mount("new");
    expect(row("visit-summary-machine").textContent, "nothing chosen yet").toBe("None selected");
    await openPanel();
    expect(machineSelect().value).toBe("room-9");
    expect(row("visit-summary-machine").textContent).toContain("Mounted");
    expect(row("visit-summary-status").textContent, "one block saved and nothing unsaved").toBe("Saved");
    await setInput(notes(), "an unsaved note");
    expect(row("visit-summary-status").textContent).toBe("Not saved yet");
    expect(saveCalls(), "reading the form saves nothing").toBe(0);
  });
  it("a registered xCell Pur unit (the native route) reads as the studio's xCell, never as the catalogue's model name", async () => {
    const XPUR = { ...PROFILE, profileId: "dectro-apilus:xcell-pur", manufacturer: "Apilus", model: "xCell Pur" };
    ctxBox.ctx = {
      ...CTX,
      legacyMachine: null,
      catalogue: [XPUR],
      devices: [{ ...DEVICE, profileId: XPUR.profileId, displayName: "Room 9 xCell" }],
    };
    await mount("new");
    await openPanel();
    expect(machineSelect().value).toBe("room-9");
    const text = row("visit-summary-machine").textContent!;
    expect(text).toContain("Dectro xCell");
    expect(text).not.toContain("xCell Pur");
  });
  it("a saved block whose unit is retired still names that unit, as no longer available, and never reads None selected", async () => {
    ctxBox.ctx = { ...CTX, remembered: null, legacyMachine: null, unitNames: { "room-9": "Room 9 unit" }, devices: [{ ...DEVICE, retiredAt: "2026-01-01T00:00:00.000Z" }] };
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    const saved = { ...BLOCK, studio_machine_id: "room-9", machine_profile_id: "fixture:mounted", machine_mode_key: "galvanic" };
    await act(async () =>
      root!.render(
        createElement(ChartingViewShell, {
          initialView: "new",
          summary: createElement(ChartingVisitSummary, { clientName: "Avery Example", kind: "electrolysis", areas: [], count: 1, nextVisitNoteRecorded: false }),
          children: createElement(BlockSetupForm, { sessionId: "s1", clientId: "c1", previousBlock: null, block: saved as never, firstEntry: null, onCancel: () => undefined }),
        }),
      ),
    );
    if (host!.querySelector('[data-testid="machine-first-open"]')) await openPanel();
    const text = row("visit-summary-machine").textContent!;
    expect(text).toContain("Room 9 unit");
    expect(text).toContain("no longer available");
  });
  it("with TWO real forms open, the Machine row follows the one last edited: A, then B, then A", async () => {
    const P2 = { ...PROFILE, profileId: "fixture:zeta", model: "Zeta" };
    ctxBox.ctx = {
      ...CTX,
      remembered: null,
      legacyMachine: null,
      catalogue: [PROFILE, P2],
      devices: [DEVICE, { ...DEVICE, deviceId: "room-10", displayName: "Room 10 unit", profileId: "fixture:zeta" }],
    };
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    const A = { ...BLOCK, id: "bA", studio_machine_id: "room-9", machine_profile_id: "fixture:mounted", machine_mode_key: "galvanic" };
    const B = null; // a NEW block form beside the saved one
    const form = (b: unknown) => createElement(BlockSetupForm, { key: b ? (b as { id: string }).id : "new", sessionId: "s1", clientId: "c1", previousBlock: null, block: b as never, firstEntry: null, onCancel: () => undefined });
    await act(async () =>
      root!.render(
        createElement(ChartingViewShell, {
          initialView: "new",
          summary: createElement(ChartingVisitSummary, { clientName: "Avery Example", kind: "electrolysis", areas: [], count: 2, nextVisitNoteRecorded: false }),
          children: createElement("div", null, form(A), form(B)),
        }),
      ),
    );
    for (let i = 0; i < 6 && host.querySelectorAll('[data-testid="machine-select"]').length < 2; i++) {
      const open = host.querySelector('[data-testid="machine-first-open"]');
      if (open && !open.hasAttribute("disabled")) await click(open);
      await act(async () => void (await new Promise((r) => setTimeout(r, 30))));
    }
    expect(host.querySelectorAll('[data-testid="machine-select"]').length, "both panels open").toBe(2);
    // The new block's unit is picked explicitly (create mode applies a pick at once and writes nothing).
    const sels = Array.from(host.querySelectorAll<HTMLSelectElement>('[data-testid="machine-select"]'));
    const newSel = sels[sels.length - 1];
    const setSel = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
    await act(async () => {
      setSel.call(newSel, "room-10");
      newSel.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const notesAt = (i: number) => host!.querySelectorAll<HTMLTextAreaElement>('[data-testid="additional-notes"]')[i];
    expect(notesAt(1), "two real forms").toBeTruthy();
    await setInput(notesAt(0), "a");
    expect(row("visit-summary-machine").textContent, "A edited").toContain("Mounted");
    await setInput(notesAt(1), "b");
    expect(row("visit-summary-machine").textContent, "B edited after A").toContain("Zeta");
    await setInput(notesAt(0), "aa");
    expect(row("visit-summary-machine").textContent, "A edited again, B still dirty").toContain("Mounted");
  });
  describe("a failed or unknown-outcome save of machine readings", () => {
    async function fillAndSave() {
      await mount("new");
      await openPanel();
      for (const input of Array.from(host!.querySelectorAll<HTMLInputElement>('[data-testid="machine-reading-entry"] input[type="number"], [data-testid="machine-reading-entry"] input:not([type])'))) {
        if (!input.closest('[data-testid^="setting-group-"][data-testid$="no-channels"]')) await setInput(input, "5");
      }
      const save = host!.querySelector<HTMLButtonElement>('[data-testid="machine-reading-save"]')!;
      expect(save.disabled, "the readings can be saved").toBe(false);
      await click(save);
    }
    it("a refused save shows Needs attention", async () => {
      actions.recordSetupSubmissionAction.mockResolvedValueOnce({ ok: false, error: "Could not save." } as never);
      await fillAndSave();
      expect(row("visit-summary-status").textContent).toBe("Needs attention");
    });
    it("an unknown-outcome save (the answer was lost) shows Needs attention", async () => {
      actions.recordSetupSubmissionAction.mockRejectedValueOnce(new Error("network") as never);
      await fillAndSave();
      expect(row("visit-summary-status").textContent).toBe("Needs attention");
    });
    it("while a save is in flight, a previous refusal is not shown as attention (the pending term)", async () => {
      actions.recordSetupSubmissionAction.mockResolvedValueOnce({ ok: false, error: "Could not save." } as never);
      await fillAndSave();
      expect(row("visit-summary-status").textContent).toBe("Needs attention");
      let release!: (v: unknown) => void;
      actions.recordSetupSubmissionAction.mockImplementationOnce((() => new Promise((r) => (release = r))) as never);
      await click(host!.querySelector<HTMLButtonElement>('[data-testid="machine-reading-save"]')!);
      expect(row("visit-summary-status").textContent).not.toBe("Needs attention");
      await act(async () => release({ ok: true }));
    });
    it("a successful save does not", async () => {
      await fillAndSave();
      expect(row("visit-summary-status").textContent).not.toBe("Needs attention");
    });
  });
  it("shows the existing xCell by the picker's own label for a saved legacy block", async () => {
    ctxBox.ctx = { ...CTX, remembered: null, devices: [] };
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    const legacyBlock = { ...BLOCK, machine_profile_id: "dectro-apilus:xcell" };
    await act(async () =>
      root!.render(
        createElement(ChartingViewShell, {
          initialView: "new",
          summary: createElement(ChartingVisitSummary, { clientName: "Avery Example", kind: "electrolysis", areas: [], count: 1, nextVisitNoteRecorded: false }),
          children: createElement(BlockSetupForm, { sessionId: "s1", clientId: "c1", previousBlock: null, block: legacyBlock as never, firstEntry: null, onCancel: () => undefined }),
        }),
      ),
    );
    expect(row("visit-summary-machine").textContent).toBe("Dectro xCell");
  });
  it("shows the existing xCell after the practitioner picks it", async () => {
    await mount("new");
    await openPanel();
    const sel = machineSelect();
    const setSel = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
    await act(async () => {
      setSel.call(sel, "legacy:xcell");
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(row("visit-summary-machine").textContent).toBe("Dectro xCell");
  });
  it("editing a saved block shows no Areas in draft (they are saved), and a NEW block shows what is picked but unsaved", async () => {
    await mount("new");
    expect(row("visit-summary-draft-areas").textContent, "the fixture edits a saved block").toBe("None selected");
    await act(async () => root!.unmount());
    host!.remove();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    const create = createElement(ChartingViewShell, {
      initialView: "new",
      summary: createElement(ChartingVisitSummary, { clientName: "Avery Example", kind: "electrolysis", areas: [], count: 0, nextVisitNoteRecorded: false }),
      children: createElement(BlockSetupForm, { sessionId: "s1", clientId: "c1", previousBlock: null, block: null as never, firstEntry: null, defaultPrimaryArea: "chin", defaultMachineFrequency: "27.12", onCancel: () => undefined }),
    });
    await act(async () => root!.render(create));
    expect(row("visit-summary-draft-areas").textContent!.toLowerCase()).toContain("chin");
    expect(row("visit-summary-status").textContent, "unsaved picks, nothing saved").toBe("Not saved yet");
  });
  it("a view switch changes nothing the card says and sends nothing", async () => {
    await mount("new");
    await openPanel();
    const before = sum().textContent;
    await click(toggle());
    await click(toggle());
    expect(sum().textContent).toBe(before);
    expect(saveCalls()).toBe(0);
  });
});

describe('"Your machine is already selected." shows only when a machine really is selected', () => {
  const hint = () => host!.querySelector('[data-testid="new-view-hint-machine"]');
  it("New view, a machine selected: shown", async () => {
    await mount("new");
    await openPanel();
    expect(machineSelect().value).toBe("room-9");
    expect(hint()?.textContent).toBe("Your machine is already selected.");
  });
  it("New view, NO machine selected: not shown", async () => {
    ctxBox.ctx = { ...CTX, remembered: null, legacyMachine: null };
    await mount("new");
    await openPanel();
    expect(machineSelect().value).toBe("");
    expect(hint()).toBeNull();
  });
  it("New view, the machine is cleared after being selected: the line goes away", async () => {
    await mount("new");
    await openPanel();
    expect(hint()).not.toBeNull();
    const sel = machineSelect();
    const setSel = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
    await act(async () => {
      setSel.call(sel, "");
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(machineSelect().value).toBe("");
    expect(hint()).toBeNull();
  });
  it("Current view, a machine selected: never shown", async () => {
    await mount("current");
    await openPanel();
    expect(machineSelect().value).toBe("room-9");
    expect(hint()).toBeNull();
  });
});

describe("block editing in New view", () => {
  it("Current view is exactly today's order with no step headings: machine first, then the areas", async () => {
    await mount();
    expect(step(1)).toBeNull();
    expect(step(2)).toBeNull();
    expect(step(3)).toBeNull();
    expect(before(machineOpenEl(), areasEl()), "machine panel precedes the areas").toBe(true);
  });

  it("New view: numbered steps; Areas treated first, then Treatment settings (the machine panel), then Client response", async () => {
    await mount("new");
    expect(step(1)!.textContent).toContain("Choose areas");
    expect(step(2)!.textContent).toContain("Enter settings");
    expect(step(3)!.textContent).toContain("Record response");
    expect(step(3)!.textContent).toContain("Optional");
    expect(before(step(1)!, areasEl())).toBe(true);
    expect(before(areasEl(), step(2)!)).toBe(true);
    expect(before(step(2)!, machineOpenEl())).toBe(true);
    expect(before(machineOpenEl(), step(3)!)).toBe(true);
    expect(before(step(3)!, notes())).toBe(true);
  });

  it("New view only: the one-block-covers-several-areas line sits under step 1; Current view has no such line", async () => {
    await mount();
    expect(host!.querySelector('[data-testid="new-view-hint-areas"]')).toBeNull();
    await mount("new");
    const hint = host!.querySelector('[data-testid="new-view-hint-areas"]') as HTMLElement;
    expect(hint.textContent).toBe("One settings block can cover several areas.");
    expect(before(step(1)!, hint)).toBe(true);
    expect(before(hint, areasEl())).toBe(true);
  });

  it("switching moves the machine panel and the area editor WITHOUT remounting them: same nodes, typed values kept, nothing sent", async () => {
    await mount();
    await openPanel();
    const field = reading();
    await setInput(field, "120");
    const select = machineSelect();
    const areas = areasEl();
    const note = notes();
    await setInput(note, "kept note");
    const callsBefore = saveCalls();
    await click(toggle());
    expect(before(areasEl(), machineSelect()), "New order: areas before the machine panel").toBe(true);
    expect(areasEl(), "the area editor is the same node").toBe(areas);
    expect(machineSelect(), "the machine select is the same node").toBe(select);
    expect(reading(), "the typed setting's field is the same node").toBe(field);
    expect(reading().value).toBe("120");
    expect(notes()).toBe(note);
    expect(notes().value).toBe("kept note");
    await click(toggle());
    expect(before(machineSelect(), areasEl()), "back to Current's order").toBe(true);
    expect(areasEl()).toBe(areas);
    expect(machineSelect()).toBe(select);
    expect(reading()).toBe(field);
    expect(reading().value).toBe("120");
    expect(saveCalls()).toBe(callsBefore);
  });

  it("the editor's controls are the same in both views (same save and cancel controls)", async () => {
    await mount();
    const idsCurrent = Array.from(host!.querySelectorAll("[data-testid]"))
      .map((e) => e.getAttribute("data-testid"))
      .filter((t) => !t!.startsWith("new-view-step") && !t!.startsWith("new-view-hint") && !t!.startsWith("visit-") && !t!.startsWith("charting-view-summary"))
      .sort();
    await click(toggle());
    const idsNew = Array.from(host!.querySelectorAll("[data-testid]"))
      .map((e) => e.getAttribute("data-testid"))
      .filter((t) => !t!.startsWith("new-view-step") && !t!.startsWith("new-view-hint") && !t!.startsWith("visit-") && !t!.startsWith("charting-view-summary"))
      .sort();
    expect(idsNew).toEqual(idsCurrent);
    expect(idsNew).toContain("save-treatment-area");
    expect(idsNew).toContain("cancel-treatment-area");
  });
});

