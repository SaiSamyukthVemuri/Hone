/**
 * Canonical marketing copy: DECLARED, REFUSED when it is not static, and judged
 * as complete values.
 *
 * WHAT REPLACED WHAT
 * ------------------
 * Its predecessor walked the transitive import graph from every public route and
 * treated each string literal as a candidate claim. Measured at `e86949e5`: 48
 * files, 1,691 candidates, of which 146 (8.6%) came from the canonical copy
 * module and the rest from font `unicode-range` tables, rate-limit
 * configuration, delivery policy and structured-data keys. Roughly nine tenths
 * of the input was not copy, and a growing TS/JSX interpreter existed to tell
 * the tenth from the rest. Nine review rounds showed that has no natural edge.
 *
 * The owner ruling inverts it. Copy is DECLARED, not discovered, and the
 * authoring law requires it to be complete and static — so the AST's job here is
 * REFUSAL, never interpretation:
 *
 *   - it never asks what a program renders;
 *   - it asks whether a string was allowed to be written where it was;
 *   - anything it cannot prove is complete static text is a FAILURE, not an
 *     inference.
 *
 * That is why this cannot grow the way the interpreter grew. An unhandled
 * construct is a red build naming a file and a line, which a person fixes by
 * authoring the copy properly — it is never a silent pass, and never a new case
 * for this module to learn.
 */
import ts from "typescript";
import {
  REPO_ROOT,
  readSource,
  publicRouteFiles,
  normalise,
  decodeEntities,
} from "./register-provenance";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";

// ---------------------------------------------------------------------------
// 1. The declarations. This list IS the scan's universe.
// ---------------------------------------------------------------------------

/**
 * Plain data modules whose exported values are marketing copy.
 *
 * These are held to the strictest rule: every string they produce must be a
 * complete literal. They are where new product-marketing copy belongs.
 */
export const CANONICAL_COPY_MODULES: readonly string[] = [
  "lib/marketing/content.ts",
  "lib/marketing/resources.ts",
  // Authors the SoftwareApplication description and other structured-data prose
  // that `app/page.tsx` renders through `softwareApplicationLd()`. The route
  // holds only a call expression, so nothing in the page reaches these strings:
  // a declared universe is exactly as complete as its declaration, and this one
  // was short by a module.
  "lib/marketing/jsonld.ts",
];

/**
 * Legally reviewed policy text, authored in its own routes.
 *
 * Owner ruling, 2026-09-20: `/privacy` and `/terms` are canonical copy sources
 * in their own right and their text is NOT moved merely to satisfy this
 * architecture. They are scanned as policy sources. Their existence does not
 * authorise arbitrary inline marketing prose elsewhere, which is why they are
 * named here one by one rather than matched by a pattern.
 */
export const POLICY_SOURCES: readonly string[] = [
  "app/privacy/page.tsx",
  "app/terms/page.tsx",
];

/**
 * Every module a file REFERENCES: imported or re-exported.
 *
 * Extracted so the re-export half is provable. `export { Hero } from "./Hero"`
 * pulls a component into the render tree without importing it, so a barrel
 * index added the barrel and stopped there, and a colocated `Hero.tsx` outside
 * the pre-scanned directories reached no guard.
 */
