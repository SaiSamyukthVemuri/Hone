#!/usr/bin/env node
/**
 * scripts/verify-production.mjs — PR #308
 *
 * Operator-run, READ-ONLY verification that PRODUCTION matches the repo's
 * required state, to be run BEFORE enabling live payments or broadening
 * sensitive-data use. It answers the P0 "we cannot independently confirm remote
 * production state" gap: it proves remote Supabase = repo-required (the latest
 * migration — derived from supabase/migrations/, not hardcoded — plus the
 * 0093/0097/0098/0099 effects), that the treatment-image bucket is
 * private with hardened policies, that RLS is on for the critical tables, that
 * there are no unresolved critical payment ops alerts, that the Stripe source
 * gates are intact, and that the reminder scheduler heartbeat is fresh.
 *
 * Run (from the production-linked Mac):
 *   node --env-file=.env.local scripts/verify-production.mjs
 *
 * SAFETY (hard rules — enforced by tests/scripts/verify-production.test.ts):
 *   - READ-ONLY. Uses `supabase db query --linked` for every DB read. It NEVER
 *     runs `supabase db push` / `supabase db execute`, never applies a
 *     migration, never INSERT/UPDATE/DELETE/UPSERT, never calls a Stripe write
 *     API, never sends email, never triggers cron.
 *   - NO SECRETS / NO PII. Every query returns SCALARS only (counts, booleans,
 *     the migration version, table/column names). The script prints only
 *     PASS/FAIL/INCOMPLETE + those scalars. It never prints the service-role
 *     key, the Upstash token, client names/emails/phones, raw tokens, health/
 *     treatment data, notes, or ops-alert message bodies.
 *   - FAIL-CLOSED. A required check that cannot run (CLI not linked, Upstash
 *     env absent for the heartbeat) is FAIL/INCOMPLETE — never a silent PASS —
 *     and the script exits non-zero.
 *
 * This is NOT a CI gate (CI has no production link, by design) and NOT a
 * live-payment enablement script. It performs the AUTOMATED subset only; the
 * MANUAL dashboard checks (Vercel prod env presence, Stripe dashboard, log
 * sample) are documented in docs/16 §17.13.
 */

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";

// Mirrored from lib/cron/reminder-heartbeat.ts (a .mjs script can't import the
// TS module). CRON_INTERVAL_MINUTES = 15; stale after 3 missed runs = 45 min.
const HEARTBEAT_KEY = "reminder_cron:last_success";
const REMINDER_STALE_AFTER_MINUTES = 45;

// Expected repo-required production state. DERIVED from supabase/migrations/ at
// run time (PR #314) — NOT hardcoded — so this pre-live verifier can never go
// stale against the repo. The expected max is the highest 4-digit migration
// prefix in the repo (e.g. 0100_postcare_send_state.sql -> "0100"). If the repo
// gains a migration, the expected value tracks automatically.
function deriveExpectedMigrationMax() {
  const dir = path.join(process.cwd(), "supabase", "migrations");
  const nums = readdirSync(dir)
    .map((f) => /^(\d{4})_.*\.sql$/.exec(f))
    .filter(Boolean)
    .map((m) => m[1])
    .sort();
  if (nums.length === 0) {
    throw new Error(
      "no supabase/migrations/NNNN_*.sql files found — run from the repo root",
    );
  }
  return nums[nums.length - 1];
}
const EXPECTED_MIGRATION_MAX = deriveExpectedMigrationMax();

// Critical tables that must have RLS enabled. All confirmed to exist in prod.
const CRITICAL_RLS_TABLES = [
  "clients",
  "appointments",
  "client_intake_forms",
  "sessions",
  "session_blocks",
  "treatment_images",
  "payment_charge_attempts",
  "ops_alerts",
  "record_keeping_audit_events",
  "record_keeping_disinfectants",
  "record_keeping_exposure_incidents",
  "record_keeping_sterile_items",
];

// ---------------------------------------------------------------------------
// Output helpers — PASS / FAIL / INCOMPLETE, scalars only.
// ---------------------------------------------------------------------------
const results = [];
function record(status, name, detail) {
  results.push({ status, name });
  const tag =
    status === "PASS" ? "PASS " : status === "FAIL" ? "FAIL " : "INCOMPLETE";
  console.log(`  ${tag}  ${name}${detail ? ` — ${detail}` : ""}`);
}
const pass = (n, d) => record("PASS", n, d);
const fail = (n, d) => record("FAIL", n, d);
const incomplete = (n, d) => record("INCOMPLETE", n, d);

