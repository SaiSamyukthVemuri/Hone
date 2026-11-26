import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
const RAW_PAGE = read("app/(app)/dashboard/page.tsx");
// COMMENTS OUT, BEFORE SLICING. The block below is located by searching for the
// phrase "Before today", and this page explains itself at length — a design
// note that merely NAMES the block would otherwise move the start marker above
// the real eyebrow and drag unrelated JSX (the client-name `truncate` class,
// the pinned-note `truncate(...)` call) into the slice, turning the CSS-clamp
// assertion red for a prose edit. Same idiom as
// tests/app/dashboard/today-treatment-memory.test.ts.
const PAGE = RAW_PAGE.split("\n")
  .filter((l) => !/^\s*\/\//.test(l))
  .join("\n")
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
const PREVIEWS = read("lib/dashboard/before-today-previews.ts");
const WORKFLOW = read("lib/dashboard/today-workflow.ts");

const ACTIONS = read("app/(app)/dashboard/visit-actions.tsx");
const note = ACTIONS.match(/<section\s+data-testid="dashboard-prep-remember"[\s\S]*?<\/section>/)?.[0] ?? "";
const card = read("components/dashboard-prior-treatment.tsx");

describe("the dashboard shows the full note and last treatment settings", () => {
  it("shows the appointment-specific note in full, including line breaks", () => {
    expect(note).toContain("From last visit, for today");
    expect(note).toContain("border-blue-200 bg-blue-50");
    expect(note).toContain("{note}</p>");
    expect(note).toContain("whitespace-pre-wrap break-words");
    expect(note).not.toMatch(/truncate|line-clamp|text-ellipsis/);
  });

  it("shows the full recorded probe, readings and notes for each area on expansion", () => {
    expect(card).toContain("setup.probeLine");
    expect(card).toContain("<ReadingList readings={sharedReadings}");
    expect(card).toContain("<ReadingList readings={readings}");
    expect(card).toContain("readings.map(");
    expect(card).toContain("{reading.value}");
    expect(card).toContain("{note.text}");
    expect(card).toContain("whitespace-pre-wrap break-words");
    expect(card).not.toMatch(/truncate|line-clamp|text-ellipsis/);
  });

  it("keeps the full caution visible and distinguishes a failed read", () => {
    const safety = read("app/(app)/dashboard/row-safety-lines.tsx");
    expect(PAGE).toContain("caution={workflow && !workflow.unavailable && workflow.hasHistory ? workflow.caution : null}");
    expect(safety).toContain("Caution: {caution}");
    expect(safety).toContain('title={caution}');
    expect(safety).toMatch(/whitespace-pre-wrap break-words/);
  });
});

describe("nothing else on the dashboard changed", () => {
  it("pinned notes are rendered WHOLE and in full — never truncated to one line", () => {
    // THIS TEST PREVIOUSLY PINNED THE DEFECT. It asserted
    // `{truncate(pinnedNoteText, 50)}`, which is exactly the behaviour Chloe
    // reported: multiple pinned notes collapsed to one 50-character line. The
    // roster now renders every note, wrapping instead of slicing.
    const SAFETY = read("app/(app)/dashboard/row-safety-lines.tsx");
    expect(PAGE).not.toMatch(/truncate\(pinnedNote/);
    expect(PAGE).toContain("pinnedNotes={appt.client ? null : pinnedNotes}");
    const editable = PAGE.indexOf("<DashboardQuickPin");
    expect(editable).toBeGreaterThan(PAGE.indexOf("</PendingContainerLink>"));
    expect(PAGE.slice(editable, PAGE.indexOf("/>", editable))).toContain("pinnedNotes=");
    // Every pin from the page data is rendered (the list handed to RowPinnedNotes is built from the whole of
    // pinnedNotes, plus any just-saved pin), never a slice.
    const quickPin = read("app/(app)/dashboard/dashboard-quick-pin.tsx");
    expect(quickPin).toContain("<RowPinnedNotes pinnedNotes={shown}");
    expect(quickPin).toMatch(/\.\.\.pinnedNotes\.map\(/);
    expect(quickPin).not.toMatch(/pinnedNotes\.slice\(/);
    expect(SAFETY).toMatch(/pinnedNotes\.map\(/);
    expect(SAFETY).toMatch(/whitespace-pre-wrap/);
    expect(PAGE).not.toMatch(/line-clamp[^\s"']*[^\s"']*/);
    expect(SAFETY).not.toMatch(/line-clamp/);
  });

  it("the combined workflow model carries the memory notes uncapped", () => {
    // The 90-character cap that once lived in the brief is gone with the brief
    // itself. The combined model trims only the outer edges and never slices.
    expect(WORKFLOW).not.toMatch(/function truncate\(/);
    expect(WORKFLOW).not.toMatch(/\.slice\(0,|substring\(|line-clamp|…/);
    expect(WORKFLOW).toMatch(/const remember = trimmedOrNull\(input\.nextVisitNote\)/);
    expect(WORKFLOW).toMatch(/const caution = trimmedOrNull\(input\.cautionNote\)/);
  });

  it("the ONE appointment card wraps instead of clipping", () => {
    const PAGE = read("app/(app)/dashboard/page.tsx");
    const row = PAGE.slice(
      PAGE.indexOf("function AppointmentRow("),
      PAGE.indexOf("function AppointmentStatusPill("),
    );
    expect(row + ACTIONS).toMatch(/whitespace-pre-wrap break-words/);
    expect(row + ACTIONS).not.toMatch(/line-clamp/);
  });

  it("the preview data helper still truncates nothing (the fix is render-only)", () => {
    expect(PREVIEWS).toMatch(/rememberLine: remember,/);
    expect(PREVIEWS).toMatch(/setupLine: briefing\.latestSetupLine,/);
    expect(PREVIEWS).not.toMatch(/\.slice\(|substring\(|…/);
  });

  it("the row still grows instead of clipping (layout contract)", () => {
    expect(PAGE).toMatch(/flex flex-wrap items-start gap-x-3 gap-y-1 py-3 pr-4/);
    expect(PAGE).toMatch(/pl-4 hover:bg-neutral-50/);
    // Primary actions have their own wrapping line, above the last-visit disclosure.
    const actions = ACTIONS.match(/data-testid="today-row-actions" className="([^"]+)"/)?.[1] ?? "";
    for (const token of ["min-w-0", "basis-full", "flex-wrap", "items-center"]) {
      expect(actions.split(" ")).toContain(token);
    }
    expect(PAGE.indexOf("<VisitActionRow")).toBeLessThan(PAGE.indexOf('data-testid="today-row-details"'));
    expect(PAGE).toMatch(/className="min-w-0 flex-1"/);
  });
});
