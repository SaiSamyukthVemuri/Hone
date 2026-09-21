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

/**
 * Where globalSetup hands the verified fingerprint to globalTeardown.
 *
 * Named here, once, so the two hooks cannot drift apart on a string literal.
 * It carries a hash, never a connection string or a credential.
 */
export const SCHEMA_FINGERPRINT_ENV = "HONE_E2E_SCHEMA_FINGERPRINT";

/** One migration, identified the same way on both sides: version + name. */
export type MigrationIdentity = { version: string; name: string };

export type PreflightFailureCode =
  | "LOCAL_AHEAD_OF_CHECKOUT"
  | "CHECKOUT_AHEAD_OF_LOCAL"
  | "IDENTITY_MISMATCH"
  | "STATE_UNAVAILABLE";

export type PreflightVerdict =
  | { ok: true; matched: number; state: LocalDatabaseState }
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
export type ComparisonVerdict =
  | { ok: true; matched: number }
  | Extract<PreflightVerdict, { ok: false }>;

export function compareMigrationState(
  checkout: readonly MigrationIdentity[],
  local: readonly MigrationIdentity[],
): ComparisonVerdict {
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

/**
 * A stable fingerprint of an applied-migration set.
 *
 * Exists because the preflight is a SNAPSHOT. It proves the database matched
 * the checkout at the moment the lane started, and nothing more: another
 * worktree can run `supabase db reset --local` while the suite is mid-flight,
 * and the run would carry on against the replacement schema. The replacement
 * can easily be similar enough that the specs still pass, so the lane would
 * report green about a database it never verified.
 *
 * This lane cannot PREVENT that — preventing it needs real per-worktree
 * database isolation, which is an architectural change and deliberately out of
 * scope here. What it can do is refuse to call the result evidence: the
 * fingerprint is taken at start and re-taken at the end, and a run whose
 * database changed underneath fails instead of passing.
 *
 * Detection, not prevention — which is this guard's whole remit.
 */
export function fingerprintMigrationState(entries: readonly MigrationIdentity[]): string {
  // Order-independent and content-sensitive: a reset that swapped one migration
  // for another of the same count and the same maximum must produce a different
  // fingerprint, or the end-of-run check would be as weak as a count compare.
  const canonical = [...entries]
    .map((e) => `${e.version}_${e.name}`)
    .sort()
    .join("\n");
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < canonical.length; i++) {
    const c = canonical.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c + i, 0x85ebca6b) >>> 0;
  }
  return `${entries.length}:${h1.toString(16)}${h2.toString(16)}`;
}

