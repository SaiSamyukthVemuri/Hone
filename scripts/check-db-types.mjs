#!/usr/bin/env node
// ===========================================================================
// Generated database types drift check (PR #221)
// ===========================================================================
//
// Compares the LOCAL migrated database schema (via
// `supabase gen types typescript --local`) against the hand-rolled
// app types in lib/types/database.ts, so CI fails when the two
// drift apart.
//
// Why curated, not a full-file diff: lib/types/database.ts is
// deliberately hand-rolled (flat named types like `Session`, with
// narrowed unions such as `modality: "electrolysis" | "laser"` that
// carry MORE information than the generated `string`). A byte diff
// against generated output is structurally impossible, so this
// check compares COLUMN SETS exactly, both directions, for every
// curated table: a column in the database but missing from the app
// type fails, and a phantom column in the app type that the
// database does not have fails.
//
// Safety (same posture as tests/db/, PR #220):
//   * Generation runs with the hardcoded `--local` flag only; it
//     talks to the supabase CLI's local Docker stack and nothing
//     else. No project ref, no --linked, no access token.
//   * The script refuses to run if SUPABASE_DB_URL or
//     HONE_LOCAL_DB_URL is set to a non-localhost or hosted-looking
//     URL (defense in depth; generation does not read them, but a
//     misconfigured shell should fail loudly, not silently).
//   * It never reads NEXT_PUBLIC_SUPABASE_URL,
//     SUPABASE_SERVICE_ROLE_KEY, or any production credential, and
//     it never writes anywhere except stdout.
//
// Usage:
//   npm run check:db-types            # runs supabase gen types --local
//   node scripts/check-db-types.mjs <pre-generated-file>   # debug path
//
// Prereq: supabase db start && supabase db reset --local (the same
// local stack the tests/db/ lane uses).

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const BANNED_URL_PATTERNS =
  /supabase\.co|supabase\.com|supabase\.in|pooler\.|amazonaws\.com|rds\.|azure|neon\.tech/i;
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

function refuseNonLocalEnv() {
  for (const name of ["SUPABASE_DB_URL", "HONE_LOCAL_DB_URL"]) {
    const value = process.env[name];
    if (!value) continue;
    if (BANNED_URL_PATTERNS.test(value)) {
      fail(`${name} matches a hosted-database host pattern. This check only ever targets the local Supabase stack.`);
    }
    let host = "";
    try {
      host = new URL(value).hostname;
    } catch {
      fail(`${name} is set but not a parseable URL.`);
    }
    if (!LOCAL_HOSTS.has(host)) {
      fail(`${name} points at "${host}", which is not localhost. This check only ever targets the local Supabase stack.`);
    }
  }
}

function fail(message) {
  console.error(`FAIL ${message}`);
  process.exit(1);
}

// DB table -> hand-rolled type name in lib/types/database.ts.
// Every entry is compared EXACTLY, both directions.
const CURATED_TABLES = {
  studios: "Studio",
  practitioners: "Practitioner",
  clients: "Client",
  appointments: "Appointment",
  sessions: "Session",
  session_blocks: "SessionBlock",
  electrolysis_entries: "ElectrolysisEntry",
  laser_entries: "LaserEntry",
  client_intake_forms: "ClientIntakeForm",
  treatment_plans: "TreatmentPlan",
  treatment_plan_stages: "TreatmentPlanStage",
  record_keeping_sterile_items: "RecordKeepingSterileItem",
  record_keeping_disinfectants: "RecordKeepingDisinfectant",
  record_keeping_exposure_incidents: "RecordKeepingExposureIncident",
  record_keeping_audit_events: "RecordKeepingAuditEvent",
};

// Recently added columns that MUST exist in both the database and
// the app types (regression pin for the hand-maintained file).
const CRITICAL_COLUMNS = [
  ["practitioners", "default_machine_frequency"],
  ["practitioners", "calendar_feed_token_hash"],
  ["session_blocks", "probe_lot_number"],
  ["session_blocks", "tolerance_rating"],
  ["session_blocks", "reaction_type"],
  ["session_blocks", "reaction_notes"],
  ["session_blocks", "caution_for_next_session"],
  ["session_blocks", "caution_note"],
  ["sessions", "aftercare_and_risks_explained_at"],
  ["sessions", "aftercare_and_risks_explained_by"],
  ["sessions", "next_session_note"],
];

// Payment/webhook tables have NO central hand-rolled type (each
// billing module types its own rows inline), so for them the check
// asserts the DATABASE side: the columns the executors, receipt/
// refund senders, and webhook reconciliation rely on must exist in
// the migrated schema.
const DB_ONLY_TABLES = {
  payment_charge_attempts: [
    "status",
    "charge_reason",
    "stripe_livemode",
    "amount_cents",
    "stripe_idempotency_key",
    "stripe_payment_intent_id",
    "receipt_status",
    "refund_status",
    "stripe_refund_id",
    "created_by_practitioner_id",
  ],
  manual_fee_charge_attempts: ["status", "stripe_livemode"],
  stripe_events: ["stripe_event_id", "stripe_livemode", "processed_at"],
  ops_alerts: ["severity", "event", "resolved_at"],
};

