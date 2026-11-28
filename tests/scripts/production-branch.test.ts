import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error - .mjs utilities ship without type declarations
import { NEW_PRODUCTION_BRANCH, OLD_PRODUCTION_BRANCH, resolveProductionBranch } from "../../scripts/lib/production-branch.mjs";

// The production branch rename (claude/build-hone-saas-hOex7 -> main) must be survivable in BOTH orders: this tooling merges first, so it has to behave before and after.
const exists = (names: string[]) => (n: string) => names.includes(n);
const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

describe("resolveProductionBranch", () => {
  it("before the rename (only the old branch exists) it names the old branch", () => {
    expect(resolveProductionBranch({ remoteBranchExists: exists([OLD_PRODUCTION_BRANCH]) })).toBe(OLD_PRODUCTION_BRANCH);
  });
  it("after the rename (main exists) it names main, even while a stale old ref is still around before a prune", () => {
    expect(resolveProductionBranch({ remoteBranchExists: exists([NEW_PRODUCTION_BRANCH]) })).toBe("main");
    expect(resolveProductionBranch({ remoteBranchExists: exists([OLD_PRODUCTION_BRANCH, NEW_PRODUCTION_BRANCH]) })).toBe("main");
  });
  it("an explicit override wins in either state, and a blank one is ignored", () => {
    expect(resolveProductionBranch({ override: "release/x", remoteBranchExists: exists(["main"]) })).toBe("release/x");
    expect(resolveProductionBranch({ override: "  ", remoteBranchExists: exists(["main"]) })).toBe("main");
    expect(resolveProductionBranch({ override: null, remoteBranchExists: exists([]) })).toBe(OLD_PRODUCTION_BRANCH);
  });
});

describe("the CI push trigger lists BOTH names (Actions filters do not follow a rename)", () => {
  it("push.branches has the old name first (draft-gate pin) and main second; pull_request has no branch filter", () => {
    const ci = read(".github/workflows/ci.yml");
    expect(ci).toMatch(/^ {2}push:\n {4}branches:\n {6}- claude\/build-hone-saas-hOex7\n {6}- main\n/m);
    const pr = ci.slice(ci.indexOf("  pull_request:"), ci.indexOf("  push:"));
    expect(pr).not.toMatch(/branches/);
  });
  it("the planner and the hosted publisher resolve the branch through the shared helper instead of a literal", () => {
    expect(read("scripts/ci-plan.mjs")).not.toMatch(/\?\? "claude\/build-hone-saas-hOex7"/);
    expect(read("scripts/ci-plan.mjs")).toMatch(/resolveProductionBranch/);
    expect(read("scripts/publish-machine-contracts-hosted.mjs")).not.toMatch(/PRODUCTION_BRANCH = "claude/);
    expect(read("scripts/publish-machine-contracts-hosted.mjs")).toMatch(/resolveProductionBranch/);
  });
});

describe("the hosted publisher's dry run (and no-argument usage) makes NO network call", () => {
  it("a --dry-run and a bare invocation never run `git ls-remote` or `git fetch` (branch resolution is deferred past the dry-run return)", () => {
    const dir = mkdtempSync(join(tmpdir(), "prodbranch-"));
    try {
      const real = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
      const log = join(dir, "git.log");
      const shim = join(dir, "git");
      writeFileSync(shim, `#!/bin/sh\necho "$@" >> '${log}'\nexec '${real}' "$@"\n`);
      chmodSync(shim, 0o755);
      const env = { PATH: `${dir}:${process.env.PATH}`, HOME: process.env.HOME ?? "" } as unknown as NodeJS.ProcessEnv;
      execFileSync("node", ["scripts/publish-machine-contracts-hosted.mjs", "--dry-run"], { cwd: ROOT, env, encoding: "utf8" });
      try { execFileSync("node", ["scripts/publish-machine-contracts-hosted.mjs", "--bogus"], { cwd: ROOT, env, encoding: "utf8", stdio: "pipe" }); } catch { /* usage exit 2 */ }
      const calls = existsSync(log) ? readFileSync(log, "utf8") : "";
      expect(calls).not.toMatch(/\b(ls-remote|fetch|pull|clone)\b/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 120_000);
});
