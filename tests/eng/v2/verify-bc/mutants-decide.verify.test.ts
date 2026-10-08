// Mutation detection for 05B: every unsafe mutant of the real `decide` must be caught by at least one named row.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeAll, describe, expect, test } from "vitest";
import path from "node:path";
import { runAllDecideRows } from "./checks-decide";
import { decideMutants } from "./mutants-decide";

const V2 = path.resolve(__dirname, "../../../../scripts/eng/v2");
let real: any;
const caughtBy: Record<string, string[]> = {};

beforeAll(async () => {
  real = (await import(path.join(V2, "decision/decide.mjs"))).decide;
  const mutants = decideMutants(real);
  for (const [name, m] of Object.entries(mutants)) {
    const rows = runAllDecideRows(m, 17);
    caughtBy[name] = rows.filter((r) => r.violations.length > 0).map((r) => r.row);
  }
  console.log(
    "05B mutants → catching rows:\n" +
      Object.entries(caughtBy)
        .map(([n, rows]) => `${rows.length > 0 ? "CAUGHT " : "MISSED "} ${n}: ${rows.join(", ") || "-"}`)
        .join("\n"),
  );
}, 900_000);

describe("05B mutants", () => {
  test("the real decide passes every row at the mutant stride (control)", () => {
    const rows = runAllDecideRows(real, 17);
    expect(rows.filter((r) => r.violations.length > 0).map((r) => `${r.row}: ${JSON.stringify(r.violations[0])}`)).toEqual([]);
  });
  test("every mutant is caught by at least one named row", () => {
    const missed = Object.entries(caughtBy).filter(([, rows]) => rows.length === 0).map(([n]) => n);
    expect(missed).toEqual([]);
    expect(Object.keys(caughtBy).length).toBe(37);
  });
  const expectations: [string, string][] = [
    ["M01 drift checked after CI (rows 3/4 swapped)", "D-DRIFT"],
    ["M02 trust by numeric id only", "D-TRUST"],
    ["M03 DISMISSED accepted as a review", "D-VERDICT"],
    ["M04 PENDING accepted as a review", "D-VERDICT"],
    ["M05 skipped UNKNOWN row: external failure read as no contexts", "D-ROWSCOPE"],
    ["M06 skipped UNKNOWN row: reviews failure read as a clean review", "D-UNK"],
    ["M07 skipped UNKNOWN row: ci failure read as SUCCEEDED", "D-ROWSCOPE"],
    ["M08 skipped UNKNOWN row: base failure read as up to date", "D-ROWSCOPE"],
    ["M09 CI_INCOMPLETE decided before row 3", "D-CI6"],
    ["M10 CI_INCOMPLETE decided after row 10", "D-CI6"],
    ["M17 humanMergeRequired false on CANDIDATE", "D-HMR"],
    ["M18 nextAction copies the failure detail", "D-CANARY"],
    ["M19 whole-snapshot UNKNOWN (ARCH-01 §8, not row-scoped)", "D-ROWSCOPE"],
    ["M20 blocking sources in input order (unsorted)", "D-PERM"],
    ["M21 reads the clock", "D-PURE"],
    ["M22 reads a file", "D-PURE"],
    ["M23 reads the environment (credential)", "D-PURE"],
    ["M24 throws on hostile input", "D-TOTAL"],
    ["M26 malformed review elements skipped", "D-MAL"],
    ["M30 mutates its input", "D-NOMUT"],
    ["M31 shared mutable state: memoizes decisions by evidenceHash", "D-TABLE"],
    ["M33 shared mutable state: every other CANDIDATE flips", "D-HAND"],
    ["M15 order-dependent: only the first review counts", "D-TABLE"],
    ["M27 terminal flag trusted over key.state", "D-MAL"],
    ["M32 unknown CI outcome read as success (interprets GitHub enums)", "D-MAL"],
    ["M34 out-of-enum verdict or channel treated as inert", "D-MAL"],
    ["M35 evidence.schema not checked", "D-MAL"],
    ["M36 applicableRunIds not checked", "D-MAL"],
    ["M37 malformed anywhere decides malformed (not row-scoped)", "D-MAL-SCOPE"],
  ];
  for (const [mutant, row] of expectations) {
    test(`${mutant} is caught by ${row}`, () => {
      expect(caughtBy[mutant]).toContain(row);
    });
  }
});
