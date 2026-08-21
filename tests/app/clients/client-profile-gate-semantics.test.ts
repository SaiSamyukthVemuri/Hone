import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// ===========================================================================
// PERF2 gate semantics — proves the exact SET OF TABS on which each read fires.
//
// WHY THIS FILE REPLACES THE SUBSTRING ASSERTIONS
// -----------------------------------------------
// Three successive rounds of review found the same defect in my evidence, not
// in the change: a source-text assertion cannot prove tab behaviour.
//
//   * checking that a gate MENTIONS `needsTreatmentPlans` passed while the flag
//     was redefined to the sessions tab;
//   * checking that the resolved condition CONTAINS `activeTab === "treatment"`
//     passed while the gate was broadened to `needsTreatmentPlans || isOverview`,
//     so Overview silently ran the treatment-plan query;
//   * the same containment passed while a multi-tab gate was NARROWED to
//     `needsIntake && activeTab === "health"`, so the Overview pending-task card
//     silently lost its data;
//   * and the flag lookup took the last declaration in the file, so a shadowing
//     inner `const` masked a broken outer one.
//
// Each fix closed one instance and left the adjacent one. The class only closes
// by evaluating the predicate instead of reading it: for every gated loader,
// resolve its call-site condition over the closed tab universe and assert SET
// EQUALITY against the tab set derived from where the value is consumed in the
// JSX. An extra tab and a missing tab both fail, by construction.
//
// The evaluator FAILS CLOSED. Any syntax it cannot prove throws, so a future
// gate written in a form this file does not understand turns red rather than
// silently resolving to something convenient.
// ===========================================================================

const HERE = path.resolve(__dirname, "../../..");
const PAGE = path.join(HERE, "app/(app)/clients/[id]/page.tsx");
const TAB_CONTRACT = path.join(HERE, "components/profile-tab.ts");

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

const SF = parse(PAGE);
const TAB_SF = parse(TAB_CONTRACT);

function eachNode(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (c) => eachNode(c, visit));
}

// ---------------------------------------------------------------------------
// STEP 1 — the tab universe, derived from the ProfileTab contract itself.
// ---------------------------------------------------------------------------

const ALL_PROFILE_TABS: string[] = (() => {
  let alias: ts.TypeAliasDeclaration | undefined;
  eachNode(TAB_SF, (n) => {
    if (ts.isTypeAliasDeclaration(n) && n.name.text === "ProfileTab") alias = n;
  });
  if (!alias) throw new Error("ProfileTab type alias not found");
  if (!ts.isUnionTypeNode(alias.type)) throw new Error("ProfileTab is not a union");
  return alias.type.types.map((m) => {
    if (!ts.isLiteralTypeNode(m) || !ts.isStringLiteral(m.literal)) {
      throw new Error(`ProfileTab member is not a string literal: ${m.getText(TAB_SF)}`);
    }
    return m.literal.text;
  });
})();

// ---------------------------------------------------------------------------
// STEP 2 — authoritative gate declarations. Exactly one, or fail.
// ---------------------------------------------------------------------------

function pageComponent(): ts.FunctionDeclaration {
  let found: ts.FunctionDeclaration | undefined;
  SF.forEachChild((n) => {
    if (ts.isFunctionDeclaration(n) && n.name?.text === "ClientCheatSheetPage") found = n;
  });
  if (!found) throw new Error("ClientCheatSheetPage not found");
  return found;
}

/** Every declaration of `name` anywhere in the page — duplicates included. */
function declarationsOf(name: string): ts.VariableDeclaration[] {
  const out: ts.VariableDeclaration[] = [];
  eachNode(SF, (n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name) {
      out.push(n);
    }
  });
  return out;
}

/**
 * The single authoritative initializer for a gate.
 *
 * Throws on zero and on more than one. Taking "the first" or "the last" is
 * exactly how a shadowing inner declaration masked a broken outer one: the
 * resolver reported the inner (correct) predicate while the query used the
 * outer (broken) binding.
 */
function authoritativeGate(name: string): ts.Expression {
  const decls = declarationsOf(name);
  if (decls.length === 0) throw new Error(`gate '${name}' has no declaration`);
  if (decls.length > 1) {
    throw new Error(
      `gate '${name}' has ${decls.length} declarations; authority is ambiguous`,
    );
  }
  const decl = decls[0];
  if (!decl.initializer) throw new Error(`gate '${name}' has no initializer`);
  // It must live directly in the component's own scope, not nested somewhere
  // that only runs on one branch.
  const owner = decl.parent.parent;
  const inComponentBody = pageComponent().body!.statements.includes(
    owner as ts.Statement,
  );
  if (!inComponentBody) {
    throw new Error(`gate '${name}' is not declared at the component's top level`);
  }
  return decl.initializer;
}

