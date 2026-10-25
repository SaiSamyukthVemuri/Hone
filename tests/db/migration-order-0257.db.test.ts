import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { resolveLocalDbUrl } from "./helpers/harness";

// ORDER PROOF for 0257 (FOLLOWUP-0257 part d), run with the tooling that is
// actually used: the pinned `supabase db push --dry-run` against a scratch
// database that carries a synthetic migration history. Nothing is applied, and
// nothing touches the stack's own database (a throwaway database is created and
// dropped). Migration file bodies are empty stubs: dry-run only compares names.
//
// Hosted is modelled as the #1035 head: every repository migration below 0257
// applied (0001..0246). 0247-0256 are held, so they are NOT in a tree that
// ships only 0257, and they ARE in a tree that has merged the held work.

const REPO_MIGRATIONS = path.resolve(__dirname, "../../supabase/migrations");
const names = readdirSync(REPO_MIGRATIONS).filter((n) => n.endsWith(".sql")).sort();
const versionOf = (n: string) => n.slice(0, 4);
const BELOW = names.filter((n) => versionOf(n) < "0257");
const HELD = Array.from({ length: 10 }, (_, i) => `${String(247 + i).padStart(4, "0")}_held_stub.sql`);
const THIS = names.find((n) => versionOf(n) === "0257")!;

const cli = spawnSync("supabase", ["--version"], { encoding: "utf8" });
const HAVE_CLI = cli.status === 0;
const dbName = `j9_order_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
const admin = new Pool({ connectionString: resolveLocalDbUrl(), max: 1 });
const dirs: string[] = [];

afterAll(async () => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  await admin.query(`drop database if exists ${dbName} with (force)`).catch(() => undefined);
  await admin.end();
});

function scratchUrl(): string {
  const u = new URL(resolveLocalDbUrl());
  u.pathname = `/${dbName}`;
  return u.toString();
}

async function remoteHistory(applied: string[]): Promise<void> {
  await admin.query(`drop database if exists ${dbName} with (force)`);
  await admin.query(`create database ${dbName}`);
  const p = new Pool({ connectionString: scratchUrl(), max: 1 });
  try {
    await p.query(`create schema supabase_migrations;
      create table supabase_migrations.schema_migrations (version text not null primary key, statements text[], name text)`);
    for (const n of applied) {
      await p.query(`insert into supabase_migrations.schema_migrations (version, name) values ($1, $2)`, [versionOf(n), n.slice(5, -4)]);
    }
  } finally {
    await p.end();
  }
}

function dryRun(tree: string[], includeAll: boolean) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "j9-order-"));
  dirs.push(dir);
  mkdirSync(path.join(dir, "supabase/migrations"), { recursive: true });
  for (const n of tree) writeFileSync(path.join(dir, "supabase/migrations", n), "select 1;\n");
  const args = ["db", "push", "--dry-run", "--db-url", scratchUrl(), "--workdir", dir];
  if (includeAll) args.push("--include-all");
  const r = spawnSync("supabase", args, { encoding: "utf8", env: { ...process.env, SUPABASE_INTERNAL_NO_TELEMETRY: "1" } });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
}
const listed = (out: string) => [...out.matchAll(/(\d{4})_[\w-]+\.sql/g)].map((m) => m[1]);

describe.skipIf(!HAVE_CLI && !process.env.CI)("0257 order proof (real supabase db push --dry-run)", () => {
  it("the pinned CLI is present", () => {
    expect(HAVE_CLI, "supabase CLI must be on PATH").toBe(true);
  });

  it("O1 hosted at 0246, a tree with only 0257 added: db push applies exactly 0257, no --include-all", async () => {
    await remoteHistory(BELOW);
    const r = dryRun([...BELOW, THIS], false);
    expect(r.status, r.out).toBe(0);
    expect(listed(r.out).filter((v) => v >= "0213")).toEqual(["0257"]);
  });

  it("O2 hosted at 0257 (applied alone), then the held 0247-0256 arrive: db push REFUSES without --include-all", async () => {
    await remoteHistory([...BELOW, THIS]);
    const tree = [...BELOW, ...HELD, THIS].sort();
    const r = dryRun(tree, false);
    expect(r.status, r.out).not.toBe(0);
    expect(r.out).toMatch(/include-all/);
    expect(listed(r.out).filter((v) => v >= "0247" && v <= "0256")).toEqual(HELD.map(versionOf));
  });

  it("O3 the same state with --include-all applies 0247-0256 OUT OF ORDER, after 0257", async () => {
    await remoteHistory([...BELOW, THIS]);
    const tree = [...BELOW, ...HELD, THIS].sort();
    const r = dryRun(tree, true);
    expect(r.status, r.out).toBe(0);
    expect(listed(r.out).filter((v) => v >= "0247")).toEqual(HELD.map(versionOf));
  });

  it("O4 hosted at 0246, a tree that already holds 0247-0256: 0257 cannot go alone, it travels with all ten", async () => {
    await remoteHistory(BELOW);
    const r = dryRun([...BELOW, ...HELD, THIS].sort(), false);
    expect(r.status, r.out).toBe(0);
    expect(listed(r.out).filter((v) => v >= "0247")).toEqual([...HELD.map(versionOf), "0257"]);
  });
});
