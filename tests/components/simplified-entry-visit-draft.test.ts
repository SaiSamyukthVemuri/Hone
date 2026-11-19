// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

const add = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("@/app/(app)/clients/[id]/sessions/[sessionId]/actions", () => ({ addElectrolysisEntryAction: add.fn }));

import { createElement, act } from "react";
import { createRoot } from "react-dom/client";
import { SimplifiedEntryForm } from "@/app/(app)/clients/[id]/sessions/[sessionId]/simplified-entry-form";
import { ChartingVisitDraftProvider, useVisitDraftSummary } from "@/components/charting-visit-draft";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Reader() {
  const s = useVisitDraftSummary();
  return createElement("output", { "data-u": String(s.unsaved), "data-a": String(s.attention) });
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
async function mount() {
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  await act(async () =>
    root!.render(createElement(ChartingVisitDraftProvider, null, createElement(SimplifiedEntryForm, { block: BLOCK as never, sessionId: "s1", clientId: "c1" }), createElement(Reader))),
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
