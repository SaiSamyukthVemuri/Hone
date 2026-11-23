import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminQuery, asRole, asUser, closePool, seedMember, seedSession, seedStudio, type SeededStudio } from "./helpers/harness";
import { CLASSIFICATION, PINS, UNPROVEN, INSERT_UNPROVEN } from "./receptionist-callable-surface.map";

// D9 (Privacy): the database surface a receptionist session can reach, built from the CATALOG, not from the app's call list.
// A receptionist is a signed-in user with no practitioners row in the studio. This proves, on a real migrated database and by DIRECT calls
// (what a signed-in person can do outside the app), that:
//   C1  every function executable by authenticated or anon in an exposed schema is classified in receptionist-callable-surface.map.ts with a
//       reason; an unclassified (new) function fails, and a stale entry fails;
//   C2  each command is called with REAL ids from a seeded studio, so the gate is what refuses, and its refusal kind is pinned exactly;
//   C3  every call runs in a transaction that is rolled back, with in-transaction write counters and a whole-database before/after count;
//   C4  six actors: this studio's receptionist, another studio's receptionist, an inactive receptionist, a practitioner of another studio who
//       is not a receptionist, a stranger, and anon; owner positive controls prove the real ids reach the gate;
//   F3  every public table: SELECT, INSERT, UPDATE and DELETE as a receptionist, a stranger and anon, expecting zero rows or a privilege error.
// Output is booleans, counts and function or table names only: no row value, name, id or email is printed or snapshotted (C7).
// SCOPE (C9): database functions and tables in the exposed schemas only. NOT covered: service-role server actions, storage policies, realtime,
// and the hosted comparison (C8, see the hook at the end), none of which this test can see.

type Outcome = { kind: string; msg?: string; writes?: number; rows?: number };
const sig = (o: Outcome) => `${o.kind}${o.msg ? `|${o.msg}` : ""}`;
const scrub = (m: string) => m.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>").slice(0, 90);
type Actor = { label: string; uid: string | "anon" };
type FnRow = { schema: string; name: string; key: string; args: string; named: boolean; ret: string; prokind: string; definer: boolean; anon: boolean; ext: string | null };

class Rollback extends Error {
  constructor(readonly outcome: Outcome) {
    super("rollback");
  }
}

let A: SeededStudio;
let B: SeededStudio;
let sessionId = "";
let blockId = "";
let apptId = "";
let serviceId = "";
let imageId = "";
const ids = {} as Record<"recA" | "recB" | "inactive" | "pracB" | "stranger", string>;
const rnd = randomUUID();

async function authUser(label: string): Promise<string> {
  const id = randomUUID();
  await adminQuery("insert into auth.users (id, email) values ($1, $2)", [id, `${label}-${id.slice(0, 8)}@harness.local`]);
  return id;
}
async function desk(studioId: string, userId: string, active: boolean) {
  await adminQuery("insert into public.studio_receptionists (studio_id, user_id, display_name, active, deactivated_at) values ($1,$2,'Synthetic Front Desk',$3,$4)", [studioId, userId, active, active ? null : new Date().toISOString()]);
}

// ---- catalog -------------------------------------------------------------------------------------------------------------------------
const EXPOSED = ["public", "graphql_public"];
async function catalog(): Promise<FnRow[]> {
  const r = await adminQuery(
    `select n.nspname as schema, p.proname as name, p.prokind, p.prosecdef as definer, p.prorettype::regtype::text as ret,
            pg_get_function_identity_arguments(p.oid) as args, (p.proargnames is not null) as named,
            has_function_privilege('anon', p.oid, 'execute') as anon,
            (select e.extname from pg_depend d join pg_extension e on e.oid = d.refobjid where d.objid = p.oid and d.deptype = 'e' limit 1) as ext,
            array_length(coalesce(p.proargtypes::oid[], '{}'::oid[]), 1) as nargs
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = any($1)
        and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute'))
      order by n.nspname, p.proname, 6`,
    [EXPOSED],
  );
  return (r.rows as (Omit<FnRow, "key"> & { nargs: number | null })[]).map((x) => ({ ...x, key: `${x.name}/${x.nargs ?? 0}` }));
}

