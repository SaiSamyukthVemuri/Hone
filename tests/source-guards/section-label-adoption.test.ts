import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

// ===========================================================================
// UX-02 — SECTION LABEL ADOPTION, PROVED FOR THIS BOUNDED SLICE.
//
// `components/ui/section-label.tsx` owns the uppercase section label. Twenty-one
// call sites across Settings → Availability spelled its class list out by hand;
// this slice replaced them with the primitive. `--color-fg-muted` is
// `oklch(55.6% 0 0)`, annotated "neutral-500" in app/globals.css, so the two
// render identically and the hand-rolled form carried no information.
//
// WHAT THIS PROVES, AND DELIBERATELY NOTHING MORE:
//
//   1. every converted file uses SectionLabel;
//   2. no converted file still contains the hand-rolled duplicate;
//   3. legacy occurrence counts do not INCREASE from the measured baseline;
//   4. SectionLabel remains the source of truth for the contract.
//
// WHAT THIS DOES NOT ATTEMPT, AND WHY THAT IS A DECISION RATHER THAN A GAP.
//
// It reads `className="…"` string literals from the AST. It does NOT interpret
// conditional expressions, nested templates, arbitrary `cx(...)` composition,
// cross-module values, or JavaScript generally.
//
// An earlier revision of this file did try. It grew constant resolution,
// lexical scope tracking and call-argument combination, and across six review
// rounds twelve findings landed — nine of them edges in THAT machinery rather
// than in the thing being protected, and one a false positive that would have
// failed correct code. The asymmetry is the argument: a missed duplicate costs
// one duplicated class list, while a false positive blocks work that was never
// wrong.
//
// Preventing every possible syntactic spelling requires a Tailwind/TypeScript
// interpreter. That is a tooling-architecture problem, recorded as debt, and
// not something a bounded primitive-adoption slice should carry.
//
// The failure this DOES prevent is the one that actually recurs: a duplicate
// copied from a neighbouring file during ordinary work, written as a plain
// literal.
// ===========================================================================

const REPO_ROOT = path.resolve(__dirname, "../..");
const PRIMITIVE = "components/ui/section-label.tsx";
const PRIMITIVE_SOURCE = readFileSync(path.join(REPO_ROOT, PRIMITIVE), "utf8");
/**
 * The files this slice actually converted.
 *
 * Named explicitly rather than derived from the directory: Settings →
 * Availability also contains page.tsx, PractitionerWeekEditor.tsx and
 * ScopeSelector.tsx, which carried no hand-rolled label and were correctly left
 * alone. A prefix match would have demanded the primitive from files that never
 * needed it.
 */
const CONVERTED: readonly string[] = [
  "app/(app)/settings/availability/AvailabilityClient.tsx",
  "app/(app)/settings/availability/RecurringBreaksSection.tsx",
  "app/(app)/settings/availability/ScopeField.tsx",
  "app/(app)/settings/availability/TimedBlocksSection.tsx",
];
const ROOTS = ["app", "components"];

/**
 * The contract, READ FROM THE PRIMITIVE (requirement 4).
 *
 * Restating it here would make this file a second source of truth: editing
 * section-label.tsx would leave the guard enforcing a contract the primitive no
 * longer has, green and protecting nothing.
 */
function contractFromPrimitive(): {
  typography: Set<string>;
  muted: Set<string>;
  sizes: Set<string>;
} {
  const shared = /"([^"]*\bfont-medium\b[^"]*\buppercase\b[^"]*\btracking-wider\b[^"]*)"/.exec(
    PRIMITIVE_SOURCE,
  );
  const tone = /tone === "muted" && "([a-z0-9-]+)"/.exec(PRIMITIVE_SOURCE);
  const sizeBlock = /const SIZE = \{([\s\S]*?)\} as const;/.exec(PRIMITIVE_SOURCE);
  expect(shared, `${PRIMITIVE} no longer states its shared class string`).toBeTruthy();
  expect(tone, `${PRIMITIVE} no longer states its muted tone class`).toBeTruthy();
  expect(sizeBlock, `${PRIMITIVE} no longer declares a SIZE map`).toBeTruthy();
  return {
    typography: new Set(shared![1].split(/\s+/).filter(Boolean)),
    // The token spelling is read from the primitive; `text-neutral-500` is the
    // raw spelling the legacy call sites use for the same colour.
    muted: new Set([tone![1], "text-neutral-500"]),
    sizes: new Set([...sizeBlock![1].matchAll(/:\s*"([^"]+)"/g)].map((m) => m[1])),
  };
}

const CONTRACT = contractFromPrimitive();

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx$/.test(entry)) out.push(full);
  }
  return out;
}

