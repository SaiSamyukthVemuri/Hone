/**
 * The marketing truth boundary, closed by construction.
 *
 * WHY THIS IS NOT A SYNTAX SCANNER
 * --------------------------------
 * Two predecessors tried to answer "what will this React tree render". Both
 * produced a finding every round, and the findings were never repeats — they
 * were different SYNTACTIC ROUTES from text to a screen: nested JSX, then JSX
 * expressions, then arrays of fragments, then imported values, then imported
 * components, then props, then spread props, then metadata helpers, then
 * re-exports, then framework convention files. Enumerating routes cannot
 * terminate, because the route set is the grammar of two languages.
 *
 * So the question is abandoned. Text that reaches a visitor has exactly two
 * origins — a LITERAL in some file, or a VALUE from another file — and this
 * closes both without ever asking what anything renders:
 *
 *   R1 CLOSURE     the transitive first-party import/re-export closure of the
 *                  marketing routes and the framework's convention files. A
 *                  module outside it cannot be reached from a marketing route,
 *                  so it cannot render. 55 modules today.
 *
 *   R2 FRAGMENTS   every literal and JSX text run in that closure, judged
 *                  against the register. No filter of any kind.
 *
 *   R3 ADJACENCY   those fragments joined per file in SOURCE ORDER and judged
 *                  again, which catches a claim assembled from harmless pieces
 *                  without knowing what an element, an array or a spread is.
 *
 *   R4 FREEZE      the prose inventory, shrink-only. An authoring rule, not a
 *                  completeness one.
 *
 *   R5 HOLES       the single remaining shape rule, and the only one: a
 *                  sentence whose middle comes from another file.
 *
 * Every bypass family above collapses into R1 or R3. No rule here names an
 * attribute, an element, a spread, an array method or a prop.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import ts from "typescript";
import {
  REPO_ROOT,
  decodeEntities,
  normalise,
  publicRouteFiles,
} from "./register-provenance";

// ---------------------------------------------------------------------------
// Reading text — the parser as a tokeniser, never as a semantic model
// ---------------------------------------------------------------------------

const parse = (file: string, source?: string): ts.SourceFile =>
  ts.createSourceFile(
    file,
    source ?? readFileSync(join(REPO_ROOT, file), "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );

const lineOf = (sf: ts.SourceFile, n: ts.Node): number =>
  sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

export type CopyViolation = {
  readonly file: string;
  readonly line: number;
  readonly rule: string;
  readonly detail: string;
};

// ---------------------------------------------------------------------------
// R1. CLOSURE
// ---------------------------------------------------------------------------

/**
 * Where marketing copy may be AUTHORED.
 *
 * Judged in full and exempt from the freeze: adding copy here is the law.
 */
export const CANONICAL_COPY_MODULES: readonly string[] = [
  "lib/marketing/content.ts",
  "lib/marketing/resources.ts",
  "lib/marketing/jsonld.ts",
];

/**
 * Legally reviewed policy text, authored in its own routes.
 *
 * Owner ruling: `/privacy` and `/terms` are canonical copy sources in their own
 * right and their text is NOT moved to satisfy this architecture.
 */
export const POLICY_SOURCES: readonly string[] = [
  "app/privacy/page.tsx",
  "app/terms/page.tsx",
];

/**
 * Next's file-convention routes at the app root.
 *
 * Wired by the framework from their FILENAME, so no import names them and no
 * registry lists them — `app/opengraph-image.tsx` renders the card every social
 * preview shows. They are SEEDS, not a special case: once seeded, everything
 * they import follows by closure like any route.
 *
 * Listed rather than globbed so that a new convention file is a decision
 * somebody makes, and non-recursive so the authenticated application under
 * `app/(app)/` stays out.
 */
export const CONVENTION_ROUTES: readonly string[] = [
  "app/layout.tsx",
  "app/opengraph-image.tsx",
  "app/apple-icon.tsx",
  "app/icon.tsx",
  "app/global-error.tsx",
  "app/robots.ts",
  "app/sitemap.ts",
];

/** Marketing route files, from the MARKETING_PAGES registry. */
export function pageCopySources(): string[] {
  return publicRouteFiles().filter((f) => !POLICY_SOURCES.includes(f));
}

