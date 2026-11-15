import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RowSafetyLines } from "@/app/(app)/dashboard/row-safety-lines";

// HON-65 regression (Chloe, 4 Nov): the Dashboard stopped showing "Last treatment". The compact-row change (#1308) moved
// the one-line summary inside the CLOSED "Visit details" disclosure, and every dashboard e2e opens that disclosure on
// load, so nothing noticed. The one line belongs on the closed row; only the full chart stays behind the disclosure.

const read = (p: string) => readFileSync(p, "utf8");
const PAGE = read("app/(app)/dashboard/page.tsx");
const MEMORY = read("app/(app)/dashboard/dashboard-treatment-memory.tsx");
const SUMMARY = "12 Mar 2026 · electrolysis · chin, upper lip · 25 min";

const html = (lastTreatment: string | null) =>
  renderToStaticMarkup(createElement(RowSafetyLines, { pinnedNotes: null, unavailable: false, caution: null, lastTreatment }));

describe("the Last treatment line is on the CLOSED row", () => {
  it("RowSafetyLines paints it, wrapped, as plain text (the row body is a link)", () => {
    const out = html(SUMMARY);
    expect(out).toContain('data-testid="dashboard-memory-compact"');
    expect(out).toContain("Last treatment: ");
    expect(out).toContain(SUMMARY);
    expect(out).toContain("whitespace-pre-wrap break-words");
    expect(out).not.toContain("<button");
  });

  it("paints nothing when there is no previous treatment (a silent absence is not a claim)", () => {
    expect(html(null)).toBe("");
  });

  it("the page feeds it from the prep authority, outside the details", () => {
    expect(PAGE).toMatch(/lastTreatment=\{prepSummary\.hasTreatment \? prepSummary\.compactSummary : null\}/);
    const row = PAGE.slice(PAGE.indexOf("<RowSafetyLines"), PAGE.indexOf("</PendingContainerLink>"));
    expect(row).toContain("lastTreatment=");
  });

  it("the disclosure no longer paints a second copy, but keeps the full-chart toggle", () => {
    expect(MEMORY).not.toContain("Last treatment: ");
    expect(MEMORY).not.toContain('data-testid="dashboard-memory-compact"');
    expect(MEMORY).toContain('data-testid="dashboard-memory-toggle"');
  });
});
