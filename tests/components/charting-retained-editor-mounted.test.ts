// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

// P1 of the charting New view: an editor opted in with `retainKey` keeps its unsaved values across an unmount/mount under one
// provider (a layout switch), and a switch sends nothing. Without `retainKey` nothing is retained.
// (Header mocks copied from the leave-guard mounted test.)
const nav = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: nav.replace, push: nav.push, refresh: vi.fn() }),
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
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;


const { ChartingStateProvider } = await import("@/components/charting-state-provider");

const BLOCK = {
  id: "b1",
  studio_id: "st1",
  session_id: "s1",
  sort_order: 1,
  mode: null,
  apilus_modality: null,
  energy_level: null,
  minutes_performed: null,
  machine_frequency: null,
  primary_area: "Upper lip",
  side: "center",
  custom_area_detail: null,
  probe_key: null,
  probe_lot_number: null,
  probe_lot_confirmed: false,
  block_notes: null,
  machine_profile_id: null,
  studio_machine_id: null,
  machine_mode_key: null,
  updated_at: "2026-11-06T10:00:00.000Z",
  deleted_at: null,
};


let root: ReturnType<typeof createRoot> | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = null;
});

function form(retainKey: string | undefined) {
  return createElement(BlockSetupForm, {
    sessionId: "s1",
    clientId: "c1",
    previousBlock: null,
    block: BLOCK as never,
    firstEntry: null,
    initialAreas: [{ area: "Upper lip", side: "center" }] as never,
    onCancel: () => undefined,
    retainKey,
  });
}
function shell(show: boolean, retainKey: string | undefined) {
  return createElement(ChartingStateProvider, null, show ? form(retainKey) : createElement("i"));
}
const notes = () => host!.querySelector<HTMLTextAreaElement>('[data-testid="additional-notes"]')!;
async function render(show: boolean, retainKey: string | undefined) {
  if (!root) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  }
  await act(async () => root!.render(shell(show, retainKey)));
}
async function type(text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(notes(), text);
    notes().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("retained editor state across a layout switch", () => {
  it("with retainKey, an unsaved note survives the editor being unmounted and mounted again, and nothing is sent", async () => {
    blockActions.updateTreatmentAreaWithEntryAction.mockReset();
    blockActions.createTreatmentAreaWithEntryAction.mockReset();
    await render(true, "block:b1");
    await type("unsaved note");
    await render(false, "block:b1");
    expect(host!.querySelector('[data-testid="additional-notes"]')).toBeNull();
    await render(true, "block:b1");
    expect(notes().value).toBe("unsaved note");
    expect(blockActions.updateTreatmentAreaWithEntryAction).not.toHaveBeenCalled();
    expect(blockActions.createTreatmentAreaWithEntryAction).not.toHaveBeenCalled();
  });

  it("CONTROL: without retainKey the same switch loses the value (today's behaviour is unchanged)", async () => {
    await render(true, undefined);
    await type("unsaved note");
    await render(false, undefined);
    await render(true, undefined);
    expect(notes().value).toBe("");
  });
});
