import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error - .mjs utility ships without type declarations
import { computeKey, entryDir, lookup } from "../../scripts/db-baseline/key.mjs";

// The baseline cache is valid for EXACTLY the inputs it was built from. These tests pin that a change to
// ANY input (a migration byte, a new, renamed or removed migration, the seed, the SQL the scripts run)
// yields a different key, so a stale entry is never found, and that nothing falls back to another entry.

let root: string;
let migrations: string;
let seed: string;
let sqlFile: string;
let cache: string;
const inputs = () => ({ migrationsDir: migrations, seedFile: seed, sqlFile });

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "hone-baseline-key-"));
  migrations = path.join(root, "migrations");
  cache = path.join(root, "cache");
  mkdirSync(migrations);
  mkdirSync(cache);
  writeFileSync(path.join(migrations, "0001_a.sql"), "select 1;\n");
  writeFileSync(path.join(migrations, "0002_b.sql"), "select 2;\n");
  seed = path.join(root, "seed.sql");
  writeFileSync(seed, "-- no rows\n");
  sqlFile = path.join(root, "sql.mjs");
  writeFileSync(sqlFile, "export const X = 1;\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("the cache key", () => {
  it("is stable for identical inputs, whatever the file times or creation order", () => {
    const a = computeKey(inputs()).key;
    utimesSync(path.join(migrations, "0001_a.sql"), new Date(2001, 1, 1), new Date(2001, 1, 1));
    expect(computeKey(inputs()).key).toBe(a);
  });

  it.each([
    ["one byte of one migration", () => writeFileSync(path.join(migrations, "0002_b.sql"), "select 3;\n")],
    ["a new migration", () => writeFileSync(path.join(migrations, "0003_c.sql"), "select 1;\n")],
    ["a renamed migration", () => {
      writeFileSync(path.join(migrations, "0002_renamed.sql"), "select 2;\n");
      rmSync(path.join(migrations, "0002_b.sql"));
    }],
    ["a removed migration", () => rmSync(path.join(migrations, "0002_b.sql"))],
    ["the seed", () => writeFileSync(seed, "insert into t values (1);\n")],
    ["the SQL the scripts run", () => writeFileSync(sqlFile, "export const X = 2;\n")],
  ])("changes when %s changes", (_label, change) => {
    const before = computeKey(inputs()).key;
    change();
    expect(computeKey(inputs()).key).not.toBe(before);
  });
});

describe("lookup: a stale baseline is never found", () => {
  const seal = (key: string, verified: boolean) => {
    const dir = entryDir(cache, key);
    mkdirSync(dir, { recursive: true });
    if (verified) writeFileSync(path.join(dir, "verified.json"), "{}");
  };

  it("finds the sealed entry for exactly these inputs", () => {
    seal(computeKey(inputs()).key, true);
    expect(lookup(cache, inputs()).ok).toBe(true);
  });

  it("refuses when no entry exists for these inputs", () => {
    const r = lookup(cache, inputs());
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/no baseline for these inputs/);
  });

  it("refuses an entry that was never verified", () => {
    seal(computeKey(inputs()).key, false);
    const r = lookup(cache, inputs());
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/never verified/);
  });

  it("after ANY input changes, the old sealed entry is invisible and nothing falls back to it", () => {
    seal(computeKey(inputs()).key, true);
    expect(lookup(cache, inputs()).ok).toBe(true);
    writeFileSync(path.join(migrations, "0002_b.sql"), "select 2; -- edited\n");
    const r = lookup(cache, inputs());
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/no baseline for these inputs/);
  });
});
