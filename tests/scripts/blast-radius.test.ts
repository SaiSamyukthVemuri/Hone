import { describe, expect, it } from "vitest";
// @ts-expect-error - .mjs utility ships without type declarations
import { buildGraph, selftest, codeMask, codeSpans, importOracle, refusalContract, queryRpc, queryTable, queryModule, queryAuthority, REFUSED_CONCLUSIONS } from "../../scripts/eng/blast-radius.mjs";

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

  // PARTIAL import loss must fail closed, not just total deletion. The previous
  // ratio invariant survived the exact 17.9% defect it was written for, which
  // is why completeness is now proved against TypeScript's own scanner.
  const IMPORT_TYPES = ["IMPORT", "REEXPORT", "TYPE_ONLY"];
  function dropFraction(fraction: number) {
    const imports = g.edges.filter((e: { type: string }) => IMPORT_TYPES.includes(e.type));
    const drop = new Set(imports.slice(0, Math.max(1, Math.round(imports.length * fraction))));
    return { ...g, edges: g.edges.filter((e: unknown) => !drop.has(e)) };
  }

  for (const pct of [0.01, 0.1, 0.179]) {
    it(`FAILS CLOSED at ${(pct * 100).toFixed(1)}% import loss`, () => {
      const bad = selftest(dropFraction(pct));
      expect(bad.pass, `${(pct * 100).toFixed(1)}% loss must not pass`).toBe(false);
      expect(bad.failed).toContain("import_completeness_vs_typescript");
    });
  }

  it("FAILS CLOSED when ONE load-bearing import is removed", () => {
    const one = g.edges.find(
      (e: { type: string; from: string; to: string }) =>
        e.type === "IMPORT" &&
        e.from === "app/(app)/financials/page.tsx" &&
        e.to === "lib/finance/financial-briefing.ts",
    );
    expect(one, "the load-bearing fixture import must exist").toBeTruthy();
    const bad = selftest({ ...g, edges: g.edges.filter((e: unknown) => e !== one) });
    expect(bad.pass).toBe(false);
    expect(bad.failed).toContain("import_completeness_vs_typescript");
  });

  it("the completeness oracle is an INDEPENDENT parser, and is available", () => {
    const o = importOracle(g);
    expect(o.available, `oracle unavailable: ${o.reason}`).toBe(true);
    expect(o.tsVersion).toMatch(/^\d+\./);
    expect(o.filesCompared).toBeGreaterThan(500);
    expect(o.deficitFiles).toEqual([]);
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
    const out = codeMask(src);
    expect(out).not.toContain("ghost");
    expect(out.length).toBe(src.length);
    expect(out.split("\n").length).toBe(src.split("\n").length);
  });

  it("the `//` inside a string URL does not start a comment and eat the line", () => {
    // The URL body is blanked because it is string DATA, not code. What matters
    // is that the scanner did not treat `//` as a line comment: the closing
    // quote, the semicolon and everything after must survive as code.
    const src = 'const u = "https://hone.care/x"; const after = 1;';
    const m = codeMask(src);
    expect(m).toContain('const u = "');
    expect(m).toContain('"; const after = 1;');
    expect(m).not.toContain("hone.care");
  });

  it("a comment saying `No createAdminClient` is not a service-role call site", () => {
    // Observed in the pilot: a comment asserting the file does NOT hold
    // service-role authority was counted as evidence that it does.
    const src = 'export const x = 1;\n//     No createAdminClient / service role.\n';
    expect(codeMask(src)).not.toContain("createAdminClient");
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
  it("every refused conclusion reads HOSTED_CURRENT_UNKNOWN", () => {
    const r = queryRpc(g, "join_new_client_waitlist");
    for (const v of Object.values(r.refuses)) expect(v).toBe("HOSTED_CURRENT_UNKNOWN");
  });

  it("names the conclusions it refuses to draw", () => {
    for (const k of [
      "effectiveRlsPermission",
      "effectiveGrants",
      "functionOwner",
      "effectiveSearchPath",
      "hostedFunctionExistence",
      "hostedFunctionDefinition",
      "hostedSchemaTruth",
      "productionState",
      "releaseReadiness",
    ]) {
      expect(REFUSED_CONCLUSIONS).toContain(k);
    }
  });

  it("a table answer states that reachable is not permitted", () => {
    expect(queryTable(g, "sessions").caveat).toMatch(/NOTHING about whether RLS permits/i);
  });

  it("an authority answer refuses to claim effective grants", () => {
    const a = queryAuthority(g);
    expect(a.refuses.effectiveGrants).toBe("HOSTED_CURRENT_UNKNOWN");
    expect(a.caveat).toMatch(/import reach, not authority/);
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


describe("blast-radius: detectors never read non-code (P1)", () => {
  const GHOSTS = ['createAdminClient()', `.from('ghost')`, `.rpc('ghost')`];

  it("a ghost call inside a STRING creates no code-bearing span", () => {
    for (const gst of GHOSTS) {
      const src = `const s = ${JSON.stringify(gst)};`;
      expect(codeMask(src), `string: ${gst}`).not.toContain(gst.slice(0, 8));
    }
  });

  it("a ghost call inside a LINE COMMENT creates no code-bearing span", () => {
    for (const gst of GHOSTS) expect(codeMask(`// ${gst}\n`)).not.toContain(gst.slice(0, 8));
  });

  it("a ghost call inside a BLOCK COMMENT creates no code-bearing span", () => {
    for (const gst of GHOSTS) expect(codeMask(`/* ${gst} */`)).not.toContain(gst.slice(0, 8));
  });

  it("a ghost call inside a TEMPLATE LITERAL's text creates no code-bearing span", () => {
    for (const gst of GHOSTS) expect(codeMask("const t = `" + gst + "`;")).not.toContain(gst.slice(0, 8));
  });

  it("a ghost call inside a REGEX LITERAL creates no code-bearing span", () => {
    expect(codeMask('const r = /\\.from\\("ghost"\\)/g;')).not.toContain("ghost");
  });

  it("keeps a real expression inside ${...} as code", () => {
    const src = "const t = `x ${admin.rpc(NAME)} y`;";
    const m = codeMask(src);
    expect(m).toContain("admin.rpc(NAME)");
    expect(m).not.toContain("x ");
  });

  it("division is not mistaken for a regex literal", () => {
    const src = "const q = total / count; const w = other / two;";
    expect(codeMask(src)).toBe(src);
  });

  it("offsets and line structure survive masking", () => {
    const src = 'a;\n// c\n/* b\n b */\n`t`;\n';
    const m = codeMask(src);
    expect(m.length).toBe(src.length);
    expect(m.split("\n").length).toBe(src.split("\n").length);
  });

  it("no ghost table/rpc/authority edge exists anywhere in the real graph", () => {
    expect(g.edges.filter((e: { to: string }) => e.to === "table:ghost")).toEqual([]);
    expect(g.edges.filter((e: { to: string }) => e.to === "sqlfn:ghost")).toEqual([]);
  });

  it("exposes a code-span map the detectors are gated on", () => {
    const src = 'const s = ".from(\'ghost\')";';
    const { code } = codeSpans(src);
    expect(code[src.indexOf(".from(")]).toBe(0);
    expect(code[0]).toBe(1);
  });
});

describe("blast-radius: type-position import() is erased (P2)", () => {
  it("classifies `typeof import(...)` and type-alias import(...) as TYPE_ONLY", () => {
    const typePos = g.edges.filter(
      (e: { type: string; detail?: string }) => e.detail === "type-position",
    );
    for (const e of typePos) expect(e.type).toBe("TYPE_ONLY");
  });

  it("a runtime `await import(...)` stays a runtime IMPORT", () => {
    const runtimeDynamic = g.edges.filter(
      (e: { type: string; detail?: string }) => e.detail === "dynamic",
    );
    for (const e of runtimeDynamic) expect(e.type).toBe("IMPORT");
    expect(runtimeDynamic.length).toBeGreaterThan(0);
  });

  it("type-only edges never enter transitive runtime reachability", () => {
    const a = queryAuthority(g);
    expect(a.runtimeTransitiveReach).toBeGreaterThan(0);
    for (const f of a.directServiceRoleHolders) expect(f.startsWith("tests/")).toBe(false);
  });
});

describe("blast-radius: the refusal contract is structural (P1)", () => {
  const results = [
    ["rpc", queryRpc(g, "join_new_client_waitlist")],
    ["table", queryTable(g, "sessions")],
    ["module", queryModule(g, "lib/finance/financial-briefing.ts")],
    ["authority", queryAuthority(g)],
  ] as const;

  it("every command returns the refusal as an OBJECT, never a list of names", () => {
    for (const [name, res] of results) {
      expect(Array.isArray((res as { refuses: unknown }).refuses), `${name} must not emit a bare list`).toBe(false);
      expect(typeof (res as { refuses: unknown }).refuses, name).toBe("object");
    }
  });

  it("every command stamps EVERY refused conclusion, always present", () => {
    for (const [name, res] of results) {
      const r = (res as { refuses: Record<string, string> }).refuses;
      for (const key of REFUSED_CONCLUSIONS) {
        expect(Object.hasOwn(r, key), `${name} is missing ${key}`).toBe(true);
        expect(r[key], `${name}.${key}`).toBe("HOSTED_CURRENT_UNKNOWN");
      }
      expect(Object.keys(r).sort()).toEqual([...REFUSED_CONCLUSIONS].sort());
    }
  });

  it("names the nine forbidden conclusions exactly once, canonically", () => {
    expect([...REFUSED_CONCLUSIONS].sort()).toEqual([
      "effectiveGrants", "effectiveRlsPermission", "effectiveSearchPath", "functionOwner",
      "hostedFunctionDefinition", "hostedFunctionExistence", "hostedSchemaTruth",
      "productionState", "releaseReadiness",
    ]);
    expect(Object.keys(refusalContract()).sort()).toEqual([...REFUSED_CONCLUSIONS].sort());
  });
});
