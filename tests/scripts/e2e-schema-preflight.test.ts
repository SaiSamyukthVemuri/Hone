import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  assertLoopbackDatabase,
  compareMigrationState,
  formatPreflightFailure,
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
