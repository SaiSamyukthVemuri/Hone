import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { Client } from "pg";
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
      return !/auth\.uid\(\)|is_studio_member|is_studio_owner|studio_id|current_studio|jwt/.test(e);
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
  const results: J[] = [];
  for (const f of fns) {
    const args: string[] = [];
    for (const ty of f.types) args.push(lit(await typeName(ty)));
    const call = `select public.${f.proname}(${args.join(",")}) r`;
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
    const reachableTables = tables.filter((t) => {
      const p = t.strangerProbes as Record<string, string>;
      return rowsSeen(p.select ?? "") || (p.insert ?? "").startsWith("ok:") || (t.beforeInsertTriggers === 0 && /^err:(23502|23503|23505|23514)$/.test(p.insert ?? "")) || wroteRows(p.update ?? "") || wroteRows(p.delete ?? "");
    });
    // A constraint error on insert where a BEFORE trigger exists: neither reached nor refused.
    const insertIndeterminate = tables
      .filter((t) => t.beforeInsertTriggers > 0 && /^err:23\d\d\d$/.test((t.strangerProbes as Record<string, string>).insert ?? ""))
      .map((t) => t.table as string);
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
    // Policies on granted tables that call NO membership helper at all (stricter than the
    // per-table list below, which also accepts a bare studio_id or jwt mention).
    const noHelper = (
      await adminQuery(
        `select schemaname||'.'||tablename||' '||policyname||' ['||cmd||']' p from pg_policies
          where schemaname in ('public','storage')
            and (roles::text like '%authenticated%' or roles::text like '%public%')
            and coalesce(qual,'')||' '||coalesce(with_check,'') !~ '(is_studio_member|is_studio_owner|can_[a-z_]+|auth[.]uid[(][)]|is_platform_admin)'
          order by 1`,
      )
    ).rows.map((r: J) => r.p as string);
    report = {
      generatedAt: new Date().toISOString(),
      counts: { functionsProbed: fns.length, functionsReachable: reachableFns.length, tablesGranted: tables.length, tablesReachable: reachableTables.length },
      functionsReachable: reachableFns,
      functionsReachableNoIdentityCheck: reachableFns.filter((f) => !f.bodyChecksIdentity && f.secdef),
      tablesReachable: reachableTables,
      unconditionalPolicies: unconditional,
      policiesWithoutMembershipHelper: noHelper,
      insertIndeterminateBeforeTrigger: insertIndeterminate,
      claim:
        "No table showed a visible or writable row to a no-studio user in the SEEDED LOCAL FIXTURE; the policies listed under unconditionalPolicies carry a literal-true predicate. This is not a proof about hosted data, and the report is NOT scrubbed.",
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
    const out = process.env.HONE_CENSUS_OUT;
    if (out) writeFileSync(out, JSON.stringify(report, null, 1));
    console.log(`NO-STUDIO CENSUS counts: ${JSON.stringify(report.counts)}`);
  });

  it("every own-identity RPC raises, or leaves no row owned by a no-studio user", () => {
    expect(report.ownIdentity.length, "the own-identity family must be non-empty or this proves nothing").toBeGreaterThan(2);
    const bad = report.ownIdentity.filter((r: J) => /^(LEAK|CHECK-ERROR)/.test(String(r.verdict)));
    expect(bad, "own-identity RPCs that keep data for a user with no studio, or a check that could not run").toEqual([]);
    // Anti-vacuity: at least one must have actually run to completion and been counted.
    expect(report.ownIdentity.some((r: J) => r.verdict === "ok-no-owned-rows"), "no own-identity call ran to the leak check").toBe(true);
  });

  it("pins the reachable set (skipped in report mode)", () => {
    if (process.env.HONE_CENSUS_REPORT === "1") return;
    const names = [
      ...report.functionsReachable.map((f: J) => `fn ${f.fn}`),
      ...report.tablesReachable.map((t: J) => `tbl ${t.table}`),
      ...report.unconditionalPolicies.map((p: string) => `policy ${p}`),
      ...report.policiesWithoutMembershipHelper.map((p: string) => `nohelper ${p}`),
      ...report.insertIndeterminateBeforeTrigger.map((t: string) => `insert-indeterminate ${t}`),
    ].sort();
    // Services the CI db lane does not start (-x realtime,storage-api in ci.yml) have no
    // such functions; their pin is asserted only when the service is present.
    const present = report.servicesPresent as Record<string, boolean>;
    const svcOf = (n: string) => (/^fn storage\./.test(n) ? "storage" : /^fn realtime\./.test(n) ? "realtime" : null);
    const skipped = Object.entries(present).filter(([, v]) => !v).map(([k]) => k);
    for (const k of skipped) console.log(`${k}: SKIPPED_NOT_IN_STACK (its functions are not asserted here)`);
    const inScope = (n: string) => { const sv = svcOf(n); return sv === null || present[sv]; };
    expect(names.filter(inScope), "reachable-by-a-no-studio-user set changed; review every added item").toEqual(PINNED.filter(inScope).sort());
    // A missing service must never HIDE a reachable function: nothing from a skipped schema may appear.
    expect(names.filter((n) => !inScope(n)), "a function appeared in a schema the stack says is absent").toEqual([]);
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
// No other table showed a visible or writable row in the seeded local fixture. Storage is deferred to the
// hosted catalog read. A NEW entry fails this test and must be reviewed.
const PINNED: string[] = [
  "fn graphql_public.graphql(\"operationName\" text, query text, variables jsonb, extensions jsonb)",
  "fn public.appointment_transition_allowed(p_old_status text, p_new_status text)",
  "fn public.archive_treatment_image(p_image_id uuid, p_client_id uuid)",
  "fn public.audit_actor_is_caller(target_actor_id uuid, target_studio_id uuid)",
  "fn public.can_read_client_legal_identity(target_studio_id uuid)",
  "fn public.can_use_client_legal_identity(target_studio_id uuid)",
  "fn public.edit_client_pinned_note(p_studio_id uuid, p_client_id uuid, p_note_id uuid, p_original_text text, p_text text)",
  "fn public.is_studio_member(target_studio_id uuid)",
  "fn public.is_studio_owner(target_studio_id uuid)",
  "fn public.latest_setup_for_client(p_studio_id uuid, p_client_id uuid, p_exclude_session_id uuid)",
  "fn public.member_owns_scoped_timed_block(p_studio_id uuid, p_practitioner_id uuid)",
  "fn public.my_pending_invitation()",
  "fn public.receptionist_cancel_appointment(p_studio_id uuid, p_appointment_id uuid, p_reason text)",
  "fn public.receptionist_create_appointment(p_studio_id uuid, p_target_practitioner_id uuid, p_client_id uuid, p_service_id uuid, p_starts_at tim",
  "fn public.receptionist_move_appointment(p_studio_id uuid, p_appointment_id uuid, p_target_practitioner_id uuid, p_expected_starts_at timestamp ",
  "fn public.reconcile_my_pending_invitation()",
  "fn public.record_appointment_settlement(p_studio_id uuid, p_appointment_id uuid, p_method text, p_amount_cents integer, p_note text, p_livemode",
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
  "tbl public.demo_requests",
  "tbl public.waitlist",
  "nohelper public.demo_requests demo_requests_anonymous_insert [INSERT]",
  "nohelper public.electrolysis_entries electrolysis_entries: members insert [INSERT]",
  "nohelper public.electrolysis_entries electrolysis_entries: members select [SELECT]",
  "nohelper public.electrolysis_entries electrolysis_entries: members update [UPDATE]",
  "nohelper public.laser_entries laser_entries: members insert [INSERT]",
  "nohelper public.laser_entries laser_entries: members select [SELECT]",
  "nohelper public.laser_entries laser_entries: members update [UPDATE]",
  "nohelper public.machine_profile_field_contract machine_profile_field_contract_read [SELECT]",
  "nohelper public.machine_profile_mode_contract machine_profile_mode_contract_read [SELECT]",
  "nohelper public.studio_timed_blocks studio_timed_blocks_member_delete_own [DELETE]",
  "nohelper public.studio_timed_blocks studio_timed_blocks_member_insert [INSERT]",
  "nohelper public.studio_timed_blocks studio_timed_blocks_member_update_own [UPDATE]",
  "nohelper public.waitlist waitlist_anonymous_insert [INSERT]",
  "insert-indeterminate public.clients",
  "insert-indeterminate public.payment_charge_attempts",
  "insert-indeterminate public.service_practitioners",
  "insert-indeterminate public.stripe_account_provisioning_attempts"
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
  type Call = { name: string; args: string; ownerCode: string; layers: Array<{ label: string; re: RegExp }> };
  const CALLS: Call[] = [
    { name: "record_appointment_settlement", args: `'%S'::uuid, '${randomUUID()}'::uuid, 'paid_cash', 1000, null, false`, ownerCode: "owner_only",
      layers: [{ label: "membership", re: /v_practitioner := public\.session_actor_practitioner\(p_studio_id\);/ }, { label: "owner", re: /if not public\.is_studio_owner\(p_studio_id\) then/ }] },
    { name: "supersede_appointment_settlement", args: `'%S'::uuid, '${randomUUID()}'::uuid, 'paid_cash', 1000, 'valid reason', null, false`, ownerCode: "not_owner",
      layers: [{ label: "membership", re: /v_practitioner := public\.session_actor_practitioner\(p_studio_id\);/ }, { label: "owner", re: /if not public\.is_studio_owner\(p_studio_id\) then/ }] },
    { name: "set_new_client_admission_mode", args: `'%S'::uuid, 'waitlist'`, ownerCode: "not_authorized",
      layers: [{ label: "owner", re: /if not public\.is_studio_owner\(p_studio_id\) then/ }] },
  ];
  const sqlFor = (c: Call) => `select (public.${c.name}(${c.args.replace("%S", A.studioId)})).* `;
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
      const owner = await run(A.userId, c);
      expect(isRefusal(c, stranger), `stranger outcome: ${stranger}`).toBe(true);
      expect(stranger).not.toMatch(/invalid/);
      expect(isRefusal(c, owner), `control: owner outcome ${owner}`).toBe(false);
      expect(owner).not.toMatch(/^invalid/);
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
      expect(isRefusal(c, none), `with every check removed the stranger got: ${none}`).toBe(false);
      // The real function is unchanged after the rollback.
      expect(isRefusal(c, await run(S, c))).toBe(true);
      void owner;
    });
  }
});
