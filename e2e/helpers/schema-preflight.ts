// ===========================================================================
// E2E schema preflight — fail-closed branch/local-database compatibility guard
// ===========================================================================
//
// THE DEFECT THIS EXISTS FOR
// --------------------------
// Every browser-E2E lane on a developer host reaches ONE Supabase stack. The
// endpoints in `e2e/helpers/local-env.ts` are source literals, so a different
// worktree and a different app port do NOT make a different database — and
// `scripts/worktree-resources.mjs` says so explicitly in SHARED_RESOURCES.
//
// So when worktree B runs `supabase db reset --local` from ITS branch, worktree
// A's next browser run tests branch A's application against branch B's schema —
// and reports green. That was observed, not theorised: an audit at production
// baseline 27a4c960 found the shared stack at migration 0202 while the audited
// checkout defined through 0201, with 0202 belonging to an unmerged lane.
//
// Green under those conditions is not evidence. It invalidates before/after
// comparisons generally, which is why this guard is measurement integrity
// rather than a convenience.
//
// WHAT IT DOES
// ------------
// Before a browser lane starts, it compares the set of migrations THE CHECKOUT
// DEFINES against the set THE LOCAL DATABASE HAS APPLIED, and refuses to run on
// any discrepancy.
//
// WHAT IT DELIBERATELY DOES NOT DO
// --------------------------------
//   * It never RESETS, reseeds, repairs or mutates the database. The stack is
//     shared with other lanes; a reset would destroy their in-flight runs. This
//     guard is detection and containment, and the remedy is the operator's.
//   * It never applies, removes or reorders a migration.
//   * It hardcodes NO migration number. "0201" and "0202" appear nowhere in the
//     logic — both sides are derived at run time, so the guard cannot go stale
//     the moment the next migration lands.
//   * It does not teach any branch about another branch's migrations.
//
// NO BYPASS, BY DESIGN
// --------------------
// There is deliberately no env-var escape hatch, following the precedent set by
// `scripts/check-production-env-gates.mjs`: the only thing a bypass flag could
// do is re-enable the exact silent failure the guard exists to prevent, and
// "temporary" bypass flags rot into permanently-on. An operator who genuinely
// needs to run against a mismatched stack reconciles the stack instead.

// `scripts/migration-state.mjs` is the repository's single source of truth for
// repository-side migration derivation (CLAUDE.md §2: migration state is
// DERIVED, never hard-coded). Reimplementing the scan here would create the
// second competing map that file exists to prevent.
//
// LOADED DYNAMICALLY, and that is not a style choice. Playwright transpiles a
// TypeScript config and its globalSetup to CommonJS, and migration-state.mjs is
// real ESM that reads `import.meta.url`. A static import therefore drags an ESM
// module into a CJS scope and dies with "exports is not defined in ES module
// scope" before the guard can check anything — observed, not theorised. A
// dynamic import keeps it loading as the ESM it is.
//
// Loading is side-effect free either way: its CLI block is guarded by an argv
// check that a Playwright or vitest process never satisfies.
type MigrationStateModule = {
  scanMigrations: (dir?: string) => { version: string; name: string }[];
  MIGRATIONS_DIR: string;
};

let migrationStateModule: MigrationStateModule | null = null;

async function loadMigrationState(): Promise<MigrationStateModule> {
  if (!migrationStateModule) {
    migrationStateModule = (await import(
      // @ts-expect-error - .mjs utility ships without type declarations, the
      // same suppression e2e/helpers/local-env.ts uses for its sibling utility.
      "../../scripts/migration-state.mjs"
    )) as unknown as MigrationStateModule;
  }
  return migrationStateModule;
}

/** One migration, identified the same way on both sides: version + name. */
export type MigrationIdentity = { version: string; name: string };

export type PreflightFailureCode =
  | "LOCAL_AHEAD_OF_CHECKOUT"
  | "CHECKOUT_AHEAD_OF_LOCAL"
  | "IDENTITY_MISMATCH"
  | "STATE_UNAVAILABLE";

export type PreflightVerdict =
  | { ok: true; matched: number }
  | {
      ok: false;
      codes: PreflightFailureCode[];
      localOnly: MigrationIdentity[];
      missingLocally: MigrationIdentity[];
      identityMismatches: { version: string; checkoutName: string; localName: string }[];
      unavailableReason: string | null;
    };

export type PreflightPolicy = {
  /** Which browser family is starting. Reported, never used to weaken a check. */
  lane: string;
  /** The lane's database. A literal from local-env, never an env var. */
  databaseUrl: string;
  /** Where the checkout's migrations live. */
  migrationsDir?: string;
};

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const BANNED_URL_PATTERNS =
  /supabase\.co|supabase\.com|supabase\.in|pooler\.|amazonaws\.com|rds\.|azure|neon\.tech|render\.com|fly\.io/i;

