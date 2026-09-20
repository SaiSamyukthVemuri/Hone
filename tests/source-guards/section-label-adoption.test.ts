import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

// ===========================================================================
// UX-02 — THE UPPERCASE SECTION LABEL HAS ONE OWNER.
//
// `components/ui/section-label.tsx` already renders this label. Ninety-seven
// call sites hand-rolled the identical class list, which makes them a
// DUPLICATE of the primitive rather than a variant of it: `--color-fg-muted`
// is `oklch(55.6% 0 0)` and is annotated "neutral-500" in app/globals.css,
// which is the same value `text-neutral-500` resolves to. The two render
// identically, so the hand-rolled form carries no information the primitive
// does not.
//
// WHY THIS PARSES RATHER THAN GREPS. An earlier guard family here matched
// `<Link href="…">Label</Link>` as TEXT, freezing the element's tag name and
// the character distance between two attributes; adding one prop broke three
// guards at once, each reporting only "no match". A second scan of this same
// pattern was corrupted a different way — it counted class lists that were
// sitting inside COMMENTS, and reported two already-converted files as the
// best remaining candidates.
//
// Both failures are gone here rather than patched. TypeScript is already a
// devDependency, so the parser is free: a comment is never a JsxAttribute, and
// the check reads each `className` literal as a SET of classes. Reorder the
// classes, reformat the attribute, rename the label, change the element from
// <span> to <p> — the answer does not move.
//
// WHY A RATCHET AND NOT A BAN. Seventy-six sites across thirty-three files are
// not adopted yet, and converting them in one change would be unreviewable.
// Two rules keep the list honest:
//
//   * a file NOT on the list may not contain the pattern at all — so neither a
//     new file nor an already-adopted one can reintroduce it;
//   * a file ON the list MUST still contain it — so an entry cannot outlive
//     its own adoption.
//
// The second rule is the one that matters later. An allowlist nobody is forced
// to prune quietly becomes permission.
// ===========================================================================

const REPO_ROOT = path.resolve(__dirname, "../..");
const PRIMITIVE = "components/ui/section-label.tsx";
const ROOTS = ["app", "components"];

/** The size rungs the primitive offers. A className carries exactly one. */
const SIZES = new Set(["text-xs", "text-[11px]"]);

/**
 * The contract, READ FROM THE PRIMITIVE rather than restated here.
 *
 * As a literal this would be a second source of truth: editing
 * section-label.tsx would leave the guard enforcing a contract the primitive
 * no longer has, still green, protecting nothing.
 *
 * `text-fg-muted` is the token spelling and `text-neutral-500` the raw one for
 * the same colour. Both belong to the contract because both render it, and the
 * call sites being retired use the raw spelling.
 */
function canonicalClasses(): Set<string> {
  const source = readFileSync(path.join(REPO_ROOT, PRIMITIVE), "utf8");
  const shared = /"([^"]*\bfont-medium\b[^"]*\buppercase\b[^"]*\btracking-wider\b[^"]*)"/.exec(
    source,
  );
  expect(
    shared,
    `${PRIMITIVE} no longer states its shared class string — update this guard with it`,
  ).toBeTruthy();
  return new Set([...shared![1].split(/\s+/).filter(Boolean), "text-neutral-500"]);
}

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
 * Every `className="…"` string literal in the file, via the AST.
 *
 * Only a JsxAttribute named `className` with a plain string initialiser is
 * considered. An expression container (`className={cx(...)}`) is deliberately
 * out of scope: composing the layers through `cx` is what the primitive itself
 * does, and flagging it would forbid the correct pattern along with the wrong
 * one.
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

/** The className literals in `file` whose class set IS the primitive. */
function handRolledSites(file: string, canonical: Set<string>): string[] {
  const source = readFileSync(path.join(REPO_ROOT, file), "utf8");
  const hits: string[] = [];
  for (const literal of classNameLiterals(source, file)) {
    const classes = literal.split(/\s+/).filter(Boolean);
    const set = new Set(classes);
    if (![...canonical].every((c) => set.has(c))) continue;
    const sizes = classes.filter((c) => SIZES.has(c));
    if (sizes.length !== 1) continue;
    // Anything beyond the contract plus one size makes it a VARIANT — a
    // caution colour, a layout class, a scroll offset — and the primitive does
    // not own those. Only an exact duplicate is a finding.
    if (classes.some((c) => !canonical.has(c) && c !== sizes[0])) continue;
    hits.push(literal);
  }
  return hits;
}

/**
 * Files that still hand-roll the label and are NOT adopted yet.
 *
 * This list may only shrink. `app/(app)/calendar/QuickBookDrawer.tsx` and
 * `app/(app)/records/page.tsx` are additionally owned by an open PR at the
 * time of writing, so they are not this lane's to convert.
 */
