import { describe, expect, it } from "vitest";
// @ts-expect-error - .mjs utility ships without type declarations
import { buildGraph, selftest, stripComments, queryRpc, queryTable, queryModule, queryAuthority, REFUSED_CONCLUSIONS } from "../../scripts/eng/blast-radius.mjs";

// ===========================================================================
// BLAST-RADIUS RECON — SOURCE OBSERVATION ONLY
// ===========================================================================
//
// These pin the defects found during the pilot, each of which produced a
// plausible, confident, WRONG answer. A regex indexer does not crash; it
// quietly returns a smaller graph. That is why the completeness invariants are
// fail-closed and why the frozen oracles below must not drift.
// ===========================================================================

const g = buildGraph();
const st = selftest(g);

describe("blast-radius: the graph is complete enough to answer anything", () => {
  it("passes every mandatory completeness invariant", () => {
    expect(st.failed, `failed invariants: ${st.failed.join(", ")}`).toEqual([]);
    expect(st.pass).toBe(true);
  });

  it("FAILS CLOSED when import coverage collapses (the 17.9% silent-loss defect)", () => {
    // Pilot defect: a newline-forbidding IMPORT regex dropped 17.9% of
    // statements and understated privileged reachability by 31 files while
    // looking entirely plausible. Coverage loss must be a hard failure.
    const crippled = { ...g, edges: g.edges.filter((e: { type: string }) => e.type !== "IMPORT") };
    const bad = selftest(crippled);
    expect(bad.pass).toBe(false);
    expect(bad.failed).toContain("parser_import_coverage");
  });

  it("FAILS CLOSED when TABLE edges cite the wrong line", () => {
    const shifted = {
      ...g,
      edges: g.edges.map((e: { type: string; line: number }) =>
        e.type.startsWith("TABLE_") ? { ...e, line: e.line + 3 } : e,
      ),
    };
    const bad = selftest(shifted);
    expect(bad.pass).toBe(false);
    expect(bad.failed).toContain("table_edge_line_self_verification");
  });

  it("every literal TABLE edge cites a line that really contains the call", () => {
    const inv = st.invariants.find((i: { id: string }) => i.id === "table_edge_line_self_verification");
    expect(inv?.pass).toBe(true);
    expect(inv?.detail).toMatch(/ 0 mismatched/);
  });
});

describe("blast-radius: comments are not code", () => {
  it("blanks line and block comments while preserving offsets", () => {
    const src = 'const a = 1; // .from("ghost")\n/* .rpc("ghost") */\nconst b = 2;';
    const out = stripComments(src);
    expect(out).not.toContain("ghost");
    expect(out.length).toBe(src.length);
    expect(out.split("\n").length).toBe(src.split("\n").length);
  });

  it("does not eat a URL inside a string", () => {
    expect(stripComments('const u = "https://hone.care/x";')).toContain("https://hone.care/x");
  });

  it("a comment saying `No createAdminClient` is not a service-role call site", () => {
    // Observed in the pilot: a comment asserting the file does NOT hold
    // service-role authority was counted as evidence that it does.
    const src = 'export const x = 1;\n//     No createAdminClient / service role.\n';
    expect(stripComments(src)).not.toContain("createAdminClient");
  });
});

describe("blast-radius: type-only imports are erased, not runtime edges", () => {
  it("classifies `import type` as TYPE_ONLY", () => {
    expect(g.edges.filter((e: { type: string }) => e.type === "TYPE_ONLY").length).toBeGreaterThan(100);
  });

  it("a type-only consumer is never a production consumer", () => {
    for (const e of g.edges.filter((x: { type: string }) => x.type === "TYPE_ONLY")) {
      expect(["IMPORT", "FUNCTION_CALL", "REEXPORT"]).not.toContain(e.type);
    }
  });
});

describe("blast-radius: frozen oracles must not drift", () => {
  it("join_new_client_waitlist has exactly ONE runtime caller", () => {
    const r = queryRpc(g, "join_new_client_waitlist");
    expect(r.runtimeCallers).toHaveLength(1);
    expect(r.runtimeCallers[0]).toMatch(/^app\/book\/\[slug\]\/waitlist-actions\.ts:L\d+$/);
  });

  it("remove_new_client_waitlist_entry has exactly ONE runtime caller", () => {
    expect(queryRpc(g, "remove_new_client_waitlist_entry").runtimeCallers).toHaveLength(1);
  });

  it("the un-wired WAIT-03 commands have ZERO runtime callers", () => {
    for (const cmd of [
      "claim_new_client_waitlist_entries",
      "claim_new_client_waitlist_entry",
      "issue_new_client_waitlist_invitation",
      "redeem_new_client_waitlist_invitation",
      "expire_new_client_waitlist_invitation",
      "release_new_client_waitlist_entry",
      "requeue_new_client_waitlist_entry",
      "record_new_client_waitlist_conversion",
    ]) {
      expect(queryRpc(g, cmd).runtimeCallers, `${cmd} should have no runtime caller`).toEqual([]);
    }
  });

  it("a redefined function is ONE identity with N historical definitions", () => {
    const r = queryRpc(g, "join_new_client_waitlist");
    expect(r.definitionCount).toBeGreaterThan(1);
    expect(r.sqlDefinitionInMigrationHistory.length).toBe(r.definitionCount);
  });
});

describe("blast-radius: refuses hosted conclusions", () => {
  it("every hosted property reads HOSTED_CURRENT_UNKNOWN", () => {
    const r = queryRpc(g, "join_new_client_waitlist");
    for (const v of Object.values(r.hosted)) expect(v).toBe("HOSTED_CURRENT_UNKNOWN");
  });

  it("names the conclusions it refuses to draw", () => {
    for (const k of [
      "effective_rls_permission",
      "effective_grants",
      "function_owner",
      "effective_search_path",
      "hosted_function_exists",
      "hosted_function_definition",
      "hosted_schema_truth",
      "production_state",
      "release_readiness",
    ]) {
      expect(REFUSED_CONCLUSIONS).toContain(k);
    }
  });

  it("a table answer states that reachable is not permitted", () => {
    expect(queryTable(g, "sessions").caveat).toMatch(/NOTHING about whether RLS permits/i);
  });

  it("an authority answer refuses to claim effective grants", () => {
    expect(queryAuthority(g).caveat).toMatch(/HOSTED_CURRENT_UNKNOWN/);
  });
});

describe("blast-radius: dynamic table names are never guessed", () => {
  it("records a dynamic .from(variable) as UNKNOWN_DYNAMIC", () => {
    const dyn = g.edges.filter((e: { to: string }) => e.to === "table:UNKNOWN_DYNAMIC");
    expect(dyn.length).toBeGreaterThan(0);
    for (const e of dyn) expect(e.detail).toMatch(/^dynamic:/);
  });
});

describe("blast-radius: module consumers are categorised, never merged", () => {
  it("separates production, test, re-export and type-only consumers", () => {
    const r = queryModule(g, "lib/finance/financial-briefing.ts");
    expect(r.existsInTree).toBe(true);
    for (const f of r.productionConsumers) expect(f.startsWith("tests/")).toBe(false);
    for (const f of r.testConsumers) expect(f.startsWith("tests/")).toBe(true);
    // financial-spine.tsx imports it `import type` and must NOT be production.
    expect(r.productionConsumers).not.toContain("app/(app)/financials/financial-spine.tsx");
  });

  it("reports a module absent from the tree instead of substituting one", () => {
    const r = queryModule(g, "lib/client-appointment/queries.ts");
    expect(r.existsInTree).toBe(false);
    expect(r.productionConsumers).toEqual([]);
  });
});
