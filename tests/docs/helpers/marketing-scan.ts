/**
 * The public marketing surface, DERIVED — and the copy on it, PARSED.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * `tests/docs/marketing-truth-register.test.ts` enforces that claims the truth
 * register classifies NOT_CURRENTLY_SUPPORTABLE never reach public copy. That
 * guard is only as good as two things: the set of files it opens, and its
 * ability to read a claim the way a visitor reads it. Review broke both,
 * repeatedly, and always in the same direction — the guard reported clean on
 * copy it had never looked at.
 *
 * THE SURFACE was a hand-maintained list. It missed the three `app/resources/`
 * routes; once those were added it missed `lib/marketing/resources.ts`, whose
 * titles they render; once that was added it missed the shared components every
 * page mounts (`SiteFooter` authors "Operated from Canada."); and it explicitly
 * filtered OUT `/privacy` and `/terms` on the reasoning that scanning
 * `PolicyLayout` covered them — it does not, it covers the wrapper, not the
 * `children` where the entire policy text lives. Four holes, one cause: a list
 * that must be remembered is a list that will be forgotten.
 *
 * So the surface is no longer written down. Route files are derived from
 * `MARKETING_PAGES` — the registry that already drives the sitemap, per-page
 * metadata and the middleware public-route allowlist — and everything those
 * routes render is derived by following their imports. A new public page, a new
 * shared component, or a new copy module is scanned the day it is reachable,
 * with nobody needing to notice.
 *
 * THE READING was a stack of regexes over file text. Each fix bred the next
 * hole: scanning only double-quoted literals missed raw JSX text, single quotes
 * and template literals; splitting JSX at every tag boundary judged
 * `<strong>an append-only edit history for sterile items</strong>` on its own
 * and passed it, while the rendered sentence "Every treatment record has …"
 * promised exactly what §0.4 N1 rejects; inlining `{"…"}` closed that one level
 * down and then failed when the literal contained the opposite quote character;
 * and comment-stripping by regex ORDER was wrong on some valid input whichever
 * order it chose.
 *
 * None of those are bugs in a particular pattern. They are what happens when a
 * grammar is approximated by patterns. So copy is read with the TypeScript
 * parser instead: the AST knows what a comment is, what a string is, which
 * quote closes which literal, and where a JSX element ends. Every one of the
 * holes above is unrepresentable here rather than patched.
 */
import ts from "typescript";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { MARKETING_PAGES } from "@/lib/marketing/content";

export const REPO_ROOT = resolve(__dirname, "../../..");

const readSource = (rel: string) => readFileSync(join(REPO_ROOT, rel), "utf8");

// ---------------------------------------------------------------------------
// 1. The surface: which files a visitor's page is built from
// ---------------------------------------------------------------------------

/**
 * The route file behind each indexable public path.
 *
 * `MARKETING_PAGES` is the registry of record for what is public — it drives
 * `SITEMAP_PATHS`, the per-page metadata and the middleware allowlist — so
 * deriving from it means a new indexable route cannot be added without this
 * scan picking it up. `/privacy` and `/terms` are ordinary members here; they
 * were previously filtered out, which is precisely how the whole of both policy
 * texts went unscanned.
 */
export function publicRouteFiles(): string[] {
  return MARKETING_PAGES.filter((p) => p.indexable).map((p) => {
    const rel =
      p.path === "/" ? "app/page.tsx" : `app${p.path}/page.tsx`;
    if (!existsSync(join(REPO_ROOT, rel))) {
      throw new Error(
        `MARKETING_PAGES declares ${p.path} indexable, but ${rel} does not exist — ` +
          "the public-copy scan cannot open the page it is supposed to govern",
      );
    }
    return rel;
  });
}

/**
 * The layouts and templates Next.js wraps a route in.
 *
 * These are applied by CONVENTION, not by import: `app/layout.tsx` renders
 * around every marketing page and nothing in the route file mentions it, so
 * following imports from `page.tsx` never reaches it. A prohibited claim added
 * there would ship on all twelve routes with this guard green — the same
 * "copy the scan never opened" failure as the hand-kept list, arriving through
 * a different door.
 *
 * Walks from the route's own directory up to `app/`, which is how Next resolves
 * the chain, and picks up `template.*` alongside `layout.*`.
 */
function layoutChainFor(routeFile: string): string[] {
  const out: string[] = [];
  let dir = dirname(routeFile);
  for (;;) {
    for (const base of ["layout", "template"]) {
      for (const ext of [".tsx", ".ts"]) {
        const rel = `${dir}/${base}${ext}`;
        if (existsSync(join(REPO_ROOT, rel))) out.push(rel);
      }
    }
    if (dir === "app" || dir === "." || dir === "") break;
    dir = dirname(dir);
  }
  return out;
}

/** Resolve a first-party import specifier to a repo-relative file, or null. */
function resolveFirstParty(spec: string, fromRel: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(REPO_ROOT, spec.slice(2));
  else if (spec.startsWith(".")) base = join(REPO_ROOT, dirname(fromRel), spec);
  else return null; // a package, or `server-only` — not our copy
  for (const ext of [".tsx", ".ts", "/index.tsx", "/index.ts"]) {
    if (existsSync(base + ext)) return relative(REPO_ROOT, base + ext);
  }
  // Any existing first-party file counts as RESOLVED, including a stylesheet or
  // an asset. Only `.ts`/`.tsx` are walked for copy, but resolving them here is
  // what distinguishes "this import holds no copy" from "this import could not
  // be followed" — and only the second is a hole worth failing on.
  if (existsSync(base)) return relative(REPO_ROOT, base);
  return null;
}

