import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import {
  adminQuery,
  asUser,
  closePool,
  seedMember,
  seedStudio,
  type SeededStudio,
} from "./helpers/harness";

// NO-STUDIO USER SURFACE CENSUS (Insurance U-2, 7 Nov).
//
// WHY: the tracked supabase/config.toml has enable_signup = true. If hosted
// matches, ANY person can create an auth user with the public anon key,
// independent of any signup page. The invite-only guarantee therefore rests on
// the database, not on closing signups. This file measures what an AUTHENTICATED
// USER WITH NO STUDIO (an auth.users row, no practitioner, no receptionist row,
// no invitation) can actually reach, and lists every reachable item.
//
// It changes no product code and writes nothing durable (every probe is rolled
// back to a savepoint). Synthetic ids only.
//
// MODES
//   HONE_CENSUS_REPORT=1  write the full census to HONE_CENSUS_OUT (JSON) and
//                         print it; the pin assertion is skipped. Use this to
//                         record or refresh the reachable set.
//   default               also asserts the reachable set equals PINNED below,
//                         so a NEW reachable item fails and names itself.
//
// WHAT "REACHABLE" MEANS HERE
//   function  executes without error as the stranger with fixture arguments
//             (arguments are built from real fixture ids, so a function that
//             needs membership reaches its gate and errors).
//   table     the stranger can SELECT/INSERT/UPDATE/DELETE at least one
//             statement without an RLS or privilege error. A SELECT that
//             returns zero rows still counts as "reachable, empty": the privilege
//             and policy let the statement run, and a later data change could
//             make it return rows.
//   policy    a policy on a table granted to authenticated whose expression
//             does not call a membership/ownership/uid check.
//   storage   buckets and storage.objects policies applicable to authenticated.

type J = Record<string, any>;
let A: SeededStudio; // a real studio, so membership-gated functions reach their gate
let M: { userId: string; practitionerId: string }; // member control
let S: string; // the no-studio stranger
const real: J = {};

async function newUser(label: string): Promise<string> {
  const id = randomUUID();
  await adminQuery("insert into auth.users (id,email) values ($1,$2)", [id, `${label}-${id.slice(0, 8)}@harness.local`]);
  return id;
}

async function outcome(q: (t: string, p?: unknown[]) => Promise<any>, sql: string): Promise<string> {
  await q("savepoint probe");
  try {
    const r = await q(sql);
    await q("rollback to savepoint probe");
    return "ok:" + JSON.stringify(r.rows ?? []).slice(0, 300) + ":" + (r.rowCount ?? "");
  } catch (e) {
    await q("rollback to savepoint probe");
    return "err:" + ((e as { code?: string }).code ?? "?");
  }
}

async function asJwt<T>(userId: string, fn: (q: (t: string, p?: unknown[]) => Promise<any>) => Promise<T>): Promise<T> {
  // asUser commits; we only ever run savepoint-rolled-back probes inside it.
  return asUser(userId, (q) => fn(q as any));
}

beforeAll(async () => {
  A = await seedStudio("nsu");
  M = await seedMember(A, "nsu-m");
  S = await newUser("nsu-stranger");
  real.studio = A.studioId;
  real.client = A.clientId;
  real.practitioner = A.practitionerId;
});
afterAll(async () => {
  await closePool();
});

