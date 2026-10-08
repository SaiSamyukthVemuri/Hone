// 05C independent verification, in process: the real `runShepherdCli` export with an injected fake `gh` spawn
// (README contract: runShepherdCli({ argv, env, out, err, now, spawn, local, toolVersion, receiptsDir })).

/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import path from "node:path";
import {
  checkNoToken,
  checkReceiptModes,
  checkShepherd,
  checkText,
  checkTokenEcho,
  checkUsage,
  checkUsageExit,
  scenarios,
} from "./checks-shepherd";
// @ts-expect-error untyped support module
import { makeFakeRequest } from "./support/fake-gh.mjs";
import { cleanupTmp, redirectTmpdir } from "./support/tmp";

redirectTmpdir();
afterAll(cleanupTmp);

const V2 = path.resolve(__dirname, "../../../../scripts/eng/v2");
let runShepherdCli: any;
const rows: Record<string, any> = {};

beforeAll(async () => {
  ({ runShepherdCli } = await import(path.join(V2, "cli-shepherd.mjs")));
  const { collect } = await import(path.join(V2, "adapter/collect.mjs"));
  const { createReaders, POLICY } = await import(path.join(V2, "adapter/internal/github/index.mjs"));
  const { loadLocalCi } = await import(path.join(V2, "adapter/local-ci.mjs"));
  const hashOf = (w: any) => {
    const c = collect({ prNumber: 800, readers: createReaders({ request: makeFakeRequest(w), policy: POLICY }), local: loadLocalCi(), now: () => "2026-10-07T20:00:00Z" });
    return c.ok ? c.evidenceHash : null;
  };
  const scen = scenarios(hashOf);
  for (const r of [...checkShepherd(runShepherdCli, scen), checkText(runShepherdCli, scen), checkUsage(runShepherdCli), checkUsageExit(runShepherdCli), checkNoToken(runShepherdCli), checkTokenEcho(runShepherdCli), checkReceiptModes(runShepherdCli)]) rows[r.row] = r;
  console.log(
    "05C rows against efc7e186 runShepherdCli():\n" +
      Object.values(rows)
        .map((r: any) => `${r.row.padEnd(16)} checked ${String(r.checked).padStart(4)}  violations ${r.total}${r.total ? "  e.g. " + JSON.stringify(r.violations[0]) : ""}`)
        .join("\n"),
  );
}, 600_000);

describe("05C rows (in process)", () => {
  for (const row of ["C-JSON", "C-FIELDS", "C-DECISION", "C-VALUES", "C-EXIT", "C-NOMUT", "C-ENV", "C-TOKEN", "C-RECEIPT", "C-TEXT", "C-USAGE", "C-USAGE-EXIT", "C-NOTOKEN", "C-TOKEN-ECHO", "C-RECEIPT-MODES"]) {
    test(row, () => {
      const r = rows[row];
      expect(r, `${row} ran`).toBeTruthy();
      expect(r.checked).toBeGreaterThan(0);
      expect(r.violations, `${row}: ${r.clause}`).toEqual([]);
    });
  }
});
