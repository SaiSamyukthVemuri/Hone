// One temporary root per test process; every scratch directory the verifier makes lives under it, and each test
// file removes it in afterAll (some rows chmod entries to 000, so permissions are restored first).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let root: string | null = null;
let savedTmpdir: string | undefined;
let redirected = false;

export function tmp(prefix: string): string {
  if (root === null || !fs.existsSync(root)) root = fs.mkdtempSync(path.join(os.tmpdir(), "vbc-run-"));
  return fs.mkdtempSync(path.join(root, prefix));
}

function restorePerms(p: string) {
  try {
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) return;
    fs.chmodSync(p, st.isDirectory() ? 0o700 : 0o600);
    if (st.isDirectory()) for (const e of fs.readdirSync(p)) restorePerms(path.join(p, e));
  } catch {
    /* best effort */
  }
}

/** Point TMPDIR at the root too, so scratch directories the code under test makes (its gh HOME) are removed with it
 * even when the test worker is killed before the code's own exit-time cleanup runs. */
export function redirectTmpdir(): void {
  tmp("init-");
  if (!redirected) {
    savedTmpdir = process.env.TMPDIR;
    redirected = true;
  }
  process.env.TMPDIR = root!;
}

export function cleanupTmp(): void {
  if (redirected) {
    if (savedTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = savedTmpdir;
    redirected = false;
  }
  if (root === null) return;
  restorePerms(root);
  fs.rmSync(root, { recursive: true, force: true });
  root = null;
}
