#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Canonical migration-state utility.
//
// WHY THIS EXISTS
// Before this, the repository migration max was hard-coded in 18 places: a
// `toBe(165)` here, a `/^01(6[6-9]|[7-9]\d)_/` "trip on the next one" regex
// there, plus scripts/verify-production.mjs and the docs guards. Every new
// migration meant a mechanical edit across all of them, and the pins lived in
// BOTH tests/migrations/ and tests/docs/ and tests/scripts/, so a run scoped to
// the "obviously relevant" directory missed some and CI went red after push.
// That happened on 0163, 0164 and 0165.
//
// Repository state is DERIVABLE from filenames, so it is derived here, once.
//
// HOSTED state is NOT derivable from the repo: a file on disk says nothing
// about what production has applied. That single fact stays declared in the
// canonical ledger record (docs/production/migration-state.json) and is read
// from there, never duplicated.
//
// Usage:
//   node scripts/migration-state.mjs           # human summary
//   node scripts/migration-state.mjs --json    # machine-readable
// Import:
//   import { getMigrationState } from "./scripts/migration-state.mjs";
// ---------------------------------------------------------------------------

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, "..");
export const MIGRATIONS_DIR = join(REPO_ROOT, "supabase", "migrations");
export const CANONICAL_STATE_FILE = join(
  REPO_ROOT,
  "docs",
  "production",
  "migration-state.json",
);

/** Migration numbers deliberately never used. Documented, not guessed. */
export const PERMANENTLY_SKIPPED = Object.freeze([158]);

const FILENAME_RE = /^(\d{4})_([a-z0-9_]+)\.sql$/;

export class MigrationStateError extends Error {}

function pad(n) {
  return String(n).padStart(4, "0");
}

/**
 * Scan supabase/migrations and derive repository state.
 * Throws on malformed prefixes and duplicate versions: a silent pass there is
 * exactly how a bad migration number would reach production.
 */
export function scanMigrations(dir = MIGRATIONS_DIR) {
  if (!existsSync(dir)) {
    throw new MigrationStateError(`migrations directory not found: ${dir}`);
  }
  const all = readdirSync(dir).filter((f) => f.endsWith(".sql"));

  const malformed = all.filter((f) => !FILENAME_RE.test(f));
  if (malformed.length > 0) {
    throw new MigrationStateError(
      `malformed migration filename(s): ${malformed.join(", ")}. ` +
        `Expected NNNN_snake_case_name.sql with a four-digit prefix.`,
    );
  }

  const entries = all
    .map((file) => {
      const m = FILENAME_RE.exec(file);
      return { file, version: m[1], number: Number.parseInt(m[1], 10), name: m[2] };
    })
    .sort((a, b) => a.number - b.number);

  const seen = new Map();
  const duplicates = [];
  for (const e of entries) {
    if (seen.has(e.number)) duplicates.push({ number: e.number, files: [seen.get(e.number), e.file] });
    else seen.set(e.number, e.file);
  }
  if (duplicates.length > 0) {
    throw new MigrationStateError(
      `duplicate migration version(s): ` +
        duplicates.map((d) => `${pad(d.number)} (${d.files.join(" and ")})`).join("; ") +
        `. Two migrations must never share a number.`,
    );
  }

  if (entries.length === 0) {
    throw new MigrationStateError("no migrations found");
  }

  return entries;
}

/** The one canonical declaration of hosted state (not derivable from files). */
export function readCanonicalRecord(file = CANONICAL_STATE_FILE) {
  if (!existsSync(file)) {
    throw new MigrationStateError(
      `canonical migration-state record not found: ${file}. ` +
        `Hosted state cannot be derived from filenames and must be declared once.`,
    );
  }
  const raw = JSON.parse(readFileSync(file, "utf8"));
  for (const k of ["hosted_migration_max", "hosted_applied_at", "hosted_note"]) {
    if (!(k in raw)) {
      throw new MigrationStateError(`canonical record missing required key: ${k}`);
    }
  }
  if (!/^\d{4}$/.test(raw.hosted_migration_max)) {
    throw new MigrationStateError(
      `hosted_migration_max must be a four-digit string, got ${JSON.stringify(raw.hosted_migration_max)}`,
    );
  }
  return raw;
}

/**
 * Full state: repository facts DERIVED, hosted facts DECLARED.
 */
export function getMigrationState({ dir, canonicalFile } = {}) {
  const entries = scanMigrations(dir);
  const numbers = entries.map((e) => e.number);
  const repoMaxNumber = numbers[numbers.length - 1];

  // The next free number skips any permanently-skipped slot.
  let next = repoMaxNumber + 1;
  while (PERMANENTLY_SKIPPED.includes(next)) next += 1;

  const record = readCanonicalRecord(canonicalFile);
  const hostedMaxNumber = Number.parseInt(record.hosted_migration_max, 10);

  const pending = entries
    .filter((e) => e.number > hostedMaxNumber)
    .map((e) => e.version);

  return {
    repo_migration_max: pad(repoMaxNumber),
    repo_migration_max_number: repoMaxNumber,
    next_free_migration: pad(next),
    next_free_migration_number: next,
    total_migrations_in_repo: entries.length,
    permanently_skipped: PERMANENTLY_SKIPPED.map(pad),
    hosted_migration_max: record.hosted_migration_max,
    hosted_migration_max_number: hostedMaxNumber,
    hosted_applied_at: record.hosted_applied_at,
    hosted_note: record.hosted_note,
    repo_equals_hosted: repoMaxNumber === hostedMaxNumber,
    pending_migrations: pending,
    versions: entries.map((e) => e.version),
    files: entries.map((e) => e.file),
  };
}

/** Convenience for tests: assert nothing above the repo max exists. */
export function assertIsRepoMax(version, opts) {
  const s = getMigrationState(opts);
  if (s.repo_migration_max !== version) {
    throw new MigrationStateError(
      `expected ${version} to be the repo migration max, but it is ${s.repo_migration_max}`,
    );
  }
  return s;
}

if (process.argv[1] && process.argv[1].endsWith("migration-state.mjs")) {
  const state = getMigrationState();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(state, null, 2));
  } else {
    console.log(`repo max            ${state.repo_migration_max}`);
    console.log(`hosted max          ${state.hosted_migration_max}`);
    console.log(`next free           ${state.next_free_migration}`);
    console.log(`total in repo       ${state.total_migrations_in_repo}`);
    console.log(`permanently skipped ${state.permanently_skipped.join(", ") || "(none)"}`);
    console.log(
      `pending             ${state.pending_migrations.join(", ") || "(none, repo == hosted)"}`,
    );
  }
}
