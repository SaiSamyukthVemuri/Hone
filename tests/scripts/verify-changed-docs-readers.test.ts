import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// verify:changed must run what CI runs for a docs-only diff (CLAUDE.md section 3: one path map, no local drift).
// CI's canonical-record job runs the unit tests that read the changed documents (docs_reader_tests); locally a
// docs-only diff ran only tests/docs and migration-state, so a doc edit that broke a reader passed locally and
// failed in CI.

const SCRIPT = path.resolve(__dirname, "../../scripts/verify-changed.mjs");
// @ts-expect-error - .mjs utility ships without type declarations
const { classify, dependenciesFor } = await import("../../scripts/classify-changes.mjs");
// A document taken FROM the live scan, never named here: a literal path in this file would make it look like a
// reader of that document.
const DOC = Object.keys((dependenciesFor() as { docReaders: Record<string, string[]> }).docReaders).sort()[0] as string;
const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// Run the actual CLI, replacing only its external executables (npx, node) with recorders.
function run(file: string, plan = false) {
  const dir = mkdtempSync(path.join(tmpdir(), "hone-verify-docs-"));
  scratch.push(dir);
  const trace = path.join(dir, "trace");
  for (const name of ["npx", "node"]) {
    writeFileSync(path.join(dir, name), `#!/bin/sh\nprintf '%s %s\\n' '${name}' "$*" >> "$VERIFY_TRACE"\nexit 0\n`);
    chmodSync(path.join(dir, name), 0o700);
  }
  const result = spawnSync(process.execPath, [SCRIPT, "--files", file, ...(plan ? ["--plan"] : [])], {
    cwd: dir,
    encoding: "utf8",
    timeout: 30_000,
    env: { PATH: dir, NODE_ENV: "test", VERIFY_TRACE: trace },
  });
  let calls: string[] = [];
  try {
    calls = readFileSync(trace, "utf8").trim().split("\n");
  } catch {
    /* --plan launches nothing */
  }
  return { ...result, calls };
}

describe("verify:changed runs the unit tests that read a changed document, as CI does", () => {
  it("a docs-only diff runs exactly CI's docs_reader_tests", () => {
    expect(DOC, "the scan names no document reader at all").toBeDefined();
    const ci = classify([DOC]) as { docs_only: boolean; docs_consistency: boolean; docs_reader_tests: string[] };
    expect(ci.docs_only && ci.docs_consistency, `${DOC} is a docs-only diff with readers`).toBe(true);
    expect(ci.docs_reader_tests.length).toBeGreaterThan(0);

    const result = run(DOC);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const readers = result.calls.filter((c) => c.startsWith("npx vitest run ") && c !== "npx vitest run tests/docs/");
    expect(readers).toHaveLength(1);
    expect(readers[0].slice("npx vitest run ".length).split(" ")).toEqual(ci.docs_reader_tests);
    // The existing docs-only checks still run.
    expect(result.calls).toContain("npx vitest run tests/docs/");
    expect(result.calls).toContain("node scripts/migration-state.mjs");
  });

  it("--plan names the reader run and executes nothing", () => {
    const result = run(DOC, true);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("unit tests that read the changed docs");
    expect(result.calls).toEqual([]);
  });
});
