import { describe, expect, it } from "vitest";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";

import { EXPORT_RESOURCE_REGISTRY, STORAGE_RESOURCE_PREFIX, type ResourceDisposition } from "@/lib/export/resource-registry";
// @ts-expect-error - .mjs utility ships without type declarations
import { buildSchemaSnapshot, serialise, SNAPSHOT_PATH } from "../../../scripts/schema-snapshot.mjs";

// ===========================================================================
// Does APPLICATION code still reference what the export registry claims?
// ===========================================================================
//
// Moved here from tests/db/export-resource-registry.db.test.ts (OPS ruling
// 20261023T1430Z, option b). That file walked app/, lib/ and components/ from
// the DB lane, so this check either ran the DB lane for every application
// change or, as #1053 shipped, ran for none of them. As a unit test against
// the committed schema snapshot it runs on every application PR, cheaply; the
// DB lane keeps what only the live database can answer, including whether the
// snapshot matches the live catalogue.
//
// The registry's application claims are the ones owners read:
//   - an EXPORTED table is read by THE EXPORT: a `.from("<table>")` in one of
//     the export modules (EXPORT_MODULES), not merely a literal anywhere in
//     app code (Photos F1: another file naming it proves nothing about the
//     archive);
//   - a reason that cites a database function ("NOT dead: reschedule_appointment_v2
//     ... (app/...)") says the application calls it, from the file it names.
// ===========================================================================

type Snapshot = { migrations: { count: number; last: string | null; sha256: string }; public: { tables: string[]; functions: string[] } };
type Source = { rel: string; code: string };

const SNAPSHOT = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8")) as Snapshot;

