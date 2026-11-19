import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChartingViewContext, NewViewOnlyStep } from "@/components/charting-view-context";

const render = (view: "current" | "new" | null) => {
  const step = createElement(NewViewOnlyStep, { n: 4, title: "Review & finish" });
  return renderToStaticMarkup(
    view === null ? step : createElement(ChartingViewContext.Provider, { value: { view, setView: () => undefined, notice: null } }, step),
  );
};

describe("NewViewOnlyStep", () => {
  it("renders the numbered step in New view", () => {
    const h = render("new");
    expect(h).toContain('data-testid="new-view-step-4"');
    expect(h).toContain("Review &amp; finish");
  });
  it("renders NOTHING in Current view, and nothing outside any switch, so Current's markup is unchanged", () => {
    expect(render("current")).toBe("");
    expect(render(null)).toBe("");
  });
});

// The page: steps 4 and 5 sit before the existing sections they head, in the existing order, and those sections are the existing controls.
const page = readFileSync("app/(app)/clients/[id]/sessions/[sessionId]/page.tsx", "utf8");
const at = (needle: string) => {
  const i = page.indexOf(needle);
  expect(i, needle).toBeGreaterThan(-1);
  return i;
};
describe("the session page's New view steps 4 and 5", () => {
  it("step 4 heads the finish checklist and step 5 heads the session payment card, in page order; the next-visit section stays unnumbered", () => {
    const photos = at("<SessionPhotos clientId");
    const next = at("<NextVisitNoteForm");
    const s4 = at('<NewViewOnlyStep n={4} title="Review & finish" />');
    const finish = at('data-testid="finish-appointment"');
    const complete = at("<MarkAppointmentCompleteControl");
    const postcare = at("<PostcareSection");
    const s5 = at('<NewViewOnlyStep n={5} title="Session payment" />');
    const pay = at("<SessionPaymentPrepareCard");
    expect([photos, next, s4, finish, complete, postcare, s5, pay]).toEqual([photos, next, s4, finish, complete, postcare, s5, pay].sort((a, b) => a - b));
    expect(page).not.toContain('title="Next visit"');
  });
  it("each step is used once, and nothing renders a step in Current view from the page itself", () => {
    expect((page.match(/<NewViewOnlyStep /g) ?? []).length).toBe(2);
    expect(page).not.toMatch(/<NewViewStep /);
  });
  it("the finish, postcare and payment controls are the existing ones, still imported from where they were", () => {
    expect(page).toContain('from "@/components/appointment/mark-complete-control"');
    expect(page).toContain('from "@/components/appointment/postcare-section"');
    expect(page).toContain('from "@/components/session-payment-prepare-card"');
    expect(page).toContain('from "./NextVisitNoteForm"');
  });
});
