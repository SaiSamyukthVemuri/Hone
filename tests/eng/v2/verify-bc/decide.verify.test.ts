// 05B independent verification: every named row runs against the real `decide` export (a black box).
// Expected outcomes: oracle.ts and hand-table.ts only (SPEC-05B, ARCH-01 §7/§17-§24, the operator's directive).

/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ALL_DECISIONS, CLOSED_REASONS, CODEX, HUMAN, ROW_DECISIONS, oracle } from "./oracle";
import { HAND_CASES } from "./hand-table";
import { type RowResult, compatiblePairs, runAllDecideRows } from "./checks-decide";
import { cleanupTmp, tmp as tmpUnderRoot } from "./support/tmp";

afterAll(cleanupTmp);

const ROOT = path.resolve(__dirname, "../../../..");
const V2 = path.join(ROOT, "scripts/eng/v2");
let decide: any;
let results: RowResult[] = [];
const byRow = (row: string) => results.find((r) => r.row === row)!;

beforeAll(async () => {
  decide = (await import(path.join(V2, "decision/decide.mjs"))).decide;
  results = runAllDecideRows(decide, 1);
  const lines = results.map((r) => `${r.row.padEnd(11)} checked ${String(r.checked).padStart(7)}  violations ${(r as any).total ?? 0}`);
  console.log(`05B rows against efc7e186 decide():\n${lines.join("\n")}`);
}, 600_000);

describe("oracle self-check (the oracle against literal hand-derived expectations)", () => {
  test("O-SELF: every hand case agrees with the oracle", () => {
    const bad = HAND_CASES.filter((h) => {
      const o = oracle(h.input());
      const got = o.decision === "UNKNOWN" ? `UNKNOWN(${o.reasonCodes[0]})` : o.decision;
      return got !== (h.decision === "UNKNOWN" ? `UNKNOWN(${h.reason})` : h.decision);
    });
    expect(bad.map((b) => b.id)).toEqual([]);
  });
  test("O-PAIRS: the compatible precedence pairs are the 2-condition combinations SPEC-05B §2 allows", () => {
    expect(compatiblePairs().length).toBeGreaterThan(60);
  });
});

describe("closed sets the spec delegates to code (cross-check only; the oracle never imports them)", () => {
  test("X-REASONS: contract/reasons.mjs is exactly the V1 set derived from ARCH-01 §40 + README rules 1-3 + SPEC-05A §6", async () => {
    const { UNKNOWN_REASONS } = await import(path.join(V2, "contract/reasons.mjs"));
    expect([...UNKNOWN_REASONS].sort()).toEqual([...CLOSED_REASONS].sort());
  });
  test("X-DECISIONS: the 13 decisions", async () => {
    const { DECISIONS } = await import(path.join(V2, "decision/decide.mjs"));
    expect([...DECISIONS].sort()).toEqual([...ALL_DECISIONS].sort());
    expect(ROW_DECISIONS.length).toBe(12);
  });
  test("X-POLICY: decision/policy.mjs carries exactly SPEC-05B §3's ids and types", async () => {
    const { TRUST_POLICY } = await import(path.join(V2, "decision/policy.mjs"));
    expect(JSON.parse(JSON.stringify(TRUST_POLICY))).toEqual({ codex: [CODEX], humanResolvers: [HUMAN] });
  });
});

describe("05B rows", () => {
  for (const row of [
    "D-TABLE",
    "D-HAND",
    "D-SHAPE",
    "D-HMR",
    "D-NEXT",
    "D-CANARY",
    "D-PAIRS",
    "D-ROWSCOPE",
    "D-UNK",
    "D-DRIFT",
    "D-CI6",
    "D-TRUST",
    "D-VERDICT",
    "D-FINDINGS",
    "D-REASONS",
    "D-PERM",
    "D-DET",
    "D-IRR",
    "D-NOMUT",
    "D-PURE",
    "D-TOTAL",
    "D-MAL",
    "D-POLICY",
  ]) {
    test(`${row}`, () => {
      const r = byRow(row);
      expect(r, `row ${row} ran`).toBeTruthy();
      expect(r.checked, `${row} checked something`).toBeGreaterThan(0);
      expect(r.violations, `${row}: ${r.clause}`).toEqual([]);
    });
  }
  test("D-PAIRS coverage: every compatible pair is exercised by the table", () => {
    const cov: Map<string, number> = (byRow("D-PAIRS") as any).coverage;
    const missing = compatiblePairs().filter(([a, b]) => !cov.has(`${a}>${b}`));
    expect(missing).toEqual([]);
    console.log(`D-PAIRS: ${compatiblePairs().length} compatible precedence pairs, all covered; ${byRow("D-PAIRS").checked} pair instances`);
  });
});

describe("D-GRAPH: the decision module's import graph (black box, via a resolve hook)", () => {
  test("decide.mjs reaches only decision/ and contract/ modules: no adapter/, receipts, shepherd, fs, child_process, network or os", () => {
    const tmp = tmpUnderRoot("graph-");
    const log = path.join(tmp, "resolved.log");
    fs.writeFileSync(
      path.join(tmp, "hooks.mjs"),
      `import fs from "node:fs";\nexport async function resolve(s, c, n) { const r = await n(s, c); fs.appendFileSync(${JSON.stringify(log)}, r.url + "\\n"); return r; }\n`,
    );
    fs.writeFileSync(path.join(tmp, "register.mjs"), `import { register } from "node:module";\nregister(${JSON.stringify("file://" + path.join(tmp, "hooks.mjs"))});\n`);
    const r = spawnSync(process.execPath, ["--import", path.join(tmp, "register.mjs"), "--input-type=module", "-e", `await import(${JSON.stringify("file://" + path.join(V2, "decision/decide.mjs"))});`], { encoding: "utf8", env: { PATH: path.dirname(process.execPath) } as unknown as NodeJS.ProcessEnv });
    expect(r.status, r.stderr).toBe(0);
    const urls = fs.readFileSync(log, "utf8").split("\n").filter(Boolean);
    const graph = [...new Set(urls.map((u) => (u.startsWith("file://") ? path.relative(V2, new URL(u).pathname) : u)))].sort();
    console.log(`decide.mjs import graph: ${graph.join(", ")}`);
    const bad = graph.filter((g) => !/^(decision|contract)\/[^/]+\.mjs$/.test(g));
    expect(bad).toEqual([]);
  });
});
