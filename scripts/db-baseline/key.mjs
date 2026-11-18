// The cache key. A cached baseline is valid for EXACTLY the inputs it was built from, and
// nothing else decides that: the key is the sha256 of every supabase/migrations file (name
// and content), the synthetic seed and the SQL the scripts run (sql.mjs). Change any byte of
// any of them and the key changes, so the old entry is simply not found and a stale
// baseline can never be restored by accident. Nothing is ever "refreshed in place".
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..", "..");
export const DEFAULT_MIGRATIONS = path.join(REPO_ROOT, "supabase", "migrations");
export const DEFAULT_SEED = path.join(HERE, "seed.sql");
export const DEFAULT_SQL = path.join(HERE, "sql.mjs");
export const DEFAULT_CACHE = process.env.HONE_DB_BASELINE_CACHE || "/srv/hone/cache/db-baseline";

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/** sha256 of "name sha256\n" lines over the sorted migration files. */
export function migrationsDigest(dir) {
  const names = readdirSync(dir).filter((n) => statSync(path.join(dir, n)).isFile()).sort();
  const lines = names.map((n) => `${n} ${sha256(readFileSync(path.join(dir, n)))}\n`);
  return { count: names.length, digest: sha256(lines.join("")) };
}

export function computeKey({ migrationsDir = DEFAULT_MIGRATIONS, seedFile = DEFAULT_SEED, sqlFile = DEFAULT_SQL } = {}) {
  const migrations = migrationsDigest(migrationsDir);
  const seed = sha256(readFileSync(seedFile));
  const sql = sha256(readFileSync(sqlFile));
  const key = sha256(`migrations ${migrations.digest}\nseed ${seed}\nsql ${sql}\n`);
  return { key, migrations, seed, sql };
}

export function entryDir(cacheDir, key) {
  return path.join(cacheDir, key);
}

/**
 * Looks the inputs up. Returns { ok:false, reason } when there is no entry for exactly
 * these inputs, or the entry was never verified (`verified.json` is written last, by
 * `seal`). The caller must then build from a fresh migration chain; it must never fall
 * back to some other entry.
 */
export function lookup(cacheDir, inputs) {
  const k = computeKey(inputs);
  const dir = entryDir(cacheDir, k.key);
  if (!existsSync(dir)) return { ok: false, reason: `no baseline for these inputs (key ${k.key.slice(0, 12)}); build one from a fresh migration chain`, ...k };
  if (!existsSync(path.join(dir, "verified.json"))) return { ok: false, reason: `the entry for key ${k.key.slice(0, 12)} was never verified (no verified.json); seal it or rebuild`, ...k };
  return { ok: true, dir, ...k };
}
