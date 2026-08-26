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
 * ESM ONLY, and that is the contract rather than a limitation — see
 * `commonJsViolations` below for why CommonJS is not analysed here at all.
 *
 * This replaced a regex that recognised only `import … from "x"` and
 * `import("x")`. Codex raised the gap on PR #646 as a P2 and it was right: a
 * SIDE-EFFECT import — `import "@/lib/dashboard/practice-metrics";` — has a
 * module specifier but no import clause and therefore no `from`, so the regex
 * skipped the edge entirely. The module executed at runtime while never
 * entering CLOSURE, and every reachability assertion below stayed green.
 * Reproduced before the fix, and it is now a control in the table below.
 *
 * Covered by construction, and pinned shape by shape in MODULE_REFERENCE_SHAPES:
 *
 *   import x from "m"        import { a } from "m"       import * as ns from "m"
 *   import "m"               import type { T } from "m"  export { a } from "m"
 *   export * from "m"        export * as ns from "m"     import("m")
 *   import x = require("m")  import("m").T
 *
 * `import x = require("m")` is a DECLARATION with a literal specifier, not an
 * executable `require` expression, so it is an edge here and is separately
 * forbidden as CommonJS below. Both are true and neither is redundant.
 *
 * `isStringLiteralLike` rather than `isStringLiteral`, because the backtick
 * form of `import()` is a NoSubstitutionTemplateLiteral and every bit as
 * executable.
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
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      // `import("m")` — the callee is a keyword, not an identifier, and it
      // needs no normalisation: `(import)("m")` is a PARSE ERROR, measured, so
      // no wrapped spelling of it can execute.
      take(node.arguments[0]);
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
 * Executable CommonJS loading anywhere in a FIN module. Its PRESENCE is the
 * violation; which module it would load is never asked.
 *
 * WHY THE QUESTION CHANGED. Four repairs in a row tried to answer "does this
 * expression load a module?" for CommonJS, and Codex defeated each one with a
 * new spelling: `require`, then `(require)`, then
 * `((require as <T>(id: string) => T)<any>)`, then
 * `(flag ? require : require)`. The first three were semantically TRANSPARENT
 * wrappers and reading the emitted output did close that class. The fourth is
 * not a wrapper at all — a conditional genuinely changes what is called, and it
 * escapes anyway because BOTH branches happen to be `require`. Following that
 * further means deciding which JavaScript expressions can evaluate to `require`,
 * which is writing an evaluator, and FIN Slice 1 does not need one.
 *
 * So the contract changed instead: THE FIN CLOSURE IS ESM-ONLY. Dependencies
 * must be expressed in the import and export forms the walker above already
 * understands. Any executable CommonJS in a reached module is forbidden
 * outright, which makes the unanswerable question irrelevant — the escape is
 * rejected BEFORE anyone asks what it loads. `(flag ? require : require)("x")`
 * is red because `require` is there, not because we worked out what it does.
 *
 * This is only safe because it is true today: the closure was audited before
 * the rule was imposed and contains no CommonJS at all, so nothing legitimate
 * is being outlawed. If a FIN module ever genuinely needs CommonJS, that is a
 * decision to take deliberately, not something to smuggle past a guard.
 *
 * VALUE POSITION ONLY. `require` inside a type — `NodeRequire`, or a parameter
 * typed `typeof require` — declares a shape and loads nothing, and the same
 * word in a string or a comment is not code at all. The AST separates those
 * three from an executable reference; a text scan could not.
 */