/**
 * `className="…"` string literals, via the AST.
 *
 * The parser is used rather than a regex for one narrow reason: a comment is
 * never a JsxAttribute. A regex scan of this same pattern was corrupted by
 * matches sitting inside comments and reported two already-converted files as
 * the best remaining candidates. Expression containers are out of scope by
 * design — see the header.
 */
function classNameLiterals(source: string, fileName: string): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isJsxAttribute(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "className" &&
      node.initializer &&
      ts.isStringLiteral(node.initializer)
    ) {
      out.push(node.initializer.text);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return out;
}

/** Hand-rolled duplicates of the primitive in `file`. */
function duplicates(file: string): string[] {
  const source = readFileSync(path.join(REPO_ROOT, file), "utf8");
  return classNameLiterals(source, file).filter((literal) => {
    const classes = [...new Set(literal.split(/\s+/).filter(Boolean))];
    const set = new Set(classes);
    if (![...CONTRACT.typography].every((c) => set.has(c))) return false;
    if (!classes.some((c) => CONTRACT.muted.has(c))) return false;
    if (classes.filter((c) => CONTRACT.sizes.has(c)).length !== 1) return false;
    // Anything else makes it a VARIANT — a caution colour, a layout class — and
    // the primitive does not own those.
    return !classes.some(
      (c) => !CONTRACT.typography.has(c) && !CONTRACT.muted.has(c) && !CONTRACT.sizes.has(c),
    );
  });
}

/**
 * The measured baseline: files still hand-rolling the label, and how many times.
 *
 * Counts may FALL as surfaces are adopted; they may not RISE. An exact-equality
 * rule was tried and rejected — it turned every partial adoption into
 * bookkeeping churn without protecting anything more, because the regression
 * being guarded against is growth.
 *
 * `calendar/QuickBookDrawer.tsx` and `records/page.tsx` are owned by another PR
 * and are not this lane's to convert.
 */
const LEGACY_BASELINE: ReadonlyArray<readonly [string, number]> = [
  ["app/(app)/calendar/AppointmentNotesEditor.tsx", 1],
  ["app/(app)/calendar/AppointmentOutcomeRepair.tsx", 1],
  ["app/(app)/calendar/PractitionerCancelForm.tsx", 1],
  ["app/(app)/calendar/QuickBookDrawer.tsx", 5],
  ["app/(app)/calendar/[id]/ManualFeeChargeCard.tsx", 1],
  ["app/(app)/calendar/[id]/page.tsx", 15],
  ["app/(app)/clients/[id]/BookAppointment.tsx", 6],
  ["app/(app)/clients/[id]/intake/page.tsx", 1],
  ["app/(app)/clients/[id]/page.tsx", 1],
  ["app/(app)/clients/[id]/sessions/[sessionId]/block-setup-form.tsx", 4],
  ["app/(app)/clients/[id]/sessions/[sessionId]/page.tsx", 4],
  ["app/(app)/clients/[id]/sessions/[sessionId]/session-blocks-view.tsx", 1],
  ["app/(app)/clients/[id]/sessions/[sessionId]/simplified-entry-form.tsx", 3],
  ["app/(app)/clients/[id]/sessions/new/page.tsx", 1],
  ["app/(app)/dashboard/practice-snapshot.tsx", 2],
  ["app/(app)/records/page.tsx", 2],
  ["app/(app)/settings/booking/BookingLinkCard.tsx", 1],
  ["app/(app)/settings/consent/ConsentTemplatesEditor.tsx", 1],
  ["app/(app)/settings/intake/page.tsx", 1],
  ["app/(app)/settings/services/page.tsx", 2],
  ["app/(app)/settings/tracking/TrackingProviderSelector.tsx", 2],
  ["components/appointment/postcare-section.tsx", 1],
  ["components/clinical-notes-section.tsx", 3],
  ["components/consultation-notes-card.tsx", 2],
  ["components/log-electrolysis-entry-form.tsx", 2],
  ["components/multi-area-editor.tsx", 1],
  ["components/payment/payment-summary-card.tsx", 1],
  ["components/portal-messages-card.tsx", 2],
  ["components/probe-picker.tsx", 3],
  ["components/profile-tab-bar.tsx", 1],
  ["components/selected-observations.tsx", 1],
  ["components/treatment-intelligence-card.tsx", 1],
  ["components/treatment-plans-card.tsx", 3],
];

