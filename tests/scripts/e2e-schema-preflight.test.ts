import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  assertLoopbackDatabase,
  compareMigrationState,
  fingerprintMigrationState,
  fingerprintDatabaseState,
  formatIncarnation,
  formatPreflightFailure,
  SCHEMA_FINGERPRINT_ENV,
  type DatabaseIncarnation,
  type LocalDatabaseState,
  type MigrationIdentity,
} from "../../e2e/helpers/schema-preflight";

// ===========================================================================
// E2E schema preflight — fail-closed proofs
// ===========================================================================
//
// The comparator is PURE, so every branch below is provable with no Docker, no
// Postgres and no browser. That is what makes the negative control cheap enough
// to keep rather than delete the first time it is inconvenient.
//
// The guard exists because a shared local Supabase stack let one worktree's
// application be tested against another worktree's schema and report green.
// These tests pin the behaviour that makes that impossible.

function read(rel: string): string {
  return readFileSync(path.resolve(__dirname, "../..", rel), "utf8");
}

const m = (version: string, name: string): MigrationIdentity => ({ version, name });

const BROWSER_CONFIGS = [
  "playwright.config.ts",
  "playwright.payment.config.ts",
  "playwright.mobile.config.ts",
  "playwright.google.config.ts",
];

describe("1. compatible state passes", () => {
  it("identical migration sets pass", () => {
    const set = [m("0001", "init"), m("0002", "clients"), m("0003", "appointments")];
    const v = compareMigrationState(set, [...set]);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.matched).toBe(3);
  });

  it("order does not matter — the comparison is by identity, not by sequence", () => {
    const checkout = [m("0001", "init"), m("0002", "clients")];
    const local = [m("0002", "clients"), m("0001", "init")];
    expect(compareMigrationState(checkout, local).ok).toBe(true);
  });
});

describe("2. local database ahead of the checkout fails closed", () => {
  it("a migration the checkout does not define is refused", () => {
    const checkout = [m("0001", "init"), m("0002", "clients")];
    const local = [...checkout, m("0003", "another_branches_feature")];
    const v = compareMigrationState(checkout, local);

    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.codes).toContain("LOCAL_AHEAD_OF_CHECKOUT");
    expect(v.localOnly).toEqual([m("0003", "another_branches_feature")]);
  });

  it("this is the exact shape the audit observed on the shared stack", () => {
    // Recorded as a SHAPE, deliberately parameterised: a checkout of N, a
    // database of N+1, and the extra one named by another lane. The numbers
    // below are fixtures for the shape, not the repository's real state — see
    // test 7, which forbids encoding real migration numbers in the guard.
    const checkout = Array.from({ length: 5 }, (_, i) =>
      m(String(i + 1).padStart(4, "0"), `migration_${i + 1}`),
    );
    const local = [...checkout, m("0006", "unmerged_lane_feature")];
    const v = compareMigrationState(checkout, local);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.localOnly.map((x) => x.version)).toEqual(["0006"]);
  });
});

describe("3. checkout ahead of the local database fails closed", () => {
  it("a migration the database has not applied is refused", () => {
    const checkout = [m("0001", "init"), m("0002", "clients"), m("0003", "new_feature")];
    const local = [m("0001", "init"), m("0002", "clients")];
    const v = compareMigrationState(checkout, local);

    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.codes).toContain("CHECKOUT_AHEAD_OF_LOCAL");
    expect(v.missingLocally).toEqual([m("0003", "new_feature")]);
  });
});

