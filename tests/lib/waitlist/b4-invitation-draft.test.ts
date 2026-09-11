import { describe, expect, it } from "vitest";
import ts from "typescript";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

import {
  WAITLIST_ENTRY_STATUSES,
  actionAvailability,
  type AdmissionContext,
  type WaitlistEntryStatus,
} from "@/lib/waitlist/admission-model";
import {
  ALLOWED_DAYS_PRESET_VALUES,
  invitationHasRunOut,
  normalizeInvitationContext,
  practitionerStatusDetail,
  BOOKING_WINDOW_PRESETS,
  INVITE_TO_BOOK_STATUSES,
  PRACTITIONER_ACTIONS,
  PRACTITIONER_ACTION_LABEL,
  PRACTITIONER_STATUS_LABEL,
  TTL_PRESETS,
  UNKNOWN_INVITATION_FAILS_CLOSED,
  WEEKDAYS_IN_DISPLAY_ORDER,
  activeAllowedDaysPreset,
  activeTtlPreset,
  activeWindowPreset,
  controlState,
  delegateFor,
  draftToInviteInput,
  emptyDraft,
  entryActionSurface,
  practitionerActionAvailability,
  practitionerStatusLabel,
  readyToBind,
  sendState,
  validateDraft,
  waitlistDomId,
  type InviteDraft,
  type PractitionerAction,
  type PractitionerActionItem,
} from "@/lib/waitlist/b4-invitation-draft";
import type { AdapterCapabilities } from "@/lib/waitlist/invite-to-book-contract";

// ===========================================================================
// WAIT-03 B4 — the practitioner surface, and the rules it must NOT own
// ===========================================================================
//
// Two things are proved here and they pull in opposite directions.
//
// THE PRODUCT RULING is that the waitlist state machine is invisible: no Claim,
// no Claim next, no Reinvite, and no screen that asks a practitioner which
// internal transition they meant. That is asserted directly against the
// exported vocabulary, because a ruling that lives only in a comment is one
// refactor from being undone.
//
// THE ENGINEERING RULING is that hiding the state machine must not mean
// re-deriving it. Every verdict this module renders is delegated to the live
// `admission-model`, and the delegation is EXECUTED here rather than described:
// the surface is walked at every status under every invitation context and each
// verdict compared against its delegate's. The one permitted divergence is
// refusing where the live model permits. Permitting where it refuses would
// offer a control the database is guaranteed to reject, which is the exact
// failure the live model exists to prevent.

const ROOT = process.cwd();

/** Every .ts/.tsx file under a directory, recursively. Node 20 has no
 *  `fs.globSync`, and this is the walk the repo's other dormancy proofs use. */
/**
 * The source extensions an application module in this repository can use.
 *
 * ONE LIST, and that is the whole point. The directory walker already accepted
 * JavaScript; the special roots below were spelled `.ts` only. Two lists that
 * must agree drifted the moment the second one was written, which is exactly
 * the defect this constant removes.
 */
const APPLICATION_EXTENSIONS = ["ts", "tsx", "js", "jsx", "mjs", "cjs"] as const;

const APPLICATION_FILE = new RegExp(`\\.(${APPLICATION_EXTENSIONS.join("|")})$`);

function walk(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(join(ROOT, dir));
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of entries) {
    const rel = join(dir, name);
    if (statSync(join(ROOT, rel)).isDirectory()) {
      if (name === "node_modules" || name === ".next") continue;
      out.push(...walk(rel));
    } else if (APPLICATION_FILE.test(name)) {
      // JAVASCRIPT COUNTS. Next accepts `.js`/`.jsx` routes, and enumerating
      // only TypeScript meant a `.jsx` route could import a prototype entry
      // point while this assertion stayed green. There are none under `app/`
      // today — and the guard exists to fail on the change that introduces
      // reachability, not to describe the tree as it stands.
      out.push(rel);
    }
  }
  return out;
}

/**
 * Every invitation context a caller can actually hand us, including the
 * combinations that should not occur.
 *
 * `{ elapsed: true, unknown: true }` is contradictory — the window cannot be
 * known to have passed on facts that could not be read — and it is in the
 * matrix on purpose. A surface that behaves sensibly only on coherent input is
 * a surface that fails on the day a read half-succeeds.
 */
const CONTEXTS: ReadonlyArray<{ name: string; context: AdmissionContext }> = [
  { name: "no invitation facts", context: {} },
  { name: "live, unused", context: { invitationElapsed: false, invitationRedeemed: false } },
  { name: "elapsed", context: { invitationElapsed: true, invitationRedeemed: false } },
  { name: "redeemed", context: { invitationRedeemed: true } },
  { name: "facts unreadable", context: { invitationFactsUnknown: true } },
  {
    name: "elapsed AND unreadable (incoherent input)",
    context: { invitationElapsed: true, invitationFactsUnknown: true },
  },
];

function surfaceItems(
  status: WaitlistEntryStatus,
  context: AdmissionContext,
): PractitionerActionItem[] {
  const surface = entryActionSurface(status, context);
  return [...(surface.primary ? [surface.primary] : []), ...surface.secondary];
}

// ---------------------------------------------------------------------------

/**
 * EVERY PROTOTYPE ENTRY POINT, not just the two leaf modules.
 *
 * The earlier guard grepped `app/` for the two MODULE names. But both
 * components import those modules, so a route doing
 * `import { AdmissionRow } from "@/components/waitlist/admission-row"` would
 * have made the whole prototype live while the route's own text mentioned
 * neither name — and the test would have stayed green. The hole was exactly
 * the size of the two files the guard exists to protect.
 */
const PROTOTYPE_ENTRY_POINTS = [
  "lib/waitlist/b4-invitation-draft.ts",
  "lib/waitlist/invite-to-book-contract.ts",
  "components/waitlist/admission-row.tsx",
  "components/waitlist/invite-composer.tsx",
] as const;

/**
 * Every import specifier in a source file, READ FROM THE SYNTAX TREE.
 *
 * NOT A REGEX, AND THE REASON IS A DEFECT THIS GUARD ALREADY SHIPPED. The first
 * version searched `app/` for the two module NAMES, and missed anything reached
 * through a component. The second searched for import STATEMENTS — still a text
 * search — and `\s+` between `from` and the module string means whitespace, so
 *
 *     import { AdmissionRow } from /* prototype *\/ "@/components/waitlist/admission-row"
 *
 * parses with zero diagnostics, compiles, makes the prototype application-
 * reachable, and produced NO edge. The guard stayed green.
 *
 * Comments are legal wherever whitespace is; so are line continuations, unusual
 * quoting and escapes. No refinement of a pattern survives contact with that,
 * so this asks the compiler instead. `ts.createSourceFile` is the same parser
 * `tsc` uses, and it is already a dependency of this repository.
 *
 * FIVE EDGE KINDS, because any of them makes a module reachable:
 *   import x from "y"          static, including type-only (see below)
 *   import "y"                 side-effect
 *   export … from "y"          re-export — a real edge, and easy to forget
 *   import("y")                dynamic
 *   require("y") / import x =  CommonJS forms
 *
 * TYPE-ONLY IMPORTS COUNT. `import type` is erased, so it cannot make code run
 * — but this guard's question is whether an application surface has coupled
 * itself to the prototype, and erring toward "reachable" is the safe direction
 * for an isolation boundary. A guard that under-reports is the failure mode
 * being fixed here twice over.
 */
