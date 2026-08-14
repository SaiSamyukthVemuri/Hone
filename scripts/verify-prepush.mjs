#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Pre-push committed-tree verification.
//
// WHY THIS EXISTS
// "Typecheck passed" is a claim about the WORKING TREE, not about what you
// pushed. This repository has been bitten repeatedly:
//   * a stash/pop cycle silently dropped 10 modified files from the index, so
//     the commit contained only the 4 new ones and CI failed on a missing
//     export while local tsc was still clean;
//   * a `git add app docs tests` missed README.md at the repository root, so a
//     locally-green commit would have failed the docs guard.
//
// Both are the same defect: the tested tree and the committed tree diverged.
// This script refuses to let that reach a push.
//
// It does NOT install or mutate any global Git hook. It is invoked explicitly.
//
// Usage:  npm run verify:prepush
// ---------------------------------------------------------------------------

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const RED = "[31m";
const GREEN = "[32m";
const DIM = "[2m";
const RESET = "[0m";

const failures = [];
const notes = [];

function git(args, { allowFail = false } = {}) {
  try {
    return execFileSync("git", args, { encoding: "utf8" });
  } catch (err) {
    if (allowFail) return err.stdout ?? "";
    throw err;
  }
}

function check(name, fn) {
  try {
    const problem = fn();
    if (problem) {
      failures.push({ name, problem });
      console.log(`${RED}✗${RESET} ${name}`);
      for (const line of String(problem).split("\n").filter(Boolean)) {
        console.log(`    ${line}`);
      }
    } else {
      console.log(`${GREEN}✓${RESET} ${name}`);
    }
  } catch (err) {
    failures.push({ name, problem: err.message });
    console.log(`${RED}✗${RESET} ${name}\n    ${err.message}`);
  }
}

console.log("pre-push verification: the committed tree must be what you tested\n");

// 1. Nothing tracked may remain modified or staged-but-uncommitted.
check("working tree is clean (no tracked modifications after the commit)", () => {
  const porcelain = git(["status", "--porcelain"]).trimEnd();
  if (!porcelain) return null;
  const lines = porcelain.split("\n");
  const tracked = lines.filter((l) => !l.startsWith("??"));
  const untracked = lines.filter((l) => l.startsWith("??"));
  const parts = [];
  if (tracked.length) {
    parts.push("tracked files not committed:");
    parts.push(...tracked.map((l) => `  ${l}`));
    parts.push("  -> git add -A && git commit --amend --no-edit");
  }
  if (untracked.length) {
    // Untracked files are reported, but a documented local-only allowlist is
    // honoured: supabase/config.toml is local E2E stack config that must
    // never be committed.
    const ALLOWED_UNTRACKED = [/^\?\? supabase\/config\.toml$/, /^\?\? node_modules/];
    const unexpected = untracked.filter((l) => !ALLOWED_UNTRACKED.some((re) => re.test(l)));
    if (unexpected.length) {
      parts.push("untracked files that may have been omitted from the commit:");
      parts.push(...unexpected.map((l) => `  ${l}`));
      parts.push("  -> add them, or add them to .gitignore deliberately");
    } else {
      notes.push("untracked files present but all on the documented local-only allowlist");
    }
  }
  return parts.length ? parts.join("\n") : null;
});

// 2. HEAD must equal the working tree.
check("git diff HEAD is empty (commit matches the tree you tested)", () => {
  const diff = git(["diff", "HEAD", "--stat"]).trim();
  return diff ? `HEAD differs from the working tree:\n${diff}` : null;
});

// 3. Whitespace errors and conflict markers in the committed diff.
check("git diff --check (whitespace / conflict markers)", () => {
  const out = git(["diff", "--check"], { allowFail: true }).trim();
  const staged = git(["diff", "--cached", "--check"], { allowFail: true }).trim();
  const both = [out, staged].filter(Boolean).join("\n");
  return both || null;
});

check("no unresolved conflict markers in tracked files", () => {
  const files = git(["ls-files"]).split("\n").filter(Boolean);
  const bad = [];
  for (const f of files) {
    if (!existsSync(f)) continue;
    // Skip anything not plausibly text.
    if (/\.(png|jpe?g|webp|gif|ico|pdf|zip|woff2?|ttf)$/i.test(f)) continue;
    let content;
    try {
      content = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    // Match at line start only, so prose mentioning the markers does not trip.
    if (/^<{7} |^={7}$|^>{7} /m.test(content)) bad.push(f);
  }
  return bad.length ? `conflict markers in:\n${bad.map((f) => `  ${f}`).join("\n")}` : null;
});

// 4. Files you just exercised locally must be present in the committed tree.
//    Best-effort and explicit about its limits: it compares the newest-modified
//    source files against HEAD's tree.
check("recently edited source files are present in the committed tree", () => {
  const tracked = new Set(git(["ls-tree", "-r", "--name-only", "HEAD"]).split("\n").filter(Boolean));
  const porcelain = git(["status", "--porcelain"]).split("\n").filter(Boolean);
  const missing = porcelain
    .filter((l) => l.startsWith("??"))
    .map((l) => l.slice(3).trim())
    .filter((f) => /\.(ts|tsx|mjs|js|sql|ya?ml|json|md)$/.test(f))
    .filter((f) => !/^supabase\/config\.toml$/.test(f))
    .filter((f) => !tracked.has(f));
  return missing.length
    ? `these files exist locally but are NOT in the commit:\n${missing.map((f) => `  ${f}`).join("\n")}`
    : null;
});

// 5. The migration state must be internally consistent before a push.
check("migration state is derivable and consistent", () => {
  try {
    execFileSync("node", ["scripts/migration-state.mjs"], { encoding: "utf8", stdio: "pipe" });
    return null;
  } catch (err) {
    return `scripts/migration-state.mjs failed:\n${(err.stderr || err.message).toString().trim()}`;
  }
});

console.log("");
for (const n of notes) console.log(`${DIM}note: ${n}${RESET}`);

if (failures.length) {
  console.log(`\n${RED}pre-push verification FAILED${RESET}, ${failures.length} problem(s). Do not push.`);
  console.log(`${DIM}The required sequence is documented in CLAUDE.md.${RESET}`);
  process.exit(1);
}
console.log(`\n${GREEN}pre-push verification passed${RESET}, the committed tree matches what you tested.`);
