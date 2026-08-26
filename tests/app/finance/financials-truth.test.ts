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

/**
 * THE REPOSITORY'S OWN MODULE RESOLVER, not a hand-written approximation.
 *
 * The previous version probed `x`, `x.ts`, `x.tsx`, `x/index.ts`, `x/index.tsx`
 * by hand. Codex showed that this repo compiles with `moduleResolution:
 * "bundler"`, under which `import "../dashboard/practice-metrics.js"` is a
 * VALID import that TypeScript resolves by extension substitution to the
 * existing `.ts` file — measured, with zero diagnostics. The hand-written
 * prober looked for `practice-metrics.js` and `practice-metrics.js.ts`, found
 * neither, returned null, and the walk skipped the edge. The specifier had been
 * read perfectly; RESOLUTION is where it vanished.
 *
 * So resolution is delegated to `ts.resolveModuleName` with the options parsed
 * from this repository's real tsconfig. That inherits bundler semantics, the
 * `@/*` path mapping, extension substitution and package resolution for free,
 * and — more to the point — it cannot drift from what the application actually
 * loads, because it IS what the application uses.
 *
 * There is exactly ONE resolver in this file. Static imports, re-exports and
 * dynamic imports all go through it.
 */
const COMPILER_OPTIONS: ts.CompilerOptions = (() => {
  const configPath = path.join(ROOT, "tsconfig.json");
  const raw = ts.readConfigFile(configPath, ts.sys.readFile);
  if (raw.error) {
    throw new Error(
      `cannot read tsconfig.json, so module resolution cannot be trusted: ${ts.flattenDiagnosticMessageText(raw.error.messageText, " ")}`,
    );
  }
  return ts.parseJsonConfigFileContent(raw.config, ts.sys, ROOT).options;
})();

const RESOLUTION_CACHE = ts.createModuleResolutionCache(ROOT, (x) => x, COMPILER_OPTIONS);

type Resolution =
  | { kind: "local"; file: string }
  | { kind: "external"; file: string }
  | { kind: "unresolved" };

/** Ask the compiler. Injectable ONLY so the fail-closed path can be proved. */
type Resolver = (specifier: string, fromFile: string) => Resolution;

const compilerResolver: Resolver = (specifier, fromFile) => {
  const { resolvedModule } = ts.resolveModuleName(
    specifier,
    fromFile,
    COMPILER_OPTIONS,
    ts.sys,
    RESOLUTION_CACHE,
  );
  if (!resolvedModule) return { kind: "unresolved" };
  const file = resolvedModule.resolvedFileName;
  // node_modules lives outside this worktree (it is shared), so the ROOT prefix
  // alone would not classify correctly. The compiler's own flag is the answer.
  const external =
    resolvedModule.isExternalLibraryImport === true || file.includes("/node_modules/");
  return external ? { kind: "external", file } : { kind: "local", file };
};

/**
 * ONE pass over a module. EVERY dependency-bearing site becomes exactly one
 * site record with exactly one kind. There is deliberately no fourth path and,
 * in particular, no silent one.
 *
 * WHY THE SHAPE MATTERS MORE THAN THE RULES. Nine escapes were reported on this
 * guard. Rounds 2–5 were CommonJS spellings, settled by refusing to analyse
 * CommonJS at all. Rounds 6–9 were all ONE bug wearing different hats: a
 * dependency site the guard could not READ became a site that did not EXIST.
 * `module["require"](…)` matched no branch; `import("../a/" + "b")` handed the
 * extractor a BinaryExpression it dropped; `import "…/x.js"` was extracted
 * perfectly and then lost by the resolver; `module["requ" + "ire"](…)` slipped
 * past a literal-only key test. Each time the answer was the same: something
 * unreadable became nothing at all.
 *
 * Fail-closed is therefore enforced at EVERY stage, not just extraction:
 *
 *   RESOLVED_LOCAL      a project source file — traversed
 *   RESOLVED_EXTERNAL   an installed package — not our source, not our contract
 *   TYPE_ONLY           a type-position dependency — ALSO traversed, on purpose
 *   FORBIDDEN_COMMONJS  CommonJS, without asking what it would load
 *   UNRESOLVED          recognised but unreadable or unresolvable — a violation
 *
 * TYPE_ONLY IS STILL TRAVERSED. `import type` erases at runtime, so following it
 * is stricter than the runtime graph — deliberately. The very first P2 on this
 * PR was `financial-spine.tsx` reaching the money module through a type-only
 * import alone. The separate kind is for accounting, not for leniency.
 *
 * WHAT IS DELIBERATELY NOT HERE. No constant folding, no evaluation of
 * concatenations, no data flow, no TypeChecker, no emitted-output analysis, no
 * callee-expression normalisation. Each was tried and each bought exactly one
 * review cycle. `import("../safe/" + "module")` is UNRESOLVED because it is not
 * a literal, not because anyone worked out where it points.
 */
type SiteKind =
  | "resolved_local"
  | "resolved_external"
  | "type_only"
  | "forbidden_commonjs"
  | "unresolved";

/** The AST form a site came from, for the census that proves none is lost. */
type SiteSyntax =
  | "import"
  | "export-from"
  | "import-type"
  | "dynamic-import"
  | "import-equals"
  | "commonjs-global";

type DependencySite = {
  kind: SiteKind;
  syntax: SiteSyntax;
  detail: string;
  /** The literal specifier, when the site had a readable one. */
  specifier?: string;
  /** Present exactly when kind is resolved_local, resolved_external or type_only. */
  file?: string;
};