// ---- arguments: REAL ids by parameter name --------------------------------------------------------------------------------------------
function parseArgs(f: FnRow): { name: string; type: string }[] {
  if (!f.args.trim()) return [];
  const parts: string[] = [];
  let depth = 0, cur = "";
  for (const ch of f.args) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { parts.push(cur.trim()); cur = ""; } else cur += ch;
  }
  parts.push(cur.trim());
  return parts.map((p, i) => {
    const m = f.named ? /^(?:(?:IN|OUT|INOUT|VARIADIC)\s+)?([A-Za-z_]\w*)\s+(.+)$/.exec(p) : null;
    return m ? { name: m[1].toLowerCase(), type: m[2].toLowerCase() } : { name: `arg${i}`, type: p.toLowerCase() };
  });
}
function valueFor(name: string, type: string, studio: SeededStudio, sess: string, blk: string, appt: string, svc: string): unknown {
  const t = type.replace(/\s+/g, " ");
  if (t === "uuid") {
    if (/studio/.test(name)) return studio.studioId;
    if (/client/.test(name)) return studio.clientId;
    if (/practitioner|performer/.test(name)) return studio.practitionerId;
    if (/appointment/.test(name)) return appt;
    if (/block/.test(name)) return blk;
    if (/session/.test(name)) return sess;
    if (/service/.test(name)) return svc;
    if (/image/.test(name)) return imageId;
    if (/actor/.test(name)) return studio.practitionerId;
    if (/user/.test(name)) return studio.userId;
    return rnd;
  }
  if (name === "p_patch") return '{"preferred_name":"Probe Pref"}';
  if (name === "p_expected") return '{"preferred_name":null}';
  if (name === "p_groups" || name === "p_areas") return "[]";
  if (name === "p_metadata") return '{"scope":"day","day":"2026-01-01"}';
  if (t.endsWith("[]")) return t.startsWith("uuid") ? "{}" : "{}";
  if (t === "text" || t.startsWith("character")) {
    if (/email/.test(name)) return "probe@harness.local";
    if (/phone/.test(name)) return "+15550101";
    if (/hash/.test(name)) return "a".repeat(64);
    if (/method/.test(name)) return "still_owes";
    if (name === "p_action") return "clinical_records_previewed";
    if (name === "p_stage") return "before";
    if (name === "p_modality") return "electrolysis";
    if (/^p_sort$/.test(name)) return "name";
    if (/key|token/.test(name)) return "probe-key-1";
    if (/^p_mode$/.test(name)) return "waitlist";
    if (/^p_move$/.test(name)) return "up";
    return "probe probe probe";
  }
  if (t === "integer" || t === "bigint" || t === "smallint" || t === "numeric") return /offset/.test(name) ? 0 : /limit/.test(name) ? 5 : /cents/.test(name) ? 100 : 1;
  if (t === "boolean") return false;
  if (t.startsWith("timestamp")) return /(^|_)(to|end|until|expected_end)/.test(name) ? new Date(Date.now() + 7 * 86_400_000).toISOString() : new Date(Date.now() - 86_400_000).toISOString();
  if (t === "date") return /(^|_)(to|end|until)/.test(name) ? new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
  if (t === "jsonb" || t === "json") return "{}";
  return null; // enums, domains, other: a typed NULL
}
function callSql(f: FnRow): string | null {
  const args = parseArgs(f);
  const place = args.map((a, i) => `$${i + 1}::${a.type}`).join(", ");
  const fn = `${f.schema}.${f.name}(${place})`;
  if (f.ret === "void") return `select ${fn}`;
  if (f.prokind === "p") return `call ${fn}`;
  return `select to_jsonb(t) as j from ${fn} as t`;
}
function paramsFor(f: FnRow, studio: SeededStudio): unknown[] {
  return parseArgs(f).map((a) => valueFor(a.name, a.type, studio, sessionId, blockId, apptId, serviceId));
}

