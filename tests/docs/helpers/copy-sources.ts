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
  // One level, and components only. Going transitive is what made the previous
  // architecture unbounded; a component a declared page renders is a rendering
  // source, and that is where the line sits.
  for (const page of [...pageCopySources(), ...POLICY_SOURCES]) {
    const sf = parse(page);
    const visit = (n: ts.Node) => {
      if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
        const spec = n.moduleSpecifier.text;
        // `@/app/_components/...` and `../_components/...` are the same file.
        // The hand-kept list missed `DemoForm` because `app/demo/page.tsx`
        // imports it relatively, which is the ordinary way to import a sibling.
        const rel = spec.startsWith("@/")
          ? spec.slice(2)
          : spec.startsWith(".")
            ? relative(REPO_ROOT, join(REPO_ROOT, dirname(page), spec))
            : null;
        // ANY directly imported first-party component, not just two blessed
        // directories. A page can colocate one — `app/pricing/Hero.tsx` via
        // `./Hero` — and a directory allow-list silently omits it, which is the
        // same rot as the hand-kept list it already replaced. A page importing a
        // `.tsx` is importing a component; that is the whole test.
        if (rel && !rel.startsWith("..")) {
          for (const ext of [".tsx", "/index.tsx"]) {
            if (existsSync(join(REPO_ROOT, rel + ext))) out.add(rel + ext);
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return [...out].sort();
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
  let cur: ts.Node | undefined = node.parent;
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
    cur = cur.parent;
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
    if (ts.isTemplateExpression(n) && assemblesProse(staticFragments(n))) {
      flag("copy-module/no-interpolation", n.getText().slice(0, 70));
    } else if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.PlusToken &&
      assemblesProse(staticFragments(n))
    ) {
      flag("copy-module/no-concatenation", n.getText().slice(0, 70));
    } else if (ts.isConditionalExpression(n)) {
      // A conditional is allowed when EACH branch is already a complete value —
      // that is the law's own wording, and `PUBLISHED ? "CAD $99" : null` is a
      // value shown or withheld, not a claim built from halves. It is refused
      // only when a branch is itself assembled.
      for (const branch of [n.whenTrue, n.whenFalse]) {
        if (!isCompleteValue(branch) && assemblesProse(staticFragments(branch))) {
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
 * Are these fragments a substantive claim being ASSEMBLED?
 *
 * Three words in one fragment, or prose across the joined fragments. A
 * `mailto:${CONTACT_EMAIL}` contributes one token and is a resource path, not a
 * sentence — the law governs claims, not every string a module builds.
 */
function assemblesProse(fragments: string[]): boolean {
  if (fragments.length === 0) return false;
  if (fragments.some((f) => f.trim().split(/\s+/).filter((w) => /^[A-Za-z]/.test(w)).length >= 3)) {
    return true;
  }
  return isSubstantiveProse(fragments.join(" "));
}

/** A complete value needs no assembly: a literal, or an absence. */
function isCompleteValue(node: ts.Node): boolean {
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
    if (ts.isJsxElement(n)) {
      const parts = claimParts(n, approved);
      if (isSubstantiveProse(parts.textWithHoles)) {
        out.push({
          file,
          line: lineOf(sf, n),
          rule: "component/no-authored-prose",
          detail: normalise(parts.text || parts.textWithHoles).slice(0, 70),
        });
      }
    }
    if (
      (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) &&
      isSubstantiveProse(n.text)
    ) {
      const attr = enclosingAttributeName(n);
      const insideJsxText = ts.isJsxExpression(n.parent) && ts.isJsxElement(n.parent.parent);
      if ((!attr || !isPlumbingAttribute(attr)) && !insideJsxText) {
        out.push({
          file,
          line: lineOf(sf, n),
          rule: "component/no-authored-prose",
          detail: normalise(n.text).slice(0, 70),
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
    if (ts.isJsxElement(n)) {
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
  readonly sequence: Array<{ words: number } | { hole: ts.Node }>;
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
  return names;
}

/** The leftmost identifier of `A.b.c`, or null. */
function rootIdentifier(e: ts.Expression): string | null {
  let cur: ts.Expression = e;
  while (ts.isPropertyAccessExpression(cur)) cur = cur.expression;
  return ts.isIdentifier(cur) ? cur.text : null;
}

function claimParts(node: ts.JsxElement, approved: Set<string> = new Set()): ClaimParts {
  let text = "";
  let textWithHoles = "";
  const holes: ts.Node[] = [];
  const approvedHoles: ts.Node[] = [];
  const undeclared: ts.Node[] = [];
  // A flat run of what this sentence is made of, in source order, so "is there
  // authored text on both sides of this hole" is a lookup rather than a guess.
  const sequence: Array<{ words: number } | { hole: ts.Node }> = [];
  for (const child of node.children) {
    if (ts.isJsxText(child)) {
      const t = decodeEntities(child.text);
      text += t;
      textWithHoles += t;
      sequence.push({ words: t.trim().split(/\s+/).filter((w) => /[A-Za-z]/.test(w)).length });
    } else if (ts.isJsxExpression(child) && child.expression) {
      const e = child.expression;
      if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) {
        text += e.text;
        textWithHoles += e.text;
        sequence.push({ words: e.text.trim().split(/\s+/).filter((w) => /[A-Za-z]/.test(w)).length });
      } else {
        const root = rootIdentifier(e);
        // A placeholder WORD, with no padding of its own: the authored text
        // around it already carries the spacing, and adding any detached the
        // full stop from the last word so the sentence stopped reading as one.
        textWithHoles += "something";
        sequence.push({ hole: child });
        if (root && approved.has(root)) approvedHoles.push(child);
        else holes.push(child);
      }
    } else if (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child)) {
      if (ts.isJsxElement(child) && INLINE_IN_CLAIM.includes(tagNameOf(child))) {
        const inner = claimParts(child, approved);
        text += inner.text;
        textWithHoles += inner.textWithHoles;
        sequence.push(...inner.sequence);
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
    const before = sequence.slice(0, i).some((x) => "words" in x && x.words > 0);
    const after = sequence.slice(i + 1).some((x) => "words" in x && x.words > 0);
    return before && after ? [item.hole] : [];
  });
  return { text, textWithHoles, holes, approvedHoles, undeclared, completing, sequence };
}

const claimText = (node: ts.JsxElement, approved?: Set<string>): string =>
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
      !(n.parent && (ts.isImportDeclaration(n.parent) || ts.isExportDeclaration(n.parent))) &&
      isSubstantiveProse(n.text)
    ) {
      out.push(normalise(n.text));
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
    if (ts.isJsxElement(n)) {
      const parts = claimParts(n, approved);
      // A sentence with a hole is not a complete value, so it is not judged
      // here — it was already REFUSED by `assembledClaimViolations`, which is
      // the guard that owns it. Judging a half-written sentence is exactly the
      // reconstruction this architecture removed.
      if (parts.holes.length === 0 && isSubstantiveProse(parts.text)) {
        out.push(normalise(parts.text));
      }
    }
    if (
      (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) &&
      isSubstantiveProse(n.text)
    ) {
      const attr = enclosingAttributeName(n);
      const insideClaimElement =
        ts.isJsxExpression(n.parent) && ts.isJsxElement(n.parent.parent);
      if ((!attr || !isPlumbingAttribute(attr)) && !insideClaimElement) {
        out.push(normalise(n.text));
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out.filter(Boolean);
}