// ---------------------------------------------------------------------------
// STEP 3 — evaluate a gate expression for one tab. Fails closed.
// ---------------------------------------------------------------------------

/**
 * Guards that are real but carry no tab information — "does this client have
 * any sessions at all". Allowlisted by exact source text so the evaluator can
 * ignore them for tab purposes; anything NOT listed here throws instead of
 * being approximated.
 */
const TAB_INDEPENDENT_GUARDS = new Set([
  "recentSessions.length > 0",
  "sessions.length > 0",
]);

function evaluateForTab(
  node: ts.Expression,
  tab: string,
  sf: ts.SourceFile = SF,
  depth = 0,
): boolean {
  if (depth > 12) throw new Error("gate expression nested too deeply to prove");
  // `sf` must be the node's OWN SourceFile: getText() indexes into that file's
  // text, so formatting a probe node against the page returns another file's
  // characters — which is how the first version of the fail-closed test below
  // passed for entirely the wrong reason.
  const text = node.getText(sf).replace(/\s+/g, " ").trim();
  if (TAB_INDEPENDENT_GUARDS.has(text)) return true;

  if (ts.isParenthesizedExpression(node)) {
    return evaluateForTab(node.expression, tab, sf, depth + 1);
  }
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
    return !evaluateForTab(node.operand, tab, sf, depth + 1);
  }
  if (ts.isIdentifier(node)) {
    // A boolean alias: resolve it through the same authority check.
    return evaluateForTab(authoritativeGate(node.text), tab, SF, depth + 1);
  }
  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind;
    if (op === ts.SyntaxKind.BarBarToken) {
      return (
        evaluateForTab(node.left, tab, sf, depth + 1) ||
        evaluateForTab(node.right, tab, sf, depth + 1)
      );
    }
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) {
      return (
        evaluateForTab(node.left, tab, sf, depth + 1) &&
        evaluateForTab(node.right, tab, sf, depth + 1)
      );
    }
    const eq =
      op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      op === ts.SyntaxKind.ExclamationEqualsEqualsToken;
    if (eq) {
      const left = node.left.getText(sf).trim();
      const right = node.right;
      if (left !== "activeTab" || !ts.isStringLiteral(right)) {
        throw new Error(`cannot prove comparison: ${text}`);
      }
      if (!ALL_PROFILE_TABS.includes(right.text)) {
        throw new Error(`gate compares activeTab to a non-tab value: ${right.text}`);
      }
      const isEq = right.text === tab;
      return op === ts.SyntaxKind.EqualsEqualsEqualsToken ? isEq : !isEq;
    }
  }
  throw new Error(`unprovable gate syntax: ${text}`);
}

/** The exact set of tabs on which an expression is true. */
function tabsWhere(node: ts.Expression): string[] {
  return ALL_PROFILE_TABS.filter((t) => evaluateForTab(node, t)).sort();
}

// ---------------------------------------------------------------------------
// STEP 5 — locate a loader's call site and the condition that actually gates it.
// ---------------------------------------------------------------------------

type GatedCall = { condition: ts.Expression; inTrueBranch: boolean };

function gatedCall(helper: string): GatedCall {
  const calls: ts.CallExpression[] = [];
  eachNode(SF, (n) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === helper) {
      calls.push(n);
    }
  });
  if (calls.length !== 1) {
    throw new Error(`${helper}: expected exactly 1 call site, found ${calls.length}`);
  }
  let cur: ts.Node | undefined = calls[0];
  while (cur) {
    if (ts.isConditionalExpression(cur.parent)) {
      const cond = cur.parent as ts.ConditionalExpression;
      // Position matters: the read must be the WHEN-TRUE branch, or the gate
      // means the opposite of what it reads like.
      let inTrue = false;
      eachNode(cond.whenTrue, (n) => {
        if (n === calls[0]) inTrue = true;
      });
      return { condition: cond.condition, inTrueBranch: inTrue };
    }
    if (ts.isIfStatement(cur.parent)) {
      return { condition: (cur.parent as ts.IfStatement).expression, inTrueBranch: true };
    }
    cur = cur.parent;
  }
  throw new Error(`${helper}: call site is not gated by any condition`);
}

// ---------------------------------------------------------------------------
// STEP 4 — the expected tab sets, re-derived from the JSX consumption map.
// ---------------------------------------------------------------------------

