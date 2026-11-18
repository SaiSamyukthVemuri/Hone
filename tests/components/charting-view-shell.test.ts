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
