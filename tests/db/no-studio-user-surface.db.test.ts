import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { Client } from "pg";
import { E2E_SUPABASE_URL as VALIDATED_API_URL } from "../../e2e/helpers/local-env";
import { apiUrlInForce, assertLoopbackPair } from "./helpers/owned-pair-core";
import {
  adminQuery,
  asUser,
  resolveLocalDbUrl,
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

// WHAT THIS DOES NOT CLAIM. The 51 pinned functions are the set that RAN for a no-studio user in
// the seeded local fixture. That is a reviewed list, not a proof that they are harmless, and the
// census does not scrub or otherwise vouch for the report it writes. Behavioural role-check
// proofs (valid fixture ids, an asserted refusal, a rolled-back scratch copy that stops
// refusing) exist for: record/supersede_appointment_settlement, set_new_client_admission_mode,
// receptionist_move_appointment (scratch RED) and receptionist_cancel/create_appointment (stranger
// refused; removing the desk gate leaves the shared core's own refusal, so no RED) (no authorised-caller
// control: no receptionist fixture), and the four own-identity RPCs (valid args plus a member control).
// Covered by SOURCE READING ONLY, no behavioural proof here: archive_treatment_image,
// set_treatment_image_note, edit_client_pinned_note, reconcile_my_pending_invitation,
// realtime.send (S1, hosted read), graphql_public.graphql (S2, hosted read).
// The four 0298 dismissal functions (dismiss/restore/restore_if_latest/list_dismissed_attention) have
// behavioural proofs in the S5 block at the end of this file.


/**
 * A policy whose ONLY identity term is "auth.uid() is not null" (or the (select auth.uid()) form)
 * admits every signed-in account, including one with no studio, exactly like a literal true. It
 * is NOT a membership check. Exported pure so a sample test can prove the detector can fire.
 *
 * KNOWN LIMITS (Insurance Z-2): the helper exemption is a SUBSTRING test, so any expression that
 * merely contains is_studio_member / is_studio_owner / can_* / is_platform_admin is exempt whatever
 * the boolean structure ("auth.uid() IS NOT NULL OR is_studio_member(studio_id)" admits every
 * signed-in account and is NOT flagged), and `can_[a-z_]+` also matches a column that starts with
 * "can_". Both are contrived today; this is a tripwire, not a policy prover.
 */
export function uidOnlyPolicy(expr: string): boolean {
  const e = expr.toLowerCase().replace(/\s+/g, " ");
  if (!/auth\.uid\(\)/.test(e)) return false;
  if (/(is_studio_member|is_studio_owner|can_[a-z_]+|clin_key_studios|is_platform_admin)/.test(e)) return false;
  const rest = e.replace(/\(?\s*(?:select\s+)?auth\.uid\(\)(?:\s+as\s+uid)?\s*\)?\s+is\s+not\s+null/g, "");
  return !/auth\.uid\(\)/.test(rest);
}

/**
 * USING and WITH CHECK are evaluated SEPARATELY (Insurance Z-1): a FOR ALL / UPDATE policy with
 * `using (auth.uid() is not null)` and a real membership WITH CHECK still exposes every row to
 * SELECT/UPDATE/DELETE, and a concatenation would let the leftover auth.uid() hide it.
 */
export function uidOnlyPolicyRow(qual: string | null | undefined, withCheck: string | null | undefined): boolean {
  return (!!qual && uidOnlyPolicy(qual)) || (!!withCheck && uidOnlyPolicy(withCheck));
}

/**
 * BROADER tripwire (Privacy R-2): the bare `auth.uid() is not null` term appears ANYWHERE in the expression,
 * including `is_studio_member(...) OR auth.uid() is not null`, which the strict detector's helper exemption
 * lets through. It also fires on a legitimate `auth.uid() is not null AND <membership>`; every hit is pinned
 * by name so a human reads each one.
 */
export function uidBareTerm(expr: string): boolean {
  const e = expr.toLowerCase().replace(/\s+/g, " ");
  return /\(?\s*(?:select\s+)?auth\.uid\(\)(?:\s+as\s+uid)?\s*\)?\s+is\s+not\s+null/.test(e);
}
export function uidBareTermRow(qual: string | null | undefined, withCheck: string | null | undefined): boolean {
  return (!!qual && uidBareTerm(qual)) || (!!withCheck && uidBareTerm(withCheck));
}

/** Policies (applicable to authenticated) that are uid-only (strict) or contain the bare term (broad), judged per expression. */
async function scanUidOnly(run: (sql: string) => Promise<{ rows: J[] }>): Promise<{ strict: string[]; bare: string[] }> {
  const { rows } = await run(
    `select schemaname||'.'||tablename||' '||policyname||' ['||cmd||']' p, qual, with_check
       from pg_policies
      where schemaname in ('public','storage')
        and (roles::text like '%authenticated%' or roles::text like '%public%')
      order by 1`,
  );
  return {
    strict: rows.filter((r) => uidOnlyPolicyRow(r.qual, r.with_check)).map((r) => r.p as string),
    bare: rows.filter((r) => uidBareTermRow(r.qual, r.with_check)).map((r) => r.p as string),
  };
}

/**
 * LOOPBACK-ONLY check (Insurance Y-1). It uses local-env's VALIDATED API URL (the explicit variable, or the
 * default stack when CI leaves E2E_SUPABASE_URL unset: Codex P1 #4500640473). It does not prove the stack is
 * the OWNED one; that is vitest.db.config.ts' paired-target guard (#879).
 */
function assertOwnedLocalPair(): void {
  assertLoopbackPair(resolveLocalDbUrl(), apiUrlInForce(process.env, VALIDATED_API_URL));
}

/** Any SQLSTATE in class 23 (integrity constraint violation), including 23P01 exclusion violations. */
const INSERT_CONSTRAINT = /^err:23[0-9A-Z]{3}$/;
/** An insert outcome that is neither landed, a privilege/RLS refusal (42501) nor a class-23 error. */
const insertUnclassified = (v: string) => !!v && !v.startsWith("ok:") && v !== "err:42501" && !INSERT_CONSTRAINT.test(v);

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
    // BEFORE INSERT row triggers run BEFORE the RLS WITH CHECK, so a 23xxx error on a table
    // that has one says nothing about whether the policy would have admitted the row.
    const beforeInsertTriggers = Number(
      (
        await adminQuery(
          `select count(*) n from pg_trigger g where g.tgrelid = $1::regclass and not g.tgisinternal
              and (g.tgtype & 2) = 2 and (g.tgtype & 4) = 4`,
          [fq],
        )
      ).rows[0].n,
    );
    const nonMembership = pol.filter((p: J) => {
      const e = `${p.qual ?? ""} ${p.with_check ?? ""}`;
      // A policy whose only identity term is `auth.uid() is not null` admits every signed-in account.
      return uidOnlyPolicyRow(p.qual, p.with_check) || !/auth\.uid\(\)|is_studio_member|is_studio_owner|studio_id|current_studio/.test(e);
    });
    out.push({
      table: fq,
      rls: t.rls,
      privileges: { select: t.s, insert: t.i, update: t.u, delete: t.d },
      policyCount: pol.length,
      beforeInsertTriggers,
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
  // VALID-shape arguments against a REAL studio, so the call reaches its identity logic
  // (own_practitioner_in_studio) instead of failing on argument shape. A member control
  // must get a non-null result with the same arguments, which proves the shape is valid.
  const validArgs: Record<string, string[]> = {
    set_own_calendar_feed_token_hash: [`'${A.studioId}'::uuid`, `'${"a".repeat(64)}'::text`],
    set_own_default_machine_frequency: [`'${A.studioId}'::uuid`, `'13.56 MHz'::text`],
    set_own_default_machine: [`'${A.studioId}'::uuid`, `null::uuid`, `null::text`],
    update_own_practitioner_profile: [`'${A.studioId}'::uuid`, `'Nsu Name'::text`, `'teal'::text`],
  };
  const results: J[] = [];
  for (const f of fns) {
    const args = validArgs[f.proname as string];
    if (!args) {
      results.push({ fn: f.proname, verdict: "CHECK-ERROR:no-valid-args-defined" });
      continue;
    }
    const call = `select public.${f.proname}(${args.join(",")}) r`;
    const control = await asJwt(M.userId, async (q) => {
      await q("savepoint ctl");
      try {
        const r = await q(call);
        return r.rows[0]?.r == null ? "CONTROL-FAILED:null" : "control-ok";
      } catch (e) {
        return "CONTROL-FAILED:" + ((e as { code?: string }).code ?? "?");
      } finally {
        await q("rollback to savepoint ctl");
      }
    });
    if (control !== "control-ok") {
      results.push({ fn: f.proname, verdict: "CHECK-ERROR:" + control });
      continue;
    }
    const verdict = await asJwt(S, async (q) => {
      await q("savepoint own");
      try {
        await q(call);
      } catch (e) {
        await q("rollback to savepoint own");
        return "raised:" + ((e as { code?: string }).code ?? "?");
      }
      // The call succeeded. Count rows the stranger now owns, as the OWNER role
      // (the stranger has no SELECT on some of these tables, which would otherwise
      // be mistaken for the function raising). The rollback restores the role.
      try {
        await q("reset role");
        let leaked = 0;
        for (const t of owned) {
          leaked += Number((await q(`select count(*) n from public.${t} where user_id = $1`, [S])).rows[0].n);
        }
        await q("rollback to savepoint own");
        return leaked === 0 ? "ok-no-owned-rows" : `LEAK: ${leaked} rows owned by the stranger after the call`;
      } catch (e) {
        await q("rollback to savepoint own");
        return "CHECK-ERROR:" + ((e as { code?: string }).code ?? "?");
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
    // A table is reachable only if the stranger SEES a row, or a write statement
    // succeeds and affects a row / an insert lands. An empty SELECT that merely runs
    // is privilege+RLS working, not reach.
    const rowsSeen = (v: string) => /"n":"?([1-9]\d*)/.test(v);
    const wroteRows = (v: string) => v.startsWith("ok:") && !/:0$/.test(v) && !/:$/.test(v);
    const literalTrueSelect = new Set<string>(
      (
        await adminQuery(
          `select schemaname||'.'||tablename t from pg_policies
            where schemaname in ('public','storage') and cmd in ('SELECT','ALL')
              and (roles::text like '%authenticated%' or roles::text like '%public%')
              and coalesce(qual,'')='true'`,
        )
      ).rows.map((r: J) => r.t as string),
    );
    // Data-dependent facts (a row another suite happened to seed) are NOT pinned: the db lane
    // runs every file on one database. They are asserted instead: a stranger may see rows only
    // in a table whose SELECT policy is a literal true (itself pinned below), and no UPDATE or
    // DELETE may land a row anywhere.
    const leaks = tables
      .filter((t) => {
        const p = t.strangerProbes as Record<string, string>;
        return (rowsSeen(p.select ?? "") && !literalTrueSelect.has(t.table)) || wroteRows(p.update ?? "") || wroteRows(p.delete ?? "");
      })
      .map((t) => t.table as string);
    // Structural, fixture-independent: the insert reached the table's own constraints, i.e. the
    // policy admitted it (no BEFORE INSERT trigger ran ahead of RLS), or it simply landed.
    const reachableTables = tables.filter((t) => {
      const p = t.strangerProbes as Record<string, string>;
      return (p.insert ?? "").startsWith("ok:") || (t.beforeInsertTriggers === 0 && INSERT_CONSTRAINT.test(p.insert ?? ""));
    });
    // A constraint error on insert where a BEFORE trigger exists: neither reached nor refused.
    const insertIndeterminate = tables
      .filter((t) => t.beforeInsertTriggers > 0 && INSERT_CONSTRAINT.test((t.strangerProbes as Record<string, string>).insert ?? ""))
      .map((t) => t.table as string);
    // Anything else the insert probe returned (a code we have not classified) must be listed, not ignored.
    const insertOther = tables
      .filter((t) => insertUnclassified((t.strangerProbes as Record<string, string>).insert ?? ""))
      .map((t) => `${t.table} ${(t.strangerProbes as Record<string, string>).insert}`);
    // Z-4. Insert outcomes that a BEFORE trigger answered ahead of RLS are resolved at TWO layers.
    //  (a) trigger layer: a VALID row naming a REAL parent from the seeded studio. The stranger is expected to
    //      get P0001 (the parent is invisible to the invoker trigger); a studio MEMBER's identical row must LAND
    //      (rolled-back savepoint). Only if the member control lands is it classed "refused at the parent
    //      lookup"; otherwise the probe is wrong and the table stays unclassified.
    //  (b) policy layer: in a ROLLED-BACK transaction, as the owner role, disable the user triggers, then run
    //      the same valid row as the stranger (expect 42501 from the policy) and as the member (must LAND).
    //      pg_trigger.tgenabled is asserted restored afterwards. LOCAL OWNED STACK ONLY.
    // Tables with no valid-row builder keep a weaker default-values probe, labelled as such.
    assertOwnedLocalPair();
    const toResolve = Array.from(new Set([...insertIndeterminate, ...insertOther.map((x) => x.split(" ")[0])])).sort();
    const planId = randomUUID();
    await adminQuery(`insert into public.treatment_plans (id, studio_id, client_id, name) values ($1,$2,$3,'census scratch plan')`, [planId, A.studioId, A.clientId]);
    const VALID: Record<string, { sql: string; args: unknown[] }> = {
      "public.client_budget_context": { sql: "insert into public.client_budget_context (client_id, studio_id, updated_by_practitioner_id) values ($1,$2,$3)", args: [A.clientId, A.studioId, A.practitionerId] },
      "public.client_clinical_notes": { sql: "insert into public.client_clinical_notes (client_id, studio_id, practitioner_id, kind, body) values ($1,$2,$3,'consultation','census scratch')", args: [A.clientId, A.studioId, A.practitionerId] },
      "public.client_personal_notes": { sql: "insert into public.client_personal_notes (client_id, studio_id, updated_by_practitioner_id) values ($1,$2,$3)", args: [A.clientId, A.studioId, A.practitionerId] },
      "public.clients": { sql: "insert into public.clients (studio_id, name) values ($1,'census scratch client')", args: [A.studioId] },
      "public.treatment_plan_stages": { sql: "insert into public.treatment_plan_stages (plan_id, studio_id, how_often_unit, visit_length_minutes, stage_length_value, stage_length_unit) values ($1,$2,'weekly',30,4,'weeks')", args: [planId, A.studioId] },
    };
    // Returns the SQLSTATE; the exception MESSAGE (never row text: uuids and quoted values are masked) is kept
    // in `lastMessage` so a trigger-layer refusal is evidence, not inference (Insurance Y-2).
    let lastMessage = "";
    const maskMessage = (m: string) =>
      m.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>").replace(/\(.*?\)=\(.*?\)/g, "(<cols>)=(<values>)").slice(0, 140);
    const tryInsert = async (q: (t: string, p?: unknown[]) => Promise<any>, sql: string, args: unknown[]): Promise<string> => {
      await q("savepoint ins");
      lastMessage = "";
      try {
        await q(sql, args);
        return "landed";
      } catch (e) {
        lastMessage = maskMessage(String((e as { message?: string }).message ?? ""));
        return (e as { code?: string }).code ?? "?";
      } finally {
        await q("rollback to savepoint ins");
      }
    };
    // V-1/H-1: the guard trigger's own sentence per table. client_clinical_notes words it "a visible clients row" (its parent lookup is
    // visibility-based); the other three say "an existing ... row". A different P0001 stays unclassified instead of passing as this one.
    const PARENT_LOOKUP_SENTENCE: Record<string, RegExp> = { "public.client_clinical_notes": /does not reference a visible clients row/ };
    const insertResolved: J[] = [];
    // N-2: the scratch plan is removed even when a probe throws mid-loop.
    try {
      for (const fq of toResolve) {
        const [sch, tbl] = fq.split(".");
        const checks = (
          await adminQuery(
            `select with_check from pg_policies where schemaname=$1 and tablename=$2 and cmd in ('INSERT','ALL')
               and (roles::text like '%authenticated%' or roles::text like '%public%')`,
            [sch, tbl],
          )
        ).rows.map((r: J) => String(r.with_check ?? ""));
        const valid = VALID[fq];
        if (!valid) {
          // No INSERT/ALL policy applicable to authenticated or public means RLS default-denies every insert,
          // whatever the row: assert that from pg_policies (Privacy W-1). Otherwise fall back to a weak probe.
          if (checks.length === 0) {
            insertResolved.push({ table: fq, verdict: "no-insert-policy(RLS default-deny)", rawWithTriggersOff: "n/a", insertWithCheck: [] });
            continue;
          }
          // Weak probe: a default-values row names no studio, so a refusal says only "refused for a null-studio row".
          let raw = "";
          const c = new Client({ connectionString: resolveLocalDbUrl() });
          await c.connect();
          try {
            await c.query("begin");
            await c.query(`alter table ${fq} disable trigger user`);
            await c.query("set local role authenticated");
            await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: S, role: "authenticated" })]);
            raw = await tryInsert((t, p) => c.query(t, p), `insert into ${fq} default values`, []);
          } finally {
            await c.query("rollback").catch(() => undefined);
            await c.end();
          }
          const verdict = raw === "landed" || /^23[0-9A-Z]{3}$/.test(raw) ? "admitted(weak:null-studio-row)" : raw === "42501" ? "refused-for-null-studio-row" : `unresolved:${raw}`;
          insertResolved.push({ table: fq, verdict, rawWithTriggersOff: raw, insertWithCheck: checks.map((w) => w.slice(0, 160)) });
          continue;
        }
        // (a) trigger layer, triggers ENABLED.
        const aStranger = await asJwt(S, (q) => tryInsert(q, valid.sql, valid.args));
        const aStrangerMessage = lastMessage;
        // Control = the studio OWNER: a plain practitioner is refused by some of these tables' policies, which
        // would make the probe look invalid for the wrong reason.
        const aMember = await asJwt(A.userId, (q) => tryInsert(q, valid.sql, valid.args));
        const layerA =
          aStranger === "42501" && aMember === "landed" ? "refused-by-policy-with-triggers-enabled"
          // V-1/H-1: the SPECIFIC trigger sentence, not merely a non-empty message, so another P0001 cannot pass as this refusal.
        : aStranger === "P0001" && (PARENT_LOOKUP_SENTENCE[fq] ?? /does not reference an existing/).test(aStrangerMessage) && aMember === "landed" ? "refused-at-parent-lookup"
          : aMember !== "landed" ? `unclassified(member-control:${aMember})`
          : `unclassified(stranger:${aStranger})`;
        // (b) policy layer, triggers DISABLED in a scratch transaction.
        let bStranger = "";
        let bMember = "";
        const c = new Client({ connectionString: resolveLocalDbUrl() });
        await c.connect();
        try {
          await c.query("begin");
          await c.query(`alter table ${fq} disable trigger user`);
          await c.query("set local role authenticated");
          await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: S, role: "authenticated" })]);
          bStranger = await tryInsert((t, p) => c.query(t, p), valid.sql, valid.args);
          await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: A.userId, role: "authenticated" })]);
          bMember = await tryInsert((t, p) => c.query(t, p), valid.sql, valid.args);
        } finally {
          await c.query("rollback").catch(() => undefined);
          await c.end();
        }
        const stillDisabled = Number(
          (await adminQuery(`select count(*) n from pg_trigger where tgrelid = $1::regclass and not tgisinternal and tgenabled <> 'O'`, [fq])).rows[0].n,
        );
        const layerB =
          stillDisabled > 0 ? "TRIGGER-NOT-RESTORED"
          : bMember !== "landed" ? `probe-invalid(member-control:${bMember})`
          : bStranger === "42501" ? "refused by policy (guard trigger disabled in a scratch run)"
          : bStranger === "landed" || /^23[0-9A-Z]{3}$/.test(bStranger) ? "ADMITTED by policy"
          : `unresolved:${bStranger}`;
        insertResolved.push({
          table: fq, verdict: `trigger[${layerA}] policy[${layerB}]`,
          raw: { aStranger, aStrangerMessage, aMember, bStranger, bMember, stillDisabled },
          insertWithCheck: checks.map((w) => w.slice(0, 160)),
        });
      }
    } finally {
      await adminQuery("delete from public.treatment_plans where id = $1", [planId]); // scratch row, not left behind
    }
    // Policies that grant to authenticated with no predicate at all.
    const unconditional = (
      await adminQuery(
        `select schemaname||'.'||tablename||' '||policyname||' ['||cmd||']' p from pg_policies
          where schemaname in ('public','storage')
            and (roles::text like '%authenticated%' or roles::text like '%public%')
            and (coalesce(qual,'')='true' or coalesce(with_check,'')='true')
          order by 1`,
      )
    ).rows.map((r: J) => r.p as string);
    // Policies naming NO membership helper and NO auth.uid() at all (this list does not catch a policy whose
    // only identity term is `auth.uid() is not null`; that is the separate uidonly detector below).
    const noHelper = (
      await adminQuery(
        `select schemaname||'.'||tablename||' '||policyname||' ['||cmd||']' p from pg_policies
          where schemaname in ('public','storage')
            and (roles::text like '%authenticated%' or roles::text like '%public%')
            and coalesce(qual,'')||' '||coalesce(with_check,'') !~ '(is_studio_member|is_studio_owner|can_[a-z_]+|clin_key_studios|auth[.]uid[(][)]|is_platform_admin)'
          order by 1`,
      )
    ).rows.map((r: J) => r.p as string);
    const uidScan = await scanUidOnly((sql) => adminQuery(sql));
    const uidOnly = uidScan.strict;
    const uidBare = uidScan.bare;
    report = {
      generatedAt: new Date().toISOString(),
      counts: { functionsProbed: fns.length, functionsReachable: reachableFns.length, tablesGranted: tables.length, tablesReachable: reachableTables.length },
      functionsReachable: reachableFns,
      functionsReachableNoIdentityCheck: reachableFns.filter((f) => !f.bodyChecksIdentity && f.secdef),
      tablesReachable: reachableTables,
      tableLeaks: leaks,
      unconditionalPolicies: unconditional,
      policiesWithoutMembershipHelper: noHelper,
      policiesOnlyAuthUidNotNull: uidOnly,
      policiesWithBareAuthUidNotNull: uidBare,
      insertIndeterminateBeforeTrigger: insertIndeterminate,
      insertUnclassified: insertOther,
      insertResolved,
      claim:
        "No table showed a visible or writable row to a no-studio user in the SEEDED LOCAL FIXTURE; the policies listed under unconditionalPolicies carry a literal-true predicate. Inserts that a BEFORE trigger answered ahead of RLS were re-probed with that trigger disabled in a rolled-back transaction (insertResolved); an outcome that stays unresolved is listed as such, not read as refused. This is not a proof about hosted data, and the report is NOT scrubbed.",
      tablesWithoutRls: tables.filter((t) => !t.rls).map((t) => t.table),
      tablesNonMembershipPolicies: tables.filter((t) => t.nonMembershipPolicies.length > 0).map((t) => ({ table: t.table, policies: t.nonMembershipPolicies })),
      storage,
      ownIdentity,
    };
    // "Present" = the stack actually exposes functions in that schema to authenticated.
    // (storage.objects/realtime.messages tables are NOT a safe signal: a stack started
    // without storage-api/realtime can still carry the schemas' helper functions.)
    report.servicesPresent = {
      storage: fns.some((f) => String(f.fn).startsWith("storage.")),
      realtime: fns.some((f) => String(f.fn).startsWith("realtime.")),
    };
    // H-2: checked here, on the object that is about to be saved, so it cannot depend on another test having run first.
    const serialised = JSON.stringify(report);
    expect(serialised.length, "empty report: the scrub check would prove nothing").toBeGreaterThan(1000);
    expect(serialised.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ?? [], "the saved report must carry no uuid").toEqual([]);
    expect(serialised.match(/(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])/gi) ?? [], "the saved report must carry no unhyphenated 32-hex id").toEqual([]);
    expect(serialised.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+[.][A-Za-z]{2,}/g) ?? [], "the saved report must carry no email address").toEqual([]);
    const out = process.env.HONE_CENSUS_OUT;
    if (out) writeFileSync(out, JSON.stringify(report, null, 1));
    console.log(`NO-STUDIO CENSUS counts: ${JSON.stringify(report.counts)}`);
  });

  it("service_practitioners has no INSERT policy for authenticated/public, and an owner insert is refused by RLS, not by a later constraint (V-2)", async () => {
    const pol = (
      await adminQuery(
        `select policyname from pg_policies where schemaname='public' and tablename='service_practitioners' and cmd in ('INSERT','ALL')
            and (roles::text like '%authenticated%' or roles::text like '%public%')`,
      )
    ).rows;
    expect(pol, "an INSERT/ALL policy appeared on service_practitioners: the default-deny pin is stale").toEqual([]);
    // service_practitioners has a BEFORE INSERT guard trigger that answers (23514) ahead of RLS, so as in the census the trigger is
    // disabled inside a rolled-back transaction to reach the policy layer. Random service/practitioner ids: if RLS admitted the row the
    // FK would answer 23503; 42501 means RLS refused first. LOCAL OWNED STACK ONLY.
    assertOwnedLocalPair();
    let code = "";
    let message = "";
    const c = new Client({ connectionString: resolveLocalDbUrl() });
    await c.connect();
    try {
      await c.query("begin");
      await c.query("alter table public.service_practitioners disable trigger user");
      await c.query("set local role authenticated");
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: A.userId, role: "authenticated" })]);
      try {
        await c.query("insert into public.service_practitioners (studio_id, service_id, practitioner_id) values ($1,$2,$3)", [A.studioId, randomUUID(), randomUUID()]);
        code = "landed";
      } catch (e) {
        code = (e as { code?: string }).code ?? "?";
        message = String((e as { message?: string }).message ?? "");
      }
    } finally {
      await c.query("rollback").catch(() => undefined);
      await c.end();
    }
    const notRestored = Number(
      (await adminQuery("select count(*) n from pg_trigger where tgrelid = 'public.service_practitioners'::regclass and not tgisinternal and tgenabled <> 'O'")).rows[0].n,
    );
    expect(notRestored, "the guard trigger must be restored after the scratch run").toBe(0);
    expect(code).toBe("42501");
    // L1-1: 42501 is also what a missing table privilege answers. Pin that the refusal is the POLICY layer: the privilege is held, and the
    // message is the row-level-security one, not "permission denied for table".
    expect(
      (await adminQuery("select has_table_privilege('authenticated', 'public.service_practitioners', 'INSERT') p")).rows[0].p,
      "authenticated must hold INSERT here, or 42501 proves nothing about RLS",
    ).toBe(true);
    expect(message).toMatch(/row-level security/);
  });

  it("every own-identity RPC raises, or leaves no row owned by a no-studio user", () => {
    expect(report.ownIdentity.length, "the own-identity family must be non-empty or this proves nothing").toBeGreaterThan(2);
    const bad = report.ownIdentity.filter((r: J) => /^(LEAK|CHECK-ERROR)/.test(String(r.verdict)));
    expect(bad, "own-identity RPCs that keep data for a user with no studio, or a check that could not run").toEqual([]);
    // Anti-vacuity: at least one must have actually run to completion and been counted.
    expect(report.ownIdentity.some((r: J) => r.verdict === "ok-no-owned-rows"), "no own-identity call ran to the leak check").toBe(true);
  });

  it("the auth.uid()-only detector can fire, and does not fire on real membership checks", () => {
    for (const bad of ["auth.uid() IS NOT NULL", "(auth.uid() IS NOT NULL)", "( SELECT auth.uid() AS uid) IS NOT NULL"]) {
      expect(uidOnlyPolicy(bad), bad).toBe(true);
    }
    for (const ok of ["user_id = auth.uid()", "(user_id = ( SELECT auth.uid() AS uid))", "is_studio_member(studio_id)", "auth.uid() IS NOT NULL AND is_studio_member(studio_id)", "true", "auth.uid() IS NOT NULL AND user_id = auth.uid()"]) {
      expect(uidOnlyPolicy(ok), ok).toBe(false);
    }
  });

  it("USING and WITH CHECK are judged separately: a mixed pair is flagged (Z-1)", () => {
    expect(uidOnlyPolicyRow("auth.uid() IS NOT NULL", "(user_id = auth.uid())")).toBe(true); // USING uid-only
    expect(uidOnlyPolicyRow("(user_id = auth.uid())", "auth.uid() IS NOT NULL")).toBe(true); // WITH CHECK uid-only
    expect(uidOnlyPolicyRow("is_studio_member(studio_id)", "is_studio_member(studio_id)")).toBe(false);
    expect(uidOnlyPolicyRow(null, "(user_id = auth.uid())")).toBe(false);
    // R-2: the OR form (strict misses it by design: the helper exemption), caught by the bare-term scan.
    expect(uidOnlyPolicyRow("is_studio_member(studio_id) OR auth.uid() IS NOT NULL", null)).toBe(false);
    expect(uidBareTermRow("is_studio_member(studio_id) OR auth.uid() IS NOT NULL", null)).toBe(true);
    expect(uidBareTermRow("(user_id = auth.uid())", "( SELECT auth.uid() AS uid) IS NOT NULL")).toBe(true);
    expect(uidBareTermRow("user_id = auth.uid()", "is_studio_member(studio_id)")).toBe(false);
  });

  it("the census scan flags a REAL scratch policy `using (auth.uid() is not null)` (created and rolled back inside the test) (Z-3)", async () => {
    assertOwnedLocalPair();
    const c = new Client({ connectionString: resolveLocalDbUrl() });
    await c.connect();
    try {
      await c.query("begin");
      await c.query("create table public.zz_census_scratch (id int, user_id uuid)");
      await c.query("alter table public.zz_census_scratch enable row level security");
      await c.query("create policy zz_uid_only on public.zz_census_scratch for all to authenticated using (auth.uid() is not null) with check (user_id = auth.uid())");
      await c.query("create policy zz_member on public.zz_census_scratch for select to authenticated using (public.is_studio_member(gen_random_uuid()))");
      await c.query("create policy zz_or on public.zz_census_scratch for insert to authenticated with check (public.is_studio_member(gen_random_uuid()) or auth.uid() is not null)");
      const hits = await scanUidOnly((sql) => c.query(sql));
      expect(hits.strict.some((h) => h.includes("zz_census_scratch zz_uid_only")), `strict scan: ${hits.strict.join(" | ")}`).toBe(true);
      expect(hits.strict.some((h) => h.includes("zz_member"))).toBe(false);
      // R-2: the OR form slips past the strict detector (helper exemption) but the bare-term scan catches it.
      expect(hits.strict.some((h) => h.includes("zz_or"))).toBe(false);
      expect(hits.bare.some((h) => h.includes("zz_census_scratch zz_or")), `bare scan: ${hits.bare.join(" | ")}`).toBe(true);
      expect(hits.bare.some((h) => h.includes("zz_member"))).toBe(false);
    } finally {
      await c.query("rollback").catch(() => undefined);
      await c.end();
    }
    const gone = (await adminQuery("select to_regclass('public.zz_census_scratch') t")).rows[0].t;
    expect(gone, "the scratch table must not survive the rollback").toBeNull();
  });

  it("payment_charge_attempts and stripe_account_provisioning_attempts have NO authenticated INSERT policy (RLS default-deny)", () => {
    const by = Object.fromEntries(report.insertResolved.map((r: J) => [r.table, r.verdict]));
    for (const t of ["public.payment_charge_attempts", "public.stripe_account_provisioning_attempts"]) {
      expect(by[t], t).toBe("no-insert-policy(RLS default-deny)");
    }
  });

  it("insert outcomes: a class-23 code of any kind is recognised; an unknown code is listed, never ignored", () => {
    for (const c of ["err:23502", "err:23503", "err:23505", "err:23514", "err:23P01"]) expect(INSERT_CONSTRAINT.test(c), c).toBe(true);
    for (const c of ["err:42501", "err:22P02", "err:42P01", "err:0A000"]) expect(INSERT_CONSTRAINT.test(c), c).toBe(false);
    expect(insertUnclassified("err:22P02")).toBe(true);
    expect(insertUnclassified("err:42501")).toBe(false);
    expect(insertUnclassified("err:23P01")).toBe(false);
    expect(insertUnclassified('ok:[]:1')).toBe(false);
  });

  it("no table leaks a row or accepts an update/delete for a no-studio user (fixture-independent)", () => {
    expect(report.tableLeaks, "a no-studio user saw rows in a table without a literal-true SELECT policy, or an UPDATE/DELETE landed").toEqual([]);
  });

  it("pins the reachable set (skipped in report mode)", () => {
    if (process.env.HONE_CENSUS_REPORT === "1") return;
    const names = [
      ...report.functionsReachable.map((f: J) => `fn ${f.fn}`),
      ...report.tablesReachable.map((t: J) => `tbl-insert-admitted ${t.table}`),
      ...report.unconditionalPolicies.map((p: string) => `policy ${p}`),
      ...report.policiesWithoutMembershipHelper.map((p: string) => `nohelper ${p}`),
      ...report.policiesOnlyAuthUidNotNull.map((p: string) => `uidonly ${p}`),
      ...report.policiesWithBareAuthUidNotNull.map((p: string) => `uidbare ${p}`),
      ...report.insertResolved.map((r: J) => `insert-resolved ${r.table} ${r.verdict}`),
      ...report.tablesWithoutRls.map((t: string) => `rls-off ${t}`),
      ...report.tablesNonMembershipPolicies.flatMap((t: J) => t.policies.map((p: string) => `nonmember ${t.table} ${p}`)),
    ].sort();
    // Services the CI db lane does not start (-x realtime,storage-api in ci.yml) have no
    // such functions; their pin is asserted only when the service is present.
    const present = report.servicesPresent as Record<string, boolean>;
    const svcOf = (n: string) => (/^fn storage\./.test(n) ? "storage" : /^fn realtime\./.test(n) ? "realtime" : null);
    const skipped = Object.entries(present).filter(([, v]) => !v).map(([k]) => k);
    for (const k of skipped) console.log(`${k}: SKIPPED_NOT_IN_STACK (its functions are not asserted here)`);
    const inScope = (n: string) => { const sv = svcOf(n); return sv === null || present[sv]; };
    expect(names.filter(inScope), "reachable-by-a-no-studio-user set changed; review every added item").toEqual(PINNED.filter(inScope).sort());
  });
});