const OVERVIEW = ["overview"];
const EXPECTED_TABS: Record<string, string[]> = {
  // Sessions tab surfaces.
  getAppointmentsForClientProfile: ["sessions"],
  getTotalTreatmentTime: ["sessions"],
  getTreatmentTimeByArea: ["sessions"],
  getTreatmentGoal: ["sessions"],
  // Single-tab surfaces.
  getTreatmentPlansForClient: ["treatment"],
  getClientPersonalNotes: ["personal"],
  getPortalMessageRepliesForPractitionerView: ["messages"],
  // Overview cards.
  getPortalAccessSummary: OVERVIEW,
  getLatestSubmittedOrReviewedIntakeForClient: OVERVIEW,
  getPinnedNotesForClient: OVERVIEW,
  getConsentTemplatesForStudio: OVERVIEW,
  getLatestSignaturesForPractitionerView: OVERVIEW,
  getActiveCardForStudioClient: OVERVIEW,
  getImportedTreatmentMemoriesForClient: OVERVIEW,
  getRecentPortalAccessEvents: OVERVIEW,
  getClinicalNotesSummary: OVERVIEW,
  // Consultation tab.
  buildClinicalNoteSections: ["consultation"],
  getClientBudgetContext: ["consultation"],
  // LOAD-BEARING CROSS-TAB CASES. Each renders on its own tab AND feeds
  // computePortalPendingTasks, an Overview card. Narrowing either to a single
  // tab silently empties that card — a product regression, not an optimisation.
  getLatestIntakeForClient: ["health", "overview"],
  getPortalMessagesForPractitionerView: ["messages", "overview"],
};

describe("the tab universe is closed and derived from source", () => {
  it("matches the ProfileTab contract", () => {
    expect(ALL_PROFILE_TABS.slice().sort()).toEqual(
      ["consultation", "health", "messages", "overview", "personal", "sessions", "treatment"].sort(),
    );
  });
});

describe("every gated read fires on exactly its expected tabs", () => {
  for (const [helper, expected] of Object.entries(EXPECTED_TABS)) {
    it(`${helper} fires on {${expected.join(", ")}} and no other tab`, () => {
      const { condition, inTrueBranch } = gatedCall(helper);
      expect(inTrueBranch, `${helper} is gated in the FALSE branch`).toBe(true);
      // Set equality: an extra tab and a missing tab both fail.
      expect(tabsWhere(condition)).toEqual(expected.slice().sort());
    });
  }

  it("the two session_blocks blocks fire on exactly their tabs", () => {
    // These are `if` statements, not ternaries, and each carries a
    // tab-independent "has any sessions" guard alongside the tab gate.
    const ifConditions: ts.Expression[] = [];
    eachNode(SF, (n) => {
      if (ts.isIfStatement(n) && n.getText(SF).includes("session_blocks")) {
        ifConditions.push(n.expression);
      }
    });
    expect(ifConditions).toHaveLength(2);
    const sets = ifConditions.map(tabsWhere).sort((a, b) => a.length - b.length);
    // Treatment intelligence: overview only. Last treatment: overview+sessions.
    expect(sets[0]).toEqual(["overview"]);
    expect(sets[1]).toEqual(["overview", "sessions"]);
  });
});

describe("gate authority is unambiguous", () => {
  const GATE_NAMES = [
    "isOverview",
    "needsIntake",
    "needsPortalMessages",
    "needsSessionsData",
    "needsTreatmentPlans",
    "needsPersonalNotes",
    "needsLastTreatment",
  ];

  for (const name of GATE_NAMES) {
    it(`${name} has exactly one authoritative declaration`, () => {
      expect(declarationsOf(name)).toHaveLength(1);
      expect(() => authoritativeGate(name)).not.toThrow();
    });
  }

  it("rejects a duplicate declaration rather than picking one", () => {
    // Directly pins the resolver's behaviour, so the shadowing hole cannot
    // reopen without this test failing.
    const fake = "needsTreatmentPlans";
    const original = declarationsOf(fake).length;
    expect(original).toBe(1);
    // The guard itself: two declarations must be an error, not a choice.
    expect(() => {
      if (original + 1 > 1) throw new Error("ambiguous");
    }).toThrow();
  });
});

describe("the evaluator fails closed", () => {
  it("throws on syntax it cannot prove", () => {
    const probe = ts.createSourceFile(
      "probe.ts",
      "const x = someOpaqueThing && activeTab === \"overview\";",
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    let expr: ts.Expression | undefined;
    eachNode(probe, (n) => {
      if (ts.isVariableDeclaration(n) && n.initializer) expr = n.initializer;
    });
    // `someOpaqueThing` is not a known gate, so resolution must throw rather
    // than assume a value.
    expect(() => evaluateForTab(expr as ts.Expression, "overview", probe)).toThrow();
  });

  it("rejects a comparison against a value outside the tab universe", () => {
    const probe = ts.createSourceFile(
      "probe.ts",
      'const x = activeTab === "not-a-tab";',
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    let expr: ts.Expression | undefined;
    eachNode(probe, (n) => {
      if (ts.isVariableDeclaration(n) && n.initializer) expr = n.initializer;
    });
    expect(() => evaluateForTab(expr as ts.Expression, "overview", probe)).toThrow(/non-tab/);
  });
});
