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
// SCOPE: what the REAL-QUERY proof cannot show.
//
// tests/db/client-profile-tab-queries.db.test.ts is the authority for which
// reads happen per tab, and for the session_blocks projections: it runs the
// real page against local Supabase and asserts on the PostgREST requests that
// actually leave the process. Tab gating, read counts and data minimisation all
// moved there, and the static harness that used to model them is deleted.
//
// Two properties survive here because no request log shows them.
//
// Tab gating moved to tests/app/clients/client-profile-tab-loaders.test.ts,
// which invokes the real component once per tab against a faked loader
// boundary and asserts the exact set of reads that run. Four generations of
// source-level gate proof were defeated in turn — identifier presence, then a
// resolved substring, then an evaluated predicate blind to branch position and
// binding provenance — so that authority is retired rather than extended, and
// there is exactly one authority for tab behaviour.
//
// What remains here are properties execution genuinely cannot establish:
//
//   1. PARALLELISM — that the independent reads sit in one Promise.all rather
//      than a chain of awaits. Invocation records cannot distinguish those.
//   2. INSTRUMENTATION PLACEMENT — that the #610 span still encloses the
//      domain work, so a remeasurement stays comparable to the 584ms baseline.
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

describe("nothing widened", () => {
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

});