// Core set (always asserted) plus storage/realtime entries (asserted only when that service
// is in the stack; CI starts Supabase with -x ...,realtime,...,storage-api).
// Recorded from the reviewed first run (report NO-STUDIO-SURFACE-*.json in the lane
// handoff, 7 Nov, production chain through 0300, local stack). Every entry is a
// function that RAN for a no-studio user (almost all return false/null/not_authorized
// or an empty result by design) or a policy that grants with no predicate. Two tables
// (waitlist, demo_requests) accept an anonymous insert by their literal-true policies;
// four more returned a constraint error on insert from a table with a BEFORE INSERT
// trigger, which runs ahead of the RLS check and so is INDETERMINATE, not reached.
// Four more raised P0001 (a custom exception from a guard) on insert: unclassified, listed, not read as
// refused or admitted. No other table showed a visible or writable row in the seeded local fixture. Storage is deferred to the
// hosted catalog read. A NEW entry fails this test and must be reviewed.
const PINNED: string[] = [
  "fn graphql_public.graphql(\"operationName\" text, query text, variables jsonb, extensions jsonb)",
  // 0287 c03 (rmin-0287-apply-20261107, Insurance PASS, Privacy no objection): the 13 Roles-engine commands granted to authenticated alone.
  // Reachable is not usable: every one refuses a no-studio caller (see the S6 describe at the end of this file). 0331 and 0332 add nothing here.
  "fn public.activate_released_permissions(p_studio uuid, p_keys text[], p_expected_version bigint, p_reason text, p_preview_hash text, p_sensitiv",
  "fn public.adopt_new_defaults(p_studio uuid, p_expected_version bigint, p_reason text, p_sensitive_confirmed boolean)",
  "fn public.appointment_transition_allowed(p_old_status text, p_new_status text)",
  "fn public.archive_treatment_image(p_image_id uuid, p_client_id uuid)",
  "fn public.audit_actor_is_caller(target_actor_id uuid, target_studio_id uuid)",
  "fn public.can_read_client_legal_identity(target_studio_id uuid)",
  "fn public.can_use_client_legal_identity(target_studio_id uuid)",
  "fn public.change_staff_role(p_studio uuid, p_membership uuid, p_new_role text, p_expected_current_role text, p_reason text)",
  // 0333 (I1): the key-aware studio set used by the clinical SELECT policies. Reachable by design (a policy runs as the caller), but it returns the EMPTY set
  // for a caller with no active practitioner row (proved in tests/db/clin-read-enforcement-records.db.test.ts, "an unknown key or no session returns no studios").
  "fn public.clin_key_studios(p_key text)",
  // 0334 (I2): the status-only intake projection. Reachable by design; it returns ZERO rows unless the caller is an active practitioner holding clin.view_intake_status or
  // clin.view_intake in that studio (tests/db/clin-read-enforcement-intake-consent.db.test.ts). The pin text is the expected form; the first DB run confirms it.
  "fn public.intake_status_for_clients(p_studio_id uuid, p_client_ids uuid[])",
  "fn public.dismiss_attention_item(p_studio uuid, p_item_key text, p_instance_token text)",
  "fn public.edit_client_pinned_note(p_studio_id uuid, p_client_id uuid, p_note_id uuid, p_original_text text, p_text text)",
  "fn public.effective_access(p_studio uuid, p_membership uuid)",
  "fn public.get_role_permissions(p_studio uuid)",
  "fn public.has_studio_permission(p_studio uuid, p_key text, p_client uuid, p_appointment uuid, p_practitioner uuid)",
  "fn public.is_studio_member(target_studio_id uuid)",
  "fn public.is_studio_owner(target_studio_id uuid)",
  "fn public.latest_setup_for_client(p_studio_id uuid, p_client_id uuid, p_exclude_session_id uuid)",
  "fn public.list_dismissed_attention(p_studio uuid)",
  "fn public.list_permission_audit(p_studio uuid, p_limit integer, p_before bigint)",
  "fn public.member_owns_scoped_timed_block(p_studio_id uuid, p_practitioner_id uuid)",
  "fn public.my_pending_invitation()",
  "fn public.preview_activation(p_studio uuid, p_keys text[])",
  "fn public.preview_adopt_new_defaults(p_studio uuid)",
  "fn public.preview_reset(p_studio uuid, p_role text)",
  "fn public.preview_role_changes(p_studio uuid, p_changes jsonb)",
  "fn public.receptionist_cancel_appointment(p_studio_id uuid, p_appointment_id uuid, p_reason text)",
  "fn public.receptionist_create_appointment(p_studio_id uuid, p_target_practitioner_id uuid, p_client_id uuid, p_service_id uuid, p_starts_at tim",
  "fn public.receptionist_move_appointment(p_studio_id uuid, p_appointment_id uuid, p_target_practitioner_id uuid, p_expected_starts_at timestamp ",
  "fn public.reconcile_my_pending_invitation()",
  "fn public.record_appointment_settlement(p_studio_id uuid, p_appointment_id uuid, p_method text, p_amount_cents integer, p_note text, p_livemode",
  "fn public.reset_role_to_defaults(p_studio uuid, p_role text, p_expected_version bigint, p_reason text, p_sensitive_confirmed boolean)",
  "fn public.restore_attention_item(p_studio uuid, p_item_key text)",
  "fn public.restore_attention_item_if_latest(p_studio uuid, p_item_key text, p_observed_seq bigint)",
  "fn public.save_role_permissions(p_studio uuid, p_expected_version bigint, p_changes jsonb, p_reason text, p_sensitive_confirmed boolean)",
  "fn public.session_is_visible(target_session_id uuid)",
  "fn public.set_new_client_admission_mode(p_studio_id uuid, p_mode text)",
  "fn public.set_own_calendar_feed_token_hash(p_studio_id uuid, p_token_hash text)",
  "fn public.set_own_default_machine(p_studio_id uuid, p_machine_id uuid, p_mode_key text)",
  "fn public.set_own_default_machine_frequency(p_studio_id uuid, p_frequency text)",
  "fn public.set_treatment_image_note(p_image_id uuid, p_client_id uuid, p_note text)",
  "fn public.setup_capture_history_for_block(p_block_id uuid)",
  "fn public.sms_normalized_phone(p_phone text)",
  "fn public.sms_trimmable_whitespace()",
  "fn public.supersede_appointment_settlement(p_studio_id uuid, p_expected_settlement_id uuid, p_method text, p_amount_cents integer, p_reason tex",
  "fn public.update_own_practitioner_profile(p_studio_id uuid, p_display_name text, p_color text)",
  "fn realtime.apply_rls(wal jsonb, max_record_bytes integer)",
  "fn realtime.build_prepared_statement_sql(prepared_statement_name text, entity regclass, columns realtime.wal_column[])",
  "fn realtime.is_visible_through_filters(columns realtime.wal_column[], filters realtime.user_defined_filter[])",
  "fn realtime.quote_wal2json(entity regclass)",
  "fn realtime.send(payload bytea, event text, topic text, private boolean)",
  "fn realtime.send(payload jsonb, event text, topic text, private boolean)",
  "fn realtime.topic()",
  "fn storage.allow_any_operation(expected_operations text[])",
  "fn storage.allow_only_operation(expected_operation text)",
  "fn storage.extension(name text)",
  "fn storage.filename(name text)",
  "fn storage.foldername(name text)",
  "fn storage.get_common_prefix(p_key text, p_prefix text, p_delimiter text)",
  "fn storage.get_size_by_bucket()",
  "fn storage.list_multipart_uploads_with_delimiter(bucket_id text, prefix_param text, delimiter_param text, max_keys integer, next_key_token text",
  "fn storage.list_objects_with_delimiter(_bucket_id text, prefix_param text, delimiter_param text, max_keys integer, start_after text, next_token",
  "fn storage.operation()",
  "fn storage.search(prefix text, bucketname text, limits integer, levels integer, offsets integer, search text, sortcolumn text, sortorder text)",
  "fn storage.search_v2(prefix text, bucket_name text, limits integer, levels integer, start_after text, sort_order text, sort_column text, sort_c",
  "policy public.demo_requests demo_requests_anonymous_insert [INSERT]",
  "policy public.machine_profile_field_contract machine_profile_field_contract_read [SELECT]",
  "policy public.machine_profile_mode_contract machine_profile_mode_contract_read [SELECT]",
  "policy public.waitlist waitlist_anonymous_insert [INSERT]",
  "tbl-insert-admitted public.demo_requests",
  "tbl-insert-admitted public.waitlist",
  "nohelper public.demo_requests demo_requests_anonymous_insert [INSERT]",
  "nohelper public.electrolysis_entries electrolysis_entries: members insert [INSERT]",
  "nohelper public.electrolysis_entries electrolysis_entries: members select [SELECT]",
  "nohelper public.electrolysis_entries electrolysis_entries: members update [UPDATE]",
  "nohelper public.laser_entries laser_entries: members insert [INSERT]",
  "nohelper public.laser_entries laser_entries: members select [SELECT]",
  "nohelper public.laser_entries laser_entries: members update [UPDATE]",
  "nohelper public.machine_profile_field_contract machine_profile_field_contract_read [SELECT]",
  "nohelper public.machine_profile_mode_contract machine_profile_mode_contract_read [SELECT]",
  // 0333: session_audit follows sessions' own (key-gated) policy through a subselect, like the entry tables above; it names no membership helper itself.
  "nohelper public.session_audit session_audit_studio_member_read [SELECT]",
  "nohelper public.studio_timed_blocks studio_timed_blocks_member_delete_own [DELETE]",
  "nohelper public.studio_timed_blocks studio_timed_blocks_member_insert [INSERT]",
  "nohelper public.studio_timed_blocks studio_timed_blocks_member_update_own [UPDATE]",
  "nohelper public.waitlist waitlist_anonymous_insert [INSERT]",
  "nonmember public.demo_requests demo_requests_anonymous_insert [INSERT] qual=null",
  // 0333: follows sessions' own (key-gated) policy through a subselect
  "nonmember public.electrolysis_entries electrolysis_entries: members select [SELECT] qual=(session_id IN ( SELECT s.id\n   FROM sessions s))",
  "nonmember public.electrolysis_entries electrolysis_entries: members insert [INSERT] qual=null",
  "nonmember public.electrolysis_entries electrolysis_entries: members update [UPDATE] qual=session_is_visible(session_id)",
  // 0333: session_audit likewise
  "nonmember public.session_audit session_audit_studio_member_read [SELECT] qual=(session_id IN ( SELECT s.id\n   FROM sessions s))",
  // 0333: follows sessions' own (key-gated) policy through a subselect
  "nonmember public.laser_entries laser_entries: members select [SELECT] qual=(session_id IN ( SELECT s.id\n   FROM sessions s))",
  "nonmember public.laser_entries laser_entries: members insert [INSERT] qual=null",
  "nonmember public.laser_entries laser_entries: members update [UPDATE] qual=session_is_visible(session_id)",
  "nonmember public.machine_profile_field_contract machine_profile_field_contract_read [SELECT] qual=true",
  "nonmember public.machine_profile_mode_contract machine_profile_mode_contract_read [SELECT] qual=true",
  "nonmember public.waitlist waitlist_anonymous_insert [INSERT] qual=null",
  "insert-resolved public.client_budget_context trigger[refused-at-parent-lookup] policy[refused by policy (guard trigger disabled in a scratch run)]",
  "insert-resolved public.client_clinical_notes trigger[refused-at-parent-lookup] policy[refused by policy (guard trigger disabled in a scratch run)]",
  "insert-resolved public.client_personal_notes trigger[refused-at-parent-lookup] policy[refused by policy (guard trigger disabled in a scratch run)]",
  "insert-resolved public.treatment_plan_stages trigger[refused-at-parent-lookup] policy[refused by policy (guard trigger disabled in a scratch run)]",
  "insert-resolved public.clients trigger[refused-by-policy-with-triggers-enabled] policy[refused by policy (guard trigger disabled in a scratch run)]",
  "insert-resolved public.payment_charge_attempts no-insert-policy(RLS default-deny)",
  "insert-resolved public.service_practitioners no-insert-policy(RLS default-deny)",
  "insert-resolved public.stripe_account_provisioning_attempts no-insert-policy(RLS default-deny)"
];

