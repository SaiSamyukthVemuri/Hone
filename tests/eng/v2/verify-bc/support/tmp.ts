// Scratch directories for the verifier. One root per test process; heavy rows work inside a scope that is removed as
// soon as they finish, so the final afterAll removes little. Removal is one native recursive force-remove per tree
// (fs.rmSync never follows a symlink: it removes the link itself). Permissions are restored only for the entries a
// row deliberately made unreadable (markRestrictive), never by walking the tree.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** The system temporary directory, captured before redirectTmpdir() points TMPDIR at our own root. */
const BASE_TMP = os.tmpdir();
let root: string | null = null;
let scope: string | null = null;
let savedTmpdir: string | undefined;
let redirected = false;
const restrictive = new Set<string>();

function ensureRoot(): string {
  if (root === null || !fs.existsSync(root)) root = fs.mkdtempSync(path.join(BASE_TMP, "vbc-run-"));
  return root;
}

/** A fresh directory in the current scope (or the root). */
export function tmp(prefix: string): string {
  const base = scope !== null && fs.existsSync(scope) ? scope : ensureRoot();
  return fs.mkdtempSync(path.join(base, prefix));
}

/** A fresh directory directly under the root: it outlives every scope (e.g. the HEAD-less copy of the tool). */
export function tmpAtRoot(prefix: string): string {
  return fs.mkdtempSync(path.join(ensureRoot(), prefix));
}

/** Record an entry a row chmods to deny access, so removal restores exactly that entry first. */
export function markRestrictive(p: string): void {
  restrictive.add(p);
}

function removeTree(p: string): void {
  for (const r of [...restrictive]) {
    if (r !== p && !r.startsWith(p + path.sep)) continue;
    try {
      const st = fs.lstatSync(r);
      if (!st.isSymbolicLink()) fs.chmodSync(r, st.isDirectory() ? 0o700 : 0o600);
    } catch {
      /* already gone */
    }
    restrictive.delete(r);
  }
  fs.rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
}

/** Run fn with tmp() creating inside a fresh scope, and remove that scope as soon as fn settles. */
export async function inScope<T>(name: string, fn: () => T | Promise<T>): Promise<T> {
  const prev = scope;
  const mine = fs.mkdtempSync(path.join(ensureRoot(), `${name.replace(/[^A-Za-z0-9-]/g, "-").slice(0, 40)}-`));
  scope = mine;
  try {
    return await fn();
  } finally {
    scope = prev;
    removeTree(mine);
  }
}

/** Point TMPDIR at the root too, so scratch directories the code under test makes (its gh HOME) are removed with it
 * even when the test worker is killed before the code's own exit-time cleanup runs. */
export function redirectTmpdir(): void {
  if (!redirected) {
    savedTmpdir = process.env.TMPDIR;
    redirected = true;
  }
  process.env.TMPDIR = ensureRoot();
}

export function cleanupTmp(): void {
  if (redirected) {
    if (savedTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = savedTmpdir;
    redirected = false;
  }
  if (root === null) return;
  const r = root;
  root = null;
  scope = null;
  removeTree(r);
}

/** Every hook that does real work gets this explicit timeout, never vitest's 10 s default: a shared CI runner that
 * runs every test file at once is far slower than a laptop. */
export const HOOK_TIMEOUT = 120_000;
