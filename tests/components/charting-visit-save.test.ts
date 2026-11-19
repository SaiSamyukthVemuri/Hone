// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const add = vi.hoisted(() => ({ fn: vi.fn(), load: vi.fn() }));
vi.mock("@/app/(app)/clients/[id]/sessions/[sessionId]/machine-setup-actions", () => ({ loadMachineSetupContext: add.load }));
vi.mock("@/app/(app)/clients/[id]/sessions/[sessionId]/actions", () => ({ addElectrolysisEntryAction: add.fn }));

import { createElement, act, useRef, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { ChartingVisitSaveProvider, VisitSaveControl, useRegisterVisitSaver, type SaveOutcome } from "@/components/charting-visit-save";
import { ChartingVisitDraftProvider } from "@/components/charting-visit-draft";
import { SimplifiedEntryForm } from "@/app/(app)/clients/[id]/sessions/[sessionId]/simplified-entry-form";
import { NextVisitNoteForm } from "@/app/(app)/clients/[id]/sessions/[sessionId]/NextVisitNoteForm";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | null = null;
let host: HTMLElement | null = null;
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = host = null; vi.clearAllMocks(); });

function Section({ id, label, saver }: { id: string; label: string; saver: () => Promise<SaveOutcome> }) {
  const ref = useRef<HTMLDivElement>(null);
  useRegisterVisitSaver(id, label, ref, saver);
  return createElement("div", { ref, "data-testid": `sec-${id}` });
}
async function mount(...kids: ReactElement[]) {
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  await act(async () => root!.render(createElement(ChartingVisitSaveProvider, null, ...kids, createElement(VisitSaveControl))));
}
const btn = () => host!.querySelector<HTMLButtonElement>('[data-testid="visit-save-button"]')!;
const click = () => act(async () => void btn().click());
const res = (id: string) => host!.querySelector(`[data-testid="visit-save-result-${id}"]`);
const deferred = () => { let r!: (o: SaveOutcome) => void; const p = new Promise<SaveOutcome>((x) => (r = x)); return { p, r }; };

describe("Save visit runs each section's own save, in order, never forcing anything", () => {
  it("the second section is not called until the first has resolved", async () => {
    const d = deferred();
    const first = vi.fn(() => d.p);
    const second = vi.fn(async (): Promise<SaveOutcome> => ({ status: "saved" }));
    await mount(createElement(Section, { id: "a", label: "A", saver: first }), createElement(Section, { id: "b", label: "B", saver: second }));
    await click();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    await act(async () => d.r({ status: "saved" }));
    expect(second).toHaveBeenCalledTimes(1);
  });
  it("a refused first section does not hide the second: both are attempted and both results shown", async () => {
    await mount(
      createElement(Section, { id: "a", label: "A", saver: async (): Promise<SaveOutcome> => ({ status: "failed", message: "Could not save." }) }),
      createElement(Section, { id: "b", label: "B", saver: async (): Promise<SaveOutcome> => ({ status: "saved" }) }),
    );
    await click();
    expect(res("a")!.getAttribute("data-status")).toBe("failed");
    expect(res("a")!.textContent).toContain("Could not save.");
    expect(res("b")!.getAttribute("data-status")).toBe("saved");
  });
  it("a saver that THROWS is a failed result, and the next section still runs", async () => {
    const next = vi.fn(async (): Promise<SaveOutcome> => ({ status: "saved" }));
    await mount(createElement(Section, { id: "a", label: "A", saver: async () => { throw new Error("x"); } }), createElement(Section, { id: "b", label: "B", saver: next }));
    await click();
    expect(res("a")!.getAttribute("data-status")).toBe("failed");
    expect(next).toHaveBeenCalledTimes(1);
  });
  it("a double click calls each section exactly once, and the button is disabled while running", async () => {
    const d = deferred();
    const a = vi.fn(() => d.p);
    await mount(createElement(Section, { id: "a", label: "A", saver: a }));
    await act(async () => { btn().click(); btn().click(); });
    expect(btn().disabled).toBe(true);
    await act(async () => void btn().click());
    expect(a).toHaveBeenCalledTimes(1);
    await act(async () => d.r({ status: "saved" }));
    expect(btn().disabled).toBe(false);
  });
  it("a held section is reported and its own result is shown, and a section with nothing to save is not a failure", async () => {
    await mount(
      createElement(Section, { id: "a", label: "A", saver: async (): Promise<SaveOutcome> => ({ status: "held", message: "Locked." }) }),
      createElement(Section, { id: "b", label: "B", saver: async (): Promise<SaveOutcome> => ({ status: "nothing" }) }),
    );
    await click();
    expect(res("a")!.textContent).toContain("Not saved");
    expect(res("b")!.textContent).toContain("Nothing to save");
  });
  it("sections run top to bottom on the page, whatever order they registered in", async () => {
    const order: string[] = [];
    const mk = (id: string) => async (): Promise<SaveOutcome> => { order.push(id); return { status: "saved" }; };
    await mount(createElement(Section, { id: "late", label: "L", saver: mk("late") }), createElement(Section, { id: "early", label: "E", saver: mk("early") }));
    // Registered in mount order (late, early); move `early` before `late` in the DOM.
    const early = host!.querySelector('[data-testid="sec-early"]')!;
    host!.insertBefore(early, host!.firstChild);
    await click();
    expect(order).toEqual(["early", "late"]);
  });
  it("a section that closed before its turn is skipped, not called", async () => {
    const gone = vi.fn(async (): Promise<SaveOutcome> => ({ status: "saved" }));
    let hide!: () => void;
    function Pair() {
      const [show, setShow] = (require("react") as typeof import("react")).useState(true);
      hide = () => setShow(false);
      return createElement("div", null, createElement(Section, { id: "a", label: "A", saver: async (): Promise<SaveOutcome> => { hide(); return { status: "saved" }; } }), show ? createElement(Section, { id: "b", label: "B", saver: gone }) : null);
    }
    await mount(createElement(Pair));
    await click();
    expect(gone).not.toHaveBeenCalled();
  });
  it("renders no control with no sections", async () => {
    await mount();
    expect(host!.querySelector('[data-testid="visit-save"]')).toBeNull();
  });
  it("the results markup never contains what was typed", async () => {
    await mount(createElement(Section, { id: "a", label: "Next-visit note", saver: async (): Promise<SaveOutcome> => ({ status: "saved" }) }));
    await click();
    expect(host!.innerHTML).not.toContain("PRIVATE");
  });
});