function commonJsViolations(source: string, fileName: string): string[] {
  const sf = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const violations: string[] = [];
  const report = (node: ts.Node, what: string) => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    violations.push(`line ${line + 1}: ${what}`);
  };

  /**
   * True when this identifier is only NAMING something — a binding being
   * declared, or an object key — rather than referring to the loader.
   *
   * `{ require }` shorthand is deliberately NOT here: that reads the value.
   */
  const isJustAName = (node: ts.Identifier): boolean => {
    const parent = node.parent;
    if (!parent) return false;
    if (ts.isPropertyAccessExpression(parent) && parent.name === node) return true;
    if (ts.isQualifiedName(parent) && parent.right === node) return true;
    return (
      (ts.isVariableDeclaration(parent) ||
        ts.isParameter(parent) ||
        ts.isFunctionDeclaration(parent) ||
        ts.isPropertyAssignment(parent) ||
        ts.isPropertyDeclaration(parent) ||
        ts.isPropertySignature(parent) ||
        ts.isMethodDeclaration(parent) ||
        ts.isMethodSignature(parent) ||
        ts.isBindingElement(parent) ||
        ts.isImportSpecifier(parent) ||
        ts.isExportSpecifier(parent) ||
        ts.isImportClause(parent) ||
        ts.isNamespaceImport(parent) ||
        ts.isImportEqualsDeclaration(parent)) &&
      parent.name === node
    );
  };

  const visit = (node: ts.Node): void => {
    // An instantiation expression is a TypeNode by kind, but its `.expression`
    // half is ordinary code — `(require<any>)(…)` calls the loader. Descend
    // into that half only, and never into the type arguments.
    if (ts.isExpressionWithTypeArguments(node)) {
      visit(node.expression);
      return;
    }
    // Any other type subtree DECLARES a shape and loads nothing. `NodeRequire`,
    // `typeof require`, `require` inside an `as` clause: all skipped wholesale,
    // which is why a text scan could not do this job.
    if (ts.isTypeNode(node)) return;

    if (ts.isIdentifier(node) && !isJustAName(node)) {
      if (node.text === "require") {
        // ANY value-position mention: called, aliased, passed, returned, or a
        // branch of a conditional. No expression analysis, so no spelling
        // escapes — which is the entire point of refusing the question.
        report(node, "executable `require`");
      } else if (node.text === "createRequire") {
        report(node, "`createRequire`");
      }
    } else if (ts.isPropertyAccessExpression(node) && node.name.text === "require") {
      // `module.require(…)`, and every other object carrying a loader.
      report(node, `\`${node.getText(sf).slice(0, 40)}\``);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      // `import x = require("m")` spells `require` as SYNTAX, not as an
      // identifier node, so nothing above would ever see it.
      report(node, "`import … = require(…)`");
    }

    ts.forEachChild(node, visit);
  };
  visit(sf);

  // Importing Node's loader facility at all, however it is then spelled.
  for (const spec of specifiersOfSource(source, fileName)) {
    if (spec === "module" || spec === "node:module") {
      violations.push(`imports "${spec}" — Node's createRequire facility`);
    }
  }
  return violations;
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
 * Every ESM shape the walker must see, with the answer WRITTEN DOWN rather
 * than computed.
 *
 * This table is the one check that cannot go blind alongside the walker.
 * Everything else in this block asks the extractor about the extractor:
 * CLOSURE IS CLOSED walks the graph with the same function that built it, so a
 * shape it cannot see is absent from both sides and the assertion passes while
 * the module executes. That is not hypothetical — it is exactly how the
 * side-effect gap shipped.
 *
 * CommonJS is deliberately absent from this table. It is not extracted at all
 * any more; it is FORBIDDEN, and proved so by NC-esm below.
 *
 * `.ts` and `.tsx` are both exercised: the entry components are TSX, and
 * ScriptKind changes how the source is parsed.
 */
type Shape = [name: string, source: string, expected: string[]];

const MODULE_REFERENCE_SHAPES: Shape[] = [
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
  ["dynamic import, template literal", "const p = import(`m`);", ["m"]],
  // A declaration with a literal specifier, so it is an edge. It is ALSO
  // forbidden as CommonJS by NC-esm; both are true.
  ["import-equals-require", 'import x = require("m");', ["m"]],
  // Type-only edges are followed too, deliberately: see the block comment above.
  ["import type", 'import type { T } from "m";', ["m"]],
  ["inline type specifier", 'import { type T } from "m";', ["m"]],
  ["export type from", 'export type { T } from "m";', ["m"]],
  ["import type position", 'type X = import("m").Y;', ["m"]],
  // ...and what must NOT become an edge.
  ["line-commented import", '// import "m";', []],
  ["block-commented import", '/* import "m"; */', []],
  ["a string that spells one", `const s = 'import "m"';`, []],
  ["a non-literal dynamic import", "const p = import(dynamicName);", []],
  // Not extracted as edges any more — CommonJS is rejected, not resolved.
  ["require is not an edge", 'const r = require("m");', []],
  ["parenthesized require is not an edge", '(require)("m");', []],
];

