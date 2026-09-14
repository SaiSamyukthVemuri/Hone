import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// ===========================================================================
// CHLOE-DASH-01 — two production complaints, one surface
// ===========================================================================
//
//  1. "Not all the pinned notes show up on dashboard. If I pin multiple notes
//     I need to see all of them."
//  2. The right-side action should be "Chart session", not "Review Before
//     Today".
//
// Point 2 is a change to the ACTION ONLY. The Before Today preparation data is
// what Chloe reads to prepare, and it must keep rendering in the row — these
// assertions exist so a future tidy-up cannot quietly take it away along with
// the label.
// ===========================================================================

const ROOT = path.resolve(__dirname, "../../..");
const DASH = readFileSync(path.join(ROOT, "app/(app)/dashboard/page.tsx"), "utf8");
const NEXT = readFileSync(path.join(ROOT, "lib/dashboard/next-action.ts"), "utf8");
const QUERIES = readFileSync(path.join(ROOT, "lib/client-pinned-notes/queries.ts"), "utf8");

/** Comment-stripped, so explanatory prose can neither satisfy an assertion nor
 *  break an absence check by naming the thing it explains. */
const code = (s: string) => s.replace(/\/\/.*$/gm, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
const NEXT_CODE = code(NEXT);
const QUERIES_CODE = code(QUERIES);
const DASH_CODE = code(DASH);

describe("A — every pinned note reaches the roster", () => {
  it("loads the GROUPED collection, not a latest-only map", () => {
    expect(DASH_CODE).toMatch(/getPinnedNotesByClient/);
    expect(DASH_CODE).not.toMatch(/getLatestPinnedNoteByClient/);
    expect(QUERIES_CODE).not.toMatch(/getLatestPinnedNoteByClient/);
    expect(QUERIES_CODE).toMatch(/Promise<Map<string, ClientPinnedNote\[\]>>/);
  });

  it("renders EVERY note, and truncates none of them", () => {
    expect(DASH).toMatch(/pinnedNotes\.map\(/);
    expect(DASH_CODE).not.toMatch(/truncate\(pinnedNote/);
    expect(DASH).toMatch(/whitespace-pre-wrap/);
  });

  it("keeps the amber Pinned semantic", () => {
    expect(DASH).toMatch(/text-amber-800/);
    expect(DASH).toMatch(/Pinned/);
  });

  it("wraps rather than overflowing sideways on a phone", () => {
    // break-words + min-w-0 are what stop a long note from widening the row.
    expect(DASH).toMatch(/break-words/);
    expect(DASH).toMatch(/min-w-0/);
  });

  it("applies no cap in the loader", () => {
    expect(QUERIES_CODE).not.toMatch(/\.limit\(/);
    expect(QUERIES_CODE).not.toMatch(/\.range\(/);
  });

  it("does not disturb the client-profile pinned notes", () => {
    expect(QUERIES).toMatch(/export async function getPinnedNotesForClient/);
  });
});

describe("B — the right-side action is Chart session", () => {
  it("the retired literal is gone from the resolver", () => {
    expect(NEXT_CODE).not.toMatch(/"Review Before Today"/);
  });

  it("offers Chart session on the existing appointment-linked route", () => {
    expect(NEXT_CODE).toMatch(/"Chart session"/);
    expect(NEXT_CODE).toMatch(/sessions\/new\?appointment_id=\$\{input\.appointmentId\}/);
  });

  it("does NOT invent a charting system", () => {
    // The completed branch already used this route; the upcoming branch reuses
    // it rather than adding one.
    const uses = NEXT_CODE.match(/sessions\/new\?appointment_id=/g) ?? [];
    expect(uses.length).toBeGreaterThanOrEqual(2);
    expect(NEXT_CODE).not.toMatch(/\/charting|\/chart\/new|createChartingSession/);
  });

  it("BEFORE TODAY PREPARATION STILL RENDERS — only the action moved", () => {
    expect(DASH).toMatch(/Before today/i);
    expect(DASH).toMatch(/getBeforeTodayPreviews/);
    expect(DASH).toMatch(/workflow &&/);
  });

  it("intake and card-on-file indicators are untouched", () => {
    expect(DASH).toMatch(/IntakePill/);
    expect(DASH).toMatch(/resolveCardOnFileStatus/);
  });
});
