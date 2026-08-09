#!/usr/bin/env node
/**
 * scripts/synthetic-mirror.mjs — privacy-safe synthetic studio mirror (operator CLI).
 *
 * PLANS a controlled TEST studio's population: generated fake clients,
 * appointments, sessions and intakes whose AGGREGATE SHAPE tracks a real
 * studio's, so the dashboard can be exercised at realistic scale. The source
 * studio contributes COUNTS AND NOTHING ELSE.
 *
 *   npm run synthetic-mirror:status     posture + config + safety
 *   npm run synthetic-mirror:dry-run    full plan + outbound-safety report
 *   npm run synthetic-mirror:sync       plan + the write-path boundary report
 *   npm run synthetic-mirror:reset      count what a governed reset could delete
 *
 * THIS TOOL PERFORMS NO DATABASE WRITES. Every command is read-only. Executing
 * the plan would need direct row creation in `sessions` / `appointments`, which
 * two shipped security guards hold at zero across scripts/ as well as app/ and
 * lib/ — see reportWriteBoundary() below for why that is respected rather than
 * exempted, and what a governed write path would require.
 *
 * SAFETY (mirrors scripts/verify-practitioner-capacity.mjs, the repository's
 * read-only production-operator precedent):
 *   - every READ uses `supabase db query --linked`. Never `db push`,
 *     never `db execute`, never a migration.
 *   - every read is aggregate or id-only. No client name, email, phone, DOB,
 *     intake answer, clinical note, image, payment id or token is ever selected
 *     from either studio.
 *   - the SOURCE studio is never written to, under any command. `reset` refuses
 *     it explicitly and separately from the target check.
 *   - FAIL-CLOSED: a check that cannot run is BLOCKED, never a silent SAFE, and
 *     the process exits non-zero.
 *   - the kill switch defaults OFF; mutating commands also require `--yes`.
 *
 * This is NOT a CI gate (CI has no production link) and it is NOT wired to any
 * cron. Scheduling is a separate, explicitly authorized change.
 */

import { spawnSync } from "node:child_process";
import {
  MirrorRefusal,
  assertMutationAllowed,
  assertNotSource,
  assertOperatorOwnsTarget,
  configProblems,
  ENV,
  loadConfig,
} from "./synthetic-mirror/config.mjs";
import { buildProfileSql, foldProfile, PROFILE_KEYS } from "./synthetic-mirror/profile.mjs";
import { buildPlan, isNoOpPlan, totalAppointments } from "./synthetic-mirror/plan.mjs";
import { ORDINAL_CEILING, syntheticIdSet } from "./synthetic-mirror/identity.mjs";
import {
  buildAppointmentRows,
  buildClientRows,
  buildIntakeRows,
  buildSessionRows,
  selectResettableIds,
} from "./synthetic-mirror/writer.mjs";

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------
const runId = `mirror_${Date.now().toString(36)}`;
let hadBlocker = false;

const line = (s = "") => console.log(s);
const head = (s) => { line(); line(`── ${s} ${"─".repeat(Math.max(0, 60 - s.length))}`); };
const info = (k, v) => line(`  ${k.padEnd(34)} ${v}`);
function verdict(channel, state, why) {
  const tag = state === "SAFE" ? "SAFE / OFF" : "BLOCKED — DO NOT POPULATE";
  if (state !== "SAFE") hadBlocker = true;
  line(`  ${channel.padEnd(12)} ${tag.padEnd(28)} ${why}`);
}

// ---------------------------------------------------------------------------
// Read-only DB access. `db query` only — never `db execute` (CLAUDE.md §5).
// ---------------------------------------------------------------------------
function dbRows(sql) {
  const out = spawnSync("supabase", ["db", "query", "--linked", sql], {
    encoding: "utf8",
    timeout: 120_000,
  });
  if (out.error) {
    throw new Error(
      `supabase CLI unavailable (${out.error.code || out.error.message}). ` +
        "Run from the production-linked environment.",
    );
  }
  if (out.status !== 0) {
    // Never echo stderr verbatim — it can contain a connection string.
    throw new Error(`supabase db query failed (exit ${out.status}). Is the CLI linked?`);
  }
  const text = out.stdout || "";
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("Could not parse supabase db query output.");
  }
  const parsed = JSON.parse(text.slice(start, end + 1));
  return parsed.rows ?? [];
}

const q = (id) => `'${String(id).replace(/'/g, "''")}'`;