// S4: three functions returned a VALIDATION result for the census's fixture args,
// so the census alone did not prove they refuse a stranger. Here the arguments
// are valid in shape (a real studio with a real owner). The two settlement
// commands have TWO layers: session_actor_practitioner (raises for a non-member)
// and then is_studio_owner (closed 'owner_only' / 'not_owner'). The admission-mode
// command has the owner layer only ('not_authorized'). Each layer is proven by a
// rolled-back scratch copy of the function with that layer removed.
// ---------------------------------------------------------------------------
describe("S4: the settlement and admission-mode commands refuse a no-studio user at the membership/role check", () => {
  type Call = { name: string; args: string; ownerCode: string; layers: Array<{ label: string; re: RegExp }>; scalar?: boolean; noControl?: boolean; coreAlsoRefuses?: boolean };
  const CALLS: Call[] = [
    { name: "record_appointment_settlement", args: `'%S'::uuid, '${randomUUID()}'::uuid, 'paid_cash', 1000, null, false`, ownerCode: "owner_only",
      layers: [{ label: "membership", re: /v_practitioner := public\.session_actor_practitioner\(p_studio_id\);/ }, { label: "owner", re: /if not public\.is_studio_owner\(p_studio_id\) then/ }] },
    { name: "supersede_appointment_settlement", args: `'%S'::uuid, '${randomUUID()}'::uuid, 'paid_cash', 1000, 'valid reason', null, false`, ownerCode: "not_owner",
      layers: [{ label: "membership", re: /v_practitioner := public\.session_actor_practitioner\(p_studio_id\);/ }, { label: "owner", re: /if not public\.is_studio_owner\(p_studio_id\) then/ }] },
    // Receptionist desk commands: gate is receptionist_actor_id(). No receptionist fixture exists
    // here, so there is no "authorised caller passes" control; the proof is that the stranger is
    // refused and that removing the gate changes the outcome.
    { name: "receptionist_cancel_appointment", scalar: true, noControl: true, coreAlsoRefuses: true, args: `'%S'::uuid, '${randomUUID()}'::uuid, 'valid reason'`, ownerCode: "not_authorized",
      layers: [{ label: "desk", re: /if v_desk is null then/ }] },
    { name: "receptionist_create_appointment", noControl: true, coreAlsoRefuses: true, args: `'%S'::uuid, '%P'::uuid, '%C'::uuid, '${randomUUID()}'::uuid, now() + interval '3 days'`, ownerCode: "not_authorized",
      layers: [{ label: "desk", re: /if v_desk is null then/ }] },
    { name: "receptionist_move_appointment", noControl: true, args: `'%S'::uuid, '${randomUUID()}'::uuid, '%P'::uuid, now() + interval '3 days', now() + interval '3 days 1 hour', now() + interval '4 days'`, ownerCode: "not_authorized",
      layers: [{ label: "desk", re: /if v_desk is null then/ }] },
    { name: "set_new_client_admission_mode", args: `'%S'::uuid, 'waitlist'`, ownerCode: "not_authorized",
      layers: [{ label: "owner", re: /if not public\.is_studio_owner\(p_studio_id\) then/ }] },
  ];
  const fill = (c: Call) => c.args.replace("%S", A.studioId).replace("%P", A.practitionerId).replace("%C", A.clientId);
  const sqlFor = (c: Call) => (c.scalar ? `select public.${c.name}(${fill(c)}) r` : `select (public.${c.name}(${fill(c)})).* `);
  const first = (rows: J[]) => String(Object.values(rows[0] ?? {})[0]);
  const run = (userId: string, c: Call) =>
    asJwt(userId, async (q) => {
      await q("savepoint x");
      try { return first((await q(sqlFor(c))).rows); }
      catch (e) { return `raised:${(e as Error).message}`; }
      finally { await q("rollback to savepoint x"); }
    });
  const isRefusal = (c: Call, r: string) => r === c.ownerCode || /^raised:(Inactive practitioners|An authenticated practitioner)/.test(r);
  const scratchRun = async (c: Call, remove: RegExp[]) => {
    const def = (await adminQuery(`select pg_get_functiondef(p.oid) d from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=$1`, [c.name])).rows[0].d as string;
    let scratch = def;
    for (const re of remove) {
      expect(scratch, `layer ${re} must be present (else this probe is stale)`).toMatch(re);
      scratch = scratch.replace(re, (m) => (m.startsWith("if ") ? "if false then" : "v_practitioner := null;"));
    }
    const client = new Client({ connectionString: resolveLocalDbUrl() });
    await client.connect();
    try {
      await client.query("begin");
      await client.query(scratch);
      await client.query("set local role authenticated");
      await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: S, role: "authenticated" })]);
      await client.query("savepoint y");
      return await client.query(sqlFor(c)).then((x) => first(x.rows), (e) => `raised:${(e as Error).message}`);
    } finally {
      await client.query("rollback").catch(() => undefined);
      await client.end();
    }
  };

  for (const c of CALLS) {
    it(`${c.name}: a stranger is refused by the membership/role check, the owner is not`, async () => {
      const stranger = await run(S, c);
      expect(isRefusal(c, stranger), `stranger outcome: ${stranger}`).toBe(true);
      expect(stranger).not.toMatch(/invalid/);
      if (!c.noControl) {
        const owner = await run(A.userId, c);
        expect(isRefusal(c, owner), `control: owner outcome ${owner}`).toBe(false);
        expect(owner).not.toMatch(/^invalid/);
      }
    });

    it(`${c.name}: scratch copies with the check(s) removed no longer refuse the stranger (can fail)`, async () => {
      const owner = c.layers.find((l) => l.label === "owner")!;
      const membership = c.layers.find((l) => l.label === "membership");
      if (membership) {
        // Membership layer removed alone: the owner layer must still refuse (defence in depth).
        expect(await scratchRun(c, [membership.re])).toBe(c.ownerCode);
      }
      // All layers removed: the stranger is no longer refused.
      const none = await scratchRun(c, c.layers.map((l) => l.re));
      if (c.coreAlsoRefuses) {
        // Defence in depth: create/cancel hand the actor to a shared core that re-checks the actor
        // against practitioners/receptionists and refuses too. Removing the desk gate alone does NOT
        // turn this red; that is recorded, not hidden. (The core's own check is not mutated here.)
        expect(none, "the shared core must still refuse when the desk gate is removed").toBe(c.ownerCode);
      } else {
        expect(isRefusal(c, none), `with every check removed the stranger got: ${none}`).toBe(false);
      }
      // The real function is unchanged after the rollback.
      expect(isRefusal(c, await run(S, c))).toBe(true);
      void owner;
    });
  }
});

