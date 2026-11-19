// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ChartingViewContext } from "@/components/charting-view-context";
import { NewViewHint } from "@/components/charting-view-context";
import { ChartingVisitSummary } from "@/components/charting-view-shell";
import type { ChartingView } from "@/lib/charting/view-preference";

// The New view copy: guidance lines that exist ONLY in New view, and the machine row of "This visit". Display only.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});
function mount(view: ChartingView | null, child: ReturnType<typeof createElement>) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const el = view === null ? child : createElement(ChartingViewContext.Provider, { value: { view, setView: () => undefined, notice: null } }, child);
  act(() => root!.render(el));
  return host;
}

describe("NewViewHint", () => {
  const hint = () => createElement(NewViewHint, { testId: "h" }, "Blank stays blank.");
  it("renders its text in New view", () => {
    expect(mount("new", hint()).querySelector('[data-testid="h"]')?.textContent).toBe("Blank stays blank.");
  });
  it("renders nothing in Current view", () => {
    expect(mount("current", hint()).querySelector('[data-testid="h"]')).toBeNull();
  });
  it("renders nothing outside the switch (every other page and bare form)", () => {
    expect(mount(null, hint()).querySelector('[data-testid="h"]')).toBeNull();
  });
});

describe("ChartingVisitSummary machine row", () => {
  const base = { clientName: "Avery Fixture", kind: "electrolysis" as const, areas: [], count: 0, nextVisitNoteRecorded: false };
  it("shows the machine line when there is one", () => {
    const h = mount("new", createElement(ChartingVisitSummary, { ...base, machineLine: "Room 1 · 27.12 MHz" }));
    expect(h.querySelector('[data-testid="visit-summary-machine"]')?.textContent).toBe("Room 1 · 27.12 MHz");
  });
  it("shows no machine row when there is none", () => {
    expect(mount("new", createElement(ChartingVisitSummary, base)).querySelector('[data-testid="visit-summary-machine"]')).toBeNull();
    expect(mount("new", createElement(ChartingVisitSummary, { ...base, machineLine: null })).textContent).not.toMatch(/Machine/);
  });
});
