import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

// PR #160. Black-box tests for scripts/export-pilot-control-sheet.mjs.
// The script is the single canonical writer of pilot-control/generated/
// and the Hone_Pilot_Control_Sheet.xlsx artifact. Pinning its outputs
// textually + structurally so a future refactor that breaks
// determinism or drops a tracker is caught by `npm test`.

const REPO_ROOT = path.resolve(__dirname, "../..");
const SCRIPT_PATH = path.join(
  REPO_ROOT,
  "scripts/export-pilot-control-sheet.mjs",
);
const GENERATED_DIR = path.join(REPO_ROOT, "pilot-control/generated");

const EXPECTED_CSVS = [
  "dashboard.csv",
  "chloe-testing-queue.csv",
  "product-feedback.csv",
  "launch-blockers.csv",
  "pr-build-log.csv",
  "future-ideas.csv",
];

describe("pilot-control export script: --check mode against the repo's current state", () => {
  it("exits 0 when the YAML matches the checked-in CSVs", () => {
    const result = spawnSync("node", [SCRIPT_PATH, "--check"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    if (result.status !== 0) {
      // Surface the script output so a CI failure here is debuggable.
      throw new Error(
        `pilot:check failed unexpectedly:\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
    }
    expect(result.stdout).toMatch(/CHECK ok/);
  });

  it("every expected CSV exists on disk", () => {
    for (const name of EXPECTED_CSVS) {
      const full = path.join(GENERATED_DIR, name);
      expect(existsSync(full), `expected ${name} to exist`).toBe(true);
    }
  });

  it("every generated CSV starts with a deterministic header row", () => {
    // Pin the first line of each CSV so a column reorder is caught
    // immediately. The column order is the contract the operator's
    // Excel import relies on.
    const expectedHeaders: Record<string, string> = {
      "dashboard.csv": "tracker,metric,value",
      "chloe-testing-queue.csv":
        "area,pr,priority,owner,status,what_changed,why_chloe_should_care,test_steps,expected_result,chloe_notes,last_tested",
      "product-feedback.csv":
        "feedback,source,area,pain_level,suggested_fix,decision,status",
      "launch-blockers.csv":
        "blocker,why_it_matters,owner,needed_before_launch,status,next_action",
      "pr-build-log.csv":
        "pr,name,what_changed,risk_level,merged,needs_chloe_test,smoke_result,notes",
      "future-ideas.csv": "idea,area,why,complexity",
    };
    for (const [name, expectedHeader] of Object.entries(expectedHeaders)) {
      const full = path.join(GENERATED_DIR, name);
      const text = readFileSync(full, "utf8");
      const firstLine = text.split("\n", 1)[0];
      expect(firstLine, `${name} header mismatch`).toBe(expectedHeader);
    }
  });

  it("every generated CSV uses LF line endings", () => {
    for (const name of EXPECTED_CSVS) {
      const text = readFileSync(path.join(GENERATED_DIR, name), "utf8");
      expect(text.includes("\r"), `${name} contains CR (expected LF only)`).toBe(
        false,
      );
    }
  });

  it("every generated CSV ends with exactly one trailing newline", () => {
    for (const name of EXPECTED_CSVS) {
      const text = readFileSync(path.join(GENERATED_DIR, name), "utf8");
      expect(text.endsWith("\n"), `${name} is missing trailing LF`).toBe(true);
      expect(
        text.endsWith("\n\n"),
        `${name} has a doubled trailing LF`,
      ).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Failure-mode tests: copy the real pilot-control/ tree into a temp
// directory, mutate one file, point the script at the temp tree, and
// assert the expected failure mode.
//
// We use an env override (PILOT_CONTROL_DIR_OVERRIDE) only inside the
// test fixture; production code paths do not consult it. To avoid
// changing the script's contract, we instead run the script from a
// temp REPO ROOT (with only the relevant files copied) so the temp
// run is fully self-contained.
// ---------------------------------------------------------------------------

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), "pilot-control-failure-"));
  // Copy the minimum surface: the script itself + node_modules + a
  // pilot-control directory + a minimal package.json shim.
  mkdirSync(path.join(tmpRoot, "scripts"), { recursive: true });
  mkdirSync(path.join(tmpRoot, "pilot-control"), { recursive: true });
  cpSync(SCRIPT_PATH, path.join(tmpRoot, "scripts/export-pilot-control-sheet.mjs"));
  for (const name of [
    "chloe-testing-queue.yml",
    "product-feedback.yml",
    "launch-blockers.yml",
    "pr-build-log.yml",
    "future-ideas.yml",
  ]) {
    cpSync(
      path.join(REPO_ROOT, "pilot-control", name),
      path.join(tmpRoot, "pilot-control", name),
    );
  }
  // Symlink node_modules from the repo root so the script can resolve
  // js-yaml and jszip without a fresh install.
  const { symlinkSync } = require("node:fs") as typeof import("node:fs");
  symlinkSync(
    path.join(REPO_ROOT, "node_modules"),
    path.join(tmpRoot, "node_modules"),
    "dir",
  );
});

afterEach(() => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

function runInTmp(args: string[]) {
  return spawnSync(
    "node",
    [path.join(tmpRoot, "scripts/export-pilot-control-sheet.mjs"), ...args],
    { cwd: tmpRoot, encoding: "utf8" },
  );
}

describe("pilot-control export script: validation failure modes", () => {
  it("fails when a YAML file has a missing required field", () => {
    // Strip the `area` from the first entry of chloe-testing-queue.
    const filePath = path.join(tmpRoot, "pilot-control/chloe-testing-queue.yml");
    const original = readFileSync(filePath, "utf8");
    // The first entry's first line is `- area: Client portal layout`.
    // Replace `area: Client portal layout` with `area: ""`.
    const mutated = original.replace(
      /- area: Client portal layout/,
      '- area: ""',
    );
    expect(mutated).not.toBe(original);
    writeFileSync(filePath, mutated);
    const result = runInTmp([]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(
      /chloe-testing-queue\.yml entry #1 is missing required field: area/,
    );
  });

  it("fails when a YAML file is syntactically invalid", () => {
    const filePath = path.join(tmpRoot, "pilot-control/future-ideas.yml");
    writeFileSync(filePath, "- this is: : not: valid\n");
    const result = runInTmp([]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Failed to parse future-ideas\.yml/);
  });

  it("fails when a tracker file is removed entirely", () => {
    rmSync(path.join(tmpRoot, "pilot-control/launch-blockers.yml"));
    const result = runInTmp([]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(
      /Tracker file is missing: pilot-control\/launch-blockers\.yml/,
    );
  });

  it("--check mode fails when the CSVs are stale relative to the YAML", () => {
    // Generate fresh CSVs in the tmp tree (so they match), then mutate
    // a YAML entry without re-exporting, then run --check.
    // First populate the generated directory.
    let result = runInTmp([]);
    expect(result.status).toBe(0);
    expect(
      existsSync(path.join(tmpRoot, "pilot-control/generated/chloe-testing-queue.csv")),
    ).toBe(true);
    // Mutate one YAML entry to introduce a drift the CSV does not yet
    // reflect.
    const filePath = path.join(tmpRoot, "pilot-control/chloe-testing-queue.yml");
    const text = readFileSync(filePath, "utf8");
    const drifted = text.replace(/priority: P0/, "priority: P1");
    expect(drifted).not.toBe(text);
    writeFileSync(filePath, drifted);
    result = runInTmp(["--check"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/generated CSVs are out of sync with YAML/);
    expect(result.stderr).toMatch(/stale:.*chloe-testing-queue\.csv/);
  });
});

// ---------------------------------------------------------------------------
// Determinism: running export twice from the same YAML must produce
// byte-identical CSVs. The XLSX, since it is a zip with a Date entry
// per member, uses a fixed pinned date to keep it stable too.
// ---------------------------------------------------------------------------

describe("pilot-control export script: deterministic output", () => {
  it("two consecutive export runs produce byte-identical CSVs", () => {
    const first = runInTmp([]);
    expect(first.status).toBe(0);
    const generated = path.join(tmpRoot, "pilot-control/generated");
    const snapshotA = Object.fromEntries(
      EXPECTED_CSVS.map((n) => [n, readFileSync(path.join(generated, n), "utf8")]),
    );
    const second = runInTmp([]);
    expect(second.status).toBe(0);
    const snapshotB = Object.fromEntries(
      EXPECTED_CSVS.map((n) => [n, readFileSync(path.join(generated, n), "utf8")]),
    );
    expect(snapshotB).toEqual(snapshotA);
  });
});

// ---------------------------------------------------------------------------
// Package wiring: confirm the scripts the operator runs are pinned in
// package.json so a future refactor cannot silently drop them.
// ---------------------------------------------------------------------------

describe("package.json wires the pilot scripts and CI composite", () => {
  it("declares pilot:export and pilot:check scripts", () => {
    const pkg = JSON.parse(
      readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"),
    );
    expect(pkg.scripts["pilot:export"]).toBe(
      "node scripts/export-pilot-control-sheet.mjs",
    );
    expect(pkg.scripts["pilot:check"]).toBe(
      "node scripts/export-pilot-control-sheet.mjs --check",
    );
  });

  it("the ci composite ends with pilot:check", () => {
    const pkg = JSON.parse(
      readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"),
    );
    expect(pkg.scripts.ci).toMatch(/npm run pilot:check\s*$/);
  });

  it("GitHub Actions ci.yml runs pilot:check after the Stripe gate", () => {
    const wf = readFileSync(
      path.join(REPO_ROOT, ".github/workflows/ci.yml"),
      "utf8",
    );
    expect(wf).toMatch(/Pilot control sheet freshness \(PR #160\)/);
    expect(wf).toMatch(/run:\s*npm run pilot:check/);
    // Ordering: Stripe gate appears BEFORE the pilot freshness step.
    const stripeIdx = wf.indexOf("npm run check:stripe-gates");
    const pilotIdx = wf.indexOf("npm run pilot:check");
    expect(stripeIdx).toBeGreaterThan(-1);
    expect(pilotIdx).toBeGreaterThan(stripeIdx);
  });
});
