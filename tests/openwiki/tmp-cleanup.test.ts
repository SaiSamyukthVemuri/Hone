import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { cleanupTmp, createFixture, isolateGitConfig, makeTmp, restoreGitConfig, write } from "./helpers";

// #893's CI run 39879248847: `tests/openwiki/nightly.test.ts > fail-closed
// preflight > the runner's own code inside the subject clone` failed in its
// afterEach with
//
//   ENOTEMPTY: directory not empty, rmdir '/tmp/hone-wiki-fixture-…/work/.git/objects'
//
// Every git call the fixtures and the runner make is synchronous, so no child
// the tests spawn is still alive at teardown. What is: the automatic
// `git maintenance run --auto` that commit, fetch and push launch, DETACHED on
// git 2.47+ (CI ran 2.55.0). It holds `objects/maintenance.lock` while the
// cleanup walks the tree. This host's git (2.43) does not detach, which is why
// the test passes locally and on most CI runs.

beforeAll(isolateGitConfig);
afterAll(restoreGitConfig);
afterEach(cleanupTmp);

describe("fixture git leaves no background process behind", () => {
  it("a fixture commit launches no automatic maintenance or gc", () => {
    // THE CAUSE. With the previous empty global config this trace contains
    // `run_command: git maintenance run --auto --quiet` for every commit.
    const fx = createFixture();
    write(fx.work, "lib/traced.ts", "export const traced = 1;\n");
    spawnSync("git", ["add", "-A"], { cwd: fx.work });
    const traced = spawnSync("git", ["commit", "--quiet", "-m", "traced"], {
      cwd: fx.work,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_TRACE: "1",
        GIT_AUTHOR_NAME: "Fixture Author",
        GIT_AUTHOR_EMAIL: "fixture@example.com",
        GIT_COMMITTER_NAME: "Fixture Author",
        GIT_COMMITTER_EMAIL: "fixture@example.com",
      },
    });
    expect(traced.status, traced.stderr).toBe(0);
    // Anti-vacuity: the trace really was captured.
    expect(traced.stderr).toMatch(/trace: built-in: git commit/u);
    expect(traced.stderr).not.toMatch(/maintenance run|gc --auto/u);
  });
});

// A stand-in for the detached maintenance process: it takes and releases a
// lock in `.git/objects` for 100 ms, as an idle `maintenance run --auto` does,
// and never re-creates a directory once it is gone. It signals before it starts
// so the race is real rather than a matter of process start-up luck.
const LOCK_HOLDER = `
const fs = require("fs"), p = require("path");
const lock = p.join(process.argv[1], "maintenance.lock");
const end = Date.now() + Number(process.argv[2]);
const spin = (ms) => { const t = Date.now() + ms; while (Date.now() < t); };
process.stdout.write("ready\\n");
while (Date.now() < end) {
  try { fs.writeFileSync(lock, "x"); } catch {}
  spin(5);
  try { fs.unlinkSync(lock); } catch {}
  spin(1);
}
`;

describe("cleanupTmp outlasts a short-lived lock holder", () => {
  it("50 removals under a lingering .git/objects writer: none fails, none is left behind", async () => {
    // THE BACKSTOP, measured. With the previous `rmSync(dir, { recursive, force })`
    // 14 of 50 identical trials failed with ENOTEMPTY; with the retries none did.
    const failures: string[] = [];
    for (let i = 0; i < 50; i++) {
      const root = makeTmp("cleanup-race");
      const objects = path.join(root, "work", ".git", "objects");
      for (let d = 0; d < 64; d++) {
        const sub = path.join(objects, d.toString(16).padStart(2, "0"));
        mkdirSync(sub, { recursive: true });
        writeFileSync(path.join(sub, "object"), "x");
      }
      const holder = spawn(process.execPath, ["-e", LOCK_HOLDER, objects, "100"], { stdio: ["ignore", "pipe", "ignore"] });
      const exited = new Promise((resolve) => holder.once("exit", resolve));
      await new Promise((resolve) => holder.stdout!.once("data", resolve));
      try {
        cleanupTmp();
      } catch (e) {
        failures.push((e as NodeJS.ErrnoException).code ?? String(e));
      }
      // The holder is always awaited, so no trial outlives this test.
      await exited;
      if (existsSync(root)) {
        failures.push(`left behind: ${root}`);
        // Do not litter /tmp when this case fails; the holder has exited.
        rmSync(root, { recursive: true, force: true });
      }
    }
    expect(failures).toEqual([]);
  }, 60_000);
});

// Codex #1054 P1 4355365276. The isolated config was created through makeTmp,
// so the FIRST afterEach deleted it while GIT_CONFIG_GLOBAL still named it, and
// git reads a missing global config as EMPTY: every later test in the file ran
// with automatic maintenance back on. The case above passed only because it
// ran first. These two run in order: one cleans up, the next must still be
// isolated.
describe("the isolated git config outlives per-test cleanup", () => {
  it("a test that creates a fixture and is cleaned up after", () => {
    const fx = createFixture();
    expect(existsSync(fx.work)).toBe(true);
  });

  it("the NEXT test still sees the config, and a commit still launches no maintenance", () => {
    const global = process.env.GIT_CONFIG_GLOBAL;
    expect(global, "GIT_CONFIG_GLOBAL is not set").toBeTruthy();
    expect(existsSync(global!), `${global} was deleted by an earlier test's cleanup`).toBe(true);

    const fx = createFixture();
    write(fx.work, "lib/after-cleanup.ts", "export const after = 1;\n");
    spawnSync("git", ["add", "-A"], { cwd: fx.work });
    const traced = spawnSync("git", ["commit", "--quiet", "-m", "after cleanup"], {
      cwd: fx.work,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_TRACE: "1",
        GIT_AUTHOR_NAME: "Fixture Author",
        GIT_AUTHOR_EMAIL: "fixture@example.com",
        GIT_COMMITTER_NAME: "Fixture Author",
        GIT_COMMITTER_EMAIL: "fixture@example.com",
      },
    });
    expect(traced.status, traced.stderr).toBe(0);
    expect(traced.stderr).toMatch(/trace: built-in: git commit/u);
    expect(traced.stderr).not.toMatch(/maintenance run|gc --auto/u);
  });
});