describe("4. unknown state fails closed, never open", () => {
  it("an empty checkout is unknown, not compatible", () => {
    const v = compareMigrationState([], [m("0001", "init")]);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.codes).toContain("STATE_UNAVAILABLE");
  });

  it("an empty database is unknown, not compatible", () => {
    const v = compareMigrationState([m("0001", "init")], []);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.codes).toContain("STATE_UNAVAILABLE");
  });

  it("both empty is unknown, not 'trivially equal'", () => {
    // The seductive bug: two empty sets ARE equal, and a set-equality guard
    // would pass them. Nothing has been verified in that case.
    const v = compareMigrationState([], []);
    expect(v.ok).toBe(false);
  });

  it("an unreadable database surfaces as a failure with an actionable reason", () => {
    const msg = formatPreflightFailure(
      { lane: "browser e2e (local stack)", databaseUrl: "postgresql://x@127.0.0.1:54322/postgres" },
      { branch: "feat/x", sha: "abc1234", checkoutCount: 5, localCount: 0 },
      {
        ok: false,
        codes: ["STATE_UNAVAILABLE"],
        localOnly: [],
        missingLocally: [],
        identityMismatches: [],
        unavailableReason: "the local database could not be read. Is the local Supabase stack running (supabase start)?",
      },
    );
    expect(msg).toContain("E2E SCHEMA PREFLIGHT FAILED");
    expect(msg).toContain("could not be read");
    expect(msg).toContain("Do not continue browser E2E against this stack.");
  });
});

describe("5. no hosted database is reachable through this path", () => {
  it("hosted host patterns are refused", () => {
    for (const url of [
      "postgresql://u:p@db.abcdefgh.supabase.co:5432/postgres",
      "postgresql://u:p@aws-0-us-east-1.pooler.supabase.com:6543/postgres",
      "postgresql://u:p@x.rds.amazonaws.com:5432/postgres",
      "postgresql://u:p@ep-x.neon.tech/postgres",
    ]) {
      expect(() => assertLoopbackDatabase(url, "test")).toThrow(/refuses to run/);
    }
  });

  it("any non-loopback host is refused even without a known hosted pattern", () => {
    expect(() => assertLoopbackDatabase("postgresql://u:p@10.0.0.5:5432/postgres", "test")).toThrow(
      /not loopback/,
    );
    expect(() => assertLoopbackDatabase("postgresql://u:p@db.internal:5432/postgres", "test")).toThrow(
      /not loopback/,
    );
  });

  it("loopback is permitted", () => {
    expect(() =>
      assertLoopbackDatabase("postgresql://postgres:postgres@127.0.0.1:54322/postgres", "test"),
    ).not.toThrow();
  });

  it("the lane's URL comes from the local-env LITERAL, not from an environment variable", () => {
    const setup = read("e2e/global-setup.ts");
    expect(setup).toMatch(/import \{ E2E_DB_URL \} from "\.\/helpers\/local-env"/);
    expect(setup).toMatch(/databaseUrl: E2E_DB_URL/);
    // No env read may supply the database this guard inspects.
    expect(setup).not.toMatch(/process\.env\.[A-Z_]*DB[A-Z_]*/);
  });
});

