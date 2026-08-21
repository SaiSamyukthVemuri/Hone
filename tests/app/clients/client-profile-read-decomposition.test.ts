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
    const text = (wave as ts.Statement).getText(SF);
    // Every read that depends only on (studio.id, client.id) belongs here.
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
      expect(text, `${helper} is not in the parallel wave`).toContain(helper);
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
  const GATED: Array<[string, RegExp]> = [
    ["getAppointmentsForClientProfile", /needsSessionsData/],
    ["getTotalTreatmentTime", /needsSessionsData/],
    ["getTreatmentTimeByArea", /needsSessionsData/],
    ["getTreatmentGoal", /needsSessionsData/],
    ["getTreatmentPlansForClient", /needsTreatmentPlans/],
    ["getClientPersonalNotes", /needsPersonalNotes/],
    ["getPortalMessageRepliesForPractitionerView", /activeTab === "messages"/],
    ["getPortalAccessSummary", /isOverview/],
    ["getLatestSubmittedOrReviewedIntakeForClient", /isOverview/],
    ["getPinnedNotesForClient", /isOverview/],
    ["getConsentTemplatesForStudio", /isOverview/],
    ["getLatestSignaturesForPractitionerView", /isOverview/],
    ["getActiveCardForStudioClient", /isOverview/],
    ["getImportedTreatmentMemoriesForClient", /isOverview/],
    ["getRecentPortalAccessEvents", /isOverview/],
  ];

  for (const [helper, flag] of GATED) {
    it(`${helper} only runs for its own tab`, () => {
      const calls = callsTo(helper);
      expect(calls.length, `${helper} not called`).toBeGreaterThan(0);
      for (const call of calls) {
        expect(
          enclosingConditionText(call),
          `${helper} is not gated by ${flag}`,
        ).toMatch(flag);
      }
    });
  }

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

  it("does not widen any SELECT projection", () => {
    // PERF2 is decomposition only. The two session_blocks selects keep their
    // exact column lists.
    expect(SOURCE).not.toContain('.select("*")');
    expect(SOURCE).toContain("electrolysis_entries(hairs_treated, observation_chips, deleted_at)");
  });
});