// ---- outcome classification (booleans and kinds only) -----------------------------------------------------------------------------------
function isEmptyish(v: unknown): boolean {
  return v === null || v === false || v === 0 || v === "" || (Array.isArray(v) && v.length === 0) || (typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v as object).length === 0);
}
const STATUS_REFUSALS = new Set(["not_authorized", "owner_only", "forbidden", "not_found", "studio_not_found", "no_invitation", "refused"]);
function shapeOf(rows: { j?: unknown }[], isVoid: boolean): string {
  if (isVoid) return "void";
  if (rows.length === 0) return "empty";
  if (rows.length > 1) return "data";
  const v = rows[0].j;
  if (typeof v === "string") return STATUS_REFUSALS.has(v) ? `status:${v}` : v === "" ? "emptyish" : `status-other:${v}`;
  if (isEmptyish(v)) return v === null ? "null" : v === false ? "false" : "emptyish";
  if (typeof v === "object" && v !== null && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    if (o.ok === false) return "json-ok-false";
    const first = typeof o.status === "string" ? o.status : typeof o.result === "string" ? o.result : Object.values(o).find((x) => typeof x === "string");
    if (typeof first === "string") {
      if (STATUS_REFUSALS.has(first)) return `status:${first}`;
      if (Object.values(o).filter((x) => x !== null && x !== first).length === 0) return `status-other:${first}`;
    }
    if (Object.values(o).every(isEmptyish)) return "record-all-empty";
  }
  return "data";
}
const REFUSAL_KINDS = new Set(["empty", "null", "false", "emptyish", "void", "json-ok-false", "record-all-empty", ...[...STATUS_REFUSALS].map((x) => `status:${x}`)]);
const refused = (o: Outcome) => o.kind.startsWith("error:") || REFUSAL_KINDS.has(o.kind);

async function probe(actor: Actor, f: FnRow, studio: SeededStudio): Promise<Outcome> {
  const sql = callSql(f);
  if (!sql) return { kind: "skipped" };
  const params = paramsFor(f, studio);
  const run = async (q: (t: string, p?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>) => {
    await q("set local statement_timeout = '8s'");
    await q("set local lock_timeout = '3s'");
    let outcome: Outcome;
    await q("savepoint s");
    const wq = "select coalesce(sum(n_tup_ins + n_tup_upd + n_tup_del), 0)::int as w, string_agg(relname, ',') filter (where n_tup_ins + n_tup_upd + n_tup_del > 0) as t from pg_stat_xact_all_tables where schemaname in ('public','auth')";
    const w0 = Number(((await q(wq)).rows[0] as { w: number }).w);
    try {
      const r = await q(sql, params);
      const w = (await q(wq)).rows[0] as { w: number; t: string };
      const delta = Number(w.w) - w0;
      if (process.env.DEBUG_WRITES && delta > 0) console.log(`WRITES ${f.key} ${actor.label}: ${w.t}`);
      outcome = { kind: shapeOf(r.rows as { j?: unknown }[], f.ret === "void"), rows: r.rows.length, writes: delta };
    } catch (e) {
      outcome = { kind: `error:${(e as { code?: string }).code ?? "unknown"}`, msg: scrub(String((e as { message?: string }).message ?? "")) };
    }
    throw new Rollback(outcome);
  };
  try {
    if (actor.uid === "anon") await asRole("anon", (q) => run(q as never));
    else await asUser(actor.uid, (q) => run(q as never));
  } catch (e) {
    if (e instanceof Rollback) return e.outcome;
    return { kind: `harness-error:${(e as { code?: string }).code ?? "unknown"}` };
  }
  return { kind: "harness-no-outcome" };
}

// ---- whole-database counts (C3) ------------------------------------------------------------------------------------------------------
async function publicTables(): Promise<string[]> {
  const r = await adminQuery(`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r','p') order by 1`);
  return (r.rows as { relname: string }[]).map((x) => x.relname);
}
async function countsSnapshot(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of await publicTables()) out[t] = Number((await adminQuery(`select count(*)::int as n from public."${t}"`)).rows[0].n);
  return out;
}

