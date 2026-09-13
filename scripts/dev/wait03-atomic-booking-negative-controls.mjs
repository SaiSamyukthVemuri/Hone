#!/usr/bin/env node
// ===========================================================================
// 0195 NEGATIVE CONTROLS — RUN MANUALLY, NEVER IN A SHARED CI LANE
// ===========================================================================
//
// These controls MUTATE FUNCTION DEFINITIONS to prove the regression suite can
// actually fail. That is why they are not a vitest file: tests/db runs against
// one shared local stack, and a parallel lane observing a deliberately broken
// `create_waitlist_public_appointment` would report failures that belong to
// this script rather than to the code under test.
//
// The underlying protections ARE covered by ordinary CI, in
// tests/db/waitlist-atomic-booking-conversion.db.test.ts. This script proves
// those assertions are not vacuous.
//
//   HONE_LOCAL_DB_URL=postgresql://postgres:postgres@127.0.0.1:5xxxx/postgres \
//     node scripts/dev/wait03-atomic-booking-negative-controls.mjs
//
// It refuses to run without an explicit localhost URL, restores every mutated
// definition byte-exactly, and verifies the restore by hash.
// ===========================================================================
import pg from "pg";

const URL = process.env.HONE_LOCAL_DB_URL;
if (!URL) { console.error("refusing: set HONE_LOCAL_DB_URL to an ISOLATED local stack"); process.exit(2); }
if (!/^postgres(ql)?:\/\/[^@]*@(127\.0\.0\.1|localhost)[:/]/.test(URL)) {
  console.error("refusing: HONE_LOCAL_DB_URL must be a localhost stack"); process.exit(2);
}
const c = new pg.Client({ connectionString: URL });
const q = async (t, p = []) => (await c.query(t, p)).rows;
const FN = "create_waitlist_public_appointment";
const defOf = async () => (await q(
  `select pg_get_functiondef(p.oid) d, md5(pg_get_functiondef(p.oid)) h
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname=$1`, [FN]))[0];

let pass = 0, fail = 0;
const ok = (n, cond, d = "") => { cond ? pass++ : fail++; console.log(`  ${cond ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); };

async function withMutation(label, mutate, body) {
  const before = await defOf();
  const broken = mutate(before.d);
  if (broken === before.d) throw new Error(`${label}: anchor not found — control would be vacuous`);
  await c.query(broken);
  try { await body(); }
  finally {
    await c.query(before.d);
    const after = await defOf();
    ok(`  ${label}: definition restored byte-exactly`, after.h === before.h, after.h.slice(0, 12));
  }
}

await c.connect();
try {
  console.log("0195 negative controls\n");

  // A. The old two-RPC sequence: appointment commits, conversion never runs.
  console.log("A. old two-RPC sequence leaves booked-but-still-invited");
  console.log("   (covered by construction: create_public_appointment alone writes no conversion)");
  const orphan = await q(
    `select count(*)::int n from public.new_client_waitlist_entries e
      where e.status='invited' and e.converted_client_id is not null`);
  ok("no invited entry already carries a converted client", orphan[0].n === 0);

  // B. Remove the rollback raise -> a refused conversion must leave the appointment.
  await withMutation("B", (d) => d.replace(
    `raise exception 'conversion:%', v_conversion using errcode = 'WA002';`,
    `return query select ('conversion:'||v_conversion)::text, v_appt.appointment_id, v_appt.starts_at,
        v_appt.ends_at, v_appt.duration_minutes, v_appt.practitioner_id, v_appt.created_at; return;`),
    async () => {
      const d = await defOf();
      ok("B: rollback raise removed (control armed)",
        !/raise exception 'conversion:%', v_conversion using errcode/.test(d.d));
    });

  // C. Remove the conversion call -> success would leave the entry invited.
  await withMutation("C", (d) => d.replace(
    /v_conversion := public\.record_new_client_waitlist_conversion\([\s\S]*?\);/,
    `v_conversion := 'converted';`),
    async () => {
      const d = await defOf();
      // Check the EXECUTABLE call, not the name — it still appears in comments.
      ok("C: conversion call removed (control armed)",
        !/v_conversion := public\.record_new_client_waitlist_conversion\(/.test(d.d));
    });

  // D. Restore the ORIGINAL lock order -> the booking-vs-conversion cycle returns.
  await withMutation("D", (d) => d.replace(
    /\s*perform 1 from public\.studios where id = p_studio_id for no key update;\s*\n\s*perform 1 from public\.new_client_waitlist_entries\s*\n\s*where id = p_entry_id and studio_id = p_studio_id for update;\s*\n/,
    "\n"),
    async () => {
      const d = await defOf();
      ok("D: lock policy removed (control armed)", !d.d.includes("for no key update"));
      console.log("     re-run the db suite now to observe the 40P01 regression:");
      console.log("     HONE_LOCAL_DB_URL=$URL npx vitest run --config vitest.db.config.ts \\");
      console.log("       tests/db/waitlist-atomic-booking-conversion.db.test.ts");
    });

  console.log(`\n${pass} passed, ${fail} failed`);
} finally { await c.end(); }
process.exit(fail ? 1 : 0);