/** The CommonJS mechanism itself. Executable use of any of these is forbidden. */
const COMMONJS_GLOBALS = new Set(["require", "module", "exports", "createRequire"]);

/**
 * Node's CommonJS loader facility, banned AT THE IMPORT BOUNDARY.
 *
 * Codex found `import * as nodeModule from "node:module"; nodeModule
 * .createRequire(import.meta.url)`. It escaped because `createRequire` in
 * property position is a NAME, and the name exemption that lets object keys
 * through suppressed the identifier rule. That was the eleventh escape on this
 * guard and the second of its kind: not a missing spelling, but an EXEMPTION
 * that had no other branch.
 *
 * Chasing the call site means enumerating every way a namespace object can be
 * aliased, destructured, passed or re-exported before `.createRequire` is
 * finally reached — property analysis, then data flow. Refused, for the same
 * reason CommonJS callee analysis was refused.
 *
 * Instead the facility is rejected where it ENTERS the module. FIN Slice 1 is
 * ESM-only and has no legitimate use for Node's loader; audited before the rule
 * was imposed, the seventeen-module closure imports neither specifier and never
 * mentions `createRequire`. So an import of it is the violation, and what the
 * module would later have done with the namespace never has to be decided.
 *
 * `"module"` is banned alongside `"node:module"` because it is the same
 * facility under its unprefixed name.
 */
const LOADER_FACILITY_SPECIFIERS = new Set(["node:module", "module"]);

/** Member names that would hand back a CommonJS loader. */
const LOADER_MEMBERS = new Set(["require", "createRequire"]);

/**
 * Whether an import or re-export is ERASED at emit, and so cannot execute the
 * module it names.
 *
 * Measured against this repository's compiler options rather than assumed:
 * `verbatimModuleSyntax` is not set, so `import type { X } from "m"`,
 * `import { type X } from "m"`, `import type * as ns from "m"` and
 * `export type { X } from "m"` all emit nothing at all. A form that emits
 * nothing cannot reach a loader, so banning it would be punishing a spelling.
 *
 * A clause with NO named bindings is not erased — `import "m"` and
 * `import {} from "m"` both execute the module for its side effects.
 */
const isErasedModuleReference = (node: ts.ImportDeclaration | ts.ExportDeclaration): boolean => {
  if (ts.isImportDeclaration(node)) {
    const clause = node.importClause;
    if (!clause) return false; // side-effect import: executes
    if (clause.isTypeOnly) return true;
    const bindings = clause.namedBindings;
    if (clause.name) return false; // a default binding is a value
    if (bindings && ts.isNamedImports(bindings)) {
      return bindings.elements.length > 0 && bindings.elements.every((e) => e.isTypeOnly);
    }
    return false; // namespace import, or nothing to inspect
  }
  if (node.isTypeOnly) return true;
  const clause = node.exportClause;
  if (clause && ts.isNamedExports(clause)) {
    return clause.elements.length > 0 && clause.elements.every((e) => e.isTypeOnly);
  }
  return false; // `export * from "m"` executes
};

