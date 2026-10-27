#!/usr/bin/env node
// ---------------------------------------------------------------------------
// The committed public-schema snapshot: table and function NAMES, derived from
// supabase/migrations/*.sql in apply order. Never hand-written.
//
//   npm run schema:snapshot                # check: exit 1 when stale (verify:prepush runs it)
//   npm run schema:snapshot -- --write     # regenerate after adding or editing a migration
//
// It exists so the "does application code still reference what the export
// registry claims" checks can run as UNIT tests on every application change,
// instead of walking app/, lib/ and components/ from the DB lane (OPS ruling
// 20261023T1430Z, option b).
//
// WHAT IT IS NOT: the schema authority. Migration text is parsed, in file
// order, for public tables (CREATE [UNLOGGED] TABLE, DROP TABLE a, b, ALTER
// TABLE ... RENAME TO; temp tables and other schemas ignored) and public
// functions keyed by name AND input argument types (CREATE [OR REPLACE],
// DROP of one overload or a bare name, ALTER FUNCTION ... RENAME TO), with
// comments stripped outside string literals. A CREATE built at run time with
// EXECUTE format(...) cannot be parsed; none exists today for a table or
// function. The DB lane checks this snapshot against the LIVE catalogue in
// BOTH directions (tests/db/export-resource-registry.db.test.ts; functions
// exclude extension members), so a parse the database disagrees with is
// caught there, nightly at the latest.
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

// ---- Lexing ---------------------------------------------------------------

/**
 * SQL with comments removed, so DDL quoted in prose is never read as DDL. A
 * `--` or `/*` inside a single-quoted string is text, not a comment (Photos F2
 * P5: `select '--'; create table ...` hid the CREATE). Dollar-quoted bodies are
 * scanned as code: a DO block's DDL really runs at migration time.
 */
export function stripComments(sql) {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === "'") {
      let j = i + 1;
      for (; j < sql.length; j++) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") j++;
          else break;
        }
      }
      out += sql.slice(i, j + 1);
      i = j + 1;
    } else if (c === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
    } else if (c === "/" && sql[i + 1] === "*") {
      let depth = 0;
      do {
        if (sql[i] === "/" && sql[i + 1] === "*") { depth++; i += 2; }
        else if (sql[i] === "*" && sql[i + 1] === "/") { depth--; i += 2; }
        else i++;
      } while (depth > 0 && i < sql.length);
      out += " ";
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

// [schema.]name, either part optionally double-quoted. The trailing guard stops
// a backtrack to a shorter name and refuses a name followed by `.`, so
// `private.zz` reads as schema private + name zz, never as a table called
// "private" (Photos F2 P1).
const QUALIFIED = String.raw`(?:"?([a-z_][a-z0-9_]*)"?\s*\.\s*)?"?([a-z_][a-z0-9_]*)"?(?![a-z0-9_$"]|\s*\.)`;
const re = (src) => new RegExp(src, "giy");

/** The public object a match names, or null for another schema. */
function publicName(schema, name) {
  if (schema !== undefined && schema.toLowerCase() !== "public") return null;
  return name.toLowerCase();
}

/** The balanced `( ... )` starting at sql[open] (which must be `(`): [inner text, index after `)`]. */
function balanced(sql, open) {
  let depth = 0;
  for (let i = open; i < sql.length; i++) {
    if (sql[i] === "(") depth++;
    else if (sql[i] === ")" && --depth === 0) return [sql.slice(open + 1, i), i + 1];
  }
  return [sql.slice(open + 1), sql.length];
}

function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let cur = "";
  for (const ch of text) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur.trim() !== "") parts.push(cur);
  return parts;
}

// ---- Function identity -----------------------------------------------------
// PostgreSQL identifies a function by name AND input argument types, so one
// DROP of f(int) must not remove a live f(text) (Photos F2 P2). Parameter names,
// defaults, OUT parameters and type modifiers are not part of the identity.

const TYPE_ALIASES = new Map([
  ["int", "integer"], ["int4", "integer"], ["int8", "bigint"], ["int2", "smallint"],
  ["bool", "boolean"], ["varchar", "character varying"], ["char", "character"],
  ["float8", "double precision"], ["float4", "real"], ["decimal", "numeric"],
  ["timestamptz", "timestamp with time zone"], ["timestamp", "timestamp without time zone"],
  ["timetz", "time with time zone"], ["time", "time without time zone"],
]);
// Words that begin a (possibly multi-word) type, so they are never mistaken for a parameter name.
const TYPE_START = new Set(["double", "character", "bit", "timestamp", "time", "interval", "national", "varchar", "char"]);