// ---------------------------------------------------------------------------
// Target census — ids only, filtered to UUID version 8 (see identity.mjs).
// A v4 id (everything Hone creates organically) can never appear here.
// ---------------------------------------------------------------------------
const TABLE_FOR_ENTITY = {
  client: "public.clients",
  appointment: "public.appointments",
  session: "public.sessions",
  intake: "public.client_intake_forms",
};

function censusIds(studioId, entity) {
  const table = TABLE_FOR_ENTITY[entity];
  const rows = dbRows(
    `select id::text as id from ${table} where studio_id = ${q(studioId)} and substring(id::text, 15, 1) = '8'`,
  );
  return rows.map((r) => r.id);
}

function countAll(studioId, table) {
  const rows = dbRows(`select count(*)::int as n from ${table} where studio_id = ${q(studioId)}`);
  return Number(rows[0]?.n ?? 0);
}

function targetCensus(config) {
  const sid = config.targetStudioId;
  const census = {};
  for (const entity of ["client", "appointment", "session", "intake"]) {
    const present = censusIds(sid, entity);
    const derivable = syntheticIdSet(sid, entity, ORDINAL_CEILING);
    const { deletable } = selectResettableIds(present, derivable);
    census[entity] = { present: present.length, synthetic: deletable.length };
  }
  census.totals = {
    clients: countAll(sid, "public.clients"),
    appointments: countAll(sid, "public.appointments"),
    sessions: countAll(sid, "public.sessions"),
    intakes: countAll(sid, "public.client_intake_forms"),
  };
  return census;
}

// ---------------------------------------------------------------------------
// Outbound safety (Phase 2 / Phase 14)
// ---------------------------------------------------------------------------
function readTargetPosture(studioId) {
  const rows = dbRows(
    `select send_confirmation_emails, send_24h_reminders, send_2h_reminders,
            send_no_show_followup, notify_practitioner_on_new_booking,
            send_confirmation_sms, send_24h_sms_reminders, send_2h_sms_reminders,
            postcare_delivery_mode,
            google_calendar_connection_enabled, google_calendar_outbound_sync_enabled
       from public.studios where id = ${q(studioId)}`,
  );
  if (rows.length !== 1) throw new Error("target studio not found");
  return rows[0];
}

/**
 * The synthetic rows this tool creates always carry email IS NULL and
 * phone IS NULL, which is what makes email and SMS structurally impossible
 * rather than merely disabled. We verify that invariant against the DATABASE
 * rather than trusting the generator, so a future edit to the generator is
 * caught here instead of in production.
 */
function verifySyntheticContactNulls(studioId) {
  const rows = dbRows(
    `select count(*)::int as n from public.clients
      where studio_id = ${q(studioId)}
        and substring(id::text, 15, 1) = '8'
        and (email is not null or phone is not null)`,
  );
  return Number(rows[0]?.n ?? 0);
}

