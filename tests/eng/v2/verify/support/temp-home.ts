/* eslint-disable @typescript-eslint/no-explicit-any -- primitives are untyped objects from an .mjs module */
// Independent verifier support: no leaked primitive homes (SPEC-05A §5.1).
//
// createPrimitive builds its fresh, empty child HOME (`hone-eng-gh-*`) under the
// process's temporary directory when it is constructed, and close() removes it
// (black-box: a never-used primitive also gets one; a primitive refused for lack of a
// token gets none). This helper gives a test file its own temporary directory, so
// the homes its primitives build land there and can be counted without racing the
// other test files vitest runs in parallel, tracks every primitive the file builds,
// and closes them after each test.

import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const HOME_PREFIX = "hone-eng-gh-";

export function primitiveHomes() {
  let root = "";
  let saved: string | undefined;
  let maxSeen = 0;
  const live = new Set<any>();
  const count = () => (root ? readdirSync(root).filter((n) => n.startsWith(HOME_PREFIX)).length : 0);
  return {
    /** call in beforeAll, before anything builds a primitive or a temp directory */
    setup() {
      saved = process.env.TMPDIR;
      root = mkdtempSync(path.join(os.tmpdir(), "verify-05a-homes-"));
      process.env.TMPDIR = root;
    },
    /** wraps createPrimitive: every primitive it builds is tracked until closed */
    wrap(create: (o: any) => any) {
      return (o: any) => {
        const p = create(o);
        if (p && typeof p.close === "function") live.add(p);
        maxSeen = Math.max(maxSeen, count());
        return p;
      };
    },
    /** call in afterEach: close() every primitive the test built */
    closeAll() {
      for (const p of live) {
        try {
          p.close();
        } catch {
          /* a close that throws still leaves the guard to report the leak */
        }
      }
      live.clear();
    },
    /** homes left behind in this file's directory */
    leftovers: () => (root ? readdirSync(root).filter((n) => n.startsWith(HOME_PREFIX)) : []),
    /** the most homes that existed at once: proves the guard is not vacuous */
    maxSeen: () => maxSeen,
    root: () => root,
    /** call in afterAll */
    teardown() {
      for (const p of live) {
        try {
          p.close();
        } catch {
          /* ignore */
        }
      }
      live.clear();
      if (saved === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = saved;
      if (root) rmSync(root, { recursive: true, force: true });
    },
  };
}