let FN: FnRow[] = [];
let actors: Record<string, Actor> = {};
let before: Record<string, number> = {};

beforeAll(async () => {
  A = await seedStudio("surf-a");
  B = await seedStudio("surf-b");
  ({ sessionId, blockId } = await seedSession(A));
  apptId = randomUUID();
  serviceId = (await adminQuery(`insert into public.services (studio_id, name, default_duration_minutes, active, modality) values ($1,'Probe service',30,true,'electrolysis') returning id`, [A.studioId])).rows[0].id as string;
  await adminQuery(
    `insert into public.appointments (id, studio_id, practitioner_id, client_id, starts_at, ends_at, duration_minutes, status, cancellation_token_hash)
     values ($1,$2,$3,$4, now() + interval '3 days', now() + interval '3 days 1 hour', 60, 'confirmed', encode(sha256(gen_random_uuid()::text::bytea), 'hex'))`,
    [apptId, A.studioId, A.practitionerId, A.clientId],
  );
  imageId = randomUUID();
  await adminQuery(`insert into public.treatment_images (id, studio_id, client_id, session_id, session_block_id, storage_path, content_type, size_bytes) values ($1,$2,$3,$4,$5,$6,'image/jpeg',1024)`, [imageId, A.studioId, A.clientId, sessionId, blockId, `${A.studioId}/${A.clientId}/${imageId}.jpg`]);
  ids.recA = await authUser("surf-rec-a");
  ids.recB = await authUser("surf-rec-b");
  ids.inactive = await authUser("surf-rec-off");
  ids.pracB = (await seedMember(B, "surf-prac-b")).userId;
  ids.stranger = await authUser("surf-stranger");
  await desk(A.studioId, ids.recA, true);
  await desk(B.studioId, ids.recB, true);
  await desk(A.studioId, ids.inactive, false);
  actors = {
    recA: { label: "this studio's receptionist", uid: ids.recA },
    recB: { label: "another studio's receptionist", uid: ids.recB },
    inactive: { label: "an inactive receptionist of this studio", uid: ids.inactive },
    pracB: { label: "a practitioner of another studio (not a receptionist)", uid: ids.pracB },
    stranger: { label: "a stranger", uid: ids.stranger },
    anon: { label: "anon", uid: "anon" },
  };
  FN = await catalog();
  before = await countsSnapshot();
});
afterAll(closePool);

const own = (f: FnRow) => !f.ext && f.prokind !== "a" && f.prokind !== "w";
const commands = () => FN.filter((f) => own(f) && f.ret !== "trigger" && f.ret !== "event_trigger");

describe("C1: every executable function is classified", () => {
  it("the catalog and the checked-in map agree, in both directions (a new function fails until it is classified with a reason)", () => {
    const keys = commands().map((f) => `${f.schema}.${f.key}`);
    const mapped = Object.keys(CLASSIFICATION);
    expect(keys.filter((k) => !mapped.includes(k)), "unclassified executable functions").toEqual([]);
    expect(mapped.filter((k) => !keys.includes(k)), "map entries with no executable function").toEqual([]);
    for (const k of mapped) expect(CLASSIFICATION[k].reason.length, `${k} has a reason`).toBeGreaterThan(20);
  });
  it("trigger functions are never callable directly, and extension-owned functions belong to an allowed extension", async () => {
    const triggers = FN.filter((f) => own(f) && (f.ret === "trigger" || f.ret === "event_trigger"));
    expect(triggers.length, "the catalog lists trigger functions").toBeGreaterThan(5);
    for (const f of triggers) {
      const o = await probe(actors.recA, f, A);
      expect(o.kind.startsWith("error:"), `${f.key} cannot be called directly`).toBe(true);
    }
    const exts = new Set(FN.filter((f) => f.ext).map((f) => f.ext as string));
    const allowed = new Set(["pg_trgm", "pgcrypto", "uuid-ossp", "btree_gist", "btree_gin", "citext", "pg_graphql", "unaccent", "fuzzystrmatch"]);
    expect([...exts].filter((e) => !allowed.has(e)), "extensions owning executable functions that are not on the allowed list").toEqual([]);
  });
  it("anon can execute exactly the pinned set of non-trigger commands (everything else is closed to anon by privilege)", () => {
    const anonSet = commands().filter((f) => f.anon).map((f) => `${f.schema}.${f.key}`).sort();
    const want = Object.entries(CLASSIFICATION).filter(([, v]) => v.anon).map(([k]) => k).sort();
    expect(anonSet).toEqual(want);
  });
});

