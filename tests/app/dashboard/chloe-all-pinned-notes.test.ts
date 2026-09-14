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
// POINT 2 WAS REVERTED. Routing an UPCOMING appointment at the existing
// `sessions/new` path means calling `start_session`, whose coalescence is
// expressed purely in time. No value of `p_coalesce_minutes` is safe: a window
// above zero adopts another appointment's session, and a window of zero cannot
// see the row the first of two near-simultaneous taps just inserted, so both
// insert. That was proved against a real database, and fixing it properly needs
// DB authority this PR does not have. Only point 1 ships here.
// ===========================================================================

const ROOT = path.resolve(__dirname, "../../..");
const DASH = readFileSync(path.join(ROOT, "app/(app)/dashboard/page.tsx"), "utf8");
const QUERIES = readFileSync(path.join(ROOT, "lib/client-pinned-notes/queries.ts"), "utf8");

/** Comment-stripped, so explanatory prose can neither satisfy an assertion nor
 *  break an absence check by naming the thing it explains. */
const code = (s: string) => s.replace(/\/\/.*$/gm, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
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

  it("PAGINATES rather than capping — and never truncates with .limit()", () => {
    // An earlier revision of this test asserted the loader used no `.range(`
    // at all. That was wrong: an unbounded select is silently capped at
    // PostgREST's max_rows (1000), which is the same loss this fix exists to
    // remove. Paging with a deterministic order is the fix; `.limit()` would
    // still be a truncation.
    expect(QUERIES_CODE).not.toMatch(/\.limit\(/);
    expect(QUERIES_CODE).toMatch(/fetchAllRows</);
    expect(QUERIES_CODE).toMatch(/\.range\(from, to\)/);
    expect(QUERIES_CODE).toMatch(/assertDeterministicOrder\("client_pinned_notes", \["created_at", "id"\]\)/);
    // The id tiebreak is what makes paging over repeated created_at values safe.
    expect(QUERIES_CODE).toMatch(/\.order\("id", \{ ascending: false \}\)/);
  });

  it("does not disturb the client-profile pinned notes", () => {
    expect(QUERIES).toMatch(/export async function getPinnedNotesForClient/);
  });
});
