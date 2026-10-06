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
  // AS WRITTEN FIRST. `import copy from "./copy.json"` carries its extension,
  // which is the documented form — appending to it produced `copy.json.ts`,
  // `copy.json.tsx` and `copy.json.json`, none of which exist, so the import
  // read as a package and the file fell out of the boundary. The previous
  // control tested an extensionless specifier and masked exactly this.
  if (existsSync(join(REPO_ROOT, rel)) && /\.[a-z]+$/.test(rel)) return rel;
  // `.json` alongside TypeScript, because `resolveJsonModule` is enabled here
  // and the extension list IS the boundary's edge: anything the compiler can
  // resolve locally belongs in it.
  return (
    [".ts", ".tsx", ".json", "/index.ts", "/index.tsx"]
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
    // A JSON module imports nothing, so it is a leaf of the closure.
    if (file.endsWith(".json")) continue;
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
/**
 * Filenames Next renders without anything importing them.
 *
 * `loading`, `template` and `default` were missing: Next shows
 * `app/pricing/loading.tsx` during navigation, so it is visitor-facing, and it
 * was neither a closure seed nor part of the route scan — which meant even the
 * outside-scope list did not move when one appeared.
 */
const CONVENTION_FILENAME =
  /^(page|route|layout|template|default|loading|not-found|error|global-error|forbidden|unauthorized|opengraph-image|twitter-image|apple-icon|icon|manifest|sitemap|robots)\.tsx?$/;

/**
 * Does Next render this filename without anything importing it?
 *
 * Exported so it can be driven with names that do not exist in the tree yet.
 * Left private it could only be proven by creating a real `loading.tsx`, so it
 * would have shipped unpinned — and a guard that cannot be shown red is not yet
 * a guard.
 */
export const isConventionFilename = (name: string): boolean => CONVENTION_FILENAME.test(name);

export function publicRouteEntryPoints(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    const abs = join(REPO_ROOT, dir);
    if (!existsSync(abs)) return;
    for (const name of readdirSync(abs)) {
      const rel = `${dir}/${name}`;
      if (statSync(join(REPO_ROOT, rel)).isDirectory()) {
        walk(rel);
      } else if (CONVENTION_FILENAME.test(name)) {
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
  // A JSON module has no syntax to walk — it is a value. Parsing it as TSX
  // yields nothing, which would have made a `.json` copy file invisible even
  // once the resolver admitted it.
  if (file.endsWith(".json")) {
    const raw = source ?? readFileSync(join(REPO_ROOT, file), "utf8");
    try {
      return walkStrings(JSON.parse(raw) as unknown).map(normalise).filter(Boolean);
    } catch {
      return [];
    }
  }
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
export function adjacentText(file: string, source?: string): string[] {
  return [
    // RENDERED adjacency: JSX text and child-position literals only. An
    // attribute literal sits between two text runs in source order, so joining
    // everything turned `<p>Every change <strong className="font-bold">is
    // tracked</strong></p>` into "Every change font-bold is tracked" and pushed
    // the sentence apart with a class name.
    renderedFragments(file, source).join(" "),
    // AND every fragment, which is what catches assembly with no JSX in it at
    // all — `"Every change" + " is tracked"`, a template, `.join()`, `.concat()`.
    // Two joins rather than one because they fail in opposite directions:
    // interleaving can BREAK a rendered match, and restricting to rendered text
    // loses the non-JSX cases. Their union is strictly more coverage than
    // either, and both are measured clean across the closure.
    textFragments(file, source).join(" "),
    // AND WITH NOTHING BETWEEN THEM. React puts no separator between children,
    // so `<p><span>synthetic</span>-<span>twin</span></p>` renders
    // `synthetic-twin` while a space-joined reading says `synthetic - twin` and
    // matches no pattern. Which separator is right depends on the markup, so
    // both are read rather than guessed at — a third candidate can only add, and
    // it is measured clean like the other two.
    renderedFragments(file, source).join(""),
  ];
}

/**
 * The fragments that render as BODY TEXT, in source order.
 *
 * R2 judges every fragment a file holds, including attribute values. R3 must
 * not: an attribute literal sits between two text runs in source order, so
 * `<p>Every change <strong className="font-bold">is tracked</strong></p>` joined
 * as "Every change font-bold is tracked" and the sentence a visitor reads was
 * pushed apart by a class name.
 *
 * This REMOVES text from the join rather than adding a case to it. Over-joining
 * is safe because it can only add a candidate; interleaving is not, because it
 * can break one — so the join takes JSX text and literals in child position, and
 * nothing else.
 */
export function renderedFragments(file: string, source?: string): string[] {
  if (file.endsWith(".json")) return textFragments(file, source);
  const sf = parse(file, source);
  const found: { at: number; text: string }[] = [];
  const inChildPosition = (node: ts.Node): boolean => {
    for (let cur: ts.Node | undefined = node.parent; cur; cur = cur.parent) {
      if (ts.isJsxAttribute(cur)) return false;
      if (
        ts.isJsxExpression(cur) &&
        cur.parent &&
        (ts.isJsxElement(cur.parent) || ts.isJsxFragment(cur.parent))
      ) {
        return true;
      }
    }
    return false;
  };
  const visit = (n: ts.Node) => {
    if (ts.isJsxText(n)) {
      const text = normalise(decodeEntities(n.text));
      if (text) found.push({ at: n.getStart(sf), text });
    }
    if (
      (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) &&
      inChildPosition(n)
    ) {
      const text = normalise(n.text);
      if (text) found.push({ at: n.getStart(sf), text });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found.sort((a, b) => a.at - b.at).map((f) => f.text);
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
  const assembled = assembledBindings(sf);
  const namesAnAssembly = (hole: ts.JsxExpression): boolean => {
    const e = hole.expression;
    if (e === undefined) return false;
    const root = ts.isIdentifier(e) ? e.text : null;
    return root !== null && assembled.has(root);
  };
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
      // WORDS AND A HOLE, **OR TWO VALUES RUNNING TOGETHER**. Source order is
      // not render order once literals are bound to names: declaring `tail`
      // before `head` and rendering `<p>{head} {tail}</p>` produces the
      // forbidden sentence while R3 joins the file as "is tracked Every change".
      // Closing that by ordering fragments by their JSX REFERENCE would be
      // same-file name resolution, and the round after it would be about object
      // properties.
      //
      // So it is refused on shape: a sentence made of two values is no more a
      // complete copy value than one made of a value and half a sentence.
      //
      // "RUNNING TOGETHER" is JSX's own whitespace rule, not a guess about
      // layout. A whitespace run containing a NEWLINE is dropped by JSX, so
      // formatted children are separate lines of a page; a plain space is
      // rendered, so `{head} {tail}` is one line of text. Measured: the blunt
      // reading — any two holes — flagged 118 places, nearly all of them a
      // container holding a header and a list. This one flags ONE.
      const together = runsTogether(n);
      // A hole naming a locally assembled value is a claim built from parts even
      // when it stands alone, so it is refused without needing a neighbour.
      const computed = holes.filter(namesAnAssembly);
      if ((directWords(n) > 0 && holes.length > 0) || together || computed.length > 0) {
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
        // A COMPONENT is not an expression, so a sentence assembled from two of
        // them — `<p><Head /><Tail /></p>` — has nothing in `holes` to attribute
        // the refusal to. The element itself is the claim in that case.
        if (together && holes.length === 0 && !reported.has(n.getStart(sf))) {
          reported.add(n.getStart(sf));
          const opening = ts.isJsxElement(n) ? n.openingElement.getText() : "<>";
          out.push({
            file,
            line: lineOf(sf, n),
            rule: "copy/incomplete-claim",
            detail: `${opening.replace(/\s+/g, " ")} assembled from adjacent parts`,
          });
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/**
 * Do two values render as one run of text inside this element?
 *
 * Adjacent, or separated only by a space JSX keeps. A whitespace run containing
 * a newline is dropped by JSX, which is what makes formatted children separate
 * lines rather than one sentence.
 */
function runsTogether(el: ts.JsxElement | ts.JsxFragment): boolean {
  const kids = el.children;
  // OPAQUE: text this file does not spell out. A non-literal expression, or a
  // COMPONENT — `<p><Head /><Tail /></p>` renders the sentence those two return
  // while each module holds a harmless fragment and the closure judges them
  // separately. A component is recognised by its capital initial, which is
  // JSX's own rule for the distinction, not a guess about what it does.
  const opaque = (c: ts.Node | undefined): boolean => {
    if (c === undefined) return false;
    if (ts.isJsxExpression(c)) {
      return c.expression !== undefined && !spelledOutHere(c.expression);
    }
    const tag = ts.isJsxSelfClosingElement(c)
      ? c.tagName.getText()
      : ts.isJsxElement(c)
        ? c.openingElement.tagName.getText()
        : null;
    if (tag === null) return false;
    // A COMPONENT, by its capital initial — JSX's own rule.
    if (/^[A-Z]/.test(tag)) return true;
    // Or an ORDINARY WRAPPER carrying a value:
    // `<p><span>{head}</span><span>{tail}</span></p>` renders the sentence those
    // two hold, and a span is not a component. Opacity propagates through it, so
    // the value inside is what runs together with the neighbour.
    //
    // An earlier draft also required the wrapper to have no authored words of
    // its own, described as leaving a sentence-bearing wrapper alone. Measured:
    // it made no difference to the real surface and REDUCED reporting — for
    // `<p><span>Every {a}</span><span>{b}</span></p>` it named only `{a}`, when
    // both values sit in the sentence a visitor reads. It was reducing coverage,
    // not over-refusal, so it is gone.
    if (!ts.isJsxElement(c)) return false;
    return c.children.some((x) => opaque(x));
  };
  // A PRAGMATIC CUT, and NOT what JSX actually does — stated plainly because an
  // earlier comment here claimed the opposite and was wrong.
  //
  // JSX REMOVES a whitespace-only run containing a newline; it does not render a
  // break. So `<p>\n  <Head />\n  <Tail />\n</p>` really does render both
  // results adjacently, and a rule faithful to that would refuse it.
  //
  // Measured what faithful costs: 144 refusals across 28 files — `<Container>`,
  // `<Reveal>`, a fragment with two children. That is a census of ordinary React
  // composition, not a list of suspicious claims, and freezing it would refuse
  // any second child added anywhere in the marketing tree.
  //
  // Separating a sentence from a layout container needs block-versus-inline tag
  // semantics, which is the interpreter this architecture exists without. So the
  // line cut is kept as a deliberate under-refusal, and the residual is recorded
  // rather than hidden: two opaque children on SEPARATE SOURCE LINES can compose
  // a claim across modules and this rule will not see it.
  const keptText = (c: ts.Node | undefined): boolean =>
    c !== undefined && ts.isJsxText(c) && !c.text.includes("\n");
  const keptSpace = (c: ts.Node | undefined): boolean =>
    c !== undefined && keptText(c) && (c as ts.JsxText).text.trim() === "" && (c as ts.JsxText).text.length > 0;
  const keptWords = (c: ts.Node | undefined): boolean =>
    c !== undefined &&
    keptText(c) &&
    (c as ts.JsxText).text.trim().split(/\s+/).filter((w) => /[A-Za-z]/.test(w)).length > 0;
  for (let i = 0; i < kids.length; i += 1) {
    if (!opaque(kids[i])) continue;
    // Two values with nothing, or only a kept space, between them.
    if (opaque(kids[i + 1])) return true;
    if (keptSpace(kids[i + 1]) && opaque(kids[i + 2])) return true;
    // Or authored words on the same line as one: `<p>Every <Head /> tracked</p>`
    // completes a sentence out of this file and another.
    if (keptWords(kids[i - 1]) || keptWords(kids[i + 1])) return true;
  }
  return false;
}

/**
 * Names this file binds to an ASSEMBLY of other values.
 *
 * `const claim = head + tail` is not a complete copy value, and rendering it as
 * `<p>{claim}</p>` presents one hole with no authored words beside it — which R5
 * reads as consumption, and R3 cannot join because the literals sit behind
 * `head` and `tail` in whatever order they were declared.
 *
 * ONE LOOKUP, same file, by name. Not dataflow: nothing is evaluated and nothing
 * is followed across a module. The question is only whether the thing this hole
 * names was written as a single value or built from parts.
 */
function assembledBindings(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const visit = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      const e = n.initializer;
      const assembles =
        (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) ||
        ts.isTemplateExpression(e) ||
        (ts.isCallExpression(e) &&
          ts.isPropertyAccessExpression(e.expression) &&
          ["join", "concat"].includes(e.expression.name.text));
      if (assembles) names.add(n.name.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return names;
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
