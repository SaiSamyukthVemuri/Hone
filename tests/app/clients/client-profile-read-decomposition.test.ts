import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// ===========================================================================
// PERF2 — Client Profile read decomposition.
//
// Production measurement (#610, 38 valid perf_route_timing lines) put
// `client-profile.domain` at p50 584ms / p75 654ms / p95 698ms — five to
// thirteen times every other measured page-domain span, while identity on this
// surface was only ~11% of measured span time. So the fix is decomposition of
// the page's reads, not identity memoisation.
//
// Two structural claims are asserted here, because both are invisible to a
// rendering test and both silently regress under ordinary editing:
//
//   1. reads that depend only on (studio.id, client.id) run in ONE parallel
//      wave rather than a chain of single-await statements;
//   2. reads whose values are rendered by exactly one tab are SKIPPED on the
//      other tabs, rather than fetched and discarded.
//
// The page is a server component that cannot be rendered without a database,
// so these are proved from the AST, the way the repo's other source guards do.
// A comment is never an AwaitExpression and never a CallExpression, so prose
// about a read cannot satisfy or break these assertions.
// ===========================================================================

const PAGE = path.resolve(__dirname, "../../../app/(app)/clients/[id]/page.tsx");
const SOURCE = readFileSync(PAGE, "utf8");
const SF = ts.createSourceFile(
  PAGE,
  SOURCE,
  ts.ScriptTarget.Latest,
  /* setParentNodes */ true,
  ts.ScriptKind.TSX,
);

function pageComponent(): ts.FunctionDeclaration {
  let found: ts.FunctionDeclaration | undefined;
  SF.forEachChild((n) => {
    if (ts.isFunctionDeclaration(n) && n.name?.text === "ClientCheatSheetPage") {
      found = n;
    }
  });
  if (!found) throw new Error("ClientCheatSheetPage not found");
  return found;
}

function containsAwait(node: ts.Node): boolean {
  let has = false;
  const visit = (n: ts.Node) => {
    if (ts.isAwaitExpression(n)) has = true;
    ts.forEachChild(n, visit);
  };
  visit(node);
  return has;
}

/** Top-level statements of the component that perform any awaited work. */
function serialWaves(): ts.Statement[] {
  return pageComponent().body!.statements.filter(containsAwait);
}

/** Every call to `name(` anywhere in the page, with its enclosing text. */
function callsTo(name: string): ts.CallExpression[] {
  const out: ts.CallExpression[] = [];
  const visit = (n: ts.Node) => {
    if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === name
    ) {
      out.push(n);
    }
    ts.forEachChild(n, visit);
  };
  visit(SF);
  return out;
}

/**
 * The source text of the nearest enclosing conditional (ternary or `if`).
 * A read is "gated" when that condition mentions the expected tab flag.
 */
function enclosingConditionText(node: ts.Node): string {
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (ts.isConditionalExpression(cur)) return cur.condition.getText(SF);
    if (ts.isIfStatement(cur)) return cur.expression.getText(SF);
    cur = cur.parent;
  }
  return "";
}

/**
 * The declared meaning of a `const <name> = <expr>` flag in the page, with
 * whitespace normalised.
 *
 * Checking that a read is wrapped in a condition MENTIONING `needsTreatmentPlans`
 * proves nothing on its own: redefining that flag to `activeTab === "sessions"`
 * leaves every such assertion green while the Treatment tab silently renders no
 * plans. The gate tests below therefore resolve the flag to its predicate and
 * assert the predicate itself.
 */
function flagDefinition(name: string): string {
  let text: string | undefined;
  const visit = (n: ts.Node) => {
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.name.text === name &&
      n.initializer
    ) {
      text = n.initializer.getText(SF).replace(/\s+/g, " ").trim();
    }
    ts.forEachChild(n, visit);
  };
  visit(SF);
  if (text === undefined) throw new Error(`flag not found: ${name}`);
  return text;
}