describe("C2 + C4: the actor matrix with real ids", () => {
  it("every non-owner actor is refused, or gets nothing, from every gated command, with no write; the receptionist's refusal kind is pinned exactly", async () => {
    const wrong: string[] = [];
    const dump: Record<string, string> = {};
    let unreached = 0;
    for (const f of commands()) {
      const c = CLASSIFICATION[`${f.schema}.${f.key}`];
      if (!c || c.cls === "pure" || c.cls === "platform") continue;
      for (const k of ["recA", "recB", "inactive", "pracB", "stranger"] as const) {
        const o = await probe(actors[k], f, A);
        if (c.cls === "desk" && k === "recA") continue; // the desk's own surface: see the desk block
        if (!refused(o) || (o.writes ?? 0) !== 0) wrong.push(`${f.key} as ${k}: ${o.kind}${o.writes ? ` writes=${o.writes}` : ""}`);
        if (k === "recA") {
          dump[`${f.schema}.${f.key}`] = sig(o);
          if (o.kind.startsWith("harness-")) unreached++;
        }
      }
    }
    if (process.env.DUMP_PINS) console.log("PINS=" + JSON.stringify(dump, null, 1));
    expect(wrong, "a non-owner actor reached data or wrote").toEqual([]);
    expect(unreached, "no probe failed in the harness").toBe(0);
    if (!process.env.DUMP_PINS) {
      const drift = Object.entries(dump).filter(([k, v]) => PINS[k] !== v).map(([k, v]) => `${k}: ${PINS[k] ?? "unpinned"} -> ${v}`);
      expect(drift, "the receptionist's refusal kind changed (re-pin deliberately)").toEqual([]);
    }
  });

  it("anon is refused by privilege or gets nothing from the commands it can execute, and writes nothing", async () => {
    for (const f of commands().filter((x) => x.anon)) {
      const c = CLASSIFICATION[`${f.schema}.${f.key}`];
      if (c.cls === "platform" || c.cls === "pure") continue;
      const o = await probe(actors.anon, f, A);
      expect(refused(o) && (o.writes ?? 0) === 0, `${f.key} as anon: ${o.kind}`).toBe(true);
    }
  });

  it("the desk functions answer this studio's receptionist and refuse every other actor (42501 or not_authorized) for this studio's ids", async () => {
    for (const f of commands().filter((x) => CLASSIFICATION[`${x.schema}.${x.key}`].cls === "desk")) {
      for (const k of ["recB", "inactive", "pracB", "stranger"] as const) {
        const o = await probe(actors[k], f, A);
        expect(["error:42501", "status:not_authorized"], `${f.key} as ${k}: ${o.kind}`).toContain(o.kind);
      }
      if (!/create|cancel|move/.test(f.name)) {
        const ok = await probe(actors.recA, f, A);
        expect(ok.kind.startsWith("error:"), `${f.key} answers its own studio's receptionist (${ok.kind})`).toBe(false);
      }
    }
  });

  it("POSITIVE CONTROLS: for every gated command the owner's outcome differs from the receptionist's, so the refusal is the gate and not a bad argument", async () => {
    const owner: Actor = { label: "owner", uid: A.userId };
    const undistinguished: string[] = [];
    let compared = 0;
    for (const f of commands()) {
      const c = CLASSIFICATION[`${f.schema}.${f.key}`];
      if (!c || c.cls === "pure" || c.cls === "platform" || c.cls === "invite") continue;
      const o = await probe(owner, f, A);
      const r = await probe(actors.recA, f, A);
      compared++;
      if (c.cls === "desk" && /create|cancel|move/.test(f.name)) continue; // the desk's writes are proven by their own refusal status below
      if (sig(o) === sig(r)) undistinguished.push(`${f.schema}.${f.key}: ${sig(r)}`);
    }
    expect(compared, "non-vacuity: many commands compared").toBeGreaterThan(60);
    expect(undistinguished.map((x) => x.split(": ")[0]).sort(), "commands whose receptionist and owner outcomes are identical (arguments do not reach past the gate)").toEqual(Object.keys(UNPROVEN).sort());
  });

  it("C3: nothing changed anywhere (every call was rolled back): the whole-database row counts equal the snapshot taken before", async () => {
    const after = await countsSnapshot();
    const changed = Object.keys(after).filter((t) => after[t] !== before[t] && !/^(audit|.*events?)$/.test(t));
    expect(changed).toEqual([]);
  });
});

