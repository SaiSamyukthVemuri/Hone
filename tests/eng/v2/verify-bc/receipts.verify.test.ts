// Receipt guarantees against the real receipts.mjs exports (black box), plus receipt-layer mutants.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import path from "node:path";
import {
  checkAppend,
  checkCollision,
  checkConcurrency,
  checkCrash,
  checkDirEntries,
  checkFaults,
  checkFrom,
  checkHang,
  checkTamper,
} from "./checks-receipts";
// @ts-expect-error untyped support module
import { receiptsApi, RECEIPT_MUTANTS } from "./support/receipt-mutants.mjs";
import { cleanupTmp, redirectTmpdir } from "./support/tmp";

redirectTmpdir();
afterAll(cleanupTmp);

const RECEIPTS = path.resolve(__dirname, "../../../../scripts/eng/v2/receipts.mjs");
const rows: Record<string, any> = {};
const mutantCaught: Record<string, string[]> = {};

async function allRows(mutant: string) {
  const api = await receiptsApi(RECEIPTS, mutant);
  return [
    checkFrom(api),
    checkAppend(api),
    checkTamper(api),
    checkDirEntries(api),
    ...(mutant === "real" ? [checkHang(RECEIPTS, mutant)] : []), // liveness only; no mutant targets it
    checkFaults(api),
    checkCollision(api),
    await checkConcurrency(api, RECEIPTS, mutant),
    await checkCrash(api, RECEIPTS, mutant, mutant === "real" ? 40 : 25),
  ];
}

beforeAll(async () => {
  for (const r of await allRows("real")) rows[r.row] = r;
  console.log(
    "Receipt rows against efc7e186 receipts.mjs:\n" +
      Object.values(rows)
        .map((r: any) => `${r.row.padEnd(10)} checked ${String(r.checked).padStart(3)}  violations ${r.total}${r.total ? "  e.g. " + JSON.stringify(r.violations[0]) : ""}${r.notes.length ? "\n           notes: " + r.notes.join(" | ") : ""}`)
        .join("\n"),
  );
  // A mutant is caught by a row when that row reports a violation the real implementation does not.
  const baseline = new Set(Object.values(rows).flatMap((r: any) => r.violations.map((v: any) => `${r.row}|${v.id}|${v.msg}`)));
  for (const m of Object.keys(RECEIPT_MUTANTS)) {
    mutantCaught[m] = (await allRows(m)).filter((r: any) => r.violations.some((v: any) => !baseline.has(`${r.row}|${v.id}|${v.msg}`))).map((r) => r.row);
  }
  console.log("Receipt mutants → catching rows:\n" + Object.entries(mutantCaught).map(([m, rs]) => `${rs.length ? "CAUGHT" : "MISSED"} ${m}: ${rs.join(", ") || "-"}`).join("\n"));
}, 900_000);

describe("receipt rows (real receipts.mjs)", () => {
  for (const row of ["R-FROM", "R-APPEND", "R-TAMPER", "R-ENTRIES", "R-HANG", "R-FAULT", "R-COLLIDE", "R-CONC", "R-CRASH"]) {
    test(row, () => {
      const r = rows[row];
      expect(r, `${row} ran`).toBeTruthy();
      expect(r.checked).toBeGreaterThan(0);
      expect(r.violations, `${row}: ${r.clause}`).toEqual([]);
    });
  }
});

describe("receipt mutants", () => {
  const expected: [string, string][] = [
    ["R-M1 accepts a tampered checksum", "R-TAMPER"],
    ["R-M2 interrupted writes counted as complete", "R-CRASH"],
    ["R-M3 unreadable directory read as clean", "R-ENTRIES"],
    ["R-M4 non-atomic writer (writes the final file in place)", "R-CRASH"],
    ["R-M5 receipt carries the failure detail", "R-FROM"],
    ["R-M6 overwriting writer (deterministic name)", "R-CONC"],
  ];
  for (const [m, row] of expected) {
    test(`${m} is caught by ${row}`, () => {
      expect(mutantCaught[m]).toContain(row);
    });
  }
});