const BASELINE = new Map(LEGACY_BASELINE.map(([f, n]) => [f, n]));
const FILES = ROOTS.flatMap((root) => walk(path.join(REPO_ROOT, root))).map((f) =>
  path.relative(REPO_ROOT, f),
);
const ADOPTED = CONVERTED;

describe("UX-02: SectionLabel adoption on Settings → Availability", () => {
  it("4. the contract is read from the primitive, not restated here", () => {
    for (const c of ["font-medium", "uppercase", "tracking-wider"]) {
      expect(CONTRACT.typography.has(c), `contract lost ${c}`).toBe(true);
    }
    expect(CONTRACT.muted.has("text-fg-muted"), "the primitive's muted token went unread").toBe(
      true,
    );
    expect(CONTRACT.sizes.size, "the primitive's SIZE map went unread").toBeGreaterThan(0);
  });

  it("1. every converted file uses SectionLabel", () => {
    expect(ADOPTED.length, "the converted set disappeared").toBe(4);
    for (const file of ADOPTED) {
      expect(FILES, `${file} is no longer in the tree`).toContain(file);
    }
    const without = ADOPTED.filter(
      (file) => !readFileSync(path.join(REPO_ROOT, file), "utf8").includes("<SectionLabel"),
    );
    expect(without, "converted files must render the primitive").toEqual([]);
  });

  it("2. no converted file still hand-rolls the duplicate", () => {
    for (const file of ADOPTED) {
      expect(duplicates(file), `${file} still hand-rolls the label`).toEqual([]);
      expect(BASELINE.has(file), `${file} should not be on the legacy baseline`).toBe(false);
    }
  });

  it("2b. the conversion is complete — 21 sites across the four converted files", () => {
    // The slice's own claim, asserted rather than described: counting the
    // primitive's usages is what makes "21 exact conversions" checkable.
    const total = ADOPTED.reduce(
      (sum, file) =>
        sum +
        (readFileSync(path.join(REPO_ROOT, file), "utf8").match(/<SectionLabel[\s>]/g) ?? []).length,
      0,
    );
    expect(total, "the converted site count moved").toBe(21);
  });

  it("3. legacy occurrence counts never increase from the baseline", () => {
    const grown: string[] = [];
    for (const [file, baseline] of LEGACY_BASELINE) {
      const actual = duplicates(file).length;
      if (actual > baseline) grown.push(`${file}: baseline ${baseline}, found ${actual}`);
    }
    expect(grown, "a legacy file gained hand-rolled labels").toEqual([]);
  });

  it("3b. no file outside the baseline introduces the duplicate", () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      if (file === PRIMITIVE || BASELINE.has(file)) continue;
      const hits = duplicates(file);
      if (hits.length > 0) offenders.push(`${file}: ${hits.length}x "${hits[0]}"`);
    }
    expect(offenders, "use <SectionLabel> — this is exactly what it renders").toEqual([]);
  });

  it("reads literals from the AST, so a comment is not a call site", () => {
    const commented = `
      export function X() {
        // <span className="text-xs font-medium uppercase tracking-wider text-neutral-500">
        return <div>{/* <span className="text-xs font-medium uppercase tracking-wider text-neutral-500" /> */}</div>;
      }
    `;
    expect(classNameLiterals(commented, "commented.tsx")).toEqual([]);
  });
});