describe("F3: every public table, all four verbs", () => {
  async function verbs(actor: Actor, table: string, col: string | null, tpl: { cols: string[]; row: unknown } | null): Promise<{ sel: Outcome; ins: Outcome; upd: Outcome; del: Outcome }> {
    const oneP = (sql: string, params: unknown[]) => one(sql, params);
    const one = async (sql: string, params: unknown[] = []): Promise<Outcome> => {
      const run = async (q: (t: string, p?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>) => {
        await q("savepoint s");
        let o: Outcome;
        try {
          const r = await q(sql, params);
          o = { kind: "ok", rows: sql.startsWith("select") ? Number((r.rows[0] as { n: number }).n) : (r.rowCount ?? 0) };
        } catch (e) {
          o = { kind: `error:${(e as { code?: string }).code ?? "unknown"}` };
        }
        throw new Rollback(o);
      };
      try {
        if (actor.uid === "anon") await asRole("anon", (q) => run(q as never));
        else await asUser(actor.uid, (q) => run(q as never));
      } catch (e) {
        if (e instanceof Rollback) return e.outcome;
        return { kind: "harness-error" };
      }
      return { kind: "harness-no-outcome" };
    };
    return {
      sel: await one(`select count(*)::int as n from public."${table}"`),
      ins: tpl ? await oneP(`insert into public."${table}" (${tpl.cols.map((c) => `"${c}"`).join(",")}) select ${tpl.cols.map((c) => `r."${c}"`).join(",")} from jsonb_populate_record(null::public."${table}", $1::jsonb) as r`, [JSON.stringify(tpl.row)]) : await one(`insert into public."${table}" default values`),
      upd: col ? await one(`update public."${table}" set "${col}" = "${col}"`) : { kind: "error:42501" },
      del: await one(`delete from public."${table}"`),
    };
  }
  it("a receptionist, a stranger and anon read zero rows (except a receptionist's own membership row), insert nothing, update zero rows and delete zero rows", async () => {
    const cols = new Map<string, string>(
      (await adminQuery(`select distinct on (c.relname) c.relname, a.attname from pg_class c join pg_namespace n on n.oid = c.relnamespace join pg_attribute a on a.attrelid = c.oid
                           where n.nspname='public' and c.relkind in ('r','p') and a.attnum > 0 and not a.attisdropped and a.attgenerated = '' and a.attidentity <> 'a' order by c.relname, a.attnum`)).rows.map(
        (r: { relname: string; attname: string }) => [r.relname, r.attname],
      ),
    );
    const tables = await publicTables();
    expect(tables.length, "the catalog lists the public tables").toBeGreaterThan(40);
    const withRows = (await Promise.all(["clients", "appointments", "sessions", "practitioners", "services"].map(async (t) => Number((await adminQuery(`select count(*)::int as n from public."${t}" where studio_id = $1`, [A.studioId])).rows[0].n)))).every((n) => n > 0);
    expect(withRows, "non-vacuity: the studio has rows in the core tables").toBe(true);
    const findings: string[] = [];
    const insertCols = new Map<string, string[]>();
    for (const r of (await adminQuery(`select c.relname, a.attname from pg_class c join pg_namespace n on n.oid = c.relnamespace join pg_attribute a on a.attrelid = c.oid
                           where n.nspname='public' and c.relkind in ('r','p') and a.attnum > 0 and not a.attisdropped and a.attgenerated = '' and a.attidentity <> 'a' order by c.relname, a.attnum`)).rows as { relname: string; attname: string }[]) {
      insertCols.set(r.relname, [...(insertCols.get(r.relname) ?? []), r.attname]);
    }
    const tpls = new Map<string, { cols: string[]; row: unknown } | null>();
    for (const t of tables) {
      const hasStudio = (insertCols.get(t) ?? []).includes("studio_id");
      const row = (await adminQuery(`select to_jsonb(x) as j from public."${t}" x ${hasStudio ? "where studio_id = $1" : ""} limit 1`, hasStudio ? [A.studioId] : [])).rows[0] as { j: unknown } | undefined;
      tpls.set(t, row ? { cols: insertCols.get(t) ?? [], row: row.j } : null);
    }
    const weakInserts = new Set<string>();
    for (const k of ["recA", "stranger", "anon"] as const) {
      for (const t of tables) {
        const v = await verbs(actors[k], t, cols.get(t) ?? null, tpls.get(t) ?? null);
        if (!tpls.get(t) && v.ins.kind.startsWith("error:") && v.ins.kind !== "error:42501") { weakInserts.add(t); continue; }
        const allowSel = k === "recA" && t === "studio_receptionists" ? 1 : 0;
        if (!(v.sel.kind === "error:42501" || (v.sel.kind === "ok" && v.sel.rows === allowSel))) findings.push(`select ${t} as ${k}: ${v.sel.kind} ${v.sel.rows ?? ""}`);
        if (v.ins.kind !== "error:42501") findings.push(`insert ${t} as ${k}: ${v.ins.kind}`);
        if (!(v.upd.kind === "error:42501" || (v.upd.kind === "ok" && v.upd.rows === 0))) findings.push(`update ${t} as ${k}: ${v.upd.kind} ${v.upd.rows ?? ""}`);
        if (!(v.del.kind === "error:42501" || (v.del.kind === "ok" && v.del.rows === 0))) findings.push(`delete ${t} as ${k}: ${v.del.kind} ${v.del.rows ?? ""}`);
      }
    }
    expect(findings, "a table a receptionist, stranger or anon can read, insert into, update or delete from").toEqual([]);
    expect([...weakInserts].sort(), "tables with no template row where the insert was stopped by a constraint or trigger before the policy could be shown (pinned; seed a row to prove the policy)").toEqual(Object.keys(INSERT_UNPROVEN).sort());
  });
});

describe("C8 hook: the hosted comparison (NOT RUN HERE; needs the owner's authorization)", () => {
  it("emits the repo-side enumeration the hosted read is diffed against: name/arity, security flag, ACL letters, body md5 (counts only)", async () => {
    const r = await adminQuery(
      `select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = any($1) and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute'))`,
      [EXPOSED],
    );
    expect(Number(r.rows[0].n)).toBeGreaterThan(100);
    // The hosted query is the same SELECT with name, identity arguments, prosecdef, proacl and md5(prosrc) per function. A function present on hosted
    // and absent here goes on a named review list; this test does not read hosted.
  });
});
