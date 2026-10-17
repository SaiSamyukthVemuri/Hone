import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Control proof for ui02-status-text-equivalent.test.ts.
//
// WHY THIS FILE EXISTS
// --------------------
// The historical cross-check in that suite reads the pre-slice file with
// `git show <base>:<path>`. CI's validate lane is a depth-1 checkout, so that
// object is not present and the read throws. The first version caught the
// throw, printed a warning and RETURNED — which Vitest reports as PASS.
//
// That is a test-truth defect, not a cosmetic one. On every CI run the
// "historical proof" was recorded green while doing nothing whatsoever. A proof
// that reports success without executing launders an absence of evidence into a
// passing tick, and it is strictly worse than having no such test: a reader
// checking whether the class sets were verified against real history would have
// been told yes.
//
// The repair is `ctx.skip()`, so the reporter distinguishes "ran and agreed with
// history" from "could not look at history". This file proves the repair holds,
// by RUNNING that suite in a subprocess and reading the reported status of each
// assertion — the reporter's own output, not a claim about it.
//
// The subprocess is pointed at a deliberately unreachable SHA to force the
// shallow path, which is why the suite reads its base ref from UI02_BASE_REF.

const SUITE = "tests/components/ui02-status-text-equivalent.test.ts";
const CROSS_CHECK = "the pinned base sets still match real history, where history exists";
const PINNED = "renders the SAME class set as before";
const UNREACHABLE = "0".repeat(40);
const REAL_BASE = "cec0234a9dbee31721df8e8978652f8b1b316cef";

type Result = { title: string; status: string };

function runSuite(baseRef: string): Result[] {
  const dir = mkdtempSync(path.join(tmpdir(), "ui02-proof-"));
  const out = path.join(dir, "r.json");
  try {
    try {
      execFileSync(
        "npx",
        ["vitest", "run", SUITE, "--reporter=json", `--outputFile=${out}`],
        {
          encoding: "utf8",
          stdio: ["ignore", "ignore", "ignore"],
          env: { ...process.env, UI02_BASE_REF: baseRef },
        },
      );
    } catch {
      // A non-zero exit still writes the report; the assertions below decide.
    }
    const report = JSON.parse(readFileSync(out, "utf8")) as {
      testResults: { assertionResults: Result[] }[];
    };
    return report.testResults.flatMap((t) => t.assertionResults);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const statusOf = (rs: Result[], title: string): string | undefined =>
  rs.find((r) => r.title === title)?.status;

const historyAvailable = (() => {
  try {
    execFileSync("git", ["cat-file", "-e", `${REAL_BASE}^{commit}`], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
})();

describe("UI-02 proof truth: a missing base must be SKIPPED, never PASSED", () => {
  it(
    "missing history => the cross-check reports SKIPPED, and specifically not passed",
    { timeout: 120_000 },
    () => {
      const rs = runSuite(UNREACHABLE);
      expect(rs.length, "the suite must have produced a report").toBeGreaterThan(0);

      const status = statusOf(rs, CROSS_CHECK);
      expect(status, `cross-check status was ${status}`).toBe("skipped");

      // Stated as its own assertion because THIS is the regression that mattered:
      // returning early made it "passed", and a future refactor could reintroduce
      // exactly that without changing anything else.
      expect(status).not.toBe("passed");
    },
  );

  it(
    "missing history => the non-historical assertions still EXECUTE and pass",
    { timeout: 120_000 },
    () => {
      const rs = runSuite(UNREACHABLE);

      // The pinned class-set comparison needs no history and must still run.
      expect(statusOf(rs, PINNED)).toBe("passed");

      // Nothing else may be quietly skipped along with the cross-check.
      const skipped = rs.filter((r) => r.status === "skipped").map((r) => r.title);
      expect(skipped, `unexpected skips: ${skipped.join(" | ")}`).toEqual([CROSS_CHECK]);

      const failed = rs.filter((r) => r.status === "failed").map((r) => r.title);
      expect(failed, `unexpected failures: ${failed.join(" | ")}`).toEqual([]);
    },
  );

  it(
    "full history => the cross-check actually EXECUTES and passes",
    { timeout: 120_000 },
    (ctx) => {
      if (!historyAvailable) {
        // Honest by the same rule this file enforces: on a shallow clone this
        // case cannot be observed, so it reports skipped rather than passing.
        ctx.skip(
          `base ${REAL_BASE.slice(0, 10)} unreachable here — the full-history case did NOT run`,
        );
        return;
      }
      const rs = runSuite(REAL_BASE);
      expect(statusOf(rs, CROSS_CHECK)).toBe("passed");
      expect(statusOf(rs, PINNED)).toBe("passed");
      expect(rs.filter((r) => r.status === "skipped")).toEqual([]);
    },
  );
});