describe("6. the guard runs before any browser test can produce evidence", () => {
  it("every browser config wires the SAME globalSetup module", () => {
    for (const cfg of BROWSER_CONFIGS) {
      const src = read(cfg);
      expect(src, `${cfg} must declare globalSetup`).toMatch(/globalSetup:\s*"\.\/e2e\/global-setup"/);
    }
  });

  it("there is exactly one preflight implementation, not one per lane", () => {
    // The failure mode this forbids is four copies that drift apart. Each config
    // may only POINT at the shared module.
    for (const cfg of BROWSER_CONFIGS) {
      const src = read(cfg);
      expect(src).not.toMatch(/compareMigrationState|schema_migrations|scanMigrations/);
    }
    const setup = read("e2e/global-setup.ts");
    expect(setup).toMatch(/runSchemaPreflight/);
  });

  it("globalSetup throws rather than warning — a warning is not a guard", () => {
    const guard = read("e2e/helpers/schema-preflight.ts");
    expect(guard).toMatch(/throw new Error\(\s*\n?\s*formatPreflightFailure/);

    // No environment-variable escape hatch may exist in the LOGIC. Comments are
    // stripped first: the header documents at length that there is deliberately
    // no bypass, and an assertion that trips over the word "bypass" in the very
    // paragraph explaining its absence is testing prose, not behaviour.
    const logic = guard
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    expect(logic).not.toMatch(/SKIP_PREFLIGHT|FORCE_|BYPASS|ALLOW_MISMATCH/i);
    // and no env read at all steers the outcome
    expect(logic).not.toMatch(/process\.env/);
  });
});

describe("7. no migration number is encoded as permanent truth", () => {
  it("the guard's logic contains no quoted four-digit migration literal", () => {
    const guard = read("e2e/helpers/schema-preflight.ts");
    // Strip comments: the header narrates the observed 0201/0202 incident, and
    // narrating history is not the same as depending on it.
    const logic = guard
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    const quotedFourDigits = logic.match(/["'`]\d{4}["'`]/g) ?? [];
    expect(quotedFourDigits, `found hardcoded version literal(s): ${quotedFourDigits.join(", ")}`).toEqual([]);
  });

  it("both sides are derived at run time, and the repo side uses the canonical scanner", () => {
    const guard = read("e2e/helpers/schema-preflight.ts");
    // CLAUDE.md section 2: migration state is DERIVED. The guard must not grow a
    // second competing scanner beside scripts/migration-state.mjs.
    expect(guard).toMatch(/scripts\/migration-state\.mjs/);
    expect(guard).toMatch(/scanMigrations/);
    expect(guard).toMatch(/supabase_migrations\.schema_migrations/);
    // And it must not re-derive migrations by reading the directory itself.
    expect(guard).not.toMatch(/readdirSync/);
  });

  it("it does not consult the hosted/production record — hosted is not local", () => {
    // docs/production/migration-state.json declares HOSTED state. Using it here
    // would compare the local stack against production, which is a different
    // question and would fail every legitimate migration-first branch.
    const guard = read("e2e/helpers/schema-preflight.ts");
    expect(guard).not.toMatch(/migration-state\.json|hosted_migration_max|readCanonicalRecord/);
  });
});

describe("negative control — the guard can actually go red", () => {
  it("MUTATION: a count-only comparison would pass a set that must fail", () => {
    // If someone "simplified" the comparator to compare COUNTS (or maxima), this
    // pair would slip through: same length, same maximum version, different
    // content. It must still fail. This is the test that dies first if the
    // comparison is ever weakened.
    const checkout = [m("0001", "init"), m("0002", "clients"), m("0003", "shared_top")];
    const local = [m("0001", "init"), m("0002", "different_migration"), m("0003", "shared_top")];

    expect(checkout.length).toBe(local.length);
    expect(checkout[checkout.length - 1].version).toBe(local[local.length - 1].version);

    const v = compareMigrationState(checkout, local);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.codes).toContain("IDENTITY_MISMATCH");
      expect(v.identityMismatches).toEqual([
        { version: "0002", checkoutName: "clients", localName: "different_migration" },
      ]);
    }
  });

  it("MUTATION: a max-version-only comparison would pass a gap that must fail", () => {
    // Same maximum, same first entry, but the database is missing a middle
    // migration. A `max(version)` guard passes this; the application would then
    // query a table that does not exist.
    const checkout = [m("0001", "init"), m("0002", "middle"), m("0003", "top")];
    const local = [m("0001", "init"), m("0003", "top")];

    expect(checkout[checkout.length - 1].version).toBe(local[local.length - 1].version);

    const v = compareMigrationState(checkout, local);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.missingLocally).toEqual([m("0002", "middle")]);
  });

  it("the failure message names the offending migrations, not just a count", () => {
    const checkout = [m("0001", "init")];
    const local = [m("0001", "init"), m("0002", "someone_elses_feature")];
    const v = compareMigrationState(checkout, local);
    expect(v.ok).toBe(false);
    if (v.ok) return;

    const msg = formatPreflightFailure(
      { lane: "browser e2e (local stack)", databaseUrl: "postgresql://x@127.0.0.1:54322/postgres" },
      { branch: "feat/x", sha: "abc1234", checkoutCount: 1, localCount: 2 },
      v,
    );
    expect(msg).toContain("0002_someone_elses_feature");
    expect(msg).toContain("does not define");
    // It must tell the operator what to do, and must NOT offer to reset.
    expect(msg).toContain("will NOT reset the stack");
    expect(msg).not.toMatch(/db reset|supabase db reset/);
  });
});

