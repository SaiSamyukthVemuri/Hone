// HON-46 (#896): THE PRINTOUT SHOWS EXACTLY WHAT THE SAVED RECORD SHOWS.
//
// Rounds 6-8 of #896's review each found another field where the printout's own
// presenter had drifted from the saved session view (reaction, numbing,
// tolerance, entry areas, entry probe). The fix is structural: the printout
// renders the view's OWN components (SavedAreaRecord, ElectrolysisEntryRow,
// LaserEntryRow; app/(records-export)/.../session-treatments.tsx). This test
// makes the next divergence impossible rather than findable: from ONE fixture
// (fixtures/saved-record-fixture.ts) it renders the REAL SessionBlocksView and
// the printout, and requires the same text, area by area and pass by pass,
// apart from the view's controls and EXACTLY the named print-only fields.
//
// No DOM library is installed (unit lane: node), so the markup is cut by its
// own stable markers: each saved area is a <section data-testid="area-section-
// ID">, each printed one a <section data-testid="export-block">, controls sit
// in [data-record-controls], print-only lines in <p data-print-only="LABEL">.

import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { SessionBlocksView } from "@/app/(app)/clients/[id]/sessions/[sessionId]/session-blocks-view";
import { ExportSessionTreatments } from "@/app/(records-export)/clients/[id]/records/export/session-treatments";
import { LaserEntryRow } from "@/components/entry-row";
import { PRINT_ONLY_FIELDS, buildClinicalRecordsDocument } from "@/lib/clinical-records/export-scope";
import { blocks, entries, exportInput, laserEntries, viewProps } from "./fixtures/saved-record-fixture";

// The saved view's text for the full fixture, CONTROLS INCLUDED, as rendered by
// the view BEFORE SavedAreaRecord was extracted from it (HEAD 25e0df7e). The
// extraction must not change what the saved record shows; a deliberate change
// to the view updates this line in the same commit.
const SAVED_VIEW_TEXT = "Recorded area Left cheeks \u00b7 Right sideburns \u00b7 along the jaw line Edit Remove area Blend \u00b7 PicoFlash \u00b7 EL 7 \u00b7 13.56 \u00b7 15 min Probe: Ballet F3 gold \u00b7 Lot #LOT-7 (confirmed) Numbing used Numbing notes: Topical, 30 minutes before Client tolerance: Needed pause / stopped early Legacy skin response: Swelling \u00b7 Legacy response note: Settled within the hour Caution for next session: Thin skin at the jaw Pass 1 Galvanic: 12.5 UL \u00b7 6s \u00b7 0.3 mA Thermolysis: 0.15 seconds \u00b7 22% \u00b7 3 pulses \u00b7 1.50s delay Hairs treated: 40 Coarse hair Client tolerated well Notes: Good release. Remove pass Pass 2 chin \u00b7 jaw Thermolysis: 2 seconds \u00b7 33% Remove pass Pass 3 Override Galvanic: 0.4 mA Coarse hair Notes: Client tolerated well Narrative after the chips. Remove pass + Add another pass Recorded area Main Edit Remove area Thermolysis Probe: Insulated \u00b7 F2 \u00b7 Lot #L9 No numbing used Caution for next session neck F2 \u00b7 Thermolysis Insulated Thermolysis: 2 pulses \u00b7 0.25s delay Hairs treated: 15 Mild redness Remove pass neck F2 \u00b7 Thermolysis Insulated Remove pass + Add another pass Area not recorded Treatment area 2 Edit Remove area Client tolerance: Mild discomfort Legacy skin response: Mild redness No entries yet. + Add another pass Recorded area upper lip \u00b7 Both sides Edit Remove area Thermolysis Client tolerance: Comfortable Thermolysis: 18% \u00b7 1 pulse Remove pass + Add another pass Unassigned entries These entries do not belong to a treatment area. Edit each to assign it. brows \u00b7 forehead Blend Thermolysis: 4 pulses \u00b7 0.75s delay Hairs treated: 8 Unassigned legacy narrative nose + Add settings block";

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

