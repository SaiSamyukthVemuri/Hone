// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// MOUNTED: the real form, the real stepper and inputs, the real payload handed to the server action. Synthetic records.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/clients/c1/sessions/s1",
}));
const blockActions = vi.hoisted(() => ({
  updateTreatmentAreaWithEntryAction: vi.fn(),
  createTreatmentAreaWithEntryAction: vi.fn(),
}));
vi.mock("@/app/(app)/clients/[id]/sessions/[sessionId]/block-actions", () => blockActions);
vi.mock("@/app/(app)/clients/[id]/sessions/[sessionId]/machine-setup-actions", () => ({
  lookupAreaCreateClaimAction: vi.fn(async () => ({ ok: true, status: "absent" })),
  recordSetupSubmissionAction: vi.fn(async () => ({ ok: true })),
  readingsForBlockAction: vi.fn(async () => ({ ok: true, readings: [], unitNames: {} })),
  recordBlockMachineIdentityAction: vi.fn(async () => ({ ok: true })),
  rememberMachineSelectionAction: vi.fn(async () => ({ ok: true })),
  clearMachineSelectionAction: vi.fn(async () => ({ ok: true })),
}));

const { createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { BlockSetupForm } = await import("@/app/(app)/clients/[id]/sessions/[sessionId]/block-setup-form");
const { ChartingViewContext } = await import("@/components/charting-view-context");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const BLOCK = {
  id: "b1", studio_id: "st1", session_id: "s1", sort_order: 1, mode: "thermo", apilus_modality: null, energy_level: null,
  minutes_performed: null, machine_frequency: null, primary_area: "Upper lip", side: "center", custom_area_detail: null,
  probe_key: null, probe_lot_number: null, probe_lot_confirmed: false, block_notes: null, machine_profile_id: null,
  studio_machine_id: null, machine_mode_key: null, updated_at: "2026-11-06T10:00:00.000Z", deleted_at: null,
};
const ENTRY = {
  id: "e1", pulse_count: 3, pulse_delay_seconds: 0.4, hairs_treated: 20, thermolysis_intensity_percent: 40,
  thermolysis_duration_seconds: 0.5, comments: null, observation_chips: [], deleted_at: null,
};

let root: ReturnType<typeof createRoot> | null = null;
let host: HTMLElement | null = null;
beforeEach(() => {
  blockActions.updateTreatmentAreaWithEntryAction.mockReset().mockResolvedValue({ ok: false, error: "x" });
  blockActions.createTreatmentAreaWithEntryAction.mockReset().mockResolvedValue({ ok: false, error: "x" });
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = null;
});

async function mount(o: { rollout: boolean; create?: boolean; entry?: unknown }) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const form = createElement(BlockSetupForm, {
    sessionId: "s1", clientId: "c1", previousBlock: null,
    block: o.create ? null : ({ ...BLOCK } as never),
    firstEntry: (o.create ? null : (o.entry ?? ENTRY)) as never,
    initialAreas: [{ area: "Upper lip", side: "center" }] as never,
    onCancel: () => undefined,
  });
  await act(async () => {
    root!.render(
      createElement(ChartingViewContext.Provider, { value: { view: "new", setView: () => undefined, notice: null, rolloutOn: o.rollout } }, form),
    );
  });
}
const labelInput = (text: string) => {
  const l = [...host!.querySelectorAll("label")].find((x) => x.textContent?.includes(text));
  const i = l?.querySelector("input");
  if (!i) throw new Error(`no input for label "${text}"`);
  return i as HTMLInputElement;
};
const typeInto = async (el: HTMLInputElement, v: string) => {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => { set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); });
};
const pill = (name: string) => [...host!.querySelectorAll("button")].find((b) => b.textContent?.trim() === name) as HTMLButtonElement;
const click = async (el: Element) => { await act(async () => { (el as HTMLElement).click(); }); };
const save = () => click(host!.querySelector('[data-testid="save-treatment-area"]')!);
const aria = (a: string) => host!.querySelector(`[aria-label="${a}"]`) as HTMLElement;
const leaveIsHeld = () => { const ev = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(ev); return ev.defaultPrevented; };
const sent = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls[0]![0] as { readings: Record<string, unknown>; mode?: string | null };

describe("B1: reopening a saved block and changing only hairs writes its pulse count and delay BACK", () => {
  it("rollout ON: saved pulse 3 / delay 0.4, change only hairs, Save: the action receives 3 and 0.4", async () => {
    await mount({ rollout: true });
    await typeInto(labelInput("Hairs treated"), "21");
    await save();
    const p = sent(blockActions.updateTreatmentAreaWithEntryAction);
    expect(p.readings.pulseCount).toBe(3);
    expect(p.readings.pulseDelaySeconds).toBe(0.4);
    expect(p.readings.hairsTreated).toBe(21);
  });
  it("a saved entry with a count but NO saved delay: the count is written back and no delay is invented", async () => {
    await mount({ rollout: true, entry: { ...ENTRY, pulse_count: 3, pulse_delay_seconds: null } });
    await typeInto(labelInput("Hairs treated"), "21");
    await save();
    const p = sent(blockActions.updateTreatmentAreaWithEntryAction);
    expect(p.readings.pulseCount).toBe(3);
    expect(p.readings.pulseDelaySeconds).toBeNull();
  });
});

