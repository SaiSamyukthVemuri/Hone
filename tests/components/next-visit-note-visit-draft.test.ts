// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createRoot } from "react-dom/client";
import { createElement, act } from "react";
import { ChartingVisitDraftProvider, useVisitDraftSummary } from "@/components/charting-visit-draft";
import { NextVisitNoteForm } from "@/app/(app)/clients/[id]/sessions/[sessionId]/NextVisitNoteForm";
import { readingsSaveNeedsAttention } from "@/components/machines/machine-reading-entry";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Reader() {
  const s = useVisitDraftSummary();
  return createElement("output", { "data-u": String(s.unsaved), "data-a": String(s.attention), "data-all": JSON.stringify(s) });
}
let root: ReturnType<typeof createRoot> | null = null;
let host: HTMLElement | null = null;
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = host = null; });

async function mount(action: (fd: FormData) => Promise<unknown>) {
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  await act(async () => root!.render(createElement(ChartingVisitDraftProvider, null, createElement(NextVisitNoteForm, { sessionId: "s1", clientId: "c1", initialNote: "", action: action as never }), createElement(Reader))));
}
const out = () => host!.querySelector("output")!;
const ta = () => host!.querySelector<HTMLTextAreaElement>("textarea")!;
const type = (v: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(ta(), v);
  ta().dispatchEvent(new Event("input", { bubbles: true }));
});
const saveBtn = () => Array.from(host!.querySelectorAll("button")).find((b) => /Save note|Saving/.test(b.textContent ?? ""))!;
const press = () => act(async () => void saveBtn().click());

describe("the next-visit note reports to This visit", () => {
  it("untouched: nothing unsaved, no attention", async () => {
    await mount(vi.fn());
    expect([out().dataset.u, out().dataset.a]).toEqual(["false", "false"]);
  });
  it("editing the note makes the visit unsaved", async () => {
    await mount(vi.fn());
    await type("remember this");
    expect([out().dataset.u, out().dataset.a]).toEqual(["true", "false"]);
  });
  it("a saved note is no longer unsaved", async () => {
    await mount(vi.fn(async () => ({ ok: true, cleared: false })));
    await type("remember this");
    await press();
    expect([out().dataset.u, out().dataset.a]).toEqual(["false", "false"]);
  });
  it("a refused save needs attention and stays unsaved", async () => {
    await mount(vi.fn(async () => ({ ok: false, error: "Could not save." })));
    await type("remember this");
    await press();
    expect([out().dataset.u, out().dataset.a]).toEqual(["true", "true"]);
  });
  it("NO summary field (machine, areas, unsaved, attention, anything) carries the note text, saved or not", async () => {
    await mount(vi.fn(async () => ({ ok: true, cleared: false })));
    await type("PRIVATE-NOTE-TEXT-7731");
    expect(out().dataset.all).not.toContain("7731");
    await press();
    expect(out().dataset.all).not.toContain("7731");
    expect(Object.keys(JSON.parse(out().dataset.all!)).sort()).toEqual(["attention", "draftAreas", "machine", "unsaved"]);
  });
  it("the recency token is the note's length and an edit counter, never its text", () => {
    const src = readFileSync("app/(app)/clients/[id]/sessions/[sessionId]/NextVisitNoteForm.tsx", "utf8");
    expect(src).toMatch(/activity: `\$\{note\.length\}:\$\{edits\}`/);
    expect(src).not.toMatch(/activity: note\b/);
  });
});

describe("readingsSaveNeedsAttention: the truth table", () => {
  const base = { pending: false, unresolved: false, recorded: false, message: null as string | null };
  it.each([
    [{}, false],
    [{ message: "refused" }, true],
    [{ message: "refused", recorded: true }, false],
    [{ unresolved: true }, true],
    [{ unresolved: true, recorded: true, message: "unknown" }, true],
    [{ unresolved: true, message: "unknown", pending: true }, false],
    [{ message: "refused", pending: true }, false],
  ])("%j -> %s", (over, want) => {
    expect(readingsSaveNeedsAttention({ ...base, ...over })).toBe(want);
  });
});
