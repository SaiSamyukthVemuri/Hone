/* eslint-disable @typescript-eslint/no-explicit-any -- vitest task trees are walked structurally */
// Independent verifier support: explicit per-row time budgets.
//
// vitest's default is 5 s per test. A row that takes seconds in isolation can cross
// that under load and turn CI red without cause: on the 05C tree (37 files, 1,603
// tests), "the order of runs and of jobs…" took 6,162 ms against 5,000 ms, though it
// takes about 2.3 s alone. So every row measured above about 200 ms in isolation runs
// under SLOW_ROW_MS, declared on its describe block or the row itself. The guard
// below runs at the end of every verify file:
//   1. every row this registry names carries a timeout of at least SLOW_ROW_MS
//      (deterministic: timeouts are configuration, not timing);
//   2. every row that passed finished in under half of its own timeout. A row
//      that grows slow is flagged while there is still headroom, before it times out.
//      Unbudgeted rows are at most ~120 ms alone, so this needs a 20x slowdown to fire.

import { describe, expect, it } from "vitest";

/** The explicit budget for a row measured above ~200 ms in isolation. */
export const SLOW_ROW_MS = 60_000;
/** The explicit budget for a setup hook that runs whole tables. */
export const SLOW_HOOK_MS = 120_000;

/**
 * Rows measured above ~200 ms with files run one at a time (`--fileParallelism=false`,
 * 2026-10-08, 16-core host), by file, as row-name or describe-name patterns. Each must
 * run under SLOW_ROW_MS. Isolated times are noted for the record.
 */
export const MEASURED_SLOW: Record<string, RegExp[]> = {
  "row3-ci.verify.test.ts": [
    /^the order of runs and of jobs in GitHub's answers never matters$/, // 2277 ms
    /^adding runs that are not applicable/, // 1101 ms
    /^adding a branch CREATION strictly before every run/, // 1025 ms
    /^adding ANY force push or deletion/, // 941 ms
    /^is pure: deep-frozen arguments give the same result/, // 572 ms
    /^every combination of injected faults is decided by its lowest-numbered rule$/, // 240 ms
  ],
  "mutants-pipeline.verify.test.ts": [/^detects the UNSAFE mutant:/], // 760-948 ms each
  "collect-primitive.verify.test.ts": [
    /^a timeout is read_failed/, // 510 ms
    /^the remaining settings are FIXED/, // 336 ms
    /^every request is counted and timed/, // 285 ms
    /^PATH, a fresh empty HOME/, // 202 ms
  ],
  "row1-key.verify.test.ts": [/^agrees with the §2 oracle on 4000 generated answers/, /^agrees again on an independent seed/], // 508, 239 ms
  "mutants.verify.test.ts": [/^baseline: the real row-1 functions/, /^\(d\) detects a coercing parsePrKey/], // 405, 210 ms
  "collect-mutants.verify.test.ts": [/^detects the UNSAFE mutant:/], // 248-375 ms each
};

const testsOf = (task: any): any[] => (task?.tasks ?? []).flatMap((t: any) => (t.type === "test" ? [t] : testsOf(t)));

/** Registers the budget guard as the last row of a verify file. Call it at the end of the file. */
export function budgetGuard(file: string) {
  describe("budgets: every row runs under an explicit, adequate time budget", () => {
    it("rows measured slow carry SLOW_ROW_MS, and every row finished in under half of its own timeout", ({ task }) => {
      const tests = testsOf((task as any).file).filter((t) => t !== task);
      for (const pattern of MEASURED_SLOW[file] ?? []) {
        const hits = tests.filter((t) => pattern.test(t.name));
        expect(hits.length, `${file}: no row matches ${pattern}`).toBeGreaterThan(0);
        for (const t of hits) expect(t.timeout, `${t.name}: budget`).toBeGreaterThanOrEqual(SLOW_ROW_MS);
      }
      const slowAgainstBudget = tests
        .filter((t) => t.result?.state === "pass" && typeof t.result.duration === "number" && t.result.duration >= t.timeout / 2)
        .map((t) => `${t.name}: ${Math.round(t.result.duration)} ms of a ${t.timeout} ms budget`);
      expect(slowAgainstBudget).toEqual([]);
    });
  });
}