// ---------------------------------------------------------------------------
// Read-only DB access via the linked Supabase CLI. `db query` is READ-ONLY;
// we NEVER use `db push` / `db execute`. Returns the parsed `rows` array, or
// throws (fail-closed) if the CLI is unavailable / not linked / errors.
// ---------------------------------------------------------------------------
function dbRows(sql) {
  const out = spawnSync(
    "supabase",
    ["db", "query", "--linked", sql],
    { encoding: "utf8", timeout: 60_000 },
  );
  if (out.error) {
    throw new Error(
      `supabase CLI not available (${out.error.code || out.error.message}). ` +
        `Run from the production-linked environment.`,
    );
  }
  if (out.status !== 0) {
    // Do NOT echo stderr verbatim (could contain a connection string); surface
    // only that the read failed.
    throw new Error(
      `supabase db query failed (exit ${out.status}). Is the CLI linked?`,
    );
  }
  const text = out.stdout || "";
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("Could not parse supabase db query output.");
  }
  let parsed;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new Error("Could not parse supabase db query JSON.");
  }
  if (!parsed || !Array.isArray(parsed.rows)) {
    throw new Error("Unexpected supabase db query shape.");
  }
  return parsed.rows;
}
// Convenience: first row's single scalar column.
function scalar(sql) {
  const rows = dbRows(sql);
  const row = rows[0] ?? {};
  const keys = Object.keys(row);
  return keys.length ? row[keys[0]] : undefined;
}

// ---------------------------------------------------------------------------
// 1. Remote migration max = 0099
// ---------------------------------------------------------------------------
function checkMigrationMax() {
  try {
    const v = scalar(
      "select max(version) as v from supabase_migrations.schema_migrations;",
    );
    if (String(v) === EXPECTED_MIGRATION_MAX) {
      pass("Remote migration max", `= ${EXPECTED_MIGRATION_MAX}`);
    } else {
      fail(
        "Remote migration max",
        `expected ${EXPECTED_MIGRATION_MAX}, remote = ${String(v)}`,
      );
    }
  } catch (e) {
    fail("Remote migration max", e.message);
  }
}

// ---------------------------------------------------------------------------
// 2. Required migration effects (0093 / 0097 / 0098 / 0099)
// ---------------------------------------------------------------------------
function checkMigrationEffects() {
  // 0093 — treatment image storage hardening.
  try {
    const bucket = dbRows(
      "select count(*) as n, coalesce(bool_and(public = false), false) as private " +
        "from storage.buckets where id = 'treatment-images';",
    )[0];
    if (Number(bucket.n) >= 1 && bucket.private === true) {
      pass("0093 bucket", "treatment-images exists + private");
    } else {
      fail(
        "0093 bucket",
        `exists=${Number(bucket.n) >= 1} private=${bucket.private === true}`,
      );
    }
  } catch (e) {
    fail("0093 bucket", e.message);
  }
  try {
    // storage.objects policies are owned by supabase_storage_admin and are NOT
    // introspectable from the linked query role (pg_policies returns nothing
    // for storage.objects here), so we verify the introspectable 0093 surface:
    // the public.treatment_images RLS policies (0092 members select/insert/
    // update) + the 0093 integrity trigger. The private-bucket state above is
    // the headline storage hardening; the storage.objects policy list is a
    // MANUAL runbook check (docs/16 §17.13).
    const policies = Number(
      scalar(
        "select count(*) as n from pg_policies " +
          "where schemaname = 'public' and tablename = 'treatment_images';",
      ),
    );
    const trigger = Number(
      scalar(
        "select count(*) as n from pg_trigger " +
          "where tgname = 'treatment_images_enforce_integrity';",
      ),
    );
    if (policies >= 3 && trigger >= 1) {
      pass(
        "0093 policies/trigger",
        `${policies} treatment_images RLS policies, integrity trigger present`,
      );
    } else {
      fail("0093 policies/trigger", `policies=${policies} trigger=${trigger}`);
    }
  } catch (e) {
    fail("0093 policies/trigger", e.message);
  }

  // 0097 — intake link metadata columns on client_intake_forms.
  columnCountCheck(
    "0097 intake link columns",
    "client_intake_forms",
    ["intake_link_last_sent_at", "intake_link_expires_at", "intake_link_send_count"],
    3,
  );

  // 0098 — intake reminder columns + indexes + RPC branches on appointments.
  columnCountCheck(
    "0098 intake reminder columns",
    "appointments",
    [
      "intake_reminder_7d_sent_at",
      "intake_reminder_7d_send_attempts",
      "intake_reminder_7d_claimed_at",
      "intake_reminder_3d_sent_at",
      "intake_reminder_3d_send_attempts",
      "intake_reminder_3d_claimed_at",
    ],
    6,
  );
  try {
    const idx = Number(
      scalar(
        "select count(*) as n from pg_indexes where tablename = 'appointments' " +
          "and indexname in ('appointments_intake_reminder_7d_window_idx', " +
          "'appointments_intake_reminder_3d_window_idx');",
      ),
    );
    idx === 2
      ? pass("0098 reminder indexes", "2/2 window indexes")
      : fail("0098 reminder indexes", `${idx}/2`);
  } catch (e) {
    fail("0098 reminder indexes", e.message);
  }
  try {
    const ok = scalar(
      "select (" +
        "position('intake_reminder_7d' in pg_get_functiondef('public.claim_email_send(uuid,text)'::regprocedure)) > 0 and " +
        "position('intake_reminder_3d' in pg_get_functiondef('public.claim_email_send(uuid,text)'::regprocedure)) > 0 and " +
        "position('intake_reminder_7d' in pg_get_functiondef('public.record_email_result(uuid,text,boolean)'::regprocedure)) > 0 and " +
        "position('intake_reminder_3d' in pg_get_functiondef('public.record_email_result(uuid,text,boolean)'::regprocedure)) > 0" +
        ") as ok;",
    );
    ok === true
      ? pass("0098 RPC branches", "claim_email_send + record_email_result have intake_reminder_7d/3d")
      : fail("0098 RPC branches", "intake_reminder branches missing");
  } catch (e) {
    fail("0098 RPC branches", e.message);
  }

  // 0099 — treatment_images.practitioner_note.
  columnCountCheck(
    "0099 practitioner_note column",
    "treatment_images",
    ["practitioner_note"],
    1,
  );
}