/** Fully expand a gate condition by substituting any flags it references. */
function resolveCondition(condition: string): string {
  let out = condition.replace(/\s+/g, " ").trim();
  for (let i = 0; i < 5; i += 1) {
    const before = out;
    out = out.replace(/\b(isOverview|needsIntake|needsPortalMessages|needsSessionsData|needsTreatmentPlans|needsPersonalNotes|needsLastTreatment)\b/g,
      (m) => `(${flagDefinition(m)})`);
    if (out === before) break;
  }
  return out;
}

describe("independent reads run in one parallel wave", () => {
  it("collapses the page to a small number of serial waves", () => {
    // Was 14 await-bearing top-level statements (2 framework params + 12 data
    // waves): getClientById, then seven single reads, a ten-way Promise.all,
    // one more read, the tab-gated notes, and two session_blocks blocks.
    const waves = serialWaves();
    expect(waves.length).toBeLessThanOrEqual(10);
  });

  it("keeps getClientById ahead of the wave, because it gates notFound()", () => {
    const waves = serialWaves();
    const texts = waves.map((w) => w.getText(SF));
    const clientIdx = texts.findIndex((t) => t.includes("getClientById"));
    const waveIdx = texts.findIndex((t) => t.includes("Promise.all"));
    expect(clientIdx).toBeGreaterThanOrEqual(0);
    expect(waveIdx).toBeGreaterThan(clientIdx);
  });

  it("puts the mutually-independent reads in a single Promise.all", () => {
    const waves = serialWaves();
    const wave = waves.find((w) => w.getText(SF).includes("Promise.all"));
    expect(wave, "no Promise.all wave found").toBeTruthy();

    // Collect the helpers ACTUALLY CALLED in the wave, from the AST.
    //
    // This used to assert `waveText.toContain(helper)`, which a mutation walked
    // straight through: replacing `getActiveServices(studio.id)` with
    // `Promise.resolve([] as Awaited<ReturnType<typeof getActiveServices>>)`
    // removes the call while KEEPING the name in the type annotation, so the
    // substring assertion stayed green while the page stopped reading services.
    const called = new Set<string>();
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
        called.add(n.expression.text);
      }
      ts.forEachChild(n, visit);
    };
    visit(wave as ts.Statement);

    for (const helper of [
      "getAppointmentsForClientProfile",
      "getActiveServices",
      "getLatestIntakeForClient",
      "getPortalAccessSummary",
      "getLatestSubmittedOrReviewedIntakeForClient",
      "getPinnedNotesForClient",
      "getTreatmentPlansForClient",
      "getTotalTreatmentTime",
      "getPortalMessagesForPractitionerView",
      "getConsentTemplatesForStudio",
      "getActiveCardForStudioClient",
      "getRecentPortalAccessEvents",
    ]) {
      expect(called, `${helper} is not CALLED in the parallel wave`).toContain(helper);
    }
  });

  it("leaves no single-read await stranded outside the wave", () => {
    // Anything still serial must be either framework input, the notFound gate,
    // a tab-gated clinical read, or a session_blocks block — never a plain
    // (studio.id, client.id) read that could have joined the wave.
    const allowed = [
      "params",
      "searchParams",
      "client-profile.identity",
      "getClientById",
      "Promise.all",
      "buildClinicalNoteSections",
      "getClientBudgetContext",
      "getClinicalNotesSummary",
      "recentSessions.length",
      "sessions.length",
    ];
    for (const w of serialWaves()) {
      const text = w.getText(SF);
      expect(
        allowed.some((a) => text.includes(a)),
        `stranded serial read: ${text.split("\n")[0]}`,
      ).toBe(true);
    }
  });
});