/**
 * Refuse any database URL that is not loopback.
 *
 * The lane's URL is already a source literal, so this cannot fire today. It is
 * here because a guard that reads a database must not be the thing that makes a
 * hosted database reachable if that literal is ever made configurable. Same
 * posture as `tests/db/helpers/harness.ts`.
 */
export function assertLoopbackDatabase(url: string, lane: string): void {
  if (BANNED_URL_PATTERNS.test(url)) {
    throw new Error(
      `e2e schema preflight refuses to run: the ${lane} lane's database URL matches a hosted-database host pattern.`,
    );
  }
  let host: string;
  try {
    host = new URL(url.replace(/^postgres(ql)?:/, "http:")).hostname;
  } catch {
    throw new Error(
      `e2e schema preflight refuses to run: the ${lane} lane's database URL is not parseable.`,
    );
  }
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      `e2e schema preflight refuses to run: database host "${host}" is not loopback. ` +
        `Browser E2E may only target the local Supabase stack.`,
    );
  }
}

/**
 * PURE. Compare what the checkout defines against what the database applied.
 *
 * Separated from all I/O on purpose: every fail-closed branch below is then
 * provable by a unit test with no Docker, no Postgres and no browser, which is
 * what makes the negative control cheap enough to actually keep.
 *
 * Both sides are keyed by VERSION, and a version present on both sides must
 * also agree on NAME — two different migrations sharing a number is precisely
 * the collision a shared stack produces when two branches both author "0202".
 */
export function compareMigrationState(
  checkout: readonly MigrationIdentity[],
  local: readonly MigrationIdentity[],
): PreflightVerdict {
  // An empty side is never "compatible"; it is unknown. A repository with no
  // migrations cannot be verified against a database, and a database with no
  // migration history has not been migrated at all.
  if (checkout.length === 0 || local.length === 0) {
    return {
      ok: false,
      codes: ["STATE_UNAVAILABLE"],
      localOnly: [],
      missingLocally: [],
      identityMismatches: [],
      unavailableReason:
        checkout.length === 0
          ? "the checkout defines no migrations"
          : "the local database reports no applied migrations",
    };
  }

  const byVersion = (xs: readonly MigrationIdentity[]) =>
    new Map(xs.map((x) => [x.version, x] as const));
  const c = byVersion(checkout);
  const l = byVersion(local);

  const localOnly: MigrationIdentity[] = [];
  const missingLocally: MigrationIdentity[] = [];
  const identityMismatches: { version: string; checkoutName: string; localName: string }[] = [];

  for (const [version, entry] of l) {
    if (!c.has(version)) localOnly.push(entry);
  }
  for (const [version, entry] of c) {
    if (!l.has(version)) missingLocally.push(entry);
  }
  for (const [version, cEntry] of c) {
    const lEntry = l.get(version);
    if (lEntry && lEntry.name !== cEntry.name) {
      identityMismatches.push({ version, checkoutName: cEntry.name, localName: lEntry.name });
    }
  }

  const codes: PreflightFailureCode[] = [];
  if (localOnly.length > 0) codes.push("LOCAL_AHEAD_OF_CHECKOUT");
  if (missingLocally.length > 0) codes.push("CHECKOUT_AHEAD_OF_LOCAL");
  if (identityMismatches.length > 0) codes.push("IDENTITY_MISMATCH");

  if (codes.length === 0) return { ok: true, matched: c.size };

  const sortByVersion = (a: MigrationIdentity, b: MigrationIdentity) =>
    a.version.localeCompare(b.version);
  return {
    ok: false,
    codes,
    localOnly: localOnly.sort(sortByVersion),
    missingLocally: missingLocally.sort(sortByVersion),
    identityMismatches: identityMismatches.sort((a, b) => a.version.localeCompare(b.version)),
    unavailableReason: null,
  };
}

/** The migrations THIS CHECKOUT defines, derived by the repository's own scanner. */
export async function readCheckoutMigrationState(dir?: string): Promise<MigrationIdentity[]> {
  const mod = await loadMigrationState();
  const entries = mod.scanMigrations(dir ?? mod.MIGRATIONS_DIR);
  return entries.map((e) => ({ version: e.version, name: e.name }));
}

/**
 * The migrations the LOCAL DATABASE has applied.
 *
 * Read-only: one SELECT against `supabase_migrations.schema_migrations`, the
 * table the Supabase CLI itself maintains. `pg` is imported dynamically so the
 * pure comparator above stays usable without a driver.
 */
export async function readLocalMigrationState(
  databaseUrl: string,
  lane: string,
): Promise<MigrationIdentity[]> {
  assertLoopbackDatabase(databaseUrl, lane);
  const { Client } = await import("pg");
  const client = new Client({
    connectionString: databaseUrl,
    // A dead stack must fail fast and say so, not hang until the lane's own
    // timeout fires and blames something else.
    connectionTimeoutMillis: 10_000,
    statement_timeout: 10_000,
  });
  await client.connect();
  try {
    const { rows } = await client.query<{ version: string; name: string | null }>(
      "select version, name from supabase_migrations.schema_migrations order by version asc",
    );
    return rows.map((r) => ({ version: r.version, name: r.name ?? "" }));
  } finally {
    await client.end().catch(() => {});
  }
}

