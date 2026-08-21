import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Dashboard memory visibility (Chloe production feedback).
//
// REPRODUCED DEFECT. The Today appointment card clipped the two lines Chloe
// actually reads before a client sits down, in TWO independent ways:
//   1. a JS character cap — `Remember: {truncate(workflow.remember, 70)}`;
//   2. Tailwind's `truncate` (= overflow:hidden; text-overflow:ellipsis;
//      white-space:nowrap) on BOTH the Remember span and the Latest-setup span.
// At 390px the usable text column is ~246px, so the CSS clamp bit at roughly
// 30-35 characters — long before the 70-char cap. The full text was already in
// the payload (lib/dashboard/before-today-previews.ts truncates nothing); only
// the render threw it away.
//
// SCOPE GUARD. Only those two fields change. The page-local `truncate` helper
// stays (the Pinned-note line still uses it) and the Daily Prep Brief keeps its
// own 90-char caps — a deliberately compact, separate surface.

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

// The Before-today preview block on the Today roster row: from the section
// eyebrow to the last (already-untruncated) records line.
// The preparation block of the combined Today card. The old generic
// "{beforeToday.recordsLine}" end-marker is gone with the record-count line, so
// the block now ends at the missing-record chips that replaced it.
// The preparation lines now live in their OWN component, rendered identically
// on Today and on any other selected day. That is what finally makes this suite
// day-independent: it used to slice the page's Today-only branch, so the
// clipping contract it protects was never asserted for the day a practitioner
// actually opens to prepare.
const RAW_BLOCK = read("app/(app)/dashboard/pre-visit-prep-block.tsx");
const BLOCK = RAW_BLOCK.split("\n")
  .filter((l) => !/^\s*\/\//.test(l))
  .join("\n")
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
  .replace(/\/\*[\s\S]*?\*\//g, "");
const PREVIEW_BLOCK = BLOCK.slice(BLOCK.indexOf("return ("));

describe("Today appointment card shows the memory lines in full", () => {
  it("isolated the right block of JSX", () => {
    expect(PREVIEW_BLOCK.length).toBeGreaterThan(200);
    expect(PREVIEW_BLOCK).toMatch(/Remember:/);
    expect(PREVIEW_BLOCK).toMatch(/Latest setup:/);
  });

  it("the Remember note is rendered whole — no character cap", () => {
    expect(PREVIEW_BLOCK).toMatch(/Remember: \{prep\.remember\.text\}/);
    expect(PREVIEW_BLOCK).not.toMatch(/truncate\(/);
  });

  it("the latest-settings line is rendered whole", () => {
    expect(PREVIEW_BLOCK).toMatch(/Latest setup: \{prep\.latestSetup\.line\}/);
    expect(PREVIEW_BLOCK).not.toMatch(/truncate\(/);
    // AND it carries no fallback copy. The `?? "Not recorded"` that used to sit
    // here turned an unread setup into a confident denial at the render site.
    expect(PREVIEW_BLOCK).not.toMatch(/Not recorded/);
    expect(PREVIEW_BLOCK).not.toMatch(/\?\?/);
  });

  it("NEITHER line carries a CSS clamp any more", () => {
    // \b...\b so the Tailwind CLASS is caught, not just a truncate(...) call —
    // the class is the mechanism that actually clipped the text on the phone.
    expect(PREVIEW_BLOCK).not.toMatch(/\btruncate\b/);
    expect(PREVIEW_BLOCK).not.toMatch(/line-clamp/);
    expect(PREVIEW_BLOCK).not.toMatch(/text-ellipsis/);
  });

  it("both lines wrap safely and keep intentional line breaks", () => {
    // Remember and Caution are now independent optional blocks (the old single
    // ternary folded the caution into Remember).
    const remember = PREVIEW_BLOCK.slice(
      PREVIEW_BLOCK.indexOf("{prep.remember && ("),
      PREVIEW_BLOCK.indexOf("{prep.caution && ("),
    );
    expect(remember).toMatch(/whitespace-pre-wrap break-words/);
    const setup = PREVIEW_BLOCK.slice(PREVIEW_BLOCK.indexOf("Latest setup:") - 300);
    expect(setup).toMatch(/whitespace-pre-wrap break-words/);
    // The caution is its own wrapped block, in the rose convention.
    const caution = PREVIEW_BLOCK.slice(
      PREVIEW_BLOCK.indexOf("{prep.caution && ("),
      PREVIEW_BLOCK.indexOf("{prep.latestSetup && ("),
    );
    expect(caution).toMatch(/whitespace-pre-wrap break-words/);
    expect(caution).toMatch(/text-rose-900/);
  });

  it("the desktop hover title is preserved on the Remember line", () => {
    expect(PREVIEW_BLOCK).toMatch(/title=\{prep\.remember\.text\}/);
  });
});

describe("nothing else on the dashboard changed", () => {
  it("the page-local truncate helper survives for the Pinned-note line", () => {
    expect(PAGE).toMatch(/function truncate\(text: string, max: number\): string/);
    expect(PAGE).toMatch(/\{truncate\(pinnedNoteText, 50\)\}/);
  });

  it("the prep model carries the memory notes uncapped", () => {
    // The 90-character cap that once lived in the brief is gone with the brief
    // itself, and the model that replaced it trims only the outer edges.
    const BUILD = read("lib/dashboard/prep/build-pre-visit-prep.ts");
    expect(BUILD).not.toMatch(/function truncate\(/);
    expect(BUILD).not.toMatch(/\.slice\(0,|substring\(|line-clamp|…/);
    expect(BUILD).toMatch(/const planText = plan\?\.text\?\.trim\(\)/);
    // Practitioner text is passed through verbatim, never summarised.
    expect(BUILD).toMatch(/text: caution\.text/);
  });

  it("the ONE appointment card wraps instead of clipping", () => {
    const PAGE = read("app/(app)/dashboard/page.tsx");
    const row = PAGE.slice(
      PAGE.indexOf("function AppointmentRow("),
      PAGE.indexOf("function AppointmentStatusPill("),
    );
    // The wrapping text now lives in the preparation block the row renders, so
    // the contract holds across the pair: the block wraps, and NEITHER clips.
    expect(RAW_BLOCK).toMatch(/whitespace-pre-wrap break-words/);
    expect(RAW_BLOCK).not.toMatch(/line-clamp/);
    expect(row).not.toMatch(/line-clamp/);
    // And the row really does render it, rather than having quietly dropped the
    // text — an empty slice would satisfy every negative assertion above.
    expect(row).toMatch(/<PreVisitPrepBlock/);
  });

  it("the preview data helper still truncates nothing (the fix is render-only)", () => {
    expect(PREVIEWS).toMatch(/rememberLine: remember,/);
    expect(PREVIEWS).toMatch(/setupLine: briefing\.latestSetupLine,/);
    expect(PREVIEWS).not.toMatch(/\.slice\(|substring\(|…/);
  });

  it("the row still grows instead of clipping (layout contract)", () => {
    // flex-wrap + items-start on the row and self-center on the action column:
    // a taller text column pushes the actions down/aside, never under them.
    //
    // The left padding became CONDITIONAL when the current-client highlight
    // landed (a 4px accent border replaces 4px of pl-4, so the time column
    // stays on the same line); the wrap/alignment contract this test exists for
    // is unchanged, so it is pinned without the padding shorthand.
    expect(PAGE).toMatch(/flex flex-wrap items-start justify-between gap-3 py-4 pr-4/);
    expect(PAGE).toMatch(/pl-4 hover:bg-neutral-50/);
    // The action footer tightened to `gap-1 self-start`: on a phone this
    // column wraps onto its own full-width line, where centring it against a
    // tall text column opened dead space with nothing in it.
    expect(PAGE).toMatch(/flex flex-col items-end gap-1 self-start/);
    expect(PAGE).toMatch(/className="min-w-0 flex-1"/);
  });
});