// ---------------------------------------------------------------------------
// 1) FUNCTIONS
// ---------------------------------------------------------------------------
async function functionCensus() {
  const fns = (
    await adminQuery(
      `select n.nspname sch, p.oid::int8 oid, p.proname, pg_get_function_identity_arguments(p.oid) a,
              p.proargnames names, p.proargtypes::oid[] types, p.prosecdef secdef,
              pg_get_function_result(p.oid) res, p.prosrc src
         from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where p.prokind='f'
          and n.nspname in ('public','storage','graphql_public','extensions','realtime')
          and has_function_privilege('authenticated',p.oid,'EXECUTE')
          and not exists (select 1 from pg_depend d where d.objid=p.oid and d.deptype='e')
        order by 1,3,4`,
    )
  ).rows;
  const typeName = async (oid: number) => (await adminQuery("select format_type($1,null) t", [oid])).rows[0].t as string;
  const arg = (name: string, type: string): string => {
    const n = (name ?? "").toLowerCase();
    if (type === "uuid")
      return `'${n.includes("studio") ? real.studio : n.includes("client") ? real.client : n.includes("practitioner") || n.includes("performer") ? real.practitioner : randomUUID()}'::uuid`;
    if (type === "text") return "'x'";
    if (["integer", "smallint", "bigint"].includes(type)) return "1";
    if (type === "boolean") return "true";
    if (type === "jsonb") return "'{}'::jsonb";
    return "null";
  };
  const rows: J[] = [];
  for (const f of fns) {
    if (f.res === "trigger") continue;
    const names: string[] = f.names ?? [];
    const argSql: string[] = [];
    for (let i = 0; i < f.types.length; i++) {
      const t = await typeName(f.types[i]);
      argSql.push(`${arg(names[i] ?? "", t)}::${t}`);
    }
    const sql = `select ${f.sch}.${f.proname}(${argSql.join(",")}) r`;
    const stranger = await asJwt(S, (q) => outcome(q, sql));
    const member = await asJwt(M.userId, (q) => outcome(q, sql));
    const src: string = f.src ?? "";
    // Heuristic for "body checks identity or membership"; a SIGNAL for review, not proof.
    const checksIdentity = /auth\.uid\(\)|is_studio_member|is_studio_owner|request\.jwt|current_setting\(/.test(src);
    rows.push({
      fn: `${f.sch}.${f.proname}(${f.a})`.slice(0, 140),
      secdef: f.secdef,
      strangerOk: stranger.startsWith("ok:"),
      strangerOutcome: stranger.slice(0, 160),
      memberDiffers: member !== stranger,
      bodyChecksIdentity: checksIdentity,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// 2) TABLES + POLICIES
// ---------------------------------------------------------------------------
async function tableCensus() {
  const tables = (
    await adminQuery(
      `select n.nspname sch, c.relname t, c.relrowsecurity rls, c.relforcerowsecurity frls,
              has_table_privilege('authenticated', c.oid, 'SELECT') s,
              has_table_privilege('authenticated', c.oid, 'INSERT') i,
              has_table_privilege('authenticated', c.oid, 'UPDATE') u,
              has_table_privilege('authenticated', c.oid, 'DELETE') d
         from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where c.relkind in ('r','p','v','m') and n.nspname in ('public','storage')
          and (has_table_privilege('authenticated', c.oid, 'SELECT') or has_table_privilege('authenticated', c.oid, 'INSERT')
               or has_table_privilege('authenticated', c.oid, 'UPDATE') or has_table_privilege('authenticated', c.oid, 'DELETE'))
        order by 1,2`,
    )
  ).rows;
  const out: J[] = [];
  for (const t of tables) {
    const fq = `${t.sch}.${t.t}`;
    const pol = (
      await adminQuery(
        `select policyname, cmd, roles::text roles, qual, with_check from pg_policies where schemaname=$1 and tablename=$2`,
        [t.sch, t.t],
      )
    ).rows;
    const probes: Record<string, string> = {};
    if (t.s) probes.select = await asJwt(S, (q) => outcome(q, `select count(*) n from ${fq}`));
    if (t.i) probes.insert = await asJwt(S, (q) => outcome(q, `insert into ${fq} default values`));
    if (t.u) {
      const col = await firstCol(t.sch, t.t);
      probes.update = await asJwt(S, (q) => outcome(q, `update ${fq} set ${col} = ${col}`));
    }
    if (t.d) probes.delete = await asJwt(S, (q) => outcome(q, `delete from ${fq}`));
    const nonMembership = pol.filter((p: J) => {
      const e = `${p.qual ?? ""} ${p.with_check ?? ""}`;
      return !/auth\.uid\(\)|is_studio_member|is_studio_owner|studio_id|current_studio|jwt/.test(e);
    });
    out.push({
      table: fq,
      rls: t.rls,
      privileges: { select: t.s, insert: t.i, update: t.u, delete: t.d },
      policyCount: pol.length,
      nonMembershipPolicies: nonMembership.map((p: J) => `${p.policyname} [${p.cmd}] qual=${String(p.qual).slice(0, 80)}`),
      strangerProbes: probes,
    });
  }
  return out;
}
async function firstCol(sch: string, t: string): Promise<string> {
  return (
    await adminQuery(
      `select column_name c from information_schema.columns where table_schema=$1 and table_name=$2 order by ordinal_position limit 1`,
      [sch, t],
    )
  ).rows[0].c as string;
}

// ---------------------------------------------------------------------------
// 3) STORAGE
// ---------------------------------------------------------------------------
async function storageCensus() {
  const buckets = (await adminQuery(`select id, public, file_size_limit, allowed_mime_types from storage.buckets order by 1`)).rows;
  const pol = (
    await adminQuery(
      `select policyname, cmd, roles::text roles, qual, with_check from pg_policies where schemaname='storage' and tablename='objects' order by 1`,
    )
  ).rows;
  return {
    status: "DEFERRED_TO_HOSTED_CATALOG_READ (a local stack is not authoritative: migration 0092 skips bucket/policy creation without privilege, and CI runs without storage-api)",
    localBuckets: buckets,
    localObjectPolicies: pol.map((p: J) => ({ name: p.policyname, cmd: p.cmd, roles: p.roles, qual: String(p.qual).slice(0, 200) })),
  };
}

// ---------------------------------------------------------------------------
// 4) OWN-IDENTITY RPCs (the real question, per OPS): a user with NO practitioner
//    row calls set_own_* / update_own_*. Each must RAISE, or succeed while
//    leaving no row owned by that user in ANY table with a user_id column.
// ---------------------------------------------------------------------------
async function ownIdentityCensus() {
  const fns = (
    await adminQuery(
      `select p.proname, p.oid::int8 oid, p.proargnames names, p.proargtypes::oid[] types
         from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.prokind='f'
          and (p.proname like 'set\_own\_%' or p.proname like 'update\_own\_%')
          and has_function_privilege('authenticated',p.oid,'EXECUTE')
        order by 1`,
    )
  ).rows;
  const owned = (
    await adminQuery(
      `select table_name from information_schema.columns
        where table_schema='public' and column_name='user_id'
          and table_name in (select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE')`,
    )
  ).rows.map((r: J) => r.table_name as string);
  const typeName = async (oid: number) => (await adminQuery("select format_type($1,null) t", [oid])).rows[0].t as string;
  const lit = (t: string): string =>
    t === "uuid" ? `'${randomUUID()}'::uuid` : t === "text" ? "'x'::text" : t === "boolean" ? "true" : ["integer", "smallint", "bigint"].includes(t) ? `1::${t}` : t === "jsonb" ? "'{}'::jsonb" : `null::${t}`;
  const results: J[] = [];
  for (const f of fns) {
    const args: string[] = [];
    for (const ty of f.types) args.push(lit(await typeName(ty)));
    const call = `select public.${f.proname}(${args.join(",")}) r`;
    const verdict = await asJwt(S, async (q) => {
      await q("savepoint own");
      try {
        await q(call);
        let leaked = 0;
        for (const t of owned) {
          leaked += Number((await q(`select count(*) n from public.${t} where user_id = $1`, [S])).rows[0].n);
        }
        await q("rollback to savepoint own");
        return leaked === 0 ? "ok-no-owned-rows" : `LEAK: ${leaked} rows owned by the stranger after the call`;
      } catch (e) {
        await q("rollback to savepoint own");
        return "raised:" + ((e as { code?: string }).code ?? "?");
      }
    });
    results.push({ fn: f.proname, verdict });
  }
  return results;
}

// ---------------------------------------------------------------------------
// the census run
// ---------------------------------------------------------------------------
let report: J = {};

describe("no-studio authenticated user: what can be reached", () => {
  it("builds the census (functions, tables, storage)", async () => {
    const fns = await functionCensus();
    const tables = await tableCensus();
    const storage = await storageCensus();
    const ownIdentity = await ownIdentityCensus();

    // Positive controls: the probes can distinguish a member from a stranger.
    expect(fns.length, "census saw too few functions to be meaningful").toBeGreaterThan(40);
    expect(fns.filter((f) => f.memberDiffers).length, "a member must reach functions the stranger cannot, or the probe proves nothing").toBeGreaterThan(5);
    expect(tables.length).toBeGreaterThan(80);

    const reachableFns = fns.filter((f) => f.strangerOk);
    const reachableTables = tables.filter((t) =>
      Object.values(t.strangerProbes as Record<string, string>).some((v) => v.startsWith("ok:")),
    );
    report = {
      generatedAt: new Date().toISOString(),
      counts: { functionsProbed: fns.length, functionsReachable: reachableFns.length, tablesGranted: tables.length, tablesReachable: reachableTables.length },
      functionsReachable: reachableFns,
      functionsReachableNoIdentityCheck: reachableFns.filter((f) => !f.bodyChecksIdentity && f.secdef),
      tablesReachable: reachableTables,
      tablesWithoutRls: tables.filter((t) => !t.rls).map((t) => t.table),
      tablesNonMembershipPolicies: tables.filter((t) => t.nonMembershipPolicies.length > 0).map((t) => ({ table: t.table, policies: t.nonMembershipPolicies })),
      storage,
      ownIdentity,
    };
    const out = process.env.HONE_CENSUS_OUT;
    if (out) writeFileSync(out, JSON.stringify(report, null, 1));
    console.log(`NO-STUDIO CENSUS counts: ${JSON.stringify(report.counts)}`);
  });

  it("every own-identity RPC raises, or leaves no row owned by a no-studio user", () => {
    expect(report.ownIdentity.length, "the own-identity family must be non-empty or this proves nothing").toBeGreaterThan(2);
    const leaks = report.ownIdentity.filter((r: J) => String(r.verdict).startsWith("LEAK"));
    expect(leaks, "own-identity RPCs that create or keep data for a user with no studio").toEqual([]);
  });

  it("pins the reachable set (skipped in report mode)", () => {
    if (process.env.HONE_CENSUS_REPORT === "1") return;
    const names = [
      ...report.functionsReachable.map((f: J) => `fn ${f.fn}`),
      ...report.tablesReachable.map((t: J) => `tbl ${t.table}`),
    ].sort();
    expect(names, "reachable-by-a-no-studio-user set changed; review every added item").toEqual([...PINNED].sort());
  });
});

// Filled from the first report run (see the findings handoff). Empty means
// "nothing recorded yet": the pin test fails until a reviewed set is entered.
const PINNED: string[] = [];