function reportOutboundSafety(config, posture) {
  head("OUTBOUND SAFETY");
  const leaks = verifySyntheticContactNulls(config.targetStudioId);

  if (leaks === 0) {
    verdict(
      "EMAIL",
      "SAFE",
      "synthetic clients have email IS NULL; every send path requires an address",
    );
    verdict("SMS", "SAFE", "synthetic clients have phone IS NULL; Twilio path short-circuits");
    verdict("POSTCARE", "SAFE", `delivery_mode=${posture.postcare_delivery_mode}, and no address to send to`);
  } else {
    verdict("EMAIL", "BLOCKED", `${leaks} synthetic client(s) carry an email or phone — contact fields must be NULL`);
    verdict("SMS", "BLOCKED", "see EMAIL");
    verdict("POSTCARE", "BLOCKED", "see EMAIL");
  }

  verdict(
    "GOOGLE",
    posture.google_calendar_outbound_sync_enabled ? "BLOCKED" : "SAFE",
    `outbound_sync_enabled=${posture.google_calendar_outbound_sync_enabled}, connection=${posture.google_calendar_connection_enabled}`,
  );
  verdict("STRIPE", "SAFE", "no payment/ledger fixture is created — production Stripe is LIVE mode");
  verdict(
    "CRON",
    leaks === 0 ? "SAFE" : "BLOCKED",
    "reminder cron may SELECT synthetic appointments; every send short-circuits on NULL email/phone",
  );

  line();
  line("  Studio email toggles are reported for context only — they are NOT the guarantee:");
  info("send_confirmation_emails", String(posture.send_confirmation_emails));
  info("send_24h_reminders", String(posture.send_24h_reminders));
  info("send_2h_reminders", String(posture.send_2h_reminders));
  info("notify_practitioner_on_new_booking", String(posture.notify_practitioner_on_new_booking));
  line();
  line("  The intake-reminder pass in app/api/cron/appointment-reminders/route.ts has NO");
  line("  studio toggle, and that endpoint is fired by an EXTERNAL scheduler. NULL contact");
  line("  fields are therefore the only guarantee that does not depend on configuration.");
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
function cmdStatus(config) {
  head("CONFIGURATION");
  info("run id", runId);
  info(`${ENV.enabled}`, config.enabled ? "true (mutations ALLOWED)" : "false (kill switch OFF — default)");
  info(`${ENV.sourceStudioId}`, config.sourceStudioId ?? "(unset)");
  info(`${ENV.targetStudioId}`, config.targetStudioId ?? "(unset)");
  info(`${ENV.operatorEmail}`, config.operatorEmail ? "(set)" : "(unset)");

  const problems = configProblems(config);
  head("CONFIG CHECKS");
  if (problems.length === 0) line("  PASS   configuration is structurally usable");
  else for (const p of problems) { hadBlocker = true; line(`  FAIL   ${p}`); }
  return problems.length === 0;
}

function resolveOwnership(config) {
  const rows = dbRows(
    `select p.studio_id::text as studio_id, p.role, p.active, u.email
       from public.practitioners p join auth.users u on u.id = p.user_id
      where p.studio_id = ${q(config.targetStudioId)} and p.role = 'owner' and p.active`,
  );
  return rows;
}

function cmdDryRun(config) {
  if (!cmdStatus(config)) throw new MirrorRefusal("configuration is not usable");

  head("OWNERSHIP");
  assertOperatorOwnsTarget(config, resolveOwnership(config));
  line("  PASS   configured operator holds an ACTIVE OWNER membership of the target studio");
  assertNotSource(config, config.targetStudioId);
  line("  PASS   target is not the source studio");

  head("SOURCE (aggregate only — no row is ever selected)");
  const profile = foldProfile(dbRows(buildProfileSql(config.sourceStudioId)));
  for (const k of PROFILE_KEYS) info(k, String(profile[k]));
  info("appointments_total", String(totalAppointments(profile)));

  head("TARGET");
  const census = targetCensus(config);
  info("clients (all / provably synthetic)", `${census.totals.clients} / ${census.client.synthetic}`);
  info("appointments (all / synthetic)", `${census.totals.appointments} / ${census.appointment.synthetic}`);
  info("sessions (all / synthetic)", `${census.totals.sessions} / ${census.session.synthetic}`);
  info("intakes (all / synthetic)", `${census.totals.intakes} / ${census.intake.synthetic}`);

  const nonSynthetic = census.totals.clients - census.client.synthetic;
  if (nonSynthetic > 0) {
    line();
    line(`  NOTE   ${nonSynthetic} target client(s) are NOT provably synthetic.`);
    line("         They will be left completely untouched: the mirror only ever");
    line("         inserts new deterministic ids, and reset deletes only ids it can");
    line("         re-derive. Nothing here can modify or remove them.");
  }

  const plan = buildPlan(profile, {
    syntheticClients: census.client.synthetic,
    syntheticAppointments: census.appointment.synthetic,
    syntheticSessions: census.session.synthetic,
    syntheticIntakes: census.intake.synthetic,
  });

  head("PLAN");
  info("clients to create", String(plan.clients.toCreate));
  info("appointments to create", String(plan.appointments.toCreate));
  info("sessions to create", String(plan.sessions.toCreate));
  info("intakes to create", String(plan.intakes.toCreate));
  info("appointment mix", JSON.stringify(plan.appointments.mix));
  info("intake mix", JSON.stringify(plan.intakes.mix));
  info("session mix", JSON.stringify(plan.sessions.mix));
  line();
  for (const s of plan.skipped) line(`  SKIPPED  ${s.what}\n           ${s.why}`);

  reportOutboundSafety(config, readTargetPosture(config.targetStudioId));

  head("RESULT");
  if (hadBlocker) {
    line("  BLOCKED — DO NOT POPULATE. Resolve the blockers above first.");
  } else if (isNoOpPlan(plan)) {
    line("  Target already matches the source's aggregate shape. Nothing to do.");
  } else {
    line("  Plan is safe to apply. This was a DRY RUN — nothing was written.");
  }
  return plan;
}

/**
 * WHY THIS TOOL CANNOT WRITE — read before adding an insert.
 * ==========================================================
 * The reconciliation PLAN is computed and reported in full, but this CLI
 * executes no DML at all. That is a deliberate consequence of a shipped
 * security boundary, not an unfinished feature:
 *
 *   - tests/security/entry-direct-dml-guard.test.ts (L18 Phase 4) requires the
 *     direct-writer census for `sessions`, `session_blocks`,
 *     `session_block_areas`, `electrolysis_entries`, `laser_entries` and
 *     `treatment_images` to be ZERO across app/, lib/, components/ AND
 *     scripts/. Its exception list is empty and the file states there is no
 *     list left to append to.
 *   - tests/security/appointment-direct-dml-guard.test.ts freezes `appointments`
 *     at exactly seven reviewed writers, every one of them an UPDATE — the
 *     repository creates and deletes no appointment directly.
 *
 * A synthetic-fixture writer under scripts/ is precisely the kind of backdoor
 * those guards exist to stop, and it should not get an exemption for being
 * well-intentioned. Fixture convenience does not outrank the clinical-write
 * boundary.
 *
 * Enabling population is therefore a SEPARATE, EXPLICITLY REVIEWED change, and
 * it needs a governed write path rather than a direct insert. The options, none
 * of which is taken here:
 *
 *   1. a service_role-only RPC command owning the fixture writes, added in a
 *      migration — but 0174-0178 are reserved by the security roadmap, so the
 *      number must be agreed first;
 *   2. running the row builders from an out-of-repo operator process, so no
 *      in-repo writer exists to breach the census;
 *   3. deliberately extending the census exception list — a visible, reviewed
 *      weakening of L18 that should need a strong argument.
 *
 * Everything needed to review the design is here: writer.mjs builds the exact
 * rows, and `dry-run` prints exactly what would be written.
 */
function reportWriteBoundary() {
  head("WRITE PATH");
  line("  This tool performs NO database writes.");
  line();
  line("  Executing the plan would require direct row creation in `sessions` and");
  line("  `appointments`, which breaches two shipped security guards:");
  line("    - L18 Phase 4 (entry-direct-dml-guard): direct writers must be ZERO,");
  line("      across scripts/ as well, with an intentionally empty exception list;");
  line("    - appointment-direct-dml-guard: appointments has exactly seven");
  line("      reviewed writers, all UPDATE.");
  line();
  line("  Population is a separate, explicitly authorized change that needs a");
  line("  governed write path. See the block comment above this function.");
}

function cmdSync(config, argv) {
  assertMutationAllowed(config);
  if (!argv.includes("--yes")) {
    throw new MirrorRefusal("refusing to proceed without --yes (this is a production studio)");
  }
  const plan = cmdDryRun(config);
  if (hadBlocker) throw new MirrorRefusal("a safety check is BLOCKED — refusing to continue");
  reportWriteBoundary();
  return plan;
}

function cmdReset(config, argv) {
  assertMutationAllowed(config);
  assertNotSource(config, config.targetStudioId);
  assertOperatorOwnsTarget(config, resolveOwnership(config));

  head("RESET — selection");
  const sid = config.targetStudioId;
  let totalDeletable = 0;
  for (const entity of ["intake", "session", "appointment", "client"]) {
    const present = censusIds(sid, entity);
    const derivable = syntheticIdSet(sid, entity, ORDINAL_CEILING);
    const { deletable, refused } = selectResettableIds(present, derivable);
    totalDeletable += deletable.length;
    info(`${entity}: provably synthetic`, String(deletable.length));
    if (refused.length > 0) {
      info(`${entity}: REFUSED (not provable)`, String(refused.length));
    }
  }
  line();
  info("rows that a future reset would delete", String(totalDeletable));
  line();
  line("  Only ids re-derivable from the synthetic namespace are ever selected;");
  line("  anything else is refused and left untouched. There is deliberately no");
  line("  `delete ... where studio_id = ...` path in this tool.");
  reportWriteBoundary();
  if (argv.includes("--yes")) {
    line();
    line("  --yes acknowledged, but deletion is not implemented (see WRITE PATH).");
  }
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------
function main() {
  const argv = process.argv.slice(2);
  const command = argv[0] ?? "status";
  const config = loadConfig();

  line("Hone — synthetic studio mirror");
  line(`command: ${command}`);

  try {
    if (command === "status") cmdStatus(config);
    else if (command === "dry-run") cmdDryRun(config);
    else if (command === "sync") cmdSync(config, argv);
    else if (command === "reset") cmdReset(config, argv);
    else {
      line(`unknown command "${command}" — expected status | dry-run | sync | reset`);
      process.exit(2);
    }
  } catch (err) {
    line();
    if (err instanceof MirrorRefusal) line(`REFUSED: ${err.message}`);
    else line(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  process.exit(hadBlocker ? 1 : 0);
}

main();
