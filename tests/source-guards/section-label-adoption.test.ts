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
//
// WHAT THIS GUARD DOES NOT ATTEMPT, STATED SO THE SCOPE HAS AN END.
//
// It resolves statically-known strings in the file it is reading: literals,
// module- and function-scoped string constants, and the concatenation of
// multi-fragment cx() calls. It does NOT evaluate a class list imported from
// another module, assembled from a computed key, or interpolated through a
// template with a substitution. Those are reachable by someone determined to
// evade it, and chasing them would turn a source guard into a constant folder.
//
// That boundary is a judgement, not an oversight: the failure this exists to
// prevent is a duplicate reappearing by HABIT — copied from a neighbouring file
// during ordinary work — and every form habit actually takes is covered. It is
// recorded here so the next reader can tell the difference between a gap that
// was considered and one that was missed.
// ===========================================================================

const REPO_ROOT = path.resolve(__dirname, "../..");
const PRIMITIVE = "components/ui/section-label.tsx";
const ROOTS = ["app", "components"];

const PRIMITIVE_SOURCE = readFileSync(path.join(REPO_ROOT, PRIMITIVE), "utf8");

/**
 * The size rungs, READ FROM the primitive's own SIZE map.
 *
 * These were restated here while the tone was derived, which is the same
 * source-of-truth gap one rung down: changing `SIZE.caption` in the primitive
 * would have left this guard treating the OLD value as canonical, unable to see
 * a duplicate using the new one, and green throughout.
 */
function sizeRungs(): Set<string> {
  const block = /const SIZE = \{([\s\S]*?)\} as const;/.exec(PRIMITIVE_SOURCE);
  expect(
    block,
    `${PRIMITIVE} no longer declares a SIZE map — update this guard with it`,
  ).toBeTruthy();
  const values = [...block![1].matchAll(/:\s*"([^"]+)"/g)].map((m) => m[1]);
  expect(values.length, "the primitive's SIZE map went unread").toBeGreaterThan(0);
  return new Set(values);
}

/**
 * The contract, READ FROM THE PRIMITIVE rather than restated here.
 *
 * As a literal this would be a second source of truth: editing
 * section-label.tsx would leave the guard enforcing a contract the primitive no
 * longer has, still green, protecting nothing.
 */
function canonicalTypography(): Set<string> {
  const shared = /"([^"]*\bfont-medium\b[^"]*\buppercase\b[^"]*\btracking-wider\b[^"]*)"/.exec(
    PRIMITIVE_SOURCE,
  );
  expect(
    shared,
    `${PRIMITIVE} no longer states its shared class string — update this guard with it`,
  ).toBeTruthy();
  return new Set(shared![1].split(/\s+/).filter(Boolean));
}

/**
 * Every spelling of the muted foreground, and why there is more than one.
 *
 * The primitive emits the TOKEN form, `text-fg-muted`. The call sites being
 * retired spell the same colour raw, as `text-neutral-500` — `--color-fg-muted`
 * is `oklch(55.6% 0 0)` and is annotated "neutral-500" in app/globals.css.
 *
 * An earlier version of this guard required the RAW spelling, so a hand-rolled
 * label written with the TOKEN would have been an exact duplicate that the
 * guard could not see. The token is read from the primitive; the raw spelling
 * is listed because it is what the legacy sites use.
 */
function mutedSpellings(): Set<string> {
  const token = /tone === "muted" && "([a-z0-9-]+)"/.exec(PRIMITIVE_SOURCE);
  expect(
    token,
    `${PRIMITIVE} no longer states its muted tone class — update this guard with it`,
  ).toBeTruthy();
  return new Set([token![1], "text-neutral-500"]);
}

const TYPOGRAPHY = canonicalTypography();
const SIZES = sizeRungs();
const MUTED = mutedSpellings();

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
 * Every string literal that reaches a `className`, via the AST.
 *
 * Both spellings are read — `className="…"` and `className={"…"}` — and so is
 * every string literal nested inside the expression, which is what makes
 * `className={cx("…")}` visible. An earlier version handled only the first, so
 * a formatter, a prettier config or one `cx()` wrapper was enough to walk a
 * duplicate straight past the guard.
 *
 * Each literal is judged INDEPENDENTLY, which is what keeps legitimate
 * composition legal: `cx(CONTROL_MIN_TOUCH, "rounded-md px-3")` contains no
 * literal that is the contract, so it is not a finding. Only a literal that IS
 * the whole primitive is.
 */