function importSpecifiers(sf: ts.SourceFile): string[] {
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
      out.push(n.moduleSpecifier.text);
    }
    if (
      ts.isExportDeclaration(n) &&
      n.moduleSpecifier &&
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
 * Every first-party file a public route is built from, transitively.
 *
 * This is the honest universe: if a module is reachable from a public page it
 * ships to that page, so copy authored in it is public copy. An unresolvable
 * relative/aliased specifier is a hard error rather than a silent omission —
 * "we could not follow this import" is exactly the failure that must not read
 * as "there was nothing there".
 */
export function publicMarketingSources(): string[] {
  const seen = new Set<string>();
  const walk = (rel: string) => {
    if (seen.has(rel)) return;
    seen.add(rel);
    const sf = ts.createSourceFile(
      rel,
      readSource(rel),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    for (const spec of importSpecifiers(sf)) {
      const resolved = resolveFirstParty(spec, rel);
      if (resolved) {
        if (/\.tsx?$/.test(resolved)) walk(resolved);
        continue;
      }
      if (spec.startsWith("@/") || spec.startsWith(".")) {
        throw new Error(
          `${rel} imports "${spec}", which resolves to no first-party file — ` +
            "the public-copy scan would silently skip whatever it holds",
        );
      }
    }
  };
  for (const route of publicRouteFiles()) {
    walk(route);
    // Applied by convention, so they are seeded as roots rather than found.
    for (const wrapper of layoutChainFor(route)) walk(wrapper);
  }
  return [...seen].sort();
}

// ---------------------------------------------------------------------------
// 2. The reading: claims, as a visitor receives them
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = {
  "&apos;": "'",
  "&quot;": '"',
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&nbsp;": " ",
  "&mdash;": "—",
  "&ndash;": "–",
  "&hellip;": "…",
  "&rsquo;": "’",
  "&lsquo;": "‘",
  "&ldquo;": "“",
  "&rdquo;": "”",
  "&middot;": "·",
  "&times;": "×",
};

function decodeEntities(text: string): string {
  return text.replace(/&(?:#\d+|#x[0-9a-fA-F]+|[a-zA-Z]+);/g, (m) => {
    const named = NAMED_ENTITIES[m.toLowerCase()];
    if (named) return named;
    const dec = /^&#(\d+);$/.exec(m);
    if (dec) return String.fromCodePoint(Number(dec[1]));
    const hex = /^&#x([0-9a-fA-F]+);$/i.exec(m);
    if (hex) return String.fromCodePoint(parseInt(hex[1], 16));
    return m;
  });
}

const normalise = (text: string) => decodeEntities(text).replace(/\s+/g, " ").trim();

/**
 * Fold every dash a browser renders as a hyphen down to an ASCII one, for
 * MATCHING only — the claim text itself keeps what the author wrote.
 *
 * `append‑only` with U+2011 (or its `&#8209;` entity, which decodes to the same
 * character) reads identically to a visitor and was invisible to an ASCII-only
 * pattern, so an unsupported sentence slipped past both the sanctioned-wording
 * allow-list and the forbidden patterns. Non-breaking and thin spaces fold too:
 * `\s` already covers U+00A0, but U+2009 and friends are not whitespace to
 * every engine and would have split a word the same way.
 */
export const foldForMatching = (text: string) =>
  text
    // U+2010 hyphen through U+2015 horizontal bar, U+2212 minus, and the
    // small/fullwidth forms. All render as a hyphen.
    .replace(/[\u2010-\u2015\u2212\ufe58\ufe63\uff0d]/g, "-")
    // U+00A0 no-break space, U+2000-U+200A, U+202F, U+205F, U+3000.
    .replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Attributes that carry no copy. Everything else — `alt`, `title`,
 * `aria-label`, `placeholder`, and any prop a component names — is treated as
 * copy, because a component prop is how most of this site's sentences are
 * actually authored.
 */
const NON_COPY_ATTRIBUTES = new Set(
  [
    "className", "class", "style", "id", "key", "href", "src", "srcSet",
    "xmlns", "viewBox", "d", "fill", "stroke", "strokeWidth", "strokeLinecap",
    "strokeLinejoin", "transform", "points", "cx", "cy", "r", "x", "y", "x1",
    "x2", "y1", "y2", "rx", "ry", "width", "height", "offset", "stopColor",
    "gradientUnits", "patternUnits", "preserveAspectRatio", "rel", "target",
    "type", "htmlFor", "tabIndex", "lang", "dir", "loading", "decoding",
    "fetchPriority", "method", "action", "autoComplete", "inputMode",
    "pattern", "charSet", "httpEquiv", "property", "itemProp", "itemType",
    "as", "crossOrigin", "referrerPolicy", "opacity", "fillOpacity",
    "strokeOpacity", "clipPath", "mask", "filter", "vectorEffect",
    "shapeRendering", "fontFamily", "fontSize", "fontWeight", "textAnchor",
    "dominantBaseline", "letterSpacing", "color", "media", "sizes", "name",
    "role", "path",
  ].map((a) => a.toLowerCase()),
);

/** Is this attribute one of the technical ones that never carries copy? */
function isNonCopyAttribute(attr: ts.JsxAttribute): boolean {
  const name = ts.isIdentifier(attr.name) ? attr.name.text : attr.name.getText();
  return NON_COPY_ATTRIBUTES.has(name.toLowerCase());
}

type JsxContainer = ts.JsxElement | ts.JsxFragment | ts.JsxSelfClosingElement;

const isJsxContainer = (n: ts.Node): n is JsxContainer =>
  ts.isJsxElement(n) || ts.isJsxFragment(n) || ts.isJsxSelfClosingElement(n);

const jsxChildren = (n: JsxContainer): readonly ts.JsxChild[] =>
  ts.isJsxSelfClosingElement(n) ? [] : n.children;

/** The tag as written: "p", "Strong", or null for a fragment. */
function tagOf(node: JsxContainer): string | null {
  if (ts.isJsxFragment(node)) return null;
  const opening = ts.isJsxElement(node) ? node.openingElement : node;
  return opening.tagName.getText();
}

/**
 * HTML elements whose content model is PHRASING ONLY — they cannot legally
 * contain a block, so whatever is inside one of them is a single sentence.
 *
 * This is a closed set from the HTML spec, not a judgement call, and it is what
 * makes `<p><span>Every treatment record has</span><strong> an append-only edit
 * history for sterile items</strong></p>` one claim. An earlier version asked
 * instead whether the container had text of its own, which read that `<p>` as
 * layout because every child happened to be an element — and split the sentence
 * exactly where the unsupported promise and its qualifier fell either side of
 * the boundary.
 */
const PHRASING_ONLY_CONTAINERS = new Set([
  "p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "dt", "dd", "td", "th",
  "caption", "figcaption", "legend", "summary", "label", "button", "option",
  "pre", "address",
]);

/** Elements that are themselves phrasing content — inline markup. */
const PHRASING_CONTENT = new Set([
  "a", "abbr", "b", "bdi", "bdo", "br", "cite", "code", "data", "dfn", "em",
  "i", "img", "kbd", "mark", "picture", "q", "ruby", "rp", "rt", "s", "samp",
  "small", "span", "strong", "sub", "sup", "time", "u", "var", "wbr",
]);

/**
 * True when nothing inside this container can start a new block — so its whole
 * subtree reads as one sentence even though the container itself is a `<div>`
 * or a component. A capitalised component counts as a possible block: `<Layout>
 * <P>one</P><P>two</P></Layout>` must stay two claims, not become one.
 */
/**
 * Does this container read as ONE sentence?
 *
 * Three independent reasons, and the first two are structural facts about HTML
 * rather than judgement calls. The third catches a component used as inline
 * markup inside authored text, which no tag list can know.
 *
 * Shared with the unreconstructable-sentence detector below, deliberately: the
 * two must agree on where a sentence begins and ends, or a hole and the prose
 * that sets its scope end up in different units and the pairing is missed —
 * which is exactly how wrapping either half in a `<span>` slipped past.
 */
export function isSentenceContainer(node: JsxContainer): boolean {
  const children = jsxChildren(node);
  const bearsText = children.some(
    (c) =>
      (ts.isJsxText(c) && /[A-Za-z]/.test(decodeEntities(c.text))) ||
      (ts.isJsxExpression(c) &&
        /[A-Za-z]/.test(authoredExpressionText(c)?.text ?? "")),
  );
  const tag = tagOf(node);
  return (
    (tag !== null && PHRASING_ONLY_CONTAINERS.has(tag)) ||
    subtreeIsAllPhrasing(node) ||
    bearsText
  );
}

function subtreeIsAllPhrasing(node: JsxContainer): boolean {
  let allPhrasing = true;
  const visit = (n: ts.Node) => {
    if (!allPhrasing) return;
    if (isJsxContainer(n) && n !== node) {
      const tag = tagOf(n);
      if (!tag || !PHRASING_CONTENT.has(tag)) {
        allPhrasing = false;
        return;
      }
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(node, visit);
  return allPhrasing;
}

/**
 * The text of a `{…}` expression, when the expression IS authored text.
 *
 * `{"an append-only edit history"}` is a sentence fragment a visitor reads, so
 * it belongs to the surrounding sentence. The parser settles which quote closes
 * the literal, so an apostrophe inside a double-quoted literal — the case that
 * defeated the regex — is simply not a special case here.
 *
 * Anything else (`{cond ? a : b}`, `{feature.body}`) is a value this scan
 * cannot resolve. It contributes a separator, never text: gluing an unresolved
 * value's own literals into the sentence would let an unscoped claim borrow a
 * qualifier it never renders next to.
 */
type AuthoredExpression = {
  /** The text this expression contributes to the sentence. */
  readonly text: string;
  /**
   * Whether that text is the WHOLE of what the expression renders.
   *
   * A template literal with substitutions is only partly readable: `{`Every
   * treatment record has ${it.body}`}` gives up "Every treatment record has"
   * and swallows the rest. Reporting that as fully authored let the static half
   * set a scope while the value behind `it.body` passed on its own as a
   * sanctioned sentence — so the static fragments are still used as text, and
   * the expression still counts as a hole.
   */
  readonly complete: boolean;
};

function readExpression(e: ts.Expression): AuthoredExpression | null {
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) {
    return { text: e.text, complete: true };
  }
  if (ts.isTemplateExpression(e)) {
    return {
      text: [e.head.text, ...e.templateSpans.map((s) => s.literal.text)].join(" "),
      complete: e.templateSpans.length === 0,
    };
  }
  if (ts.isParenthesizedExpression(e)) return readExpression(e.expression);
  // Concatenation is authoring, not computation: `{"…an append-" + "only edit
  // history"}` renders one sentence, and scanning the two literals separately
  // meant neither half tripped a rule while the rendered claim did. Joined with
  // NO separator, because that is what `+` does — the hyphen has to survive.
  if (
    ts.isBinaryExpression(e) &&
    e.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = readExpression(e.left);
    const right = readExpression(e.right);
    if (!left && !right) return null;
    return {
      text: `${left?.text ?? " "}${right?.text ?? " "}`,
      complete: Boolean(left?.complete && right?.complete),
    };
  }
  return null;
}

function authoredExpressionText(expr: ts.JsxExpression): AuthoredExpression | null {
  return expr.expression ? readExpression(expr.expression) : null;
}

/**
 * Every claim in one source file: the sentences its JSX renders, plus every
 * authored string literal.
 *
 * SENTENCE ASSEMBLY. A container whose children mix text with elements is a
 * paragraph — its element children are inline markup and are dissolved INTO the
 * sentence. A container whose children are only elements is a layout — each
 * child starts its own claim. That one structural rule replaces the tag
 * allow-lists that kept being incomplete, and it is the rule that makes
 * `<p>Every treatment record has <strong>an append-only edit history for
 * sterile items</strong></p>` one claim rather than two.
 *
 * Comments never appear. The parser removes them by construction, so the
 * comment-stripping order bug — line-first eats a block terminator, block-first
 * eats real code after a `next/ *` inside a line comment — has no expression
 * here at all.
 */
export function collectClaims(src: string, fileName = "input.tsx"): string[] {
  const sf = ts.createSourceFile(
    fileName,
    src,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );

  const claims: string[] = [];
  const push = (text: string) => {
    const value = normalise(text);
    if (value && /[A-Za-z]/.test(value)) claims.push(value);
  };

  // Containers already folded into a claim, so the file-wide sweep below does
  // not emit them a second time as roots of their own.
  const consumed = new Set<ts.Node>();

  /**
   * Fold a whole subtree's text into the sentence being built.
   *
   * Nothing is padded. JSX text nodes already carry the spacing the browser
   * renders, so concatenating verbatim reproduces the sentence a visitor reads
   * — `Edits kept as <em>history</em>, not written over.` comes back with its
   * comma attached, and `hist<em>ory</em>` comes back as one word rather than
   * two. An unresolved expression is the one thing that DOES contribute a
   * space: it stands for text this scan cannot see, and must not fuse the
   * words on either side of it into a claim nobody wrote.
   */
  const flattenInto = (node: JsxContainer): string => {
    consumed.add(node);
    let text = "";
    for (const child of jsxChildren(node)) {
      if (ts.isJsxText(child)) {
        text += decodeEntities(child.text);
      } else if (ts.isJsxExpression(child)) {
        text += authoredExpressionText(child)?.text ?? " ";
      } else if (isJsxContainer(child)) {
        text += flattenInto(child);
      }
    }
    return text;
  };

  const emit = (node: JsxContainer) => {
    consumed.add(node);
    const children = jsxChildren(node);
    const isSentence = isSentenceContainer(node);

    if (isSentence) {
      push(flattenInto(node));
      return;
    }

    // Layout. Each element child starts its own claim; loose text between them
    // is a claim of its own rather than glue between two unrelated sentences.
    let buffer = "";
    const flush = () => {
      push(buffer);
      buffer = "";
    };

    for (const child of children) {
      if (ts.isJsxText(child)) {
        buffer += decodeEntities(child.text);
        continue;
      }
      if (ts.isJsxExpression(child)) {
        buffer += authoredExpressionText(child)?.text ?? " ";
        // An unresolved expression may still CONTAIN JSX (`{items.map(…)}`).
        // It is left for the file-wide sweep, which will emit it as its own
        // claim root.
        continue;
      }
      if (isJsxContainer(child)) {
        flush();
        emit(child);
      }
    }
    flush();
  };

  const isNonCopyAttributeValue = (node: ts.Node): boolean => {
    const parent = node.parent;
    return Boolean(parent && ts.isJsxAttribute(parent) && isNonCopyAttribute(parent));
  };

  const isModuleSpecifier = (node: ts.Node): boolean => {
    const parent = node.parent;
    return Boolean(
      parent &&
        ((ts.isImportDeclaration(parent) && parent.moduleSpecifier === node) ||
          (ts.isExportDeclaration(parent) && parent.moduleSpecifier === node) ||
          ts.isExternalModuleReference(parent) ||
          ts.isImportTypeNode(parent)),
    );
  };

  const sweep = (node: ts.Node) => {
    if (isJsxContainer(node) && !consumed.has(node)) emit(node);

    // A prop is where most of this site's sentences are authored, so copy
    // assembled inside one has to be reassembled too. `<Card title={"…append-"
    // + "only edit history"} />` emitted its two fragments independently and
    // neither tripped a rule, while the component rendered the joined claim.
    if (
      ts.isJsxAttribute(node) &&
      node.initializer &&
      ts.isJsxExpression(node.initializer) &&
      !isNonCopyAttribute(node)
    ) {
      const authored = node.initializer.expression
        ? readExpression(node.initializer.expression)
        : null;
      if (authored) push(authored.text);
    }

    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (!isModuleSpecifier(node) && !isNonCopyAttributeValue(node)) {
        push(node.text);
      }
    } else if (ts.isTemplateExpression(node)) {
      push(
        [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join(
          " ",
        ),
      );
    }

    ts.forEachChild(node, sweep);
  };
  sweep(sf);

  return claims;
}

/** Claims across a whole set of repo-relative sources, tagged with their file. */
export function claimsBySource(
  sources: string[],
): Array<{ file: string; claim: string }> {
  const out: Array<{ file: string; claim: string }> = [];
  for (const file of sources) {
    for (const claim of collectClaims(readSource(file), file)) {
      out.push({ file, claim });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 3. The rules: parsed FROM the register, not kept in parallel with it
// ---------------------------------------------------------------------------

export type ForbiddenWording = {
  readonly id: string;
  readonly source: string;
  readonly pattern: RegExp;
};

/**
 * The wordings §0.4 forbids, read out of the register itself.
 *
 * Review's objection to the earlier version was exact and correct: the guard
 * hard-coded a list of patterns, claimed to enforce §0.4, and did not match the
 * canonical sentence §0.4 actually rejects — so the register's own rejected
 * wording could have shipped green. A ruling and its enforcement cannot be two
 * documents. The register now carries a fenced `forbidden-public-wording`
 * block, and this is the only place the guard learns what is banned.
 */
export function forbiddenWordings(register: string): ForbiddenWording[] {
  const block = /```forbidden-public-wording\n([\s\S]*?)```/.exec(register);
  if (!block) {
    throw new Error(
      "the truth register carries no machine-readable `forbidden-public-wording` " +
        "block; §0.4's ruling would not be enforced by anything",
    );
  }
  const rules: ForbiddenWording[] = [];
  for (const raw of block[1].split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const split = line.indexOf("|");
    if (split < 0) {
      throw new Error(
        `malformed forbidden-wording rule (expected "<id> | <regex>"): ${line}`,
      );
    }
    const id = line.slice(0, split).trim();
    const source = line.slice(split + 1).trim();
    if (!id || !source) {
      throw new Error(`malformed forbidden-wording rule: ${line}`);
    }
    rules.push({ id, source, pattern: new RegExp(source, "i") });
  }
  if (rules.length === 0) {
    throw new Error("the forbidden-public-wording block declares no rules");
  }
  return rules;
}

/**
 * Every repository file §0 cites as evidence for a classification.
 *
 * Taken from the register's own backticked citations rather than a second list,
 * so a row that starts resting on a new file starts watching that file. These
 * are what "production has advanced and nothing this register rests on moved"
 * is a claim ABOUT — without them the staleness row is a date, not a check.
 */
export function citedEvidenceFiles(register: string): string[] {
  const operative = register.slice(
    register.indexOf("## 0. v2.2 copy-deck claim classification"),
  );
  const out = new Set<string>();
  for (const m of operative.matchAll(/`([^`\n]+)`/g)) {
    // Citations wrap lines in the source table, so a path can arrive with a
    // newline inside it; the register also cites directory globs.
    const token = m[1].replace(/\s+/g, "");
    const glob = token.endsWith("/**");
    const candidate = (glob ? token.slice(0, -3) : token)
      .replace(/[:#].*$/, "")
      .replace(/\/{2,}/g, "/")
      .replace(/\/$/, "");
    if (!/^[\w./@()[\]-]+$/.test(candidate)) continue;

    // EXISTENCE IS NOT THE TEST. Filtering citations through the working tree
    // dropped exactly the change the staleness check must catch: when
    // production deletes or renames a cited file, it is absent from a branch
    // carrying that change, so the old path fell out of the watch set and the
    // deletion `git diff` reports could never match anything. A citation is
    // therefore classified by SHAPE — a known source extension makes it a file,
    // whatever the working tree currently holds.
    //
    // Shape is how a DELETED path stays watched, and it cannot lean on an
    // extension list. §0's V13 row cites `.env.local.example`; a list of known
    // extensions drops it, and falling back to "does it exist" drops it again
    // the moment production deletes it — which is exactly the change the
    // comparison must report. So a FILE is recognised by the shape of its last
    // segment: a dotted name. That covers `expiry.ts`, `package.json` and
    // `.env.local.example` alike, and it survives deletion.
    //
    // The qualifier keeps §0's prose out. A dotted token with no path around it
    // could equally be a version or a measurement — `v2.2`, `13.56` — so a bare
    // dotted name counts only when it is a dotfile or actually exists.
    const isDir = isDirectory(candidate);
    const exists = existsSync(join(REPO_ROOT, candidate));
    const lastSegment = candidate.split("/").pop() ?? "";
    // A leading dot is enough on its own — `.env`, `.npmrc`, `.gitignore` are
    // whole filenames. Without the first alternative the optional dot was
    // consumed and a SECOND component was then required, so an ordinary dotfile
    // failed the shape test and a deleted one fell out of the watch set again.
    // Anything else needs a dot INSIDE it to count as a filename.
    const dotted = /^(?:\.[\w-]+(?:\.[\w-]+)*|[\w-]+(?:\.[\w-]+)+)$/.test(lastSegment);
    const looksLikeFile =
      dotted &&
      (candidate.includes("/") || lastSegment.startsWith(".") || (exists && !isDir));

    if (!glob && !looksLikeFile && !isDir) continue;

    if (glob || (!looksLikeFile && isDir)) {
      // A bare top-level directory is prose, not evidence. §0 says things like
      // "zero calls to billingPortal across `app/` + `lib/`" — treating that as
      // a watch root would red on essentially every production merge, which is
      // the failure this guard was built to avoid. A citation has to name
      // something narrower than a whole tree to count as evidence for a row.
      if (!candidate.includes("/")) continue;
      // Trailing slash marks a prefix match: `git diff --name-only` returns
      // `lib/record-keeping/expiry.ts`, never the bare directory, so reducing
      // `lib/record-keeping/**` to `lib/record-keeping` and comparing for
      // equality watched nothing at all.
      out.add(`${candidate}/`);
      continue;
    }
    out.add(candidate);
  }
  return [...out].sort();
}

const isDirectory = (rel: string): boolean => {
  try {
    return statSync(join(REPO_ROOT, rel)).isDirectory();
  } catch {
    return false;
  }
};

/**
 * Does a changed path fall under anything watched?
 *
 * Entries ending in `/` are directories and match by prefix; everything else is
 * an exact file. Equality alone silently watched no directory citation.
 */
export function isWatched(path: string, watched: Iterable<string>): boolean {
  for (const w of watched) {
    if (w.endsWith("/") ? path.startsWith(w) : path === w) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 4. The scoped-claim ruling (§0.4 N1)
// ---------------------------------------------------------------------------

/**
 * §0.4 N1. Migration 0086's trigger-written trail covers sterile items,
 * disinfectants, exposure incidents, the aftercare mark and
 * `session_blocks.probe_lot_number` — THAT COLUMN ONLY. Every other charted
 * value is a plain UPDATE through `update_block_with_entry` (0166) that keeps
 * no prior value.
 *
 * WHY THIS IS AN ALLOW-LIST
 * -------------------------
 * It was a deny-list: name a supported record type, and avoid an enumerated set
 * of widening terms. Review broke it with a conjunction — *"Energy settings and
 * sterile items have an append-only edit history"* passes, because `sterile
 * items` satisfies the scope and neither `energy` nor `settings` is in the
 * widening list, while energy edits keep no prior value at all. That is not a
 * missing term. No enumeration of the unsupported nouns can be complete, because
 * the unsupported set is every charted field the product has or will have.
 *
 * So the question is inverted: public copy may make an append-only claim only in
 * a wording §0.4 has sanctioned, and the sanctioned wordings live in the
 * register. Anything else is rejected whatever it says. That is deliberately
 * brittle — rephrasing a claim about what is audited SHOULD require going back
 * to the authority that classified it, which is the whole premise of §0.
 *
 * The two patterns below no longer gate public copy. They gate the ALLOW-LIST:
 * a sanctioned wording must still name a covered record type and must not
 * contain an obvious widening. They catch a careless register entry, not a
 * clever one — the register is a human ruling, and this cannot check the
 * classification, only its shape.
 */
export const SUPPORTED_APPEND_ONLY_SCOPE =
  /\b(sterile[- ]item|sterile items|disinfectant|exposure incident|probe lot|lot number|record[- ]keeping)\b/i;

export const APPEND_ONLY_OVERREACH =
  /\b(every (record|change|edit|treatment|field)|all (records|changes|edits|treatments)|treatment record|charting|chart(ed)? (value|field)|session|clinical)\b/i;

/** "append-only" and "append only" are the same promise to a reader. */
export const APPEND_ONLY_TRIGGER = /append[-\s]only/i;

export type SanctionedWording = { readonly id: string; readonly text: string };

/**
 * The append-only wordings §0.4 sanctions, read out of the register.
 *
 * Literal sentences, not patterns: a pattern would reintroduce exactly the
 * looseness this replaces.
 */
export function sanctionedAppendOnlyWordings(register: string): SanctionedWording[] {
  const block = /```supportable-append-only-wording\n([\s\S]*?)```/.exec(register);
  if (!block) {
    throw new Error(
      "the truth register carries no machine-readable " +
        "`supportable-append-only-wording` block; every append-only claim would " +
        "be rejected and §0.4's supportable form could not ship",
    );
  }
  const out: SanctionedWording[] = [];
  for (const raw of block[1].split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const split = line.indexOf("|");
    if (split < 0) {
      throw new Error(
        `malformed sanctioned-wording entry (expected "<id> | <sentence>"): ${line}`,
      );
    }
    const id = line.slice(0, split).trim();
    const text = normalise(line.slice(split + 1));
    if (!id || !text) throw new Error(`malformed sanctioned-wording entry: ${line}`);
    out.push({ id, text });
  }
  if (out.length === 0) {
    throw new Error("the supportable-append-only-wording block sanctions nothing");
  }
  return out;
}

export type AppendOnlyVerdict =
  | { readonly kind: "not-a-claim" }
  | { readonly kind: "sanctioned"; readonly id: string }
  | { readonly kind: "unsanctioned" };

export function judgeAppendOnlyClaim(
  claim: string,
  sanctioned: readonly SanctionedWording[],
): AppendOnlyVerdict {
  // Folded on both sides: `append‑only` with a non-breaking hyphen is the same
  // promise to a reader, and used to be classified `not-a-claim` — which sent
  // it past the allow-list AND past the forbidden patterns.
  const folded = foldForMatching(normalise(claim));
  if (!APPEND_ONLY_TRIGGER.test(folded)) return { kind: "not-a-claim" };
  const hit = sanctioned.find((s) => foldForMatching(s.text) === folded);
  return hit ? { kind: "sanctioned", id: hit.id } : { kind: "unsanctioned" };
}

// ---------------------------------------------------------------------------
// 5. Sentences this scan cannot reconstruct
// ---------------------------------------------------------------------------

/**
 * Scope-setting prose — words that change what a value dropped beside them
 * promises.
 *
 * Deliberately narrower than `APPEND_ONLY_OVERREACH`, which exists to judge a
 * WHOLE claim. This one judges a FRAGMENT sitting next to a hole, so it matches
 * only quantified scope ("every treatment record", "all edits") and the
 * record-keeps-history construction. `/resources` says *"on keeping good
 * treatment records and moving a practice off paper"* next to an unresolved
 * author name; that is true, harmless, and must stay sayable.
 */
export const SCOPE_SETTING_PROSE =
  /\b(every|all|each|any)\s+(?:[\w-]+\s+){0,2}(treatment\s+records?|clinical\s+records?|records?|changes?|edits?|fields?|sessions?|charts?)\b|\b(treatment|clinical|session)\s+records?\s+(keeps?|retains?|holds?|preserves?|has|have)\b/i;

export type UnreconstructableSentence = {
  readonly file: string;
  readonly prose: string;
  readonly expression: string;
};

/**
 * A forbidden rule, split into its top-level regex atoms.
 *
 * The first cut of this tried to EXPAND the rules into literal phrases. Codex
 * found the hole that approach cannot close: expansion has to stop at
 * `(?:[\w-]+ ){0,3}`, so every prefix reaching THROUGH the wildcard was lost,
 * and `"Treatment records keep their complete edit " + lastWord` — which renders
 * a sentence N1 matches — was compared only against the truncated opening. The
 * same pass also leaked regex syntax into supposed literals, because a group's
 * alternatives were taken verbatim: `keeps?` was treated as the word "keeps?".
 *
 * Atoms avoid both. An atom is one literal character, one group, or one
 * character class, together with any quantifier bound to it — so any RUN of
 * atoms is itself a valid regex, and the engine does the matching instead of an
 * enumerator that has to understand every construct. Nothing needs expanding,
 * nothing gets truncated, and a wildcard is just another atom.
 */
export function ruleAtoms(source: string): string[] {
  const atoms: string[] = [];
  let i = 0;
  while (i < source.length) {
    const start = i;
    const ch = source[i];
    if (ch === "\\") {
      i += 2;
    } else if (ch === "(") {
      let depth = 0;
      for (; i < source.length; i += 1) {
        if (source[i] === "\\") {
          i += 1;
          continue;
        }
        if (source[i] === "(") depth += 1;
        else if (source[i] === ")") {
          depth -= 1;
          if (depth === 0) {
            i += 1;
            break;
          }
        }
      }
    } else if (ch === "[") {
      i += 1;
      for (; i < source.length; i += 1) {
        if (source[i] === "\\") {
          i += 1;
          continue;
        }
        if (source[i] === "]") {
          i += 1;
          break;
        }
      }
    } else {
      i += 1;
    }
    while (i < source.length && "?*+".includes(source[i])) i += 1;
    if (source[i] === "{") {
      const close = source.indexOf("}", i);
      if (close > 0) i = close + 1;
    }
    atoms.push(source.slice(start, i));
  }
  return atoms;
}

/**
 * The shortest overlap that counts as "this half is starting a banned claim".
 *
 * Below this it is coincidence: almost any sentence ends in two letters that
 * also open some rule. At four characters, aligned to a word boundary, the
 * fragment is committing to the wording rather than brushing past it.
 */
const MIN_COMPLETION_OVERLAP = 4;

/** Does `overlap` sit at the start of a word within `text`? */
const overlapStartsAWord = (text: string, overlap: string): boolean => {
  const before = text.slice(0, text.length - overlap.length);
  return before === "" || /[^A-Za-z0-9]$/.test(before);
};

/** Does `overlap`, taken from the front of `text`, end on a word boundary? */
const overlapEndsAWord = (text: string, overlap: string): boolean => {
  const after = text.slice(overlap.length);
  return after === "" || /^[^A-Za-z0-9]/.test(after);
};

/**
 * Folded for comparison the way the rules themselves are matched.
 *
 * `foldForMatching` settles dashes and spaces but deliberately keeps case,
 * because the claim text it produces is also what gets reported. The rules are
 * compiled case-insensitively, so a comparison against them must lower too —
 * without this, "Edits kept as " never matched "edits kept as history" and the
 * whole completion test silently passed everything.
 */
const foldForCompletion = (text: string) => foldForMatching(text).toLowerCase();

type CompletionPatterns = {
  /** Openings of the rule, longest first, each anchored to the END of input. */
  readonly heads: readonly RegExp[];
  /** Endings of the rule, longest first, each anchored to the START of input. */
  readonly tails: readonly RegExp[];
};

/**
 * A group whose alternatives are plain words, as `(tracked|recorded|kept)` is.
 *
 * `(?:…)` is excluded by the `(?!\?)`, and any alternative carrying regex syntax
 * disqualifies the whole atom — this only ever reads groups that are literal.
 */
const LITERAL_GROUP_ATOM = /^\((?!\?)([^()]*)\)\??$/;

/**
 * `keeps?` is two words, and both of them are readable.
 *
 * Codex at `3d9c93f4`. Rejecting any alternative that carries a `?` threw away
 * the whole N1 verb group `(keeps?|retains?|holds?|preserves?|has|have)`, so
 * `"Treatment records ret" + ending` — which renders a sentence that rule
 * forbids — generated no head to match. An optional single character is the only
 * regex construct these alternatives use, and it expands to exactly two
 * branches, so it is expanded rather than refused.
 *
 * Anything richer still disqualifies the atom. This is a plural `s`, not an
 * expression language.
 */
const OPTIONAL_EXPANSION_CAP = 64;

function expandOptionalChars(alternative: string): string[] | null {
  let variants: string[] = [""];
  for (let i = 0; i < alternative.length; i += 1) {
    const ch = alternative[i];
    // A `?` reaching here is leading or doubled — not a quantifier this
    // understands.
    if (ch === "?" || /[\\+*{}[\]().^$|]/.test(ch)) return null;
    if (alternative[i + 1] === "?") {
      variants = variants.flatMap((v) => [v + ch, v]);
      i += 1;
    } else {
      variants = variants.map((v) => v + ch);
    }
    if (variants.length > OPTIONAL_EXPANSION_CAP) return null;
  }
  return [...new Set(variants)].filter(Boolean);
}

function literalAlternatives(atom: string): string[] | null {
  const match = LITERAL_GROUP_ATOM.exec(atom);
  if (!match) return null;
  const alternatives = match[1].split("|").filter(Boolean);
  if (alternatives.length === 0) return null;
  const expanded: string[] = [];
  for (const alternative of alternatives) {
    const branches = expandOptionalChars(alternative);
    if (!branches) return null;
    expanded.push(...branches);
  }
  return expanded.length > 0 ? [...new Set(expanded)] : null;
}

const escapeLiteral = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const alternationOf = (parts: string[]): string =>
  `(?:${[...new Set(parts)]
    .sort((a, b) => b.length - a.length)
    .map(escapeLiteral)
    .join("|")})`;

/**
 * A completion can land INSIDE a group, not only between atoms.
 *
 * Codex at `25179fd0`, and a genuine regression against the expansion this
 * replaced: treating `(tracked|recorded|kept|preserved)` as one indivisible atom
 * means the openings of the rule stop at `"every change is "`, so
 * `"Every change is rec" + ending` — which renders `"Every change is recorded"`
 * — matched nothing.
 *
 * Only groups whose alternatives are literal words get this. That is exactly
 * where a partial word is meaningful, and it keeps the wildcard atom whole,
 * which is what the previous round existed to fix.
 */
const partialHeadOf = (atom: string): string | null => {
  const alternatives = literalAlternatives(atom);
  if (!alternatives) return null;
  return alternationOf(
    alternatives.flatMap((alt) =>
      Array.from({ length: alt.length }, (_, i) => alt.slice(0, alt.length - i)),
    ),
  );
};

const partialTailOf = (atom: string): string | null => {
  const alternatives = literalAlternatives(atom);
  if (!alternatives) return null;
  return alternationOf(
    alternatives.flatMap((alt) =>
      Array.from({ length: alt.length }, (_, i) => alt.slice(i)),
    ),
  );
};

/**
 * Compiled once per rule. Every rule produces two patterns per atom boundary,
 * and this runs for every concatenation in every scanned file.
 */
const completionCache = new Map<string, CompletionPatterns>();

function completionPatterns(source: string): CompletionPatterns {
  const cached = completionCache.get(source);
  if (cached) return cached;
  const atoms = ruleAtoms(source);
  const heads: RegExp[] = [];
  const tails: RegExp[] = [];
  // A rule the splitter cannot cut cleanly must not take the whole guard down,
  // so a run that does not compile is skipped rather than thrown.
  const add = (into: RegExp[], pattern: string) => {
    try {
      into.push(new RegExp(pattern, "i"));
    } catch {
      /* skipped */
    }
  };

  // `k < atoms.length`: a run covering the WHOLE rule is a complete match, which
  // the rule's own pattern already catches. Only proper parts are completions.
  for (let k = atoms.length - 1; k >= 1; k -= 1) {
    add(heads, `(${atoms.slice(0, k).join("")})$`);
    add(tails, `^(${atoms.slice(atoms.length - k).join("")})`);
  }

  // And the boundaries INSIDE a literal-alternative group, which the atom split
  // would otherwise step straight over.
  for (let k = atoms.length - 1; k >= 0; k -= 1) {
    const head = partialHeadOf(atoms[k]);
    if (head) add(heads, `(${atoms.slice(0, k).join("")}${head})$`);
    const tail = partialTailOf(atoms[k]);
    if (tail) add(tails, `^(${tail}${atoms.slice(k + 1).join("")})`);
  }

  const patterns = { heads, tails };
  completionCache.set(source, patterns);
  return patterns;
}

export function couldCompleteForbidden(
  text: string,
  rules: readonly ForbiddenWording[],
): ForbiddenWording | null {
  const folded = foldForCompletion(text);
  if (!folded) return null;
  for (const rule of rules) {
    if (rule.pattern.test(folded)) continue; // a full match; already catchable
    const { heads, tails } = completionPatterns(rule.source);

    // Text BEFORE a hole: it ends with an opening of the rule, and the value
    // supplies the rest. Longest run first, so the reported rule is the one the
    // fragment commits to hardest rather than the first four letters that agree.
    for (const head of heads) {
      const match = head.exec(folded);
      if (
        match &&
        match[1].length >= MIN_COMPLETION_OVERLAP &&
        overlapStartsAWord(folded, match[1])
      ) {
        return rule;
      }
    }

    // Text AFTER a hole: it opens with an ending of the rule. The overlap must
    // be a whole word on BOTH sides — otherwise the four-letter tail "edit" of
    // "full history of every edit" matches the front of any sentence beginning
    // "edits…", which is every N1 phrase there is.
    for (const tail of tails) {
      const match = tail.exec(folded);
      if (
        match &&
        match[1].length >= MIN_COMPLETION_OVERLAP &&
        overlapEndsAWord(folded, match[1])
      ) {
        return rule;
      }
    }
  }
  return null;
}

/**
 * JSX containers that mix authored prose with a value this scan cannot resolve.
 *
 * Review's case: `<p>Every treatment record includes {it.body}</p>`. The
 * expression is a prop on a `.map` callback in a SHARED renderer — `it.body`'s
 * values live in whichever page passes `items`, so no amount of same-file
 * resolution reaches them. The literal is then scanned on its own, matches the
 * sanctioned wording, and passes; the prose becomes a separate claim with no
 * append-only trigger and passes too. A visitor reads the two joined together.
 *
 * Nothing static can reconstruct that sentence, so the guard forbids the
 * ambiguity instead of pretending to resolve it: prose that SETS SCOPE may not
 * sit next to a hole, and a sentence that is itself half an append-only promise
 * may not have a hole in it at all. Copy either says the whole thing in one
 * place, or holds the whole thing in one value.
 */
export function unreconstructableIn(
  src: string,
  file = "input.tsx",
  rules: readonly ForbiddenWording[] = [],
): UnreconstructableSentence[] {
  const sf = ts.createSourceFile(
    file,
    src,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const out: UnreconstructableSentence[] = [];
  // An expression can be reached twice — once as a JSX child or prop, once by
  // the whole-file sweep below. Report it once.
  const reported = new Set<ts.Node>();

  /**
   * Everything under this sentence, flattened the way a visitor receives it,
   * plus every expression that cannot be read.
   *
   * Direct children were not enough. Wrapping either half in ordinary inline
   * markup separated them — `<p><strong>Every treatment record</strong>
   * includes {it.body}</p>` left "includes" as the only direct prose, and
   * `<p>… <span>{it.body}</span></p>` left the hole in a child with no prose at
   * all. The prose and the hole have to be paired across the whole sentence,
   * exactly as `collectClaims` already flattens it.
   */
  const readSentence = (node: JsxContainer) => {
    let prose = "";
    const holes: ts.Expression[] = [];
    const spliced: ts.Expression[] = [];
    const walk = (n: JsxContainer) => {
      for (const child of jsxChildren(n)) {
        if (ts.isJsxText(child)) {
          prose += decodeEntities(child.text);
        } else if (ts.isJsxExpression(child)) {
          const authored = authoredExpressionText(child);
          prose += authored?.text ?? " ";
          // A template with substitutions gives up its static fragments and
          // swallows the rest, so it is BOTH text and a hole.
          if ((!authored || !authored.complete) && child.expression) {
            holes.push(child.expression);
            if (splicesIntoWords(authored)) spliced.push(child.expression);
          }
        } else if (isJsxContainer(child)) {
          walk(child);
        }
      }
    };
    walk(node);
    return { prose: normalise(prose), holes, spliced };
  };

  const emitFinding = (prose: string, hole: ts.Node) => {
    if (reported.has(hole)) return;
    reported.add(hole);
    out.push({ file, prose, expression: hole.getText().slice(0, 80) });
  };

  const report = (prose: string, hole: ts.Node) => {
    const folded = foldForMatching(prose);
    if (SCOPE_SETTING_PROSE.test(folded) || APPEND_ONLY_TRIGGER.test(folded)) {
      emitFinding(prose, hole);
    }
  };

  /**
   * An expression that SPLICES a value into the middle of authored words.
   *
   * `{"Energy settings have an append-" + (enabled ? "only edit history" : "")}`
   * defeats every check that reads the readable half alone: the fragment sets
   * no scope and carries no complete `append-only`, yet one branch renders an
   * unsanctioned claim. The trigger is assembled ACROSS the hole, so no amount
   * of pattern-matching on the visible part can see it.
   *
   * It is rejected on structure rather than content: authored words plus an
   * unreadable operand, inside one expression, cannot be judged. That is
   * narrower than "any incomplete expression" on purpose — `{`footer-group-${…}`}`
   * is an identifier being built, not a sentence being spliced, and a container
   * that renders `text {value}` as separate children is not splicing either.
   * The discriminator is that the readable part is MULTI-WORD, which is what
   * authored copy is and what an identifier fragment is not.
   */
  const splicesIntoWords = (authored: AuthoredExpression | null): boolean =>
    Boolean(authored && !authored.complete && /[A-Za-z]\s+\S*[A-Za-z]/.test(authored.text));

  /**
   * A prop can set a scope around a hole too.
   *
   * `<Card title={"Every treatment record has " + it.body} />` is the same
   * laundering one level over: the static half sets the scope, the value
   * supplies the promise, and nothing that looks only at JSX CHILDREN sees it.
   */
  const visitAttributes = (n: ts.Node) => {
    if (
      ts.isJsxAttribute(n) &&
      n.initializer &&
      ts.isJsxExpression(n.initializer) &&
      n.initializer.expression &&
      !isNonCopyAttribute(n)
    ) {
      const authored = readExpression(n.initializer.expression);
      if (splicesIntoWords(authored)) {
        emitFinding(normalise(authored!.text), n.initializer.expression);
      } else if (!authored || !authored.complete) {
        report(normalise(authored?.text ?? ""), n.initializer.expression);
      }
    }
  };

  const visit = (n: ts.Node) => {
    visitAttributes(n);
    if (isJsxContainer(n) && isSentenceContainer(n)) {
      const { prose, holes, spliced } = readSentence(n);
      // A splice cannot be judged at all, so it is reported on structure. A
      // plain hole is reported only when the prose around it sets a scope.
      if (spliced.length > 0) {
        emitFinding(prose, spliced[0]);
      } else if (holes.length > 0) {
        report(prose, holes[0]);
      }
      // A sentence is the unit for CHILDREN, but its descendants' attributes
      // still have to be checked.
      const descend = (x: ts.Node) => {
        visitAttributes(x);
        ts.forEachChild(x, descend);
      };
      ts.forEachChild(n, descend);
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);

  /**
   * The same laundering, ANYWHERE — including outside JSX entirely.
   *
   * Two holes the JSX-shaped checks above cannot see, both proven against this
   * scanner before this sweep existed:
   *
   *   A. `lib/marketing/content.ts` is a COPY MODULE, not a component. It is in
   *      `publicMarketingSources()` because a public route imports it, and its
   *      sentences ship. `{ line: "Edits kept as " + label }` has no JSX around
   *      it, so neither `visitAttributes` nor the sentence walk ever looked at
   *      it, and the page rendered "Edits kept as history" — N1 — scan green.
   *
   *   B. `splicesIntoWords` requires the readable half to be MULTI-WORD, which
   *      is right for telling authored prose from an identifier fragment but
   *      leaves a one-word opening uncovered. `{"never " + verb}` renders
   *      "never overwritten" — N1 — and read "never", which trips nothing.
   *
   * Both are the same shape: authored text that is a PROPER PREFIX of a banned
   * wording, with the hole sitting exactly where the rest of it goes. So the
   * discriminator is the rule set itself rather than another shape heuristic —
   * `couldCompleteForbidden` asks whether a value could finish a banned phrase,
   * which is precisely the property the register cares about, and is why
   * `className={"rounded-md border " + extra}` and `` `footer-group-${id}` ``
   * stay silent: nothing completes them into a claim.
   *
   * With no rules passed this sweep does nothing, so a caller that forgets them
   * gets the old behaviour rather than a false all-clear — which is why
   * `unreconstructableSentences` requires them.
   */
  if (rules.length > 0) {
    const sweepForCompletions = (n: ts.Node) => {
      const isConcat =
        ts.isBinaryExpression(n) &&
        n.operatorToken.kind === ts.SyntaxKind.PlusToken;
      if (isConcat || ts.isTemplateExpression(n)) {
        const authored = readExpression(n as ts.Expression);
        if (authored && !authored.complete) {
          const parent = n.parent;
          const inNonCopyAttribute =
            parent &&
            ts.isJsxExpression(parent) &&
            parent.parent &&
            ts.isJsxAttribute(parent.parent) &&
            isNonCopyAttribute(parent.parent);
          if (!inNonCopyAttribute && couldCompleteForbidden(authored.text, rules)) {
            emitFinding(normalise(authored.text), n);
          }
        }
      }
      ts.forEachChild(n, sweepForCompletions);
    };
    sweepForCompletions(sf);
  }

  return out;
}

export function unreconstructableSentences(
  sources: string[],
  rules: readonly ForbiddenWording[],
): UnreconstructableSentence[] {
  return sources.flatMap((file) =>
    unreconstructableIn(readSource(file), file, rules),
  );
}