function columnCountCheck(name, table, columns, expected) {
  try {
    const list = columns.map((c) => `'${c}'`).join(", ");
    const n = Number(
      scalar(
        "select count(*) as n from information_schema.columns " +
          `where table_schema = 'public' and table_name = '${table}' ` +
          `and column_name in (${list});`,
      ),
    );
    n === expected
      ? pass(name, `${n}/${expected} columns`)
      : fail(name, `${n}/${expected} columns present`);
  } catch (e) {
    fail(name, e.message);
  }
}

// ---------------------------------------------------------------------------
// 3. RLS enabled on the critical tables
// ---------------------------------------------------------------------------
function checkRls() {
  try {
    const list = CRITICAL_RLS_TABLES.map((t) => `'${t}'`).join(", ");
    const row = dbRows(
      "select count(*) as found, " +
        "count(*) filter (where not c.relrowsecurity) as rls_off " +
        "from pg_class c join pg_namespace n on n.oid = c.relnamespace " +
        `where n.nspname = 'public' and c.relkind = 'r' and c.relname in (${list});`,
    )[0];
    const found = Number(row.found);
    const rlsOff = Number(row.rls_off);
    if (found === CRITICAL_RLS_TABLES.length && rlsOff === 0) {
      pass("RLS on critical tables", `${found}/${CRITICAL_RLS_TABLES.length}, all enabled`);
    } else {
      fail(
        "RLS on critical tables",
        `found ${found}/${CRITICAL_RLS_TABLES.length}, ${rlsOff} without RLS`,
      );
    }
  } catch (e) {
    fail("RLS on critical tables", e.message);
  }
}

// ---------------------------------------------------------------------------
// 4. Unresolved critical payment ops alerts (count only — never message bodies)
// ---------------------------------------------------------------------------
function checkOpsAlerts() {
  try {
    const n = Number(
      scalar(
        "select count(*) as n from ops_alerts " +
          "where severity = 'critical' and resolved_at is null and (" +
          "event ilike '%payment%' or event ilike '%refund%' or " +
          "event ilike '%stripe%' or event ilike '%charge%');",
      ),
    );
    n === 0
      ? pass("Critical payment ops alerts", "0 unresolved")
      : fail("Critical payment ops alerts", `${n} unresolved (see /admin, not this script)`);
  } catch (e) {
    fail("Critical payment ops alerts", e.message);
  }
}