/**
 * A DATABASE INCARNATION — "is this still the same database?"
 *
 * WHY THE MIGRATION FINGERPRINT IS NOT ENOUGH (Codex P1).
 * The fingerprint covers migration versions, names and count. So
 * `A -> reset -> A` — another worktree resetting the shared stack to a set that
 * happens to be IDENTICAL — produces the same fingerprint, and a browser run
 * can live through a complete database replacement and still finish green. The
 * whole point of the end-of-run re-check is to refuse exactly that, and on the
 * most likely reset of all (a lane resetting to the branch it already had) it
 * was blind.
 *
 * WHY THIS IS A COMPOSITE OF THINGS POSTGRES ALREADY KEEPS.
 * Postgres has no single incarnation counter — nothing like Oracle's. Asked to
 * invent one, the obvious move is a sentinel table holding a UUID, and that was
 * rejected: it would make this guard WRITE to a database it exists only to
 * observe, on a stack shared with every other lane.
 *
 * MEASURED, NOT ASSUMED — and two obvious limbs turned out to be useless.
 * Two INDEPENDENTLY CREATED local Supabase stacks carrying the SAME 96-table
 * schema were read side by side (pure SELECTs, nothing reset):
 *
 *   limb                    stack A                stack B                differs
 *   system_identifier       7686678812421562407    7687687241716015144    YES
 *   database_oid            5                      5                      no
 *   postmaster_start_time   2026-09-18 01:19:39    2026-09-20 18:32:53    YES
 *   migration_schema_oid    18512                  17810                  YES
 *   migration_table_oid     18513                  17811                  YES
 *   public_table_count      96                     96                     no
 *   public_table_oid_low    18520                  17818                  YES
 *   public_table_oid_high   23676                  22974                  YES
 *   public_table_oid_sum    1992402                1925010                YES
 *
 * That is the `A -> reset -> A` SHAPE reproduced without a reset: two distinct
 * databases holding the same migration set. Seven limbs separate them.
 *
 * The two that do NOT are precisely the two a guess would reach for first.
 * `database_oid` is **5** on both — the original, template-created database,
 * which a local reset does not drop, so a database-OID check would never fire
 * on the event this exists to catch. `public_table_count` is 96 on both, so a
 * count is no better than the migration fingerprint it was meant to strengthen.
 * Both are kept in the composite anyway: each still moves under a reset shape
 * the other limbs do not cover (the database genuinely being dropped; a table
 * added or removed), and a limb that is merely redundant costs nothing, whereas
 * a missing one is a blind spot.
 *
 * WHAT REMAINS UNPROVEN, AND IS NOT CLAIMED. The reading above proves the
 * composite DISCRIMINATES BETWEEN TWO DATABASE INCARNATIONS. It does not prove
 * that `supabase db reset --local` on ONE stack moves these limbs. The
 * inference is strong — OIDs are allocated from a forward-running counter, so
 * objects recreated by a re-applied migration chain cannot reuse their previous
 * numbers — but it is inference, not observation. Observing it requires
 * destroying a stack, and both stacks on this host are owned: one is shared by
 * every lane, the other belongs to the active release unit. That proof is
 * therefore DEFERRED to a released DB slot rather than taken, and this comment
 * is the record that it is owed.
 *
 * The limbs that move are the RECREATED OBJECTS.
 *
 *   systemIdentifier      cluster re-init (`initdb`, a fresh container)
 *   databaseOid           the database itself dropped and recreated
 *   postmasterStartTime   the server restarting
 *   migrationSchemaOid    `supabase_migrations` rebuilt
 *   migrationTableOid     `schema_migrations` rebuilt
 *   publicTable*          the migrated schema dropped and re-applied — OIDs come
 *                         from a forward-running counter, so recreated tables
 *                         never reuse their old numbers
 *
 * None of these moves because rows were inserted, which is the "stable through
 * an untouched run" half of the requirement and the reason row- or
 * statistics-based signals were not used.
 *
 * NOT per-worktree isolation. This DETECTS replacement; it does not prevent it.
 * Real isolation — a Supabase project per lane, or a reservation protocol —
 * stays separate architecture work and is deliberately not smuggled in here.
 */
export type DatabaseIncarnation = {
  systemIdentifier: string;
  databaseOid: string;
  postmasterStartTime: string;
  migrationSchemaOid: string;
  migrationTableOid: string;
  publicTableCount: string;
  publicTableOidLow: string;
  publicTableOidHigh: string;
  publicTableOidSum: string;
};

/** Everything one connection observed, at one instant. */
export type LocalDatabaseState = {
  migrations: MigrationIdentity[];
  incarnation: DatabaseIncarnation;
};

/** The incarnation as one comparable string. Order fixed, never re-sorted. */
export function formatIncarnation(i: DatabaseIncarnation): string {
  return [
    i.systemIdentifier,
    i.databaseOid,
    i.postmasterStartTime,
    i.migrationSchemaOid,
    i.migrationTableOid,
    i.publicTableCount,
    i.publicTableOidLow,
    i.publicTableOidHigh,
    i.publicTableOidSum,
  ].join("|");
}