/** Everything a visitor can arrive at directly, before closure. */
export function seedFiles(): string[] {
  return [...publicRouteFiles(), ...CONVENTION_ROUTES]
    .filter((f) => existsSync(join(REPO_ROOT, f)))
    .sort();
}

/**
 * A module specifier as a repository path, or null for a package.
 *
 * Reads the string. The file is opened only because it is IN the closure, never
 * to decide whether it belongs there.
 */
export function resolveSpecifier(spec: string, from: string): string | null {
  const rel = spec.startsWith("@/")
    ? spec.slice(2)
    : spec.startsWith(".")
      ? relative(REPO_ROOT, join(REPO_ROOT, dirname(from), spec))
      : null;
  if (rel === null || rel.startsWith("..")) return null;
  return (
    [".ts", ".tsx", "/index.ts", "/index.tsx"]
      .map((ext) => rel + ext)
      .find((candidate) => existsSync(join(REPO_ROOT, candidate))) ?? null
  );
}

/**
 * THE BOUNDARY. Every first-party module a marketing route can reach.
 *
 * Imports AND re-exports, transitively, to a fixed point. This is the step both
 * predecessors refused: they followed imports one level, then two, then argued
 * about `.ts` versus `.tsx`, because every file they admitted had to carry a
 * frozen prose baseline and the noise was unaffordable.
 *
 * It is affordable here because the closure feeds JUDGEMENT, which is a phrase
 * match with no per-file baseline. Measured on the real tree: 55 modules, 2,616
 * fragments, zero forbidden and zero unsanctioned. Following the graph costs
 * nothing and buys the completeness the syntax rules kept failing to reach.
 */