describe("tab-exclusive reads are skipped on other tabs", () => {
  // helper -> the flag its call site must be gated by.
  // helper -> the TAB SEMANTICS its call site must resolve to, after flag
  // substitution. Asserting the resolved predicate (not the flag's name) is
  // what makes a redefinition of the flag fail here.
  const GATED: Array<[string, string]> = [
    ["getAppointmentsForClientProfile", 'activeTab === "sessions"'],
    ["getTotalTreatmentTime", 'activeTab === "sessions"'],
    ["getTreatmentTimeByArea", 'activeTab === "sessions"'],
    ["getTreatmentGoal", 'activeTab === "sessions"'],
    ["getTreatmentPlansForClient", 'activeTab === "treatment"'],
    ["getClientPersonalNotes", 'activeTab === "personal"'],
    ["getPortalMessageRepliesForPractitionerView", 'activeTab === "messages"'],
    ["getPortalAccessSummary", 'activeTab === "overview"'],
    ["getLatestSubmittedOrReviewedIntakeForClient", 'activeTab === "overview"'],
    ["getPinnedNotesForClient", 'activeTab === "overview"'],
    ["getConsentTemplatesForStudio", 'activeTab === "overview"'],
    ["getLatestSignaturesForPractitionerView", 'activeTab === "overview"'],
    ["getActiveCardForStudioClient", 'activeTab === "overview"'],
    ["getImportedTreatmentMemoriesForClient", 'activeTab === "overview"'],
    ["getRecentPortalAccessEvents", 'activeTab === "overview"'],
  ];

  for (const [helper, predicate] of GATED) {
    it(`${helper} is gated by ${predicate}`, () => {
      const calls = callsTo(helper);
      expect(calls.length, `${helper} not called`).toBeGreaterThan(0);
      for (const call of calls) {
        const resolved = resolveCondition(enclosingConditionText(call));
        expect(
          resolved,
          `${helper} resolves to \`${resolved}\`, not ${predicate}`,
        ).toContain(predicate);
      }
    });
  }

  it("pins every flag's definition, so a redefinition cannot pass silently", () => {
    // The hole Codex found: the loop above used to match the flag's NAME.
    // Redefining needsTreatmentPlans to the sessions tab kept the suite green
    // while the Treatment tab rendered no plans.
    expect(flagDefinition("isOverview")).toBe('activeTab === "overview"');
    expect(flagDefinition("needsIntake")).toBe('isOverview || activeTab === "health"');
    expect(flagDefinition("needsPortalMessages")).toBe('isOverview || activeTab === "messages"');
    expect(flagDefinition("needsSessionsData")).toBe('activeTab === "sessions"');
    expect(flagDefinition("needsTreatmentPlans")).toBe('activeTab === "treatment"');
    expect(flagDefinition("needsPersonalNotes")).toBe('activeTab === "personal"');
    expect(flagDefinition("needsLastTreatment")).toBe('isOverview || activeTab === "sessions"');
  });

  it("keeps reads that feed the overview card ungated by their own tab", () => {
    // `intake` renders on health AND feeds computePortalPendingTasks, an
    // overview card. `portalMessages` renders on messages AND feeds the same
    // card. Gating either to one tab would silently blank that list — a
    // product change, not an optimisation.
    for (const [helper, flag] of [
      ["getLatestIntakeForClient", /needsIntake/],
      ["getPortalMessagesForPractitionerView", /needsPortalMessages/],
    ] as Array<[string, RegExp]>) {
      for (const call of callsTo(helper)) {
        expect(enclosingConditionText(call)).toMatch(flag);
      }
    }
    expect(SOURCE).toMatch(/const needsIntake =\s*isOverview \|\| activeTab === "health"/);
    expect(SOURCE).toMatch(
      /const needsPortalMessages =\s*isOverview \|\| activeTab === "messages"/,
    );
  });

  it("gates the two session_blocks reads by the tabs that render them", () => {
    // The widest reads on the page: every session's blocks plus
    // attachStructuredAreas. Last-treatment renders on overview+sessions;
    // treatment intelligence renders on overview only.
    expect(SOURCE).toMatch(
      /const needsLastTreatment = isOverview \|\| activeTab === "sessions";/,
    );
    expect(SOURCE).toMatch(
      /if \(needsLastTreatment && recentSessions\.length > 0\) \{/,
    );
    expect(SOURCE).toMatch(/if \(isOverview && sessions\.length > 0\) \{/);
  });
});

describe("nothing widened", () => {
  it("adds no new query helper to the page", () => {
    // Decomposition must not become "fetch more, in parallel". Every helper in
    // the wave existed on this page before PERF2.
    const known = [
      "getAppointmentsForClientProfile","getActiveServices","getLatestIntakeForClient",
      "getPortalAccessSummary","getLatestSubmittedOrReviewedIntakeForClient",
      "getPinnedNotesForClient","getTreatmentPlansForClient","getTotalTreatmentTime",
      "getTreatmentTimeByArea","getTreatmentGoal","getClientPersonalNotes",
      "getPortalMessagesForPractitionerView","getPortalMessageRepliesForPractitionerView",
      "getConsentTemplatesForStudio","getLatestSignaturesForPractitionerView",
      "getActiveCardForStudioClient","getImportedTreatmentMemoriesForClient",
      "getRecentPortalAccessEvents","getClientById","getCurrentPractitionerWithStudio",
      "buildClinicalNoteSections","getClientBudgetContext","getClinicalNotesSummary",
      "attachStructuredAreas","createClient",
    ];
    const wave = serialWaves().find((w) => w.getText(SF).includes("Promise.all"));
    const called = new Set<string>();
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
        called.add(n.expression.text);
      }
      ts.forEachChild(n, visit);
    };
    visit(wave as ts.Statement);
    for (const name of called) {
      if (name.startsWith("get") || name.startsWith("build")) {
        expect(known, `unexpected new read in the wave: ${name}`).toContain(name);
      }
    }
  });

  it("preserves the #610 measurement span so results stay comparable", () => {
    // The span must still open before the first domain read and close after
    // the last, or a future remeasurement cannot be compared to the 584ms p50.
    expect(SOURCE).toContain('startPerfSpan("client-profile.domain")');
    expect(SOURCE).toContain("domain.end()");
    const spanIdx = SOURCE.indexOf('startPerfSpan("client-profile.domain")');
    const waveIdx = SOURCE.indexOf("await Promise.all([");
    const endIdx = SOURCE.indexOf("domain.end()");
    expect(spanIdx).toBeLessThan(waveIdx);
    expect(waveIdx).toBeLessThan(endIdx);
  });

  it("does not widen either session_blocks projection", () => {
    // Checking only for the absence of `*` and the presence of one nested
    // fragment let ANY added column through — a future widening that exposed
    // further clinical fields would have kept this green. Both projections are
    // now compared in full against their baselines.
    const BASELINES = [
      "id, session_id, sort_order, block_name, primary_area, side, custom_area_detail, mode, apilus_modality, energy_level, minutes_performed, probe_label, probe_lot_number, tolerance_rating, reaction_type, reaction_notes, caution_for_next_session, caution_note, electrolysis_entries(observation_chips, deleted_at)",
      "id, session_id, primary_area, side, block_name, mode, apilus_modality, energy_level, machine_frequency, probe_label, minutes_performed, tolerance_rating, reaction_type, caution_for_next_session, caution_note, electrolysis_entries(hairs_treated, observation_chips, deleted_at)",
    ];

    // Pull the argument of every `.from("session_blocks").select(<string>)`.
    const found: string[] = [];
    const visit = (n: ts.Node) => {
      if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        n.expression.name.text === "select" &&
        n.arguments.length > 0 &&
        ts.isStringLiteral(n.arguments[0])
      ) {
        const chain = n.expression.expression.getText(SF);
        if (chain.includes('from("session_blocks")')) {
          found.push((n.arguments[0] as ts.StringLiteral).text.replace(/\s+/g, " ").trim());
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(SF);

    expect(found, "expected exactly two session_blocks projections").toHaveLength(2);
    expect(found.sort()).toEqual([...BASELINES].sort());
    expect(SOURCE).not.toContain('.select("*")');
  });
});
