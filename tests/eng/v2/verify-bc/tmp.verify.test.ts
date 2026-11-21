// The scratch-tree remover (support/tmp.ts removeTree) must leave nothing or throw. A returned fs.rmSync is not
// proof the tree is gone: on Node 24.22.1, under a concurrent writer, it can return WITHOUT error and leave the tree
// behind, ignoring maxRetries (measured: 9 of 150 trials; 0 of 120 on 22.23.4 and 20.20.2).
//
// The silent return is a Node-24 race, so the contract is proved deterministically with fs.rmSync stubbed to
// return without removing, and the real race is then run against whichever Node executes the suite.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { REMOVE_ATTEMPTS, cleanupTmp, tmpAtRoot } from "./support/tmp";

const realRmSync = fs.rmSync;
const stray: string[] = [];
afterEach(() => vi.restoreAllMocks());
afterAll(() => {
  for (const d of stray) realRmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

/** A fresh verifier root holding a few files; returns the root that cleanupTmp() removes. */
function populatedRoot(): string {
  const scratch = tmpAtRoot("victim-");
  for (let i = 0; i < 40; i++) {
    fs.mkdirSync(path.join(scratch, `s${i % 4}`), { recursive: true });
    fs.writeFileSync(path.join(scratch, `s${i % 4}`, `f${i}`), "x");
  }
  const root = path.dirname(scratch);
  stray.push(root);
  return root;
}

describe("removeTree: verified, retried, then thrown", () => {
  it("an rmSync that returns WITHOUT removing is retried until the tree is gone", () => {
    const root = populatedRoot();
    let silent = 2;
    const rm = vi.spyOn(fs, "rmSync").mockImplementation(((p: fs.PathLike, o?: fs.RmOptions) => {
      if (silent-- > 0) return;
      realRmSync(p, o);
    }) as typeof fs.rmSync);
    cleanupTmp();
    expect(fs.existsSync(root)).toBe(false);
    expect(rm).toHaveBeenCalledTimes(3);
  });

  it("an rmSync that never removes makes removal THROW, never return with the tree on disk", () => {
    const root = populatedRoot();
    const rm = vi.spyOn(fs, "rmSync").mockImplementation((() => undefined) as typeof fs.rmSync);
    expect(() => cleanupTmp()).toThrow(`survived ${REMOVE_ATTEMPTS} removals`);
    expect(rm).toHaveBeenCalledTimes(REMOVE_ATTEMPTS);
    expect(fs.existsSync(root)).toBe(true);
  });

  it("an rmSync that keeps throwing is retried, then its error is rethrown", () => {
    populatedRoot();
    const busy = Object.assign(new Error("ENOTEMPTY: directory not empty"), { code: "ENOTEMPTY" });
    const rm = vi.spyOn(fs, "rmSync").mockImplementation((() => {
      throw busy;
    }) as typeof fs.rmSync);
    expect(() => cleanupTmp()).toThrow(busy);
    expect(rm).toHaveBeenCalledTimes(REMOVE_ATTEMPTS);
  });
});

// The shape of tests/openwiki/tmp-cleanup.test.ts: a holder that writes and unlinks one lock file inside an EXISTING
// directory and never recreates a directory, so anything left after removal is a genuine survivor.
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

describe("removeTree under a real concurrent writer", () => {
  it(`a lock holder inside the tree: nothing is left behind, over 20 trials on Node ${process.version}`, async () => {
    const failures: string[] = [];
    for (let t = 0; t < 20; t++) {
      const root = populatedRoot();
      const objects = path.join(root, "repo", ".git", "objects");
      for (let i = 0; i < 300; i++) {
        const shard = path.join(objects, (i % 30).toString(16).padStart(2, "0"));
        fs.mkdirSync(shard, { recursive: true });
        fs.writeFileSync(path.join(shard, `o${i}`), "x");
      }
      const holder = spawn(process.execPath, ["-e", LOCK_HOLDER, objects, "100"], { stdio: ["ignore", "pipe", "ignore"] });
      const exited = new Promise((resolve) => holder.once("exit", resolve));
      await new Promise((resolve) => holder.stdout!.once("data", resolve));
      try {
        cleanupTmp();
      } catch (e) {
        failures.push((e as NodeJS.ErrnoException).code ?? String(e));
      }
      await exited;
      if (fs.existsSync(root)) failures.push(`left behind: ${root}`);
    }
    expect(failures).toEqual([]);
  }, 60_000);
});