const LEGACY_UNADOPTED: readonly string[] = [
  "app/(app)/calendar/AppointmentNotesEditor.tsx",
  "app/(app)/calendar/AppointmentOutcomeRepair.tsx",
  "app/(app)/calendar/PractitionerCancelForm.tsx",
  "app/(app)/calendar/QuickBookDrawer.tsx",
  "app/(app)/calendar/[id]/ManualFeeChargeCard.tsx",
  "app/(app)/calendar/[id]/page.tsx",
  "app/(app)/clients/[id]/BookAppointment.tsx",
  "app/(app)/clients/[id]/intake/page.tsx",
  "app/(app)/clients/[id]/page.tsx",
  "app/(app)/clients/[id]/sessions/[sessionId]/block-setup-form.tsx",
  "app/(app)/clients/[id]/sessions/[sessionId]/page.tsx",
  "app/(app)/clients/[id]/sessions/[sessionId]/session-blocks-view.tsx",
  "app/(app)/clients/[id]/sessions/[sessionId]/simplified-entry-form.tsx",
  "app/(app)/clients/[id]/sessions/new/page.tsx",
  "app/(app)/dashboard/practice-snapshot.tsx",
  "app/(app)/records/page.tsx",
  "app/(app)/settings/booking/BookingLinkCard.tsx",
  "app/(app)/settings/consent/ConsentTemplatesEditor.tsx",
  "app/(app)/settings/intake/page.tsx",
  "app/(app)/settings/services/page.tsx",
  "app/(app)/settings/tracking/TrackingProviderSelector.tsx",
  "components/appointment/postcare-section.tsx",
  "components/clinical-notes-section.tsx",
  "components/consultation-notes-card.tsx",
  "components/log-electrolysis-entry-form.tsx",
  "components/multi-area-editor.tsx",
  "components/payment/payment-summary-card.tsx",
  "components/portal-messages-card.tsx",
  "components/probe-picker.tsx",
  "components/profile-tab-bar.tsx",
  "components/selected-observations.tsx",
  "components/treatment-intelligence-card.tsx",
  "components/treatment-plans-card.tsx",
];

const CANONICAL = canonicalClasses();
const FILES = ROOTS.flatMap((root) => walk(path.join(REPO_ROOT, root))).map((f) =>
  path.relative(REPO_ROOT, f),
);

describe("UX-02: the uppercase section label has one owner", () => {
  it("derives its contract from the primitive", () => {
    for (const c of ["font-medium", "uppercase", "tracking-wider", "text-neutral-500"]) {
      expect(CANONICAL.has(c), `contract lost ${c}`).toBe(true);
    }
  });

  it("finds className literals through the AST, not through comments", () => {
    // A commented-out call site is not a call site. This is asserted because a
    // regex scan of this exact pattern previously counted comments as real.
    const commented = `
      export function X() {
        // <span className="text-xs font-medium uppercase tracking-wider text-neutral-500">
        /* <span className="text-xs font-medium uppercase tracking-wider text-neutral-500"> */
        return <div>{/* <span className="text-xs font-medium uppercase tracking-wider text-neutral-500" /> */}</div>;
      }
    `;
    expect(classNameLiterals(commented, "commented.tsx")).toEqual([]);
  });

  it("no file outside the legacy list hand-rolls it", () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      if (file === PRIMITIVE) continue;
      if (LEGACY_UNADOPTED.includes(file)) continue;
      const hits = handRolledSites(file, CANONICAL);
      if (hits.length > 0) offenders.push(`${file}: ${hits.length}x "${hits[0]}"`);
    }
    expect(
      offenders,
      "use <SectionLabel> — this class list is exactly what the primitive renders",
    ).toEqual([]);
  });

  it("the legacy list may only shrink — every entry still hand-rolls it", () => {
    const stale = LEGACY_UNADOPTED.filter(
      (file) => handRolledSites(file, CANONICAL).length === 0,
    );
    expect(
      stale,
      "adopted — delete these from LEGACY_UNADOPTED so the list keeps shrinking",
    ).toEqual([]);
  });

  it("the surface this slice adopted is clean and off the list", () => {
    const adopted = FILES.filter((f) => f.startsWith("app/(app)/settings/availability/"));
    expect(adopted.length, "the adopted surface disappeared").toBeGreaterThan(0);
    for (const file of adopted) {
      expect(handRolledSites(file, CANONICAL), `${file} still hand-rolls it`).toEqual([]);
      expect(LEGACY_UNADOPTED).not.toContain(file);
    }
  });
});