export function marketingClosure(): string[] {
  const seen = new Set<string>();
  const stack = seedFiles();
  while (stack.length) {
    const file = stack.pop();
    if (file === undefined || seen.has(file)) continue;
    seen.add(file);
    const sf = parse(file);
    const visit = (n: ts.Node) => {
      if (
        (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) &&
        n.moduleSpecifier !== undefined &&
        ts.isStringLiteral(n.moduleSpecifier)
      ) {
        const resolved = resolveSpecifier(n.moduleSpecifier.text, file);
        if (resolved !== null && !seen.has(resolved)) stack.push(resolved);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return [...seen].sort();
}

/**
 * Every public route in the application, marketing or not.
 *
 * The closure is only as complete as its SEEDS, and seeds come from a registry
 * a person maintains. So the routes the closure does NOT reach are enumerated
 * and frozen too: a new public page is then either registered as marketing, in
 * which case closure covers it, or it appears here and somebody decides. What
 * cannot happen is a public route quietly belonging to neither.
 *
 * `(app)` is excluded by path: that group is the authenticated application, and
 * the marketing register does not govern it.
 */
export function publicRouteEntryPoints(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    const abs = join(REPO_ROOT, dir);
    if (!existsSync(abs)) return;
    for (const name of readdirSync(abs)) {
      const rel = `${dir}/${name}`;
      if (statSync(join(REPO_ROOT, rel)).isDirectory()) {
        walk(rel);
      } else if (
        /^(page|route|layout|opengraph-image|twitter-image|not-found|error|global-error)\.tsx?$/.test(
          name,
        )
      ) {
        out.push(rel);
      }
    }
  };
  walk("app");
  return out.filter((f) => !f.includes("/(app)/")).sort();
}

/** Public routes the marketing closure does not reach — the declared scope limit. */
export function outsideMarketingScope(): string[] {
  const closure = new Set(marketingClosure());
  return publicRouteEntryPoints().filter((f) => !closure.has(f));
}

/**
 * The closure minus the canonical modules: where prose is FROZEN.
 *
 * Judgement covers the whole closure; the freeze covers only the part where
 * authoring new copy is a breach rather than the law.
 */
export function frozenSurface(): string[] {
  return marketingClosure().filter((f) => !CANONICAL_COPY_MODULES.includes(f));
}

// ---------------------------------------------------------------------------
// R2 / R3. READING
// ---------------------------------------------------------------------------

/**
 * Every text fragment a file contains, IN SOURCE ORDER.
 *
 * JSX text runs, string literals and the literal segments of templates. No
 * element types, no attributes, no arrays, no holes, no approval, no
 * readability — the file is read as a sequence of authored strings and nothing
 * more. Two files with the same text produce the same fragments however their
 * markup is arranged, which is what makes both readings stable.
 */
export function textFragments(file: string, source?: string): string[] {
  const sf = parse(file, source);
  const found: { at: number; text: string }[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isJsxText(n)) {
      const text = normalise(decodeEntities(n.text));
      if (text) found.push({ at: n.getStart(sf), text });
    }
    if (
      ts.isStringLiteral(n) ||
      ts.isNoSubstitutionTemplateLiteral(n) ||
      ts.isTemplateHead(n) ||
      ts.isTemplateMiddle(n) ||
      ts.isTemplateTail(n)
    ) {
      // A module specifier is a path, not copy.
      const isSpecifier =
        n.parent !== undefined &&
        (ts.isImportDeclaration(n.parent) || ts.isExportDeclaration(n.parent));
      if (!isSpecifier) {
        const text = normalise((n as ts.LiteralLikeNode).text);
        if (text) found.push({ at: n.getStart(sf), text });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found.sort((a, b) => a.at - b.at).map((f) => f.text);
}

/**
 * R3. The file's fragments as one string.
 *
 * This is what replaces six separate shape rules. A claim split by markup, an
 * array of fragments React concatenates, a `+`, a `.join()`, an element inside
 * an expression — every one of them is adjacent authored strings in source
 * order, so every one appears here, and none has to be recognised as itself.
 *
 * Over-joining is safe in exactly one direction, and it is the direction that
 * matters: joining text that does not actually render together can ADD a
 * candidate string, never hide one, and an extra candidate fails closed into a
 * build failure a human reads. Measured across the real closure: zero.
 *
 * Used for the FORBIDDEN rules only. Those are phrase patterns, so containment
 * is the question and a longer string can only help. The append-only rules are
 * an exact-match allow-list over a complete authored value — a joined window is
 * not one, and judging it there reported nine sanctioned sentences as
 * unsanctioned purely for having a heading in front of them.
 */
export function adjacentText(file: string, source?: string): string {
  return textFragments(file, source).join(" ");
}

const FUNCTION_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "before", "but", "by", "can",
  "do", "does", "each", "every", "for", "from", "has", "have", "in", "into",
  "is", "it", "its", "no", "not", "of", "on", "or", "own", "so", "that", "the",
  "their", "them", "then", "there", "they", "this", "to", "until", "was",
  "we", "what", "when", "where", "which", "who", "will", "with", "you", "your",
]);

/**
 * Is this text the SORT OF THING a person wrote for a visitor to read?
 *
 * It decides what the INVENTORY holds — an authoring question. It is never used
 * to decide what gets JUDGED: a length gate there hid a four-word forbidden
 * sentence behind its own threshold in the first architecture.
 */
export function isSubstantiveProse(text: string): boolean {
  const value = normalise(decodeEntities(text));
  const tokens = value.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;
  // A PLAIN WORD is letters, with an optional internal hyphen or apostrophe and
  // optional trailing punctuation. `append-only` is a word; `min-h-[44px]` is
  // not — without this a Tailwind class string reads as a nine-word sentence.
  const plain = tokens.filter((t) => /^[A-Za-z][A-Za-z'’-]*[.,;:!?)”"']*$/.test(t));
  if (plain.length < 3) return false;
  if (plain.length / tokens.length < 0.6) return false;
  const endsASentence = /[A-Za-z]{3,}[.!?]("|”|'|’)?(\s|$)/.test(value);
  const hasFunctionWord = plain.some((t) =>
    FUNCTION_WORDS.has(t.replace(/[^A-Za-z'’-]/g, "").toLowerCase()),
  );
  if (!hasFunctionWord && !endsASentence) return false;
  if (plain.length >= 5) return true;
  return endsASentence;
}

/** R4. The prose a file contains, for the frozen inventory. */
export function copyInventory(file: string, source?: string): string[] {
  return textFragments(file, source).filter(isSubstantiveProse).sort();
}

// ---------------------------------------------------------------------------
// R5. The one shape rule that survives
// ---------------------------------------------------------------------------

/**
 * A sentence whose middle comes from ANOTHER FILE.
 *
 * Why this one and not the others: R3 joins fragments within a file, so
 * `<p>Every <strong>change</strong> is tracked</p>` is caught as adjacent text
 * with no rule about elements at all. But `<p>Every {NOUN} is tracked</p>`, with
 * `NOUN` exported from a copy module, has only "Every" and "is tracked" in this
 * file — the missing word is somewhere else, and joining cannot reach across a
 * module boundary without following values, which is the dataflow this
 * architecture exists without.
 *
 * So it is REFUSED rather than read: a sentence with a gap is not a complete
 * copy value. That is the authoring law stated exactly, and it is the last place
 * this code looks at JSX shape.
 *
 * HOLES from any depth, WORDS only from the element itself. The asymmetry
 * separates a sentence from a layout container without naming a tag:
 *
 *   <p>Every <strong>{NOUN}</strong> is tracked</p>   refused
 *   <div><h2>Pricing</h2>{PLANS.map(…)}</div>         allowed
 */
export function incompleteClaimViolations(file: string, source?: string): CopyViolation[] {
  const sf = parse(file, source);
  const out: CopyViolation[] = [];
  // One report per hole: the rule fires at every level whose own words enclose
  // it, so a nested case was otherwise counted twice.
  const reported = new Set<number>();
  const isHole = (c: ts.Node): c is ts.JsxExpression =>
    ts.isJsxExpression(c) && c.expression !== undefined && !spelledOutHere(c.expression);
  const directWords = (el: ts.JsxElement | ts.JsxFragment): number =>
    el.children
      .filter(ts.isJsxText)
      .reduce(
        (sum, t) => sum + t.text.trim().split(/\s+/).filter((w) => /[A-Za-z]/.test(w)).length,
        0,
      );
  const visit = (n: ts.Node) => {
    if (ts.isJsxElement(n) || ts.isJsxFragment(n)) {
      const holes: ts.JsxExpression[] = [];
      const gatherHoles = (el: ts.JsxElement | ts.JsxFragment) => {
        for (const child of el.children) {
          if (isHole(child)) holes.push(child);
          if (ts.isJsxElement(child) || ts.isJsxFragment(child)) gatherHoles(child);
        }
      };
      gatherHoles(n);
      if (directWords(n) > 0 && holes.length > 0) {
        for (const hole of holes) {
          if (reported.has(hole.getStart(sf))) continue;
          reported.add(hole.getStart(sf));
          out.push({
            file,
            line: lineOf(sf, hole),
            rule: "copy/incomplete-claim",
            detail: hole.getText().replace(/\s+/g, " "),
          });
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** Is every string this expression can produce written in this file? */
function spelledOutHere(node: ts.Node): boolean {
  const e = ts.isParenthesizedExpression(node) ? node.expression : node;
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return true;
  if (ts.isJsxElement(e) || ts.isJsxFragment(e) || ts.isJsxSelfClosingElement(e)) {
    let spelled = true;
    const check = (x: ts.Node) => {
      if (ts.isJsxExpression(x) && x.expression && !spelledOutHere(x.expression)) spelled = false;
      ts.forEachChild(x, check);
    };
    ts.forEachChild(e, check);
    return spelled;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Judging a canonical module by value as well as by source
// ---------------------------------------------------------------------------

/** Every string reachable in a runtime value, so a data module is judged twice. */
export function walkStrings(value: unknown, seen = new Set<unknown>()): string[] {
  if (typeof value === "string") return [value];
  if (value === null || typeof value !== "object") return [];
  if (seen.has(value)) return [];
  seen.add(value);
  return Object.values(value as Record<string, unknown>).flatMap((v) => walkStrings(v, seen));
}

/**
 * A declaration that names a file which is gone is a BROKEN declaration.
 *
 * Exported so it can be driven with a path that really is missing; left inline
 * it could only be proven by deleting a real source file.
 */
export function assertDeclaredExist(files: readonly string[]): void {
  const missing = files.filter((f) => !existsSync(join(REPO_ROOT, f)));
  if (missing.length) {
    throw new Error(
      `declared copy source(s) no longer exist: ${missing.join(", ")} — ` +
        "update the declaration in the same change that moves the file",
    );
  }
}