describe("nothing touched sends no pulse reading", () => {
  it("a fresh block with only an area: null count and null delay, and no mode", async () => {
    await mount({ rollout: true, create: true });
    await save();
    const p = sent(blockActions.createTreatmentAreaWithEntryAction);
    expect(p.readings.pulseCount).toBeNull();
    expect(p.readings.pulseDelaySeconds).toBeNull();
    expect(p.mode ?? null).toBeNull();
  });
  it("a mode picked, nothing else touched: still no pulse reading (selecting alone never records)", async () => {
    await mount({ rollout: true, create: true });
    await click(pill("Thermolysis"));
    await save();
    const p = sent(blockActions.createTreatmentAreaWithEntryAction);
    expect(p.readings.pulseCount).toBeNull();
    expect(p.readings.pulseDelaySeconds).toBeNull();
  });
  it("COUNT touched, DELAY untouched: the count is recorded and the untouched default delay is NOT", async () => {
    await mount({ rollout: true, create: true });
    await click(pill("Thermolysis"));
    await click(aria("Increase thermolysis pulse count")); // 1 -> 2, so the delay control shows at its default
    await click(aria("Increase thermolysis pulse count")); // -> 3
    await save();
    const p = sent(blockActions.createTreatmentAreaWithEntryAction);
    expect(p.readings.pulseCount).toBe(3);
    expect(p.readings.pulseDelaySeconds).toBeNull();
  });
  it("both touched: both recorded", async () => {
    await mount({ rollout: true, create: true });
    await click(pill("Thermolysis"));
    await click(aria("Increase thermolysis pulse count"));
    await typeInto(aria("Pulse delay in seconds") as HTMLInputElement, "0.6");
    await save();
    const p = sent(blockActions.createTreatmentAreaWithEntryAction);
    expect(p.readings.pulseCount).toBe(2);
    expect(p.readings.pulseDelaySeconds).toBe(0.6);
  });
});

describe("OFF path is today's payload", () => {
  it("rollout OFF, fresh thermolysis block: the untouched default count is sent exactly as before", async () => {
    await mount({ rollout: false, create: true });
    await click(pill("Thermolysis"));
    await save();
    const p = sent(blockActions.createTreatmentAreaWithEntryAction);
    expect(p.readings.pulseCount).toBe(1);
  });
  it("rollout OFF: a saved block is written back unchanged", async () => {
    await mount({ rollout: false });
    await typeInto(labelInput("Hairs treated"), "21");
    await save();
    const p = sent(blockActions.updateTreatmentAreaWithEntryAction);
    expect(p.readings.pulseCount).toBe(3);
    expect(p.readings.pulseDelaySeconds).toBe(0.4);
  });
  it("rollout OFF: switching modes shows no notice and parks nothing", async () => {
    await mount({ rollout: false, create: true });
    await click(pill("Thermolysis"));
    await typeInto(labelInput("Thermolysis intensity"), "55");
    await click(pill("Galvanic"));
    expect(host!.querySelector('[data-testid="hidden-mode-readings-notice"]')).toBeNull();
  });
});

describe("R2: the leave guard covers readings parked for another mode", () => {
  it("rollout ON: readings typed under Thermolysis, then Galvanic shown: leaving is held and the notice names the mode only", async () => {
    await mount({ rollout: true, create: true });
    await click(pill("Thermolysis"));
    await typeInto(labelInput("Thermolysis intensity"), "55");
    await click(pill("Galvanic"));
    expect(leaveIsHeld()).toBe(true);
    const n = host!.querySelector('[data-testid="hidden-mode-readings-notice"]')!;
    expect(n.textContent).toBe("Thermolysis readings is kept in this draft and will not be saved.");
    expect(n.textContent).not.toMatch(/55/);
  });
});

describe("R2 (isolated): parked readings ALONE keep the leave guard armed", () => {
  it("readings typed under Thermolysis, then the mode cleared so the visible draft equals the baseline: leaving is STILL held", async () => {
    await mount({ rollout: true, create: true });
    expect(leaveIsHeld(), "control: a fresh form is not held").toBe(false);
    await click(pill("Thermolysis"));
    await typeInto(labelInput("Thermolysis intensity"), "55");
    await click(pill("Thermolysis")); // clears the mode: the visible draft is back to the baseline
    expect(host!.querySelector('[data-testid="hidden-mode-readings-notice"]')).not.toBeNull();
    expect(leaveIsHeld()).toBe(true);
  });
});

describe("R3: values typed with NO mode are parked at the first mode pick, never silently discarded", () => {
  it("typed EL with no mode, then Thermolysis picked: the draft is still unsaved, the notice says so, and clearing the mode restores it", async () => {
    await mount({ rollout: true, create: true });
    await typeInto(labelInput("Energy level"), "14");
    await click(pill("Thermolysis"));
    expect(leaveIsHeld()).toBe(true);
    expect(host!.querySelector('[data-testid="hidden-mode-readings-notice"]')!.textContent).toMatch(/before a mode was chosen/);
    await click(pill("Thermolysis")); // tapping the selected pill clears the mode
    expect(labelInput("Energy level").value).toBe("14");
  });
});