export function moduleSpecifiersOf(file: string, source?: string): string[] {
  const sf = parse(file, source);
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (
      (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) &&
      n.moduleSpecifier !== undefined &&
      ts.isStringLiteral(n.moduleSpecifier)
    ) {
      out.push(n.moduleSpecifier.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/**
 * Where a plain `.ts` module may still author rendered marketing copy.
 *
 * The walk follows `.tsx` anywhere first-party, because a component renders.
 * A `.ts` module is followed only here: these are the two places copy is
 * authored, and everything outside them is infrastructure.
 */
const COPY_MODULE_DIRS = ["app/_components/", "lib/marketing/"];

/** Marketing route files, from the MARKETING_PAGES registry. */
export function pageCopySources(): string[] {
  return publicRouteFiles().filter((f) => !POLICY_SOURCES.includes(f));
}

/**
 * Rendering code. It composes layout and consumes approved copy values; it does
 * not author substantive prose of its own.
 */
export function marketingComponentFiles(): string[] {
  const out = new Set<string>();
  for (const dir of ["app/_components/marketing", "app/_components/marketing/visuals"]) {
    const abs = join(REPO_ROOT, dir);
    if (!existsSync(abs)) continue;
    for (const name of readdirSync(abs)) {
      if (/\.tsx$/.test(name)) out.add(`${dir}/${name}`);
    }
  }
  // DERIVED, not only listed. A hand-kept directory list missed
  // `app/_components/DemoForm.tsx`, which `app/demo/page.tsx` renders and which
  // authors visitor-facing prose: `pageClaims` cannot see through `<DemoForm />`
  // and the prose guard never ran on it, so a claim added there shipped green.
  //
  // TRANSITIVE, with a visited set. One level was the line because "going
  // transitive" was what made the PREVIOUS architecture unbounded — but that was
  // unbounded INTERPRETATION of rendered text, not import following. Walking a
  // first-party import graph is a finite traversal over files on disk: it
  // terminates, it reads no semantics, and it needs no dataflow.
  //
  // One level leaked. Both policy pages import `PolicyLayout.tsx`, which renders
  // `MarketingFooter` and `MarketingHeader`; those author visitor-facing prose,
  // sit outside the two blessed directories, and are imported by no page
  // directly. Forbidden copy added there reached neither the prose guard nor the
  // judged corpus. A wrapper is not a boundary — what it renders is on the page.
  const seen = new Set<string>();
  const walkImports = (from: string) => {
    if (seen.has(from)) return;
    seen.add(from);
    const sf = parse(from);
    const visit = (n: ts.Node) => {
      // Import OR re-export — see `moduleSpecifiersOf`, which is the same rule
      // in a form a test can drive.
      const isModuleRef =
        (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) &&
        n.moduleSpecifier !== undefined &&
        ts.isStringLiteral(n.moduleSpecifier);
      if (isModuleRef && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
        const spec = n.moduleSpecifier.text;
        // `@/app/_components/...` and `../_components/...` are the same file.
        // The hand-kept list missed `DemoForm` because `app/demo/page.tsx`
        // imports it relatively, which is the ordinary way to import a sibling.
        const rel = spec.startsWith("@/")
          ? spec.slice(2)
          : spec.startsWith(".")
            ? relative(REPO_ROOT, join(REPO_ROOT, dirname(from), spec))
            : null;
        // ANY directly imported first-party component, not just two blessed
        // directories. A page can colocate one — `app/pricing/Hero.tsx` via
        // `./Hero` — and a directory allow-list silently omits it, which is the
        // same rot as the hand-kept list it already replaced. A page importing a
        // `.tsx` is importing a component; that is the whole test.
        // `.ts` AS WELL AS `.tsx`, but only where copy lives. Components render
        // values from plain modules — `app/_components/marketingNav.ts` holds
        // `MARKETING_CTA.label` and `MARKETING_NAV`, rendered by the header and
        // the mobile nav on every policy page — and a `.tsx`-only walk never saw
        // them, so a forbidden label there changed nothing any guard reads.
        //
        // BOUNDED deliberately. Following every first-party `.ts` transitively
        // reaches `lib/supabase/server.ts`, `lib/rate-limit/**`,
        // `lib/waitlist/**` and `app/actions/**` — 13 files of server
        // infrastructure that author no copy. That is the unbounded expansion
        // this architecture exists to avoid, so `.ts` is followed only where
        // marketing copy is authored.
        const inCopyModuleDir =
          rel !== null && COPY_MODULE_DIRS.some((dir) => rel.startsWith(dir));
        const extensions = inCopyModuleDir
          ? [".tsx", "/index.tsx", ".ts", "/index.ts"]
          : [".tsx", "/index.tsx"];
        if (rel && !rel.startsWith("..")) {
          for (const ext of extensions) {
            if (existsSync(join(REPO_ROOT, rel + ext))) {
              out.add(rel + ext);
              walkImports(rel + ext);
            }
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  };
  // Next.js applies a layout WITHOUT the route importing it, so an
  // import-following walk starting at pages alone never reaches one. Every
  // marketing route is wrapped by `app/layout.tsx`, which authors public
  // metadata — keywords, descriptions — that would be emitted on every page
  // while reaching no guard and no rule. Seed them, then walk from there.
  const declared = [...pageCopySources(), ...POLICY_SOURCES];
  const layouts = new Set<string>();
  for (const page of declared) {
    // Every ancestor segment up to `app/`, because nested and route-group
    // layouts apply the same way the root one does.
    for (let dir = dirname(page); dir === "app" || dir.startsWith("app/"); dir = dirname(dir)) {
      const layout = `${dir}/layout.tsx`;
      if (existsSync(join(REPO_ROOT, layout))) layouts.add(layout);
      if (dir === "app") break;
    }
  }
  for (const layout of layouts) out.add(layout);
  for (const page of [...declared, ...layouts]) walkImports(page);
  // A canonical copy module is not a component. Following `.ts` reaches them,
  // and counting their prose as a component-prose VIOLATION is a category
  // error — authoring copy there is the law, not a breach of it. They are
  // declared, read and judged as modules in their own right.
  for (const module of CANONICAL_COPY_MODULES) out.delete(module);
  return [...out].sort();
}

/**
 * A complete claim that is SPELLED as an assembly of complete parts.
 *
 * `copyModuleViolations` refuses assembly inside a canonical copy module, so
 * this cannot arise there. Components are rendering code, where `+` is ordinary
 * and allowed — and that is the hole: `const state = "Every change" + " is
 * tracked"` behind a baselined `{state}` leaves the identity, the count and the
 * file set untouched, while judgement sees only the two harmless halves.
 *
 * Folding is NOT the interpreter coming back. It reads one expression node whose
 * every leaf is already a complete literal and returns the string that node
 * denotes. There is no dataflow, no branch selection and no rendering model; an
 * operand that is not a literal makes the whole fold undefined, so it fails
 * closed into "not a complete value" rather than guessing.
 */
/** Inline elements whose text is a separate call to action, not this sentence. */
const LINK_TAGS = ["a", "Link"];

/**
 * Self-closing inline elements that SEPARATE rendered characters.
 *
 * `<br />` ends a line, so the words either side are distinct. `<wbr />` marks a
 * permitted break point and renders nothing, so the characters either side are
 * one word. Treating them alike split `track<wbr />ed` into "track ed".
 */
const BOUNDARY_TAGS = ["br"];

function foldStatic(node: ts.Expression): string | undefined {
  const e = unwrap(node) as ts.Expression;
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
  // A template whose every substitution is itself static is just a spelling of
  // the same concatenation: `Every ${"change is tracked"}`.
  if (ts.isTemplateExpression(e)) {
    let out = e.head.text;
    for (const span of e.templateSpans) {
      const value = foldStatic(span.expression);
      if (value === undefined) return undefined;
      out += value + span.literal.text;
    }
    return out;
  }
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = foldStatic(e.left);
    const right = foldStatic(e.right);
    return left !== undefined && right !== undefined ? left + right : undefined;
  }
  // `.join()` and `.concat()` as well as `+`. Naming spellings one at a time is
  // what kept this class of defect alive a round at a time, so the unfoldable
  // remainder is refused in `staticConcatClaims` instead of being enumerated.
  if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression)) {
    const method = e.expression.name.text;
    const receiver = unwrap(e.expression.expression);
    const args = e.arguments.map((a) => foldStatic(a as ts.Expression));
    if (args.some((a) => a === undefined)) return undefined;
    if (method === "join") {
      if (!ts.isArrayLiteralExpression(receiver)) return undefined;
      const separator = e.arguments.length === 0 ? "," : (args[0] as string);
      const parts = receiver.elements.map((el) => foldStatic(el as ts.Expression));
      return parts.every((part) => part !== undefined)
        ? (parts as string[]).join(separator)
        : undefined;
    }
    if (method === "concat") {
      // String receiver only. `["a"].concat("b")` yields an ARRAY, and folding
      // it to a string would be inventing a render.
      const base = foldStatic(receiver as ts.Expression);
      return base === undefined ? undefined : base + (args as string[]).join("");
    }
    return undefined;
  }
  return undefined;
}

/**
 * A static string put through an operation this fold does not understand.
 *
 * REFUSAL, not interpretation, and the reason there is no third spelling to
 * chase: `+`, `.join()` and `.concat()` are folded, and every OTHER method on a
 * string-literal receiver is reported instead of being read. Adding a fold later
 * shrinks this set; adding none still leaves the claim visible.
 *
 * Array receivers are left alone deliberately — `.map()` on a list of literals
 * yields a list, not a sentence, and it is the one such call on the declared
 * surface.
 */
function unreadableStaticStringCalls(sf: ts.SourceFile, file: string): CopyViolation[] {
  const out: CopyViolation[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      // RESOLVABLE, not merely literal. An unsupported operation chained after a
      // supported one — `"Every_change".concat("_is_tracked").replaceAll("_", " ")`
      // — has a CallExpression receiver, so an immediate-literal check saw
      // nothing and the underscored fragments passed as harmless.
      // EXEMPT BY FOLD, never by name. Exempting every call named `concat` let
      // `"Every change".concat(...[" is tracked"])` through: the spread makes
      // the fold fail, so nothing judged the whole, and the method name still
      // bought the exemption. The question is only ever "can this be read", and
      // `foldStatic` is what answers it.
      //
      // Array receivers stay out: `["a","b"].map(...)` yields a list, not a
      // sentence, its elements are judged individually, and it is the one such
      // call on the declared surface.
      const receiver = unwrap(n.expression.expression) as ts.Expression;
      const isStaticString = foldStatic(receiver) !== undefined;
      if (isStaticString && foldStatic(n as ts.Expression) === undefined) {
        out.push({
          file,
          line: lineOf(sf, n),
          rule: "claim/unreadable-static-string-call",
          detail: n.getText().replace(/\s+/g, " ").slice(0, 70),
        });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/**
 * A string BINDING built from authored words and something dynamic.
 *
 * `const state = "Every change is " + status` rendered through `<p>{state}</p>`
 * is reachable by no other guard: the placeholder is not substantive prose, the
 * concatenation cannot be folded because `status` is dynamic, and judgement sees
 * only the harmless fragments. `copyModuleViolations` refuses this inside a
 * canonical module; a component is where it was still allowed.
 *
 * TWO PLAIN WORDS, measured. The only mixed binding on the declared surface is a
 * Tailwind class string, whose tokens carry hyphens, colons and brackets; a
 * sentence fragment does not. Requiring two bare alphabetic words separates them
 * without a prose-length gate, which is what let the four-word N1 wording
 * through everywhere else.
 */
export function mixedAssemblyViolations(file: string, source?: string): CopyViolation[] {
  const sf = parse(file, source);
  const out: CopyViolation[] = [];
  const visit = (n: ts.Node) => {
    const initializer = ts.isVariableDeclaration(n)
      ? n.initializer
      : ts.isPropertyAssignment(n)
        ? n.initializer
        : undefined;
    if (initializer) {
      const e = unwrap(initializer) as ts.Expression;
      const assembles =
        ts.isTemplateExpression(e) ||
        (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken);
      if (assembles && foldStatic(e) === undefined) {
        const words: string[] = [];
        const collect = (x: ts.Node) => {
          if (
            ts.isStringLiteral(x) ||
            ts.isNoSubstitutionTemplateLiteral(x) ||
            ts.isTemplateHead(x) ||
            ts.isTemplateMiddle(x) ||
            ts.isTemplateTail(x)
          ) {
            for (const w of (x as ts.LiteralLikeNode).text.split(/\s+/)) {
              if (/^[A-Za-z]+$/.test(w)) words.push(w);
            }
          }
          ts.forEachChild(x, collect);
        };
        collect(e);
        if (words.length >= 2) {
          out.push({
            file,
            line: lineOf(sf, n),
            rule: "claim/assembled-binding",
            detail: e.getText().replace(/\s+/g, " ").slice(0, 70),
          });
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** Static string assemblies this fold cannot read, for the file's own guard. */
export function unreadableAssemblies(file: string, source?: string): CopyViolation[] {
  return unreadableStaticStringCalls(parse(file, source), file);
}

/** Every complete value a file spells as an assembly, judged as the whole it renders. */
export function staticConcatClaims(file: string, source?: string): string[] {
  const sf = parse(file, source);
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isBinaryExpression(n) || ts.isCallExpression(n) || ts.isTemplateExpression(n)) {
      // Only at the TOP of an assembly: a nested `+` inside a larger one folds
      // to a prefix of its parent, which is noise, not evidence.
      const parent = parentPastWrappers(n);
      const nestedInConcat =
        parent !== undefined &&
        ts.isBinaryExpression(parent) &&
        parent.operatorToken.kind === ts.SyntaxKind.PlusToken;
      if (!nestedInConcat) {
        const folded = foldStatic(n as ts.Expression);
        if (folded !== undefined) {
          const value = normalise(folded);
          if (value) out.push(value);
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/**
 * Elements that may appear INSIDE a claim without breaking it into fragments.
 *
 * Closed and measured, not guessed: across the whole marketing surface the only
 * tags appearing inside substantive text are `strong` (63), `a` (8), `Link` (6),
 * `code` (2), `span` (1) and `FormattedDateTime` (1). The rest of the list is
 * the standard inline set, included so ordinary authoring does not trip a guard
 * over a tag nobody happened to use yet.
 *
 * A component is inline only by DECLARATION. `Link` and `FormattedDateTime` are
 * named here because a person decided they render inline — the scan does not
 * infer it, which is the "custom-component semantic guessing" the ruling removes.
 * Anything else inside substantive text is refused, and the fix is to author the
 * sentence as one value.
 */
export const INLINE_IN_CLAIM: readonly string[] = [
  "a", "abbr", "b", "br", "code", "em", "i", "span", "strong", "sub", "sup",
  "time", "wbr",
  "Link", "FormattedDateTime",
];

/**
 * Attribute names that never carry a claim.
 *
 * Ten entries, from the ruling's own list — class names, hrefs, ids, resource
 * paths, keys, metadata identifiers — plus `data-*` by prefix. It replaces a
 * 101-entry HTML/SVG vocabulary and a 22-entry second one, and it stays this
 * size because the substantive-prose test does the rest of the work: a class
 * name is a token soup, not a sentence, and only `className` needs naming
 * because a long one has enough space-separated tokens to look like words.
 */
const PLUMBING_ATTRIBUTES = new Set([
  "classname", "class", "style", "id", "key", "href", "src", "d", "viewbox",
  "srcset",
]);

const isPlumbingAttribute = (name: string): boolean =>
  name.toLowerCase().startsWith("data-") ||
  PLUMBING_ATTRIBUTES.has(name.toLowerCase());

// ---------------------------------------------------------------------------
// 2. "Substantive prose", defined from measurement
// ---------------------------------------------------------------------------

/**
 * Is this text a claim a visitor reads, rather than a label or a token?
 *
 * Derived from the marketing surface as it stands, not from taste. The word
 * distribution across 1,983 text nodes is heavily bimodal — 860 single words,
 * 162 of two, then a long tail — and the boundary that separates labels
 * ("Pricing", "Request a walkthrough") from claims sits between four and five
 * words, with terminal punctuation pulling shorter sentences in.
 *
 * Deliberately crude. It does not need to know what the text MEANS; the register
 * decides that. It only needs to know whether the text is the sort of thing the
 * register governs.
 */
export function isSubstantiveProse(text: string): boolean {
  const value = normalise(decodeEntities(text));
  const tokens = value.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;

  // A PLAIN WORD is letters, with an optional internal hyphen or apostrophe and
  // optional trailing punctuation. `append-only` is a word; `min-h-[44px]`,
  // `text-[color:var(--x)]` and `·` are not. Without this a long Tailwind class
  // string reads as a nine-word sentence, which is how five class constants
  // landed in the first run of this guard.
  const plain = tokens.filter((t) => /^[A-Za-z][A-Za-z'’-]*[.,;:!?)”"']*$/.test(t));
  if (plain.length < 3) return false;
  if (plain.length / tokens.length < 0.6) return false;

  const endsASentence = /[A-Za-z]{3,}[.!?]("|”|'|’)?(\s|$)/.test(value);

  // ENGLISH, NOT TOKENS. `inline-flex items-center justify-center rounded-md
  // border` is five hyphenated "words" by any shape test, and read as a
  // five-word sentence in the first run of this guard. Prose has function words;
  // a class list, an SVG path and a probe-lot label do not. Either a function
  // word or a real sentence ending is required, and both are cheap to check.
  const hasFunctionWord = plain.some((t) =>
    FUNCTION_WORDS.has(t.replace(/[^A-Za-z'’-]/g, "").toLowerCase()),
  );
  if (!hasFunctionWord && !endsASentence) return false;

  if (plain.length >= 5) return true;

  // Terminal punctuation pulls a short sentence in, but only after a real word.
  // "Maya R. · 30 min" is sample data in a preview, not a claim, and the full
  // stop after an initial must not promote it.
  return endsASentence;
}

/**
 * The closed function-word list that separates English from token soup.
 *
 * Deliberately tiny and deliberately boring. It is not a language model; it is
 * the observation that a marketing claim contains at least one of these and a
 * Tailwind class string contains none of them.
 */
const FUNCTION_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "before", "but", "by", "can",
  "do", "does", "each", "every", "for", "from", "has", "have", "in", "into",
  "is", "it", "its", "no", "not", "of", "on", "or", "own", "so", "that", "the",
  "their", "them", "then", "they", "this", "to", "up", "was", "we", "were",
  "what", "when", "where", "which", "who", "why", "will", "with", "you", "your",
]);

export type CopyViolation = {
  readonly file: string;
  readonly line: number;
  readonly rule: string;
  readonly detail: string;
};

const parse = (file: string, source?: string): ts.SourceFile =>
  ts.createSourceFile(
    file,
    source ?? readSource(file),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );

const lineOf = (sf: ts.SourceFile, node: ts.Node): number =>
  sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

const tagNameOf = (node: ts.JsxElement | ts.JsxSelfClosingElement): string =>
  (ts.isJsxElement(node) ? node.openingElement : node).tagName.getText();

/** The attribute this node sits in, however deeply nested, or null. */
function enclosingAttributeName(node: ts.Node): string | null {
  let cur: ts.Node | undefined = parentPastWrappers(node);
  while (cur) {
    if (ts.isJsxAttribute(cur)) {
      return ts.isIdentifier(cur.name) ? cur.name.text : cur.name.getText();
    }
    if (
      ts.isJsxElement(cur) ||
      ts.isJsxSelfClosingElement(cur) ||
      ts.isJsxFragment(cur) ||
      ts.isSourceFile(cur)
    ) {
      return null;
    }
    cur = parentPastWrappers(cur);
  }
  return null;
}

// ---------------------------------------------------------------------------
// 3. The shape guard — three refusals
// ---------------------------------------------------------------------------

/**
 * A canonical copy module produces complete literals and nothing else.
 *
 * Fail closed, by the ruling: an interpolation, a concatenation or a conditional
 * inside a copy module is refused WITHOUT any attempt to understand it. There is
 * nothing to understand — copy that is assembled at runtime cannot be reviewed
 * before it ships, which is the whole reason the register classifies sentences.
 */
export function copyModuleViolations(file: string, source?: string): CopyViolation[] {
  const sf = parse(file, source);
  const out: CopyViolation[] = [];
  const visit = (n: ts.Node) => {
    const flag = (rule: string, detail: string) =>
      out.push({ file, line: lineOf(sf, n), rule, detail });
    if (ts.isTemplateExpression(n) && assemblesText(n)) {
      flag("copy-module/no-interpolation", n.getText().slice(0, 70));
    } else if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.PlusToken &&
      assemblesText(n)
    ) {
      flag("copy-module/no-concatenation", n.getText().slice(0, 70));
    } else if (
      ts.isCallExpression(n) &&
      joinsTextArray(n)
    ) {
      // NOT a three-construct denylist. `["Every change is", "tracked"].join(" ")`
      // produced a forbidden sentence through none of template/`+`/conditional,
      // so the guard that called itself fail-closed was a list of three shapes.
      //
      // The test is the FRAGMENTS, not the callee: a call whose string literals
      // amount to prose is prose being assembled, whatever the method is named.
      // Structural calls stay clean because their literals are not prose —
      // measured across the declared modules, `abs("/pricing")`, the `"@type"`
      // maps and `label.replace(/[^0-9.]/g, "")` all pass.
      flag("copy-module/no-assembled-copy", n.getText().replace(/\s+/g, " ").slice(0, 70));
    } else if (ts.isConditionalExpression(n)) {
      // A conditional is allowed when EACH branch is already a complete value —
      // that is the law's own wording, and `PUBLISHED ? "CAD $99" : null` is a
      // value shown or withheld, not a claim built from halves. It is refused
      // only when a branch is itself assembled.
      for (const branch of [n.whenTrue, n.whenFalse]) {
        if (!isCompleteValue(branch) && assemblesText(branch)) {
          flag("copy-module/no-conditional-copy", branch.getText().slice(0, 70));
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}


/** Every static string fragment an expression contributes, in source order. */
function staticFragments(node: ts.Node): string[] {
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) out.push(n.text);
    else if (ts.isTemplateExpression(n)) {
      out.push(n.head.text, ...n.templateSpans.map((sp) => sp.literal.text));
      for (const sp of n.templateSpans) visit(sp.expression);
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return out;
}

/**
 * Is text being ASSEMBLED here, at any length?
 *
 * Length-independent, deliberately and by repeated correction. Two earlier
 * versions gated this on `isSubstantiveProse`, and each time a short assembly
 * walked through: `["Every change is", "tracked"].join(" ")`, then
 * `["Every change", suffix].join(" ")`, then `['Every change', 'is tracked']
 * .join(' ')` — all rendering the exact N1 sentence out of fragments that are
 * individually harmless.
 *
 * A length heuristic answers "may a person write this here", which is an
 * AUTHORING question. Whether text is being assembled is a structural one, and
 * structure is what this guard refuses on.
 */
/**
 * Strip the wrappers that do not change what an expression IS.
 *
 * Parentheses, `as`, `satisfies` and `!` are noise to every classification in
 * this file, and matching on syntax shapes without normalising them first meant
 * `("Every change").concat(" is tracked")` and its `as string` sibling walked
 * past a check that `"Every change".concat(…)` had just been taught to refuse.
 *
 * One `unwrap`, applied wherever an expression is classified, ends that family:
 * a wrapper cannot hide an assembly if nothing ever sees the wrapper.
 */
/**
 * The first ancestor that is not a wrapper.
 *
 * `unwrap` normalises DOWNWARD; ancestor walks needed the mirror and did not
 * have it, so `{("Every change is tracked")}` failed the "already counted as
 * part of a claim" test and was emitted twice, and an attribute lookup could not
 * see past a parenthesis either.
 */
function parentPastWrappers(node: ts.Node): ts.Node | undefined {
  let p = node.parent;
  while (
    p &&
    (ts.isParenthesizedExpression(p) ||
      ts.isAsExpression(p) ||
      ts.isSatisfiesExpression(p) ||
      ts.isNonNullExpression(p) ||
      ts.isTypeAssertionExpression(p))
  ) {
    p = p.parent;
  }
  return p;
}

function unwrap(node: ts.Node): ts.Node {
  let n = node;
  while (
    ts.isParenthesizedExpression(n) ||
    ts.isAsExpression(n) ||
    ts.isSatisfiesExpression(n) ||
    ts.isNonNullExpression(n) ||
    ts.isTypeAssertionExpression(n)
  ) {
    n = n.expression;
  }
  return n;
}

const bearsWord = (text: string): boolean => /[A-Za-z]{2,}/.test(text);

/**
 * A resource path, which the ruling lists as plumbing rather than a claim.
 *
 * `mailto:${CONTACT_EMAIL}` and `${CANONICAL_HOST}/icon` are templates whose
 * static parts carry words — "mailto", "icon" — so a purely length-independent
 * word test flagged them the moment the length gate came off. They are URLs. No
 * visitor reads them as a sentence and no rule could match one.
 *
 * Shape, not an allow-list: a scheme, a leading slash, an authority separator,
 * or an unspaced token carrying path punctuation.
 */
function looksLikeResourcePath(text: string): boolean {
  const value = text.trim();
  if (!value) return false;
  if (/^[a-z][a-z+.-]*:/i.test(value)) return true;
  if (value.startsWith("/") || value.startsWith("#")) return true;
  if (value.includes("://")) return true;
  return !/\s/.test(value) && /[/:#?=]/.test(value);
}

const wordBearingLiterals = (nodes: readonly ts.Node[]): ts.Node[] =>
  nodes.filter(
    (e) =>
      (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) &&
      bearsWord((e as ts.StringLiteral).text),
  );

function assemblesText(node: ts.Node): boolean {
  if (ts.isTemplateExpression(node)) {
    const fragments = [node.head.text, ...node.templateSpans.map((sp) => sp.literal.text)];
    if (looksLikeResourcePath(fragments.join(""))) return false;
    return node.templateSpans.length > 0 && fragments.some(bearsWord);
  }
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const fragments = staticFragments(node);
    if (looksLikeResourcePath(fragments.join(""))) return false;
    return fragments.some(bearsWord);
  }
  return false;
}

/**
 * An ARRAY being combined into one string — `[…].join(" ")` and friends.
 *
 * Scoped to a call's receiver or arguments rather than to arrays generally,
 * because an array of complete copy lines is a LIST, not an assembly, and
 * `lib/marketing/content.ts` is full of them. `["a", "b"]` is data;
 * `["a", "b"].join(" ")` is a sentence being built.
 */
function joinsTextArray(call: ts.CallExpression): boolean {
  const isTextLiteral = (raw: ts.Node): boolean => {
    const e = unwrap(raw);
    return (
      (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) &&
      bearsWord((e as ts.StringLiteral).text) &&
      !looksLikeResourcePath((e as ts.StringLiteral).text)
    );
  };

  // An array being combined — `[…].join(" ")`.
  const callee = unwrap(call.expression);
  const arrays: ts.Node[] = [...call.arguments];
  if (ts.isPropertyAccessExpression(callee)) {
    arrays.push(callee.expression);
  }
  for (const raw of arrays) {
    const c = unwrap(raw);
    if (!ts.isArrayLiteralExpression(c)) continue;
    const literals = c.elements.filter(isTextLiteral);
    const values = c.elements.filter((raw) => {
      const e = unwrap(raw);
      return !ts.isStringLiteral(e) && !ts.isNoSubstitutionTemplateLiteral(e);
    });
    if (literals.length >= 2 || (literals.length >= 1 && values.length >= 1)) return true;
  }

  // A STRING being combined — `"Every change".concat(" is tracked")`. Scoping
  // this to arrays let the same assembly through under a different method name,
  // which is the third spelling of one escape.
  //
  // The receiver counts only when it is itself a text literal or array. An
  // identifier receiver must not count, or `t("a complete authored sentence")`
  // — passing a whole value to a function — reads as assembly, which it is not.
  const parts: ts.Node[] = [...call.arguments];
  if (
    ts.isPropertyAccessExpression(callee) &&
    (isTextLiteral(callee.expression) ||
      ts.isArrayLiteralExpression(unwrap(callee.expression)))
  ) {
    parts.push(callee.expression);
  }
  const literals = parts.filter(isTextLiteral);
  const values = parts.filter((raw) => {
    const e = unwrap(raw);
    return (
      !ts.isStringLiteral(e) &&
      !ts.isNoSubstitutionTemplateLiteral(e) &&
      !ts.isArrowFunction(e) &&
      !ts.isFunctionExpression(e)
    );
  });
  return literals.length >= 2 || (literals.length >= 1 && values.length >= 1);
}

/** A complete value needs no assembly: a literal, or an absence. */
function isCompleteValue(raw: ts.Node): boolean {
  const node = unwrap(raw);
  return (
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    node.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(node) && node.text === "undefined")
  );
}

/** Does this expression have a string literal anywhere in it? */
function producesText(node: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

/**
 * A marketing component composes layout. It does not author substantive prose.
 *
 * Measured before the rule was written: 19 substantive items across every
 * marketing component, against 223 on the route pages and 300 in the two policy
 * routes. The rule is affordable because the codebase already almost obeys it.
 */
export function componentProseViolations(file: string, source?: string): CopyViolation[] {
  const sf = parse(file, source);
  const approved = approvedCopyNames(sf);
  const out: CopyViolation[] = [];
  const visit = (n: ts.Node) => {
    // Build the sentence first, exactly as `pageClaims` does. Classifying each
    // JsxText node on its own let `<p>Every <strong>change is tracked</strong>.
    // </p>` pass as three harmless fragments.
    if (isClaimContainer(n) && !foldedIntoClaimParent(n)) {
      const parts = claimParts(n, approved);
      if (isSubstantiveProse(parts.textWithHoles)) {
        out.push({
          file,
          line: lineOf(sf, n),
          rule: "component/no-authored-prose",
          // NOT truncated. The identity baseline compares these strings, and two
          // different sentences sharing a 70-character prefix compared equal —
          // so one declared exception could be swapped for another that differs
          // only after the cut. Callers truncate for display; the value carries
          // the whole sentence.
          // The IDENTITY, holes included as their source, so a swapped value
          // changes the recorded sentence.
          detail: normalise(parts.identityText || parts.textWithHoles),
        });
      }
    }
    if (
      (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) &&
      isSubstantiveProse(n.text)
    ) {
      const attr = enclosingAttributeName(n);
      const jsxParent = parentPastWrappers(n);
      const insideJsxText =
        jsxParent !== undefined &&
        ts.isJsxExpression(jsxParent) &&
        jsxParent.parent !== undefined &&
        isClaimContainer(jsxParent.parent);
      if ((!attr || !isPlumbingAttribute(attr)) && !insideJsxText) {
        out.push({
          file,
          line: lineOf(sf, n),
          rule: "component/no-authored-prose",
          detail: normalise(n.text),
        });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/**
 * A claim in a page or policy source is complete static text.
 *
 * The authoring law, enforced structurally: a substantive claim may not be
 * assembled from fragments, and may not be split across an element this scan has
 * not been told renders inline. Both are refusals — nothing is reconstructed,
 * and an unknown element is reported rather than guessed at.
 */
export function assembledClaimViolations(file: string, source?: string): CopyViolation[] {
  const sf = parse(file, source);
  const approved = approvedCopyNames(sf);
  const out: CopyViolation[] = [];
  const visit = (n: ts.Node) => {
    if (isClaimContainer(n) && !foldedIntoClaimParent(n)) {
      const parts = claimParts(n, approved);
      // CONSUMPTION vs COMPLETION, and the test is position rather than
      // presence. An approved value is exempt unless authored words sit on BOTH
      // sides of it — which is what "completing a claim across the boundary"
      // physically is:
      //
      //   <p>{corePromise} <Link>See the full picture</Link></p>   consumption
      //   <p>Operational guides from {AUTHOR}, the people …</p>    completion
      //
      // Measured before the rule was chosen: 71 standalone consumptions on the
      // declared pages and exactly ONE completion. A cruder "any authored words"
      // test flagged the first line too, which would have forbidden a trailing
      // call to action for no reason.
      const countedHoles = [
        ...parts.holes,
        ...parts.approvedHoles.filter((h) => parts.completing.includes(h)),
      ];
      // A STANDALONE UNAPPROVED HOLE IS REFUSED ON ITS OWN.
      // `<p>{getMarketingClaim()}</p>` has `textWithHoles` of just "something",
      // so the substantive-prose gate below never opened, `pageClaims` dropped
      // the container for having a hole, and the identity baseline recorded
      // nothing — the whole sentence was whatever that call returned, judged by
      // nobody. The prose threshold is an authoring heuristic and has no
      // business deciding whether an unreadable claim is reported.
      //
      // NARROW, and measured: refusing EVERY standalone hole flagged 23 real
      // ones — `{PRICING_PLANS.map(...)}`, which produces elements rather than
      // text, and loop variables over arrays the page itself declares, whose
      // copy is already frozen in the page-prose baseline. Neither is a claim
      // produced by code. What is, is a CALL: `{getMarketingClaim()}` puts the
      // whole sentence behind a function, which is precisely what the authoring
      // law forbids a page to do. An iteration method is excluded because its
      // result is a list of elements, not a sentence.
      const authoredWords = parts.sequence.some((x) => "words" in x && x.words > 0);
      // OPAQUE BY DEFAULT, exempting only what can positively be read.
      // Naming the unreadable shapes one at a time — first calls, then bare
      // identifiers — left `<p>{claim.text}</p>` passing on the next head. The
      // polarity was wrong: a standalone hole IS the whole sentence, so the
      // burden belongs on showing it can be read, not on enumerating ways it
      // cannot.
      const readable = (expr: ts.Expression): boolean => {
        const e = unwrap(expr) as ts.Expression;
        if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return true;
        // A default or a branch is readable when every alternative is:
        // `{plan.priceLabel ?? "Talk to us"}` is consumption on both sides.
        if (
          ts.isBinaryExpression(e) &&
          (e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
            e.operatorToken.kind === ts.SyntaxKind.BarBarToken)
        ) {
          return readable(e.left) && readable(e.right);
        }
        if (ts.isConditionalExpression(e)) {
          return readable(e.whenTrue) && readable(e.whenFalse);
        }
        // An iteration yields elements, not a sentence — but only when its
        // RECEIVER can be seen. `getItems().map(...)` hides the claim one level
        // further out.
        if (
          ts.isCallExpression(e) &&
          ts.isPropertyAccessExpression(e.expression) &&
          ITERATION_METHODS.has(e.expression.name.text) &&
          !ts.isCallExpression(unwrap(e.expression.expression))
        ) {
          return true;
        }
        // And anything rooted in an approved copy value, which includes a loop
        // variable over one.
        const root = rootIdentifier(e);
        return root !== null && approved.has(root);
      };
      const isOpaque = (node: ts.Node): boolean => {
        const expression = (node as ts.JsxExpression).expression;
        return expression !== undefined && !readable(expression);
      };
      if (
        !authoredWords &&
        parts.holes.length === 1 &&
        parts.undeclared.length === 0 &&
        isOpaque(parts.holes[0])
      ) {
        out.push({
          file,
          line: lineOf(sf, parts.holes[0]),
          rule: "claim/standalone-opaque-hole",
          detail: parts.holes[0].getText().replace(/\s+/g, " ").slice(0, 70),
        });
      }
      // The gate reads the sentence WITH its holes counted as words, because a
      // hole renders as something and a claim missing one word is still a claim.
      if (isSubstantiveProse(parts.textWithHoles)) {
        for (const hole of countedHoles) {
          out.push({
            file,
            line: lineOf(sf, hole),
            rule: "claim/assembled-from-fragments",
            detail: hole.getText().slice(0, 70),
          });
        }
        for (const el of parts.undeclared) {
          const tag = tagNameOf(el as ts.JsxElement | ts.JsxSelfClosingElement);
          out.push({
            file,
            line: lineOf(sf, el),
            rule: "claim/unknown-element-inside-claim",
            detail: `<${tag}> inside substantive text; declare it inline or author the sentence as one value`,
          });
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

// ---------------------------------------------------------------------------
// 4. Extraction — complete values, because the guards guarantee completeness
// ---------------------------------------------------------------------------

/**
 * Every complete string in an imported copy module's exported values.
 *
 * This is the whole of part C for a copy module: no AST, no reassembly, no
 * sentence model. The value IS the sentence, because `copyModuleViolations`
 * refuses anything that is not.
 */
export function walkStrings(value: unknown, seen = new Set<unknown>()): string[] {
  if (typeof value === "string") return [value];
  if (value === null || typeof value !== "object") return [];
  if (seen.has(value)) return [];
  seen.add(value);
  return Object.values(value as Record<string, unknown>).flatMap((v) =>
    walkStrings(v, seen),
  );
}


/**
 * The sentence an element renders, folding DECLARED inline descendants in.
 *
 * Built BEFORE the substantive test, not after. Gating on an element's direct
 * text first meant `<p>Every <strong>change is tracked</strong>.</p>` produced
 * nothing at all: "Every ." is not substantive and "change is tracked" is below
 * the threshold on its own, while the rendered sentence matches N1 exactly.
 *
 * A non-inline child contributes NOTHING here — it emits its own claim, which is
 * what keeps `<div>Intro<p>…</p></div>` from fusing — and an expression that is
 * not a complete literal contributes nothing either, because the shape guard has
 * already refused it. Neither case is inferred; both are already settled.
 */
type ClaimParts = {
  /** The sentence as authored, holes contributing nothing. */
  readonly text: string;
  /**
   * The same sentence with each hole standing in as one ordinary word.
   *
   * A hole RENDERS as something, so for the purpose of deciding "is this a
   * claim?" it has to count as a word. Without this,
   * `<p>Every <strong>change is {state}</strong>.</p>` reduced to "Every change
   * is ." — not substantive — so the hole was never refused, and with
   * `state === "tracked"` the page rendered the N1 sentence with every guard
   * green.
   */
  readonly textWithHoles: string;
  /**
   * The sentence with each hole shown as its SOURCE.
   *
   * `textWithHoles` renders every hole as the same placeholder word, which is
   * right for deciding "is this a claim" and wrong for an identity: two
   * different hole-bearing sentences compared equal, so one declared exception
   * could be swapped for another that differs only in the value it interpolates.
   */
  readonly identityText: string;
  /** Expressions inside the claim that are not complete literals. */
  readonly holes: ts.Node[];
  /**
   * Holes that resolve to a declared copy module.
   *
   * Kept apart from `holes` rather than dropped, because whether consuming an
   * approved value is legitimate depends on WHERE it sits: alone in its element
   * it is consumption, and among authored words it is a claim being assembled
   * across the boundary. `FRAGMENT = "change is"` plus `<p>Every {FRAGMENT}
   * tracked.</p>` renders the N1 sentence out of two halves neither of which
   * trips anything on its own.
   */
  readonly approvedHoles: ts.Node[];
  /** Holes with authored words on BOTH sides, within this sentence. */
  readonly completing: ts.Node[];
  /** Internal: the flat run this was built from, so nesting can compose. */
  readonly sequence: Array<{ words: number; direct: boolean } | { hole: ts.Node }>;
  /** Element children inside the claim that nothing declared inline. */
  readonly undeclared: ts.JsxElement[] | ts.Node[];
};

/**
 * The sentence an element renders, folding DECLARED inline descendants in.
 *
 * One traversal, shared by all three guards and by extraction — because the
 * previous head applied build-text-first to `pageClaims` and left the component
 * guard classifying each `JsxText` node on its own, so the identical sentence in
 * a component produced only the fragments "Every", "change is tracked" and "."
 * and no violation at all.
 */
/**
 * Names a file imports from a DECLARED canonical copy module.
 *
 * `{POSITIONING.corePromise}` is not a claim being assembled — it is a complete
 * approved value being consumed, which is exactly what the authoring law asks
 * rendering code to do. Refusing it would forbid the very pattern the law
 * prescribes, and the first run of the hole check did precisely that.
 *
 * One level of import resolution, by name. Nothing is evaluated and nothing is
 * followed further: the value's CONTENT is judged where it is authored, in the
 * copy module, by `moduleClaims`.
 */
function approvedCopyNames(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const visit = (n: ts.Node) => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
      const spec = n.moduleSpecifier.text.replace(/^@\//, "");
      if (CANONICAL_COPY_MODULES.some((m) => m === `${spec}.ts` || m === spec)) {
        const clause = n.importClause?.namedBindings;
        if (clause && ts.isNamedImports(clause)) {
          for (const el of clause.elements) names.add(el.name.text);
        }
        if (n.importClause?.name) names.add(n.importClause.name.text);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);

  // A NAME BOUND LOCALLY IS NOT THE IMPORTED ONE.
  // Approval is a set of identifier TEXT, so a prop or local named `POSITIONING`
  // in a nested component was treated as the canonical import and its runtime
  // text was neither refused nor judged. Without a type checker the binding
  // cannot be resolved exactly, so the safe reading is that a name declared
  // anywhere in the file is no longer reliably the import. Zero occurrences on
  // the real surface today; this keeps it that way.
  const locallyBound = new Set<string>();
  const findLocals = (n: ts.Node) => {
    if (
      (ts.isParameter(n) || ts.isVariableDeclaration(n) || ts.isBindingElement(n)) &&
      ts.isIdentifier(n.name)
    ) {
      locallyBound.add(n.name.text);
    }
    ts.forEachChild(n, findLocals);
  };
  findLocals(sf);
  for (const name of locallyBound) names.delete(name);

  // A LOOP VARIABLE IS CONSUMPTION, NOT AN OPAQUE CLAIM.
  // This was written one head earlier, measured to change nothing, and removed
  // as a loosening path the fix did not need. Extending the standalone rule to
  // bare identifiers needs it: the five such holes on the real pages —
  // `{line}`, `{a}`, `{item}`, `{it}`, `{p}` — are every one a callback
  // parameter, and without this they would all be refused.
  //
  // ANY receiver, not only an approved import, because the arrays behind those
  // five are declared in the page itself or written inline, and their copy is
  // already frozen in the page-prose baseline. Repeated to a fixpoint so a
  // nested iteration is covered too.
  // Termination is STRUCTURAL: the loop repeats only while the set actually
  // grew, and the set is bounded by the identifiers in one file. A `changed`
  // flag set by the body reads the same but is not the same — proving this
  // guard, I removed the `add` and left the flag, and the suite hung instead of
  // failing. A mutation test should go red, never spin.
  for (let size = -1; size !== names.size; ) {
    size = names.size;
    const collect = (n: ts.Node) => {
      if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        ITERATION_METHODS.has(n.expression.name.text)
      ) {
        const callback = n.arguments[0];
        if (
          callback &&
          (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) &&
          callback.parameters[0] &&
          ts.isIdentifier(callback.parameters[0].name)
        ) {
          names.add(callback.parameters[0].name.text);
        }
      }
      ts.forEachChild(n, collect);
    };
    collect(sf);
  }
  return names;
}

/** Iteration methods whose callback parameter carries the receiver's elements. */
const ITERATION_METHODS = new Set(["map", "flatMap", "filter", "forEach", "find"]);

/** The leftmost identifier of `A.b.c`, or null. */
function rootIdentifier(e: ts.Expression): string | null {
  let cur = unwrap(e) as ts.Expression;
  while (ts.isPropertyAccessExpression(cur)) cur = unwrap(cur.expression) as ts.Expression;
  return ts.isIdentifier(cur) ? cur.text : null;
}

/**
 * A container that can hold a sentence.
 *
 * A fragment is one. `export default () => <>Every change is tracked</>` authored
 * the exact N1 wording, and every check here asked `ts.isJsxElement` — so the
 * text reached neither the shape guard nor the corpus. There is no reason a
 * fragment should behave differently from a `<div>`; it was simply not in the
 * predicate.
 */
type ClaimContainer = ts.JsxElement | ts.JsxFragment;

const isClaimContainer = (n: ts.Node): n is ClaimContainer =>
  ts.isJsxElement(n) || ts.isJsxFragment(n);

/**
 * Has an enclosing claim ALREADY folded this container into itself?
 *
 * `claimParts` folds a fragment or an inline element that is a direct child, so
 * the traversal then met the same text twice: once inside the assembled parent
 * sentence and once as a container of its own. Wrapping part of the sanctioned
 * A1 sentence in `<strong>` therefore emitted "with an append-only edit
 * history." as an independent claim and judged it UNSANCTIONED — rejecting a
 * markup-only change to copy that visitors still read exactly as sanctioned.
 *
 * DIRECT parent only, mirroring the fold: `claimParts` walks `node.children`, so
 * an inline element behind a `{cond ? <em/> : null}` is NOT folded and must
 * still be seen on its own.
 */
const foldedIntoClaimParent = (n: ClaimContainer): boolean => {
  const foldable = ts.isJsxFragment(n) || INLINE_IN_CLAIM.includes(tagNameOf(n));
  if (!foldable) return false;
  const parent = parentPastWrappers(n);
  return parent !== undefined && isClaimContainer(parent);
};

function claimParts(node: ClaimContainer, approved: Set<string> = new Set()): ClaimParts {
  let text = "";
  let textWithHoles = "";
  let identityText = "";
  const holes: ts.Node[] = [];
  const approvedHoles: ts.Node[] = [];
  const undeclared: ts.Node[] = [];
  // A flat run of what this sentence is made of, in source order, so "is there
  // authored text on both sides of this hole" is a lookup rather than a guess.
  // `direct` marks words authored in THIS sentence's own text run, as opposed
  // to words that live inside a trailing link. That is the whole difference
  // between a value being consumed and a value being completed from the right.
  const sequence: Array<{ words: number; direct: boolean } | { hole: ts.Node }> = [];
  for (const child of node.children) {
    if (ts.isJsxText(child)) {
      const t = decodeEntities(child.text);
      text += t;
      textWithHoles += t;
      identityText += t;
      sequence.push({
        words: t.trim().split(/\s+/).filter((w) => /[A-Za-z]/.test(w)).length,
        direct: true,
      });
    } else if (ts.isJsxExpression(child) && child.expression) {
      const e = unwrap(child.expression) as ts.Expression;
      if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) {
        text += e.text;
        textWithHoles += e.text;
        identityText += e.text;
        sequence.push({
          words: e.text.trim().split(/\s+/).filter((w) => /[A-Za-z]/.test(w)).length,
          direct: true,
        });
      } else {
        const root = rootIdentifier(e);
        // A placeholder WORD, with no padding of its own: the authored text
        // around it already carries the spacing, and adding any detached the
        // full stop from the last word so the sentence stopped reading as one.
        textWithHoles += "something";
        identityText += `{${child.expression.getText().replace(/\s+/g, " ")}}`;
        sequence.push({ hole: child });
        if (root && approved.has(root)) approvedHoles.push(child);
        else holes.push(child);
      }
    } else if (ts.isJsxFragment(child)) {
      // A nested fragment is not a boundary. `<p>Every <>change is tracked</></p>`
      // is one sentence to a visitor, and treating the fragment as a separate
      // container split it into "Every" and "change is tracked" — neither of
      // which matches anything. A fragment renders nothing of its own.
      const inner = claimParts(child, approved);
      text += inner.text;
      textWithHoles += inner.textWithHoles;
      identityText += inner.identityText;
      sequence.push(...inner.sequence);
      holes.push(...inner.holes);
      approvedHoles.push(...inner.approvedHoles);
      undeclared.push(...inner.undeclared);
    } else if (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child)) {
      if (ts.isJsxSelfClosingElement(child) && INLINE_IN_CLAIM.includes(tagNameOf(child))) {
        // `<p>Every<br />change is tracked</p>` is four words to a visitor. A
        // self-closing inline element has nothing to recurse into, so it was
        // contributing nothing at all and the text closed up to
        // "Everychange is tracked" — which no rule matches.
        //
        // But `<wbr />` is the opposite: it offers a line-break OPPORTUNITY and
        // separates no rendered characters, so `track<wbr />ed` reads "tracked".
        // Inserting a space there broke a word apart and N1 stopped matching —
        // the same miss as before, in the other direction.
        const separator = BOUNDARY_TAGS.includes(tagNameOf(child)) ? " " : "";
        text += separator;
        textWithHoles += separator;
        identityText += separator;
        sequence.push({ words: 0, direct: true });
      } else if (ts.isJsxElement(child) && INLINE_IN_CLAIM.includes(tagNameOf(child))) {
        const inner = claimParts(child, approved);
        text += inner.text;
        textWithHoles += inner.textWithHoles;
        identityText += inner.identityText;
        // A trailing LINK is a separate call to action, which the owner ruling
        // keeps sayable after a consumed value. Any other inline element —
        // `<strong>`, `<em>` — is the same sentence continuing, so its words
        // complete a claim exactly as bare text does.
        const inLink = LINK_TAGS.includes(tagNameOf(child));
        sequence.push(
          ...inner.sequence.map((item) =>
            "words" in item && inLink ? { ...item, direct: false } : item,
          ),
        );
        holes.push(...inner.holes);
        approvedHoles.push(...inner.approvedHoles);
        undeclared.push(...inner.undeclared);
      } else if (!INLINE_IN_CLAIM.includes(tagNameOf(child))) {
        undeclared.push(child);
      }
    }
  }
  const completing = sequence.flatMap((item, i) => {
    if (!("hole" in item)) return [];
    // Authored words BEFORE the hole. `<p>Every change is {TRACKED}.</p>` is a
    // sentence the value completes, and requiring words on both sides missed it
    // because "." contributes none. Words only AFTER the hole are a different
    // shape — `{corePromise} <Link>See the full picture</Link>` leads with a
    // complete value and follows it with a separate call to action, which is
    // consumption and must stay sayable.
    const before = sequence.slice(0, i).some((x) => "words" in x && x.words > 0);
    // AND from the right. Position alone was the rule, and it left
    // `<p>{FRAGMENT} is tracked.</p>` exempt: the approved hole stayed
    // consumption, `pageClaims` judged only "is tracked." and `moduleClaims`
    // only "Every change", while the rendered sentence is N1. What actually
    // distinguishes the sanctioned shape is not that the words come after, but
    // that they live in a trailing LINK rather than in this sentence's own run.
    const after = sequence
      .slice(i + 1)
      .some((x) => "words" in x && x.words > 0 && x.direct);
    return before || after ? [item.hole] : [];
  });
  return { text, textWithHoles, identityText, holes, approvedHoles, undeclared, completing, sequence };
}

const claimText = (node: ClaimContainer, approved?: Set<string>): string =>
  claimParts(node, approved).text;

/**
 * Substantive strings a declared copy module authors, read statically.
 *
 * Complements the value walk rather than replacing it, and closes two gaps the
 * value walk cannot:
 *
 *   - a module whose copy is returned by a FUNCTION (`softwareApplicationLd()`)
 *     exports no value to walk;
 *   - `FLAG ? "banned" : "safe"` evaluates to ONE branch, so the other ships
 *     unjudged. Both branches are literals in the source, so both are judged.
 *
 * Static reading is sound here precisely because `copyModuleViolations` has
 * already refused anything that is not a complete literal.
 */
export function moduleClaims(file: string, source?: string): string[] {
  const sf = parse(file, source);
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (
      (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) &&
      !(n.parent && (ts.isImportDeclaration(n.parent) || ts.isExportDeclaration(n.parent)))
    ) {
      // NO PROSE FILTER HERE, deliberately. `isSubstantiveProse` decides whether
      // text is the SORT OF THING an author may write in a component or a page —
      // an authoring question. Using it to decide what gets JUDGED meant
      // `export const title = "Every change is tracked"` — four words, no full
      // stop, and the exact N1 wording — never reached the rules at all.
      //
      // A complete canonical literal is judged whatever its length. Short
      // technical strings cost nothing: the rules are specific phrases and do
      // not match `"@type"`.
      const value = normalise(n.text);
      if (value) out.push(value);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  // And the whole that an assembly denotes, not only its halves.
  return [...out, ...staticConcatClaims(file, source)];
}

/**
 * Every JSX expression in TEXT position that is not a complete literal.
 *
 * Reported directly, with no substantive-prose gate in front of it. The previous
 * "policy sources carry no holes" assertion went through
 * `assembledClaimViolations`, which only reports holes inside text it already
 * judged substantive — so `<p>{state}</p>` passed, its one-word placeholder
 * failing the gate, while `pageClaims` dropped the element for having a hole. If
 * `state` rendered a whole forbidden claim, the supposedly safe judged surface
 * stayed green.
 *
 * An invariant that guards a judged surface has to be asserted on its own terms.
 */
export function jsxHoles(file: string, source?: string): CopyViolation[] {
  const sf = parse(file, source);
  const out: CopyViolation[] = [];
  const visit = (n: ts.Node) => {
    if (
      ts.isJsxExpression(n) &&
      n.expression &&
      n.parent &&
      (ts.isJsxElement(n.parent) || ts.isJsxFragment(n.parent)) &&
      !ts.isStringLiteral(unwrap(n.expression)) &&
      !ts.isNoSubstitutionTemplateLiteral(unwrap(n.expression))
    ) {
      out.push({
        file,
        line: lineOf(sf, n),
        rule: "source/hole-in-text-position",
        detail: n.expression.getText().replace(/\s+/g, " ").slice(0, 70),
      });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/**
 * The sentences a page or policy source renders.
 *
 * One claim per element bearing substantive direct text, with declared inline
 * descendants folded in — which is what `<p>Read the <a>privacy policy</a> for
 * the full detail.</p>` needs and is 13.6% of the surface. No phrasing grammar
 * is involved: a non-inline element inside substantive text was already REFUSED
 * by `assembledClaimViolations`, so nothing here has to decide what to do about
 * one.
 */
export function pageClaims(file: string, source?: string): string[] {
  const sf = parse(file, source);
  const approved = approvedCopyNames(sf);
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (isClaimContainer(n) && !foldedIntoClaimParent(n)) {
      const parts = claimParts(n, approved);
      // A sentence with a hole is not a complete value, so it is not judged
      // here — it was already REFUSED by `assembledClaimViolations`, which is
      // the guard that owns it. Judging a half-written sentence is exactly the
      // reconstruction this architecture removed.
      // NO PROSE FILTER: this feeds JUDGEMENT. `<p>Every change is tracked</p>`
      // is four unpunctuated words and the exact N1 wording, and a length gate
      // here dropped it before any rule saw it — the same category error that
      // had already been fixed in `moduleClaims` and not carried across.
      if (parts.holes.length === 0) {
        const value = normalise(parts.text);
        if (value) out.push(value);
      }
    }
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      const attr = enclosingAttributeName(n);
      const jsxParent = parentPastWrappers(n);
      const insideClaimElement =
        jsxParent !== undefined &&
        ts.isJsxExpression(jsxParent) &&
        jsxParent.parent !== undefined &&
        isClaimContainer(jsxParent.parent);
      if ((!attr || !isPlumbingAttribute(attr)) && !insideClaimElement) {
        const value = normalise(n.text);
        if (value) out.push(value);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  // Same here. A component is rendering code, so `+` is ordinary and allowed
  // there; judging only the halves is what let a split binding launder N1.
  return [...out, ...staticConcatClaims(file, source)].filter(Boolean);
}

/**
 * The substantive prose a page authors — the AUTHORING view.
 *
 * Distinct from `pageClaims`, which is the JUDGEMENT view and is deliberately
 * unfiltered. Conflating the two is what let a four-word forbidden sentence
 * through twice: judgement must see everything readable, while the identity
 * baseline should freeze only the sentences a person actually wrote, or it would
 * record every nav label on the site.
 */
export function pageProse(file: string, source?: string): string[] {
  return pageClaims(file, source).filter(isSubstantiveProse);
}
