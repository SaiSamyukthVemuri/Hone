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
// SCOPE: what the REAL-QUERY proof cannot show. This file is a structural
// tripwire, not release authority. Nothing here claims completeness over the
// page's reads; the suites named below are what a release rests on.
//
// tests/db/client-profile-tab-queries.db.test.ts is the authority for which
// reads happen per tab, and for the session_blocks projections: it runs the
// real page against local Supabase and asserts on the PostgREST requests that
// actually leave the process. Tab gating, read counts and data minimisation all
// moved there, and the static harness that used to model them is deleted.
//
// Two properties survive here because no request log shows them.
//
// Tab gating is NOT proved here and no longer can be. Five generations of
// source-level gate proof were defeated in turn — identifier presence, a
// resolved substring, an evaluated predicate blind to branch position, a
// binding-provenance walker, a hand-written React renderer — and that whole
// evidence class is retired rather than extended. The machinery it needed
// (flag resolution, enclosing-condition lookup, call census) is deleted from
// this file along with it.
//
// The authorities that replaced it, all of which run the real page:
//
//   * tests/db/client-profile-tab-queries.db.test.ts — which reads each tab
//     issues, off the wire, against the local stack;
//   * tests/db/client-profile-tab-behaviour.db.test.ts — what a practitioner
//     actually sees on each tab, rendered by real react-dom/server;
//   * app/(app)/clients/[id]/deferred-reads.ts — a dev/test invariant that
//     throws if a tab renders data whose read was deferred.
//
// What remains here are two properties execution genuinely cannot establish:
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

describe("independent reads run in one parallel wave", () => {
  it("collapses the page to a small number of serial waves", () => {
    // Was 14 await-bearing top-level statements (2 framework params + 12 data
    // waves): getClientById, then seven single reads, a ten-way Promise.all,
    // one more read, the tab-gated notes, and two session_blocks blocks.
    //
    // PERF-02A raised this ceiling from 10 to 11, and the direction is worth
    // stating because it looks backwards in a performance change. This counter
    // sees TOP-LEVEL awaits only, so the two `attachStructuredAreas` calls that
    // used to sit INSIDE the two session_blocks if/else branches were never
    // counted. PERF-02A merged them into one call, which is top-level and
    // therefore visible: +1 counted wave, -1 actual session_block_areas read,
    // and the overview tab went from four serial stages in that region to
    // three. The ceiling exists to stop the page drifting back toward 14; it is
    // not a proxy for round trips, and the DB lane
    // (tests/db/client-profile-tab-queries.db.test.ts) is what counts those.
    const waves = serialWaves();
    expect(waves.length).toBeLessThanOrEqual(11);
  });

  // PERF-02A. The invariant the ceiling above cannot express, and the one this
  // slice actually establishes: the page attaches structured areas EXACTLY
  // ONCE. `recentSessions` is a strict prefix of the intelligence window and
  // getSessionBlockAreasByBlockIds de-duplicates its ids, so a second call can
  // only ever re-fetch rows the first already has.
  it("attaches structured areas exactly once", () => {
    const calls = SOURCE.match(/attachStructuredAreas\(/g) ?? [];
    expect(
      calls.length,
      "a second attachStructuredAreas call re-reads session_block_areas rows the first already fetched",
    ).toBe(1);
  });

  it("still passes the studio id to the areas read (cross-studio defence in depth)", () => {
    // RLS already scopes it; queries.ts documents this filter as the guard that
    // stops a cross-studio block id surfacing a foreign area row. Merging the
    // two calls must not quietly drop it.
    expect(SOURCE).toMatch(/attachStructuredAreas\([\s\S]{0,200}?studio\.id/);
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
      // PERF-02A: the single structured-areas attach. Genuinely serial — it
      // depends on the output of BOTH session_blocks reads — and it replaced
      // two such stages rather than adding one.
      "attachStructuredAreas",
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
