import { afterAll, describe, expect, it } from "vitest";
import { adminQuery, closePool } from "./helpers/harness";
import {
  LEGACY_SERVICE_ROLE_DEBT,
  RPC_ACL_MANIFEST,
  type RolePosture,
} from "./rpc-acl-manifest";

// ===========================================================================
// The repo-wide ACL authority: PostgreSQL interpreting PostgreSQL
// ===========================================================================
//
// This replaces a static migration-text parser. That parser was not merely
// incomplete — it was unsound in principle. Deciding whether a REVOKE inside
// one of this chain's 39 conditional DO blocks actually ran requires executing
// it, and matching a loop's signature array to a declaration requires
// reimplementing PostgreSQL's own identity-argument normalisation.
//
// Everything that made the parser wrong disappears here rather than being
// fixed:
//
//   * final state       — the catalog holds the ACL after every migration ran,
//                         so a later GRANT that re-opens a revoked function is
//                         simply visible (the parser reported it closed);
//   * overloads         — rows are keyed by OID and reported by argument types,
//                         so start_session's two signatures are two rows;
//   * DO-block loops    — already executed, conditionals included, with no
//                         cross-attribution to invent;
//   * function bodies   — pg_get_functiondef returns exactly the body.
//
// The test asks the database what is true and compares it to a reviewed
// manifest. It never reconstructs ACL state from migration text.

type Row = {
  identity: string;
  is_public: boolean;
  anon: boolean;
  authenticated: boolean;
  service_role: boolean;
};

/**
 * Every directly-callable SECURITY DEFINER function a browser role can reach.
 *
 * `prokind='f'` excludes procedures and aggregates; a `returns trigger`
 * function cannot be invoked directly at all (PostgreSQL raises 0A000), so an
 * EXECUTE grant on one is inert and excluding it is a statement about
 * reachability, not convenience.
 *
 * PUBLIC is read from the ACL itself — has_function_privilege has no role named
 * PUBLIC. A NULL proacl means the default is in force, which includes EXECUTE
 * to PUBLIC, so NULL counts as exposed.
 */
const EXPOSED_SQL = `
  select
    format('public.%s(%s)', p.proname, pg_catalog.oidvectortypes(p.proargtypes)) as identity,
    (
      p.proacl is null
      or exists (
        select 1 from aclexplode(p.proacl) a
         where a.grantee = 0 and a.privilege_type = 'EXECUTE'
      )
    ) as is_public,
    has_function_privilege('anon', p.oid, 'EXECUTE')          as anon,
    has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
    has_function_privilege('service_role', p.oid, 'EXECUTE')  as service_role
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prokind = 'f'
    and p.prosecdef
    and pg_get_function_result(p.oid) <> 'trigger'
    and (
      p.proacl is null
      or exists (
        select 1 from aclexplode(p.proacl) a
         where a.grantee = 0 and a.privilege_type = 'EXECUTE'
      )
      or has_function_privilege('anon', p.oid, 'EXECUTE')
      or has_function_privilege('authenticated', p.oid, 'EXECUTE')
    )
  order by identity
`;

async function exposed(): Promise<Row[]> {
  const { rows } = await adminQuery(EXPOSED_SQL);
  return rows as Row[];
}

function postureOf(r: Row): RolePosture {
  return {
    public: r.is_public,
    anon: r.anon,
    authenticated: r.authenticated,
    serviceRole: r.service_role,
  };
}

