#!/usr/bin/env node
// Runtime fresh-managed-project proof for the DB-integration lane.
//
// The static guard (check-migration-extension-qualification.mjs) proves every
// pgcrypto/uuid-ossp call in the migrations is `extensions.<fn>`-qualified. This
// script proves the RUNTIME precondition that qualification exists for: on the
// just-migrated local database: matching a fresh MANAGED Supabase project:
//
//   (a) pgcrypto is installed in the `extensions` schema (NOT public), and
//   (b) with `extensions` ABSENT from the session search_path, a BARE pgcrypto
//       call (gen_random_bytes) fails with 42883, while the schema-qualified call
//       (extensions.gen_random_bytes) succeeds, and the pg_catalog built-in
//       gen_random_uuid() still works bare.
//
// Together with the all-qualified static guarantee, this shows the 0001->NNNN
// chain applies on a fresh managed project where extensions is off the migration
// search_path. Local stack only; refuses any non-localhost database URL.
import pg from "pg";

const DEFAULT_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const url = process.env.HONE_LOCAL_DB_URL || DEFAULT_URL;

// Localhost-only guard (mirrors tests/db/helpers/harness.ts): never point this at
// a managed/hosted database.
const host = (() => {
  try {
    return new URL(url.replace(/^postgres(ql)?:\/\//, "http://")).hostname;
  } catch {
    return "";
  }
})();
if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
  console.error(`REFUSING: fresh-managed probe is local-only, got host=${host || "(unparseable)"}`);
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
const fail = (msg) => {
  console.error(`FRESH-MANAGED EXTENSION PROOF FAILED: ${msg}`);
  process.exitCode = 1;
};

try {
  await client.connect();

  // (a) pgcrypto lives in `extensions` (managed layout, not public/pg_catalog).
  const { rows: ext } = await client.query(
    `select e.extname, n.nspname as schema
       from pg_extension e join pg_namespace n on n.oid = e.extnamespace
      where e.extname in ('pgcrypto','uuid-ossp')`,
  );
  const pgcrypto = ext.find((r) => r.extname === "pgcrypto");
  if (!pgcrypto) fail("pgcrypto extension is not installed");
  else if (pgcrypto.schema !== "extensions")
    fail(`pgcrypto is in schema '${pgcrypto.schema}', expected 'extensions' (managed layout)`);
  const uuidOssp = ext.find((r) => r.extname === "uuid-ossp");
  if (uuidOssp && uuidOssp.schema !== "extensions")
    fail(`uuid-ossp is in schema '${uuidOssp.schema}', expected 'extensions'`);

  // (b) simulate the managed migration session: extensions OFF the search_path.
  await client.query("set search_path = pg_catalog, public");

  let bareFailed = false;
  try {
    await client.query("select gen_random_bytes(1)");
  } catch (e) {
    bareFailed = e.code === "42883"; // undefined_function -> exactly the fresh-managed failure mode
    if (!bareFailed) fail(`bare gen_random_bytes failed with ${e.code}, expected 42883`);
  }
  if (!bareFailed) fail("bare gen_random_bytes() resolved with extensions off search_path, managed layout NOT reproduced");

  // qualified call must succeed under the same off-path session.
  await client
    .query("select extensions.gen_random_bytes(1) as b")
    .catch((e) => fail(`extensions.gen_random_bytes failed (${e.code}): ${e.message}`));

  // pg_catalog built-in must still work bare (guard intentionally does not flag it).
  await client
    .query("select gen_random_uuid() as u")
    .catch((e) => fail(`gen_random_uuid() built-in failed (${e.code}): ${e.message}`));

  if (process.exitCode === 1) {
    await client.end();
    process.exit(1);
  }
  console.log(
    "OK: fresh-managed layout verified: pgcrypto in `extensions`; bare pgcrypto fails (42883) " +
      "and extensions.<fn> succeeds with extensions off search_path; gen_random_uuid() built-in unaffected.",
  );
} catch (e) {
  fail(`unexpected error: ${e.message}`);
} finally {
  await client.end().catch(() => undefined);
}