/** The element that opens at `start`, through its balanced close tag. */
function elementAt(html: string, start: number): string {
  const tag = /^<([a-z0-9]+)/i.exec(html.slice(start))![1];
  const re = new RegExp(`<${tag}\\b|</${tag}>`, "gi");
  re.lastIndex = start;
  let depth = 0;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    depth += m[0].startsWith("</") ? -1 : 1;
    if (depth === 0) return html.slice(start, m.index + m[0].length);
  }
  throw new Error("unbalanced markup");
}

/** Every element whose opening tag carries `attr` (e.g. data-testid="x"). */
function elementsWith(html: string, attr: RegExp): string[] {
  const out: string[] = [];
  const open = /<[a-z0-9]+\b[^>]*>/gi;
  for (let m = open.exec(html); m; m = open.exec(html)) {
    if (attr.test(m[0])) out.push(elementAt(html, m.index));
  }
  return out;
}

/** The markup with every element carrying `attr` removed. */
function without(html: string, attr: RegExp): string {
  let out = html;
  for (let found = elementsWith(out, attr); found.length > 0; found = elementsWith(out, attr)) {
    out = out.replace(found[0], "");
  }
  return out;
}

const CONTROLS = /data-record-controls=|<button\b/;

const viewHtml = renderToStaticMarkup(createElement(SessionBlocksView, viewProps()));
const doc = buildClinicalRecordsDocument(exportInput());
const printHtml = renderToStaticMarkup(createElement(ExportSessionTreatments, { session: doc.sessions[0], timezone: "America/Toronto" }));

describe("the saved session view itself is unchanged by sharing its render", () => {
  it("renders exactly the pre-extraction text for the full fixture", () => {
    expect(text(viewHtml)).toBe(SAVED_VIEW_TEXT);
  });
});

describe("PARITY: the printout is the saved record, plus only the named print-only fields", () => {
  const viewAreas = blocks.map((b) => {
    const [section] = elementsWith(viewHtml, new RegExp(`data-testid="area-section-${b.id}"`));
    return section;
  });
  const printAreas = elementsWith(printHtml, /data-testid="export-block"/);

  it("prints every saved area, in the view's order", () => {
    expect(printAreas).toHaveLength(blocks.length);
    expect(viewAreas.every(Boolean)).toBe(true);
  });

  it("each printed area's text is EXACTLY the saved view's, controls aside", () => {
    blocks.forEach((b, i) => {
      const saved = text(without(viewAreas[i], CONTROLS));
      const printed = text(without(printAreas[i], /data-print-only=/));
      expect(printed, `area ${b.id}`).toBe(saved);
    });
  });

  it("each unassigned pass prints exactly as the view's Unassigned entries row", () => {
    // The view's "Unassigned entries" section (SessionBlocksView, orphanEntries).
    const [unassigned] = elementsWith(viewHtml, /^<section class="rounded-lg border border-amber-300/);
    expect(text(unassigned)).toMatch(/^Unassigned entries/);
    const savedRows = elementsWith(unassigned, /^<li\b/).map((li) => text(without(li, CONTROLS)));
    const printedRows = elementsWith(printHtml, /data-testid="export-entry"/).map((li) => text(li));
    expect(printedRows).toHaveLength(entries.filter((e) => e.block_id === null).length);
    expect(printedRows).toEqual(savedRows);
  });

  it("each laser pass prints exactly LaserEntryRow, newest first as the session page lists them", () => {
    const newestFirst = [...laserEntries].sort((a, b) => b.created_at.localeCompare(a.created_at));
    const printed = elementsWith(printHtml, /data-testid="export-laser"/).map((d) => text(without(d, /data-print-only=/)));
    expect(printed).toEqual(newestFirst.map((l) => text(renderToStaticMarkup(createElement(LaserEntryRow, { entry: l as never })))));
    // The session page sorts its laser list newest first, beside LaserEntryRow.
    const page = readFileSync("app/(app)/clients/[id]/sessions/[sessionId]/page.tsx", "utf8");
    expect(page).toMatch(/new Date\(b\.created_at\)\.getTime\(\) - new Date\(a\.created_at\)\.getTime\(\),\s*\);[\s\S]{0,400}<LaserEntryRow/);
  });

  it("the ONLY additions are the named print-only fields, and each one prints", () => {
    const labels = [...printHtml.matchAll(/data-print-only="([^"]+)"/g)].map((m) => m[1]);
    const named = [...PRINT_ONLY_FIELDS.block, ...PRINT_ONLY_FIELDS.laser] as string[];
    expect(new Set(labels)).toEqual(new Set(named));
    expect(printHtml).toContain("Area notes: Legacy area note kept on paper");
    // The area's own recorded times, in the studio timezone (Codex P2 4347995164).
    expect(printHtml).toContain("Area started: October 1, 2026 at 11:05 a.m.");
    expect(printHtml).toContain("Area ended: October 1, 2026 at 11:20 a.m.");
    expect(printHtml).toContain("Results: Good ejection");
    // Every laser setting LaserEntryRow does not show is kept on paper.
    expect(printHtml).toContain("Settings: fluence j cm2 18 · cooling contact");
  });

  it("the printout carries no control at all", () => {
    expect(printHtml).not.toMatch(/<button\b|data-record-controls=|<form\b|<input\b/);
  });
});

