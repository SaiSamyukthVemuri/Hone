/**
 * The marketing copy surface, declared and frozen — never interpreted.
 *
 * WHY THIS IS NOT THE PREVIOUS SCANNER
 * ------------------------------------
 * The predecessor asked "what will this expression render". Answering that needs
 * a TypeScript compiler and a React renderer, and approximating both produced a
 * finding every round for twenty-two rounds: `+`, then `.join()`, then
 * `.concat()`, then a template, then a chained method, then a bare identifier,
 * then a property access, then a short label prefix, then a callback parameter,
 * then an array element. Each repair was correct and the sequence had no end.
 *
 * This asks a different question:
 *
 *     did visitor-facing text OUTSIDE the canonical copy modules grow?
 *
 * That needs no rendering model. The parser is used as a tokeniser — find text
 * runs and string literals — and the answer is compared against a frozen
 * inventory. Spelling stops mattering, because nothing is read for meaning: a
 * template, a concatenation, an alias, a wrapper and a re-export all fail
 * identically, since all of them require NEW TEXT somewhere and new text is what
 * is refused.
 *
 * Two shape refusals sit alongside the freeze, for the places where text can
 * arrive without appearing in the file. They are refusals, not inferences: they
 * do not ask what a value renders, they refuse a shape that cannot be read.
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
// R1. DECLARE — lists and directories, never a discovered import graph
// ---------------------------------------------------------------------------

/**
 * Where marketing copy may be AUTHORED.
 *
 * Judged in full against the register, and shape-guarded so every value in them
 * is a complete literal. They are not frozen: adding copy here is the law.
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
 * right and their text is NOT moved to satisfy this architecture. Named one by
 * one rather than matched, so their existence authorises nothing elsewhere.
 */
export const POLICY_SOURCES: readonly string[] = [
  "app/privacy/page.tsx",
  "app/terms/page.tsx",
];

/**
 * Directories whose every file renders to the public site.
 *
 * A DIRECTORY, not a hand-kept file list and not an import walk. A list rots the
 * moment a component is added; an import walk is the discovery this architecture
 * dropped. Every `.ts`/`.tsx` under these is inventoried, so a new file arrives
 * already covered.
 *
 * `app/_components/` holds only public surface at this head — the authenticated
 * application lives under `app/(app)/`. `app/actions/` holds the public form
 * actions whose returned text a component displays.
 */
export const DECLARED_COPY_DIRS: readonly string[] = [
  "app/_components",
  "app/actions",
  // Referenced from marketing components, so a value imported from here reaches
  // the page. It carries no prose today; declaring it costs nothing and keeps
  // the import rule from having to make an exception.
  "app/_fonts",
];

/**
 * Individual files outside those directories that still carry rendered copy.
 *
 * NAMED ONE AT A TIME, because the alternative is opening an infrastructure
 * tree. `app/layout.tsx` is applied by Next to every route without any route
 * importing it, and its metadata is what search results and social cards show.
 * `lib/rate-limit/public.ts` is a rate limiter, but `RATE_LIMIT_MESSAGE` is
 * returned by the demo action and shown to visitors.
 */
export const DECLARED_COPY_FILES: readonly string[] = [
  "app/layout.tsx",
  "lib/rate-limit/public.ts",
];

/** Marketing route files, from the MARKETING_PAGES registry. */
export function pageCopySources(): string[] {
  return publicRouteFiles().filter((f) => !POLICY_SOURCES.includes(f));
}

const filesUnder = (dir: string): string[] => {
  const abs = join(REPO_ROOT, dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs).flatMap((name) => {
    const rel = `${dir}/${name}`;
    if (statSync(join(REPO_ROOT, rel)).isDirectory()) return filesUnder(rel);
    return /\.tsx?$/.test(name) ? [rel] : [];
  });
};

/**
 * A declaration that names a file which is gone is a BROKEN declaration.
 *
 * Exported so it can be driven with a path that really is missing. Left inline,
 * it could only be proven by deleting a real source file, so it would have
 * shipped unpinned — and a guard that cannot be shown red is not yet a guard.
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

/**
 * Every declared file whose text is FROZEN.
 *
 * The canonical modules are excluded: authoring copy there is the law, not a
 * breach of it, and they are judged instead.
 */
