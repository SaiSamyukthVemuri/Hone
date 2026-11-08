// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Codex, #1369 4493497730: the leave guard was disarmed while "Saving…" was pending, so closing, reloading or following a link mid-save
// could lose an unconfirmed draft (and, for a create, the retry key). It is armed while a request is in flight, through an unknown or
// lost reply, and through a definitive refusal; only a CONFIRMED save releases it. Mounted: the real form, the real hook, a real
// beforeunload event. Synthetic records.
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
const { BlockSetupForm, leaveGuardArmed } = await import("@/app/(app)/clients/[id]/sessions/[sessionId]/block-setup-form");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

beforeEach(() => {
  blockActions.updateTreatmentAreaWithEntryAction.mockReset();
  blockActions.createTreatmentAreaWithEntryAction.mockReset();
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = null;
});

async function mount(create = false) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      createElement(BlockSetupForm, {
        sessionId: "s1",
        clientId: "c1",
        previousBlock: null,
        block: create ? null : (BLOCK as never),
        firstEntry: null,
        initialAreas: [{ area: "Upper lip", side: "center" }] as never,
        onCancel: () => undefined,
      }),
    );
  });
}
async function makeDirty() {
  const ta = host!.querySelector<HTMLTextAreaElement>('[data-testid="additional-notes"]')!;
  expect(ta, "the notes field must exist").not.toBeNull();
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(ta, "an unsaved note");
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const save = async () => {
  await act(async () => {
    host!.querySelector<HTMLButtonElement>('[data-testid="save-treatment-area"]')!.click();
  });
};
/** Would leaving the page now be held? beforeunload is cancelable and the guard prevents it while armed. */
function leaveIsHeld() {
  const ev = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(ev);
  return ev.defaultPrevented;
}

describe("the pure rule", () => {
  it("anything unsaved arms it; only a confirmed save releases it", () => {
    expect(leaveGuardArmed(true, false)).toBe(true);
    expect(leaveGuardArmed(true, true)).toBe(false);
    expect(leaveGuardArmed(false, false)).toBe(false);
  });
});

describe("the leave guard on the real form", () => {
  it("CONTROL: nothing edited, nothing held", async () => {
    await mount();
    expect(leaveIsHeld()).toBe(false);
  });

  it("armed once the draft is dirty", async () => {
    await mount();
    await makeDirty();
    expect(leaveIsHeld()).toBe(true);
  });

  it("ARMED WHILE THE REQUEST IS IN FLIGHT (it used to be disarmed here)", async () => {
    let settle!: (v: unknown) => void;
    blockActions.updateTreatmentAreaWithEntryAction.mockImplementation(() => new Promise((r) => (settle = r)));
    await mount();
    await makeDirty();
    await save();
    expect(blockActions.updateTreatmentAreaWithEntryAction).toHaveBeenCalledTimes(1);
    expect(leaveIsHeld(), "closing mid-save would lose the unconfirmed draft").toBe(true);
    await act(async () => settle({ ok: false, error: "x" }));
  });

  it("armed after a lost reply (the call rejects)", async () => {
    blockActions.updateTreatmentAreaWithEntryAction.mockRejectedValue(new Error("network"));
    await mount();
    await makeDirty();
    await save();
    await act(async () => undefined);
    expect(leaveIsHeld()).toBe(true);
  });

  it("armed after a definitive refusal while the draft is unsaved", async () => {
    blockActions.updateTreatmentAreaWithEntryAction.mockResolvedValue({ ok: false, error: "Refused." });
    await mount();
    await makeDirty();
    await save();
    expect(host!.textContent).toContain("Refused.");
    expect(leaveIsHeld()).toBe(true);
  });

  it("released after a confirmed success", async () => {
    blockActions.updateTreatmentAreaWithEntryAction.mockResolvedValue({ ok: true });
    await mount();
    await makeDirty();
    await save();
    await act(async () => undefined);
    expect(leaveIsHeld()).toBe(false);
  });
});

// Codex #1369 4506141998: a NEW area saved UNCHANGED (prefilled values; the draft equals its baseline) was not unsaved, so an in-flight or
// unresolved create did not arm the guard, and leaving dropped the create key (which is not in the URL). The create attempt is a registry
// owner: unresolved from submit until a CONFIRMED outcome.
describe("the leave guard on a CREATE saved without any edit", () => {
  it("CONTROL: an untouched new area holds nothing", async () => {
    await mount(true);
    expect(leaveIsHeld()).toBe(false);
  });

  it("IN FLIGHT: armed although the draft equals its baseline", async () => {
    let settle!: (v: unknown) => void;
    blockActions.createTreatmentAreaWithEntryAction.mockImplementation(() => new Promise((r) => (settle = r)));
    await mount(true);
    await save();
    expect(blockActions.createTreatmentAreaWithEntryAction, "the create reached the action").toHaveBeenCalledTimes(1);
    expect(leaveIsHeld(), "leaving now drops the create key").toBe(true);
    await act(async () => settle({ ok: false, error: "No." }));
  });

  it("LOST RESPONSE: still armed, the key is kept (no second create is possible) and Save stays closed", async () => {
    blockActions.createTreatmentAreaWithEntryAction.mockRejectedValue(new Error("network"));
    await mount(true);
    await save();
    await act(async () => undefined);
    const first = blockActions.createTreatmentAreaWithEntryAction.mock.calls[0][0] as { createKey: string | null };
    expect(first.createKey, "the create was keyed").toEqual(expect.any(String));
    expect(leaveIsHeld(), "armed through the lost answer").toBe(true);
    expect(host!.querySelector<HTMLButtonElement>('[data-testid="save-treatment-area"]')!.disabled, "no retry that could duplicate").toBe(true);
    expect(blockActions.createTreatmentAreaWithEntryAction).toHaveBeenCalledTimes(1);
  });

  it("A DEFINITIVE REFUSAL with no lost answer is a confirmed outcome: nothing committed, nothing to protect", async () => {
    blockActions.createTreatmentAreaWithEntryAction.mockResolvedValue({ ok: false, error: "Refused." });
    await mount(true);
    await save();
    await act(async () => undefined);
    expect(host!.textContent).toContain("Refused.");
    expect(leaveIsHeld()).toBe(false);
  });

  it("CONFIRMED SUCCESS: disarmed", async () => {
    blockActions.createTreatmentAreaWithEntryAction.mockResolvedValue({ ok: true });
    await mount(true);
    await save();
    await act(async () => undefined);
    expect(blockActions.createTreatmentAreaWithEntryAction).toHaveBeenCalledTimes(1);
    expect(leaveIsHeld()).toBe(false);
  });
});
