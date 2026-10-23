#!/usr/bin/env node
// ---------------------------------------------------------------------------
// The committed public-schema snapshot: table and function NAMES, derived from
// supabase/migrations/*.sql in apply order. Never hand-written.
//
//   node scripts/schema-snapshot.mjs           # check: exit 1 when stale
//   node scripts/schema-snapshot.mjs --write   # regenerate after a migration
//
// It exists so the "does application code still reference what the export
// registry claims" checks can run as UNIT tests on every application change,
// instead of walking app/, lib/ and components/ from the DB lane (OPS ruling
// 20261023T1430Z, option b).
//
// WHAT IT IS NOT: the schema authority. Migration text is parsed for names
// only (comments stripped; CREATE adds, DROP removes, in file order), which a
// rename, an EXECUTE'd CREATE or a DO block could defeat. None of those occur
// for tables or functions today, and the DB lane checks this snapshot against
// the LIVE catalogue (tests/db/export-resource-registry.db.test.ts), so a
// parse the database disagrees with is caught there, nightly at the latest.
//
// FRESHNESS: the snapshot records a hash over every migration's name and
// bytes. tests/lib/export/registry-app-references.test.ts regenerates it and
// fails on any difference, so a new or edited migration without --write is
// red in the unit lane.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
export const SNAPSHOT_PATH = "supabase/schema-snapshot.json";

const IDENT = String.raw`(?:"?public"?\.)?"?([a-z_][a-z0-9_]*)"?`;
const FUNCTION_DDL = new RegExp(String.raw`\b(create(?:\s+or\s+replace)?|drop)\s+function\s+(?:if\s+exists\s+)?${IDENT}`, "gi");
const TABLE_DDL = new RegExp(String.raw`\b(create|drop)\s+table\s+(?:if\s+(?:not\s+)?exists\s+)?${IDENT}`, "gi");

/** SQL with comments removed, so DDL quoted in prose is never read as DDL. */
function stripComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
}

function apply(set, sql, re) {
  for (const m of sql.matchAll(re)) {
    const name = m[2].toLowerCase();
    if (/^drop/i.test(m[1])) set.delete(name);
    else set.add(name);
  }
}

/** The snapshot of the public schema as the migrations in `dir` describe it. */
export function buildSchemaSnapshot(dir = path.join(REPO_ROOT, "supabase/migrations")) {
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const hash = createHash("sha256");
  const tables = new Set();
  const functions = new Set();
  for (const f of files) {
    const raw = readFileSync(path.join(dir, f));
    hash.update(f).update("\0").update(raw).update("\0");
    const sql = stripComments(raw.toString("utf8"));
    apply(tables, sql, TABLE_DDL);
    apply(functions, sql, FUNCTION_DDL);
  }
  return {
    generated_by: "node scripts/schema-snapshot.mjs --write",
    migrations: { count: files.length, last: files.at(-1) ?? null, sha256: hash.digest("hex") },
    public: { tables: [...tables].sort(), functions: [...functions].sort() },
  };
}

export function serialise(snapshot) {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = path.join(REPO_ROOT, SNAPSHOT_PATH);
  const fresh = serialise(buildSchemaSnapshot());
  if (process.argv.includes("--write")) {
    writeFileSync(target, fresh);
    console.log(`wrote ${SNAPSHOT_PATH}`);
  } else {
    let committed = "";
    try {
      committed = readFileSync(target, "utf8");
    } catch {
      /* missing reads as stale */
    }
    if (committed !== fresh) {
      console.error(`${SNAPSHOT_PATH} is stale: run node scripts/schema-snapshot.mjs --write`);
      process.exit(1);
    }
    console.log(`${SNAPSHOT_PATH} is current`);
  }
}