function classNameLiterals(source: string, fileName: string): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: string[] = [];

  /** The nearest enclosing scope of a node: a function-like, or the file. */
  const scopeOf = (node: ts.Node): ts.Node => {
    let cur: ts.Node | undefined = node.parent;
    while (cur) {
      // BLOCKS are scopes too. Recognising only functions put two sibling
      // `if`/`else` blocks, each declaring a conventional `const LABEL`, into
      // one map under the enclosing function — so the later declaration
      // answered for usages in the earlier block. That is the same collision as
      // before, one level down.
      if (
        ts.isBlock(cur) ||
        ts.isCaseClause(cur) ||
        ts.isDefaultClause(cur) ||
        ts.isForStatement(cur) ||
        ts.isForOfStatement(cur) ||
        ts.isForInStatement(cur) ||
        ts.isFunctionDeclaration(cur) ||
        ts.isFunctionExpression(cur) ||
        ts.isArrowFunction(cur) ||
        ts.isMethodDeclaration(cur) ||
        ts.isSourceFile(cur)
      ) {
        return cur;
      }
      cur = cur.parent;
    }
    return sf;
  };

  // Constants are keyed BY SCOPE, not by name alone.
  //
  // A single file-wide map keyed only by identifier text was wrong in both
  // directions: two components each declaring a conventional `const LABEL`
  // would collide, so the later declaration silently answered for the earlier
  // one. That loses a real duplicate AND invents one in unrelated code, and a
  // guard that fails innocent code is worse than a guard with a gap.
  const constants = new Map<ts.Node, Map<string, string>>();
  const declare = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isStringLiteral(node.initializer) ||
        ts.isNoSubstitutionTemplateLiteral(node.initializer))
    ) {
      const scope = scopeOf(node);
      if (!constants.has(scope)) constants.set(scope, new Map());
      constants.get(scope)!.set(node.name.text, node.initializer.text);
    }
    ts.forEachChild(node, declare);
  };
  ts.forEachChild(sf, declare);

  /** Resolve an identifier from its OWN scope outward, nearest wins. */
  const resolve = (node: ts.Identifier): string | null => {
    let scope: ts.Node | undefined = scopeOf(node);
    while (scope) {
      const hit = constants.get(scope)?.get(node.text);
      if (hit !== undefined) return hit;
      if (ts.isSourceFile(scope)) break;
      scope = scopeOf(scope);
    }
    return null;
  };

  /** Every statically-known string reachable from a node, in source order. */
  const staticStrings = (node: ts.Node): string[] => {
    const found: string[] = [];
    const visit = (n: ts.Node): void => {
      if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) found.push(n.text);
      else if (ts.isIdentifier(n)) {
        const v = resolve(n);
        if (v !== null) found.push(v);
      }
      ts.forEachChild(n, visit);
    };
    visit(node);
    return found;
  };

  const visit = (node: ts.Node): void => {
    if (
      ts.isJsxAttribute(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "className" &&
      node.initializer
    ) {
      if (ts.isStringLiteral(node.initializer)) {
        out.push(node.initializer.text);
      } else if (ts.isJsxExpression(node.initializer) && node.initializer.expression) {
        const expr = node.initializer.expression;
        // Each statically-known fragment, judged on its own.
        out.push(...staticStrings(expr));
        // AND the combination — but ONLY across arguments that render
        // together, which means the arguments of a single call.
        //
        // The previous version joined every static string it could reach,
        // including BOTH branches of a conditional. `flag ? "a b c" : "d"`
        // renders one branch or the other and never their union, yet the join
        // produced exactly the contract and failed the file. That is a false
        // positive on valid code — worse than the gap it was closing — so the
        // combination is now built only from a call's own arguments, and a
        // conditional argument contributes nothing to it.
        if (ts.isCallExpression(expr)) {
          const parts = expr.arguments
            .map((arg) => {
              if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) return arg.text;
              if (ts.isIdentifier(arg)) return resolve(arg);
              return null; // conditional, logical, spread — may not render
            })
            .filter((v): v is string => v !== null);
          if (parts.length > 1) out.push(parts.join(" "));
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return out;
}

/**
 * The className literals in `file` whose class set IS the primitive.
 *
 * The muted colour matches on EITHER spelling, so a duplicate written with the
 * token is caught as readily as one written raw.
 */
function handRolledSites(file: string): string[] {
  const source = readFileSync(path.join(REPO_ROOT, file), "utf8");
  const hits: string[] = [];
  for (const literal of classNameLiterals(source, file)) {
    const classes = literal.split(/\s+/).filter(Boolean);
    const set = new Set(classes);
    if (![...TYPOGRAPHY].every((c) => set.has(c))) continue;
    const muted = classes.filter((c) => MUTED.has(c));
    if (muted.length !== 1) continue;
    const sizes = classes.filter((c) => SIZES.has(c));
    if (sizes.length !== 1) continue;
    // Anything beyond the contract plus one size makes it a VARIANT — a caution
    // colour, a layout class, a scroll offset — and the primitive does not own
    // those. Only an exact duplicate is a finding.
    if (classes.some((c) => !TYPOGRAPHY.has(c) && c !== muted[0] && c !== sizes[0])) continue;
    hits.push(literal);
  }
  return hits;
}

/**
 * Files that still hand-roll the label, WITH their exact occurrence count.
 *
 * Filenames alone were not a ratchet. A file on the list could gain occurrences
 * and still pass, because the only question asked was "more than zero?" — so
 * the allowlist would have licensed growth in exactly the files furthest from
 * adoption. The count is asserted EXACTLY: any movement, up or down, has to be
 * written down here, which is a visible and reviewable act.
 *
 * `app/(app)/calendar/QuickBookDrawer.tsx` and `app/(app)/records/page.tsx` are
 * additionally owned by an open PR at the time of writing, so they are not this
 * lane's to convert.
 */
const LEGACY_UNADOPTED: ReadonlyArray<readonly [string, number]> = [
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

const LEGACY_BY_FILE = new Map(LEGACY_UNADOPTED.map(([f, n]) => [f, n]));

const FILES = ROOTS.flatMap((root) => walk(path.join(REPO_ROOT, root))).map((f) =>
  path.relative(REPO_ROOT, f),
);

describe("UX-02: the uppercase section label has one owner", () => {
  it("derives its contract from the primitive, both typography and tone", () => {
    for (const c of ["font-medium", "uppercase", "tracking-wider"]) {
      expect(TYPOGRAPHY.has(c), `contract lost ${c}`).toBe(true);
    }
    // The TOKEN spelling must come from the primitive itself, not from this file.
    expect(MUTED.has("text-fg-muted"), "the primitive's muted token went unread").toBe(true);
    expect(MUTED.has("text-neutral-500"), "the raw legacy spelling went unread").toBe(true);
  });

  it("sees a duplicate however it is spelled or wrapped", () => {
    const contract = "text-xs font-medium uppercase tracking-wider";
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["plain attribute", `<span className="${contract} text-neutral-500" />`],
      ["expression container", `<span className={"${contract} text-neutral-500"} />`],
      ["wrapped in cx", `<span className={cx("${contract} text-neutral-500")} />`],
      ["token spelling", `<span className="${contract} text-fg-muted" />`],
      ["reordered", `<span className="uppercase text-neutral-500 tracking-wider text-xs font-medium" />`],
    ];
    // Split across two cx() fragments, which renders as the concatenation.
    const viaFragments = classNameLiterals(
      `export const X = <span className={cx("${contract}", "text-neutral-500")} />;`,
      "fragments.tsx",
    );
    expect(
      viaFragments.some((l) => {
        const set = new Set(l.split(/\s+/).filter(Boolean));
        return [...TYPOGRAPHY].every((c) => set.has(c)) && set.has("text-neutral-500");
      }),
      "a contract split across cx fragments escaped the guard",
    ).toBe(true);

    // Two scopes, same conventional name. The first must resolve to its OWN
    // value: a file-wide map keyed by name alone answered with the second.
    const scoped = classNameLiterals(
      `export function A() { const LABEL = "${contract} text-neutral-500"; return <span className={LABEL} />; }\n` +
        `export function B() { const LABEL = "text-sm text-red-600"; return <span className={LABEL} />; }`,
      "scoped.tsx",
    );
    expect(scoped, "scoped constants did not resolve to their own declarations").toContain(
      `${contract} text-neutral-500`,
    );
    expect(scoped).toContain("text-sm text-red-600");

    // An extracted constant is the same duplicate with a name on it.
    const viaConstant = classNameLiterals(
      `const LABEL = "${contract} text-neutral-500";\nexport const X = <span className={LABEL} />;`,
      "constant.tsx",
    );
    expect(
      viaConstant.some((l) => l.includes("tracking-wider")),
      "a duplicate stored in a constant escaped the guard",
    ).toBe(true);
    for (const [name, src] of cases) {
      const literals = classNameLiterals(`export const X = ${src};`, "case.tsx");
      const matched = literals.some((literal) => {
        const classes = literal.split(/\s+/).filter(Boolean);
        const set = new Set(classes);
        return (
          [...TYPOGRAPHY].every((c) => set.has(c)) &&
          classes.filter((c) => MUTED.has(c)).length === 1 &&
          classes.filter((c) => SIZES.has(c)).length === 1
        );
      });
      expect(matched, `${name} escaped the guard`).toBe(true);
    }
  });

  it("never joins branches that cannot render together", () => {
    // A REGRESSION THIS GUARD CAUSED ONCE. Joining every reachable static
    // string combined both arms of a ternary into the exact contract, so a file
    // rendering one arm or the other was failed for a class list neither arm
    // produces. A guard that fails valid code is worse than one with a gap.
    const contract = "text-xs font-medium uppercase tracking-wider";
    const conditional = classNameLiterals(
      `export const X = <span className={flag ? "${contract}" : "text-neutral-500"} />;`,
      "conditional.tsx",
    );
    for (const literal of conditional) {
      const set = new Set(literal.split(/\s+/).filter(Boolean));
      const isContract =
        [...TYPOGRAPHY].every((c) => set.has(c)) &&
        [...set].some((c) => MUTED.has(c)) &&
        [...set].some((c) => SIZES.has(c));
      expect(isContract, `mutually exclusive branches were joined into "${literal}"`).toBe(false);
    }
  });

  it("resolves constants per BLOCK, not merely per function", () => {
    // Two sibling blocks may each declare a conventional name. Keying only by
    // enclosing function let the later declaration answer for the earlier block.
    const contract = "text-xs font-medium uppercase tracking-wider";
    const blocks = classNameLiterals(
      `export function A(flag: boolean) {\n` +
        `  if (flag) { const LABEL = "${contract} text-neutral-500"; return <span className={LABEL} />; }\n` +
        `  else { const LABEL = "text-sm text-red-600"; return <span className={LABEL} />; }\n` +
        `}`,
      "blocks.tsx",
    );
    expect(blocks, "the first block's constant did not resolve to its own value").toContain(
      `${contract} text-neutral-500`,
    );
    expect(blocks).toContain("text-sm text-red-600");
  });

  it("leaves real composition alone", () => {
    // A variant is not a duplicate. Flagging these would forbid the correct
    // pattern along with the wrong one.
    const legal = [
      `<span className={cx(CONTROL_MIN_TOUCH, "rounded-md px-3")} />`,
      `<span className="text-xs font-medium uppercase tracking-wider text-blue-800" />`,
      `<span className="text-sm font-medium uppercase tracking-wider text-neutral-500" />`,
    ];
    for (const src of legal) {
      const literals = classNameLiterals(`export const X = ${src};`, "legal.tsx");
      for (const literal of literals) {
        const classes = literal.split(/\s+/).filter(Boolean);
        const set = new Set(classes);
        const exact =
          [...TYPOGRAPHY].every((c) => set.has(c)) &&
          classes.filter((c) => MUTED.has(c)).length === 1 &&
          classes.filter((c) => SIZES.has(c)).length === 1 &&
          !classes.some(
            (c) => !TYPOGRAPHY.has(c) && !MUTED.has(c) && !SIZES.has(c),
          );
        expect(exact, `${literal} was wrongly treated as a duplicate`).toBe(false);
      }
    }
  });

  it("finds className literals through the AST, not through comments", () => {
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
      if (LEGACY_BY_FILE.has(file)) continue;
      const hits = handRolledSites(file);
      if (hits.length > 0) offenders.push(`${file}: ${hits.length}x "${hits[0]}"`);
    }
    expect(
      offenders,
      "use <SectionLabel> — this class list is exactly what the primitive renders",
    ).toEqual([]);
  });

  it("every legacy count is exact, so the list can only be changed deliberately", () => {
    const drifted: string[] = [];
    for (const [file, expected] of LEGACY_UNADOPTED) {
      const actual = handRolledSites(file).length;
      if (actual === expected) continue;
      drifted.push(
        actual === 0
          ? `${file}: adopted — delete this entry`
          : `${file}: recorded ${expected}, found ${actual} — update the count`,
      );
    }
    expect(drifted, "the legacy ledger no longer matches the tree").toEqual([]);
  });

  it("the surface this slice adopted is clean and off the list", () => {
    const adopted = FILES.filter((f) => f.startsWith("app/(app)/settings/availability/"));
    expect(adopted.length, "the adopted surface disappeared").toBeGreaterThan(0);
    for (const file of adopted) {
      expect(handRolledSites(file), `${file} still hand-rolls it`).toEqual([]);
      expect(LEGACY_BY_FILE.has(file)).toBe(false);
    }
  });
});