function scanDependencies(
  source: string,
  fileName: string,
  resolver: Resolver = compilerResolver,
): DependencySite[] {
  const sf = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const sites: DependencySite[] = [];
  const at = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

  /**
   * The ONLY route a specifier can take. A non-literal specifier, or one the
   * compiler cannot resolve, becomes an UNRESOLVED site — never an absent one.
   */
  const dependency = (
    specifierNode: ts.Node | undefined,
    syntax: SiteSyntax,
    site: ts.Node,
    typeOnly: boolean,
  ) => {
    if (!specifierNode || !ts.isStringLiteralLike(specifierNode)) {
      sites.push({
        kind: "unresolved",
        syntax,
        detail: `line ${at(site)}: ${syntax} — the specifier is not a literal, so it cannot be followed`,
      });
      return;
    }
    const specifier = specifierNode.text;

    // THE LOADER FACILITY, rejected where it enters rather than where it is
    // used. Deliberately BEFORE resolution, so this does not depend on whether
    // `node:module` happens to resolve in this repository — it does not today,
    // and a guard that leaned on that accident would open the moment @types/node
    // reached the resolution path.
    if (!typeOnly && LOADER_FACILITY_SPECIFIERS.has(specifier)) {
      sites.push({
        kind: "forbidden_commonjs",
        syntax,
        detail: `line ${at(site)}: ${syntax} "${specifier}" — Node's CommonJS loader facility`,
        specifier,
      });
      return;
    }

    const resolution = resolver(specifier, fileName);
    if (resolution.kind === "unresolved") {
      sites.push({
        kind: "unresolved",
        syntax,
        detail: `line ${at(site)}: ${syntax} "${specifier}" — the compiler cannot resolve it`,
        specifier,
      });
      return;
    }
    sites.push({
      kind: typeOnly ? "type_only" : resolution.kind === "external" ? "resolved_external" : "resolved_local",
      syntax,
      detail: `line ${at(site)}: ${syntax} "${specifier}"`,
      specifier,
      file: resolution.file,
    });
  };

  // Two CommonJS rules can fire on the SAME source position — `module["require"]`
  // is both a member named require and a use of the `module` global. That is
  // fail-closed rather than fail-open, but it would double-count the site, so
  // the first report at a position wins and the census stays one-per-location.
  const forbiddenAt = new Set<number>();
  const forbid = (node: ts.Node, syntax: SiteSyntax, what: string) => {
    const start = node.getStart(sf);
    if (forbiddenAt.has(start)) return;
    forbiddenAt.add(start);
    sites.push({ kind: "forbidden_commonjs", syntax, detail: `line ${at(node)}: ${what}` });
  };

  /** True when this identifier only NAMES something rather than referring to it. */
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

  /**
   * `inType` is a FLAG carried down the walk, never an early return. Returning
   * early on type subtrees silently loses a nested `import("m")` inside one —
   * `Foo<import("m").Bar>` — which is the same fail-open in miniature. An
   * earlier draft of this very function did exactly that and the shape table
   * caught it.
   */
  const visit = (node: ts.Node, inType: boolean): void => {
    // An instantiation expression is a TypeNode by kind, but its `.expression`
    // half is ordinary code.
    if (ts.isExpressionWithTypeArguments(node)) {
      visit(node.expression, inType);
      for (const typeArgument of node.typeArguments ?? []) visit(typeArgument, true);
      return;
    }

    if (ts.isImportDeclaration(node)) {
      dependency(node.moduleSpecifier, "import", node, isErasedModuleReference(node));
    } else if (ts.isExportDeclaration(node)) {
      // A bare `export { a }` re-exports nothing from elsewhere: not a site.
      if (node.moduleSpecifier) {
        dependency(node.moduleSpecifier, "export-from", node, isErasedModuleReference(node));
      }
    } else if (ts.isImportTypeNode(node)) {
      dependency(
        ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined,
        "import-type",
        node,
        /* typeOnly */ true,
      );
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      // `(import)("m")` is a PARSE ERROR — measured — so the callee needs no
      // normalisation. The ARGUMENT is where something can hide.
      dependency(node.arguments[0], "dynamic-import", node, /* typeOnly */ false);
    } else if (
      !inType &&
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      forbid(node, "import-equals", "`import … = require(…)` — CommonJS");
    } else if (!inType && ts.isPropertyAccessExpression(node) && LOADER_MEMBERS.has(node.name.text)) {
      // A member named `require` or `createRequire` on ANY receiver. DEFENCE IN
      // DEPTH, not the proof: the import-boundary ban above is what actually
      // closes `nodeModule.createRequire(…)`, because it never lets the
      // namespace into the module. This catches a loader arriving by some other
      // future route without resolving any property or following any value.
      forbid(node, "commonjs-global", `\`${node.getText(sf).slice(0, 40)}\` — a member named ${node.name.text}`);
    } else if (
      !inType &&
      ts.isElementAccessExpression(node) &&
      node.argumentExpression &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      LOADER_MEMBERS.has(node.argumentExpression.text)
    ) {
      forbid(
        node,
        "commonjs-global",
        `\`${node.getText(sf).slice(0, 40)}\` — a member named ${node.argumentExpression.text}`,
      );
    } else if (!inType && ts.isIdentifier(node) && COMMONJS_GLOBALS.has(node.text) && !isJustAName(node)) {
      // THE MECHANISM, NOT ITS SPELLINGS. Forbidding executable `module` is why
      // `module.require(…)`, `module["require"](…)`, `module["requ" + "ire"](…)`
      // and `module[k](…)` all fail without anyone folding a string or deciding
      // what would have been loaded. Same for `require` in any expression
      // position: conditional, sequence, generic, parenthesised or aliased.
      //
      // Safe because it is true today: the closure was audited before the rule
      // was imposed and declares none of these names and uses none of them.
      forbid(node, "commonjs-global", `executable \`${node.text}\` — the CommonJS mechanism`);
    }

    ts.forEachChild(node, (child) =>
      visit(child, inType || (ts.isTypeNode(child) && !ts.isExpressionWithTypeArguments(child))),
    );
  };
  visit(sf, /* inType */ false);
  return sites;
}

/** Local project files a module depends on, type-only edges included. */
function localTargets(sites: readonly DependencySite[]): string[] {
  const out: string[] = [];
  for (const site of sites) {
    const isLocal = site.kind === "resolved_local" || site.kind === "type_only";
    if (isLocal && site.file && !site.file.includes("/node_modules/")) out.push(site.file);
  }
  return out;
}

/** Everything that must turn the guard red. */
function violationsOf(sites: readonly DependencySite[]): string[] {
  return sites
    .filter((s) => s.kind === "forbidden_commonjs" || s.kind === "unresolved")
    .map((s) => s.detail);
}

const dependencySites = (file: string): DependencySite[] =>
  scanDependencies(readFileSync(file, "utf8"), file);

/** Forbidden CommonJS, plus dependency syntax that cannot be read or resolved. */
function dependencyViolations(source: string, fileName: string): string[] {
  return violationsOf(scanDependencies(source, fileName));
}

