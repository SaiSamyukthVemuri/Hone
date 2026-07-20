#!/usr/bin/env node
/**
 * scripts/verify-practitioner-capacity.mjs — PR A (practitioner-capacity foundation)
 *
 * Operator-run, READ-ONLY, NO-PII health check for the practitioner-capacity
 * layer (migration 0134). It proves the layer is present and, above all, that
 * it is DORMANT and Willow-safe: no production studio has the flag on, and every
 * flag-OFF studio's calendar shadow is still keyed studio-wide (resource_key =
 * studio_id) exactly as before. It also surfaces the structural invariants a
 * later activation depends on (eligibility coverage, mirror consistency, no
 * orphan rows, no per-practitioner overlaps).
 *
 * Run (from the production-linked Mac):
 *   node --env-file=.env.local scripts/verify-practitioner-capacity.mjs
 *
 * SAFETY (hard rules — enforced by tests/scripts/verify-practitioner-capacity.test.ts):
 *   - READ-ONLY. Uses `supabase db query --linked` for every DB read. It NEVER
 *     runs `supabase db push` / `supabase db execute`, never applies a
 *     migration, never INSERT/UPDATE/DELETE/UPSERT, never toggles a flag.
 *   - NO SECRETS / NO PII. Every query returns SCALARS only (counts, booleans,
 *     and studio UUIDs — which are not personal data). It never selects or
 *     prints client/practitioner names, emails, phones, notes, tokens, or any
 *     health/treatment data. No `select *`.
 *   - FAIL-CLOSED. A required check that cannot run is FAIL/INCOMPLETE — never a
 *     silent PASS — and the script exits non-zero.
 *
 * This is NOT a CI gate (CI has no production link) and NOT an activation
 * script. It never enables the flag for any studio.
 */

import { spawnSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Output helpers — PASS / FAIL / INCOMPLETE / INFO, scalars only.
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
// Informational report line — NOT a pass/fail gate (never pushed to results, so
// it never affects the summary or exit code). Scalars / booleans / studio ids.
function report(name, detail) {
  console.log(`  INFO   ${name}${detail ? ` — ${detail}` : ""}`);
}

// ---------------------------------------------------------------------------
// Read-only DB access via the linked Supabase CLI. `db query` is READ-ONLY; we
// NEVER use `db push` / `db execute`. Returns the parsed `rows` array, or throws
// (fail-closed) if the CLI is unavailable / not linked / errors.
// ---------------------------------------------------------------------------
function dbRows(sql) {
  const out = spawnSync("supabase", ["db", "query", "--linked", sql], {
    encoding: "utf8",
    timeout: 60_000,
  });
  if (out.error) {
    throw new Error(
      `supabase CLI not available (${out.error.code || out.error.message}). ` +
        `Run from the production-linked environment.`,
    );
  }
  if (out.status !== 0) {
    // Do NOT echo stderr verbatim (could contain a connection string).
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
function scalar(sql) {
  const rows = dbRows(sql);
  const row = rows[0] ?? {};
  const keys = Object.keys(row);
  return keys.length ? row[keys[0]] : undefined;
}
const n = (v) => Number(v ?? 0);

// ---------------------------------------------------------------------------
// 1. Schema present — the 0134 objects exist.
// ---------------------------------------------------------------------------
function checkSchemaPresent() {
  try {
    const flag = n(
      scalar(
        "select count(*) as c from information_schema.columns " +
          "where table_schema='public' and table_name='studios' " +
          "and column_name='practitioner_capacity_enabled';",
      ),
    );
    const rk = n(
      scalar(
        "select count(*) as c from information_schema.columns " +
          "where table_schema='public' and table_name='studio_calendar_reservations' " +
          "and column_name='resource_key';",
      ),
    );
    const elig = n(
      scalar(
        "select count(*) as c from information_schema.tables " +
          "where table_schema='public' and table_name='service_practitioners';",
      ),
    );
    if (flag === 1 && rk === 1 && elig === 1) {
      pass("0134 schema present", "flag + resource_key + service_practitioners");
    } else {
      fail(
        "0134 schema present",
        `flag=${flag} resource_key=${rk} service_practitioners=${elig} (each expected 1)`,
      );
    }
  } catch (e) {
    fail("0134 schema present", e.message);
  }
}

// ---------------------------------------------------------------------------
// 2. Dormancy — no studio has the flag on (the PR A / Willow invariant). Reports
//    the enabled studio ids (UUIDs, not PII) if any so an operator can confirm
//    intent post-activation. PASS at zero.
// ---------------------------------------------------------------------------
function checkDormant() {
  try {
    const enabled = n(
      scalar(
        "select count(*) as c from public.studios where practitioner_capacity_enabled = true;",
      ),
    );
    if (enabled === 0) {
      pass("Capacity dormant", "0 studios enabled (Willow + all studios OFF)");
    } else {
      // Not a hard failure post-activation, but always surfaced for review.
      const ids = dbRows(
        "select id from public.studios where practitioner_capacity_enabled = true order by id;",
      )
        .map((r) => r.id)
        .join(", ");
      report("Capacity ENABLED studios (review intent)", `${enabled}: ${ids}`);
      fail(
        "Capacity dormant",
        `${enabled} studio(s) have the flag ON — expected 0 for the dormant PR A state`,
      );
    }
  } catch (e) {
    fail("Capacity dormant", e.message);
  }
}

// ---------------------------------------------------------------------------
// 2b. Two-flag state model (0136). Reports the derived Legacy/Configuring/Live/
//     Draining state, proves the invalid state (capacity OFF + booking ON) is
//     absent, and — for any enabled studio — the structural-deactivation
//     blockers (booking still on, overlapping appointments). No PII.
// ---------------------------------------------------------------------------
function checkStateModel() {
  try {
    const bookingOn = n(
      scalar(
        "select count(*) as c from public.studios where practitioner_capacity_booking_enabled = true;",
      ),
    );
    bookingOn === 0
      ? pass("Booking dormant", "0 studios accept practitioner-aware bookings")
      : report("Booking ENABLED studios (review intent)", String(bookingOn));

    const invalid = n(
      scalar(
        "select count(*) as c from public.studios " +
          "where practitioner_capacity_booking_enabled = true and practitioner_capacity_enabled = false;",
      ),
    );
    invalid === 0
      ? pass("No invalid capacity state", "no studio has booking on without capacity")
      : fail("No invalid capacity state", `${invalid} studio(s) booking-on without capacity`);

    // Derived-state + retirement-blocker report for any enabled studio.
    const rows = dbRows(
      "select id, practitioner_capacity_enabled cap, practitioner_capacity_booking_enabled book " +
        "from public.studios where practitioner_capacity_enabled = true order by id;",
    );
    for (const r of rows) {
      // Only THREE technical states exist; "configuring" vs "draining" is an
      // operational reading of CAPACITY_READY_BOOKING_PAUSED, surfaced via the
      // operational indicators (overlaps / blockers), not a distinct DB state.
      const state = r.book ? "LIVE" : "CAPACITY_READY_BOOKING_PAUSED";
      const overlaps = n(
        scalar(
          "select count(*) as c from public.appointments a1 " +
            "join public.appointments a2 on a1.studio_id=a2.studio_id and a1.id<a2.id " +
            `where a1.studio_id='${r.id}' and a1.status='confirmed' and a2.status='confirmed' ` +
            "and tstzrange(a1.starts_at,a1.blocked_ends_at,'[)') && tstzrange(a2.starts_at,a2.blocked_ends_at,'[)');",
        ),
      );
      report(
        `Studio ${r.id} state`,
        `${state}; deactivation blockers: booking_on=${!!r.book}, overlapping_appointments=${overlaps}`,
      );
    }
  } catch (e) {
    fail("State model", e.message);
  }
}

// ---------------------------------------------------------------------------
// 3. OFF-studio reservation parity — the core Willow-safety invariant. Every
//    shadow row belonging to a flag-OFF studio must be keyed studio-wide
//    (resource_key = studio_id), i.e. identical to pre-0134 behaviour.
// ---------------------------------------------------------------------------
function checkOffParity() {
  try {
    const bad = n(
      scalar(
        "select count(*) as c from public.studio_calendar_reservations r " +
          "join public.studios s on s.id = r.studio_id " +
          "where s.practitioner_capacity_enabled = false and r.resource_key <> r.studio_id;",
      ),
    );
    if (bad === 0) {
      pass("OFF-studio reservation parity", "all OFF rows keyed studio-wide");
    } else {
      fail(
        "OFF-studio reservation parity",
        `${bad} OFF-studio shadow row(s) not keyed to studio_id`,
      );
    }
  } catch (e) {
    fail("OFF-studio reservation parity", e.message);
  }
}

// ---------------------------------------------------------------------------
// 4. Structural integrity — resource_key NOT NULL; capacity_enabled mirror
//    matches each appointment's studio flag; no ON appointment lacks a
//    practitioner (the CHECK invariant, verified independently).
// ---------------------------------------------------------------------------
function checkIntegrity() {
  try {
    const nullKey = n(
      scalar(
        "select count(*) as c from public.studio_calendar_reservations where resource_key is null;",
      ),
    );
    nullKey === 0
      ? pass("resource_key not null", "0 null keys")
      : fail("resource_key not null", `${nullKey} null resource_key rows`);

    const mismatch = n(
      scalar(
        "select count(*) as c from public.appointments a " +
          "join public.studios s on s.id = a.studio_id " +
          "where a.capacity_enabled <> s.practitioner_capacity_enabled;",
      ),
    );
    mismatch === 0
      ? pass("capacity_enabled mirror", "matches studio flag")
      : fail("capacity_enabled mirror", `${mismatch} appointment(s) out of sync`);

    // Only collision-participating statuses (confirmed/completed) must carry a
    // practitioner when ON; cancelled/no_show may legitimately be null.
    const nullPract = n(
      scalar(
        "select count(*) as c from public.appointments " +
          "where capacity_enabled = true and practitioner_id is null " +
          "and status in ('confirmed','completed');",
      ),
    );
    nullPract === 0
      ? pass("ON appointments carry a practitioner", "0 null-practitioner confirmed/completed ON rows")
      : fail(
          "ON appointments carry a practitioner",
          `${nullPract} confirmed/completed ON appointment(s) with null practitioner_id`,
        );
  } catch (e) {
    fail("Structural integrity", e.message);
  }
}

// ---------------------------------------------------------------------------
// 5. Orphan reservations — every shadow row's source must still exist.
// ---------------------------------------------------------------------------
function checkOrphans() {
  try {
    const orphans = n(
      scalar(
        "select count(*) as c from public.studio_calendar_reservations r where " +
          "(r.source_kind='appointment' and not exists (select 1 from public.appointments a where a.id=r.source_id)) or " +
          "(r.source_kind='timed_block' and not exists (select 1 from public.studio_timed_blocks t where t.id=r.source_id)) or " +
          "(r.source_kind='full_day_blockout' and not exists (select 1 from public.studio_blockouts b where b.id=r.source_id)) or " +
          "(r.source_kind='recurring_break_occurrence' and not exists (select 1 from public.studio_recurring_break_occurrences o where o.id=r.source_id));",
      ),
    );
    orphans === 0
      ? pass("No orphan reservations", "every shadow row has a live source")
      : fail("No orphan reservations", `${orphans} orphan shadow row(s)`);
  } catch (e) {
    fail("No orphan reservations", e.message);
  }
}

// ---------------------------------------------------------------------------
// 6. Eligibility coverage — every service with at least one active practitioner
//    in its studio has at least one eligible practitioner mapping (the backfill
//    invariant). Reports the eligible-mapping total for visibility.
// ---------------------------------------------------------------------------
function checkEligibility() {
  try {
    const total = n(
      scalar("select count(*) as c from public.service_practitioners;"),
    );
    report("Eligible service→practitioner mappings", String(total));

    const uncovered = n(
      scalar(
        "select count(*) as c from public.services s " +
          "where exists (select 1 from public.practitioners p where p.studio_id=s.studio_id and p.active=true) " +
          "and not exists (select 1 from public.service_practitioners sp where sp.service_id=s.id);",
      ),
    );
    uncovered === 0
      ? pass("Eligibility coverage", "every service has an eligible active practitioner")
      : fail("Eligibility coverage", `${uncovered} service(s) with active practitioners but no mapping`);

    // Same-studio integrity: composite FKs make cross-studio rows impossible,
    // but verify none slipped in before the FKs (defense in depth).
    const crossStudio = n(
      scalar(
        "select count(*) as c from public.service_practitioners sp " +
          "join public.services s on s.id=sp.service_id " +
          "join public.practitioners p on p.id=sp.practitioner_id " +
          "where s.studio_id <> sp.studio_id or p.studio_id <> sp.studio_id;",
      ),
    );
    crossStudio === 0
      ? pass("Eligibility same-studio", "no cross-studio mappings")
      : fail("Eligibility same-studio", `${crossStudio} cross-studio mapping(s)`);
  } catch (e) {
    fail("Eligibility coverage", e.message);
  }
}

// ---------------------------------------------------------------------------
// 7. No per-practitioner overlaps — belt-and-suspenders read of the invariant
//    the GiST exclusions enforce: no two confirmed ON appointments for the same
//    practitioner overlap, and no two shadow rows share a resource_key with
//    overlapping ranges. Both must be zero.
// ---------------------------------------------------------------------------
function checkOverlaps() {
  try {
    const apptOverlap = n(
      scalar(
        "select count(*) as c from public.appointments a1 " +
          "join public.appointments a2 on a1.practitioner_id=a2.practitioner_id and a1.id<a2.id " +
          "where a1.status='confirmed' and a2.status='confirmed' " +
          "and a1.capacity_enabled=true and a2.capacity_enabled=true " +
          "and tstzrange(a1.starts_at,a1.blocked_ends_at,'[)') && tstzrange(a2.starts_at,a2.blocked_ends_at,'[)');",
      ),
    );
    apptOverlap === 0
      ? pass("No same-practitioner overlaps", "0 overlapping ON appointment pairs")
      : fail("No same-practitioner overlaps", `${apptOverlap} overlapping pair(s)`);

    const resOverlap = n(
      scalar(
        "select count(*) as c from public.studio_calendar_reservations r1 " +
          "join public.studio_calendar_reservations r2 on r1.resource_key=r2.resource_key and r1.id<r2.id " +
          "where tstzrange(r1.starts_at,r1.ends_at,'[)') && tstzrange(r2.starts_at,r2.ends_at,'[)');",
      ),
    );
    resOverlap === 0
      ? pass("No resource-key overlaps", "shadow exclusion invariant holds")
      : fail("No resource-key overlaps", `${resOverlap} overlapping shadow pair(s)`);
  } catch (e) {
    fail("No per-practitioner overlaps", e.message);
  }
}

// ---------------------------------------------------------------------------
// 8. Report — active-practitioner distribution (aggregate, no PII).
// ---------------------------------------------------------------------------
function reportPractitionerCounts() {
  try {
    const multi = n(
      scalar(
        "select count(*) as c from (select studio_id from public.practitioners " +
          "where active=true group by studio_id having count(*) > 1) t;",
      ),
    );
    report("Studios with >1 active practitioner", String(multi));
  } catch (e) {
    report("Studios with >1 active practitioner", `unavailable — ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------
function main() {
  console.log("\nPractitioner-capacity verification (READ-ONLY, no PII)\n");
  checkSchemaPresent();
  checkDormant();
  checkStateModel();
  checkOffParity();
  checkIntegrity();
  checkOrphans();
  checkEligibility();
  checkOverlaps();
  reportPractitionerCounts();

  const failed = results.filter((r) => r.status === "FAIL").length;
  const incompleteN = results.filter((r) => r.status === "INCOMPLETE").length;
  const passed = results.filter((r) => r.status === "PASS").length;
  console.log(
    `\n${passed} PASS · ${failed} FAIL · ${incompleteN} INCOMPLETE\n`,
  );
  // Fail-closed: any FAIL or INCOMPLETE exits non-zero.
  process.exit(failed > 0 || incompleteN > 0 ? 1 : 0);
}

main();