function importSpecifiers(file: string, text: string): string[] {
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    // The script kind is load-bearing: parsing a .tsx file as .ts misreads JSX
    // as type assertions and silently loses the imports below it.
    file.endsWith(".tsx") || file.endsWith(".jsx")
      ? ts.ScriptKind.TSX
      : ts.ScriptKind.TS,
  );
  const specs: string[] = [];
  // TRIPLE-SLASH REFERENCES ARE NOT AST NODES. `/// <reference path="…" />`
  // lands in `SourceFile.referencedFiles`, and TypeScript pulls the target into
  // the program — but `forEachChild` never visits it, so the walk below cannot
  // see it. A reference to a prototype entry point therefore left this guard
  // green. Reference paths are FILE paths rather than module specifiers, so a
  // bare-looking one like `components/x.tsx` still means "relative to me"; the
  // `./` prefix makes that explicit for the resolver.
  for (const ref of source.referencedFiles) {
    specs.push(ref.fileName.startsWith(".") ? ref.fileName : `./${ref.fileName}`);
  }
  const literal = (node: ts.Node | undefined): void => {
    if (node && ts.isStringLiteralLike(node)) specs.push(node.text);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      literal(node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      literal(node.moduleReference.expression);
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isDynamicImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(callee) && callee.text === "require";
      if (isDynamicImport || isRequire) literal(node.arguments[0]);
    } else if (ts.isImportTypeNode(node)) {
      // `type E = import("@/x").Thing` — the TYPE position. It is an
      // ImportTypeNode, NOT a CallExpression, so the dynamic-import branch
      // above never sees it. Missing this contradicted the policy stated two
      // paragraphs up: type-only coupling counts, and this is the syntax that
      // expresses it most directly.
      literal(node.argument.kind === ts.SyntaxKind.LiteralType
        ? (node.argument as ts.LiteralTypeNode).literal
        : undefined);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return specs;
}

/**
 * The repository's OWN compiler options, read from `tsconfig.json`.
 *
 * Resolution is not reimplemented below, for the same reason the extractor
 * above is not a regex: every hand-rolled approximation of the compiler has so
 * far been wrong in a way that made this guard quietly permissive.
 */
const COMPILER_OPTIONS: ts.CompilerOptions = (() => {
  const raw = ts.readConfigFile(join(ROOT, "tsconfig.json"), ts.sys.readFile);
  const options = ts.parseJsonConfigFileContent(raw.config ?? {}, ts.sys, ROOT).options;
  // `allowJs` only WIDENS what resolves, which is the safe direction for a
  // guard: without it a `.js` intermediary between an app route and the
  // prototype would resolve to nothing and break the chain.
  return { ...options, allowJs: true };
})();

// Resolution is quadratic-ish across a large graph without this.
const RESOLUTION_CACHE = ts.createModuleResolutionCache(
  ROOT,
  (x) => x,
  COMPILER_OPTIONS,
);

/**
 * Resolve one specifier to a repo-relative file, or null for a package.
 *
 * ASKS THE COMPILER. The previous version probed a hand-written candidate list
 * — `base`, `base.ts`, `base.tsx`, `base/index.*` — which reproduced only
 * extensionless resolution. This repository is on `moduleResolution: "bundler"`,
 * where TypeScript SUBSTITUTES a `.js` suffix and resolves the `.tsx` source,
 * so `"@/components/waitlist/admission-row.js"` is a working import that the
 * candidate list turned into `.js`, `.js.ts`, `.js.tsx` and `.js/index.ts` —
 * none of which exist. It returned null, produced no edge, and the guard stayed
 * green while the component was application-reachable. The repository already
 * pins that `.js` behaviour elsewhere, in
 * tests/app/finance/financials-truth.test.ts.
 *
 * `ts.resolveModuleName` handles suffix substitution, `paths`, `baseUrl`,
 * extension order and index files in one call, from the repo's own config.
 */
const RESOLUTION_MEMO = new Map<string, string | null>();

function resolveSpecifier(fromFile: string, spec: string): string | null {
  // ONLY `@/…` AND RELATIVE SPECIFIERS CAN REACH A REPO FILE, and that is a
  // provable property of this tsconfig rather than an assumption: `paths` maps
  // `@/*` alone and `baseUrl` is unset, so a bare specifier resolves into
  // node_modules or nowhere. Skipping them is what keeps this walk fast enough
  // to stay well inside its timeout — every app file imports `react` and
  // `next/*`, and resolving those is the dominant cost. The premise is pinned
  // by "the fast path rests on a tsconfig property" below, so adding a
  // `baseUrl` turns that test red instead of quietly opening a hole here.
  if (!spec.startsWith("@/") && !spec.startsWith(".")) return null;

  // Resolution depends on the containing DIRECTORY, not the exact file, so the
  // same specifier from a hundred siblings is one lookup.
  const key = `${dirname(fromFile)}\u0000${spec}`;
  const memo = RESOLUTION_MEMO.get(key);
  if (memo !== undefined) return memo;

  const resolved = ts.resolveModuleName(
    spec,
    join(ROOT, fromFile),
    COMPILER_OPTIONS,
    ts.sys,
    RESOLUTION_CACHE,
  );
  const target = resolved.resolvedModule;
  let rel =
    !target || target.isExternalLibraryImport
      ? null
      : relative(ROOT, target.resolvedFileName);
  if (rel === null && spec.startsWith(".")) {
    // A LITERAL PATH THAT EXISTS. Module resolution will not accept a specifier
    // ending in `.tsx`, but a reference directive is a file path and legitimately
    // does. Probing the exact path is not a second resolution algorithm — it is
    // the only thing a reference directive means.
    const literal = join(dirname(fromFile), spec);
    try {
      if (statSync(join(ROOT, literal)).isFile()) rel = literal;
    } catch {
      // not a file; leave unresolved
    }
  }
  // Outside the repo, or inside node_modules by another route: not our graph.
  const answer =
    rel === null || rel.startsWith("..") || rel.split(sep).includes("node_modules")
      ? null
      : rel;
  RESOLUTION_MEMO.set(key, answer);
  return answer;
}

/**
 * The SHIPPED APPLICATION entry points — the roots of everything that runs in
 * production.
 *
 * `app/` is the router. The root-level special files are Next's own entry
 * points and ship with every request; they were missing entirely, which meant an
 * import placed in `middleware.ts` was invisible to a guard whose whole job is
 * reachability — and then they were enumerated in TypeScript only, which left
 * `middleware.js` invisible the same way.
 *
 * DELIBERATELY ABSENT: `e2e/`, `scripts/`, and the test tree. They are not
 * shipped, so a value constructed there cannot make the practitioner surface
 * live — see the note above the adapter guard.
 */
const SPECIAL_ROOT_BASENAMES = [
  "middleware",
  "instrumentation",
  "instrumentation-client",
] as const;

/**
 * Every spelling a special root could have, whether or not it exists today.
 *
 * Pure and separately asserted, because "did we enumerate `middleware.js`?" is
 * a question about this list rather than about the current tree — and the tree
 * having only `.ts` files is precisely why the omission was invisible.
 *
 * The vocabulary is the walker's, so a root cannot be a kind of file the walk
 * would refuse to follow. Being broader than Next strictly accepts for a given
 * basename is deliberate: an extra candidate that does not exist costs one
 * `statSync`, while a missing one is a silent hole in a reachability claim.
 */
function specialRootCandidates(): string[] {
  return SPECIAL_ROOT_BASENAMES.flatMap((base) =>
    APPLICATION_EXTENSIONS.map((ext) => `${base}.${ext}`),
  );
}

function shippedApplicationRoots(): string[] {
  const roots = [...walk("app")];
  for (const rel of specialRootCandidates()) {
    try {
      if (statSync(join(ROOT, rel)).isFile()) roots.push(rel);
    } catch {
      // not present in this tree
    }
  }
  return roots;
}

/**
 * Every module transitively reachable from the shipped application, with the
 * path that got there — a boolean answer to "is this live?" is far less useful
 * in a failure than the chain that made it live.
 *
 * THE ROOTS ARE SHIPPED ENTRY POINTS; THE TRAVERSAL GOES ANYWHERE. An
 * application file that reaches `#683` through a helper in `lib/`, a barrel in
 * `components/`, or any other directory is still reachable, and this walk
 * follows it. Narrowing WHAT IS CLAIMED must never narrow WHERE THE WALK LOOKS.
 */
function reachableFromApp(): Map<string, string[]> {
  const reached = new Map<string, string[]>();
  const queue: string[] = [];
  for (const entry of shippedApplicationRoots()) {
    reached.set(entry, [entry]);
    queue.push(entry);
  }
  while (queue.length > 0) {
    const current = queue.shift()!;
    const path = reached.get(current)!;
    let text: string;
    try {
      text = readFileSync(join(ROOT, current), "utf8");
    } catch {
      continue;
    }
    for (const spec of importSpecifiers(current, text)) {
      const target = resolveSpecifier(current, spec);
      if (target === null || reached.has(target)) continue;
      reached.set(target, [...path, target]);
      queue.push(target);
    }
  }
  return reached;
}

const CONTRACT_MODULE = "lib/waitlist/invite-to-book-contract.ts";

/**
 * Every reason one source file looks like an invitation adapter.
 *
 * SEPARATE FROM THE REPO SCAN ON PURPOSE. Run only over a clean tree, a
 * detector reports nothing and cannot be told apart from one that is broken —
 * so this is exercised directly against synthetic sources below, including the
 * bare object literal that defeated the previous nominal check.
 *
 * Two signals, both from the syntax tree:
 *
 *   SHAPE       an object literal or class declaring every member the
 *               interface requires IS an adapter, whatever it says about
 *               itself. TypeScript is structurally typed; the previous check
 *               matched `implements`, a keyword nobody has to write.
 *   ANNOTATION  a value declared as, or asserted to satisfy, the type.
 */
/** Object literals a module declares, and the bindings it pulls in from other
 *  modules. Both halves are needed to follow a spread: `{...parts}` is answered
 *  by `locals` when `parts` is declared here and by `imported` when it is not. */
type LiteralIndex = {
  locals: Map<string, ts.ObjectLiteralExpression>;
  imported: Map<string, { spec: string; exported: string }>;
};

function literalIndexOf(source: ts.SourceFile): LiteralIndex {
  const locals = new Map<string, ts.ObjectLiteralExpression>();
  const imported = new Map<string, { spec: string; exported: string }>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      locals.set(node.name.text, node.initializer);
    } else if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const spec = node.moduleSpecifier.text;
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const el of bindings.elements) {
          imported.set(el.name.text, { spec, exported: (el.propertyName ?? el.name).text });
        }
      }
      if (node.importClause?.name) {
        imported.set(node.importClause.name.text, { spec, exported: "default" });
      }
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.exportClause &&
      ts.isNamedExports(node.exportClause)
    ) {
      // `export { parts } from "./m"` binds nothing locally, so a later lookup
      // for `parts` has to follow the re-export or it dead-ends here.
      for (const el of node.exportClause.elements) {
        imported.set(el.name.text, {
          spec: node.moduleSpecifier.text,
          exported: (el.propertyName ?? el.name).text,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return { locals, imported };
}

/** Follow an imported binding to the literal the exporting module names, so a
 *  shape assembled from parts that live in other files is still one shape.
 *  Uses `resolveSpecifier` — the resolver the reachability walk already uses —
 *  so "inside the repository" means the same thing in both places. */
function exportedMemberNames(
  fromRel: string,
  binding: { spec: string; exported: string },
  seen: Set<unknown>,
): string[] {
  const target = resolveSpecifier(fromRel, binding.spec);
  if (target === null) return [];
  const key = `${target}#${binding.exported}`;
  if (seen.has(key)) return [];
  seen.add(key);
  let text: string;
  try {
    text = readFileSync(join(ROOT, target), "utf8");
  } catch {
    return [];
  }
  const source = ts.createSourceFile(
    target,
    text,
    ts.ScriptTarget.Latest,
    false,
    target.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const index = literalIndexOf(source);
  const local = index.locals.get(binding.exported);
  if (local) return literalMemberNames(local, target, index, seen);
  const reExported = index.imported.get(binding.exported);
  return reExported ? exportedMemberNames(target, reExported, seen) : [];
}

/** Member names a literal contributes, following spreads — same-file and ACROSS
 *  MODULE BOUNDARIES. `seen` breaks both `const a = {...b}; const b = {...a};`
 *  and an import cycle between two files. */
function literalMemberNames(
  literal: ts.ObjectLiteralExpression,
  rel: string,
  index: LiteralIndex,
  seen: Set<unknown>,
): string[] {
  if (seen.has(literal)) return [];
  seen.add(literal);
  const out: string[] = [];
  for (const prop of literal.properties) {
    if (ts.isSpreadAssignment(prop)) {
      if (ts.isObjectLiteralExpression(prop.expression)) {
        out.push(...literalMemberNames(prop.expression, rel, index, seen));
      } else if (ts.isIdentifier(prop.expression)) {
        const local = index.locals.get(prop.expression.text);
        if (local) {
          out.push(...literalMemberNames(local, rel, index, seen));
        } else {
          const binding = index.imported.get(prop.expression.text);
          if (binding) out.push(...exportedMemberNames(rel, binding, seen));
        }
      }
    } else if (
      prop.name &&
      (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))
    ) {
      out.push(prop.name.text);
    }
  }
  return out;
}

function adapterSignals(
  rel: string,
  text: string,
  members: ReadonlyArray<string>,
): string[] {
  // Cheap prefilter, and the third clause is load-bearing rather than defensive.
  // "A complete implementation must contain every member name, so it must
  // contain this one" STOPPED BEING TRUE the moment spreads were followed across
  // modules: `export const a = { ...partsA, ...partsB }` names no member at all.
  // Without the spread clause the split-shape test below silently passes for the
  // wrong reason, which is how this class of gap survived twice already.
  if (
    !text.includes(members[0]) &&
    !text.includes("WaitlistInvitationAdapter") &&
    !/\.\.\.\s*[A-Za-z_$]/.test(text)
  ) {
    return [];
  }
  const source = ts.createSourceFile(
    rel,
    text,
    ts.ScriptTarget.Latest,
    false,
    rel.endsWith(".tsx") || rel.endsWith(".jsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const found: string[] = [];

  // SPREADS CARRY MEMBERS, AND SPLITTING A LITERAL USED TO EVADE THIS TWICE.
  // Neither half declares the full set and the merged literal declares no named
  // property at all, so the shape signal saw nothing while the merge typechecks
  // as a real adapter. First the halves were same-file; the fix indexed local
  // literals by name. Then the halves moved into two OTHER modules and the same
  // evasion worked again — a measured gap, not a hypothetical one.
  //
  // So spreads are now followed across module boundaries too, by the resolver
  // the reachability walk already uses. Recording that seam as a "known bound"
  // was the cheaper-looking option and it is what let the second escape happen.
  const index = literalIndexOf(source);

  const names = (
    list: ReadonlyArray<{ name?: ts.PropertyName | ts.BindingName }>,
  ): string[] =>
    list
      .map((m) =>
        m.name && (ts.isIdentifier(m.name) || ts.isStringLiteral(m.name))
          ? m.name.text
          : null,
      )
      .filter((n): n is string => n !== null);
  const mentionsType = (node: ts.Node | undefined): boolean =>
    node !== undefined && /\bWaitlistInvitationAdapter\b/.test(node.getText(source));

  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      const declared = literalMemberNames(node, rel, index, new Set());
      if (members.every((m) => declared.includes(m))) found.push(`${rel} (shape)`);
    } else if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      const declared = names(node.members);
      if (members.every((m) => declared.includes(m))) found.push(`${rel} (shape)`);
      for (const heritage of node.heritageClauses ?? []) {
        // Read from the tree, so `implements` inside a comment or a string is
        // not one.
        if (heritage.token === ts.SyntaxKind.ImplementsKeyword && mentionsType(heritage)) {
          found.push(`${rel} (implements)`);
        }
      }
    } else if (ts.isVariableDeclaration(node) && mentionsType(node.type)) {
      found.push(`${rel} (annotation)`);
    } else if (ts.isSatisfiesExpression(node) && mentionsType(node.type)) {
      found.push(`${rel} (satisfies)`);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return found;
}


/** The member names `WaitlistInvitationAdapter` requires, read from the
 *  interface declaration itself so a sixth method tightens the structural check
 *  automatically rather than being silently optional. */
function adapterMemberNames(): string[] {
  const source = ts.createSourceFile(
    CONTRACT_MODULE,
    readFileSync(join(ROOT, CONTRACT_MODULE), "utf8"),
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TS,
  );
  let names: string[] = [];
  ts.forEachChild(source, (node) => {
    if (
      ts.isInterfaceDeclaration(node) &&
      node.name.text === "WaitlistInvitationAdapter"
    ) {
      names = node.members
        .map((m) => (m.name && ts.isIdentifier(m.name) ? m.name.text : null))
        .filter((n): n is string => n !== null);
    }
  });
  if (names.length === 0) {
    throw new Error("WaitlistInvitationAdapter has no readable members");
  }
  return names;
}

describe("this module is UNREACHABLE from the application", () => {
  // TIMEOUT STATED, AND WELL ABOVE THE MEASURED COST. This walk resolves every
  // specifier in the application graph with the real compiler; it ran at ~6.7s
  // against vitest's 5s default and so passed alone and failed under
  // full-suite CPU contention. A ceiling that equals its target is not a
  // ceiling — the same lesson the CI budgets in CLAUDE.md record three times.
  // INDEPENDENT ORACLE — deliberately NOT derived from the implementation.
  //
  // The previous version of this proof looped over APPLICATION_EXTENSIONS on
  // BOTH sides, so it asserted only that the list equals itself. Delete "jsx"
  // and the walker stopped seeing JSX, the roots stopped generating `.jsx`, the
  // expectation stopped expecting it, and the suite stayed green — a guard that
  // cannot fail is not a guard.
  //
  // These two lists are therefore written out by hand. There is no repo-wide
  // extension constant to derive them from: `tsconfig.json` includes `**/*.ts`
  // and `**/*.tsx` only, because the application is TypeScript today. That is
  // the reason the JavaScript spellings must still be covered — this guard
  // exists to fail on the change that introduces one, not to describe the tree
  // as it currently stands.
  const EXPECTED_SUPPORTED_APPLICATION_EXTENSIONS = [
    "ts",
    "tsx",
    "js",
    "jsx",
    "mjs",
    "cjs",
  ] as const;

  const EXPECTED_SPECIAL_ROOT_NAMES = [
    "middleware",
    "instrumentation",
    "instrumentation-client",
  ] as const;

  it("the walker vocabulary is EXACTLY the supported vocabulary", () => {
    // Equality, not containment: an extension quietly dropped is the defect
    // being guarded against, and an extension quietly added is a widening
    // nobody reviewed.
    expect(
      [...APPLICATION_EXTENSIONS].sort(),
      "APPLICATION_EXTENSIONS drifted from the supported application vocabulary",
    ).toEqual([...EXPECTED_SUPPORTED_APPLICATION_EXTENSIONS].sort());

    // The constant feeds a regular expression, so pin the regexp against the
    // same independent oracle — building it differently must not silently
    // narrow what the walk accepts.
    for (const ext of EXPECTED_SUPPORTED_APPLICATION_EXTENSIONS) {
      expect(APPLICATION_FILE.test(`probe.${ext}`), `${ext} must be walked`).toBe(true);
    }
    expect(APPLICATION_FILE.test("probe.md")).toBe(false);
    expect(APPLICATION_FILE.test("probe.json")).toBe(false);
  });

  it("special roots are the full cross product of NAMES x SUPPORTED EXTENSIONS", () => {
    // Expected candidates are generated from the independent oracle on both
    // axes, so neither a dropped extension nor a dropped root name can shrink
    // the expectation along with the implementation.
    const expected = EXPECTED_SPECIAL_ROOT_NAMES.flatMap((name) =>
      EXPECTED_SUPPORTED_APPLICATION_EXTENSIONS.map((ext) => `${name}.${ext}`),
    );
    expect(expected).toContain("middleware.js");
    expect(expected.length).toBe(18);

    expect(
      [...specialRootCandidates()].sort(),
      "a supported shipped entry point spelling is no longer enumerated as a root",
    ).toEqual([...expected].sort());

    expect([...SPECIAL_ROOT_BASENAMES].sort()).toEqual(
      [...EXPECTED_SPECIAL_ROOT_NAMES].sort(),
    );

    // Roots are special files and `app/` only. A detached script or test does
    // not become a shipped entry point merely by existing.
    expect(
      specialRootCandidates().some(
        (c) => c.startsWith("scripts/") || c.startsWith("tests/"),
      ),
    ).toBe(false);
  });

  it("no prototype entry point is reachable from the SHIPPED APPLICATION, at ANY depth", { timeout: 30_000 }, () => {
    const reached = reachableFromApp();

    // NON-VACUITY, THREE WAYS. A traversal that silently resolved nothing would
    // report every prototype file unreachable and read as reassurance.
    expect(reached.size, "the import graph walk found almost nothing").toBeGreaterThan(200);
    // It genuinely follows edges: the LIVE model is reachable, and not because
    // it sits under app/ — it is pulled in through an import.
    const liveModel = reached.get("lib/waitlist/admission-model.ts");
    expect(liveModel, "the live model is no longer reachable from the shipped application").toBeDefined();
    expect(liveModel!.length).toBeGreaterThan(1);
    // And it follows them TRANSITIVELY, not just one hop out of app/.
    const deepest = Math.max(...[...reached.values()].map((p) => p.length));
    expect(deepest, "the walk never went beyond a single hop").toBeGreaterThan(3);

    for (const entry of PROTOTYPE_ENTRY_POINTS) {
      const path = reached.get(entry);
      expect(
        path === undefined ? null : path.join("\n  -> "),
        `a shipped application path now reaches ${entry}, which no server action carries`,
      ).toBeNull();
    }
  });

  it("reads imports from the syntax tree, not from a pattern", () => {
    // THE EXTRACTOR IS THE GUARD. Two earlier versions were text searches and
    // both had holes: the first missed anything reached through a component,
    // the second missed a comment between `from` and the module string —
    // legal, compiles, zero parse diagnostics, no edge produced.
    //
    // These cases are pinned here so the extractor cannot quietly regress to
    // pattern-matching. Each is a form a bundler follows and a regex tends not
    // to.
    const cases: ReadonlyArray<[string, string, string]> = [
      ["plain static", 'import { A } from "@/x/a";', "@/x/a"],
      ["comment before specifier", 'import { A } from /* why */ "@/x/a";', "@/x/a"],
      ["comment and newline", 'import { A } from\n  // note\n  "@/x/a";', "@/x/a"],
      ["side-effect", 'import "@/x/a";', "@/x/a"],
      ["re-export", 'export { A } from "@/x/a";', "@/x/a"],
      ["export star", 'export * from "@/x/a";', "@/x/a"],
      ["dynamic", 'const f = () => import("@/x/a");', "@/x/a"],
      ["require", 'const a = require("@/x/a");', "@/x/a"],
      ["import equals", 'import a = require("@/x/a");', "@/x/a"],
      // Erased at compile time, but it still couples an application surface to
      // the prototype, and this boundary errs toward reachable.
      ["type-only", 'import type { A } from "@/x/a";', "@/x/a"],
      ["single quotes", "import { A } from '@/x/a';", "@/x/a"],
      // THE TYPE POSITION. An ImportTypeNode, not a CallExpression — the
      // dynamic-import branch never sees it, which contradicted the stated
      // policy that type-only coupling counts.
      ["import-type node", 'type E = import("@/x/a").Thing;', "@/x/a"],
      ["import-type, nested in a generic", 'type E = Array<import("@/x/a").Thing>;', "@/x/a"],
      // NOT AN AST NODE AT ALL. `referencedFiles`, which `forEachChild` never
      // visits, while TypeScript still pulls the target into the program.
      ["triple-slash reference", '/// <reference path="./a.tsx" />\nexport const v = 1;', "./a.tsx"],
      [
        "reference without a ./ prefix",
        '/// <reference path="sub/a.tsx" />\nexport const v = 1;',
        "./sub/a.tsx",
      ],
    ];
    for (const [label, source, expected] of cases) {
      expect(importSpecifiers("probe.ts", source), `${label} produced no edge`).toContain(
        expected,
      );
    }

    // A .tsx file must be parsed as TSX, or JSX reads as type assertions and
    // every import below it is silently lost.
    const tsx = 'import { A } from "@/x/a";\nexport const V = () => <div a={1 as number} />;';
    expect(importSpecifiers("probe.tsx", tsx)).toContain("@/x/a");

    // NO FALSE EDGES: a module name inside a string or a comment is not an
    // import, and treating it as one would make the guard cry wolf until
    // somebody loosened it.
    const notImports = [
      'const s = "import { A } from \'@/x/fake\'";',
      "// import { A } from \"@/x/fake\";",
      '/* import { A } from "@/x/fake"; */',
    ].join("\n");
    expect(importSpecifiers("probe.ts", notImports)).not.toContain("@/x/fake");
  });

  it("the fast path rests on a tsconfig property, not on a guess", () => {
    // `resolveSpecifier` short-circuits bare specifiers as packages. That is
    // only sound while `paths` maps `@/*` alone and `baseUrl` is unset — add a
    // `baseUrl` and `import "lib/waitlist/b4-invitation-draft"` would resolve
    // into the repo while the walk skipped it. This fails first if that
    // changes.
    expect(COMPILER_OPTIONS.baseUrl).toBeUndefined();
    expect(Object.keys(COMPILER_OPTIONS.paths ?? {})).toEqual(["@/*"]);
    // And the property itself, checked rather than reasoned about.
    for (const bare of ["lib/waitlist/b4-invitation-draft", "components/waitlist/admission-row"]) {
      const resolved = ts.resolveModuleName(
        bare,
        join(ROOT, "app/probe.ts"),
        COMPILER_OPTIONS,
        ts.sys,
      );
      expect(resolved.resolvedModule?.resolvedFileName, `${bare} reached a repo file`).toBeUndefined();
    }
  });

  it("resolves specifiers with the compiler, not a candidate list", () => {
    // The previous resolver probed `base`, `base.ts`, `base.tsx`,
    // `base/index.*`. This repository is on `moduleResolution: "bundler"`,
    // where TypeScript SUBSTITUTES a `.js` suffix and resolves the `.tsx`
    // source — so a working import turned into `.js`, `.js.ts`, `.js.tsx` and
    // `.js/index.ts`, none of which exist. Null, no edge, guard green.
    const from = "app/(app)/settings/waitlist/page.tsx";

    // The case that was blind, and its extensionless twin.
    expect(resolveSpecifier(from, "@/components/waitlist/admission-row.js")).toBe(
      "components/waitlist/admission-row.tsx",
    );
    expect(resolveSpecifier(from, "@/components/waitlist/admission-row")).toBe(
      "components/waitlist/admission-row.tsx",
    );
    // `.ts` sources, and the alias itself.
    expect(resolveSpecifier(from, "@/lib/waitlist/admission-model")).toBe(
      "lib/waitlist/admission-model.ts",
    );
    expect(resolveSpecifier(from, "@/lib/waitlist/admission-model.js")).toBe(
      "lib/waitlist/admission-model.ts",
    );
    // Relative specifiers resolve from the importing file, not from the root.
    expect(
      resolveSpecifier(
        "components/waitlist/admission-row.tsx",
        "@/lib/waitlist/b4-invitation-draft",
      ),
    ).toBe("lib/waitlist/b4-invitation-draft.ts");

    // NOT OUR GRAPH: packages resolve, and must still be excluded, or the walk
    // would wander into node_modules and take forever.
    expect(resolveSpecifier(from, "react")).toBeNull();
    expect(resolveSpecifier(from, "next/link")).toBeNull();
    // And a specifier that resolves to nothing is simply not an edge.
    expect(resolveSpecifier(from, "@/does/not/exist")).toBeNull();
  });

  it("guards the COMPONENTS, not only the modules they import", () => {
    // The premise the entry-point list rests on: each component really does
    // pull the prototype in, so a component becoming reachable would make the
    // unwired half live. If that stopped being true the list would be guarding
    // files that no longer matter, and this says so.
    for (const component of [
      "components/waitlist/admission-row.tsx",
      "components/waitlist/invite-composer.tsx",
    ]) {
      const text = readFileSync(join(ROOT, component), "utf8");
      const specs = importSpecifiers(component, text);
      expect(
        specs.some((s) => s.includes("b4-invitation-draft")),
        `${component} no longer imports the prototype model`,
      ).toBe(true);
      expect(PROTOTYPE_ENTRY_POINTS as ReadonlyArray<string>).toContain(component);
    }
  });

  it("no SHIPPED APPLICATION path binds an adapter for this surface", () => {
    // THE REPOSITORY-WIDE CLAIM IS RETIRED, AND IT WAS THE DEFECT.
    //
    // This test used to assert that NOTHING ANYWHERE in the repository could
    // structurally satisfy `WaitlistInvitationAdapter`. That is not the product
    // invariant, and chasing it produced four rounds of findings that were all
    // really the same complaint: the claim was broader than the property. Each
    // round widened the detector — nominal clause, then shapes, then same-file
    // spreads, then imported spreads and every source root — and each widening
    // created the next gap, because "no value anywhere can have this shape" is
    // not a property a source scan can honestly close.
    //
    // The load-bearing invariant is narrower and true:
    //
    //     #683 stays UNWIRED and UNREACHABLE from the shipped application until
    //     a deliberately reviewed binding lands.
    //
    // A test helper, a script, an e2e fixture or a future isolated
    // implementation may construct an adapter without making the practitioner
    // surface live. Those are not application authority, and calling them
    // violations trains the reader to dismiss this test.
    //
    // So the scan set is DERIVED, not enumerated: exactly the modules the
    // shipped application can reach. That is the same graph the dormancy guard
    // above walks, so the two cannot disagree, and an adapter assembled from
    // IMPORTED SPREADS is caught the moment an application path reaches the
    // module holding it — which is the only moment it matters.
    const members = adapterMemberNames();
    // Derived from the interface, not copied beside it: a sixth method on the
    // contract tightens this automatically instead of being silently optional.
    expect(members).toContain("inviteToBook");
    expect(members.length).toBeGreaterThan(4);

    const reachable = [...reachableFromApp().keys()];
    // Non-vacuity: the application graph must actually have been walked, or an
    // empty set would report "no adapter is reachable" for the wrong reason.
    expect(reachable.length).toBeGreaterThan(200);

    const offenders = reachable.flatMap((rel) =>
      rel === CONTRACT_MODULE
        ? []
        : adapterSignals(rel, readFileSync(join(ROOT, rel), "utf8"), members),
    );

    expect(
      [...new Set(offenders)].sort(),
      "a module the shipped application can reach is an invitation adapter",
    ).toEqual([]);
  });
});

describe("the adapter detector, exercised on sources that ARE adapters", () => {
  const M = adapterMemberNames();
  const CAPS =
    "capabilities: { enforcesScope: true, canResend: true, canCancel: true, canReturnToWaitlist: true, canRemove: true },";
  const LITERAL_BODY = [CAPS, ...M.filter((m) => m !== "capabilities").map((m) => `async ${m}() { return null as never; },`)].join("\n");
  const MID = Math.ceil(M.length / 2);
  const memberLine = (m: string) =>
    m === "capabilities" ? CAPS : `async ${m}() { return null as never; },`;
  const HALF_A = M.slice(0, MID).map(memberLine).join("\n");
  const HALF_B = M.slice(MID).map(memberLine).join("\n");
  const CLASS_BODY = [
    "capabilities = { enforcesScope: true, canResend: true, canCancel: true, canReturnToWaitlist: true, canRemove: true };",
    ...M.filter((m) => m !== "capabilities").map((m) => `async ${m}() { return null as never; }`),
  ].join("\n");

  it("catches every shape a real adapter can take", () => {
    // The bare object literal is the one that defeated the previous nominal
    // check — it typechecks as a real adapter and says nothing about itself.
    const adapters: ReadonlyArray<[string, string]> = [
      ["bare object literal", `export const a = {\n${LITERAL_BODY}\n};`],
      [
        "annotated const",
        `export const a: WaitlistInvitationAdapter = {\n${LITERAL_BODY}\n};`,
      ],
      [
        "satisfies expression",
        `export const a = {\n${LITERAL_BODY}\n} satisfies WaitlistInvitationAdapter;`,
      ],
      ["class with implements", `export class A implements WaitlistInvitationAdapter {\n${CLASS_BODY}\n}`],
      ["class WITHOUT implements", `export class A {\n${CLASS_BODY}\n}`],
      ["returned from a factory", `export function make() {\n  return {\n${LITERAL_BODY}\n  };\n}`],
      ["assigned inside a function", `function f() {\n  const a = {\n${LITERAL_BODY}\n  };\n  return a;\n}`],
      // SPREAD SHAPES. Neither half declares the full set, and the merged
      // literal declares no named property at all — it evaded the shape signal
      // entirely while typechecking as a real adapter.
      [
        "split across two literals",
        `const half = {\n${HALF_A}\n};\nconst rest = {\n${HALF_B}\n};\nexport const a = { ...half, ...rest };`,
      ],
      [
        "re-wrapped whole literal",
        `const base = {\n${LITERAL_BODY}\n};\nexport const a = { ...base };`,
      ],
      [
        "spread chained through a third",
        `const c = {\n${HALF_B}\n};\nconst b = { ...c };\nconst d = {\n${HALF_A}\n};\nexport const a = { ...d, ...b };`,
      ],
      [
        "inline nested spread",
        `export const a = { ...{\n${HALF_A}\n}, ...{\n${HALF_B}\n} };`,
      ],
    ];
    for (const [label, source] of adapters) {
      expect(
        adapterSignals("probe.ts", source, M),
        `${label} was not detected as an adapter`,
      ).not.toEqual([]);
    }
  });

  it("does not cry wolf, or the guard gets loosened", () => {
    const innocent: ReadonlyArray<[string, string]> = [
      [
        "partial shape, one member missing",
        `export const a = {\n${CAPS}\n  async ${M[1] ?? "inviteToBook"}() { return null as never; },\n};`,
      ],
      [
        "type-only re-export of the name",
        'export type { WaitlistInvitationAdapter } from "@/lib/waitlist/invite-to-book-contract";',
      ],
      [
        "the name in a comment",
        "// a WaitlistInvitationAdapter would go here one day\nexport const a = 1;",
      ],
      [
        "the name in a string",
        'export const doc = "implements WaitlistInvitationAdapter";',
      ],
      ["an unrelated object", 'export const a = { inviteToBook: 1 };'],
    ];
    for (const [label, source] of innocent) {
      expect(adapterSignals("probe.ts", source, M), `${label} was falsely flagged`).toEqual([]);
    }
  });

  it("does not hang on a spread cycle", () => {
    // `const a = { ...b }; const b = { ...a };` parses fine and would recurse
    // for ever without the seen-set.
    //
    // THE MEMBER NAME IS LOAD-BEARING. Without it the cheap prefilter returns
    // before the walk begins, the recursion never runs, and this asserts
    // nothing — which is exactly what the first version of this test did:
    // it passed with the cycle guard deleted.
    const cyclic = `const a = { ...b, ${CAPS} };\nconst b = { ...a };\nexport const c = a;`;
    expect(cyclic).toContain(M[0]);
    expect(adapterSignals("probe.ts", cyclic, M)).toEqual([]);
  });

  it("a shape SPLIT ACROSS MODULES is still one shape", () => {
    // The evasion this closes, pinned on real files so it cannot rot into an
    // assertion about a string literal: two modules each hold part of the
    // adapter, a third spreads them together, and no single file declares the
    // full set. NEGATIVE CONTROL: deleting the `index.imported` branch in
    // `literalMemberNames` turns this red.
    const dir = "tests/fixtures/adapter-spread";
    const read = (f: string) => readFileSync(join(ROOT, dir, f), "utf8");
    const halves = [
      ...literalMemberNames(
        literalIndexOf(
          ts.createSourceFile("a.ts", read("parts-a.ts"), ts.ScriptTarget.Latest, false),
        ).locals.get("partsA")!,
        `${dir}/parts-a.ts`,
        literalIndexOf(
          ts.createSourceFile("a.ts", read("parts-a.ts"), ts.ScriptTarget.Latest, false),
        ),
        new Set(),
      ),
      ...literalMemberNames(
        literalIndexOf(
          ts.createSourceFile("b.ts", read("parts-b.ts"), ts.ScriptTarget.Latest, false),
        ).locals.get("partsB")!,
        `${dir}/parts-b.ts`,
        literalIndexOf(
          ts.createSourceFile("b.ts", read("parts-b.ts"), ts.ScriptTarget.Latest, false),
        ),
        new Set(),
      ),
    ];
    // Non-vacuity, and a self-explaining failure if the interface gains a
    // member: the fixtures must together cover exactly the contract, and
    // neither half may cover it alone.
    expect([...halves].sort()).toEqual([...M].sort());
    expect(adapterSignals(`${dir}/parts-a.ts`, read("parts-a.ts"), M)).toEqual([]);
    expect(adapterSignals(`${dir}/parts-b.ts`, read("parts-b.ts"), M)).toEqual([]);

    expect(
      adapterSignals(`${dir}/assembled.ts`, read("assembled.ts"), M),
    ).toContain(`${dir}/assembled.ts (shape)`);
  });

  it("the structural scan is a tripwire; REACHABILITY is the invariant", () => {
    // Still uncrossed, and stated: this reads source, it does not run it, so a
    // value built by `Object.assign` or returned from a factory is not tracked.
    expect(
      adapterSignals("probe.ts", "export const a = Object.assign({}, parts);", M),
    ).toEqual([]);

    // THAT BOUND IS NOT LOAD-BEARING, and this is the reason. Binding an
    // adapter to the practitioner surface requires IMPORTING one of its entry
    // points — including the contract module that declares the type — and the
    // dormancy guard catches that at any depth regardless of how the adapter
    // value was assembled. The structural scan only shortens the distance
    // between someone writing an adapter and someone being told about it.
    expect(PROTOTYPE_ENTRY_POINTS).toContain(CONTRACT_MODULE);
  });

  it("tightens automatically when the contract grows a method", () => {
    // The member list is DERIVED from the interface, so a source that satisfies
    // today's contract stops counting the moment a sixth method is required.
    const withExtra = [...M, "cancelEverything"];
    const todaysAdapter = `export const a = {\n${LITERAL_BODY}\n};`;
    expect(adapterSignals("probe.ts", todaysAdapter, M)).not.toEqual([]);
    expect(adapterSignals("probe.ts", todaysAdapter, withExtra)).toEqual([]);
  });
});

describe("DOM ids are unique per entry, injectively", () => {
  it("never maps two distinct entries onto one namespace", () => {
    // The first version replaced every unsafe character with `-`, so `a/b` and
    // `a:b` both became `wl-a-b-…` and two rows rendered together collided —
    // the exact defect the shared factory was introduced to remove, one level
    // deeper. Centralising a derivation does not make it correct.
    const entries = [
      "a/b", "a:b", "a-b", "a_b", "a.b", "a b", "a#b", "a@b",
      // The escape alphabet fed back in: an input that LOOKS like an encoded
      // form must not collide with the thing it looks like.
      "a_2f_b", "a_5f_b", "wl-a-b",
      "", "a", "A", "0",
      "\u00e9", "\u4e2d\u6587", '"q"', "<script>",
    ];
    const seen = new Map<string, string>();
    for (const entry of entries) {
      const id = waitlistDomId(entry, "reason-remove");
      const previous = seen.get(id);
      expect(
        previous,
        `${JSON.stringify(entry)} and ${JSON.stringify(previous)} share the id ${id}`,
      ).toBeUndefined();
      seen.set(id, entry);
      // Still a usable HTML id for every input, including empty and non-ASCII.
      expect(id, `${JSON.stringify(entry)} produced an unusable id`).toMatch(
        /^[A-Za-z][A-Za-z0-9_-]*$/,
      );
    }
    expect(seen.size).toBe(entries.length);
  });

  it("keeps the entry and the suffix from bleeding into each other", () => {
    // Without escaping `-` in the entry, entry `a` with suffix `b-c` and entry
    // `a-b` with suffix `c` both produce `wl-a-b-c`.
    expect(waitlistDomId("a", "b-c")).not.toBe(waitlistDomId("a-b", "c"));
  });
});

describe("the state machine is invisible", () => {
  it("offers no Claim, Claim next, Reinvite or Record expired — by any spelling", () => {
    // THE ACTION VOCABULARY is where the state machine would show through. It
    // must contain none of the database's verbs, `expire` included: recording
    // an expiry is bookkeeping the database performs, not a button.
    const actionVocabulary = [
      ...PRACTITIONER_ACTIONS,
      ...Object.values(PRACTITIONER_ACTION_LABEL),
    ]
      .join(" ")
      .toLowerCase();
    for (const forbidden of ["claim", "reinvite", "re-invite", "expire"]) {
      expect(
        actionVocabulary,
        `"${forbidden}" is a database verb, not a practitioner's action`,
      ).not.toContain(forbidden);
    }

    // THE STATUS VOCABULARY may say "Invitation expired", because that is the
    // state a practitioner genuinely observes — it is the ACT of recording it
    // that must not exist. So the ban here is on the control's name, not on the
    // adjective.
    const everythingRendered = [
      ...Object.values(PRACTITIONER_STATUS_LABEL),
      ...Object.values(PRACTITIONER_ACTION_LABEL),
    ]
      .join(" ")
      .toLowerCase();
    for (const forbidden of ["record expired", "claim", "reinvite"]) {
      expect(everythingRendered, `"${forbidden}" reached the practitioner`).not.toContain(
        forbidden,
      );
    }
    expect(Object.values(PRACTITIONER_STATUS_LABEL)).toContain("Invitation expired");
  });

  it("never names an internal status in anything a practitioner reads", () => {
    // The database's own words for four of the seven states. A practitioner
    // sees none of them — not in a label, not in a refusal sentence.
    const internal = ["claimed", "released", "converted", "requeue"];
    const rendered: string[] = [...Object.values(PRACTITIONER_STATUS_LABEL)];
    for (const status of WAITLIST_ENTRY_STATUSES) {
      for (const { context } of CONTEXTS) {
        rendered.push(practitionerStatusLabel(status, context));
        for (const action of PRACTITIONER_ACTIONS) {
          const verdict = practitionerActionAvailability(action, status, context);
          if (!verdict.available) rendered.push(verdict.reason);
        }
      }
    }
    const text = rendered.join(" ").toLowerCase();
    for (const word of internal) {
      expect(text, `"${word}" leaked into practitioner-facing copy`).not.toContain(word);
    }
  });

  it("an elapsed invitation reads as expired, though the entry is still `invited`", () => {
    // Recording the expiry is bookkeeping the database performs. Whether it has
    // happened yet is not a fact a practitioner should be able to observe, and
    // certainly not one they should have to fix with a button.
    expect(practitionerStatusLabel("invited", { invitationElapsed: true, invitationRedeemed: false })).toBe(
      "Invitation expired",
    );
    expect(practitionerStatusLabel("invited", { invitationElapsed: false, invitationRedeemed: false })).toBe(
      "Invitation created",
    );
    // A REDEEMED invitation is not expired even after its window passes: they
    // used it, and the entry is waiting on a booking record, not on a clock.
    expect(
      practitionerStatusLabel("invited", {
        invitationElapsed: true,
        invitationRedeemed: true,
      }),
    ).toBe("Invitation created");
  });

  it("a previously invited person who is eligible again gets the ordinary invite", () => {
    // Finding A, closed by removing the choice rather than by answering it.
    // There is no second action to tell apart from the first, so no caller needs
    // invitation history to decide which control to render.
    for (const status of INVITE_TO_BOOK_STATUSES) {
      const surface = entryActionSurface(status);
      expect(surface.primary?.action).toBe("invite_to_book");
      expect(surface.primary?.label).toBe("Invite to book");
    }
    // And nothing anywhere renders a second sending action beside it.
    const everySendingControl = WAITLIST_ENTRY_STATUSES.flatMap((status) =>
      CONTEXTS.flatMap(({ context }) =>
        surfaceItems(status, context).filter((i) => i.action === "invite_to_book"),
      ),
    );
    expect(new Set(everySendingControl.map((i) => i.label)).size).toBeLessThanOrEqual(1);
  });
});

describe("every verdict is the live model's, not a second copy of it", () => {
  it("never offers a control the live model refuses", () => {
    let compared = 0;
    for (const status of WAITLIST_ENTRY_STATUSES) {
      for (const { name, context } of CONTEXTS) {
        for (const item of surfaceItems(status, context)) {
          const delegate = delegateFor(item.action, status);
          if (delegate === null) continue;
          const live = actionAvailability(delegate, status, context);
          compared += 1;
          expect(
            !item.available || live.available,
            `${item.action}@${status} (${name}) is offered while ${delegate} refuses it`,
          ).toBe(true);
        }
      }
    }
    // Non-vacuity: the walk must actually be reaching delegated controls.
    expect(compared).toBeGreaterThan(20);
  });

  it("diverges from the live verdict ONLY where it fails closed, and only there", () => {
    // THE KEY CARRIES THE CONTEXT, and that is load-bearing. An earlier
    // revision keyed on `action@status` alone and compared Sets, so the
    // unreadable case already contributed `return_to_waitlist@invited` and a
    // NEW divergence at the same action and status — one that stranded an
    // ordinary readable, elapsed invitation — would have collapsed into the
    // same set element and passed. The exception has to be scoped to the exact
    // context it was granted for, or it is not scoped at all.
    const divergences: string[] = [];
    let inspected = 0;
    for (const status of WAITLIST_ENTRY_STATUSES) {
      for (const { name, context } of CONTEXTS) {
        for (const item of surfaceItems(status, context)) {
          const delegate = delegateFor(item.action, status);
          if (delegate === null) continue;
          const live = actionAvailability(delegate, status, context);
          inspected += 1;
          if (item.available !== live.available) {
            divergences.push(`${item.action}@${status}@${name}`);
          }
        }
      }
    }
    // The single documented case: "Return to waitlist" on an `invited` entry
    // whose window is reported elapsed on facts that could not be READ.
    // `expire` folds "not elapsed" and "could not look" into one branch, which
    // is safe where it is offered and unsafe here — so unknown refuses, the way
    // `release` already does one branch above.
    // TWO ENTRIES, BOTH IN THE SAFE DIRECTION, BOTH FROM ONE CAUSE.
    //
    // The comparison above deliberately uses the RAW context, which is what the
    // live model sees. On an `invited` entry with NO invitation facts at all,
    // the live model reads the absent flags as false and answers "available";
    // this surface normalises that same absence to `invitationFactsUnknown` and
    // refuses. We are strictly stricter, which is the only divergence direction
    // permitted — offering a control the database will reject is the failure
    // this whole delegation exists to prevent, and refusing one it might have
    // accepted costs a practitioner a retry.
    //
    // Scoped to the exact context, so a divergence appearing under any OTHER
    // context — or on any other action — fails here rather than hiding behind
    // an already-accepted key.
    expect(divergences.sort()).toEqual([
      "cancel_invitation@invited@no invitation facts",
      // Same cause, third control: the raw context claims an elapsed window on
      // facts that could not be read, the live model believes the flag, and
      // this surface discards it as incoherent and refuses. Strictly stricter,
      // which is the only direction allowed.
      "remove_from_waitlist@invited@elapsed AND unreadable (incoherent input)",
      "resend_invitation@invited@no invitation facts",
    ]);
    // NON-VACUITY: the walk must actually be reaching delegated controls, or an
    // empty result would mean the loop found nothing rather than that nothing
    // diverged.
    expect(inspected).toBeGreaterThan(20);
  });

  it("fails closed on an unreadable invitation rather than guessing", () => {
    // Still the model's ruling for any direct caller, even though the surface
    // no longer routes here — unknown facts now render the live shape.
    const verdict = practitionerActionAvailability("return_to_waitlist", "invited", {
      invitationFactsUnknown: true,
      invitationElapsed: true,
    });
    expect(verdict.available).toBe(false);
    expect(verdict.available === false && verdict.reason).toBe(
      UNKNOWN_INVITATION_FAILS_CLOSED,
    );
  });

  it("treats a MISSING invitation context as unknown, not as a live invitation", () => {
    // `AdmissionEntry.invitation` is optional and documented as "absent means
    // not known", but an absent object was reaching the rulings as `{}`, where
    // `invitationFactsUnknown` and `invitationRedeemed` both read as false. The
    // row then claimed the link was live and unused, and once an adapter is
    // bound it would advertise Resend and Cancel on an invitation the database
    // may already have marked redeemed — both returning `already_redeemed`.
    for (const raw of [undefined, {}]) {
      expect(normalizeInvitationContext("invited", raw)).toEqual({
        invitationFactsUnknown: true,
      });

      const actions = surfaceItems("invited", raw as AdmissionContext);
      const resend = actions.find((i) => i.action === "resend_invitation")!;
      const cancel = actions.find((i) => i.action === "cancel_invitation")!;
      expect(resend.available, "Resend offered on unknown facts").toBe(false);
      expect(cancel.available, "Cancel offered on unknown facts").toBe(false);
      expect(actions.map((i) => i.action)).not.toContain("return_to_waitlist");

      // And it SAYS so, rather than describing a live link.
      expect(practitionerStatusDetail("invited", raw as AdmissionContext)).toContain(
        "could not be checked",
      );
      expect(practitionerStatusLabel("invited", raw as AdmissionContext)).toBe(
        "Invitation created",
      );
    }

    // A caller that genuinely KNOWS the invitation is live keeps its controls —
    // otherwise the fix would simply disable the feature.
    const known = { invitationElapsed: false, invitationRedeemed: false };
    const live = surfaceItems("invited", known);
    expect(live.find((i) => i.action === "resend_invitation")!.available).toBe(true);
    expect(live.find((i) => i.action === "cancel_invitation")!.available).toBe(true);
  });

  it("treats PARTIAL invitation facts as unknown, not as a live invitation", () => {
    // Key count was the wrong question. `{ invitationElapsed: false }` has a
    // key, so it passed through unchanged, `invitationRedeemed` stayed absent
    // and read as false, and the row went back to announcing a live, unused
    // link — a claim about redemption the caller never made. A key whose value
    // is `undefined` failed the same way, because it still counts as a key.
    const partial: ReadonlyArray<[string, AdmissionContext]> = [
      ["elapsed only", { invitationElapsed: false }],
      ["elapsed only, true", { invitationElapsed: true }],
      ["a key with no fact", { invitationElapsed: undefined }],
      // THE CASE THAT DISCRIMINATES `typeof ... === "boolean"` FROM `"x" in c`.
      // Redemption IS stated here, so the check reaches the elapsed half; only
      // a real boolean may satisfy it. A presence test would call this complete
      // and read the absent elapsed value as "not elapsed".
      [
        "redemption stated, elapsed present but undefined",
        { invitationRedeemed: false, invitationElapsed: undefined },
      ],
      ["not-redeemed only", { invitationRedeemed: false }],
      ["facts-unknown explicitly false, nothing else", { invitationFactsUnknown: false }],
    ];
    for (const [label, context] of partial) {
      expect(
        normalizeInvitationContext("invited", context),
        `${label} was accepted as complete`,
      ).toEqual({ invitationFactsUnknown: true });

      const actions = surfaceItems("invited", context);
      for (const action of ["resend_invitation", "cancel_invitation"] as const) {
        expect(
          actions.find((i) => i.action === action)!.available,
          `${label}: ${action} was offered on incomplete facts`,
        ).toBe(false);
      }
      expect(practitionerStatusDetail("invited", context)).toContain("could not be checked");
    }
  });

  it("accepts the three shapes that ARE complete, and keeps their controls", () => {
    // Or the fix would just be disabling the feature.
    //
    // REDEEMED IS COMPLETE ON ITS OWN: it is terminal and settles every ruling
    // — it has not run out, it cannot be released, cancelled or resent, and the
    // entry waits on a booking record. Nothing else needs to be known.
    const complete: ReadonlyArray<[string, AdmissionContext]> = [
      ["explicitly unreadable", { invitationFactsUnknown: true }],
      ["redeemed", { invitationRedeemed: true }],
      ["live and unused", { invitationElapsed: false, invitationRedeemed: false }],
      ["run out, unused", { invitationElapsed: true, invitationRedeemed: false }],
    ];
    for (const [label, context] of complete) {
      expect(
        normalizeInvitationContext("invited", context),
        `${label} was discarded as incomplete`,
      ).toEqual(context);
    }

    // And a genuinely live invitation still offers both controls.
    const live = surfaceItems("invited", {
      invitationElapsed: false,
      invitationRedeemed: false,
    });
    expect(live.find((i) => i.action === "resend_invitation")!.available).toBe(true);
    expect(live.find((i) => i.action === "cancel_invitation")!.available).toBe(true);
    // A run-out one still promotes the return, rather than being frozen unknown.
    expect(
      entryActionSurface("invited", { invitationElapsed: true, invitationRedeemed: false })
        .primary?.action,
    ).toBe("return_to_waitlist");
  });

  it("discards every flag that accompanies an unknown invitation", () => {
    // A flag sitting beside `invitationFactsUnknown` came from the SAME read
    // that failed, so it is a claim sourced from the thing that just said it
    // could not be sourced. It had a reachable consequence: the removal refusal
    // tested `invitationRedeemed` first and announced "they have already used
    // their invitation" one line under a row saying the state could not be
    // checked.
    const CANONICAL = { invitationFactsUnknown: true };
    const cases: ReadonlyArray<[string, AdmissionContext]> = [
      ["unknown + redeemed", { invitationFactsUnknown: true, invitationRedeemed: true }],
      ["unknown + elapsed", { invitationFactsUnknown: true, invitationElapsed: true }],
      [
        "unknown + both",
        {
          invitationFactsUnknown: true,
          invitationRedeemed: true,
          invitationElapsed: true,
        },
      ],
      ["unknown alone", { invitationFactsUnknown: true }],
    ];

    for (const [label, context] of cases) {
      expect(
        normalizeInvitationContext("invited", context),
        `${label} kept a companion flag`,
      ).toEqual(CANONICAL);

      const detail = practitionerStatusDetail("invited", context);
      expect(detail).toContain("could not be checked");
      expect(detail, `${label}: claimed the invitation was used`).not.toContain("have used");
      expect(detail, `${label}: claimed the invitation ran out`).not.toContain("ran out");
      expect(practitionerStatusLabel("invited", context)).not.toBe("Invitation expired");

      for (const item of surfaceItems("invited", context)) {
        expect(item.available, `${label}: ${item.action} was offered`).toBe(false);
        const reason = item.available === false ? item.reason : "";
        expect(reason, `${label}: ${item.action} asserted a fact`).toContain(
          "could not be checked",
        );
      }
      expect(surfaceItems("invited", context).map((i) => i.action)).not.toContain(
        "return_to_waitlist",
      );
    }

    // Applied at every status, so there is ONE shape of unknown in the system.
    for (const status of WAITLIST_ENTRY_STATUSES) {
      expect(
        normalizeInvitationContext(status, {
          invitationFactsUnknown: true,
          invitationRedeemed: true,
        }),
      ).toEqual(CANONICAL);
    }
  });

  it("preserves a READABLE redeemed or elapsed invitation, unchanged", () => {
    // The other half of the law: discarding companions must not flatten facts
    // that were genuinely read. Without this the fix would just be "never
    // believe anything".
    const redeemed = { invitationRedeemed: true };
    expect(normalizeInvitationContext("invited", redeemed)).toEqual(redeemed);
    expect(practitionerStatusDetail("invited", redeemed)).toContain("have used");
    const removeOnRedeemed = surfaceItems("invited", redeemed).find(
      (i) => i.action === "remove_from_waitlist",
    )!;
    expect(
      removeOnRedeemed.available === false ? removeOnRedeemed.reason : "",
    ).toContain("already used their invitation");

    const elapsed = { invitationElapsed: true, invitationRedeemed: false };
    expect(normalizeInvitationContext("invited", elapsed)).toEqual(elapsed);
    expect(practitionerStatusLabel("invited", elapsed)).toBe("Invitation expired");
    expect(entryActionSurface("invited", elapsed).primary?.action).toBe(
      "return_to_waitlist",
    );
  });

  it("discards the partial fact rather than carrying it beside the unknown flag", () => {
    // A half-known state produced this defect twice — once as a missing object,
    // once as a partial one. Keeping the fragment invites a third reading of it.
    expect(normalizeInvitationContext("invited", { invitationElapsed: true })).toEqual({
      invitationFactsUnknown: true,
    });
    expect(
      normalizeInvitationContext("invited", { invitationElapsed: true }),
    ).not.toHaveProperty("invitationElapsed");
  });

  it("does not give a non-invited row invitation semantics", () => {
    // A waiting or released entry has no invitation for facts to be unknown
    // ABOUT, and marking one unknown would withhold controls whose safety does
    // not depend on an invitation at all.
    for (const status of WAITLIST_ENTRY_STATUSES) {
      if (status === "invited") continue;
      expect(normalizeInvitationContext(status, undefined)).toEqual({});
      expect(normalizeInvitationContext(status, {})).toEqual({});
    }
    expect(entryActionSurface("waiting").primary?.action).toBe("invite_to_book");
    expect(entryActionSurface("waiting").primary?.available).toBe(true);
    expect(entryActionSurface("released").primary?.available).toBe(true);
  });

  it("lets unreadable facts beat a stale elapsed flag, everywhere at once", () => {
    // An unreadable invitation may already have been REDEEMED, and a redeemed
    // one has not expired. So a `invitationElapsed` bit we could not verify may
    // not be used to claim expiry, hide the live controls, or contradict the
    // sentence underneath the pill — which is exactly what happened when the
    // label, the detail and the surface each read the flags independently.
    const unreadable = { invitationFactsUnknown: true, invitationElapsed: true };

    expect(invitationHasRunOut(unreadable)).toBe(false);
    expect(practitionerStatusLabel("invited", unreadable)).toBe("Invitation created");
    expect(practitionerStatusDetail("invited", unreadable)).toContain("could not be checked");

    // The row keeps the LIVE shape, where every control refuses with a
    // could-not-check sentence rather than vanishing.
    const actions = surfaceItems("invited", unreadable).map((i) => i.action);
    expect(actions).toContain("cancel_invitation");
    expect(actions).toContain("resend_invitation");
    for (const item of surfaceItems("invited", unreadable)) {
      if (item.action === "remove_from_waitlist") continue;
      expect(item.available, `${item.action} was offered on unreadable facts`).toBe(false);
    }

    // NEGATIVE CONTROL: a READABLE elapsed invitation still reads as expired.
    const readable = {
      invitationFactsUnknown: false,
      invitationElapsed: true,
      invitationRedeemed: false,
    };
    expect(invitationHasRunOut(readable)).toBe(true);
    expect(practitionerStatusLabel("invited", readable)).toBe("Invitation expired");
  });

  it("reads a closed entry's refusal from the live model rather than restating it", () => {
    for (const status of ["converted", "removed"] as const) {
      for (const action of PRACTITIONER_ACTIONS) {
        const ours = practitionerActionAvailability(action, status);
        const live = actionAvailability("claim", status);
        expect(ours).toEqual(live);
      }
      // The premise that delegation rests on: every live action refuses a
      // closed entry identically, so `claim` is a sound probe for all of them.
      const viaClaim = actionAvailability("claim", status);
      for (const live of ["expire", "release", "requeue", "remove"] as const) {
        expect(actionAvailability(live, status)).toEqual(viaClaim);
      }
    }
  });
});

describe("`Invite to book` accepts exactly the statuses the database can reach", () => {
  it("derives its domain from 0188's own transition table", () => {
    const sql = readFileSync(
      join(ROOT, "supabase/migrations/0188_new_client_waitlist_invitations.sql"),
      "utf8",
    );
    // The guard's legal-edge list, verbatim: ('waiting',  'claimed'), …
    const edges = [...sql.matchAll(/\(\s*'(\w+)'\s*,\s*'(\w+)'\s*\)/g)].map((m) => [
      m[1],
      m[2],
    ]);
    expect(edges.length).toBeGreaterThan(10);

    // `issue` requires `claimed`. So the compound command's domain is every
    // status that reaches `claimed` in at most one studio-driven hop.
    const reachesClaimed = WAITLIST_ENTRY_STATUSES.filter(
      (s) => s === "claimed" || edges.some(([from, to]) => from === s && to === "claimed"),
    );
    expect(new Set(INVITE_TO_BOOK_STATUSES)).toEqual(new Set(reachesClaimed));
  });

  it("sends `expired` and `released` back to the queue instead", () => {
    for (const status of ["expired", "released"] as const) {
      const surface = entryActionSurface(status);
      expect(surface.primary?.action).toBe("return_to_waitlist");
      const invite = practitionerActionAvailability("invite_to_book", status);
      expect(invite.available).toBe(false);
    }
  });
});

describe("the row's action surface", () => {
  it("gives a closed entry nothing at all", () => {
    // Not five greyed buttons under someone who has already booked: on a
    // terminal entry no control will ever become available, so there is nothing
    // for a disabled one to teach.
    for (const status of ["converted", "removed"] as const) {
      expect(entryActionSurface(status)).toEqual({ primary: null, secondary: [] });
    }
  });

  it("leaves a live invitation with no primary action", () => {
    // The studio is not the one deciding — the invitee is. Inventing a primary
    // control here pushes a practitioner to interfere with someone mid-decision.
    const surface = entryActionSurface("invited", { invitationElapsed: false, invitationRedeemed: false });
    expect(surface.primary).toBeNull();
    expect(surface.secondary.map((i) => i.action)).toEqual([
      "resend_invitation",
      "cancel_invitation",
      "remove_from_waitlist",
    ]);
  });

  it("promotes `Return to waitlist` once the invitation has run out", () => {
    const surface = entryActionSurface("invited", { invitationElapsed: true, invitationRedeemed: false });
    expect(surface.primary?.action).toBe("return_to_waitlist");
    // Cancelling an invitation that has already expired is a distinction only
    // the state machine cares about.
    expect(surface.secondary.map((i) => i.action)).not.toContain("cancel_invitation");
  });

  it("renders an elapsed invitation EXACTLY as the expired entry it becomes", () => {
    // The `invited` -> `expired` bookkeeping transition is invisible to a
    // practitioner. If the two rows offered different actions, the moment it
    // happened would show as a control appearing or vanishing on its own —
    // which is the state machine leaking through the one seam this design
    // closes. Resend used to sit on one and not the other.
    const elapsed = entryActionSurface("invited", { invitationElapsed: true, invitationRedeemed: false });
    const expired = entryActionSurface("expired");
    // COMPARE WHETHER THEY WORK, NOT MERELY WHETHER THEY APPEAR. This
    // assertion used to map to `.action` alone, so both rows listed
    // `remove_from_waitlist` and it passed — while Remove was DISABLED on the
    // elapsed row and ENABLED on the expired one, and the invisible
    // bookkeeping transition flipped it. An anti-leak test with a hole shaped
    // exactly like the leak.
    const shape = (s: ReturnType<typeof entryActionSurface>) => ({
      primary: s.primary
        ? { action: s.primary.action, label: s.primary.label, available: s.primary.available }
        : null,
      secondary: s.secondary.map((i) => ({
        action: i.action,
        label: i.label,
        available: i.available,
        destructive: i.destructive,
      })),
    });
    expect(shape(elapsed)).toEqual(shape(expired));
    // And the refusal SENTENCES agree too, where there are any — a row that
    // explains itself differently is as visible a difference as a greyed
    // button.
    const reasons = (s: ReturnType<typeof entryActionSurface>) =>
      [...(s.primary ? [s.primary] : []), ...s.secondary]
        .map((i) => (i.available ? null : i.reason))
        .filter(Boolean);
    expect(reasons(elapsed)).toEqual(reasons(expired));
    // And they read the same, so nothing distinguishes them on screen at all.
    expect(practitionerStatusLabel("invited", { invitationElapsed: true, invitationRedeemed: false })).toBe(
      practitionerStatusLabel("expired"),
    );
  });

  it("refuses to resend into a window that has already closed", () => {
    // Resending starts with `release`, so it would stamp an invitation that RAN
    // OUT as one the studio CANCELLED, and the entry's own history would then
    // disagree with what happened.
    const verdict = practitionerActionAvailability("resend_invitation", "invited", {
      invitationElapsed: true,
      invitationRedeemed: false,
    });
    expect(verdict.available).toBe(false);
    expect(verdict.available === false && verdict.reason).toContain("Return them to the waitlist");
    // Still offered on a live invitation, or the refusal above proves nothing.
    expect(
      practitionerActionAvailability("resend_invitation", "invited", {
        invitationElapsed: false,
        invitationRedeemed: false,
      }).available,
    ).toBe(true);
  });

  it("never leaves a legacy held entry without a way out", () => {
    // `claimed` is unreachable by any action on this surface but exists in the
    // data, put there by the older screen. Both exits stay open.
    const actions = surfaceItems("claimed", {}).map((i) => i.action);
    expect(actions).toContain("invite_to_book");
    expect(actions).toContain("return_to_waitlist");
  });

  it("names the exit the row actually offers when removal is blocked", () => {
    // A refusal that says "cancel it first" on a row whose invitation has
    // already expired points at a control that is not there — the same defect
    // as explaining a disabled Remove with a sentence about sending.
    const removeReason = (context: AdmissionContext) => {
      const item = surfaceItems("invited", context).find(
        (i) => i.action === "remove_from_waitlist",
      )!;
      return item.available === false ? item.reason : null;
    };

    expect(removeReason({ invitationElapsed: false, invitationRedeemed: false })).toContain(
      "Cancel their invitation",
    );
    // An ELAPSED invitation no longer blocks removal at all — the server owns
    // the expire-then-remove compound, so this row matches the `expired` row it
    // silently becomes. There is no refusal left to name.
    expect(removeReason({ invitationElapsed: true, invitationRedeemed: false })).toBeNull();

    // The refusal's ACTIONABLE VERB must belong to a control the same row is
    // showing. Comparing whole labels is too strict — the sentence reads
    // "Cancel their invitation" where the button reads "Cancel invitation" —
    // and comparing nothing is the defect itself.
    for (const [context, verb] of [
      [{ invitationElapsed: false, invitationRedeemed: false }, "Cancel"],
    ] as const) {
      const reason = removeReason(context)!;
      expect(reason).toContain(verb);
      const shown = surfaceItems("invited", context).map((i) => i.label);
      expect(
        shown.some((label) => label.startsWith(verb)),
        `"${reason}" points at a control this row does not show: ${shown.join(", ")}`,
      ).toBe(true);
    }
  });

  it("applies the unknown-over-elapsed precedence to the removal reason too", () => {
    // The precedence was established for the label, the detail and the action
    // surface, then bypassed here by a raw `context.invitationElapsed` read. On
    // unreadable facts the row keeps the LIVE shape — no "Return to waitlist"
    // anywhere on it — while this sentence told the practitioner to use exactly
    // that absent control.
    const unreadable = { invitationFactsUnknown: true, invitationElapsed: true };
    const shown = surfaceItems("invited", unreadable);
    expect(shown.map((i) => i.action)).not.toContain("return_to_waitlist");

    const remove = shown.find((i) => i.action === "remove_from_waitlist")!;
    expect(remove.available).toBe(false);
    const reason = remove.available === false ? remove.reason : "";
    expect(reason).not.toContain("Return them to the waitlist");
    expect(reason).toContain("could not be checked");

    // NEGATIVE CONTROL: with the facts READABLE and elapsed, the row offers
    // both controls outright — no refusal at all. Unknown is therefore doing
    // real work here rather than matching what elapsed would have done anyway.
    const readable = { invitationElapsed: true, invitationRedeemed: false };
    const readableActions = surfaceItems("invited", readable);
    expect(readableActions.map((i) => i.action)).toContain("return_to_waitlist");
    expect(
      readableActions.find((i) => i.action === "remove_from_waitlist")!.available,
    ).toBe(true);
  });

  it("never names a control the row is not showing, at any status or context", () => {
    // The general form of the defect class that has now recurred five times.
    // Every refusal sentence that names an action must name one this row
    // actually renders.
    const VERBS: ReadonlyArray<[string, PractitionerAction]> = [
      ["Cancel their invitation", "cancel_invitation"],
      ["Return them to the waitlist", "return_to_waitlist"],
    ];
    for (const status of WAITLIST_ENTRY_STATUSES) {
      for (const { name, context } of CONTEXTS) {
        const shown = surfaceItems(status, context);
        const actions = new Set(shown.map((i) => i.action));
        for (const item of shown) {
          if (item.available) continue;
          for (const [phrase, action] of VERBS) {
            if (!item.reason.includes(phrase)) continue;
            expect(
              actions.has(action),
              `${status} (${name}): "${item.label}" points at ${action}, which this row does not show`,
            ).toBe(true);
          }
        }
      }
    }
  });

  it("does not send a redeemed entry chasing a control that will refuse it too", () => {
    // The known lifecycle gap: someone who used their invitation and never
    // booked has no operator exit at all. Naming Cancel here would send a
    // practitioner to a control that answers `already_redeemed`.
    const item = surfaceItems("invited", { invitationRedeemed: true }).find(
      (i) => i.action === "remove_from_waitlist",
    )!;
    expect(item.available).toBe(false);
    const reason = item.available === false ? item.reason : "";
    expect(reason).toContain("already used their invitation");
    expect(reason).not.toContain("Cancel their invitation first");
  });

  it("marks exactly the two irreversible actions destructive", () => {
    const destructive = new Set(
      WAITLIST_ENTRY_STATUSES.flatMap((s) =>
        CONTEXTS.flatMap(({ context }) =>
          surfaceItems(s, context).filter((i) => i.destructive).map((i) => i.action),
        ),
      ),
    );
    expect(destructive).toEqual(new Set(["cancel_invitation", "remove_from_waitlist"]));
  });
});

describe("wiring state is not eligibility", () => {
  it("explains an unwired control by naming that control", () => {
    // Finding C. The earlier revision applied one sentence about SENDING to
    // every unwired action, including three that send nothing.
    for (const item of surfaceItems("waiting", {})) {
      const state = controlState(item, null);
      expect(state.disabled).toBe(true);
      expect(state.reason).toContain(item.label);
      expect(state.reason?.toLowerCase()).not.toContain("sending is not available");
    }
  });

  it("keeps the eligibility reason when the entry itself forbids the action", () => {
    // "They have already used their invitation" stays true whether or not the
    // invitation service exists, and is the more useful of the two sentences.
    const item = surfaceItems("invited", { invitationRedeemed: true }).find(
      (i) => i.action === "resend_invitation",
    )!;
    expect(item.available).toBe(false);
    expect(controlState(item, null).reason).toBe(
      item.available === false ? item.reason : null,
    );
  });

  it("withholds resend from an adapter that cannot carry the scope it sends", () => {
    // `resendInvitation` takes a scope for the same reason `inviteToBook` does:
    // it mints a NEW invitation rather than re-delivering the old one. An
    // adapter reporting `{ canResend: true, enforcesScope: false }` — which the
    // contract permits as an intermediate state — must not light this control.
    const item = surfaceItems("invited", { invitationElapsed: false, invitationRedeemed: false }).find(
      (i) => i.action === "resend_invitation",
    )!;
    expect(item.available).toBe(true);

    const halfWired = controlState(item, {
      enforcesScope: false,
      canResend: true,
      canCancel: true,
      canReturnToWaitlist: true,
      canRemove: true,
    });
    expect(halfWired.disabled).toBe(true);
    expect(halfWired.reason).toContain("booking window");

    // NEGATIVE CONTROL: with scope enforcement the identical control enables.
    expect(
      controlState(item, {
        enforcesScope: true,
        canResend: true,
        canCancel: true,
        canReturnToWaitlist: true,
        canRemove: true,
      }).disabled,
    ).toBe(false);
  });

  it("gates each action on the capabilities it actually needs — the full matrix", () => {
    const caps = (over: Partial<AdapterCapabilities> = {}): AdapterCapabilities => ({
      enforcesScope: true,
      canResend: true,
      canCancel: true,
      canReturnToWaitlist: true,
      canRemove: true,
      ...over,
    });
    const find = (
      status: WaitlistEntryStatus,
      context: AdmissionContext,
      action: PractitionerAction,
    ) => surfaceItems(status, context).find((i) => i.action === action)!;

    const live = { invitationElapsed: false, invitationRedeemed: false };
    const resend = find("invited", live, "resend_invitation");
    const cancel = find("invited", live, "cancel_invitation");
    const invite = find("waiting", {}, "invite_to_book");
    const requeue = find("released", {}, "return_to_waitlist");
    const remove = find("waiting", {}, "remove_from_waitlist");

    // RESEND NEEDS BOTH. It mints a NEW invitation with a newly supplied scope,
    // so an adapter that can resend but cannot carry a scope would either drop
    // what the practitioner chose or silently reuse the old one.
    expect(controlState(resend, caps({ canResend: true, enforcesScope: false })).disabled).toBe(true);
    expect(controlState(resend, caps({ canResend: false, enforcesScope: true })).disabled).toBe(true);
    expect(controlState(resend, caps()).disabled).toBe(false);

    // INVITE TO BOOK OPENS THE COMPOSER and carries no scope itself, so it must
    // stay reachable in the half-wired state the contract permits — otherwise
    // the composer's own "form visible, Send disabled" state is unreachable.
    expect(controlState(invite, caps({ enforcesScope: false })).disabled).toBe(false);
    expect(controlState(invite, null).disabled).toBe(true);

    // The single-capability actions are gated on theirs, and NOT on scope.
    expect(controlState(cancel, caps({ canCancel: false })).disabled).toBe(true);
    expect(controlState(cancel, caps({ enforcesScope: false })).disabled).toBe(false);
    expect(controlState(requeue, caps({ canReturnToWaitlist: false })).disabled).toBe(true);
    expect(controlState(requeue, caps({ enforcesScope: false })).disabled).toBe(false);
    expect(controlState(remove, caps({ canRemove: false })).disabled).toBe(true);
    expect(controlState(remove, caps({ enforcesScope: false })).disabled).toBe(false);
  });

  it("is not ready to bind, because no adapter exists", () => {
    expect(readyToBind(null)).toBe(false);
    expect(readyToBind({
      enforcesScope: false,
      canResend: true,
      canCancel: true,
      canReturnToWaitlist: true,
      canRemove: true,
    })).toBe(false);
    expect(readyToBind({
      enforcesScope: true,
      canResend: true,
      canCancel: true,
      canReturnToWaitlist: true,
      canRemove: true,
    })).toBe(true);
  });
});

describe("the composer's draft", () => {
  const draft = (over: Partial<InviteDraft> = {}): InviteDraft => ({
    ...emptyDraft(),
    ...over,
  });

  it("treats no service as a real answer and no permitted day as an error", () => {
    // `null` weekdays means every day. `[]` means no day is permitted, which is
    // an invitation that opens onto an empty calendar.
    expect(validateDraft(draft({ serviceId: null })).ok).toBe(true);
    expect(validateDraft(draft({ allowedWeekdays: null })).ok).toBe(true);
    const empty = validateDraft(draft({ allowedWeekdays: [] }));
    expect(empty.ok).toBe(false);
    expect(empty.ok === false && empty.errors.days).toBeTruthy();
  });

  it("refuses an expiry the shipped command would refuse, rather than clamping it", () => {
    // 1 hour .. 7 days, and out of range is REFUSED — a clamped window is one
    // the caller did not ask for and cannot see.
    expect(validateDraft(draft({ expiresInHours: 1 })).ok).toBe(true);
    expect(validateDraft(draft({ expiresInHours: 168 })).ok).toBe(true);
    for (const bad of [0, 169, 2.5, Number.NaN]) {
      expect(validateDraft(draft({ expiresInHours: bad })).ok, `${bad}`).toBe(false);
    }
  });

  it("bounds the booking window", () => {
    expect(validateDraft(draft({ windowDays: 1 })).ok).toBe(true);
    expect(validateDraft(draft({ windowDays: 365 })).ok).toBe(true);
    for (const bad of [0, 366, 7.5]) {
      expect(validateDraft(draft({ windowDays: bad })).ok, `${bad}`).toBe(false);
    }
  });

  it("hands the adapter nothing at all for an invalid draft", () => {
    // A partially-repaired payload is the one thing worse than no payload.
    expect(draftToInviteInput("e1", draft({ expiresInHours: 999 }))).toBeNull();
    expect(draftToInviteInput("e1", draft())).toEqual({
      entryId: "e1",
      scope: { serviceId: null, windowDays: 7, allowedWeekdays: null },
      expiresInHours: 72,
    });
  });

  it("refuses a service that is no longer selectable instead of widening the scope", () => {
    // The composer renders the chosen service by looking it up. When the lookup
    // misses — deleted service, or the list refreshed under an open composer —
    // the summary read "any service" while the payload still carried the stale
    // id, so the practitioner confirmed one scope and sent another.
    const withService = draft({ serviceId: "svc-gone" });
    // With no service list supplied the draft is unjudged, as before.
    expect(validateDraft(withService).ok).toBe(true);

    const judged = validateDraft(withService, { serviceIds: ["svc-1", "svc-2"] });
    expect(judged.ok).toBe(false);
    expect(judged.ok === false && judged.errors.service).toBeTruthy();

    // And nothing reaches the adapter.
    expect(draftToInviteInput("e1", withService, { serviceIds: ["svc-1"] })).toBeNull();
    expect(sendState(withService, null, { serviceIds: ["svc-1"] }).disabled).toBe(true);

    // NEGATIVE CONTROL: a service that IS in the list passes the identical call.
    expect(validateDraft(withService, { serviceIds: ["svc-gone"] }).ok).toBe(true);
    // "Any service" is still a real answer and is never judged missing.
    expect(validateDraft(draft({ serviceId: null }), { serviceIds: [] }).ok).toBe(true);
  });

  it("derives the pressed preset from the value, so the two cannot disagree", () => {
    expect(activeWindowPreset(7)).toBe(7);
    expect(activeWindowPreset(9)).toBe("custom");
    expect(activeTtlPreset(72)).toBe(72);
    expect(activeTtlPreset(5)).toBe("custom");
    expect(activeAllowedDaysPreset(null)).toBe("every");
    expect(activeAllowedDaysPreset([1, 2, 3, 4, 5])).toBe("weekdays");
    // Order must not matter; a set is a set.
    expect(activeAllowedDaysPreset([5, 4, 3, 2, 1])).toBe("weekdays");
    expect(activeAllowedDaysPreset([6, 0])).toBe("weekends");
    expect(activeAllowedDaysPreset([1, 3])).toBe("custom");
    // Every preset round-trips through its own value.
    for (const [preset, value] of Object.entries(ALLOWED_DAYS_PRESET_VALUES)) {
      expect(activeAllowedDaysPreset(value)).toBe(preset);
    }
  });

  it("renders weekdays Monday-first while keeping Sunday at index 0", () => {
    // Display order and value travel together: selecting "Mon–Fri" by position
    // must not quietly select Sunday–Thursday.
    expect(WEEKDAYS_IN_DISPLAY_ORDER.map((d) => d.label)).toEqual([
      "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun",
    ]);
    expect(WEEKDAYS_IN_DISPLAY_ORDER.map((d) => d.index)).toEqual([1, 2, 3, 4, 5, 6, 0]);
    expect(WEEKDAYS_IN_DISPLAY_ORDER.find((d) => d.label === "Sun")?.index).toBe(0);
  });

  it("blocks the send for a fixable field before blaming the missing service", () => {
    // A fixable draft must not look permanently broken.
    const broken = sendState(draft({ expiresInHours: 999 }), null);
    expect(broken.disabled).toBe(true);
    expect(broken.reason).toContain("highlighted");

    const unbound = sendState(draft(), null);
    expect(unbound.disabled).toBe(true);
    expect(unbound.reason).toContain("Invite to book");

    const unscoped = sendState(draft(), {
      enforcesScope: false,
      canResend: true,
      canCancel: true,
      canReturnToWaitlist: true,
      canRemove: true,
    });
    expect(unscoped.disabled).toBe(true);
    expect(unscoped.reason).toContain("booking window");
  });

  it("offers presets that are all inside the bounds they claim", () => {
    for (const preset of TTL_PRESETS) {
      expect(validateDraft(draft({ expiresInHours: preset.hours })).ok).toBe(true);
    }
    for (const preset of BOOKING_WINDOW_PRESETS) {
      expect(validateDraft(draft({ windowDays: preset.days })).ok).toBe(true);
    }
  });
});