/** The operator-facing failure. Explicit about what is wrong and what to do. */
export function formatPreflightFailure(
  policy: PreflightPolicy,
  context: { branch: string; sha: string; checkoutCount: number; localCount: number },
  verdict: Extract<PreflightVerdict, { ok: false }>,
): string {
  const lines: string[] = [];
  const list = (xs: MigrationIdentity[]) =>
    xs.map((x) => `    ${x.version}_${x.name}`).join("\n");

  lines.push("");
  lines.push("=".repeat(72));
  lines.push("E2E SCHEMA PREFLIGHT FAILED");
  lines.push("=".repeat(72));
  lines.push("");
  lines.push(`Lane:`);
  lines.push(`  ${policy.lane}`);
  lines.push("");
  lines.push(`Checked-out branch:`);
  lines.push(`  ${context.branch} @ ${context.sha}`);
  lines.push("");
  lines.push(`Repository migration state (derived from supabase/migrations):`);
  lines.push(`  ${context.checkoutCount} migration(s) defined by this checkout`);
  lines.push("");
  lines.push(`Local Supabase migration state (read from supabase_migrations.schema_migrations):`);
  lines.push(`  ${context.localCount} migration(s) applied`);
  lines.push("");
  lines.push("Reason:");

  if (verdict.codes.includes("STATE_UNAVAILABLE")) {
    lines.push(`  migration state could not be determined reliably — ${verdict.unavailableReason}`);
  }
  if (verdict.localOnly.length > 0) {
    lines.push("  local database contains migration(s) this checkout does not define:");
    lines.push(list(verdict.localOnly));
    lines.push("");
    lines.push("  Another worktree almost certainly reset this shared stack from its own");
    lines.push("  branch. Running now would test THIS application against THAT schema.");
  }
  if (verdict.missingLocally.length > 0) {
    lines.push("  this checkout defines migration(s) the local database has not applied:");
    lines.push(list(verdict.missingLocally));
  }
  if (verdict.identityMismatches.length > 0) {
    lines.push("  migration identity mismatch — same version, different migration:");
    for (const m of verdict.identityMismatches) {
      lines.push(`    ${m.version}: checkout has "${m.checkoutName}", database has "${m.localName}"`);
    }
  }

  lines.push("");
  lines.push("Do not continue browser E2E against this stack.");
  lines.push("");
  lines.push("What to do:");
  lines.push("  * Obtain or reserve a Supabase stack whose applied migrations match this");
  lines.push("    checkout, and point this lane at it; or");
  lines.push("  * reconcile this checkout with the branch that owns the extra migration(s).");
  lines.push("");
  lines.push("  This guard will NOT reset the stack for you. It is shared with every other");
  lines.push("  worktree on this host (see scripts/worktree-resources.mjs, SHARED_RESOURCES),");
  lines.push("  and a reset would destroy other lanes' in-flight runs.");
  lines.push("=".repeat(72));
  lines.push("");
  return lines.join("\n");
}

/**
 * Run the preflight. Resolves on compatibility; THROWS on anything else,
 * including an unreadable database — unknown is a failure, never a pass.
 */
export async function runSchemaPreflight(
  policy: PreflightPolicy,
  context: { branch: string; sha: string },
): Promise<PreflightVerdict> {
  let checkout: MigrationIdentity[];
  try {
    checkout = await readCheckoutMigrationState(policy.migrationsDir);
  } catch (err) {
    throw new Error(
      formatPreflightFailure(
        policy,
        { ...context, checkoutCount: 0, localCount: 0 },
        {
          ok: false,
          codes: ["STATE_UNAVAILABLE"],
          localOnly: [],
          missingLocally: [],
          identityMismatches: [],
          unavailableReason: `the checkout's migrations could not be derived: ${
            err instanceof Error ? err.message : String(err)
          }`,
        },
      ),
    );
  }

  let local: MigrationIdentity[];
  try {
    local = await readLocalMigrationState(policy.databaseUrl, policy.lane);
  } catch (err) {
    throw new Error(
      formatPreflightFailure(
        policy,
        { ...context, checkoutCount: checkout.length, localCount: 0 },
        {
          ok: false,
          codes: ["STATE_UNAVAILABLE"],
          localOnly: [],
          missingLocally: [],
          identityMismatches: [],
          unavailableReason:
            `the local database could not be read: ${
              err instanceof Error ? err.message : String(err)
            }. Is the local Supabase stack running (supabase start)?`,
        },
      ),
    );
  }

  const verdict = compareMigrationState(checkout, local);
  if (!verdict.ok) {
    throw new Error(
      formatPreflightFailure(
        policy,
        { ...context, checkoutCount: checkout.length, localCount: local.length },
        verdict,
      ),
    );
  }
  return verdict;
}