function canonicalType(raw) {
  let t = raw.toLowerCase().replace(/"/g, "").replace(/\([^)]*\)/g, "").replace(/\s+/g, " ").trim();
  t = t.replace(/^public\s*\.\s*/, "");
  const array = t.endsWith("[]") ? "[]" : "";
  if (array) t = t.slice(0, -2).trim();
  return (TYPE_ALIASES.get(t) ?? t) + array;
}

/** The identity signature of an argument list: input types only, canonicalised. */
export function functionSignature(args) {
  const types = [];
  for (const part of splitTopLevel(args)) {
    let tokens = part.replace(/\s+(?:default\b|=)[\s\S]*$/i, "").trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    const mode = tokens[0].toLowerCase();
    if (mode === "out") continue;
    if (mode === "in" || mode === "inout" || mode === "variadic") tokens = tokens.slice(1);
    if (tokens.length >= 2 && !TYPE_START.has(tokens[0].toLowerCase().replace(/"/g, ""))) tokens = tokens.slice(1);
    types.push(canonicalType(tokens.join(" ")));
  }
  return types.join(",");
}

// ---- Statements --------------------------------------------------------------

const CREATE_TABLE = String.raw`\bcreate\s+(?:(?:global|local)\s+)?(temp|temporary|unlogged)?\s*table\s+(?:if\s+not\s+exists\s+)?`;
const DROP_TABLE = String.raw`\bdrop\s+table\s+(?:if\s+exists\s+)?`;
const ALTER_TABLE = String.raw`\balter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?`;
const CREATE_FUNCTION = String.raw`\bcreate\s+(?:or\s+replace\s+)?function\s+`;
const DROP_FUNCTION = String.raw`\bdrop\s+function\s+(?:if\s+exists\s+)?`;
const ALTER_FUNCTION = String.raw`\balter\s+function\s+`;
const STATEMENT = new RegExp(`${CREATE_TABLE}|${DROP_TABLE}|${ALTER_TABLE}|${CREATE_FUNCTION}|${DROP_FUNCTION}|${ALTER_FUNCTION}`, "gi");

/** Applies one migration's DDL, in textual order, to the running state. */
function applyMigration(sql, tables, functions) {
  const readName = (pos) => {
    const r = re(String.raw`\s*${QUALIFIED}`);
    r.lastIndex = pos;
    const m = r.exec(sql);
    return m ? { schema: m[1], name: m[2], end: r.lastIndex } : null;
  };
  const readArgs = (pos) => {
    const r = re(String.raw`\s*\(`);
    r.lastIndex = pos;
    if (!r.exec(sql)) return null;
    return balanced(sql, r.lastIndex - 1);
  };
  const removeFunction = (name, args) => {
    if (!functions.has(name)) return;
    if (args === null) functions.delete(name);
    else {
      functions.get(name).delete(functionSignature(args));
      if (functions.get(name).size === 0) functions.delete(name);
    }
  };

  for (const m of sql.matchAll(STATEMENT)) {
    const head = m[0].toLowerCase();
    const at = m.index + m[0].length;
    if (/^create\b[\s\S]*\btable\b/.test(head)) {
      const n = readName(at);
      if (!n || /^temp/i.test(m[1] ?? "")) continue; // temp/temporary tables are not schema; UNLOGGED ones are
      const name = publicName(n.schema, n.name);
      if (name) tables.add(name);
    } else if (/^drop\s+table/.test(head)) {
      let pos = at;
      for (;;) {
        const n = readName(pos);
        if (!n) break;
        const name = publicName(n.schema, n.name);
        if (name) tables.delete(name);
        const comma = re(String.raw`\s*,`);
        comma.lastIndex = n.end;
        if (!comma.exec(sql)) break;
        pos = comma.lastIndex;
      }
    } else if (/^alter\s+table/.test(head)) {
      const n = readName(at);
      if (!n) continue;
      const r = re(String.raw`\s+rename\s+to\s+"?([a-z_][a-z0-9_]*)"?`);
      r.lastIndex = n.end;
      const to = r.exec(sql);
      const from = publicName(n.schema, n.name);
      if (to && from && tables.delete(from)) tables.add(to[1].toLowerCase());
    } else if (/^create\b/.test(head)) {
      const n = readName(at);
      const name = n && publicName(n.schema, n.name);
      const args = n && readArgs(n.end);
      if (!name || !args) continue;
      if (!functions.has(name)) functions.set(name, new Set());
      functions.get(name).add(functionSignature(args[0]));
    } else if (/^drop\s+function/.test(head)) {
      let pos = at;
      for (;;) {
        const n = readName(pos);
        if (!n) break;
        const args = readArgs(n.end);
        const name = publicName(n.schema, n.name);
        if (name) removeFunction(name, args ? args[0] : null);
        const comma = re(String.raw`\s*,`);
        comma.lastIndex = args ? args[1] : n.end;
        if (!comma.exec(sql)) break;
        pos = comma.lastIndex;
      }
    } else if (/^alter\s+function/.test(head)) {
      const n = readName(at);
      const name = n && publicName(n.schema, n.name);
      if (!name || !functions.has(name)) continue;
      const args = readArgs(n.end);
      const r = re(String.raw`\s+rename\s+to\s+"?([a-z_][a-z0-9_]*)"?`);
      r.lastIndex = args ? args[1] : n.end;
      const to = r.exec(sql);
      if (!to) continue;
      const moved = args ? [functionSignature(args[0])] : [...functions.get(name)];
      removeFunction(name, args ? args[0] : null);
      const target = to[1].toLowerCase();
      if (!functions.has(target)) functions.set(target, new Set());
      for (const sig of moved) functions.get(target).add(sig);
    }
  }
}

/** The snapshot of the public schema as the migrations in `dir` describe it. */
export function buildSchemaSnapshot(dir = path.join(REPO_ROOT, "supabase/migrations")) {
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const hash = createHash("sha256");
  const tables = new Set();
  /** name -> the identity signatures of its live overloads */
  const functions = new Map();
  for (const f of files) {
    const raw = readFileSync(path.join(dir, f));
    hash.update(f).update("\0").update(raw).update("\0");
    applyMigration(stripComments(raw.toString("utf8")), tables, functions);
  }
  return {
    generated_by: "npm run schema:snapshot -- --write",
    migrations: { count: files.length, last: files.at(-1) ?? null, sha256: hash.digest("hex") },
    public: { tables: [...tables].sort(), functions: [...functions.keys()].sort() },
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
      console.error(`${SNAPSHOT_PATH} is stale against supabase/migrations: run npm run schema:snapshot -- --write, then commit it`);
      process.exit(1);
    }
    console.log(`${SNAPSHOT_PATH} is current`);
  }
}