// ---------------------------------------------------------------------------
// 5. Stripe source gates — spawn the existing read-only source-grep gate.
// ---------------------------------------------------------------------------
function checkStripeGates() {
  const out = spawnSync("node", ["scripts/check-stripe-gates.mjs"], {
    encoding: "utf8",
    timeout: 60_000,
  });
  if (out.error) {
    fail("Stripe gates (1/1/0/0)", "could not run check-stripe-gates.mjs");
    return;
  }
  out.status === 0
    ? pass("Stripe gates (1/1/0/0)", "check-stripe-gates.mjs passed")
    : fail("Stripe gates (1/1/0/0)", `check-stripe-gates.mjs exit ${out.status}`);
}

// ---------------------------------------------------------------------------
// 6. Reminder scheduler heartbeat (fresh ≤ 45 min). Upstash REST GET, read-only.
//    Missing Upstash env → INCOMPLETE (fail-closed), NOT pass.
// ---------------------------------------------------------------------------
async function checkHeartbeat() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    incomplete(
      "Reminder scheduler heartbeat",
      "UPSTASH_REDIS_REST_URL/TOKEN not set — verify the Reminder scheduler card in /admin (see runbook)",
    );
    return;
  }
  try {
    const res = await fetch(`${url}/get/${HEARTBEAT_KEY}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      incomplete("Reminder scheduler heartbeat", `Upstash GET failed (status ${res.status})`);
      return;
    }
    const body = await res.json();
    const raw = body?.result;
    if (!raw) {
      fail("Reminder scheduler heartbeat", "no heartbeat recorded (scheduler may be down)");
      return;
    }
    const hb = typeof raw === "string" ? JSON.parse(raw) : raw;
    const at = hb?.at;
    const parsed = at ? Date.parse(at) : NaN;
    if (Number.isNaN(parsed)) {
      fail("Reminder scheduler heartbeat", "heartbeat has no valid timestamp");
      return;
    }
    const ageMinutes = Math.max(0, Math.round((Date.now() - parsed) / 60000));
    ageMinutes <= REMINDER_STALE_AFTER_MINUTES
      ? pass("Reminder scheduler heartbeat", `fresh (${ageMinutes} min ≤ ${REMINDER_STALE_AFTER_MINUTES})`)
      : fail("Reminder scheduler heartbeat", `stale (${ageMinutes} min > ${REMINDER_STALE_AFTER_MINUTES})`);
  } catch {
    // Never surface the Upstash URL/token in an error.
    incomplete("Reminder scheduler heartbeat", "Upstash read errored");
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log("Read-only production verification (PR #308)");
  console.log("Automated remote checks — no writes, no secrets, no PII.\n");

  console.log("Migration state:");
  checkMigrationMax();
  checkMigrationEffects();

  console.log("\nAccess control:");
  checkRls();

  console.log("\nPayments posture:");
  checkOpsAlerts();
  checkStripeGates();

  console.log("\nScheduler:");
  await checkHeartbeat();

  const failed = results.filter((r) => r.status === "FAIL");
  const incompletes = results.filter((r) => r.status === "INCOMPLETE");
  const passed = results.filter((r) => r.status === "PASS");

  console.log(
    `\nSummary: ${passed.length} PASS, ${failed.length} FAIL, ${incompletes.length} INCOMPLETE`,
  );
  console.log(
    "\nMANUAL checks still required (NOT covered here — see docs/16 §17.13):\n" +
      "  - Vercel PRODUCTION env: OPS_ALERT_EMAILS set, Upstash set, " +
      "STRIPE_ALLOW_LIVE_MODE unset/false, Stripe keys test-mode.\n" +
      "  - Stripe dashboard: mode / keys / account state.\n" +
      "  - Optional: read-only Vercel production log sample for 5xx/errors.\n" +
      "  - Reminder scheduler external dashboard if the heartbeat was INCOMPLETE.",
  );

  if (failed.length > 0 || incompletes.length > 0) {
    console.log(
      "\nNOT VERIFIED ✗ — automated checks did not fully pass (or could not be " +
        "verified). Do NOT treat production as ready. Resolve every FAIL/INCOMPLETE.",
    );
    process.exit(1);
  }
  console.log(
    "\nPRODUCTION VERIFIED ✓ (automated checks). Complete the MANUAL checks " +
      "above before enabling live payments or broadening sensitive-data use.",
  );
  process.exit(0);
}

main().catch((e) => {
  // Fail-closed on any unexpected error; never print secrets.
  console.log(`  FAIL   verify-production crashed — ${e?.message ?? "unknown error"}`);
  console.log("\nNOT VERIFIED ✗");
  process.exit(1);
});
