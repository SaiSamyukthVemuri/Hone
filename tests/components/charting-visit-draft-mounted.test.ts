// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { createElement, act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { ChartingVisitDraftProvider, useReportVisitDraft, useVisitDraftSummary, type VisitDraftReport } from "@/components/charting-visit-draft";
import { ChartingVisitSummary } from "@/components/charting-view-shell";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const base: VisitDraftReport = { machine: null, draftAreas: [], unsaved: false, attention: false };
function Form({ id, report }: { id: string; report: VisitDraftReport }) {
  useReportVisitDraft(id, report);
  return null;
}
function Reader() {
  const s = useVisitDraftSummary();
  return createElement("output", { "data-m": s.machine ?? "", "data-a": s.draftAreas.join("|"), "data-u": String(s.unsaved) });
}

let root: ReturnType<typeof createRoot> | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = null;
});
async function render(children: ReactNode) {
  host ??= document.body.appendChild(document.createElement("div"));
  root ??= createRoot(host);
  await act(async () => root!.render(createElement(ChartingVisitDraftProvider, null, children, createElement(Reader))));
}
const out = () => host!.querySelector("output")!;

describe("a closed form's report", () => {
  it("is removed when the form unmounts, so nothing lingers in This visit", async () => {
    await render(createElement(Form, { id: "block:a", report: { ...base, machine: "Dectro xCell", draftAreas: ["Chin"], unsaved: true } }));
    expect(out().dataset.m).toBe("Dectro xCell");
    expect(out().dataset.a).toBe("Chin");
    expect(out().dataset.u).toBe("true");
    await render(null);
    expect(out().dataset.m).toBe("");
    expect(out().dataset.a).toBe("");
    expect(out().dataset.u).toBe("false");
  });
});

describe("with several open forms the Machine row follows the one most recently EDITED", () => {
  const form = (id: string, machine: string, activity: string) =>
    createElement(Form, { key: id, id: `block:${id}`, report: { ...base, machine, unsaved: true, activity } });
  it("A, then B, then A again, with both forms dirty and every summary value unchanged", async () => {
    await render([form("a", "Unit A", "a1"), form("b", "Unit B", "b1")]);
    expect(out().dataset.m, "b reported last").toBe("Unit B");
    await render([form("a", "Unit A", "a2"), form("b", "Unit B", "b1")]);
    expect(out().dataset.m, "A was edited after B").toBe("Unit A");
    await render([form("a", "Unit A", "a2"), form("b", "Unit B", "b2")]);
    expect(out().dataset.m, "B was edited after A").toBe("Unit B");
    await render([form("a", "Unit A", "a3"), form("b", "Unit B", "b2")]);
    expect(out().dataset.m, "A edited again while B is still dirty").toBe("Unit A");
  });
  it("the unsaved flag flipping (a save completing) is not an edit and does not reorder the forms", async () => {
    const f = (id: string, machine: string, activity: string, unsaved: boolean) =>
      createElement(Form, { key: id, id: `block:${id}`, report: { ...base, machine, unsaved, activity } });
    await render([f("a", "Unit A", "a1", true), f("b", "Unit B", "b1", true)]);
    expect(out().dataset.m).toBe("Unit B");
    await render([f("a", "Unit A", "a1", false), f("b", "Unit B", "b1", true)]);
    expect(out().dataset.m, "A's save completed; B is still the form last edited").toBe("Unit B");
  });
  it("a re-render with no edit does not reorder the forms", async () => {
    await render([form("a", "Unit A", "a1"), form("b", "Unit B", "b1")]);
    await render([form("a", "Unit A", "a1"), form("b", "Unit B", "b1")]);
    expect(out().dataset.m).toBe("Unit B");
  });
  it("a most-recent form with no machine does not hide another form's machine", async () => {
    await render([createElement(Form, { key: "a", id: "block:a", report: { ...base, machine: "Unit A", activity: "1" } }), createElement(Form, { key: "b", id: "block:b", report: { ...base, draftAreas: ["Chin"], activity: "1" } })]);
    expect(out().dataset.m).toBe("Unit A");
  });
});

describe("the Session payment step is listed only where the payment card renders", () => {
  const html = (paymentStep?: boolean) =>
    renderToStaticMarkup(createElement(ChartingVisitSummary, { clientName: "Avery Example", kind: "electrolysis", areas: [], count: 0, nextVisitNoteRecorded: false, ...(paymentStep === undefined ? {} : { paymentStep }) }));
  it("listed for an eligible owner", () => {
    expect(html(true)).toContain("Session payment");
  });
  it("not listed otherwise (a practitioner, or an ineligible session)", () => {
    expect(html(false)).not.toContain("Session payment");
    expect(html(false)).toContain("Review &amp; finish");
  });
});
