// A HEAD-less copy of the tool under test, for the rows that need "no HEAD can be established" (README: toolVersion is
// null then). The copy has no `.git` anywhere at or above it, and GIT_CEILING_DIRECTORIES stops git's upward search,
// so the rows behave the same in a `git archive` scratch tree, a developer checkout and CI's actions/checkout.
// The tool's files are copied byte for byte, never read.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { tmp } from "./tmp";

const ROOT = path.resolve(__dirname, "../../../../..");
let copy: string | null = null;

/** Environment additions that stop git from searching above the copy. */
export function ceiling(dir: string): Record<string, string> {
  return { GIT_CEILING_DIRECTORIES: path.dirname(dir) };
}

/** An environment in which git can find no repository for `dir`: no GIT_DIR or GIT_WORK_TREE, and a ceiling. */
export function headlessEnv(base: Record<string, string | undefined>, dir: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && k !== "GIT_DIR" && k !== "GIT_WORK_TREE" && k !== "GIT_COMMON_DIR") env[k] = v;
  return { ...env, ...ceiling(dir) };
}

/** Run fn with process.env made HEAD-less for `dir` (the in-process tool spawns git with the process environment or
 * its own; either way no repository is reachable from the copy). */
export function withHeadlessProcessEnv<T>(dir: string, fn: () => T): T {
  const saved = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE, GIT_COMMON_DIR: process.env.GIT_COMMON_DIR, GIT_CEILING_DIRECTORIES: process.env.GIT_CEILING_DIRECTORIES };
  delete process.env.GIT_DIR;
  delete process.env.GIT_WORK_TREE;
  delete process.env.GIT_COMMON_DIR;
  process.env.GIT_CEILING_DIRECTORIES = path.dirname(dir);
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

export function headlessRoot(): string {
  if (copy !== null && fs.existsSync(copy)) return copy;
  const dir = tmp("headless-");
  for (const p of ["scripts", ".github", "package.json"]) fs.cpSync(path.join(ROOT, p), path.join(dir, p), { recursive: true });
  const nm = path.join(ROOT, "node_modules");
  if (fs.existsSync(nm)) fs.symlinkSync(fs.realpathSync(nm), path.join(dir, "node_modules"));
  // Precondition, checked rather than assumed: no repository is reachable from the copy.
  for (let d = dir; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, ".git"))) throw new Error(`headless copy is inside a git repository (${d}); move TMPDIR outside it`);
    if (path.dirname(d) === d) break;
  }
  const probe = spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, env: headlessEnv(process.env, dir) as unknown as NodeJS.ProcessEnv, encoding: "utf8" });
  if (probe.status === 0) throw new Error(`git still resolves a HEAD from the headless copy: ${probe.stdout.trim()}`);
  copy = dir;
  return dir;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the tool under test is an untyped .mjs module
export async function headlessRunShepherdCli(): Promise<any> {
  const dir = headlessRoot();
  return (await import(path.join(dir, "scripts/eng/v2/cli-shepherd.mjs"))).runShepherdCli;
}