// ---------------------------------------------------------------------------
// S5: the four 0298 dashboard-dismissal functions are reachable by a no-studio user (they are
// SECURITY DEFINER and granted to authenticated) but each stops at the same first check,
// `v_user is null or p_studio is null or not public.is_studio_owner(p_studio)` (0298 lines 77-80,
// 112-115, 148-151, 181-184), and answers only {ok:false, code:'refused'}. Proven here:
//   1. the stranger gets exactly that answer for the owner's real studio, a random studio and a
//      NULL studio (so the answer is no oracle for which studios exist, and echoes no studio id);
//   2. the stranger's calls add no event row in ANY studio (the whole table is counted before and after), on the SAME
//      connection inside the transaction (reset role, count, back to the savepoint), so a call that did insert would be seen; the scratch
//      probe below shows the count moving when the ownership check is removed from dismiss_attention_item;
//   3. after the OWNER dismissed an item (same transaction, claims then switched to the stranger),
//      the stranger gets the refused answer and no item key or token. The refused answer is the
//      discriminating assertion here: events are scoped to the caller, so a stranger without the gate
//      would see an empty list too and the absence of the key alone would not tell the cases apart;
//   4. a member who is not an owner, and the owner of a different studio, are refused the same way; the owner is not (control);
//   5. a rolled-back scratch copy of each function without the ownership check no longer refuses the
//      stranger (the probe can fail);
//   6. anon, public and service_role cannot execute them.
// The scratch-copy probe (5) runs CREATE OR REPLACE FUNCTION inside a transaction it always rolls back. It is
// local-stack only: this file must never be pointed at a hosted database (the harness refuses a non-loopback pair).
// ---------------------------------------------------------------------------
describe("S5: the 0298 dismissal functions refuse a no-studio user at the ownership check and leak nothing", () => {
  const KEY = "unpaid:s5-probe";
  const REFUSED = JSON.stringify({ ok: false, code: "refused" });
  type Fn = { name: string; sql: (studio: string | null) => string };
  const lit = (studio: string | null) => (studio === null ? "null::uuid" : `'${studio}'::uuid`);
  const FNS: Fn[] = [
    { name: "dismiss_attention_item", sql: (st) => `select public.dismiss_attention_item(${lit(st)}, '${KEY}', 'tok-1') r` },
    { name: "restore_attention_item", sql: (st) => `select public.restore_attention_item(${lit(st)}, '${KEY}') r` },
    { name: "restore_attention_item_if_latest", sql: (st) => `select public.restore_attention_item_if_latest(${lit(st)}, '${KEY}', 1) r` },
    { name: "list_dismissed_attention", sql: (st) => `select public.list_dismissed_attention(${lit(st)}) r` },
  ];
  const as = async (c: Client, userId: string) => {
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId, role: "authenticated" })]);
  };
  const call = async (c: Client, f: Fn, studio: string | null) => (await callCounting(c, f, studio)).answer;
  // The answer plus how many rows the call added to dashboard_attention_events in ALL studios (not only the
  // named one), counted on the same connection before the savepoint is rolled back. The table is closed to
  // authenticated, so both counts run as the owner role and the call runs as authenticated in between.
  const countAllEvents = async (c: Client) =>
    Number((await c.query("select count(*)::int n from public.dashboard_attention_events")).rows[0].n);
  const callCounting = async (c: Client, f: Fn, studio: string | null) => {
    await c.query("savepoint s5");
    try {
      await c.query("reset role");
      const before = await countAllEvents(c);
      await c.query("set local role authenticated");
      const answer = JSON.stringify((await c.query(f.sql(studio))).rows[0].r);
      await c.query("reset role");
      return { answer, added: (await countAllEvents(c)) - before };
    } finally { await c.query("rollback to savepoint s5"); }
  };
  const withTx = async <T,>(fn: (c: Client) => Promise<T>): Promise<T> => {
    const c = new Client({ connectionString: resolveLocalDbUrl() });
    await c.connect();
    try {
      await c.query("begin");
      await c.query("set local role authenticated");
      return await fn(c);
    } finally {
      await c.query("rollback").catch(() => undefined);
      await c.end();
    }
  };

  it("the stranger gets exactly {ok:false, code:refused} for a real, a random and a NULL studio, and no studio id is echoed", async () => {
    await withTx(async (c) => {
      await as(c, S);
      for (const f of FNS) {
        for (const st of [A.studioId, randomUUID(), null]) {
          const { answer, added } = await callCounting(c, f, st);
          expect(answer, `${f.name}(${st === null ? "null" : "studio"})`).toBe(REFUSED);
          expect(answer).not.toContain(A.studioId);
          expect(added, `${f.name}: a refused stranger call must add no event row anywhere`).toBe(0);
        }
      }
    });
  });

  it("an item the owner dismissed is not visible to the stranger, and the stranger's restores change nothing", async () => {
    await withTx(async (c) => {
      await as(c, A.userId);
      const d = await c.query(`select public.dismiss_attention_item('${A.studioId}'::uuid, '${KEY}', 'tok-1') r`);
      expect(d.rows[0].r).toEqual({ ok: true, changed: true });
      const own = await c.query(`select public.list_dismissed_attention('${A.studioId}'::uuid) r`);
      expect(JSON.stringify(own.rows[0].r), "control: the owner sees the dismissal").toContain(KEY);
      await as(c, S);
      for (const f of FNS) {
        const r = await call(c, f, A.studioId);
        expect(r, f.name).toBe(REFUSED);
        expect(r).not.toContain(KEY);
        expect(r).not.toContain("tok-1");
      }
      await as(c, A.userId);
      const after = await c.query(`select public.list_dismissed_attention('${A.studioId}'::uuid) r`);
      expect(JSON.stringify(after.rows[0].r), "the stranger's restores left the owner's dismissal in place").toContain(KEY);
    });
  });

  it("a member who is not an owner is refused the same way; the owner is not (control)", async () => {
    await withTx(async (c) => {
      for (const f of FNS) {
        await as(c, M.userId);
        expect(await call(c, f, A.studioId), `member ${f.name}`).toBe(REFUSED);
        await as(c, A.userId);
        expect(await call(c, f, A.studioId), `owner ${f.name}`).not.toBe(REFUSED);
      }
    });
  });

  it("the owner of a DIFFERENT studio, calling with this studio's id, is refused and leaves no event", async () => {
    const B = await seedStudio("nsu-other-owner");
    await withTx(async (c) => {
      await as(c, B.userId);
      for (const f of FNS) {
        const { answer, added } = await callCounting(c, f, A.studioId);
        expect(answer, `other-studio owner ${f.name}`).toBe(REFUSED);
        expect(added, `${f.name}: no event row anywhere`).toBe(0);
      }
    });
  });

  for (const f of FNS) {
    it(`${f.name}: a scratch copy without the ownership check no longer refuses the stranger (can fail)`, async () => {
      const def = (await adminQuery(`select pg_get_functiondef(p.oid) d from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=$1`, [f.name])).rows[0].d as string;
      const gate = /or not public\.is_studio_owner\(p_studio\)/;
      expect(def, "the ownership check must be present (else this probe is stale)").toMatch(gate);
      const out = await withTx(async (c) => {
        await c.query("reset role");
        await c.query(def.replace(gate, ""));
        await c.query("set local role authenticated");
        await as(c, S);
        return callCounting(c, f, A.studioId);
      });
      expect(out.answer, "with the ownership check removed the stranger is no longer refused").not.toBe(REFUSED);
      // The event count moves too, for the command that writes unconditionally (the restores have nothing to restore).
      if (f.name === "dismiss_attention_item") expect(out.added, "the stranger's dismissal is written once the check is gone").toBe(1);
      // the real function is unchanged after the rollback
      await withTx(async (c) => { await as(c, S); expect(await call(c, f, A.studioId)).toBe(REFUSED); });
    });

    it(`${f.name}: not executable by anon, public or service_role`, async () => {
      const r = await adminQuery(
        `select has_function_privilege('anon', p.oid, 'execute') a, has_function_privilege('service_role', p.oid, 'execute') s, has_function_privilege('authenticated', p.oid, 'execute') u,
                exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x where x.grantee = 0) pub
           from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=$1`, [f.name]);
      expect(r.rows[0]).toEqual({ a: false, s: false, u: true, pub: false });
    });
  }
});

