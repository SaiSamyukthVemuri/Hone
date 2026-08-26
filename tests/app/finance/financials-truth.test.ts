import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";

import { UNKNOWN_EXPLANATION, UNKNOWN_LABEL, PERMANENT_LINES } from "@/lib/finance/financial-copy";
import type { FinancialUnknownCause } from "@/lib/finance/financial-fact";

// ===========================================================================
// FIN-01A SLICE 1 — the source guard
// ===========================================================================
//
// Load-bearing negative controls. Each one names the wrong behaviour it
// forbids, so a future author cannot satisfy it by deleting the assertion.
//
// Comments are stripped before matching: several of these files DISCUSS the
// tables and the coercions they must never perform, and the discussion is the
// documentation. Only executable source is searched.

const ROOT = path.resolve(__dirname, "../../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const codeOnly = (src: string) =>
  src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const FILES = {
  fact: "lib/finance/financial-fact.ts",
  copy: "lib/finance/financial-copy.ts",
  model: "lib/finance/financial-briefing-model.ts",
  loader: "lib/finance/financial-briefing.ts",
  page: "app/(app)/financials/page.tsx",
  spine: "app/(app)/financials/financial-spine.tsx",
} as const;

const SOURCE = Object.fromEntries(
  Object.entries(FILES).map(([k, rel]) => [k, read(rel)]),
) as Record<keyof typeof FILES, string>;
const CODE = Object.fromEntries(
  Object.entries(SOURCE).map(([k, src]) => [k, codeOnly(src)]),
) as Record<keyof typeof FILES, string>;
const ALL_CODE = Object.values(CODE).join("\n");

const ALL_CAUSES: FinancialUnknownCause[] = [
  "not_recorded",
  "unavailable",
  "unknowable",
  "not_yet_supported",
  "not_enumerable",
];

// ---------------------------------------------------------------------------
// 1. No money arithmetic entered Slice 1
// ---------------------------------------------------------------------------

describe("NC1-3 — Slice 1 contains no money, from any of the three truth classes", () => {
  const LEDGERS = [
    // Hone-verified card money.
    "payment_charge_attempts",
    "charged_at",
    "refunded_at",
    "refund_status",
    "stripe_livemode",
    // Practitioner-attested disposition (migration 0187).
    "appointment_settlements",
    "amount_cents",
    "quoted_amount_cents",
    "paid_cash",
    "paid_e_transfer",
    "still_owes",
    // Service value.
    "price_cents",
    "price_paid_cents",
    // The dormant and legacy decoys, which must never be read by anything.
    "manual_fee_charge_attempts",
    "stripe_charge_attempts",
    "appointment_payments",
    "stripe_refunds",
    "stripe_refund_attempts",
  ];

  it.each(LEDGERS)("no executable reference to %s", (identifier) => {
    expect(ALL_CODE).not.toContain(identifier);
  });

  it("reads exactly ONE table, and it is appointments", () => {
    const tables = [...CODE.loader.matchAll(/\.from\((["'])([^"']+)\1\)/g)].map((m) => m[2]);
    expect(tables).toEqual(["appointments"]);
    expect(ALL_CODE.match(/\.from\(/g) ?? []).toHaveLength(1);
  });

  it("selects only the status column — no amount, no price, no join", () => {
    expect(CODE.loader).toContain('.select("status", { count: "exact" })');
  });
});

// ---------------------------------------------------------------------------
// 2. UNKNOWN cannot become zero
// ---------------------------------------------------------------------------

describe("NC4/NC9 — an absence has no coercion route to a number", () => {
  it("there is no valueOr / getOrElse / unwrapOr helper anywhere", () => {
    // A coercion helper is the single mechanism by which "we could not read
    // this" becomes "$0.00", and once it exists somebody reaches for it.
    expect(ALL_CODE).not.toMatch(/\b(valueOr|getOrElse|unwrapOr|orZero|orDefault)\b/);
  });

  it("no fact is defaulted with ?? or || to a number or a currency string", () => {
    expect(ALL_CODE).not.toMatch(/\.value\s*(\?\?|\|\|)/);
    expect(ALL_CODE).not.toMatch(/(\?\?|\|\|)\s*["'`]\$?0/);
    // The I/O and render paths — where a Fact is in scope — carry no numeric
    // default at all. The rule is narrowed to them deliberately: a blanket ban
    // would also forbid the census counter below, which is a legitimate zero.
    for (const key of ["loader", "spine", "page", "fact", "copy"] as const) {
      expect(CODE[key], key).not.toMatch(/(\?\?|\|\|)\s*0\b/);
    }
  });

  it("the model's ONLY zero-default is the census counter, which is a real zero", () => {
    // `byStatus.get(status) ?? 0` means "this status had no rows in a read that
    // succeeded". That is `known(0)`, not a coerced unknown — and it is the one
    // place a literal zero may be written in the slice.
    const defaults = [...CODE.model.matchAll(/[^\n]*(\?\?|\|\|)\s*0\b[^\n]*/g)].map((m) =>
      m[0].trim(),
    );
    expect(defaults).toEqual([
      "byStatus.set(row.status, (byStatus.get(row.status) ?? 0) + 1);",
      "const count = (status: AppointmentStatusName) => known(byStatus.get(status) ?? 0);",
    ]);
  });

  it("no figure is rendered as a bare dash or an em dash placeholder", () => {
    expect(CODE.spine).not.toMatch(/>\s*[-—–]\s*</);
  });

  it("the render path narrows the union rather than reading .value unguarded", () => {
    // Every read of `.value` in the spine sits behind a `.known` check.
    expect(CODE.spine).toMatch(/if \(!fact\.known\) return <Unknown cause=\{fact\.cause\} \/>;/);
    expect(CODE.spine).toMatch(/calendar\.completed\.known \?/);
  });
});

// ---------------------------------------------------------------------------
// 3. The five causes stay five
// ---------------------------------------------------------------------------

describe("NC7/NC8 — the causes are not collapsed at the render boundary", () => {
  it("every cause has its own label, explanation and SHAPE", () => {
    for (const cause of ALL_CAUSES) {
      expect(UNKNOWN_LABEL[cause]).toBeTruthy();
      expect(UNKNOWN_EXPLANATION[cause]).toBeTruthy();
      // Colour is never the only channel: the mark map is exhaustive.
      expect(CODE.spine).toContain(`${cause}:`);
    }
  });

  it("no shared 'Not available' fallback survives anywhere", () => {
    expect(ALL_CODE).not.toMatch(/Not available/i);
  });

  it("the permanent framing lines are all rendered", () => {
    expect(CODE.spine).toContain("PERMANENT_LINES");
    expect(PERMANENT_LINES).toHaveLength(3);
    for (const line of PERMANENT_LINES) expect(line.length).toBeGreaterThan(40);
  });

  it("asserts no apply date for the historical boundary", () => {
    // docs/production/migration-state.json records 0187 with
    // hosted_applied_at: null and states no server apply instant was captured.
    // Printing one to an owner would claim precision the canonical record
    // explicitly declines to claim.
    expect(SOURCE.copy).not.toMatch(/\b20\d\d-\d\d-\d\d\b/);
    expect(CODE.copy).not.toMatch(/\b(August|September|October)\b/);
  });
});

// ---------------------------------------------------------------------------
// 4. Authority
// ---------------------------------------------------------------------------

describe("NC-auth — the gate precedes the read, and claims no more than it is", () => {
  it("the role refusal is the FIRST statement of the loader", () => {
    // Not merely present: first. A read issued before the check is an aggregate
    // payload a practitioner caused, whatever the page then renders.
    expect(CODE.loader).toMatch(
      /Promise<FinancialsView>\s*\{\s*if \(practitioner\.role !== "owner"\) return \{ access: "refused" \};/,
    );
  });

  it("the page refuses before it renders the spine", () => {
    const refusal = CODE.page.indexOf('view.access === "refused"');
    const spine = CODE.page.indexOf("<FinancialSpine");
    expect(refusal).toBeGreaterThan(-1);
    expect(spine).toBeGreaterThan(refusal);
  });

  it("does not describe itself as a database boundary", () => {
    const claims = /owner-only (data|database|row) boundary|RLS[^.]{0,40}owner/i;
    expect(SOURCE.loader).not.toMatch(claims);
    expect(SOURCE.page).not.toMatch(claims);
  });

  it("states in source that the gate is application-layer only", () => {
    // Prose wraps across comment lines, so strip the markers before matching.
    const prose = SOURCE.loader.replace(/^\s*(\/\/|\*)/gm, " ").replace(/\s+/g, " ");
    expect(prose).toMatch(/is_studio_member/);
    expect(prose).toMatch(/NOT a database boundary/i);
    expect(prose).toMatch(/decides who is SHOWN the aggregate/i);
  });

  it("financial truth is never cached", () => {
    expect(CODE.page).toContain('export const dynamic = "force-dynamic"');
  });
});

// ---------------------------------------------------------------------------
// 5. Read-only
// ---------------------------------------------------------------------------

describe("NC-readonly — no mutation, no RPC, no schema", () => {
  it.each([".insert(", ".update(", ".delete(", ".upsert(", ".rpc("])(
    "no %s anywhere in the slice",
    (verb) => {
      expect(ALL_CODE).not.toContain(verb);
    },
  );

  it("no migration, trigger or policy text is introduced by the slice", () => {
    expect(ALL_CODE).not.toMatch(/create (table|policy|index|function)/i);
  });
});

// ---------------------------------------------------------------------------
// 6. Responsive and accessible
// ---------------------------------------------------------------------------

describe("NC-mobile/a11y — order carries the meaning, colour never does", () => {
  it("the provenance chain cannot be re-sequenced by a viewport", () => {
    // No grid, no CSS ordering, no reversal: stacking a single column cannot
    // change the reading order of calendar -> anchor -> what became of it.
    expect(CODE.spine).not.toMatch(/\border-\d/);
    expect(CODE.spine).not.toMatch(/\b(flex-row-reverse|flex-col-reverse)\b/);
    expect(CODE.spine).not.toMatch(/\bgrid-cols-/);
  });

  it("renders the sections in the frozen Direction B order", () => {
    const order = [
      "The calendar",
      "Work actually completed",
      "Where the completed work went",
      "Money in this period",
    ].map((heading) => CODE.spine.indexOf(heading));
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("nothing is pinned to a fixed pixel width that could overflow a phone", () => {
    expect(CODE.spine).not.toMatch(/(?<![\w-])w-\[\d+px\]/);
    expect(CODE.spine).toContain("max-w-[920px]");
    // Flex children that hold prose declare min-w-0, or a long word forces the
    // row wider than the viewport instead of wrapping.
    expect(CODE.spine).toContain("min-w-0");
  });

  it("headings are real headings, not styled captions", () => {
    const h2s = CODE.spine.match(/<SectionLabel as="h2">/g) ?? [];
    expect(h2s.length).toBeGreaterThanOrEqual(4);
    expect((CODE.spine.match(/<h1/g) ?? []).length).toBe(1);
  });

  it("load-bearing financial explanation never rides on muted-over-sunken", () => {
    // Measured 4.54:1 — it clears AA by 0.04. Captions may use it; sentences
    // that carry the meaning of a missing figure may not.
    for (const [name, code] of Object.entries(CODE)) {
      for (const line of code.split("\n")) {
        const bad = line.includes("text-fg-muted") && line.includes("bg-surface-sunken");
        expect(bad, `${name}: ${line.trim()}`).toBe(false);
      }
    }
  });

  it("every decorative mark is hidden from assistive technology and paired with text", () => {
    expect(CODE.spine).toContain('aria-hidden="true"');
    expect(CODE.spine).toContain("UNKNOWN_LABEL[cause]");
  });

  it("the active period is announced, not only painted", () => {
    expect(CODE.spine).toMatch(/aria-current=\{active \? "page" : undefined\}/);
  });
});

// ---------------------------------------------------------------------------
// 7. Slice boundary
// ---------------------------------------------------------------------------

describe("NC-scope — the later slices are absent, and say so", () => {
  it("names both unbuilt sections in a sentence rather than a zero", () => {
    expect(CODE.spine).toContain("DISPOSITION_CHAIN_NOT_YET");
    expect(CODE.spine).toContain("MONEY_BRIDGES_NOT_YET");
    expect(CODE.spine).toContain('<Unknown cause="not_yet_supported" />');
  });

  it("does not register or advertise the route", () => {
    // The nav landing is its own slice. This PR must not add a NAV_ENTRIES row.
    const registry = read("lib/search/navigation-registry.ts");
    expect(registry).toContain('route: "/financials"');
    const navEntries = registry.slice(0, registry.indexOf("NON_SEARCHABLE_ROUTES"));
    expect(navEntries).not.toContain("/financials");
  });
});

// ---------------------------------------------------------------------------
// 8. Reachability — the boundary the leaf scan above could not prove
// ---------------------------------------------------------------------------
//
// Everything above scans six enumerated leaf files and never follows an import.
// Codex raised that on PR #646 as a P2 and it was right: FIN imported its period
// helpers from lib/dashboard/practice-metrics.ts, whose executable module also
// reads `services(price_cents)` and queries `payment_charge_attempts`, so a
// forbidden path was reachable while every assertion above stayed green.
//
// This block closes that gap with the smallest mechanism that actually proves
// the claim: walk FIN Slice 1's static import graph and scan everything it
// reaches. Deliberately NOT a general dependency framework — no cycle
// reporting, no visualiser, no config. One walk, one scan, four assertions.
//
// TYPE IMPORTS ARE FOLLOWED TOO. `import type` erases at runtime, so following
// it is stricter than the runtime graph — on purpose. The contract is about
// what this surface is COUPLED to, and `financial-spine.tsx` reached the money
// module through a type-only import alone.

const resolveImport = (spec: string, fromFile: string): string | null => {
  let base: string;
  if (spec.startsWith("@/")) base = path.join(ROOT, spec.slice(2));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(fromFile), spec);
  else return null; // a node_modules package: not our source, not our contract
  for (const c of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")]) {
    try {
      if (statSync(c).isFile()) return c;
    } catch {
      /* not this candidate */
    }
  }
  return null;
};

/**
 * EVERY module specifier a source text statically depends on, read from the
 * TypeScript AST rather than matched by regex.
 *
 * This replaced a regex that recognised only `import … from "x"` and
 * `import("x")`. Codex raised the gap on PR #646 as a P2 and it was right: a
 * SIDE-EFFECT import — `import "@/lib/dashboard/practice-metrics";` — has a
 * module specifier but no import clause and therefore no `from`, so the regex
 * skipped the edge entirely. The module executed at runtime while never
 * entering CLOSURE, and every reachability assertion below stayed green.
 * Reproduced before the fix, and it is now a control in the table below.
 *
 * Codex then raised the SAME failure a second time in a different spelling:
 * `require("@/lib/dashboard/practice-metrics")`. That is a CallExpression whose
 * callee is the identifier `require` — not the `ImportKeyword` the dynamic
 * import branch tests for, and not a declaration at all — so an AST walk built
 * only out of import and export declarations skipped the edge while the module
 * still executed. Reproduced the same way before this fix: appended to a FIN
 * entry file, all 55 assertions stayed green.
 *
 * Every executable literal module reference is now covered by construction, and
 * each shape is pinned individually in MODULE_REFERENCE_SHAPES:
 *
 *   import x from "m"        import { a } from "m"       import * as ns from "m"
 *   import "m"               import type { T } from "m"  export { a } from "m"
 *   export * from "m"        export * as ns from "m"     import("m")
 *   import x = require("m")  require("m")                import("m").T
 *
 * `isStringLiteralLike` rather than `isStringLiteral`, because the backtick
 * forms of `require` and `import` are NoSubstitutionTemplateLiterals and every
 * bit as executable.
 *
 * TYPE-ONLY EDGES REMAIN EDGES, exactly as the block comment above declares:
 * following them is deliberately STRICTER than the runtime graph, because the
 * contract is about what this surface is COUPLED to. `import("m")` in type
 * position is that same edge spelled as an ImportTypeNode, so it is followed
 * for the same reason rather than becoming the next way out.
 *
 * PARSED FROM RAW SOURCE, not from `codeOnly`. The compiler already knows what
 * a comment is, so a commented-out import is correctly NOT an edge — and
 * stripping first would only risk corrupting what it reads. The identifier scan
 * still uses `codeOnly`, because these files legitimately DISCUSS the tables
 * they must never reach.
 */
function specifiersOfSource(source: string, fileName: string): string[] {
  const sf = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const specs: string[] = [];
  const take = (node: ts.Node | undefined) => {
    if (node && ts.isStringLiteralLike(node)) specs.push(node.text);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      // Side-effect imports land here too: no importClause, but a specifier.
      take(node.moduleSpecifier);
    } else if (ts.isExportDeclaration(node)) {
      // Covers `export * as ns from "m"`, which the scanner-based cross-check
      // below does not report at all — one reason the AST stays the authority.
      take(node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      take(node.moduleReference.expression);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      take(node.argument.literal);
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        // `import("m")` — the callee is a keyword, not an identifier.
        take(node.arguments[0]);
      } else if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
        // `require("m")` — executable CommonJS, and the gap this repair closes.
        take(node.arguments[0]);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return specs;
}

/** The same extraction, for a file on disk. */
function moduleSpecifiers(file: string): string[] {
  return specifiersOfSource(readFileSync(file, "utf8"), file);
}

/**
 * The same question asked by a DIFFERENT implementation: TypeScript's own
 * scanner-based preprocessor, which this repo already uses for exactly this job
 * in tests/source-guards/self-hosted-fonts-guards.test.ts. It replaces a crude
 * `^\s*import\s` line count that was itself blind to `require` — the very shape
 * this repair is about — and so could never have caught it.
 *
 * It is the CROSS-CHECK and not the extractor, because measurement puts it
 * wrong in both directions:
 *
 *   - it does not report `export * as ns from "m"` at all; and
 *   - having no JSX mode, it scans JSX TEXT as code, so prose reading
 *     `<p>you must import "x" first</p>` is reported as an edge — and both
 *     entry components here are prose about the tables they must never read.
 *
 * Resolving each specifier against the repo discards the invented ones, which
 * name no file, and keeps every real one. That makes it a sound LOWER BOUND on
 * the walker: whatever it can resolve, the walker must also have found.
 */
function independentSpecifiers(file: string): string[] {
  return ts
    .preProcessFile(readFileSync(file, "utf8"), /* readImportFiles */ true, /* detectJs */ true)
    .importedFiles.map((f) => f.fileName);
}

/** Specifiers that resolve to a file inside this repo, deduplicated. */
function resolvedEdges(specs: readonly string[], fromFile: string): string[] {
  const out = new Set<string>();
  for (const spec of specs) {
    const target = resolveImport(spec, fromFile);
    if (target) out.add(target);
  }
  return [...out];
}

/**
 * file -> the importer that first reached it, so a failure names a chain.
 *
 * `specifiersOf` is injectable for ONE reason: the traversal itself has to be
 * provable. Recognising a `require` specifier and enqueuing its target are two
 * different things, and a walker that did the first but not the second would
 * satisfy every shape assertion while the chain behind it still executed.
 * Production callers take the default and read from disk.
 */
function walkFrom(
  entries: readonly string[],
  specifiersOf: (file: string) => string[] = moduleSpecifiers,
): Map<string, string | null> {
  const reached = new Map<string, string | null>();
  const queue: Array<[string, string | null]> = entries.map((e) => [path.join(ROOT, e), null]);
  while (queue.length > 0) {
    const [file, via] = queue.shift()!;
    if (reached.has(file)) continue;
    reached.set(file, via);
    for (const spec of specifiersOf(file)) {
      const target = resolveImport(spec, file);
      if (target && !reached.has(target)) queue.push([target, path.relative(ROOT, file)]);
    }
  }
  return reached;
}

const FIN_ENTRIES = Object.values(FILES);
const CLOSURE = walkFrom(FIN_ENTRIES);
const CLOSURE_REL = [...CLOSURE.keys()].map((f) => path.relative(ROOT, f)).sort();

/**
 * The FIN-01A truth contract's banned identifiers, as *reachability* rules.
 * Service value, practitioner-attested settlement and Hone-verified money — the
 * three classes Slice 1 answers none of — plus the dormant and legacy decoys.
 */
const FORBIDDEN_ON_THE_PATH = [
  "price_cents",
  "price_paid_cents",
  "quoted_amount_cents",
  "amount_cents",
  "payment_charge_attempts",
  "appointment_settlements",
  "manual_fee_charge_attempts",
  "stripe_charge_attempts",
  "appointment_payments",
  "stripe_refunds",
  "stripe_refund_attempts",
  "charged_at",
  "refunded_at",
  "refund_status",
  "stripe_livemode",
  "inferStripeLivemode",
];

/**
 * ONE exemption, and it is narrow enough to state in a sentence: a module that
 * only DECLARES the shape of a row names its columns, and naming a column is
 * not reading one. `lib/types/database.ts` is where `Studio` lives.
 *
 * The exemption is not taken on trust — the assertion below proves the file
 * still cannot execute a read. If someone puts a query in it, the exemption
 * fails rather than silently widening.
 */
const TYPE_DECLARATION_ONLY = new Set(["lib/types/database.ts"]);

/**
 * Every shape of module reference the extractor must see, with the answer
 * WRITTEN DOWN rather than computed.
 *
 * This table is the one check in the file that cannot go blind alongside the
 * walker. Everything else in this block asks the extractor about the extractor:
 * CLOSURE IS CLOSED walks the graph with the same function that built it, so a
 * shape it cannot see is absent from both sides and the assertion passes while
 * the module executes. That is not hypothetical — it is exactly how the
 * side-effect gap shipped, and then how `require` shipped after it.
 *
 * `.ts` and `.tsx` are both exercised: the entry components are TSX, and
 * ScriptKind changes how the source is parsed.
 */
const MODULE_REFERENCE_SHAPES: ReadonlyArray<readonly [string, string, string[]]> = [
  // Executable ES module references.
  ["default import", 'import x from "m";', ["m"]],
  ["named import", 'import { a } from "m";', ["m"]],
  ["namespace import", 'import * as ns from "m";', ["m"]],
  ["side-effect import", 'import "m";', ["m"]],
  ["export-from", 'export { a } from "m";', ["m"]],
  ["export-star", 'export * from "m";', ["m"]],
  ["export-star-as", 'export * as ns from "m";', ["m"]],
  ["dynamic import", 'const p = import("m");', ["m"]],
  ["awaited dynamic import", 'async function f() { await import("m"); }', ["m"]],
  // Executable CommonJS — the shape this repair added.
  ["require", 'const r = require("m");', ["m"]],
  ["require, member-accessed", 'const r = require("m").thing;', ["m"]],
  ["require, nested in a branch", 'function f() { if (x) { require("m"); } }', ["m"]],
  ["require, template literal", "const r = require(`m`);", ["m"]],
  ["import-equals-require", 'import x = require("m");', ["m"]],
  // Type-only edges are followed too, deliberately: see the block comment above.
  ["import type", 'import type { T } from "m";', ["m"]],
  ["inline type specifier", 'import { type T } from "m";', ["m"]],
  ["export type from", 'export type { T } from "m";', ["m"]],
  ["import type position", 'type X = import("m").Y;', ["m"]],
  // ...and what must NOT become an edge.
  ["line-commented import", '// import "m";', []],
  ["block-commented require", '/* const r = require("m"); */', []],
  ["a string that spells one", `const s = 'require("m")';`, []],
  ["a require on another object", 'const r = obj.require("m");', []],
  ["a non-literal require", 'const r = require(dynamicName);', []],
];

describe("NC-reach — the extractor sees every executable module reference", () => {
  it.each(MODULE_REFERENCE_SHAPES)("%s", (_name, source, expected) => {
    expect(specifiersOfSource(source, path.join(ROOT, "probe.ts"))).toEqual(expected);
    expect(specifiersOfSource(source, path.join(ROOT, "probe.tsx"))).toEqual(expected);
  });

  it("THE ESCAPE ITSELF: a require of the money module resolves to the money module", () => {
    // Not a shape in the abstract. This is the exact line that, appended to a
    // FIN entry file before this repair, executed lib/dashboard/practice-metrics
    // — a `services(price_cents)` read and a payment_charge_attempts query —
    // while all 55 assertions in this file stayed green.
    const entry = path.join(ROOT, FILES.model);
    const specs = specifiersOfSource('require("@/lib/dashboard/practice-metrics");', entry);
    expect(specs).toEqual(["@/lib/dashboard/practice-metrics"]);

    const resolved = resolveImport(specs[0], entry);
    expect(resolved).not.toBeNull();
    expect(path.relative(ROOT, resolved ?? "")).toBe("lib/dashboard/practice-metrics.ts");

    // ...and the module it reaches is genuinely a money path, so the control is
    // not a rehearsal against an innocent file that would prove nothing.
    const money = codeOnly(read("lib/dashboard/practice-metrics.ts"));
    expect(FORBIDDEN_ON_THE_PATH.filter((id) => money.includes(id))).not.toEqual([]);
  });

  it("a require edge is walked TRANSITIVELY, not just recognised at the entry", () => {
    // Recognising a specifier is half the job: the queue must also FOLLOW it.
    // A walker that saw `require` but never enqueued its target would satisfy
    // every shape above while the whole chain behind it still executed.
    //
    // Real files as nodes so resolution is real, synthetic edges so the thing
    // under test is the traversal and not what any file happens to import.
    const CHAIN: Record<string, string> = {
      [FILES.model]: 'require("@/lib/finance/financial-copy");',
      "lib/finance/financial-copy.ts": 'require("@/lib/dashboard/practice-metrics");',
    };
    const reached = walkFrom([FILES.model], (file) =>
      specifiersOfSource(CHAIN[path.relative(ROOT, file)] ?? "", file),
    );
    expect([...reached.keys()].map((f) => path.relative(ROOT, f))).toEqual([
      FILES.model,
      "lib/finance/financial-copy.ts",
      "lib/dashboard/practice-metrics.ts",
    ]);
  });
});

describe("NC-reach — no money path is reachable from FIN Slice 1, transitively", () => {
  it("ANTI-VACUITY: the walk actually resolved a real graph", () => {
    // A walker that silently resolves nothing would pass every assertion below.
    expect(CLOSURE.size).toBeGreaterThanOrEqual(12);
    expect(CLOSURE_REL).toContain("lib/booking/reporting-period.ts");
    expect(CLOSURE_REL).toContain("lib/booking/tz.ts");
    expect(CLOSURE_REL).toContain("lib/supabase/queries.ts");
    expect(CLOSURE_REL).toContain("lib/types/database.ts");
  });

  it("ANTI-BLINDNESS: a second, independent extractor finds no edge the walker missed", () => {
    // The side-effect gap was invisible precisely because nothing compared the
    // extractor against a second method — the graph stayed populated, so every
    // other assertion still passed while an edge vanished. `require` was the
    // same failure a second time, and the old cross-check here was a line count
    // that could not see `require` either, so it agreed with the blindness.
    //
    // Compared on RESOLVED in-repo edges, which is the only thing reachability
    // is about, and which discards the specifiers the scanner invents out of
    // JSX prose because they name no file.
    const blind: string[] = [];
    let independentEdges = 0;
    for (const file of CLOSURE.keys()) {
      const walked = new Set(resolvedEdges(moduleSpecifiers(file), file));
      for (const spec of independentSpecifiers(file)) {
        const target = resolveImport(spec, file);
        if (!target) continue;
        independentEdges += 1;
        if (!walked.has(target)) {
          blind.push(`${path.relative(ROOT, file)} -> ${spec}: walker did not see this edge`);
        }
      }
    }
    expect(blind).toEqual([]);
    // ...and the cross-check is not itself asleep: a method that resolved
    // nothing would agree with any extractor, however blind. It must find at
    // least one edge per non-entry file, or it never discovered this graph.
    expect(independentEdges).toBeGreaterThanOrEqual(CLOSURE.size - FIN_ENTRIES.length);
  });

  it("CLOSURE IS CLOSED: every in-repo edge of a reached file is itself reached", () => {
    const escaped: string[] = [];
    for (const file of CLOSURE.keys()) {
      for (const spec of moduleSpecifiers(file)) {
        const target = resolveImport(spec, file);
        if (target && !CLOSURE.has(target)) {
          escaped.push(`${path.relative(ROOT, file)} -> ${spec}`);
        }
      }
    }
    expect(escaped).toEqual([]);
  });

  it("THE P2 ITSELF: the money module is not reachable from /financials", () => {
    expect(CLOSURE_REL).not.toContain("lib/dashboard/practice-metrics.ts");
    expect(CLOSURE_REL.filter((f) => f.startsWith("lib/dashboard/"))).toEqual([]);
  });

  it("no module on the reachable path contains a forbidden identifier", () => {
    const offences: string[] = [];
    for (const [file, via] of CLOSURE) {
      const rel = path.relative(ROOT, file);
      if (TYPE_DECLARATION_ONLY.has(rel)) continue;
      const code = codeOnly(readFileSync(file, "utf8"));
      for (const id of FORBIDDEN_ON_THE_PATH) {
        if (code.includes(id)) offences.push(`${rel} contains "${id}" (reached via ${via ?? "entry point"})`);
      }
    }
    expect(offences).toEqual([]);
  });

  it("the type-declaration exemption cannot hide a read", () => {
    for (const rel of TYPE_DECLARATION_ONLY) {
      const code = codeOnly(readFileSync(path.join(ROOT, rel), "utf8"));
      // No client, no query, no RPC: it declares shapes and nothing else.
      expect(code, rel).not.toMatch(/\.from\(|\.rpc\(|createClient|supabase/i);
      // Every import it makes is type-only, so it drags no runtime module in.
      for (const line of code.split("\n")) {
        if (/^\s*import\s/.test(line)) expect(line, `${rel}: ${line.trim()}`).toMatch(/^\s*import type\s/);
      }
    }
  });
});