describe("NC-reach — the extractor sees every ESM module reference", () => {
  it.each(MODULE_REFERENCE_SHAPES)("%s", (_name, source, expected) => {
    expect(specifiersOfSource(source, path.join(ROOT, "probe.ts"))).toEqual(expected);
    // Both script kinds, because the entry components are TSX and ScriptKind
    // changes the parse.
    expect(specifiersOfSource(source, path.join(ROOT, "probe.tsx"))).toEqual(expected);
  });

  it("an ESM edge is walked TRANSITIVELY, not just recognised at the entry", () => {
    // Recognising a specifier is half the job: the queue must also FOLLOW it.
    // A walker that recognised an edge but never enqueued its target would
    // satisfy every shape above while the whole chain behind it executed.
    //
    // Real files as nodes so resolution is real; synthetic edges so the thing
    // under test is the traversal, not what any file happens to import.
    const CHAIN: Record<string, string> = {
      [FILES.model]: 'import "@/lib/finance/financial-copy";',
      "lib/finance/financial-copy.ts": 'import "@/lib/dashboard/practice-metrics";',
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

  it("THE MONEY MODULE: an ESM edge to it resolves, and it really is a money path", () => {
    // So the controls above are not a rehearsal against an innocent file.
    const entry = path.join(ROOT, FILES.model);
    const specs = specifiersOfSource('import "@/lib/dashboard/practice-metrics";', entry);
    expect(specs).toEqual(["@/lib/dashboard/practice-metrics"]);

    const resolved = resolveImport(specs[0], entry);
    expect(resolved).not.toBeNull();
    expect(path.relative(ROOT, resolved ?? "")).toBe("lib/dashboard/practice-metrics.ts");

    const money = codeOnly(read("lib/dashboard/practice-metrics.ts"));
    expect(FORBIDDEN_ON_THE_PATH.filter((id) => money.includes(id))).not.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 9. The FIN closure is ESM-only
// ---------------------------------------------------------------------------
//
// Four repairs tried to answer "does this expression load a module?" for
// CommonJS, and each was defeated by a new spelling: `require`, `(require)`,
// `((require as <T>(id: string) => T)<any>)`, `(flag ? require : require)`.
// The first three were transparent wrappers and reading emitted output closed
// that class. The fourth is not a wrapper — a conditional really does change
// what is called, and it escapes anyway because both branches are `require`.
// Chasing it means deciding which JavaScript expressions can evaluate to
// `require`, which is writing an evaluator.
//
// So the question is refused rather than answered. FIN dependencies must be
// ESM. Executable CommonJS in a reached module is the violation by itself, and
// no spelling of it can create an untracked money path because no spelling of
// it is allowed. Audited before the rule was imposed: the closure contained
// none, so nothing legitimate was outlawed.

const COMMONJS_SHAPES: Array<[string, string, boolean]> = [
  // Executable CommonJS — every one of these is a violation, and NONE of them
  // required working out which module it loads.
  ["direct require", 'const r = require("m");', true],
  ["parenthesized require", '(require)("m");', true],
  ["doubly parenthesized require", '((require))("m");', true],
  ["non-null asserted require", '(require!)("m");', true],
  ["as-cast require", '(require as typeof require)("m");', true],
  ["instantiated require", '(require<any>)("m");', true],
  ["instantiated as-cast require", '((require as <T>(id: string) => T)<any>)("m");', true],
  ["conditional require", '(flag ? require : require)("m");', true],
  ["one-sided conditional require", '(flag ? require : safeFn)("m");', true],
  ["logical-or require", '(require || safeFn)("m");', true],
  ["logical-and require", '(flag && require)("m");', true],
  ["nullish require", '(require ?? safeFn)("m");', true],
  ["comma-sequence require", '(0, require)("m");', true],
  ["reversed comma sequence", '(require, 0)("m");', true],
  ["require aliased to a const", "const r = require;", true],
  ["require passed as an argument", "register(require);", true],
  ["require returned", "function f() { return require; }", true],
  ["module.require", 'module.require("m");', true],
  ["parenthesized module.require", '(module.require)("m");', true],
  ["createRequire", 'const r = createRequire(u); r("m");', true],
  ["import of node:module", 'import { createRequire } from "node:module";', true],
  ["import-equals-require", 'import x = require("m");', true],
  // ...and what is NOT executable CommonJS.
  ["a string containing require", `const s = 'require("m")';`, false],
  ["a string containing the wrapped form", `const s = '(require)("m")';`, false],
  ["a line comment", '// const r = require("m");', false],
  ["a block comment", '/* const r = require("m"); */', false],
  ["a JSDoc mention", "/** uses require() at runtime */ export const a = 1;", false],
  ["a NodeRequire type annotation", "let r: NodeRequire;", false],
  ["a typeof require annotation", "function f(r: typeof require) { return r; }", false],
  ["a type alias naming require", "type R = typeof require;", false],
  ["an interface member typed as require", "interface I { r: NodeRequire }", false],
  ["an ordinary ESM import", 'import x from "m";', false],
  ["a dynamic import", 'const p = import("m");', false],
  ["an ordinary function call", '(safeFn)("m");', false],
  ["a conditional of safe functions", '(flag ? safeFn : otherFn)("m");', false],
  ["a property NAMED require on some object", "const o = { require: 1 };", false],
  ["a local parameter named require", "function f(require) { return 1; }", false],
];

describe("NC-esm — the FIN closure is ESM-only, so no CommonJS spelling matters", () => {
  it.each(COMMONJS_SHAPES)("%s", (_name, source, isViolation) => {
    const found = commonJsViolations(source, path.join(ROOT, "probe.ts"));
    expect(found.length > 0, `${source} -> ${JSON.stringify(found)}`).toBe(isViolation);
  });

  it("THE CONDITIONAL ESCAPE: rejected without deciding what it loads", () => {
    // The finding that ended the analysis approach. Note what is NOT asserted:
    // nothing here claims to know that this calls require or what it would
    // load. It is red because `require` appears in value position at all.
    const escape = '(flag ? require : require)("@/lib/dashboard/practice-metrics");';
    const probe = path.join(ROOT, "probe.ts");
    expect(commonJsViolations(escape, probe)).not.toEqual([]);
    // ...and the walker deliberately does NOT resolve it to an edge, which is
    // the whole point: the question was refused, not answered.
    expect(specifiersOfSource(escape, probe)).toEqual([]);
  });

  it("NO MODULE IN THE FIN CLOSURE USES COMMONJS", () => {
    // The invariant itself, over the real tree. Audited before this rule was
    // written: the answer was already none, so the rule outlaws nothing that
    // FIN legitimately does today.
    const offences: string[] = [];
    for (const [file, via] of CLOSURE) {
      const rel = path.relative(ROOT, file);
      for (const violation of commonJsViolations(readFileSync(file, "utf8"), file)) {
        offences.push(`${rel} ${violation} (reached via ${via ?? "entry point"})`);
      }
    }
    expect(offences).toEqual([]);
  });

  it("ANTI-VACUITY: the guard really does fire on a module in this closure", () => {
    // A guard that found nothing because it looks at nothing would pass the
    // assertion above. Take a file that IS in the closure, append the escape,
    // and require that the guard reports it.
    const rel = "lib/finance/financial-briefing-model.ts";
    const real = read(rel);
    expect(commonJsViolations(real, path.join(ROOT, rel))).toEqual([]);
    expect(
      commonJsViolations(
        `${real}\n(flag ? require : require)("@/lib/dashboard/practice-metrics");\n`,
        path.join(ROOT, rel),
      ),
    ).not.toEqual([]);
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
    // same failure a second time, and the cross-check before it was a line
    // count that could not see `require` either, so it agreed with the
    // blindness.
    //
    // KNOW WHAT THIS CHECK IS NOT. It is about ESM edges only, and it is not
    // what protects against CommonJS: `ts.preProcessFile` was measured against
    // `(require)("m")` and the instantiated form and reports neither. CommonJS
    // is covered by NC-esm above, which forbids it outright rather than trying
    // to see through it. This assertion covers a different failure — the walker
    // silently losing an ESM edge shape a second implementation still sees.
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