// The same rules the DB file used: comments stripped so prose does not count
// as use, and the registry and the hand-rolled types skipped, because naming
// every table is their whole job.
const APP_ROOTS = ["app", "lib", "components"] as const;
const NOT_A_REFERENCE = new Set(["lib/export/resource-registry.ts", "lib/types/database.ts"]);

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walkTs(full));
    else if (/\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

function stripComments(raw: string): string {
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}

function appSources(): Source[] {
  return APP_ROOTS.flatMap((root) => walkTs(root))
    .filter((rel) => !NOT_A_REFERENCE.has(rel))
    .map((rel) => ({ rel, code: stripComments(readFileSync(rel, "utf8")) }));
}

/** `symbol` used as a real string literal, not as prose. */
const uses = (code: string, symbol: string) =>
  code.includes(`"${symbol}"`) || code.includes(`'${symbol}'`) || code.includes(`\`${symbol}\``);

/** The modules that build the data export: the settings export action and the lib/export helpers it uses
 * (the registry itself is the claim, not a reader). A module that moves must be updated here; a missing one is a
 * fault, never a silent skip. */
const EXPORT_ACTION = "app/(app)/settings/data/actions.ts";
const EXPORT_MODULES = [
  EXPORT_ACTION,
  ...readdirSync("lib/export")
    .filter((f) => /\.tsx?$/.test(f) && f !== "resource-registry.ts")
    .map((f) => `lib/export/${f}`),
];

/** The code reads `table` through the query builder: `.from("table")`, any quote style. */
const readsTable = (code: string, table: string) =>
  new RegExp(String.raw`\.from\(\s*["'\`]${table}["'\`]\s*\)`).test(code);

/** Application files a reason names, e.g. app/(app)/calendar/x.ts or lib/stripe/account.ts. */
const NAMED_FILE = /\b(?:app|lib|components)\/[\w\-[\]().\/]*?\.tsx?\b/g;

function citedFunctions(reason: string, snapshot: Snapshot): string[] {
  return snapshot.public.functions.filter((fn) => new RegExp(String.raw`\b${fn}\b`).test(reason));
}

function appReferenceFaults(
  registry: Record<string, ResourceDisposition>,
  snapshot: Snapshot,
  sources: Source[],
  fileExists: (rel: string) => boolean,
  exportModules: readonly string[] = EXPORT_MODULES,
): string[] {
  const faults: string[] = [];
  const tables = new Set(snapshot.public.tables);
  const exportCode = sources.filter((s) => exportModules.includes(s.rel));
  for (const rel of exportModules) if (!fileExists(rel)) faults.push(`export module ${rel} does not exist`);
  for (const [resource, d] of Object.entries(registry)) {
    if (d.kind === "exported" && !resource.startsWith(STORAGE_RESOURCE_PREFIX)) {
      if (!tables.has(resource)) faults.push(`exported ${resource} is not a table in the schema snapshot`);
      if (!exportCode.some((s) => readsTable(s.code, resource))) {
        faults.push(`exported ${resource} is not read by the export (no .from("${resource}") in ${exportModules.join(", ")})`);
      }
    }
    if (d.kind !== "pending" && d.kind !== "excluded") continue;
    const cited = citedFunctions(d.reason, snapshot);
    if (cited.length === 0) continue;
    const mentions = [...d.reason.matchAll(NAMED_FILE)].map((m) => ({ rel: m[0], at: m.index ?? 0 }));
    const named = [...new Set(mentions.map((m) => m.rel))];
    for (const rel of named) if (!fileExists(rel)) faults.push(`${resource}: its reason names ${rel}, which does not exist`);
    for (const fn of cited) {
      // The file the prose pairs with this function: the first one named AFTER
      // it ("f (app/x.ts)", "f, g and h are invoked from lib/y.ts"). Photos F4:
      // any-of let a call move between two files one reason names.
      const at = d.reason.search(new RegExp(String.raw`\b${fn}\b`));
      const paired = mentions.find((m) => m.at > at)?.rel;
      if (!sources.some((s) => uses(s.code, fn))) faults.push(`${resource}: its reason cites ${fn}, which no application source calls`);
      else if (paired !== undefined && !sources.some((s) => s.rel === paired && uses(s.code, fn))) {
        faults.push(`${resource}: its reason pairs ${fn} with ${paired}, which does not call it`);
      }
    }
  }
  return faults;
}

describe("the export registry's application claims hold against application source", () => {
  const sources = appSources();

  it("every claim holds", () => {
    expect(appReferenceFaults(EXPORT_RESOURCE_REGISTRY, SNAPSHOT, sources, existsSync)).toEqual([]);
  });

  it("is not vacuous: real tables, real cited functions, real sources", () => {
    const exported = Object.entries(EXPORT_RESOURCE_REGISTRY).filter(
      ([r, d]) => d.kind === "exported" && !r.startsWith(STORAGE_RESOURCE_PREFIX),
    );
    expect(exported.length).toBeGreaterThan(10);
    const cited = Object.values(EXPORT_RESOURCE_REGISTRY).flatMap((d) =>
      d.kind === "pending" || d.kind === "excluded" ? citedFunctions(d.reason, SNAPSHOT) : [],
    );
    expect(cited.length, "no reason cites a function: the RPC half checks nothing").toBeGreaterThanOrEqual(7);
    expect(sources.length).toBeGreaterThan(200);
    // Moved from the DB lane's live-graph anti-vacuity: the application names
    // many database functions as RPC literals.
    expect(SNAPSHOT.public.functions.filter((fn) => sources.some((s) => uses(s.code, fn))).length).toBeGreaterThan(50);
  });

  // MUTATION CONTROLS, on fixtures, so each fault is proved to fire.
  const snapshot: Snapshot = { migrations: { count: 1, last: "x.sql", sha256: "0" }, public: { tables: ["widgets", "ledger"], functions: ["claim_ledger", "other_fn"] } };
  const registry = {
    widgets: { kind: "exported" } as unknown as ResourceDisposition,
    ledger: { kind: "pending", ticket: "T", tier: 2, reason: "LIVE: claim_ledger is invoked from lib/pay/ledger.ts." } as ResourceDisposition,
  };
  const good: Source[] = [
    { rel: "lib/export/build.ts", code: 'supabase.from("widgets")' },
    { rel: "lib/pay/ledger.ts", code: 'supabase.rpc("claim_ledger")' },
  ];
  const exists = (rel: string) => good.some((s) => s.rel === rel);
  const fixtureExport = ["lib/export/build.ts"];

  it("CONTROL: the fixture is clean", () => {
    expect(appReferenceFaults(registry, snapshot, good, exists, fixtureExport)).toEqual([]);
  });

  it("RED when the export stops reading an exported table, even though another app file still names it (Photos C)", () => {
    const sources: Source[] = [
      ...good.map((s) => (s.rel === "lib/export/build.ts" ? { ...s, code: "export {};" } : s)),
      { rel: "lib/widgets/queries.ts", code: 'supabase.from("widgets")' },
    ];
    expect(appReferenceFaults(registry, snapshot, sources, () => true, fixtureExport)).toEqual([
      'exported widgets is not read by the export (no .from("widgets") in lib/export/build.ts)',
    ]);
  });

  it("RED when the export only NAMES an exported table without reading it", () => {
    const sources = good.map((s) => (s.rel === "lib/export/build.ts" ? { ...s, code: 'const label = "widgets";' } : s));
    expect(appReferenceFaults(registry, snapshot, sources, exists, fixtureExport)).toEqual([
      'exported widgets is not read by the export (no .from("widgets") in lib/export/build.ts)',
    ]);
  });

  it("RED when an export module is gone", () => {
    expect(appReferenceFaults(registry, snapshot, good, exists, [...fixtureExport, "lib/export/moved.ts"])).toContain(
      "export module lib/export/moved.ts does not exist",
    );
  });

  it("RED when the cited RPC is no longer called (the published 'NOT dead' reason is now false)", () => {
    const sources = good.map((s) => (s.rel === "lib/pay/ledger.ts" ? { ...s, code: "export {};" } : s));
    expect(appReferenceFaults(registry, snapshot, sources, exists, fixtureExport)).toEqual([
      "ledger: its reason cites claim_ledger, which no application source calls",
    ]);
  });

  it("RED when the call moves to a file the reason does not name", () => {
    const sources: Source[] = [good[0], { rel: "lib/pay/elsewhere.ts", code: 'rpc("claim_ledger")' }];
    expect(appReferenceFaults(registry, snapshot, sources, () => true, fixtureExport)).toEqual([
      "ledger: its reason pairs claim_ledger with lib/pay/ledger.ts, which does not call it",
    ]);
  });

  it("RED when a call moves to the OTHER file the same reason names (Photos F4)", () => {
    const two = {
      ...registry,
      ledger: { kind: "pending", ticket: "T", tier: 2, reason: "LIVE: claim_ledger (lib/pay/ledger.ts) and other_fn (lib/pay/other.ts) read it." } as ResourceDisposition,
    };
    const paired: Source[] = [good[0], { rel: "lib/pay/ledger.ts", code: 'rpc("claim_ledger")' }, { rel: "lib/pay/other.ts", code: 'rpc("other_fn")' }];
    expect(appReferenceFaults(two, snapshot, paired, () => true, fixtureExport)).toEqual([]);
    const moved: Source[] = [good[0], { rel: "lib/pay/ledger.ts", code: "export {};" }, { rel: "lib/pay/other.ts", code: 'rpc("other_fn"); rpc("claim_ledger")' }];
    expect(appReferenceFaults(two, snapshot, moved, () => true, fixtureExport)).toEqual([
      "ledger: its reason pairs claim_ledger with lib/pay/ledger.ts, which does not call it",
    ]);
  });

  it("RED when the file a reason names is gone", () => {
    expect(appReferenceFaults(registry, snapshot, good, () => false, fixtureExport)).toContain("ledger: its reason names lib/pay/ledger.ts, which does not exist");
  });

  it("RED when an exported table is not in the schema snapshot", () => {
    const shrunk = { ...snapshot, public: { ...snapshot.public, tables: ["ledger"] } };
    expect(appReferenceFaults(registry, shrunk, good, exists, fixtureExport)).toEqual(["exported widgets is not a table in the schema snapshot"]);
  });

  it("a mention in a COMMENT is not a reference", () => {
    expect(uses(stripComments('// supabase.rpc("claim_ledger")\n/* "widgets" */'), "claim_ledger")).toBe(false);
  });
});

describe("the schema snapshot is fresh against supabase/migrations", () => {
  it(`${SNAPSHOT_PATH} is exactly what the generator derives (regenerate: npm run schema:snapshot -- --write)`, () => {
    expect(readFileSync(SNAPSHOT_PATH, "utf8")).toBe(serialise(buildSchemaSnapshot()));
  });

  it("RED on a new migration that was not followed by --write", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hone-schema-snapshot-"));
    try {
      for (const f of readdirSync("supabase/migrations").filter((n) => n.endsWith(".sql"))) {
        copyFileSync(join("supabase/migrations", f), join(dir, f));
      }
      const before = buildSchemaSnapshot(dir) as Snapshot;
      expect(serialise(before)).toBe(readFileSync(SNAPSHOT_PATH, "utf8"));
      writeFileSync(
        join(dir, "9999_zz_new.sql"),
        "begin;\ncreate table public.zz_new (id uuid);\ncreate or replace function public.zz_fn() returns int language sql as $$ select 1 $$;\n-- create table public.not_ddl (prose only)\ncommit;\n",
      );
      const after = buildSchemaSnapshot(dir) as Snapshot;
      expect(serialise(after)).not.toBe(readFileSync(SNAPSHOT_PATH, "utf8"));
      expect(after.migrations.sha256).not.toBe(before.migrations.sha256);
      expect(after.public.tables).toContain("zz_new");
      expect(after.public.functions).toContain("zz_fn");
      expect(after.public.tables).not.toContain("not_ddl");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Photos F2: parser shapes that occur 0 times today but would silently corrupt the snapshot.
  const parse = (...files: string[]) => {
    const dir = mkdtempSync(path.join(tmpdir(), "hone-schema-snapshot-"));
    try {
      files.forEach((sql, i) => writeFileSync(join(dir, `${String(i + 1).padStart(4, "0")}_m.sql`), sql));
      return (buildSchemaSnapshot(dir) as Snapshot).public;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("P1: a schema-qualified non-public object is excluded, never recorded under its SCHEMA name", () => {
    expect(
      parse('create table private.zz (id int);\ncreate function auth.zz_fn() returns int language sql as $$ select 1 $$;\ncreate table "extensions"."zz2" (id int);\n'),
    ).toEqual({ tables: [], functions: [] });
    expect(parse('create table public.kept (id int);\ncreate table "public"."kept2" (id int);\n').tables).toEqual(["kept", "kept2"]);
  });

  it("P2: dropping ONE overload keeps the name while another overload is live", () => {
    const fn = (sig: string) => `create or replace function public.f(${sig}) returns int language sql as $$ select 1 $$;\n`;
    expect(parse(fn("p_id integer"), fn("p_label text"), "drop function public.f(int);\n").functions).toEqual(["f"]);
    expect(parse(fn("p_id integer"), fn("p_label text"), "drop function public.f(int4);\ndrop function if exists public.f(text);\n").functions).toEqual([]);
    // Parameter names, defaults, OUT parameters and typmods are not part of the identity.
    expect(parse(fn("p_at timestamptz default now(), out n int"), "drop function public.f(timestamp with time zone);\n").functions).toEqual([]);
    expect(parse(fn("p_s varchar(10)"), "drop function public.f(character varying);\n").functions).toEqual([]);
    // A bare DROP (no argument list) names the only overload.
    expect(parse(fn("p_id integer"), "drop function public.f;\n").functions).toEqual([]);
  });

  it("P3/P6/P7: UNLOGGED tables, multi-table DROP, and renames", () => {
    expect(parse("create unlogged table public.u (id int);\n").tables).toEqual(["u"]);
    expect(parse("create temporary table t (id int);\n").tables).toEqual([]);
    expect(parse("create table a (id int); create table b (id int); create table c (id int);\n", "drop table if exists public.a, b;\n").tables).toEqual(["c"]);
    expect(parse("create table old_t (id int);\n", "alter table if exists public.old_t rename to new_t;\n").tables).toEqual(["new_t"]);
    expect(
      parse("create function public.old_f(int) returns int language sql as $$ select 1 $$;\n", "alter function public.old_f(integer) rename to new_f;\n").functions,
    ).toEqual(["new_f"]);
    // A column rename is not a table rename.
    expect(parse("create table t2 (a int);\n", "alter table t2 rename column a to b;\n").tables).toEqual(["t2"]);
  });

  it("P5: a '--' inside a string literal does not hide DDL after it", () => {
    expect(parse("select '--'; create table public.hidden (id int);\nselect 'it''s -- fine'; create table public.also (id int);\n").tables).toEqual(["also", "hidden"]);
    expect(parse("-- create table public.commented (id int);\n/* create table public.blocked (id int); */\n").tables).toEqual([]);
  });

  it("a DROP removes what an earlier migration created", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hone-schema-snapshot-"));
    try {
      writeFileSync(join(dir, "0001_a.sql"), "create table t1 (id int);\ncreate function public.f1() returns int language sql as $$ select 1 $$;\n");
      writeFileSync(join(dir, "0002_b.sql"), "drop function if exists public.f1();\ndrop table if exists public.t1;\n");
      const snap = buildSchemaSnapshot(dir) as Snapshot;
      expect(snap.public).toEqual({ tables: [], functions: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
