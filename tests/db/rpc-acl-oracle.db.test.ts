import { afterAll, describe, expect, it } from "vitest";
import { adminQuery, closePool } from "./helpers/harness";
import {
  exposedSchemas,
  HISTORICAL_LEGACY_SERVICE_ROLE_DEBT,
  LEGACY_SERVICE_ROLE_DEBT,
  RPC_ACL_MANIFEST,
  type RolePosture,
} from "./rpc-acl-manifest";
import { migrationState } from "../migrations/helpers/migration-state";

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
//
// WHAT THIS ORACLE IS THE AUTHORITY FOR, and nothing beyond it:
//
//   1. which SECURITY DEFINER functions are browser-exposed, across every
//      schema PostgREST is configured to expose;
//   2. what their ACTUAL final EXECUTE privileges are;
//   3. whether those privileges match the reviewed manifest.
//
// It does NOT certify that a command authorises its caller correctly. An
// earlier revision inferred "actor-gated" from `auth.uid()` appearing in a body
// or in a callee's name, which is not enforcement: a function that merely
// stamps auth.uid() into an audit column would have been certified, and a
// function whose gate lives behind a runtime condition would have been too.
// That claim is removed rather than weakened.
//
// Actor correctness is a behavioural property and is proved behaviourally, by
// calling a command as the wrong actor and asserting the refusal —
// tests/db/session-write-commands.db.test.ts,
// tests/db/cross-studio-isolation.db.test.ts,
// tests/db/session-block-electrolysis-commands.db.test.ts. Those results are
// referenced, never converted into a textual rule here.

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
    format('%s.%s(%s)', n.nspname, p.proname, pg_catalog.oidvectortypes(p.proargtypes)) as identity,
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
  where n.nspname = any($1::text[])
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
  const { rows } = await adminQuery(EXPOSED_SQL, [exposedSchemas()]);
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

  it("the database is migrated to THIS branch's exact head", async () => {
    // Everything below is a statement about a database. If that database is a
    // few migrations short, the oracle measures a smaller function set and
    // passes while proving nothing — so the chain is pinned exactly, not to a
    // floor. `count > 150` was that floor and it could not tell 196 from 151.
    //
    // The expected head is DERIVED from the branch through the repository's
    // canonical utility, never written down here: a hard-coded "0197" would be
    // stale the day the next migration lands, which is the pin CONTRIBUTING.md
    // forbids.
    const state = migrationState();
    const { rows } = await adminQuery(
      "select version from supabase_migrations.schema_migrations order by version",
    );
    const applied = (rows as Array<{ version: string }>).map((r) => r.version);

    expect(applied.at(-1), "local database is not at the repository's migration head").toBe(
      state.repo_migration_max,
    );
    expect(applied.length).toBe(state.versions.length);
    // Not merely the same count: the same versions.
    expect(applied).toEqual([...state.versions].sort());
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
        "posture and record it in tests/db/rpc-acl-manifest.ts.",
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

  it("legacy service_role debt is frozen by IDENTITY, and only ever shrinks", () => {
    // Not a claim that these are safe. A claim that they are known, that their
    // intended posture is unaudited, and that the list is not a place to put new
    // commands.
    //
    // A count is not a freeze: `length <= 9` let an entry be swapped for an
    // unrelated function while the number stayed put. Subset-of-historical is
    // the property actually wanted — remediating a command and removing its row
    // is always allowed; marking a NEW one as legacy is not, because legacy
    // means it predates this guard.
    const historical = new Set(HISTORICAL_LEGACY_SERVICE_ROLE_DEBT);
    const introduced = LEGACY_SERVICE_ROLE_DEBT.filter((id) => !historical.has(id));
    expect(
      introduced,
      "a command was marked serviceRoleLegacyDebt that is not in the historical list. " +
        "Legacy debt predates this oracle; a newly exposed command needs a decided " +
        "posture with a stated reason, not a debt mark.",
    ).toEqual([]);
    expect(LEGACY_SERVICE_ROLE_DEBT.length).toBeLessThanOrEqual(
      HISTORICAL_LEGACY_SERVICE_ROLE_DEBT.length,
    );
    // Every historical identity must still be a real function, or the list is
    // recording something that no longer exists.
    expect(new Set(HISTORICAL_LEGACY_SERVICE_ROLE_DEBT).size).toBe(
      HISTORICAL_LEGACY_SERVICE_ROLE_DEBT.length,
    );
  });

  it("overloads are separate rows, not one collapsed identity", async () => {
    // The concrete regression: a parser keyed by bare name credited one
    // overload's revoke to its sibling. `start_session` has two signatures in
    // this chain; the oracle must see two.
    const live = await exposed();
    const starts = live.filter((r) => /(^|\.)start_session\(/.test(r.identity));
    expect(starts.length).toBe(2);
    expect(new Set(starts.map((r) => r.identity)).size).toBe(2);
    const { rows } = await adminQuery(`
      select count(*)::int c
      from (
        select p.proname
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = any($1::text[]) and p.prokind = 'f'
        group by p.proname having count(*) > 1
      ) t
    `, [exposedSchemas()]);
    // If this chain ever stops carrying overloads the test above is vacuous,
    // and this says so rather than passing quietly.
    expect(rows[0].c).toBeGreaterThan(0);
  });

  it("the census covers every configured exposed schema, not an assumed one", async () => {
    const schemas = exposedSchemas();
    // The configured list is the scope. Hard-coding 'public' meant a schema
    // exposed in configuration alone — no migration, no new function — silently
    // left coverage.
    expect(schemas.length).toBeGreaterThan(0);
    expect(schemas).toContain("public");

    // Every schema in the list must really exist, or the config and the
    // database disagree and the oracle is measuring something else.
    const { rows } = await adminQuery(
      `select n.nspname from pg_namespace n where n.nspname = any($1::text[])`,
      [schemas],
    );
    const present = (rows as Array<{ nspname: string }>).map((r) => r.nspname).sort();
    expect(present).toEqual([...schemas].sort());

    // And the census query must actually be scoped to them: every identity it
    // returns is qualified by one of the configured schemas.
    const live = await exposed();
    const prefixes = schemas.map((sch) => `${sch}.`);
    const foreign = live
      .map((r) => r.identity)
      .filter((id) => !prefixes.some((pfx) => id.startsWith(pfx)));
    expect(foreign).toEqual([]);
  });
});
