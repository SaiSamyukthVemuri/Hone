import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Insurance/Privacy BA1: every server action that WRITES one of the eight chart tables (directly, or through an RPC whose body writes one) asks
// clin.edit_records, or is listed in EXEMPT with the reason it is a different key or a fixed rule. A new chart writer without the gate fails here.
// A tripwire, not a proof: the 0289 triggers are the database backstop for the same eight tables. A negative control below proves the checker
// fails on a writer that lacks the gate (so a green run cannot be a checker that sees nothing).
const CHART = ["sessions", "session_blocks", "session_block_areas", "electrolysis_entries", "laser_entries", "treatment_plans", "treatment_plan_stages", "client_clinical_notes"];
const T = CHART.join("|");
const KEY = "clin.edit_records";

const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\"'`])\/\/.*$/gm, "$1");

// RPCs whose latest body writes a chart table (trigger functions excluded).
function writerRpcs(): Set<string> {
  const out = new Map<string, boolean>();
  for (const m of readdirSync("supabase/migrations").filter((n) => n.endsWith(".sql")).sort()) {
    const s = readFileSync(join("supabase/migrations", m), "utf8");
    for (const f of s.matchAll(/create\s+(?:or\s+replace\s+)?function\s+public\.(\w+)\s*\(([\s\S]*?)\$(\w*)\$([\s\S]*?)\$\3\$/gi)) {
      if (/returns\s+trigger/i.test(f[0].slice(0, f[0].indexOf("$")))) continue;
      out.set(f[1]!, new RegExp(`\\b(insert\\s+into|update|delete\\s+from)\\s+(public\\.)?(${T})\\b`, "i").test(f[4]!));
    }
  }
  return new Set([...out].filter(([, w]) => w).map(([n]) => n));
}

type Fn = { name: string; exported: boolean; body: string };
function functions(src: string): Fn[] {
  const s = strip(src);
  const starts = [...s.matchAll(/^(export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/gm)];
  return starts.map((m, i) => ({ name: m[2]!, exported: !!m[1], body: s.slice(m.index!, starts[i + 1]?.index ?? s.length) }));
}
const hasKey = (body: string) => new RegExp(`requirePermission\\s*\\([\\s\\S]{0,300}?["']${KEY.replace(".", "\\.")}["']`).test(body);

export function ungatedChartWriters(file: string, src: string, rpcs: Set<string>): string[] {
  const fns = functions(src);
  const gateHelpers = fns.filter((f) => hasKey(f.body)).map((f) => f.name);
  const direct = new RegExp(`\\.from\\(\\s*["'\`](${T})["'\`]\\s*\\)\\s*\\.(insert|update|upsert|delete)\\b`);
  const rpcCall = [...rpcs].length ? new RegExp(`\\.rpc\\(\\s*["'](${[...rpcs].join("|")})["']`) : null;
  return fns
    .filter((f) => f.exported)
    .filter((f) => direct.test(f.body) || (rpcCall?.test(f.body) ?? false) || fns.some((h) => h.name !== f.name && !h.exported && f.body.includes(`${h.name}(`) && (direct.test(h.body) || (rpcCall?.test(h.body) ?? false))))
    .filter((f) => !hasKey(f.body) && !gateHelpers.some((h) => h !== f.name && f.body.includes(`${h}(`)))
    .map((f) => `${file}::${f.name}`);
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (n === "node_modules" || n === ".next") return [];
    return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(n) ? [p] : [];
  });
}

// Chart writers that are NOT clin.edit_records actions, each with the key or rule that governs it.
const EXEMPT: Record<string, string> = {
  "app/(app)/clients/[id]/sessions/[sessionId]/actions.ts::updateSessionPriceAction":
    "set_session_price writes only price_paid_cents: pricing/payment is its own key (not_yet), outside the edit guard and out of revision images (0289, AC-5)",
};

describe("negative control: the checker fails a chart writer that lacks the gate", () => {
  const rpcs = new Set(["soft_delete_session"]);
  it("flags a direct writer with no gate", () => {
    const src = `export async function addNote() { const db = await createClient(); await db.from("client_clinical_notes").insert({ a: 1 }); }`;
    expect(ungatedChartWriters("x.ts", src, rpcs)).toEqual(["x.ts::addNote"]);
  });
  it("flags an RPC writer with no gate", () => {
    const src = `export async function drop() { await db.rpc("soft_delete_session", {}); }`;
    expect(ungatedChartWriters("x.ts", src, rpcs)).toEqual(["x.ts::drop"]);
  });
  it("passes a gated writer, a writer behind a gate helper, and a gate written in a comment does not count", () => {
    expect(ungatedChartWriters("x.ts", `export async function a() { await requirePermission(db, s, "clin.edit_records", {}); await db.from("sessions").update({}); }`, rpcs)).toEqual([]);
    expect(ungatedChartWriters("x.ts", `async function gate() { return requirePermission(db, s, "clin.edit_records", {}); }\nexport async function b() { await gate(); await db.from("sessions").delete(); }`, rpcs)).toEqual([]);
    expect(ungatedChartWriters("x.ts", `export async function c() { // requirePermission(db, s, "clin.edit_records")\n await db.from("sessions").update({}); }`, rpcs)).toEqual(["x.ts::c"]);
  });
  it("ignores a read and a non-chart table", () => {
    expect(ungatedChartWriters("x.ts", `export async function r() { await db.from("sessions").select("id"); await db.from("clients").update({}); }`, rpcs)).toEqual([]);
  });
});

describe("every chart-table writer in the app asks clin.edit_records or is classified", () => {
  const rpcs = writerRpcs();
  it("finds the writer RPCs (sanity: the derivation is not empty)", () => {
    expect(rpcs.size).toBeGreaterThan(10);
  });
  const found = walk("app").flatMap((f) => ungatedChartWriters(f, readFileSync(f, "utf8"), rpcs));
  it("has no unclassified, ungated chart writer", () => {
    expect(found.filter((x) => !(x in EXEMPT)), "ungated chart writers; gate them or classify in EXEMPT with the key/rule that governs them").toEqual([]);
  });
  it("EXEMPT has no stale row", () => {
    expect(Object.keys(EXEMPT).filter((x) => !found.includes(x))).toEqual([]);
  });
});