describe("RPC ACL oracle — real migrated privileges vs the reviewed manifest", () => {
  afterAll(async () => {
    await closePool();
  });

  it("the migration chain is fully applied", async () => {
    // Without this, every assertion below could pass against a half-built
    // database that simply has fewer functions to disagree about.
    const { rows } = await adminQuery(
      "select count(*)::int c from supabase_migrations.schema_migrations",
    );
    expect(rows[0].c).toBeGreaterThan(150);
    const fns = await adminQuery(`
      select count(*)::int c from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.prokind = 'f' and p.prosecdef
    `);
    expect(fns.rows[0].c).toBeGreaterThan(150);
  });

  it("every browser-reachable command is in the reviewed manifest", async () => {
    const live = await exposed();
    const known = new Set(RPC_ACL_MANIFEST.map((e) => e.identity));
    const unreviewed = live.map((r) => r.identity).filter((i) => !known.has(i));
    expect(
      unreviewed,
      "a SECURITY DEFINER command became reachable by a browser role without a reviewed " +
        "manifest entry. Supabase's ALTER DEFAULT PRIVILEGES grants EXECUTE to anon and " +
        "authenticated at create time, so this is the default, not a choice. Decide the " +
        "posture and record it in tests/db/helpers/rpc-acl-manifest.ts.",
    ).toEqual([]);
  });

  it("the manifest has no entries for commands that no longer exist", async () => {
    const live = new Set((await exposed()).map((r) => r.identity));
    const stale = RPC_ACL_MANIFEST.map((e) => e.identity).filter((i) => !live.has(i));
    expect(stale, "manifest rows with no live counterpart — stale review state").toEqual([]);
  });

  it("the REAL privileges equal the reviewed expectation, per overload", async () => {
    const live = await exposed();
    const want = new Map(RPC_ACL_MANIFEST.map((e) => [e.identity, e.posture]));
    const drift: string[] = [];
    for (const r of live) {
      const expected = want.get(r.identity);
      if (!expected) continue; // reported by the coverage test above
      const actual = postureOf(r);
      for (const role of ["public", "anon", "authenticated", "serviceRole"] as const) {
        if (actual[role] !== expected[role]) {
          drift.push(`${r.identity}: ${role} is ${actual[role]}, manifest says ${expected[role]}`);
        }
      }
    }
    expect(drift).toEqual([]);
  });

  it("anon execution is never silent — every anon-executable command states why", () => {
    const anon = RPC_ACL_MANIFEST.filter((e) => e.posture.anon || e.posture.public);
    for (const e of anon) {
      expect(e.anonWhy, `${e.identity} allows anon and must say why`).toBeTruthy();
      expect(e.anonWhy!.length).toBeGreaterThan(30);
    }
    // Small by construction: anon reaching a definer function is exceptional.
    expect(anon.length).toBeLessThanOrEqual(3);
  });

  it("service_role execution is either justified or carried as named debt", () => {
    for (const e of RPC_ACL_MANIFEST.filter((x) => x.posture.serviceRole)) {
      const decided = Boolean(e.serviceRoleWhy) || e.serviceRoleLegacyDebt === true;
      expect(decided, `${e.identity} allows service_role with neither a reason nor a debt mark`).toBe(true);
    }
  });

  it("the legacy service_role debt is frozen and cannot grow", () => {
    // Not a claim that these are safe. A claim that they are known, that their
    // intended posture is unaudited, and that the list is not a place to put
    // new commands.
    expect(LEGACY_SERVICE_ROLE_DEBT.length).toBeLessThanOrEqual(9);
    expect(LEGACY_SERVICE_ROLE_DEBT.length).toBeGreaterThan(0);
  });

  it("overloads are separate rows, not one collapsed identity", async () => {
    // The concrete regression: a parser keyed by bare name credited one
    // overload's revoke to its sibling. `start_session` has two signatures in
    // this chain; the oracle must see two.
    const live = await exposed();
    const starts = live.filter((r) => r.identity.startsWith("public.start_session("));
    expect(starts.length).toBe(2);
    expect(new Set(starts.map((r) => r.identity)).size).toBe(2);
    const { rows } = await adminQuery(`
      select count(*)::int c
      from (
        select p.proname
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.prokind = 'f'
        group by p.proname having count(*) > 1
      ) t
    `);
    // If this chain ever stops carrying overloads the test above is vacuous,
    // and this says so rather than passing quietly.
    expect(rows[0].c).toBeGreaterThan(0);
  });

  it("helper-mediated actor gating is still resolved, per overload", async () => {
    // The classification the static guard existed for. Every input comes from
    // the catalog — OID, identity, and the real body via pg_get_functiondef —
    // so nothing is reconstructed from migration text. Only the graph closure
    // runs here, because PostgreSQL forbids a recursive CTE reference inside a
    // subquery and the "every overload of the callee is gated" rule needs one.
    //
    // The rule is deliberately conservative: a caller counts as gated only when
    // some callee name has ALL of its overloads gated. An ambiguous name can
    // therefore never certify a command as safe, which is the direction an
    // overload mistake must fail in.
    const { rows } = await adminQuery(`
      select p.oid::int8::text as oid,
             p.proname,
             format('public.%s(%s)', p.proname, pg_catalog.oidvectortypes(p.proargtypes)) as identity,
             pg_get_functiondef(p.oid) as def,
             p.prosecdef as definer,
             (pg_get_function_result(p.oid) = 'trigger') as is_trigger,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.prokind = 'f'
    `);
    type F = {
      oid: string; proname: string; identity: string; def: string;
      definer: boolean; is_trigger: boolean; authenticated: boolean;
    };
    const fns = rows as F[];
    const byName = new Map<string, F[]>();
    for (const f of fns) {
      const bucket = byName.get(f.proname) ?? [];
      bucket.push(f);
      byName.set(f.proname, bucket);
    }

    const gated = new Set<string>(
      fns.filter((f) => /auth\.uid\(\)/i.test(f.def)).map((f) => f.oid),
    );
    // Callee names each function mentions, computed once.
    const mentions = new Map<string, string[]>();
    for (const f of fns) {
      const hit: string[] = [];
      for (const name of byName.keys()) {
        if (name === f.proname) continue;
        if (new RegExp(`\\b(?:public\\.)?${name}\\s*\\(`).test(f.def)) hit.push(name);
      }
      mentions.set(f.oid, hit);
    }
    for (let changed = true; changed; ) {
      changed = false;
      for (const f of fns) {
        if (gated.has(f.oid)) continue;
        for (const name of mentions.get(f.oid) ?? []) {
          const overloads = byName.get(name) ?? [];
          if (overloads.length > 0 && overloads.every((o) => gated.has(o.oid))) {
            gated.add(f.oid);
            changed = true;
            break;
          }
        }
      }
    }

    const ungated = fns
      .filter((f) => f.definer && !f.is_trigger && f.authenticated && !gated.has(f.oid))
      .map((f) => f.identity)
      .sort();
    expect(
      ungated,
      "a browser-callable SECURITY DEFINER command whose authority reaches auth.uid() by " +
        "no path at all — its actor would come only from its arguments.",
    ).toEqual([]);

    // Non-vacuity: the closure must actually be doing work, not marking
    // everything gated by accident.
    expect(gated.size).toBeGreaterThan(20);
    expect(gated.size).toBeLessThan(fns.length);
  });
});
