import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import path from "node:path";

const yaml = createRequire(path.resolve("package.json"))("js-yaml") as {
  load(source: string): { jobs?: Record<string, {
    "runs-on"?: unknown;
    steps?: { name?: string; run?: string; shell?: string; if?: unknown; env?: Record<string, unknown> }[];
  }> };
};
const labels = ["self-hosted", "linux", "x64", "hone-ci-ubuntu-24.04"];
type Sources = [string, string][];

// Parse what Actions executes. Quoted keys or block-style YAML must not evade
// the no-hosted-compute policy. Enumerate, so future workflows join this guard.
function faults(sources: Sources): string[] {
  const out: string[] = [];
  if (!sources.length) out.push("no workflows");
  for (const [file, source] of sources) {
    const jobs = yaml.load(source)?.jobs;
    if (!jobs || !Object.keys(jobs).length) { out.push(file + ": no jobs"); continue; }
    for (const [name, job] of Object.entries(jobs)) {
      const prefix = file + "/" + name;
      if (JSON.stringify(job["runs-on"]) !== JSON.stringify(labels)) out.push(prefix + ": runner");
      const first = job.steps?.[0];
      if (first?.name !== "Require disposable VPS runner" || first.shell !== "bash" || first.if !== undefined) {
        out.push(prefix + ": unconditional first guard");
        continue;
      }
      if (first.env?.HONE_REPOSITORY_PRIVATE !== "${{ github.event.repository.private }}") {
        out.push(prefix + ": private repository check");
      }
      for (const check of [
        "set -euo pipefail",
        'test "${HONE_REPOSITORY_PRIVATE:-}" = true',
        'test "${RUNNER_ENVIRONMENT:-}" = self-hosted',
        'test "$(systemd-detect-virt --container)" = lxc',
        'test "$ID:$VERSION_ID" = ubuntu:24.04',
        'test "$(stat -c \'%u:%a\' /etc/hone-ci-ephemeral)" = 0:444',
        "grep -qx 'hone-ci-v1' /etc/hone-ci-ephemeral",
      ]) {
        if (!first.run?.includes(check)) out.push(prefix + ": missing " + check);
      }
    }
  }
  return out;
}

const sources: Sources = readdirSync(".github/workflows")
  .filter(name => /\.ya?ml$/.test(name)).sort()
  .map(name => [name, readFileSync(".github/workflows/" + name, "utf8")]);

describe("VPS routing covers every workflow without a hosted fallback", () => {
  it("keeps all current jobs, including detection, aggregation, nightly and restore, on the pinned VPS", () => {
    expect(sources.length).toBeGreaterThanOrEqual(3);
    expect(faults(sources)).toEqual([]);
  });

  it("rejects hosted compute introduced through a new workflow and quoted YAML key", () => {
    expect(faults([...sources, ["future.yaml", 'jobs:\n  bypass:\n    "runs-on": ubuntu-24.04\n']]))
      .toContain("future.yaml/bypass: runner");
  });

  it("rejects generic self-hosted labels that could schedule on the developer host", () => {
    const mutant: Sources = sources.map(([name, source]) => [
      name, source.replaceAll("[self-hosted, linux, x64, hone-ci-ubuntu-24.04]", "[self-hosted]"),
    ]);
    expect(faults(mutant).filter(f => f.endsWith(": runner")).length).toBeGreaterThan(0);
  });

  it("rejects a bypassed guard before checkout or package credentials", () => {
    const mutant: Sources = sources.map(([name, source]) => [
      name, source.replaceAll("name: Require disposable VPS runner", "name: Skip boundary"),
    ]);
    expect(faults(mutant).filter(f => f.endsWith(": unconditional first guard")).length).toBeGreaterThan(0);
  });

  it("rejects dropping the fresh-container marker or the Ubuntu pin", () => {
    for (const check of ["grep -qx 'hone-ci-v1' /etc/hone-ci-ephemeral", 'test "$ID:$VERSION_ID" = ubuntu:24.04']) {
      const mutant: Sources = sources.map(([name, source]) => [name, source.replaceAll(check, "true")]);
      expect(faults(mutant).length).toBeGreaterThan(0);
    }
  });

  it("rejects removing the private-repository check", () => {
    const mutant: Sources = sources.map(([name, source]) => [
      name, source.replaceAll('test "${HONE_REPOSITORY_PRIVATE:-}" = true', "true"),
    ]);
    expect(faults(mutant).length).toBeGreaterThan(0);
  });

  it.each([
    ["public repo", "false", "self-hosted"],
    ["unknown visibility", "", "self-hosted"],
    ["GitHub hosted compute", "true", "github-hosted"],
  ])("the real first-step shell refuses %s before any later work", (_, visibility, runner) => {
    for (const [, source] of sources) {
      for (const job of Object.values(yaml.load(source).jobs ?? {})) {
        const script = job.steps?.[0].run ?? "";
        const result = spawnSync("bash", ["-c", script + "\nprintf 'UNREACHABLE\\n'"], {
          encoding: "utf8",
          env: { ...process.env, HONE_REPOSITORY_PRIVATE: visibility, RUNNER_ENVIRONMENT: runner },
          timeout: 3000,
        });
        expect(result.status).toBe(1);
        expect(result.stdout).not.toContain("UNREACHABLE");
      }
    }
  });
});
