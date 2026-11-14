#!/usr/bin/env node
// Writes the DERIVED rows of docs/production/migration-ledger.md's current-state block: the repo max and the next free number.
// Those two rows carry the marker `<!-- ledger-derived -->` and are rewritten only by this script (`npm run ledger:sync`), so they can
// never be hand-wrong. `--check` changes nothing and exits 1 when a marked row differs from what would be written.
// Hosted facts are DECLARED (docs/production/migration-state.json), not derived, and are not touched here.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { REPO_ROOT, getMigrationState } from "./migration-state.mjs";

export const MARKER = "<!-- ledger-derived -->";
export const LEDGER_FILE = join(REPO_ROOT, "docs", "production", "migration-ledger.md");

/** The two derived rows, from a migration-state object. Pure. */
export function renderDerivedRows(state) {
  const file = state.files[state.files.length - 1];
  return {
    repo: `| **Repo migration max** | **${state.repo_migration_max}** (\`${file}\`), derived from the source files on this tree. ${MARKER} |`,
    next: `| **Next free number** | Next free number is **${String(state.next_free_migration_number).padStart(4, "0")}** by this tree's derived filenames, **not claimed** or reallocated here. Numbers are allocated by OPS reservation, not by this file. ${MARKER} |`,
  };
}

const isRepoRow = (l) => /^\|\s*\*\*Repo migration max\*\*/.test(l);
const isNextRow = (l) => /^\|\s*\*\*Next free number\*\*/.test(l);

/** Index of the first line of the CURRENT-state block and its end (exclusive). Throws when there is no such block. */
export function currentBlockRange(lines) {
  const start = lines.findIndex((l) => /^##\s+Current state\b/.test(l));
  if (start === -1) throw new Error("migration-ledger.md has no '## Current state' block");
  const rest = lines.slice(start + 1);
  const off = rest.findIndex((l) => l.startsWith("## "));
  return [start, off === -1 ? lines.length : start + 1 + off];
}

/** Rewrite the first repo-max row and the first next-free row inside the current block. Returns { text, changed }. Pure. */
export function syncLedgerText(text, state) {
  const lines = text.split("\n");
  const [a, b] = currentBlockRange(lines);
  const rows = renderDerivedRows(state);
  let changed = false;
  let sawRepo = false;
  let sawNext = false;
  for (let i = a; i < b; i += 1) {
    let want = null;
    if (!sawRepo && isRepoRow(lines[i])) { want = rows.repo; sawRepo = true; }
    else if (!sawNext && isNextRow(lines[i])) { want = rows.next; sawNext = true; }
    if (want !== null && lines[i] !== want) { lines[i] = want; changed = true; }
  }
  if (!sawRepo || !sawNext) throw new Error("the current-state block must carry a 'Repo migration max' row and a 'Next free number' row");
  return { text: lines.join("\n"), changed };
}

/** The marked rows of the current block, for the equality test. */
export function markedRows(text) {
  const lines = text.split("\n");
  const [a, b] = currentBlockRange(lines);
  return lines.slice(a, b).filter((l) => l.includes(MARKER));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes("--check");
  const text = readFileSync(LEDGER_FILE, "utf8");
  const { text: next, changed } = syncLedgerText(text, getMigrationState());
  if (check) {
    if (changed) { console.error("migration-ledger.md derived rows are stale: run `npm run ledger:sync`"); process.exit(1); }
    console.log("migration-ledger.md derived rows are current");
  } else if (changed) {
    writeFileSync(LEDGER_FILE, next);
    console.log("migration-ledger.md derived rows updated");
  } else {
    console.log("migration-ledger.md derived rows already current");
  }
}