function generatedTypes() {
  const fileArg = process.argv[2];
  if (fileArg) {
    return readFileSync(fileArg, "utf8");
  }
  try {
    return execFileSync("supabase", ["gen", "types", "typescript", "--local"], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    fail(
      `could not run "supabase gen types typescript --local". Is the local stack up (supabase db start)? ${error.message ?? error}`,
    );
  }
}

function parseGeneratedColumns(generated, table) {
  const m = generated.match(
    new RegExp(`\\n      ${table}: \\{\\n        Row: \\{\\n([\\s\\S]*?)\\n        \\}`),
  );
  if (!m) return null;
  const cols = new Set();
  for (const line of m[1].split("\n")) {
    const cm = line.match(/^\s+([a-z_0-9]+)\??: /);
    if (cm) cols.add(cm[1]);
  }
  return cols;
}

function parseHandRolledColumns(handRolled, typeName) {
  const m = handRolled.match(
    new RegExp(`export type ${typeName} = \\{\\n([\\s\\S]*?)\\n\\};`),
  );
  if (!m) return null;
  const cols = new Set();
  for (const line of m[1].split("\n")) {
    const cm = line.match(/^\s{2}([a-z_0-9]+)\??:/);
    if (cm) cols.add(cm[1]);
  }
  return cols;
}

refuseNonLocalEnv();

const generated = generatedTypes();
const handRolled = readFileSync("lib/types/database.ts", "utf8");

if (!generated.includes("export type Database")) {
  fail("generated output does not look like supabase gen types output.");
}

let failures = 0;

for (const [table, typeName] of Object.entries(CURATED_TABLES)) {
  const dbCols = parseGeneratedColumns(generated, table);
  const tsCols = parseHandRolledColumns(handRolled, typeName);
  if (!dbCols) {
    console.error(`FAIL ${table}: table not found in generated types (migration chain incomplete?)`);
    failures += 1;
    continue;
  }
  if (!tsCols) {
    console.error(`FAIL ${table}: type ${typeName} not found in lib/types/database.ts`);
    failures += 1;
    continue;
  }
  const missingInTs = [...dbCols].filter((c) => !tsCols.has(c)).sort();
  const phantomInTs = [...tsCols].filter((c) => !dbCols.has(c)).sort();
  if (missingInTs.length || phantomInTs.length) {
    console.error(
      `FAIL ${table} (${typeName}): drift detected.` +
        (missingInTs.length ? ` In DB but missing from type: ${missingInTs.join(", ")}.` : "") +
        (phantomInTs.length ? ` In type but missing from DB: ${phantomInTs.join(", ")}.` : ""),
    );
    failures += 1;
  } else {
    console.log(`PASS ${table} (${typeName}): ${dbCols.size} columns, exact match`);
  }
}

for (const [table, column] of CRITICAL_COLUMNS) {
  const dbCols = parseGeneratedColumns(generated, table);
  const tsCols = parseHandRolledColumns(handRolled, CURATED_TABLES[table]);
  const okDb = Boolean(dbCols && dbCols.has(column));
  const okTs = Boolean(tsCols && tsCols.has(column));
  if (!okDb || !okTs) {
    console.error(
      `FAIL critical column ${table}.${column}: in DB=${okDb} in app types=${okTs}`,
    );
    failures += 1;
  }
}
if (CRITICAL_COLUMNS.every(([t, c]) => parseGeneratedColumns(generated, t)?.has(c))) {
  console.log(`PASS critical recent columns present in DB and app types (${CRITICAL_COLUMNS.length})`);
}

for (const [table, columns] of Object.entries(DB_ONLY_TABLES)) {
  const dbCols = parseGeneratedColumns(generated, table);
  if (!dbCols) {
    console.error(`FAIL ${table}: table not found in generated types`);
    failures += 1;
    continue;
  }
  const missing = columns.filter((c) => !dbCols.has(c));
  if (missing.length) {
    console.error(`FAIL ${table}: schema is missing relied-upon columns: ${missing.join(", ")}`);
    failures += 1;
  } else {
    console.log(`PASS ${table}: ${columns.length} relied-upon columns present in DB (no central app type; modules type rows inline)`);
  }
}

if (failures > 0) {
  console.error(
    `\n${failures} drift failure(s). Fix lib/types/database.ts (or the migration) so the app types match the migrated schema, then re-run: npm run check:db-types`,
  );
  process.exit(1);
}
console.log("\nAll database type drift checks passed.");