describe("containment — the guard never mutates the database", () => {
  it("it issues no DDL or DML of any kind", () => {
    const guard = read("e2e/helpers/schema-preflight.ts");
    const sqlish = /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke)\s+/i;
    // Isolate the actual query text rather than prose in the header comment.
    const queries = guard.match(/"(select|insert|update|delete)[^"]*"/gi) ?? [];
    expect(queries.length).toBeGreaterThan(0);
    for (const q of queries) {
      expect(q.toLowerCase().startsWith('"select')).toBe(true);
      expect(q.replace(/^"select/i, "")).not.toMatch(sqlish);
    }
  });
});

describe("8. the run is re-verified at the END, not only at the start", () => {
  // Codex P1 at 7608081d: the preflight is a one-time snapshot, so a
  // `supabase db reset --local` from another worktree landing mid-run would go
  // unnoticed and the lane could report green against a schema it never
  // verified. This guard cannot PREVENT that without real per-worktree
  // isolation (out of scope, recorded as follow-up), but it must refuse to call
  // such a run evidence.

  it("the fingerprint is content-sensitive, not a count or a maximum", () => {
    const base = [m("0001", "init"), m("0002", "clients"), m("0003", "top")];

    // same count, same maximum, one migration swapped — the exact shape a reset
    // from a sibling branch produces.
    const swapped = [m("0001", "init"), m("0002", "other_branch"), m("0003", "top")];
    expect(fingerprintMigrationState(swapped)).not.toBe(fingerprintMigrationState(base));

    // one migration missing
    const missing = [m("0001", "init"), m("0003", "top")];
    expect(fingerprintMigrationState(missing)).not.toBe(fingerprintMigrationState(base));

    // one migration added
    const added = [...base, m("0004", "someone_elses")];
    expect(fingerprintMigrationState(added)).not.toBe(fingerprintMigrationState(base));
  });

  it("the fingerprint is stable and order-independent", () => {
    const a = [m("0001", "init"), m("0002", "clients")];
    const b = [m("0002", "clients"), m("0001", "init")];
    expect(fingerprintMigrationState(a)).toBe(fingerprintMigrationState(b));
    expect(fingerprintMigrationState(a)).toBe(fingerprintMigrationState([...a]));
  });

  it("every browser config wires the shared teardown", () => {
    for (const cfg of BROWSER_CONFIGS) {
      expect(read(cfg), `${cfg} must declare globalTeardown`).toMatch(
        /globalTeardown:\s*"\.\/e2e\/global-teardown"/,
      );
    }
  });

  it("setup and teardown share ONE env-var name, not two literals", () => {
    const setup = read("e2e/global-setup.ts");
    const teardown = read("e2e/global-teardown.ts");
    expect(setup).toMatch(/SCHEMA_FINGERPRINT_ENV/);
    expect(teardown).toMatch(/SCHEMA_FINGERPRINT_ENV/);
    // Neither may re-spell the variable name inline.
    expect(setup).not.toMatch(/"HONE_E2E_SCHEMA_FINGERPRINT"/);
    expect(teardown).not.toMatch(/"HONE_E2E_SCHEMA_FINGERPRINT"/);
    expect(SCHEMA_FINGERPRINT_ENV).toBe("HONE_E2E_SCHEMA_FINGERPRINT");
  });

  it("teardown fails the run on a changed fingerprint, and says the results are not evidence", () => {
    const teardown = read("e2e/global-teardown.ts");
    expect(teardown).toMatch(/throw new Error/);
    expect(teardown).toMatch(/NOT evidence/i);
    expect(teardown).toMatch(/changed DURING this run/);
    // It must not offer to reset, and must not pretend to prevent the reset.
    expect(teardown).not.toMatch(/db reset --local`\s*$/m);
    expect(teardown).toMatch(/cannot prevent it/);
  });

  it("teardown stays silent when the preflight never reached its PASS path", () => {
    // No fingerprint recorded means the run was already refused and reported.
    // Teardown must not invent a second, confusing failure on top of it.
    const teardown = read("e2e/global-teardown.ts");
    expect(teardown).toMatch(/if \(!expected\)/);
    expect(teardown).toMatch(/return;/);
  });

  it("the fingerprint carries no credential or connection string", () => {
    const fp = fingerprintMigrationState([m("0001", "init"), m("0002", "clients")]);
    expect(fp).toMatch(/^\d+:[0-9a-f]+$/);
    expect(fp).not.toMatch(/postgres|127\.0\.0\.1|@|:\/\//);
  });
});

// ===========================================================================
// 9. DATABASE INCARNATION — `A -> reset -> A` is still a replacement
// ===========================================================================
//
// The migration fingerprint alone answers "does the database have the same
// migrations?". That is not the question a mid-run reset poses. The most
// LIKELY reset of all — a lane resetting to the branch it already had —
// restores an identical migration set, so the fingerprint matched, the
// end-of-run check passed, and a browser run that lived through a complete
// database replacement still reported green.

/** A plausible incarnation, with named limbs so each can be moved alone. */
function incarnation(over: Partial<DatabaseIncarnation> = {}): DatabaseIncarnation {
  return {
    systemIdentifier: "7686678812421562407",
    databaseOid: "5",
    postmasterStartTime: "2026-09-18 01:19:39.885595+00",
    migrationSchemaOid: "18512",
    migrationTableOid: "18513",
    publicTableCount: "96",
    publicTableOidLow: "18520",
    publicTableOidHigh: "23676",
    publicTableOidSum: "2020304",
    ...over,
  };
}

const state = (
  migrations: MigrationIdentity[],
  over: Partial<DatabaseIncarnation> = {},
): LocalDatabaseState => ({ migrations, incarnation: incarnation(over) });

const SET_A = [m("0200", "waitlist_redeemed_unbooked_exit"), m("0201", "waitlist_exit_authority_contraction")];

describe("9. the fingerprint refuses a replaced database", () => {
  it("control 1 — same DB, same migration set: PASSES", () => {
    // Anti-vacuity for the four failing controls below: if this did not pass,
    // they would all "fail" for a reason that has nothing to do with the thing
    // being tested, and the suite would prove nothing.
    expect(fingerprintDatabaseState(state(SET_A))).toBe(
      fingerprintDatabaseState(state([...SET_A])),
    );
  });

  it("control 2 — a different migration set: FAILS", () => {
    const withExtra = [...SET_A, m("0202", "waitlist_profile_and_sms_consent_authority")];
    expect(fingerprintDatabaseState(state(SET_A))).not.toBe(
      fingerprintDatabaseState(state(withExtra)),
    );
  });

  it("control 3 — reset to the SAME migration labels, different incarnation: FAILS", () => {
    // THE DEFECT THIS WHOLE SECTION EXISTS FOR. Identical migrations, so the
    // migration half of the fingerprint is byte-identical; only the database
    // changed. Before the incarnation limb this compared EQUAL and the run
    // passed.
    const before = state(SET_A);
    const after = state([...SET_A], {
      // A reset re-applies every migration, so the recreated tables take fresh
      // OIDs from a forward-running counter — they never reuse the old ones.
      publicTableOidLow: "24000",
      publicTableOidHigh: "29000",
      publicTableOidSum: "2600000",
      migrationTableOid: "23990",
      migrationSchemaOid: "23989",
    });
    expect(fingerprintMigrationState(before.migrations)).toBe(
      fingerprintMigrationState(after.migrations),
    );
    expect(fingerprintDatabaseState(before)).not.toBe(fingerprintDatabaseState(after));
  });

  it("control 5 — A -> B -> A during the suite still fails if the incarnation moved", () => {
    // Returning to migration set A is not returning to database A. The round
    // trip is invisible to a migration-only fingerprint by construction.
    const start = state(SET_A);
    const endSameLabels = state([...SET_A], { publicTableOidSum: "9999999" });
    expect(fingerprintDatabaseState(start)).not.toBe(fingerprintDatabaseState(endSameLabels));
  });

  it("every limb of the incarnation is load-bearing", () => {
    // A limb nothing can move is decoration that makes the signal look
    // stronger than it is. Each one is moved ALONE and must change the
    // fingerprint by itself.
    const base = state(SET_A);
    const limbs: (keyof DatabaseIncarnation)[] = [
      "systemIdentifier",
      "databaseOid",
      "postmasterStartTime",
      "migrationSchemaOid",
      "migrationTableOid",
      "publicTableCount",
      "publicTableOidLow",
      "publicTableOidHigh",
      "publicTableOidSum",
    ];
    for (const limb of limbs) {
      const moved = state([...SET_A], { [limb]: "MOVED" } as Partial<DatabaseIncarnation>);
      expect(
        fingerprintDatabaseState(moved),
        `moving ${limb} alone did not change the fingerprint`,
      ).not.toBe(fingerprintDatabaseState(base));
    }
  });

  it("the incarnation is order-fixed, so it is never accidentally canonicalised", () => {
    // The migration half is deliberately order-INdependent; the incarnation
    // half must not be, or two different databases whose limbs happen to be
    // permutations of each other would collide.
    const a = formatIncarnation(incarnation({ databaseOid: "1", systemIdentifier: "2" }));
    const b = formatIncarnation(incarnation({ databaseOid: "2", systemIdentifier: "1" }));
    expect(a).not.toBe(b);
  });
});

// ===========================================================================
// 10. THE SNAPSHOT THAT PASSED IS THE SNAPSHOT RECORDED
// ===========================================================================
describe("10. control 4 — a reset between proof and recording cannot be accepted", () => {
  const preflight = read("e2e/helpers/schema-preflight.ts");
  const setup = read("e2e/global-setup.ts");
  const teardown = read("e2e/global-teardown.ts");

  it("the verdict carries the validated snapshot", () => {
    expect(preflight).toMatch(/ok:\s*true;\s*matched:\s*number;\s*state:\s*LocalDatabaseState/);
    expect(preflight).toMatch(/return \{ ok: true, matched: verdict\.matched, state \};/);
  });

  it("globalSetup fingerprints THAT snapshot and never re-reads", () => {
    // The race, stated as code: a second read here would be a different
    // observation of a shared database, and a reset landing between them would
    // be validated in the first and recorded in the second.
    expect(setup).toContain("fingerprintDatabaseState(verdict.state)");
    expect(setup).not.toContain("readLocalMigrationState");
    expect(setup).not.toContain("readLocalDatabaseState");
  });

  it("the setup reads the database exactly ONCE, via the preflight", () => {
    // Counted rather than asserted by absence: a re-read added under a
    // different name would slip past a `not.toContain`.
    const reads = setup.match(/await\s+read[A-Za-z]*\(/g) ?? [];
    expect(reads, `globalSetup performs ${reads.length} direct database read(s)`).toHaveLength(0);
    expect(setup).toContain("runSchemaPreflight");
  });

  it("both hooks compare the SAME kind of fingerprint", () => {
    // A start fingerprint that included the incarnation and an end fingerprint
    // that did not would compare unequal on every run — green would become
    // impossible and the guard would be turned off within a day.
    expect(setup).toContain("fingerprintDatabaseState");
    expect(teardown).toContain("fingerprintDatabaseState");
  });

  it("teardown COMPUTES the end fingerprint rather than echoing the start", () => {
    // ASSERTS THE CALL, NOT THE IMPORT. A first draft checked only that the
    // module mentioned `readLocalDatabaseState` — which the import line
    // satisfies. Replacing the whole computation with `actual = expected`
    // therefore left the guard green while making the end-of-run check
    // compare a value against itself: it could no longer fail at all, which
    // is the precise failure this whole file exists to prevent, reproduced
    // inside its own proof.
    expect(teardown).toMatch(
      /actual\s*=\s*fingerprintDatabaseState\(\s*await\s+readLocalDatabaseState\(/,
    );
    // And the comparison must be between two independently obtained values.
    expect(teardown).not.toMatch(/actual\s*=\s*expected/);
    expect(teardown).toContain("if (actual === expected) return;");
  });
});

describe("11. the incarnation read stays read-only and local", () => {
  const preflight = read("e2e/helpers/schema-preflight.ts");

  it("Postgres ENFORCES the read-only claim", () => {
    // Not a comment promising good behaviour: the transaction is declared
    // read only, so a write would error rather than succeed quietly on a stack
    // shared with every other lane.
    expect(preflight).toContain("begin transaction read only isolation level repeatable read");
  });

  it("no sentinel table, no write, no DDL", () => {
    const body = preflight.slice(preflight.indexOf("export async function readLocalDatabaseState"));
    for (const banned of ["insert into", "update ", "delete from", "create table", "drop ", "alter "]) {
      expect(body.toLowerCase(), `incarnation read contains "${banned}"`).not.toContain(banned);
    }
  });

  it("it reads identity Postgres already keeps, rather than inventing one", () => {
    expect(preflight).toContain("pg_control_system()");
    expect(preflight).toContain("pg_postmaster_start_time()");
    expect(preflight).toContain("to_regclass('supabase_migrations.schema_migrations')");
  });

  it("an unreadable limb is a failure, never a pass", () => {
    // A null limb would otherwise compare equal to another null limb, and two
    // different databases would fingerprint the same.
    expect(preflight).toContain('throw new Error(`database incarnation could not be read');
  });

  it("it is still bounded to loopback", () => {
    const body = preflight.slice(preflight.indexOf("export async function readLocalDatabaseState"));
    expect(body).toContain("assertLoopbackDatabase(databaseUrl, lane)");
  });

  it("this repair did NOT quietly become per-worktree isolation", () => {
    // The stronger architectural follow-up stays a follow-up.
    //
    // COMMENT-STRIPPED, and the first draft was not: this module names
    // `supabase db reset --local` repeatedly in prose while explaining the
    // defect it exists for and the remedy it deliberately refuses to perform.
    // Matching raw source made the guard fire on its own documentation — the
    // assertion has to be about what the module DOES.
    //
    // LINE comments first, then block: a `//` line containing `/*` would
    // otherwise leave the block stripper eating real code to the next `*/`,
    // and every "does not contain" check here would pass vacuously.
    const code = preflight
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join("\n")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    // Anti-vacuity: the stripper must have kept the implementation.
    expect(code).toContain("export async function readLocalDatabaseState");

    // ASSERTS THE CAPABILITY, NOT A PHRASE. A first draft banned the substring
    // "supabase start" and fired on the operator help text — "Is the local
    // Supabase stack running (supabase start)?" — which is guidance this guard
    // SHOULD give. Telling someone to start their stack is not provisioning
    // one. What must remain impossible is this module running anything.
    for (const spawner of [
      "child_process",
      "execFileSync",
      "execSync",
      "spawnSync",
      "spawn(",
      "exec(",
    ]) {
      expect(code, `preflight can invoke a process via ${spawner}`).not.toContain(spawner);
    }
    // And it still must not perform the remedy it names.
    expect(code).not.toContain("db reset");
  });
});