function hashString(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c + i, 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(16)}${h2.toString(16)}`;
}

/**
 * The fingerprint the two hooks compare: migrations AND incarnation.
 *
 * Both halves are load-bearing and neither subsumes the other. Migrations alone
 * miss `A -> reset -> A`; incarnation alone would miss a migration applied
 * forward into a database that was never recreated.
 */
export function fingerprintDatabaseState(state: LocalDatabaseState): string {
  return `${fingerprintMigrationState(state.migrations)}@${hashString(
    formatIncarnation(state.incarnation),
  )}`;
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

/**
 * Read the migrations AND the incarnation from ONE connection, in ONE
 * read-only snapshot.
 *
 * ATOMIC RELATIVE TO EACH OTHER, deliberately. Two separate reads would
 * reintroduce one level down the very race this repair closes: a reset landing
 * between them would pair migration state from before with an incarnation from
 * after, and the fingerprint would describe a database that never existed.
 *
 * `read only` is not decoration. It makes "this guard never writes" something
 * Postgres ENFORCES rather than something a reviewer takes on trust — a write
 * here would error instead of succeeding quietly on a shared stack.
 *
 * `repeatable read` so both statements see one snapshot: a concurrent reset is
 * then wholly before or wholly after what we read, never spliced through it.
 */
export async function readLocalDatabaseState(
  databaseUrl: string,
  lane: string,
): Promise<LocalDatabaseState> {
  assertLoopbackDatabase(databaseUrl, lane);
  const { Client } = await import("pg");
  const client = new Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 10_000,
  });
  await client.connect();
  try {
    await client.query("begin transaction read only isolation level repeatable read");

    const { rows: migrationRows } = await client.query<{
      version: string;
      name: string | null;
    }>("select version, name from supabase_migrations.schema_migrations order by version asc");

    // to_regclass / to_regnamespace rather than a cast: a cast RAISES when the
    // object is absent, and "the migration table is gone" is information this
    // signal should carry, not an exception that hides it.
    const { rows: incarnationRows } = await client.query<Record<string, string | null>>(
      `select
         (select system_identifier::text from pg_control_system())              as system_identifier,
         (select oid::text from pg_database where datname = current_database()) as database_oid,
         (select pg_postmaster_start_time()::text)                              as postmaster_start_time,
         coalesce(to_regnamespace('supabase_migrations')::oid::text, 'absent')  as migration_schema_oid,
         coalesce(to_regclass('supabase_migrations.schema_migrations')::oid::text, 'absent') as migration_table_oid,
         (select count(*)::text from pg_class
            where relnamespace = 'public'::regnamespace and relkind = 'r')      as public_table_count,
         (select coalesce(min(oid)::text, 'none') from pg_class
            where relnamespace = 'public'::regnamespace and relkind = 'r')      as public_table_oid_low,
         (select coalesce(max(oid)::text, 'none') from pg_class
            where relnamespace = 'public'::regnamespace and relkind = 'r')      as public_table_oid_high,
         (select coalesce(sum(oid::bigint)::text, 'none') from pg_class
            where relnamespace = 'public'::regnamespace and relkind = 'r')      as public_table_oid_sum`,
    );

    await client.query("commit");

    const r = incarnationRows[0] ?? {};
    const need = (k: string): string => {
      const v = r[k];
      if (v === null || v === undefined) {
        // Unknown is a failure, never a pass — the same posture the migration
        // side takes. A null limb would compare equal to another null limb, so
        // two different databases would fingerprint the same.
        throw new Error(`database incarnation could not be read: "${k}" is null`);
      }
      return v;
    };

    return {
      migrations: migrationRows.map((m) => ({ version: m.version, name: m.name ?? "" })),
      incarnation: {
        systemIdentifier: need("system_identifier"),
        databaseOid: need("database_oid"),
        postmasterStartTime: need("postmaster_start_time"),
        migrationSchemaOid: need("migration_schema_oid"),
        migrationTableOid: need("migration_table_oid"),
        publicTableCount: need("public_table_count"),
        publicTableOidLow: need("public_table_oid_low"),
        publicTableOidHigh: need("public_table_oid_high"),
        publicTableOidSum: need("public_table_oid_sum"),
      },
    };
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

  // READ ONCE. The snapshot validated below is the snapshot returned, and the
  // caller fingerprints exactly it — see the note on the return value.
  let state: LocalDatabaseState;
  try {
    state = await readLocalDatabaseState(policy.databaseUrl, policy.lane);
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

  const verdict = compareMigrationState(checkout, state.migrations);
  if (!verdict.ok) {
    throw new Error(
      formatPreflightFailure(
        policy,
        {
          ...context,
          checkoutCount: checkout.length,
          localCount: state.migrations.length,
        },
        verdict,
      ),
    );
  }
  // THE SNAPSHOT THAT PASSED, not a fresh read (Codex P2).
  //
  // This used to return only `{ ok, matched }`, leaving globalSetup to issue a
  // SECOND read and fingerprint that. Those are two observations of a shared
  // database: a reset landing between them would be VALIDATED in the first and
  // RECORDED in the second, so the run's "expected" fingerprint would describe
  // the REPLACEMENT — and teardown, comparing replacement against replacement,
  // would pass. The proof and the record must be the same observation, so the
  // observation is what is returned.
  return { ok: true, matched: verdict.matched, state };
}