// ---------------------------------------------------------------------------
// S6: the 13 authenticated-EXECUTE functions 0287 granted (rmin-0287-apply-20261107 c03). Reachable is not usable: a
// no-studio caller gets a refusal and no data from each one, for a real studio, a random studio and a NULL studio.
// The owner-only commands stop at `perm_actor(p_studio)` + `role <> 'owner'` and answer only {ok:false, code:'refused'};
// has_studio_permission answers false. Also pins that the granted set is EXACTLY these 13 (0331 and 0332 grant nothing).
// ---------------------------------------------------------------------------
describe("S6: the 0287 Roles-engine functions refuse a no-studio user and leak nothing", () => {
  const REFUSED = JSON.stringify({ ok: false, code: "refused" });
  const lit = (studio: string | null) => (studio === null ? "null::uuid" : `'${studio}'::uuid`);
  type Cmd = { name: string; sql: (st: string | null) => string; expect: string };
  const ZERO = "'00000000-0000-0000-0000-000000000000'::uuid";
  const CMDS: Cmd[] = [
    { name: "has_studio_permission", sql: (st) => `select public.has_studio_permission(${lit(st)}, 'appt.cancel', null, null, null) r`, expect: "false" },
    { name: "preview_role_changes", sql: (st) => `select public.preview_role_changes(${lit(st)}, '[]'::jsonb) r`, expect: REFUSED },
    { name: "save_role_permissions", sql: (st) => `select public.save_role_permissions(${lit(st)}, 0, '[]'::jsonb, 'probe', false) r`, expect: REFUSED },
    { name: "preview_reset", sql: (st) => `select public.preview_reset(${lit(st)}, 'practitioner') r`, expect: REFUSED },
    { name: "reset_role_to_defaults", sql: (st) => `select public.reset_role_to_defaults(${lit(st)}, 'practitioner', 0, 'probe', false) r`, expect: REFUSED },
    { name: "preview_adopt_new_defaults", sql: (st) => `select public.preview_adopt_new_defaults(${lit(st)}) r`, expect: REFUSED },
    { name: "adopt_new_defaults", sql: (st) => `select public.adopt_new_defaults(${lit(st)}, 0, 'probe', false) r`, expect: REFUSED },
    { name: "get_role_permissions", sql: (st) => `select public.get_role_permissions(${lit(st)}) r`, expect: REFUSED },
    { name: "preview_activation", sql: (st) => `select public.preview_activation(${lit(st)}, array[]::text[]) r`, expect: REFUSED },
    { name: "activate_released_permissions", sql: (st) => `select public.activate_released_permissions(${lit(st)}, array[]::text[], 0, 'probe', 'x', false) r`, expect: REFUSED },
    { name: "effective_access", sql: (st) => `select public.effective_access(${lit(st)}, ${ZERO}) r`, expect: REFUSED },
    { name: "list_permission_audit", sql: (st) => `select public.list_permission_audit(${lit(st)}, 10, null) r`, expect: REFUSED },
    { name: "change_staff_role", sql: (st) => `select public.change_staff_role(${lit(st)}, ${ZERO}, 'receptionist', 'practitioner', 'probe') r`, expect: REFUSED },
  ];

  it("the 13 are executable by authenticated, and NO other perm_* helper is (0331 and 0332 replace helpers and grant nothing)", async () => {
    const granted = (await adminQuery(
      `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = any($1::text[]) and has_function_privilege('authenticated', p.oid, 'execute')
        order by 1`, [CMDS.map((c) => c.name)])).rows.map((r: J) => r.proname as string);
    expect(granted).toEqual(CMDS.map((c) => c.name).sort());
    const helpers = (await adminQuery(
      `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname like 'perm\\_%'
          and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute')
               or has_function_privilege('service_role', p.oid, 'execute'))
        order by 1`)).rows.map((r: J) => r.proname as string);
    expect(helpers, "perm_base_scope, perm_scope_source, perm_activation_hash and every other perm_* helper stay closed").toEqual([]);
  });

  for (const c of CMDS) {
    it(`${c.name}: a no-studio caller is refused for a real, a random and a NULL studio, with no data and no studio id echoed`, async () => {
      for (const st of [A.studioId, randomUUID(), null]) {
        const out = await asJwt(S, async (q) => {
          await q("savepoint s6");
          try {
            const r = await q(c.sql(st));
            return JSON.stringify(r.rows[0].r);
          } finally { await q("rollback to savepoint s6"); }
        });
        expect(out, `${c.name}(${st === null ? "null" : "studio"})`).toBe(c.expect);
        expect(out).not.toContain(A.studioId);
      }
    });
  }
});