/** The literal specifiers a source names, whatever became of them. */
function specifiersOfSource(source: string, fileName: string): string[] {
  return scanDependencies(source, fileName)
    .map((site) => site.specifier)
    .filter((specifier): specifier is string => specifier !== undefined);
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

/** Specifiers that the compiler resolves to a local project file, deduplicated. */
function resolvedEdges(specs: readonly string[], fromFile: string): string[] {
  const out = new Set<string>();
  for (const spec of specs) {
    const resolution = compilerResolver(spec, fromFile);
    if (resolution.kind === "local") out.add(resolution.file);
  }
  return [...out];
}

/**
 * file -> the importer that first reached it, so a failure names a chain.
 *
 * `sitesOf` is injectable for TWO reasons, both about provability. Recognising
 * a dependency and enqueuing its target are different things, and a walker that
 * did the first but not the second would satisfy every shape assertion while
 * the chain behind it still executed. Second, and newer: the fail-closed
 * behaviour of a RESOLVER that returns nothing for a perfectly readable literal
 * has to be testable, and the only honest way to test it is to hand the walk a
 * resolver that does exactly that. Production callers take the default.
 */
function walkFrom(
  entries: readonly string[],
  sitesOf: (file: string) => DependencySite[] = dependencySites,
): Map<string, string | null> {
  const reached = new Map<string, string | null>();
  const queue: Array<[string, string | null]> = entries.map((e) => [path.join(ROOT, e), null]);
  while (queue.length > 0) {
    const [file, via] = queue.shift()!;
    if (reached.has(file)) continue;
    reached.set(file, via);
    for (const target of localTargets(sitesOf(file))) {
      if (!reached.has(target)) queue.push([target, path.relative(ROOT, file)]);
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
  // Nested inside a type argument. An earlier draft of the scanner returned
  // early on type subtrees and lost this one silently — the same fail-open
  // this change exists to remove, reintroduced by the fix for it.
  ["import type nested in a type argument", 'type X = Foo<import("m").Bar>;', ["m"]],
  // Not an edge: it is CommonJS, so it is FORBIDDEN rather than resolved. One
  // outcome per dependency site — see NC-esm.
  ["import-equals-require is forbidden, not resolved", 'import x = require("m");', []],
  // Type-only edges are followed too, deliberately: see the block comment above.
  ["import type", 'import type { T } from "m";', ["m"]],
  ["inline type specifier", 'import { type T } from "m";', ["m"]],
  ["export type from", 'export type { T } from "m";', ["m"]],
  ["import type position", 'type X = import("m").Y;', ["m"]],
  // ...and what must NOT become an edge.
  ["line-commented import", '// import "m";', []],
  ["block-commented import", '/* import "m"; */', []],
  ["a string that spells one", `const s = 'import "m"';`, []],
  // Not edges — and not silently absent either. Each is a VIOLATION, pinned in
  // the table below. Recording nothing here is only safe because of that.
  ["a non-literal dynamic import", "const p = import(dynamicName);", []],
  ["a concatenated dynamic import", 'const p = import("../a/" + "b");', []],
  ["a substituted template dynamic import", "const p = import(`../a/${n}`);", []],
  ["a conditional dynamic import", 'const p = import(f ? "./a" : "./b");', []],
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
      scanDependencies(CHAIN[path.relative(ROOT, file)] ?? "", file),
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

    const resolution = compilerResolver(specs[0], entry);
    expect(resolution.kind).toBe("local");
    expect(
      resolution.kind === "local" ? path.relative(ROOT, resolution.file) : resolution.kind,
    ).toBe("lib/dashboard/practice-metrics.ts");

    const money = codeOnly(read("lib/dashboard/practice-metrics.ts"));
    expect(FORBIDDEN_ON_THE_PATH.filter((id) => money.includes(id))).not.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 9. Static ESM only, and nothing unreadable
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
//
// Two more escapes then showed that refusing the question was not enough on its
// own, because the walk still had somewhere to put an answer it did not have.
// `module["require"](…)` matched no branch, and `import("../a/" + "b")` handed
// the extractor a BinaryExpression it silently dropped. Neither recorded an
// edge and neither raised anything: an unreadable dependency became an ABSENT
// dependency. The default is now inverted — a site this cannot read is a
// violation — so the next unreadable form fails closed rather than open.
// Audited too: no member named `require` and no non-literal dynamic import
// anywhere in the closure.

const DEPENDENCY_VIOLATION_SHAPES: Array<[string, string, boolean]> = [
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
  // Bracket access. No FIN runtime code needs a member called require, so the
  // SYNTAX is forbidden and the receiver is never examined — no evaluator.
  ['module["require"]', 'module["require"]("m");', true],
  ["module['require'] single-quoted", "module['require'](\"m\");", true],
  ['globalThis["require"]', 'globalThis["require"]("m");', true],
  ['someObject["require"]', 'someObject["require"]("m");', true],
  ["someObject.require", 'someObject.require("m");', true],
  ['a bracket require behind parens', '(module["require"])("m");', true],
  // UNRESOLVABLE DEPENDENCY SYNTAX. Not CommonJS at all — an ESM dynamic
  // import whose specifier cannot be read. Forbidden rather than ignored,
  // without folding constants or evaluating anything.
  ["concatenated dynamic import", 'import("../dashboard/" + "practice-metrics");', true],
  ["variable dynamic import", 'const s = "./x"; import(s);', true],
  ["conditional dynamic import", 'import(c ? "./safe" : "../dashboard/practice-metrics");', true],
  ["substituted template dynamic import", "import(`../dashboard/${name}`);", true],
  ["dynamic import with no argument", "import();", true],
  ["unreadable import type position", "type X = import(SomeAlias).Y;", true],
  ["createRequire", 'const r = createRequire(u); r("m");', true],
  // THE LOADER FACILITY, rejected at the import boundary. None of these needs
  // anyone to work out what the module would later do with the namespace.
  ["named import of node:module", 'import { createRequire } from "node:module";', true],
  ["renamed named import of node:module", 'import { createRequire as cr } from "node:module";', true],
  ["namespace import of node:module", 'import * as nm from "node:module";', true],
  ["default import of node:module", 'import nm from "node:module";', true],
  ["side-effect import of node:module", 'import "node:module";', true],
  ["namespace import of bare module", 'import * as nm from "module";', true],
  ["named import of bare module", 'import { createRequire } from "module";', true],
  ["dynamic import of node:module", 'const p = import("node:module");', true],
  ["dynamic import of bare module", 'const p = import("module");', true],
  ["re-export from node:module", 'export { createRequire } from "node:module";', true],
  ["re-export star from node:module", 'export * from "node:module";', true],
  // ...and the exact Codex reproduction, whole.
  [
    "THE CODEX REPRODUCTION",
    'import * as nodeModule from "node:module";\nconst load = nodeModule.createRequire(import.meta.url);\nload("@/lib/dashboard/practice-metrics");',
    true,
  ],
  // Defence in depth: a loader arriving by some other route.
  ["namespace-qualified createRequire", "ns.createRequire(u);", true],
  ["bracketed createRequire member", 'ns["createRequire"](u);', true],
  ["bare createRequire", "const load = createRequire(u);", true],
  ["createRequire aliased to a const", "const cr = createRequire;", true],
  ["import-equals-require", 'import x = require("m");', true],
  // ...and what is NOT executable CommonJS.
  ["a string containing require", `const s = 'require("@/x")';`, false],
  ["a string containing the wrapped form", `const s = '(require)("@/x")';`, false],
  ["a line comment", '// const r = require("@/x");', false],
  ["a block comment", '/* const r = require("@/x"); */', false],
  ["a JSDoc mention", "/** uses require() at runtime */ export const a = 1;", false],
  ["a NodeRequire type annotation", "let r: NodeRequire;", false],
  ["a typeof require annotation", "function f(r: typeof require) { return r; }", false],
  ["a type alias naming require", "type R = typeof require;", false],
  ["an interface member typed as require", "interface I { r: NodeRequire }", false],
  ["an ordinary ESM import", 'import x from "@/lib/finance/financial-fact";', false],
  ["a dynamic import", 'const p = import("@/lib/finance/financial-fact");', false],
  ["an ordinary function call", '(safeFn)("m");', false],
  ["a conditional of safe functions", '(flag ? safeFn : otherFn)("m");', false],
  ["a property NAMED require on some object", "const o = { require: 1 };", false],
  ["a local parameter named require", "function f(require) { return 1; }", false],
  // Ordinary indexing must survive: the closure uses 25 computed element
  // accesses. Only a LITERAL `require` key is forbidden.
  ["computed element access", "const v = UNKNOWN_LABEL[cause];", false],
  // NEW, and the point of Part 1: a literal the compiler cannot resolve is a
  // violation rather than an absence.
  ["a local literal that resolves to nothing", 'import "@/lib/does/not/exist";', true],
  ["a relative literal that resolves to nothing", 'import "./nope/nowhere";', true],
  // ...while an explicit .js extension DOES resolve here, under bundler
  // resolution, to the .ts file. It is a real edge, so it is not a violation.
  ["an explicit .js specifier that resolves", 'import "@/lib/finance/financial-fact.js";', false],
  ["an installed external package", 'import * as React from "react";', false],
  // TYPE-ONLY IS NOT PERSECUTED FOR ITS SPELLING. Measured against this repo's
  // options: with `verbatimModuleSyntax` unset, every one of these emits
  // nothing, so none can reach a loader.
  ["type-only import of a package", 'import type { FC } from "react";', false],
  ["inline type specifier of a package", 'import { type FC } from "react";', false],
  ["type-only namespace import", 'import type * as React from "react";', false],
  ["export type from a package", 'export type { FC } from "react";', false],
  ["import type position", 'type X = import("react").FC;', false],
  // Text is not code.
  ["a string naming node:module", `const s = 'import "node:module"';`, false],
  ["a comment naming node:module", '// import { createRequire } from "node:module";', false],
  ["a comment naming createRequire", "/* createRequire(u) */ export const a = 1;", false],
  ["an object key named createRequire", "const o = { createRequire: 1 };", false],
  ["element access with another literal key", 'const v = o["safe"];', false],
  ["a member named something else", 'other.request("@/lib/finance/financial-fact");', false],
  ["a string used as an element key elsewhere", 'const k = "require"; const v = o[k];', false],
  // Literal dynamic imports stay legal — that is the whole legible form.
  ["literal dynamic import", 'import("@/lib/finance/financial-fact");', false],
  ["template-literal dynamic import", "import(`@/lib/finance/financial-fact`);", false],
];

describe("NC-esm — static ESM only: CommonJS and unreadable dependencies both fail", () => {
  it.each(DEPENDENCY_VIOLATION_SHAPES)("%s", (_name, source, isViolation) => {
    const found = dependencyViolations(source, path.join(ROOT, "probe.ts"));
    expect(found.length > 0, `${source} -> ${JSON.stringify(found)}`).toBe(isViolation);
  });

  it("THE CONDITIONAL ESCAPE: rejected without deciding what it loads", () => {
    // The finding that ended the analysis approach. Note what is NOT asserted:
    // nothing here claims to know that this calls require or what it would
    // load. It is red because `require` appears in value position at all.
    const escape = '(flag ? require : require)("@/lib/dashboard/practice-metrics");';
    const probe = path.join(ROOT, "probe.ts");
    expect(dependencyViolations(escape, probe)).not.toEqual([]);
    // ...and the walker deliberately does NOT resolve it to an edge, which is
    // the whole point: the question was refused, not answered.
    expect(specifiersOfSource(escape, probe)).toEqual([]);
  });

  it("THE BRACKET ESCAPE: forbidden as syntax, without examining the receiver", () => {
    // Nothing here decides whether `module` is Node's module object. No FIN
    // runtime code needs a member called require — audited before the rule was
    // imposed — so the spelling itself is the violation.
    const probe = path.join(ROOT, "probe.ts");
    for (const escape of [
      'module["require"]("@/lib/dashboard/practice-metrics");',
      'globalThis["require"]("@/lib/dashboard/practice-metrics");',
      'anything["require"]("@/lib/dashboard/practice-metrics");',
    ]) {
      expect(dependencyViolations(escape, probe), escape).not.toEqual([]);
      expect(specifiersOfSource(escape, probe), escape).toEqual([]);
    }
  });

  it("FAIL CLOSED: an unreadable dependency is a violation, never an absence", () => {
    // The design flaw behind the last two findings, asserted directly. Both of
    // these record no edge — that part is unchanged and correct, because
    // neither specifier can be read. What changed is that recording no edge is
    // no longer the END of it: each is reported, so a dependency site can never
    // become "nothing happened" again.
    const probe = path.join(ROOT, "lib/finance/probe.ts");

    // STAGE ONE — unreadable at EXTRACTION: the specifier is not a literal.
    for (const unreadable of [
      'import("@/lib/dashboard/" + "practice-metrics");',
      'const s = "@/lib/dashboard/practice-metrics"; import(s);',
      'import(cond ? "./safe" : "@/lib/dashboard/practice-metrics");',
      "import(`@/lib/dashboard/${name}`);",
    ]) {
      const sites = scanDependencies(unreadable, probe);
      expect(localTargets(sites), unreadable).toEqual([]);
      expect(violationsOf(sites), unreadable).not.toEqual([]);
      expect(sites.every((s) => s.kind === "unresolved"), unreadable).toBe(true);
      expect(violationsOf(sites).join(" ")).toMatch(/not a literal/);
    }

    // No constant folding happened: a concatenation that spells a SAFE module
    // is rejected too. Legibility is the rule, not the destination.
    const safe = scanDependencies('import("@/lib/finance/" + "financial-fact");', probe);
    expect(localTargets(safe)).toEqual([]);
    expect(violationsOf(safe)).not.toEqual([]);

    // STAGE TWO — unreadable at RESOLUTION: a perfectly legible literal that
    // the compiler cannot resolve. This is the stage the `.js` finding exposed,
    // where extraction succeeded and the edge then vanished.
    const nowhere = scanDependencies('import "@/lib/does/not/exist";', probe);
    expect(localTargets(nowhere)).toEqual([]);
    expect(violationsOf(nowhere)).not.toEqual([]);
    expect(nowhere.map((s) => s.kind)).toEqual(["unresolved"]);
    expect(violationsOf(nowhere).join(" ")).toMatch(/cannot resolve/);
  });

  it("EVERY DEPENDENCY SITE HAS EXACTLY ONE OUTCOME", () => {
    // Resolved, forbidden or unreadable — never none of the three. Asserted by
    // construction over a source that contains one of each.
    const probe = path.join(ROOT, "lib/finance/probe.ts");
    const kindsOf = (source: string) => scanDependencies(source, probe).map((s) => s.kind);

    expect(kindsOf('import "@/lib/finance/financial-fact";')).toEqual(["resolved_local"]);
    expect(kindsOf('import * as React from "react";')).toEqual(["resolved_external"]);
    expect(kindsOf('import type { T } from "@/lib/finance/financial-fact";')).toEqual([
      "type_only",
    ]);
    expect(kindsOf('module["require"]("@/lib/finance/financial-fact");')).toEqual([
      "forbidden_commonjs",
    ]);
    expect(kindsOf("import(x);")).toEqual(["unresolved"]);
    expect(kindsOf('import "@/lib/does/not/exist";')).toEqual(["unresolved"]);

    // ...and a module containing one of each loses none of them: the census
    // below is what makes that a fact rather than a hope.
    const mixed = scanDependencies(
      [
        'import "@/lib/finance/financial-fact";',
        'import * as React from "react";',
        'import type { T } from "@/lib/finance/financial-copy";',
        'module["require"]("@/lib/finance/financial-fact");',
        "import(x);",
      ].join("\n"),
      probe,
    );
    expect(mixed.map((s) => s.kind).sort()).toEqual(
      [
        "forbidden_commonjs",
        "resolved_external",
        "resolved_local",
        "type_only",
        "unresolved",
      ].sort(),
    );
    expect(mixed).toHaveLength(5);
  });

  it("THE LOADER FACILITY: banned where it ENTERS, not where it is used", () => {
    // The eleventh escape, and the second caused by an EXEMPTION rather than a
    // missing spelling: `createRequire` in property position is a name, and the
    // name exemption that lets object keys through suppressed the identifier
    // rule. Chasing the call site means property analysis and then data flow.
    //
    // So the namespace never gets in. Note what is NOT asserted below: nothing
    // claims to know what `nodeModule` is or what `.createRequire` would
    // return. The import is the violation.
    const probe = path.join(ROOT, "lib/finance/probe.ts");
    const codexReproduction = [
      'import * as nodeModule from "node:module";',
      "const load = nodeModule.createRequire(import.meta.url);",
      'load("@/lib/dashboard/practice-metrics");',
    ].join("\n");

    const sites = scanDependencies(codexReproduction, probe);
    expect(sites.some((s) => s.kind === "forbidden_commonjs")).toBe(true);
    expect(violationsOf(sites).join(" ")).toMatch(/loader facility/);
    // The import is rejected on its own, before the call site is even reached.
    const importAlone = scanDependencies('import * as nodeModule from "node:module";', probe);
    expect(importAlone.map((s) => s.kind)).toEqual(["forbidden_commonjs"]);
  });

  it("the loader ban does NOT depend on whether node:module resolves", () => {
    // It does not resolve in this repository — no @types/node on the resolution
    // path — so a ban placed after resolution would be caught by the
    // unresolved-site rule instead and would silently open the day @types/node
    // arrived. This pins that the ban fires FIRST, by its own reason.
    const probe = path.join(ROOT, "lib/finance/probe.ts");
    const sites = scanDependencies('import * as nm from "node:module";', probe, () => ({
      // a resolver that CAN resolve it, standing in for a future @types/node
      kind: "external",
      file: "/somewhere/node_modules/@types/node/module.d.ts",
    }));
    expect(sites.map((s) => s.kind)).toEqual(["forbidden_commonjs"]);
    expect(violationsOf(sites).join(" ")).toMatch(/loader facility/);
  });

  it("TYPE-ONLY BOUNDARY: erased references are not executable violations", () => {
    // Measured, not assumed: with `verbatimModuleSyntax` unset every form below
    // emits nothing, so none of them can reach a loader. Banning them would be
    // punishing a spelling, which the contract explicitly refuses to do.
    const probe = path.join(ROOT, "lib/finance/probe.ts");
    for (const erased of [
      'import type { createRequire } from "node:module";',
      'import { type createRequire } from "node:module";',
      'import type * as nm from "node:module";',
      'export type { createRequire } from "node:module";',
      'type X = import("node:module").RequireResolve;',
    ]) {
      const kinds = scanDependencies(erased, probe).map((s) => s.kind);
      expect(kinds, erased).not.toContain("forbidden_commonjs");
    }

    // ...and the same forms against a RESOLVABLE package land in TYPE_ONLY,
    // which is the category the contract says governs them. The node:module
    // forms above are `unresolved` only because that specifier does not resolve
    // here at all — a fact about this repo, not a judgement about type imports.
    for (const erased of [
      'import type { FC } from "react";',
      'import { type FC } from "react";',
      'import type * as React from "react";',
    ]) {
      expect(scanDependencies(erased, probe).map((s) => s.kind), erased).toEqual(["type_only"]);
    }
    expect(
      scanDependencies('import type { createRequire } from "node:module";', probe).map(
        (s) => s.kind,
      ),
    ).toEqual(["unresolved"]);
  });

  it("NO MODULE IN THE FIN CLOSURE USES COMMONJS OR AN UNREADABLE DEPENDENCY", () => {
    // The invariant itself, over the real tree. Audited before either rule was
    // written — no executable member named `require`, no non-literal dynamic
    // import — so neither outlaws anything FIN legitimately does today.
    const offences: string[] = [];
    for (const [file, via] of CLOSURE) {
      const rel = path.relative(ROOT, file);
      for (const violation of dependencyViolations(readFileSync(file, "utf8"), file)) {
        offences.push(`${rel} ${violation} (reached via ${via ?? "entry point"})`);
      }
    }
    expect(offences).toEqual([]);
  });

  it("ANTI-VACUITY: the guard really does fire on a module in this closure", () => {
    // A guard that found nothing because it looks at nothing would pass the
    // assertion above. Take a file that IS in the closure and append each
    // escape in turn.
    const rel = "lib/finance/financial-briefing-model.ts";
    const real = read(rel);
    const where = path.join(ROOT, rel);
    expect(dependencyViolations(real, where)).toEqual([]);
    for (const escape of [
      '(flag ? require : require)("@/lib/dashboard/practice-metrics");',
      'module["require"]("@/lib/dashboard/practice-metrics");',
      'import("../dashboard/" + "practice-metrics");',
      'import * as nodeModule from "node:module";',
      // NOTE: `import "../dashboard/practice-metrics.js"` is deliberately NOT
      // here. It RESOLVES, so it is a legitimate edge and no violation — what
      // it breaks is reachability, caught by the money-path assertion instead.
    ]) {
      expect(dependencyViolations(`${real}\n${escape}\n`, where), escape).not.toEqual([]);
    }
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
      const walked = new Set(localTargets(dependencySites(file)));
      for (const spec of independentSpecifiers(file)) {
        const resolution = compilerResolver(spec, file);
        if (resolution.kind !== "local") continue;
        const target = resolution.file;
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
      for (const target of localTargets(dependencySites(file))) {
        if (!CLOSURE.has(target)) {
          escaped.push(`${path.relative(ROOT, file)} -> ${path.relative(ROOT, target)}`);
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

// ---------------------------------------------------------------------------
// 10. Site accounting — nothing may vanish between the stages
// ---------------------------------------------------------------------------
//
// Rounds 6 to 9 of this guard were all one bug: a dependency site the guard
// could not understand became a site that did not exist. It happened at
// extraction (`module["require"]`, `import("../a/" + "b")`) and it happened one
// stage later at resolution (`import "…/x.js"`, extracted perfectly and then
// lost). Each individual fix was correct and each was followed by the same bug
// somewhere else, because nothing was checking that sites SURVIVE the pipeline.
//
// This block checks exactly that, and it is the reason the pipeline reports
// site records rather than a bare list of specifiers.

/**
 * An INDEPENDENT count of dependency-bearing syntax, written without reference
 * to `scanDependencies` and using plain `forEachChild` recursion. If the
 * scanner ever stops emitting a record for a form, this disagrees with it.
 */
function countDependencySyntax(file: string): number {
  const source = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  let count = 0;
  const seen = new Set<number>();
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) count += 1;
    else if (ts.isExportDeclaration(node) && node.moduleSpecifier) count += 1;
    else if (ts.isImportTypeNode(node)) count += 1;
    else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      count += 1;
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      count += 1;
    } else if (
      (ts.isIdentifier(node) && COMMONJS_GLOBALS.has(node.text)) ||
      (ts.isPropertyAccessExpression(node) && node.name.text === "require") ||
      (ts.isElementAccessExpression(node) &&
        node.argumentExpression &&
        ts.isStringLiteralLike(node.argumentExpression) &&
        node.argumentExpression.text === "require")
    ) {
      // Counted per POSITION, matching how the scanner dedupes overlapping
      // CommonJS rules. Type positions and pure naming are filtered by the
      // scanner, so this is an upper bound and the comparison below is <=.
      const start = node.getStart(sf);
      if (!seen.has(start)) {
        seen.add(start);
        count += 1;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return count;
}

describe("NC-census — every dependency site survives the whole pipeline", () => {
  it("TOTAL equals the sum of the five kinds, for every module in the closure", () => {
    // The invariant stated as arithmetic. A site that fell through to nothing
    // would make the parts sum to less than the whole.
    for (const file of CLOSURE.keys()) {
      const sites = dependencySites(file);
      const byKind = {
        resolved_local: sites.filter((s) => s.kind === "resolved_local").length,
        resolved_external: sites.filter((s) => s.kind === "resolved_external").length,
        type_only: sites.filter((s) => s.kind === "type_only").length,
        forbidden_commonjs: sites.filter((s) => s.kind === "forbidden_commonjs").length,
        unresolved: sites.filter((s) => s.kind === "unresolved").length,
      };
      const sum =
        byKind.resolved_local +
        byKind.resolved_external +
        byKind.type_only +
        byKind.forbidden_commonjs +
        byKind.unresolved;
      expect(sum, `${path.relative(ROOT, file)} ${JSON.stringify(byKind)}`).toBe(sites.length);
    }
  });

  it("the scanner emits a record for every dependency-bearing node an independent count finds", () => {
    // Two implementations of "what counts as a dependency site". The scanner
    // filters type positions and pure naming, so it may legitimately report
    // FEWER; it may never report fewer than the ESM forms alone, and the
    // shortfall is reported rather than hidden.
    const disagreements: string[] = [];
    let totalSites = 0;
    for (const file of CLOSURE.keys()) {
      const sites = dependencySites(file);
      totalSites += sites.length;
      const esmSites = sites.filter((s) => s.syntax !== "commonjs-global").length;
      const independent = countDependencySyntax(file);
      if (esmSites > independent) {
        disagreements.push(
          `${path.relative(ROOT, file)}: scanner ${esmSites} ESM sites, independent count ${independent}`,
        );
      }
    }
    expect(disagreements).toEqual([]);
    // ...and it is not vacuous: this closure really does have dependency sites.
    expect(totalSites).toBeGreaterThanOrEqual(CLOSURE.size);
  });

  it("every FIN closure module is REACHED through a recorded site, not by accident", () => {
    // Each non-entry file must be the `file` of a resolved site on some other
    // reached module. A file that appeared in CLOSURE without a site pointing at
    // it would mean the traversal and the accounting had drifted apart.
    const pointedAt = new Set<string>();
    for (const file of CLOSURE.keys()) {
      for (const target of localTargets(dependencySites(file))) pointedAt.add(target);
    }
    const entries = new Set(FIN_ENTRIES.map((e) => path.join(ROOT, e)));
    const orphans = [...CLOSURE.keys()]
      .filter((f) => !entries.has(f) && !pointedAt.has(f))
      .map((f) => path.relative(ROOT, f));
    expect(orphans).toEqual([]);
  });

  it("LOAD-BEARING: a recognised literal the resolver cannot resolve turns the guard RED", () => {
    // The exact failure the `.js` finding exposed, forced deliberately. The
    // specifier is a perfectly good literal and extraction succeeds; only
    // RESOLUTION fails. Before this change that produced silence.
    //
    // A resolver that resolves nothing stands in for the hand-written prober
    // that could not follow `practice-metrics.js`.
    const blindResolver: Resolver = () => ({ kind: "unresolved" });
    const source = 'import "@/lib/finance/financial-fact";';
    const probe = path.join(ROOT, "lib/finance/probe.ts");

    const sites = scanDependencies(source, probe, blindResolver);
    expect(sites.map((s) => s.kind)).toEqual(["unresolved"]);
    expect(violationsOf(sites)).not.toEqual([]);
    expect(localTargets(sites)).toEqual([]);

    // ...and the whole guard, not just the scanner, goes red: walking the real
    // entries with that resolver leaves a closure full of unresolved sites.
    const reached = walkFrom(FIN_ENTRIES, (file) =>
      scanDependencies(readFileSync(file, "utf8"), file, blindResolver),
    );
    expect(reached.size).toBe(FIN_ENTRIES.length);
    const offences: string[] = [];
    for (const file of reached.keys()) {
      offences.push(
        ...violationsOf(scanDependencies(readFileSync(file, "utf8"), file, blindResolver)),
      );
    }
    expect(offences).not.toEqual([]);

    // The real resolver, on the same tree, produces neither.
    expect(violationsOf(dependencySites(path.join(ROOT, FILES.model)))).toEqual([]);
  });
});
