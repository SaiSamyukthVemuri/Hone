// Receipt guarantees against the real receipts.mjs exports (black box), plus receipt-layer mutants.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import path from "node:path";
import {
  checkAppend,
  checkCollision,
  checkLinkCrash,
  checkRace,
  checkToctou,
  checkWriterSymlink,
  probeLegacyToolVersion,
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
import { HOOK_TIMEOUT, cleanupTmp, inScope, redirectTmpdir } from "./support/tmp";
import { timed } from "./support/timing";

redirectTmpdir();
afterAll(timed("receipts afterAll cleanupTmp", cleanupTmp), HOOK_TIMEOUT);

const RECEIPTS = path.resolve(__dirname, "../../../../scripts/eng/v2/receipts.mjs");
const rows: Record<string, any> = {};
const mutantCaught: Record<string, string[]> = {};

/** The real implementation gets the full workload; each mutant a lighter one that still reaches every row it must
 * fail (each mutant's catching rows are asserted below). Every run works in its own scope, removed when it ends. */
async function allRows(mutant: string) {
  const real = mutant === "real";
  return inScope(real ? "real" : mutant.slice(0, 6), async () => {
    const api = await receiptsApi(RECEIPTS, mutant);
    const rows = [
      checkFrom(api),
      checkAppend(api),
      checkTamper(api),
      checkDirEntries(api),
      ...(real || mutant.startsWith("R-M10") ? [checkHang(RECEIPTS, mutant, real ? 30_000 : 6_000)] : []), // liveness rows: the real reader (generous) and the FIFO mutant (blocks forever)
      checkFaults(api),
      checkCollision(api),
      checkWriterSymlink(api),
      await checkConcurrency(api, RECEIPTS, mutant, real ? 12 : 6, real ? 40 : 16),
      await checkCrash(api, RECEIPTS, mutant, real ? 40 : 12),
    ];
    if (real) {
      rows.push(await checkRace(api, RECEIPTS, mutant, 2000), await checkLinkCrash(api, RECEIPTS), await checkToctou(api, RECEIPTS, mutant));
      rows[3].notes.push(probeLegacyToolVersion(api));
    }
    if (mutant.startsWith("R-M8")) rows.push(await checkRace(api, RECEIPTS, mutant, 1500, ["symlink"]), await checkToctou(api, RECEIPTS, mutant));
    if (mutant.startsWith("R-M10")) rows.push(await checkRace(api, RECEIPTS, mutant, 1500, ["fifo"]));
    return rows;
  });
}

beforeAll(timed("receipts beforeAll (real + 11 mutants)", async () => {
  for (const r of await allRows("real")) rows[r.row] = r;
  console.log(
    "Receipt rows against the builder head's receipts.mjs:\n" +
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
}), 1_800_000);

describe("receipt rows (real receipts.mjs)", () => {
  for (const row of ["R-FROM", "R-APPEND", "R-TAMPER", "R-ENTRIES", "R-HANG", "R-FAULT", "R-COLLIDE", "R-CONC", "R-CRASH", "R-RACE", "R-LINKCRASH", "R-TOCTOU", "R-WSYMLINK"]) {
    test(row, () => {
      const r = rows[row];
      expect(r, `${row} ran`).toBeTruthy();
      expect(r.checked).toBeGreaterThan(0);
      expect(r.violations, `${row}: ${r.clause}`).toEqual([]);
    });
  }
});

describe("receipt mutants", () => {
  // Attribution only to deterministic rows: the crash and race rows are probabilistic under load (they still run, and
  // must pass, for the real implementation).
  const expected: [string, string][] = [
    ["R-M1 accepts a tampered checksum", "R-TAMPER"],
    ["R-M2 interrupted writes counted as complete", "R-ENTRIES"],
    ["R-M2 interrupted writes counted as complete", "R-FAULT"],
    ["R-M3 unreadable directory read as clean", "R-ENTRIES"],
    ["R-M4 non-atomic writer (writes the final file in place)", "R-FAULT"],
    ["R-M5 receipt carries the failure detail", "R-FROM"],
    ["R-M6 overwriting writer (deterministic name)", "R-CONC"],
    ["R-M7 overwriting publish (rename instead of an exclusive link)", "R-COLLIDE"],
    ["R-M7 overwriting publish (rename instead of an exclusive link)", "R-WSYMLINK"],
    ["R-M8 symlink-following reader", "R-ENTRIES"],
    ["R-M8 symlink-following reader", "R-TOCTOU"],
    ["R-M9 reasons-consistency rule dropped", "R-FROM"],
    ["R-M9 reasons-consistency rule dropped", "R-TAMPER"],
    ["R-M10 reader blocks on a FIFO", "R-HANG"],
    ["R-M11 reader accepts files over 4 KB", "R-TAMPER"],
  ];
  for (const [m, row] of expected) {
    test(`${m} is caught by ${row}`, () => {
      expect(mutantCaught[m]).toContain(row);
    });
  }
  test("every receipt mutant is caught by at least one row", () => {
    expect(Object.entries(mutantCaught).filter(([, rs]) => rs.length === 0).map(([m]) => m)).toEqual([]);
    expect(Object.keys(mutantCaught).length).toBe(11);
  });
});
