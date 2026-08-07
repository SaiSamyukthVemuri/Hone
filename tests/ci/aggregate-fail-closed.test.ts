import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

// THE FAIL-CLOSED CONTRACT of the stable required browser check.
//
// WHY THIS EXISTS
// ---------------
// `browser e2e (local stack)` is the job this repository designates as the
// stable required check (ci.yml: "Branch protection points HERE, never at a
// dynamic shard name"). Every "is browser coverage required?" answer it computes
// is derived from the OUTPUTS of `changed-path detection`.
//
// When that gate does not succeed, its outputs are the empty string. The
// aggregator therefore computed REQUIRED="false", saw the shard job report
// "skipped", and concluded "no browser coverage required for this diff —
// satisfied", exiting 0. The required check went GREEN having executed ZERO
// tests.
//
// That fail-open was observed on a real PR head during the 2026-08-06 GitHub
// Actions incident (https://stspg.io/rcz3fcm83sff): run 31120309970 on
// fd6538209dfc202de2818af313f8f2f01ed9cbeb reports
// `browser e2e (local stack) = success` with the gate cancelled after 15
// minutes without ever being assigned a runner, and every other lane skipped.
// See docs/audits/GITHUB_ACTIONS_RUNNER_ASSIGNMENT_2026-08.md.
//
// WHY IT IS PINNED HERE AND NOT IN ci-config.test.ts
// --------------------------------------------------
// The guard is six lines of shell inside a `run:` block. Deleting it leaves the
// workflow structurally identical — every existing source-grep assertion in
// tests/ci/ci-config.test.ts still passes, because none of them reads
// `needs.changes.result`. A source-shape pin cannot protect a behaviour; only
// executing the behaviour can. So this file EXECUTES the real script.
//
// THE SCRIPT UNDER TEST IS EXTRACTED FROM .github/workflows/ci.yml, never
// reimplemented. A hand-written copy of the decision logic would drift from the
// workflow silently, which is the very class of bug this file guards against.
// extractAggregateScript() below fails loudly if it cannot find the exact block.

const ROOT = path.resolve(__dirname, "../..");
const CI_PATH = path.join(ROOT, ".github/workflows/ci.yml");
const CI = readFileSync(CI_PATH, "utf8");

// Mechanically lift the `run:` body of the FIRST step of the `browser-e2e` job.
// Deliberately strict: every failure mode throws rather than returning a partial
// script that would make the assertions below vacuous.
function extractAggregateScript(): string {
  const lines = CI.split("\n");
  const jobIdx = lines.findIndex((l) => l === "  browser-e2e:");
  if (jobIdx < 0) throw new Error("browser-e2e job not found in ci.yml");

  // Stop at the next top-level job key so we can never wander into another job.
  let jobEnd = lines.length;
  for (let i = jobIdx + 1; i < lines.length; i += 1) {
    if (/^ {2}[A-Za-z][\w-]*:/.test(lines[i])) {
      jobEnd = i;
      break;
    }
  }

  const runIdx = lines.findIndex(
    (l, i) => i > jobIdx && i < jobEnd && l === "        run: |",
  );
  if (runIdx < 0) throw new Error("browser-e2e `run: |` block not found");

  const body: string[] = [];
  for (let i = runIdx + 1; i < jobEnd; i += 1) {
    const line = lines[i];
    if (line.trim() === "") {
      body.push("");
      continue;
    }
    const indent = line.length - line.trimStart().length;
    if (indent < 10) break;
    body.push(line.slice(10));
  }
  const script = body.join("\n");

  // SELF-VERIFICATION. If the extractor ever grabs the wrong block — or an empty
  // one — these throw instead of letting the decision table pass against
  // nothing. This is what stops the whole file from going vacuous.
  if (script.length < 500) {
    throw new Error(`extracted aggregate script implausibly short (${script.length} chars)`);
  }
  for (const marker of [
    "REQUIRED=",
    "SHARD_RESULT",
    "browser shard(s) passed",
  ]) {
    if (!script.includes(marker)) {
      throw new Error(`extracted script missing expected marker: ${marker}`);
    }
  }
  return script;
}

const SCRIPT = extractAggregateScript();

type GateEnv = {
  CHANGES_RESULT: string;
  SHARD_RESULT: string;
  BROWSER_RUN: string;
  FULL_MATRIX: string;
  EXTENDED: string;
  SHARDS: string;
};