describe("with the REAL forms", () => {
  const BLOCK = { id: "b1", mode: null, apilus_modality: null, energy_level: null, minutes_performed: null, probe_type: null, probe_size: null, machine_frequency: null };
  const note = vi.fn(async () => ({ ok: true, cleared: false }));
  async function mountReal() {
    host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    await act(async () =>
      root!.render(
        createElement(ChartingVisitDraftProvider, null,
          createElement(ChartingVisitSaveProvider, null,
            createElement(SimplifiedEntryForm, { block: BLOCK as never, sessionId: "s1", clientId: "c1" }),
            createElement(NextVisitNoteForm, { sessionId: "s1", clientId: "c1", initialNote: "", action: note as never }),
            createElement(VisitSaveControl))),
      ),
    );
  }
  const type = (v: string) => act(async () => {
    const all = host!.querySelectorAll<HTMLTextAreaElement>("textarea");
    const ta = all[all.length - 1]; // the next-visit note is the last textarea
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(ta, v);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  });
  it("nothing edited: no action is called at all", async () => {
    await mountReal();
    await click();
    expect(add.fn).not.toHaveBeenCalled();
    expect(note).not.toHaveBeenCalled();
    expect(res("note")!.getAttribute("data-status")).toBe("nothing");
    expect(res("pass:b1")!.getAttribute("data-status")).toBe("nothing");
  });
  it("an edited note is saved through the note's own action, once", async () => {
    await mountReal();
    await type("PRIVATE remember this");
    await click();
    expect(note).toHaveBeenCalledTimes(1);
    expect(res("note")!.getAttribute("data-status")).toBe("saved");
    expect(host!.querySelector('[data-testid="visit-save"]')!.innerHTML).not.toContain("PRIVATE");
  });
  it("a refused note shows its own failure and is retryable by the next Save visit", async () => {
    note.mockResolvedValueOnce({ ok: false, error: "Could not save." } as never);
    await mountReal();
    await type("x");
    await click();
    expect(res("note")!.getAttribute("data-status")).toBe("failed");
    await click();
    expect(note).toHaveBeenCalledTimes(2);
    expect(res("note")!.getAttribute("data-status")).toBe("saved");
  });
  it("an add-pass with a lost answer is HELD, never resubmitted by Save visit", async () => {
    add.fn.mockRejectedValueOnce(new Error("network"));
    await mountReal();
    // Pick an area through the form's own control, then submit it with its own button (the lost answer).
    const chip = Array.from(host!.querySelectorAll("button")).find((b) => /Upper lip/i.test(b.textContent ?? ""));
    expect(chip, "an area chip exists").toBeTruthy();
    await act(async () => void chip!.click());
    await act(async () => void host!.querySelector<HTMLFormElement>('[data-testid="add-pass-form"]')!.requestSubmit());
    expect(add.fn).toHaveBeenCalledTimes(1);
    await click();
    expect(add.fn).toHaveBeenCalledTimes(1);
    expect(res("pass:b1")!.getAttribute("data-status")).toBe("held");
  });
});

describe("source: Save visit is an orchestrator, not a second save path", () => {
  const read = (p: string) => readFileSync(p, "utf8");
  it("the orchestrator imports no server action and calls no finish, postcare or payment code", () => {
    const src = read("components/charting-visit-save.tsx").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""); // code only: the header names what it never does
    expect(src).not.toMatch(/from "[^"]*actions[^"]*"/);
    expect(src).not.toMatch(/payment|postcare|createTreatmentArea|updateTreatmentArea|addElectrolysisEntry/i);
    expect(src).not.toMatch(/setView|useChartingView/);
  });
  it("the block form's button and its Save visit saver run the SAME function", () => {
    const src = read("app/(app)/clients/[id]/sessions/[sessionId]/block-setup-form.tsx");
    expect(src).toMatch(/function submit\(\) \{\s*startTransition\(async \(\) => \{\s*await runSave\(\);/);
    expect(src).toMatch(/useRegisterVisitSaver\([\s\S]*?p = runSave\(\);/);
    expect(src.match(/createTreatmentAreaWithEntryAction\(\{/g)).toHaveLength(1);
  });
});
