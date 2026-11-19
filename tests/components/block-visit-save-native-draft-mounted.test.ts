// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Codex P1 on Save visit: an EXISTING area whose editor holds unsaved NATIVE-machine readings must be HELD, not saved (saving closes the form and
// loses them). Mounted: the real BlockSetupForm, the real registry, the real Save visit; the machine panel is replaced by a stand-in that reports a
// draft the way the real collector does.
const nav = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: nav.refresh }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/clients/c1/sessions/s1",
}));
const blockActions = vi.hoisted(() => ({ updateTreatmentAreaWithEntryAction: vi.fn(), createTreatmentAreaWithEntryAction: vi.fn() }));
vi.mock("@/app/(app)/clients/[id]/sessions/[sessionId]/block-actions", () => blockActions);
vi.mock("@/app/(app)/clients/[id]/sessions/[sessionId]/machine-setup-actions", () => ({
  lookupAreaCreateClaimAction: vi.fn(async () => ({ ok: true, status: "absent" })),
  recordSetupSubmissionAction: vi.fn(async () => ({ ok: true })),
  readingsForBlockAction: vi.fn(async () => ({ ok: true, readings: [], unitNames: {} })),
  recordBlockMachineIdentityAction: vi.fn(async () => ({ ok: true })),
  rememberMachineSelectionAction: vi.fn(async () => ({ ok: true })),
  clearMachineSelectionAction: vi.fn(async () => ({ ok: true })),
}));
const panel = vi.hoisted(() => ({ reportsDraft: false }));
vi.mock("@/components/machines/machine-first-setup-connected", async () => {
  const { useReportDraft } = await import("@/components/machines/draft-registry");
  const { createElement } = await import("react");
  return {
    MachineFirstSetupConnected: () => {
      useReportDraft({ draft: panel.reportsDraft, unresolved: false });
      return createElement("div", { "data-testid": "stand-in-panel" });
    },
  };
});

const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { BlockSetupForm } = await import("@/app/(app)/clients/[id]/sessions/[sessionId]/block-setup-form");
const { ChartingVisitSaveProvider, VisitSaveControl } = await import("@/components/charting-visit-save");
const { ChartingVisitDraftProvider } = await import("@/components/charting-visit-draft");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const BLOCK = {
  id: "b1", studio_id: "st1", session_id: "s1", sort_order: 1, mode: null, apilus_modality: null, energy_level: null, minutes_performed: null,
  machine_frequency: null, primary_area: "Upper lip", side: "center", custom_area_detail: null, probe_key: null, probe_lot_number: null,
  probe_lot_confirmed: false, block_notes: null, machine_profile_id: null, studio_machine_id: null, machine_mode_key: null,
  updated_at: "2026-11-06T10:00:00.000Z", deleted_at: null,
};
let root: ReturnType<typeof createRoot> | null = null;
let host: HTMLElement | null = null;
beforeEach(() => {
  blockActions.updateTreatmentAreaWithEntryAction.mockReset();
  blockActions.updateTreatmentAreaWithEntryAction.mockResolvedValue({ ok: true, block: { ...BLOCK, updated_at: "2026-11-06T10:05:00.000Z" } });
});
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = host = null; panel.reportsDraft = false; });

async function mount() {
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  await act(async () =>
    root!.render(
      createElement(ChartingVisitDraftProvider, null,
        createElement(ChartingVisitSaveProvider, null,
          createElement(BlockSetupForm, { sessionId: "s1", clientId: "c1", previousBlock: null, block: BLOCK as never, firstEntry: null, initialAreas: [{ area: "Upper lip", side: "center" }] as never, onCancel: () => undefined }),
          createElement(VisitSaveControl))),
    ),
  );
}
async function typeNote() {
  const ta = host!.querySelector<HTMLTextAreaElement>('[data-testid="additional-notes"]')!;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => { setter.call(ta, "an edited note"); ta.dispatchEvent(new Event("input", { bubbles: true })); });
}
const saveVisit = () => act(async () => void host!.querySelector<HTMLButtonElement>('[data-testid="visit-save-button"]')!.click());
const status = () => host!.querySelector('[data-testid^="visit-save-result-"]')?.getAttribute("data-status");

describe("Save visit on an existing area", () => {
  it("CONTROL: an edited note and no machine draft is saved", async () => {
    await mount();
    await typeNote();
    await saveVisit();
    expect(blockActions.updateTreatmentAreaWithEntryAction).toHaveBeenCalledTimes(1);
    expect(status()).toBe("saved");
  });
  it("UNSAVED NATIVE READINGS: the area is HELD, the save action is never called, and the result says so", async () => {
    panel.reportsDraft = true;
    await mount();
    await typeNote();
    await saveVisit();
    expect(blockActions.updateTreatmentAreaWithEntryAction).not.toHaveBeenCalled();
    expect(status()).toBe("held");
    expect(host!.querySelector('[data-testid^="visit-save-result-"]')!.textContent).toContain("see the message on that section");
    expect(host!.textContent, "the message the result line points to is on the section").toContain("This area has unsaved machine settings");
  });
  it("held even when the area itself has nothing else to save (the readings are the unsaved thing)", async () => {
    panel.reportsDraft = true;
    await mount();
    await saveVisit();
    expect(blockActions.updateTreatmentAreaWithEntryAction).not.toHaveBeenCalled();
    expect(status()).toBe("held");
  });
});