// GitHub always defines every key declared in a step's `env:`; an expression
// that resolves to nothing becomes the EMPTY STRING, never an unset variable.
// The defaults below mirror that, which matters because the script runs under
// `set -u`.
function runAggregate(over: Partial<GateEnv>): { code: number; out: string } {
  const env: GateEnv = {
    CHANGES_RESULT: "",
    SHARD_RESULT: "",
    BROWSER_RUN: "",
    FULL_MATRIX: "",
    EXTENDED: "",
    SHARDS: "",
    ...over,
  };
  try {
    const out = execFileSync("bash", ["-c", SCRIPT], {
      env: { ...process.env, ...env },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return {
      code: typeof err.status === "number" ? err.status : 1,
      out: `${err.stdout ?? ""}${err.stderr ?? ""}`,
    };
  }
}

// A healthy extended run, as observed on run 31123533948 attempt 2.
const HEALTHY_EXTENDED: GateEnv = {
  CHANGES_RESULT: "success",
  SHARD_RESULT: "success",
  BROWSER_RUN: "true",
  FULL_MATRIX: "true",
  EXTENDED: "true",
  SHARDS: "[1,2,3,4]",
};

describe("the extracted script is the real one", () => {
  it("comes from the committed workflow and carries the fail-closed guard", () => {
    expect(SCRIPT).toContain("CHANGES_RESULT");
    expect(SCRIPT).toMatch(/if \[ "\$\{CHANGES_RESULT:-\}" != "success" \]/);
    // The guard must precede the first output-derived decision, or a
    // non-success gate would still reach the REQUIRED computation.
    expect(SCRIPT.indexOf("CHANGES_RESULT:-")).toBeLessThan(
      SCRIPT.indexOf('REQUIRED="false"'),
    );
  });

  it("the workflow declares the gate result as step env", () => {
    // Without this the script would read an unset variable and, under `set -u`,
    // fail for the wrong reason — passing this file while breaking real CI.
    expect(CI).toMatch(/CHANGES_RESULT: \$\{\{ needs\.changes\.result \}\}/);
  });
});

describe("FAIL CLOSED — a gate that did not succeed can never yield a green required check", () => {
  // THE regression. Each of these passed (exit 0) before the guard existed.
  for (const gate of ["cancelled", "failure", "skipped"]) {
    it(`gate result "${gate}" fails the required check`, () => {
      const r = runAggregate({ CHANGES_RESULT: gate, SHARD_RESULT: "skipped" });
      expect(r.code).not.toBe(0);
      // Fails for the RIGHT reason — not a shell error, not malformed JSON.
      expect(r.out).toContain("changed-path detection did not succeed");
      expect(r.out).toContain(gate);
      expect(r.out).not.toContain("satisfied");
    });
  }

  it("an EMPTY gate result (job never materialised) fails the required check", () => {
    const r = runAggregate({ CHANGES_RESULT: "", SHARD_RESULT: "skipped" });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("changed-path detection did not succeed");
    expect(r.out).not.toContain("satisfied");
  });

  it("a dead gate fails EVEN WHEN the shard job also reports success", () => {
    // Defence in depth: the verdict must not depend on the shard result when we
    // cannot prove what the plan was.
    const r = runAggregate({
      ...HEALTHY_EXTENDED,
      CHANGES_RESULT: "cancelled",
    });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("changed-path detection did not succeed");
  });

  it("the exact PR #518 shape — dead gate, empty outputs, skipped shards — fails", () => {
    // Reproduces run 31120309970 on fd6538209dfc..., which reported the required
    // check GREEN with zero tests executed.
    const r = runAggregate({
      CHANGES_RESULT: "cancelled",
      SHARD_RESULT: "skipped",
      BROWSER_RUN: "",
      FULL_MATRIX: "",
      EXTENDED: "",
      SHARDS: "",
    });
    expect(r.code).toBe(1);
  });
});

describe("gate SUCCESS behaviour is unchanged", () => {
  it("no coverage required + shards skipped → satisfied", () => {
    const r = runAggregate({
      CHANGES_RESULT: "success",
      SHARD_RESULT: "skipped",
      BROWSER_RUN: "false",
      FULL_MATRIX: "false",
      EXTENDED: "false",
      SHARDS: "[1]",
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain("no browser coverage required for this diff");
  });

  it("coverage required + shards succeeded → passes", () => {
    const r = runAggregate({
      CHANGES_RESULT: "success",
      SHARD_RESULT: "success",
      BROWSER_RUN: "true",
      FULL_MATRIX: "false",
      EXTENDED: "false",
      SHARDS: "[1]",
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain("browser shard(s) passed");
  });

  for (const shard of ["skipped", "cancelled", "failure"]) {
    it(`coverage required + shards "${shard}" → fails`, () => {
      const r = runAggregate({
        CHANGES_RESULT: "success",
        SHARD_RESULT: shard,
        BROWSER_RUN: "true",
        FULL_MATRIX: "false",
        EXTENDED: "false",
        SHARDS: "[1]",
      });
      expect(r.code).not.toBe(0);
      // NOT via the new guard — the pre-existing shard logic must still own this.
      expect(r.out).not.toContain("changed-path detection did not succeed");
    });
  }

  it("coverage required + shard result MISSING → fails", () => {
    const r = runAggregate({
      CHANGES_RESULT: "success",
      SHARD_RESULT: "",
      BROWSER_RUN: "true",
      FULL_MATRIX: "false",
      EXTENDED: "false",
      SHARDS: "[1]",
    });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("MISSING");
  });

  it("no coverage required + shard result MISSING → satisfied", () => {
    const r = runAggregate({
      CHANGES_RESULT: "success",
      SHARD_RESULT: "",
      BROWSER_RUN: "false",
      FULL_MATRIX: "false",
      EXTENDED: "false",
      SHARDS: "[1]",
    });
    expect(r.code).toBe(0);
  });

  it("extended coverage must declare exactly four shards", () => {
    expect(runAggregate(HEALTHY_EXTENDED).code).toBe(0);
    const short = runAggregate({ ...HEALTHY_EXTENDED, SHARDS: "[1]" });
    expect(short.code).not.toBe(0);
    expect(short.out).toContain("exactly 4 shards");
  });

  it("reproduces the healthy attempt-2 verdict of run 31123533948", () => {
    // gate success · required true · extended true · 4 shards → real-plan pass.
    const r = runAggregate(HEALTHY_EXTENDED);
    expect(r.code).toBe(0);
    expect(r.out).toContain("gate result      : success");
    expect(r.out).toContain("browser required : true");
    expect(r.out).toContain("expected shards  : 4");
    expect(r.out).toContain("all 4 browser shard(s) passed");
  });
});