export function frozenSurface(): string[] {
  const out = new Set<string>([
    ...pageCopySources(),
    ...POLICY_SOURCES,
    ...DECLARED_COPY_FILES,
  ]);
  for (const dir of DECLARED_COPY_DIRS) for (const f of filesUnder(dir)) out.add(f);
  for (const module of CANONICAL_COPY_MODULES) out.delete(module);
  // NOT FILTERED BY EXISTENCE. Dropping a missing file here made the declaration
  // self-healing in the worst way: move `lib/rate-limit/public.ts`, and the
  // stale entry vanishes silently while its replacement sits outside the
  // declared directories carrying visitor-facing text. The test that checks
  // every declared file exists then iterates an already-filtered list and can
  // never notice. A declaration that names a file that is gone is a broken
  // declaration, and it fails here.
  assertDeclaredExist([...out]);
  return [...out].sort();
}

// ---------------------------------------------------------------------------
// Parsing — as a TOKENISER, not a semantic model
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
 * Lifted unchanged from the predecessor, where it was validated against the real
 * surface. It decides what the INVENTORY holds — an authoring question. It is
 * deliberately never used to decide what gets JUDGED: a length gate there hid a
 * four-word forbidden sentence behind its own threshold.
 */
export function isSubstantiveProse(text: string): boolean {
  const value = normalise(decodeEntities(text));
  const tokens = value.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;

  // A PLAIN WORD is letters, with an optional internal hyphen or apostrophe and
  // optional trailing punctuation. `append-only` is a word; `min-h-[44px]` and
  // `text-[color:var(--x)]` are not — without this a Tailwind class string reads
  // as a nine-word sentence.
  const plain = tokens.filter((t) => /^[A-Za-z][A-Za-z'’-]*[.,;:!?)”"']*$/.test(t));
  if (plain.length < 3) return false;
  if (plain.length / tokens.length < 0.6) return false;

  const endsASentence = /[A-Za-z]{3,}[.!?]("|”|'|’)?(\s|$)/.test(value);

  // ENGLISH, NOT TOKENS. `inline-flex items-center justify-center rounded-md
  // border` is five hyphenated "words" by any shape test. Prose has function
  // words; a class list and an SVG path do not.
  const hasFunctionWord = plain.some((t) =>
    FUNCTION_WORDS.has(t.replace(/[^A-Za-z'’-]/g, "").toLowerCase()),
  );
  if (!hasFunctionWord && !endsASentence) return false;
  if (plain.length >= 5) return true;
  return endsASentence;
}

// ---------------------------------------------------------------------------
// R3. FREEZE — a lexical inventory, compared by identity, shrink-only
// ---------------------------------------------------------------------------

/**
 * Prose-like text a file contains, read lexically.
 *
 * Raw JSX text runs and string literals — no folding, no holes, no approval, no
 * readability, no notion of what renders. Two files with the same text produce
 * the same entries whatever their markup does, which is the property that makes
 * this stable to freeze.
 */
export function copyInventory(file: string, source?: string): string[] {
  const sf = parse(file, source);
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isJsxText(n)) {
      const text = normalise(decodeEntities(n.text));
      if (text && isSubstantiveProse(text)) out.push(text);
    }
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      const text = normalise(n.text);
      if (text && isSubstantiveProse(text)) out.push(text);
    }
    // A template's literal SEGMENTS are authored text too, whatever fills the
    // gaps between them.
    if (ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) {
      const text = normalise((n as ts.LiteralLikeNode).text);
      if (text && isSubstantiveProse(text)) out.push(text);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out.sort();
}

// ---------------------------------------------------------------------------
// Shape refusals — "this cannot be read", never "this renders X"
// ---------------------------------------------------------------------------

const unwrap = (node: ts.Node): ts.Node => {
  let cur = node;
  while (
    ts.isParenthesizedExpression(cur) ||
    ts.isAsExpression(cur) ||
    ts.isSatisfiesExpression(cur) ||
    ts.isNonNullExpression(cur) ||
    ts.isTypeAssertionExpression(cur)
  ) {
    cur = cur.expression;
  }
  return cur;
};

/**
 * Can this expression be read completely, right here, with no dataflow?
 *
 * Literals, JSX, and structures built only from those. A spread hides its
 * source, so anything carrying one is not proven. Everything else — a call, an
 * identifier, a property access — is unproven, and unproven fails closed.
 */
export function isProvenStatic(node: ts.Node): boolean {
  const e = unwrap(node);
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return true;
  if (ts.isNumericLiteral(e)) return true;
  if (
    e.kind === ts.SyntaxKind.TrueKeyword ||
    e.kind === ts.SyntaxKind.FalseKeyword ||
    e.kind === ts.SyntaxKind.NullKeyword
  ) {
    return true;
  }
  if (ts.isJsxElement(e) || ts.isJsxFragment(e) || ts.isJsxSelfClosingElement(e)) return true;
  if (ts.isArrayLiteralExpression(e)) return e.elements.every(isProvenStatic);
  if (ts.isObjectLiteralExpression(e)) {
    return e.properties.every(
      (prop) => ts.isPropertyAssignment(prop) && isProvenStatic(prop.initializer),
    );
  }
  return false;
}

/**
 * P2 CLASS 1 — an inline array rendered as copy whose elements are not proven.
 *
 * `{[intro, getClaim()].map((line) => <li>{line}</li>)}` puts visitor-facing
 * text on the page that appears nowhere in this file, so the inventory cannot
 * see it grow. The refusal is a SHAPE test: this array contains something that
 * cannot be read here, so it may not be rendered as copy. It makes no claim
 * about what the element evaluates to.
 *
 * Scoped to arrays that actually render — written inside a JSX expression, or
 * iterated — so ordinary data arrays elsewhere in a file are untouched.
 */
export function unprovenArrayViolations(file: string, source?: string): CopyViolation[] {
  const sf = parse(file, source);
  const out: CopyViolation[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isArrayLiteralExpression(n) && !isProvenStatic(n) && rendersAsCopy(n)) {
      const unproven = n.elements.filter((el) => !isProvenStatic(el));
      for (const element of unproven) {
        out.push({
          file,
          line: lineOf(sf, element),
          rule: "copy/unproven-array-element",
          detail: element.getText().replace(/\s+/g, " "),
        });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

const ITERATION_METHODS = new Set(["map", "flatMap"]);

/**
 * Is this array literal written where its elements reach the page as TEXT?
 *
 * Two positions count: inside a JSX expression that sits in CHILD position, and
 * the receiver of an iteration. An attribute value does not — `<Chart data={[1,
 * 2, load()]} />` is data, and the attributes a visitor actually reads have
 * their own rule. Distinguishing the two is why this looks at the JSX
 * expression's parent rather than stopping at the first `JsxExpression`.
 */
function rendersAsCopy(node: ts.ArrayLiteralExpression): boolean {
  for (let cur: ts.Node = node; cur.parent; cur = cur.parent) {
    // `[...].map(...)` — the receiver position of an iteration.
    const parent = cur.parent;
    if (
      ts.isPropertyAccessExpression(parent) &&
      ITERATION_METHODS.has(parent.name.text) &&
      unwrap(parent.expression) === cur
    ) {
      return true;
    }
    if (
      ts.isJsxExpression(parent) &&
      parent.parent &&
      (ts.isJsxElement(parent.parent) || ts.isJsxFragment(parent.parent))
    ) {
      return true;
    }
    if (ts.isJsxAttribute(parent)) return false;
  }
  return false;
}

/**
 * Attributes whose value a visitor READS.
 *
 * DOM text attributes and the ARIA members that carry literal text. The ARIA
 * `*-labelledby` / `*-describedby` members are deliberately absent: they hold
 * element ids, not words.
 */
export const TEXT_BEARING_ATTRIBUTES: readonly string[] = [
  "alt",
  "title",
  "placeholder",
  "summary",
  "aria-label",
  "aria-description",
  "aria-placeholder",
  "aria-roledescription",
  "aria-valuetext",
];

/**
 * P2 CLASS 2 — visitor-facing text passed through an attribute, dynamically.
 *
 * `<img alt={describe(photo)} />` and `<button aria-label={label}>` put words in
 * front of a visitor — including a screen-reader user, for whom `alt` IS the
 * content — while the file contains no such text for the inventory to hold.
 * Refused on SHAPE: an attribute a visitor reads must carry a complete value
 * written here.
 *
 * A static `alt="Close"` stays accepted and enters the inventory like any other
 * authored text.
 */
export function dynamicTextAttributeViolations(
  file: string,
  source?: string,
): CopyViolation[] {
  const sf = parse(file, source);
  const out: CopyViolation[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isJsxAttribute(n) && TEXT_BEARING_ATTRIBUTES.includes(n.name.getText())) {
      const value = n.initializer;
      // `alt` with no value at all is the empty-alt decorative case, which is
      // correct and carries no text.
      const proven =
        value === undefined ||
        ts.isStringLiteral(value) ||
        (ts.isJsxExpression(value) &&
          value.expression !== undefined &&
          isProvenStatic(value.expression));
      if (!proven) {
        out.push({
          file,
          line: lineOf(sf, n),
          rule: "copy/dynamic-text-attribute",
          detail: n.getText().replace(/\s+/g, " "),
        });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/**
 * P1 — a sentence that mixes authored words with a hole.
 *
 * `<p>Every {TRACKING_NOUN} is tracked</p>` renders the forbidden claim while
 * the joined candidate reads "Every is tracked" and each fragment is harmless.
 * Concatenation cannot close this: the missing word is not in the file, and the
 * value may come from a canonical module the import rule allows.
 *
 * REFUSED, not evaluated. Reading the hole means resolving a binding, which is
 * the analysis this architecture exists without. A sentence whose middle is a
 * value is not a complete copy value; author it as one. Existing occurrences are
 * declared by identity — six, today.
 *
 * A hole ALONE is untouched: `<p>{children}</p>` and `<p>{POSITIONING.corePromise}</p>`
 * carry no authored words, so they are consumption rather than a claim built
 * around a gap.
 */
export function incompleteClaimViolations(file: string, source?: string): CopyViolation[] {
  const sf = parse(file, source);
  const out: CopyViolation[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isJsxElement(n) || ts.isJsxFragment(n)) {
      let words = 0;
      const holes: ts.JsxExpression[] = [];
      for (const child of n.children) {
        if (ts.isJsxText(child)) {
          words += child.text
            .trim()
            .split(/\s+/)
            .filter((w) => /[A-Za-z]/.test(w)).length;
        }
        if (
          ts.isJsxExpression(child) &&
          child.expression &&
          !isProvenStatic(child.expression)
        ) {
          holes.push(child);
        }
      }
      if (words > 0 && holes.length > 0) {
        for (const hole of holes) {
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

/**
 * P1 — a value rendered as text that was imported from an UNDECLARED module.
 *
 * The escape this closes is ordinary refactoring: a declared component imports
 * `CLAIM` from a new `lib/…` helper and renders `{CLAIM}`. The component holds
 * no text for the inventory, the helper is on no declared list so nothing judges
 * it, and a bare identifier is not an assembly, an array or an attribute.
 *
 * NOT DISCOVERY. The import is never FOLLOWED and the module is never read. The
 * only question asked is whether the specifier names a file already on the
 * declared surface — a set membership test against a path written in the import
 * statement. Copy may come from a canonical module, or from another declared
 * file whose text is already frozen and judged; anywhere else is refused.
 */
export function undeclaredCopyImportViolations(
  file: string,
  declared: readonly string[],
  source?: string,
): CopyViolation[] {
  const sf = parse(file, source);
  const known = new Set(declared);

  // Which local names came from where. Lexical: it reads the import statement,
  // it does not open the file named there.
  const origin = new Map<string, string>();
  const collectImports = (n: ts.Node) => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
      const spec = n.moduleSpecifier.text;
      const rel = spec.startsWith("@/")
        ? spec.slice(2)
        : spec.startsWith(".")
          ? relative(REPO_ROOT, join(REPO_ROOT, dirname(file), spec))
          : null;
      if (rel === null || rel.startsWith("..")) return;
      const resolved =
        [".ts", ".tsx", "/index.ts", "/index.tsx"]
          .map((ext) => rel + ext)
          .find((candidate) => existsSync(join(REPO_ROOT, candidate))) ?? rel;
      const clause = n.importClause;
      if (clause?.name) origin.set(clause.name.text, resolved);
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const el of clause.namedBindings.elements) origin.set(el.name.text, resolved);
      }
      if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
        origin.set(clause.namedBindings.name.text, resolved);
      }
    }
    ts.forEachChild(n, collectImports);
  };
  collectImports(sf);

  const out: CopyViolation[] = [];
  const seen = new Set<string>();
  const check = (expression: ts.Expression, at: ts.Node) => {
    // EVERY identifier in the expression, not only its root. A prop is often
    // `{`${PREFIX} …`}` or `{pick(CLAIM)}`, and a root-only test reads the
    // wrapper rather than the value.
    const collect = (x: ts.Node) => {
      if (ts.isIdentifier(x)) {
        const from = origin.get(x.text);
        if (from !== undefined && !known.has(from)) {
          const key = `${lineOf(sf, at)}:${x.text}:${from}`;
          if (!seen.has(key)) {
            seen.add(key);
            out.push({
              file,
              line: lineOf(sf, at),
              rule: "copy/undeclared-copy-import",
              detail: `${x.text} from ${from}`,
            });
          }
        }
      }
      ts.forEachChild(x, collect);
    };
    collect(expression);
  };
  const visit = (n: ts.Node) => {
    // CHILD position — `<p>{CLAIM}</p>`.
    if (
      ts.isJsxExpression(n) &&
      n.expression &&
      n.parent &&
      (ts.isJsxElement(n.parent) || ts.isJsxFragment(n.parent))
    ) {
      check(n.expression, n);
    }
    // ATTRIBUTE position — `<Hero headline={CLAIM} />`. A custom component prop
    // renders whatever it is handed, and the fixed list of DOM text-bearing
    // attributes cannot know that `headline` is copy. Checking the SOURCE of the
    // value instead of the NAME of the attribute needs no such knowledge.
    if (ts.isJsxAttribute(n) && n.initializer && ts.isJsxExpression(n.initializer)) {
      if (n.initializer.expression) check(n.initializer.expression, n);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** The leftmost identifier of `A.b.c`, or null. */
function rootIdentifier(e: ts.Expression): string | null {
  let cur = unwrap(e) as ts.Expression;
  while (ts.isPropertyAccessExpression(cur)) cur = unwrap(cur.expression) as ts.Expression;
  return ts.isIdentifier(cur) ? cur.text : null;
}

/**
 * R4 — copy assembled from authored words and something dynamic.
 *
 * The one rule about spelling that survives, and it is a refusal: a binding or
 * property that glues authored words to a value cannot be read as a whole, so it
 * is reported rather than guessed at. `+`, a template, `.join()` and `.concat()`
 * are all the same shape.
 *
 * TWO PLAIN WORDS, measured. The only mixed assembly on the declared surface is
 * a Tailwind class string, whose tokens carry hyphens, colons and brackets; a
 * sentence fragment does not. A prose-LENGTH gate would have missed the
 * four-word forbidden wording, which is why the threshold counts bare
 * alphabetic words instead.
 */
export function assembledCopyViolations(file: string, source?: string): CopyViolation[] {
  const sf = parse(file, source);
  const out: CopyViolation[] = [];
  const visit = (n: ts.Node) => {
    const e = unwrap(n);
    const assembles =
      ts.isTemplateExpression(e) ||
      (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) ||
      (ts.isCallExpression(e) &&
        ts.isPropertyAccessExpression(e.expression) &&
        (e.expression.name.text === "join" || e.expression.name.text === "concat"));
    // NO "unless it is fully static" exemption. `"Every change" + " is tracked"`
    // is entirely literal and still renders the forbidden sentence, while each
    // fragment is below the prose threshold and matches no rule on its own. The
    // predecessor answered that by FOLDING the expression, which is how it ended
    // up chasing `.join()`, `.concat()`, templates and chained methods one round
    // at a time. Refusing the shape needs none of that: author it as one value.
    if (assembles && e === n) {
      const words: string[] = [];
      let literalText = "";
      const collect = (x: ts.Node) => {
        if (
          ts.isStringLiteral(x) ||
          ts.isNoSubstitutionTemplateLiteral(x) ||
          ts.isTemplateHead(x) ||
          ts.isTemplateMiddle(x) ||
          ts.isTemplateTail(x)
        ) {
          literalText += ` ${(x as ts.LiteralLikeNode).text}`;
          for (const w of (x as ts.LiteralLikeNode).text.split(/\s+/)) {
            if (/^[A-Za-z]+$/.test(w)) words.push(w);
          }
        }
        ts.forEachChild(x, collect);
      };
      collect(e);
      // TWO PLAIN WORDS AND A PROSE RATIO. Counting plain words alone flagged
      // two real Tailwind templates: `flex flex-col rounded-[12px] border
      // bg-white` yields "flex" and "border" and nothing else, which is two. A
      // sentence fragment is mostly plain words; a class list is mostly not. The
      // ratio separates them without a LENGTH gate, which is what let the
      // four-word forbidden wording through everywhere else.
      const tokens = literalText.split(/\s+/).filter(Boolean);
      const proseRatio = tokens.length === 0 ? 0 : words.length / tokens.length;
      if (words.length >= 2 && proseRatio >= 0.6) {
        out.push({
          file,
          line: lineOf(sf, n),
          rule: "copy/assembled-from-fragments",
          detail: e.getText().replace(/\s+/g, " "),
        });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

// ---------------------------------------------------------------------------
// R2. JUDGE — every string a canonical module holds, unfiltered
// ---------------------------------------------------------------------------

/**
 * Every string literal a canonical copy module contains.
 *
 * NO PROSE FILTER, deliberately. `isSubstantiveProse` decides what may be
 * AUTHORED where; using it here meant `export const title = "Every change is
 * tracked"` — four words, no full stop, the exact forbidden wording — never
 * reached the rules. Short technical strings cost nothing: the rules are
 * specific phrases and do not match `"@type"`.
 */
export function moduleLiterals(file: string, source?: string): string[] {
  const sf = parse(file, source);
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (
      (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) &&
      !(n.parent && (ts.isImportDeclaration(n.parent) || ts.isExportDeclaration(n.parent)))
    ) {
      const value = normalise(n.text);
      if (value) out.push(value);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/**
 * Every piece of text a file contains, WITHOUT the prose filter.
 *
 * The inventory holds substantive prose only, so it stays stable and a CSS tweak
 * does not redden the build — but that gate needs five plain words or a full
 * stop, and `Every change is tracked` is four words with neither. The exact
 * forbidden wording would therefore never have entered the frozen set.
 *
 * Judgement has no such threshold and costs nothing: the rules are specific
 * phrases and match no class name. So the freeze answers "did prose grow" and
 * this answers "did forbidden wording appear", and neither is asked to do the
 * other's job.
 */
export function judgeableText(file: string, source?: string): string[] {
  const sf = parse(file, source);
  const out: string[] = [];

  // WHOLE SUBTREES, not one text node at a time. `<p>Every change <strong>is
  // tracked</strong></p>` emits "Every change" and "is tracked", and neither
  // fragment matches a rule or reaches the prose threshold — the sentence a
  // visitor reads existed nowhere in the corpus.
  //
  // This is CONCATENATION, not a rendering model. It does not decide which tags
  // are inline, what a hole evaluates to, or how React composes the tree: it
  // joins the text a subtree contains, at every level. Joining too eagerly
  // across a block boundary can only ADD a candidate string, never hide one, and
  // an extra candidate fails closed — a build failure a human looks at, rather
  // than a silent pass. That asymmetry is why concatenation is safe here and
  // interpretation was not.
  const subtreeText = (node: ts.Node): string => {
    let text = "";
    const gather = (x: ts.Node) => {
      if (ts.isJsxText(x)) text += ` ${decodeEntities(x.text)}`;
      if (
        (ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x)) &&
        x.parent &&
        ts.isJsxExpression(x.parent)
      ) {
        text += ` ${x.text}`;
      }
      ts.forEachChild(x, gather);
    };
    gather(node);
    return normalise(text);
  };

  const visit = (n: ts.Node) => {
    if (ts.isJsxElement(n) || ts.isJsxFragment(n)) {
      const joined = subtreeText(n);
      if (joined) out.push(joined);
    }
    if (ts.isJsxText(n)) {
      const text = normalise(decodeEntities(n.text));
      if (text) out.push(text);
    }
    if (
      ts.isStringLiteral(n) ||
      ts.isNoSubstitutionTemplateLiteral(n) ||
      ts.isTemplateHead(n) ||
      ts.isTemplateMiddle(n) ||
      ts.isTemplateTail(n)
    ) {
      const text = normalise((n as ts.LiteralLikeNode).text);
      if (text) out.push(text);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** Every string reachable in a runtime value, so a data module is judged by value too. */
export function walkStrings(value: unknown, seen = new Set<unknown>()): string[] {
  if (typeof value === "string") return [value];
  if (value === null || typeof value !== "object") return [];
  if (seen.has(value)) return [];
  seen.add(value);
  return Object.values(value as Record<string, unknown>).flatMap((v) => walkStrings(v, seen));
}