describe("the fixture exercises every field the printout carries", () => {
  // Pinned to the ALLOW-LIST the builder copies: a field added to the record
  // without a fixture value that reaches the screen fails here.
  it("every block and pass field is set somewhere in the fixture", () => {
    const record = doc.sessions[0].blocks.map((b) => b.record);
    const blockKeys = Object.keys(record[0]).filter((k) => k !== "electrolysis_entries" && k !== "id");
    for (const key of blockKeys) {
      const set = record.some((r) => {
        const v = (r as Record<string, unknown>)[key];
        return v !== null && v !== undefined && v !== false && !(Array.isArray(v) && v.length === 0);
      });
      expect(set, `block field ${key}`).toBe(true);
    }
    const passes = [...record.flatMap((r) => r.electrolysis_entries), ...doc.sessions[0].entries];
    const entryKeys = Object.keys(passes[0]).filter((k) => k !== "id");
    for (const key of entryKeys) {
      const set = passes.some((p) => {
        const v = (p as Record<string, unknown>)[key];
        return v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0);
      });
      expect(set, `pass field ${key}`).toBe(true);
    }
  });
});

describe("the Codex findings that drove this, as named regressions", () => {
  const b1 = text(without(printAreas(), /data-print-only=/));
  function printAreas() {
    return elementsWith(printHtml, /data-testid="export-block"/)[0];
  }
  it("an edited legacy pass's OLD entry probe is not printed under a structured block (4307259893)", () => {
    expect(printHtml).not.toContain("OLD-PROBE-TYPE");
    expect(printHtml).not.toContain("OLD-F5");
  });
  it("a pass whose area repeats the header is not re-labelled; a differing one shows as the view does (4307259890)", () => {
    expect(b1).toContain("Pass 2 chin · jaw");
    const b4 = text(elementsWith(printHtml, /data-testid="export-block"/)[3]);
    expect(b4).not.toMatch(/Comfortable upper lip/);
  });
  it("tolerance, numbing and the legacy reaction print as the view words them (4307190165, 4305737602, 4304382927)", () => {
    expect(b1).toContain("Client tolerance: Needed pause / stopped early");
    expect(printHtml).toContain("No numbing used");
    expect(printHtml).not.toContain("stray note that must not imply numbing");
    expect(b1).toContain("Legacy skin response: Swelling");
  });
});
