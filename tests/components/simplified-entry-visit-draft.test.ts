// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

const add = vi.hoisted(() => ({ fn: vi.fn(), load: vi.fn() }));
vi.mock("@/app/(app)/clients/[id]/sessions/[sessionId]/machine-setup-actions", () => ({ loadMachineSetupContext: add.load }));
vi.mock("@/app/(app)/clients/[id]/sessions/[sessionId]/actions", () => ({ addElectrolysisEntryAction: add.fn }));

import { createElement, act } from "react";
import { createRoot } from "react-dom/client";
import { SimplifiedEntryForm } from "@/app/(app)/clients/[id]/sessions/[sessionId]/simplified-entry-form";
import { ChartingVisitDraftProvider, useVisitDraftSummary } from "@/components/charting-visit-draft";
import { ChartingViewContext } from "@/components/charting-view-context";
import type { StudioDevice } from "@/lib/machines/selection";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Reader() {
  const s = useVisitDraftSummary();
  return createElement("output", { "data-u": String(s.unsaved), "data-a": String(s.attention), "data-m": s.machine ?? "" });
}
const BLOCK = { id: "b1", mode: null, apilus_modality: null, energy_level: null, minutes_performed: null, probe_type: null, probe_size: null, machine_frequency: null };

let root: ReturnType<typeof createRoot> | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = null;
  vi.clearAllMocks();
});
async function mount(block: Record<string, unknown> = BLOCK, view: "current" | "new" = "new") {
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  await act(async () =>
    root!.render(
      createElement(
        ChartingViewContext.Provider,
        { value: { view, setView: () => undefined, notice: null } },
        createElement(ChartingVisitDraftProvider, null, createElement(SimplifiedEntryForm, { block: block as never, sessionId: "s1", clientId: "c1" }), createElement(Reader)),
      ),
    ),
  );
}
const out = () => host!.querySelector("output")!;
const form = () => host!.querySelector<HTMLFormElement>('[data-testid="add-pass-form"]')!;
const textarea = () => host!.querySelector<HTMLTextAreaElement>("textarea")!;
const type = async (el: HTMLTextAreaElement, v: string) => {
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => {
    set.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const chip = () => Array.from(form().querySelectorAll<HTMLButtonElement>("button[type=button]")).find((b) => /upper lip|chin|lip/i.test(b.textContent ?? ""))!;
const submit = () => act(async () => void form().dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));

describe('"Add another pass" reports to This visit', () => {
  it("a pass with typed readings that is not saved shows as unsaved; an empty pass does not", async () => {
    await mount();
    expect(out().dataset.u).toBe("false");
    await type(textarea(), "a note");
    expect(out().dataset.u).toBe("true");
  });
  it("a failed submission shows as needing attention and stays unsaved", async () => {
    await mount();
    await type(textarea(), "a note");
    await submit(); // no area picked: refused client-side
    expect(add.fn).not.toHaveBeenCalled();
    expect(out().dataset.a).toBe("true");
    expect(out().dataset.u).toBe("true");
  });
  it("the persisted-but-unverified recovery lock shows as needing attention", async () => {
    await mount();
    await act(async () => chip().click());
    add.fn.mockResolvedValueOnce({ ok: false, code: "unverified", error: "Saved, but could not be confirmed. Reload and check." });
    await submit();
    expect(add.fn).toHaveBeenCalledTimes(1);
    expect(out().dataset.a).toBe("true");
  });
  it("a server refusal shows as needing attention; a successful pass clears both", async () => {
    await mount();
    const c = chip();
    expect(c, "an area chip exists").toBeTruthy();
    await act(async () => c.click());
    add.fn.mockResolvedValueOnce({ ok: false, code: "not_persisted", error: "Could not save." });
    await submit();
    expect(add.fn).toHaveBeenCalledTimes(1);
    expect(out().dataset.a).toBe("true");
    expect(out().dataset.u).toBe("true");
    add.fn.mockResolvedValueOnce({ ok: true });
    await submit();
    expect(out().dataset.u).toBe("false");
    expect(out().dataset.a).toBe("false");
  });
});

const PROFILE = { profileId: "fixture:mounted", version: 1, manufacturer: "Fixture", model: "Mounted", availability: "active" };
const DEVICE: StudioDevice = { deviceId: "room-9", studioId: "st", profileId: "fixture:mounted", profileVersion: 1, displayName: "Room 9 unit", installedOptions: [], retiredAt: null };
const ctx = (over: Record<string, unknown> = {}) => ({ scope: { studioId: "st", practitionerId: "p" }, devices: [DEVICE], catalogue: [PROFILE], legacyMachine: { label: "Dectro xCell" }, unitNames: { "room-9": "Room 9 unit" }, ...over });

describe("the add-pass form reports the machine it inherits from the saved block (New view)", () => {
  it("a live saved unit: the model's display label, with the block's frequency as stored", async () => {
    add.load.mockResolvedValue(ctx());
    await mount({ ...BLOCK, studio_machine_id: "room-9", machine_profile_id: "fixture:mounted", machine_frequency: "27.12 MHz" });
    expect(out().dataset.m).toBe("Fixture Mounted \u00b7 27.12 MHz");
  });
  it("a retired saved unit: its name, as no longer available", async () => {
    add.load.mockResolvedValue(ctx({ devices: [{ ...DEVICE, retiredAt: "2026-01-01T00:00:00.000Z" }] }));
    await mount({ ...BLOCK, studio_machine_id: "room-9", machine_profile_id: "fixture:mounted" });
    expect(out().dataset.m).toBe("Room 9 unit (no longer available)");
  });
  it("the existing xCell saved without a unit: the picker's own label", async () => {
    add.load.mockResolvedValue(ctx());
    await mount({ ...BLOCK, studio_machine_id: null, machine_profile_id: "dectro-apilus:xcell" });
    expect(out().dataset.m).toBe("Dectro xCell");
  });
  it("a block with no machine reports none, and reads nothing", async () => {
    await mount({ ...BLOCK, studio_machine_id: null, machine_profile_id: null });
    expect(add.load).not.toHaveBeenCalled();
    expect(out().dataset.m).toBe("");
  });
  it("Current view reads nothing and reports no machine", async () => {
    add.load.mockResolvedValue(ctx());
    await mount({ ...BLOCK, studio_machine_id: "room-9", machine_profile_id: "fixture:mounted" }, "current");
    expect(add.load).not.toHaveBeenCalled();
    expect(out().dataset.m).toBe("");
  });
  it("a failed read leaves the machine unreported, the form usable, and raises no unhandled rejection", async () => {
    const rejections: unknown[] = [];
    const onRej = (e: unknown) => rejections.push(e);
    process.on("unhandledRejection", onRej);
    add.load.mockRejectedValue(new Error("nope"));
    await mount({ ...BLOCK, studio_machine_id: "room-9", machine_profile_id: "fixture:mounted" });
    await act(async () => void (await new Promise((r) => setTimeout(r, 20))));
    process.off("unhandledRejection", onRej);
    expect(out().dataset.m).toBe("");
    expect(form()).not.toBeNull();
    expect(rejections).toEqual([]);
  });
  it("asks the machine-context action for exactly this visit's route values and this block, once", async () => {
    add.load.mockResolvedValue(ctx());
    await mount({ ...BLOCK, studio_machine_id: "room-9", machine_profile_id: "fixture:mounted" });
    expect(add.load).toHaveBeenCalledTimes(1);
    expect(add.load).toHaveBeenCalledWith({ clientId: "c1", sessionId: "s1", blockId: "b1" });
  });
  it("two passes on one visit share ONE read", async () => {
    add.load.mockResolvedValue(ctx());
    host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    const b = (id: string) => ({ ...BLOCK, id, studio_machine_id: "room-9", machine_profile_id: "fixture:mounted" });
    await act(async () =>
      root!.render(
        createElement(
          ChartingViewContext.Provider,
          { value: { view: "new", setView: () => undefined, notice: null } },
          createElement(ChartingVisitDraftProvider, null, createElement(SimplifiedEntryForm, { key: "1", block: b("b1") as never, sessionId: "s1", clientId: "c1" }), createElement(SimplifiedEntryForm, { key: "2", block: b("b2") as never, sessionId: "s1", clientId: "c1" }), createElement(Reader)),
        ),
      ),
    );
    await act(async () => void (await new Promise((r) => setTimeout(r, 30)))); // let any second read land before counting
    expect(add.load).toHaveBeenCalledTimes(1);
    expect(out().dataset.m).toBe("Fixture Mounted");
  });
});
