// Synthetic fixtures only: invented counts, no real result, no studio, no id. Run: node --test compare-preflight.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, symlinkSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FILES, G2, W3_TABLES, S1_TABLES, CHECKSUM_VERSIONS, SUPERSEDED_0214_SHA, PINNED_0214_SHA, BLACKOUT_UTC, evaluate, evaluateS1, readRows, NEW_0214_FUNCTIONS, format } from "./compare-preflight-lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sha = (t) => createHash("sha256").update(t).digest("hex");

const J = (rows) => JSON.stringify({ rows });
const clone = (o) => JSON.parse(JSON.stringify(o));
const versions = Array.from({ length: 34 }, (_, i) => String(213 + i).padStart(4, "0"));

function goodResults() {
  const studios = 8, ords = [1, 2, 3, 4, 5, 6, 7, 8];
  const reach = new Set([2, 4, 5]);
  const g11b = ["fluence", "pulse_width", "spot_size"].map((k) => ({ at_hosted_0212: 1, leaf_key: k, class_n_non_object_blob: 0, class_x1_finalized_or_void: 0, class_x2_soft_deleted: 0, class_h1_number: 0, class_h2_total: 0, nonconforming_total: 0 }));
  g11b.push({ at_hosted_0212: 1, leaf_key: "ALL_ROWS", class_n_non_object_blob: 0, class_x1_finalized_or_void: 0, class_x2_soft_deleted: 0, class_h1_number: 0, class_h2_total: 0, package_g11_rows: 0, reconciles: true });
  return {
    "g02-history": J([{ ...G2 }]),
    "g06-payment-drain": J([{ at_hosted_0212: 1, d1_ready: 0, d1_pending_stripe: 0, d1_pending_unbindable: 0, d2_refund_pending: 0, d3_claimed_inflight: 0, d3_unprocessed_unclaimed: 0, d3_errored_any_type: 0, d4_account_provisioning_open: 0, d4_customer_provisioning_open: 0, info_receipt_sending: 3, info_saved_cards_total_pre_0245: 2 }]),
    "g07-sms-claimed-number-duplicates": J([{ at_hosted_0212: 1, duplicated_numbers: 0, rows_in_duplicates: 0, info_live_claimed_rows: 4 }]),
    "g09a-0214-reach-summary": J([{ at_hosted_0212: 1, studios, reachable_by_setter: 3, refused_account: 4, refused_money_only: 1 }]),
    "g09b-0214-reach-per-studio": J(ords.map((o) => ({ at_hosted_0212: 1, studio_ordinal: o, bound_account_rows: o % 2, r2a_reachable: reach.has(o), needs_ack_prices: !reach.has(o) }))),
    "g09c-0214-bound-account-mode": J(ords.map((o) => ({ at_hosted_0212: 1, studio_ordinal: o, present: true, bound_live: o % 2, bound_test: 0, bound_unknown_mode: 0, observed_country_column_present: false }))),
    "g10-constraint-names": J(Array.from({ length: 7 }, (_, i) => ({ at_hosted_0212: 1, con_oid: i, present: true, present_total: 7, other_checks_on_key_column: 0 }))),
    "g11-0244-legacy-laser-types": J([{ at_hosted_0212: 1, wrong_type_rows: 0, wrong_type_fluence: 0, wrong_type_pulse_width: 0, wrong_type_spot_size: 0 }]),
    "g11b-0244-legacy-laser-classes": J(g11b),
    "g12-0243-intake-definers": J([{ at_hosted_0212: 1, signature: null, owner: null, anon_exec: null, authenticated_exec: null, service_role_exec: null, callable: null, definers_total: 0, callable_total: 0 }]),
    "census-0213-0246": J(versions.map((v) => ({ version: v, objects_checked: v === "0214" ? 30 : 5, present_now: 0 }))),
    "w03-table-sizes": J(W3_TABLES.map((t) => ({ at_hosted_0212: 1, table_name: t, present: true, total_bytes: 1048576, approx_rows: 1000, statement_timeout: "0", lock_timeout: "0" }))),
    "s1-open-transactions": J(S1_TABLES.map((t) => ({ at_hosted_0212: 1, table_name: t, xact_age_seconds: 60, table_present: true, old_xact_backends: 0, old_idle_in_xact_backends: 0, waiting_backends: 0, any_xact_backends: 1, oldest_xact_age_seconds: 2, old_xact_backends_database_wide: 0 }))),
  };
}
const WS = "2026-10-26T23:00:00Z", WE = "2026-10-27T02:00:00Z", NOW = Date.parse("2026-10-26T23:40:00Z");
const hx = (c) => c.repeat(64);
const checksums = () => Object.fromEntries(CHECKSUM_VERSIONS.map((v) => [v, v === "0214" ? PINNED_0214_SHA : sha(`file-${v}`)]));
const baseline = () => ({
  runner_sha256: hx("a"), manifest_sha256: hx("b"), project_ref_sha256: hx("c"), planned_duration_minutes: 60, g4_max_age_hours: 24,
  g3: { head_sha: "d".repeat(40), checksums: checksums() },
  g09: { studios: 8, reachable_by_setter: 3, refused_account: 4, refused_money_only: 1, per_ordinal: Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8].map((o) => [o, { r2a_reachable: [2, 4, 5].includes(o), needs_ack_prices: ![2, 4, 5].includes(o), acct: o % 2 === 1, money: false, bound_live: o % 2, bound_test: 0 }])) },
});
const at = (m) => `2026-10-26T${m}:00Z`;
const attest = () => ({
  operator: "operator-1", project_ref_sha256: hx("c"),
  holds: { cron_job_org_paused: { confirmed_by: "operator-1", at_utc: at("22:50") }, people_hold_in_place: { confirmed_by: "operator-1", at_utc: at("22:51") }, maintenance_flag_decision: { choice: "no_flag", confirmed_by: "operator-1", at_utc: at("22:52") } },
  g3: { head_sha: "d".repeat(40), checksums: checksums() },
  g4: { backup_id: "backup-synthetic-1", status: "COMPLETED", backup_completed_at_utc: at("20:00") },
  r6: { choice: "accept_rpo", answer_text: "Accept the loss window for the cutover.", reference: "decision-ref-1" },
  disposition_0242: { choice: "R-3", reference: "decision-ref-2" }, denial_files: [], runner_refusals: 0,
});
const manifest = () => Object.fromEntries(FILES.map((n) => [`${n}.sql`, sha(`sql-${n}`)]));
const metasFor = (files, o = {}) => Object.fromEntries(FILES.filter((n) => typeof files[n] === "string").map((n, i) => [n, { file: `${n}.sql`, sql_sha256: sha(`sql-${n}`), result_sha256: sha(files[n]), started_at_utc: at("23:10"), captured_at_utc: at(`23:${String(11 + (i % 20)).padStart(2, "0")}`), exit_code: 0, runner_sha256: hx("a"), manifest_sha256: hx("b"), ...o }]));
const run = (mut = (f) => f, opts = {}) => {
  const f = goodResults(); const m = mut(f) ?? f;
  const metas = metasFor(m); if (opts.metaMut) opts.metaMut(metas);
  if (opts.after) opts.after(m);
  return evaluate({ files: m, metas, manifest: opts.manifest === undefined ? manifest() : opts.manifest, baseline: opts.baseline === undefined ? baseline() : opts.baseline, attest: opts.attest === undefined ? attest() : opts.attest, manifestFileSha256: opts.manifestFileSha256 === undefined ? hx("b") : opts.manifestFileSha256, window: opts.window ?? { start: WS, end: WE }, maxAgeMin: opts.maxAgeMin, now: opts.now ?? NOW, dataOnly: opts.dataOnly });
};
const status = (o, id) => o.rows.find((r) => r.id === id);
const rowsOf = (f, n) => JSON.parse(f[n]).rows;
const set = (f, n, rows) => { f[n] = J(rows); return f; };

test("the clean synthetic set is PASS and every required check is PASS", () => {
  const o = run();
  assert.equal(o.overall, "PASS", JSON.stringify(o.rows.filter((r) => r.status !== "PASS")));
  assert.ok(o.rows.every((r) => r.required && r.status === "PASS"));
  assert.equal(FILES.length, 13);
});

// ---- one mutant per failure class ----------------------------------------------------
const mutants = {
  "missing file": [(f) => { delete f["g07-sms-claimed-number-duplicates"]; return f; }, ["S0-13", "S0-4b"]],
  "unreadable (not JSON)": [(f) => { f["g06-payment-drain"] = "ERROR: division by zero"; return f; }, ["S0-13", "S0-4a"]],
  "error payload": [(f) => { f["g02-history"] = JSON.stringify({ error: "boom" }); return f; }, ["S0-13", "S0-2"]],
  "empty rows (a missing census is not a zero)": [(f) => set(f, "census-0213-0246", []), ["S0-13", "S0-3"]],
  "chain guard not 1": [(f) => set(f, "g07-sms-claimed-number-duplicates", [{ ...rowsOf(f, "g07-sms-claimed-number-duplicates")[0], at_hosted_0212: 0 }]), ["S0-13"]],
  "G2 history 212 rows": [(f) => set(f, "g02-history", [{ ...G2, applied_count: 212 }]), ["S0-2"]],
  "G2 version >= 0213 present": [(f) => set(f, "g02-history", [{ ...G2, versions_ge_0213: 1 }]), ["S0-2"]],
  "G2 0212 hash differs": [(f) => set(f, "g02-history", [{ ...G2, statements_sha256_0212: "0".repeat(64) }]), ["S0-2"]],
  "census present_now 1": [(f) => { const r = rowsOf(f, "census-0213-0246"); r[5].present_now = 1; return set(f, "census-0213-0246", r); }, ["S0-3"]],
  "census row missing": [(f) => set(f, "census-0213-0246", rowsOf(f, "census-0213-0246").slice(1)), ["S0-3"]],
  "census duplicate version": [(f) => { const r = rowsOf(f, "census-0213-0246"); r[1].version = "0213"; return set(f, "census-0213-0246", r); }, ["S0-3"]],
  "G10 = 6": [(f) => set(f, "g10-constraint-names", rowsOf(f, "g10-constraint-names").slice(1).map((r) => ({ ...r, present_total: 6 }))), ["S0-3"]],
  "G6 d3 = 1": [(f) => set(f, "g06-payment-drain", [{ ...rowsOf(f, "g06-payment-drain")[0], d3_claimed_inflight: 1 }]), ["S0-4a"]],
  "G6 column missing": [(f) => { const r = rowsOf(f, "g06-payment-drain")[0]; delete r.d2_refund_pending; return set(f, "g06-payment-drain", [r]); }, ["S0-4a"]],
  "G7 duplicate": [(f) => set(f, "g07-sms-claimed-number-duplicates", [{ ...rowsOf(f, "g07-sms-claimed-number-duplicates")[0], duplicated_numbers: 1 }]), ["S0-4b"]],
  "G9 summary studio count shifted": [(f) => set(f, "g09a-0214-reach-summary", [{ ...rowsOf(f, "g09a-0214-reach-summary")[0], studios: 9 }]), ["S0-5"]],
  "G9 reachability flipped": [(f) => { const r = rowsOf(f, "g09b-0214-reach-per-studio"); r[0].r2a_reachable = true; return set(f, "g09b-0214-reach-per-studio", r); }, ["S0-5"]],
  "G9 per-studio row count 7": [(f) => set(f, "g09b-0214-reach-per-studio", rowsOf(f, "g09b-0214-reach-per-studio").slice(1)), ["S0-5"]],
  "G9 unknown-mode account": [(f) => { const r = rowsOf(f, "g09c-0214-bound-account-mode"); r[2].bound_unknown_mode = 1; return set(f, "g09c-0214-bound-account-mode", r); }, ["S0-5"]],
  "G9 live+test != bound": [(f) => { const r = rowsOf(f, "g09c-0214-bound-account-mode"); r[1].bound_test = 4; return set(f, "g09c-0214-bound-account-mode", r); }, ["S0-5"]],
  "G9 observed-country column present": [(f) => { const r = rowsOf(f, "g09c-0214-bound-account-mode"); r[0].observed_country_column_present = true; return set(f, "g09c-0214-bound-account-mode", r); }, ["S0-5"]],
  "G11 wrong types > 0 under the package rule": [(f) => { set(f, "g11-0244-legacy-laser-types", [{ ...rowsOf(f, "g11-0244-legacy-laser-types")[0], wrong_type_rows: 2 }]); const r = rowsOf(f, "g11b-0244-legacy-laser-classes"); r[3].package_g11_rows = 2; r[3].class_h1_number = 2; return set(f, "g11b-0244-legacy-laser-classes", r); }, ["S0-6a"]],
  "g11b reconciles false": [(f) => { const r = rowsOf(f, "g11b-0244-legacy-laser-classes"); r[3].reconciles = false; return set(f, "g11b-0244-legacy-laser-classes", r); }, ["S0-6b"]],
  "g11b has no ALL_ROWS": [(f) => set(f, "g11b-0244-legacy-laser-classes", rowsOf(f, "g11b-0244-legacy-laser-classes").slice(0, 3)), ["S0-6b"]],
  "G12 callable": [(f) => set(f, "g12-0243-intake-definers", [{ ...rowsOf(f, "g12-0243-intake-definers")[0], signature: "x()", callable: true, callable_total: 1 }]), ["S0-6c"]],
  "G12 callable_total alone (no per-row flag)": [(f) => set(f, "g12-0243-intake-definers", [{ ...rowsOf(f, "g12-0243-intake-definers")[0], callable_total: 2 }]), ["S0-6c"]],
  "W3 missing file": [(f) => { delete f["w03-table-sizes"]; return f; }, ["S0-13", "S0-W3"]],
  "W3 one table over 512 MiB": [(f) => { const r = rowsOf(f, "w03-table-sizes"); r[3].total_bytes = 536870913; return set(f, "w03-table-sizes", r); }, ["S0-W3"]],
  "W3 a table absent": [(f) => { const r = rowsOf(f, "w03-table-sizes"); r[2].present = false; return set(f, "w03-table-sizes", r); }, ["S0-W3"]],
  "W3 nine rows": [(f) => set(f, "w03-table-sizes", rowsOf(f, "w03-table-sizes").slice(1)), ["S0-W3"]],
  "W3 table name substituted": [(f) => { const r = rowsOf(f, "w03-table-sizes"); r[0].table_name = "studios"; return set(f, "w03-table-sizes", r); }, ["S0-W3"]],
  "W3 duplicated table": [(f) => { const r = rowsOf(f, "w03-table-sizes"); r[1].table_name = r[0].table_name; return set(f, "w03-table-sizes", r); }, ["S0-W3"]],
  "W3 size not a number": [(f) => { const r = rowsOf(f, "w03-table-sizes"); r[4].total_bytes = "big"; return set(f, "w03-table-sizes", r); }, ["S0-W3"]],
  "W3 settings missing": [(f) => { const r = rowsOf(f, "w03-table-sizes"); r.forEach((x) => delete x.statement_timeout); return set(f, "w03-table-sizes", r); }, ["S0-W3"]],
  "W3 settings inconsistent": [(f) => { const r = rowsOf(f, "w03-table-sizes"); r[0].lock_timeout = "5s"; return set(f, "w03-table-sizes", r); }, ["S0-W3"]],
  "old transaction": [(f) => { const r = rowsOf(f, "s1-open-transactions"); r[4].old_xact_backends = 1; return set(f, "s1-open-transactions", r); }, ["S0-7"]],
  "s1 row count 9": [(f) => set(f, "s1-open-transactions", rowsOf(f, "s1-open-transactions").slice(1)), ["S0-7"]],
};
for (const [name, [mut, ids]] of Object.entries(mutants)) {
  test(`FAIL: ${name}`, () => {
    const o = run(mut);
    assert.equal(o.overall, "FAIL");
    for (const id of ids) assert.equal(status(o, id).status, "FAIL", `${id}: ${status(o, id).detail}`);
  });
}

// ---- inputs the data cannot supply -----------------------------------------------------
test("missing or unreadable baseline fails S0-5 and the overall", () => {
  for (const b of [null, {}, { g09: { studios: 8 } }, { ...baseline(), g09: { ...baseline().g09, studios: 7 } }]) { const o = run((f) => f, { baseline: b }); assert.equal(o.overall, "FAIL"); assert.equal(status(o, "S0-5").status, "FAIL"); }
});
test("missing attestation fails all six attested checks", () => {
  const o = run((f) => f, { attest: null });
  assert.equal(o.overall, "FAIL");
  for (const id of ["S0-1", "S0-8", "S0-9", "S0-10", "S0-11", "S0-12"]) assert.equal(status(o, id).status, "FAIL");
});
// F7: each itemised attestation fails on its own, and only its own check
const del = (k) => (a) => { delete a[k]; return a; };
const attMut = {
  "S0-1 no operator named": [(a) => ({ ...a, operator: "  " })],
  "S0-1 project ref hash missing": [del("project_ref_sha256")],
  "S0-1 project ref hash differs from the pin": [(a) => ({ ...a, project_ref_sha256: hx("e") })],
  "S0-8 holds absent": [del("holds")],
  "S0-8 cron hold missing": [(a) => { delete a.holds.cron_job_org_paused; return a; }],
  "S0-8 people hold unconfirmed": [(a) => { a.holds.people_hold_in_place.confirmed_by = ""; return a; }],
  "S0-8 maintenance decision not made": [(a) => { a.holds.maintenance_flag_decision.choice = "undecided"; return a; }],
  "S0-8 hold dated in the future": [(a) => { a.holds.cron_job_org_paused.at_utc = at("23:59"); return a; }],
  "S0-9 head sha short": [(a) => { a.g3.head_sha = "abc123"; return a; }],
  "S0-9 head sha differs from the pin": [(a) => { a.g3.head_sha = "e".repeat(40); return a; }],
  "S0-9 33 checksums": [(a) => { delete a.g3.checksums["0246"]; return a; }],
  "S0-9 one checksum differs": [(a) => { a.g3.checksums["0230"] = hx("0"); return a; }],
  "S0-9 checksum not 64 hex": [(a) => { a.g3.checksums["0230"] = "abc"; return a; }],
  "S0-9 0214 is the superseded file": [(a) => { a.g3.checksums["0214"] = SUPERSEDED_0214_SHA; return a; }],
  "S0-10 backup id missing": [(a) => { a.g4.backup_id = ""; return a; }],
  "S0-10 backup not completed": [(a) => { a.g4.status = "IN_PROGRESS"; return a; }],
  "S0-10 backup older than the limit": [(a) => { a.g4.backup_completed_at_utc = "2026-10-25T20:00:00Z"; return a; }],
  "S0-10 R-6 answer text empty": [(a) => { a.r6.answer_text = ""; return a; }],
  "S0-10 R-6 choice unknown": [(a) => { a.r6.choice = "later"; return a; }],
  "S0-10 R-6 absent": [del("r6")],
  "S0-11 no 0242 disposition": [(a) => ({ ...a, disposition_0242: { choice: "none", reference: "x" } })],
  "S0-11 disposition without a reference": [(a) => ({ ...a, disposition_0242: { choice: "R-3", reference: "" } })],
  "S0-12 denial file recorded": [(a) => ({ ...a, denial_files: ["DENIAL-1.json"] })],
  "S0-12 runner refused a file": [(a) => ({ ...a, runner_refusals: 1 })],
  "a bare boolean attestation (the old shape)": [() => ({ operator: "operator-1", project_ref_matches_canonical: true, holds_in_place: true, g3_met_at_exact_head: true, g4_recorded: true, r6_answered: true })],
};
for (const [name, [m]] of Object.entries(attMut)) test(`FAIL (attested): ${name}`, () => {
  const o = run((f) => f, { attest: m(attest()) });
  assert.equal(o.overall, "FAIL");
  const id = /^S0-\d+/.exec(name)?.[0];
  if (id) assert.equal(status(o, id).status, "FAIL", status(o, id).detail);
});

// F4: the real clock, the declared window and the 07:45-10:00 UTC blackout
const T = (s) => Date.parse(`2026-10-27T${s}:00Z`);
const win = (a, b) => ({ start: `2026-10-27T${a}:00Z`, end: `2026-10-27T${b}:00Z` });
const clockRun = (nowS, w, b = baseline()) => run((f) => f, { now: T(nowS), window: w, baseline: b, metaMut: (m) => { for (const n of Object.keys(m)) { m[n].started_at_utc = `2026-10-27T${nowS}:00Z`; m[n].captured_at_utc = `2026-10-27T${nowS}:00Z`; } } });
test("F4: the clock before the window start, after the window end, or without time left fails S0-8", () => {
  assert.equal(status(run((f) => f, { now: Date.parse("2026-10-26T22:55:00Z") }), "S0-8").status, "FAIL"); // holds are dated 22:50-22:52, so only the window bound fails
  assert.equal(status(run((f) => f, { now: Date.parse("2026-10-27T02:30:00Z") }), "S0-8").status, "FAIL");
  assert.equal(status(run((f) => f, { now: Date.parse("2026-10-27T01:30:00Z") }), "S0-8").status, "FAIL"); // 30 min left < 60 planned
});
test("F4: a window and a clock outside 07:45-10:00 UTC pass; a clock inside it fails even inside the window", () => {
  assert.equal(status(clockRun("05:00", win("04:00", "07:00")), "S0-8").status, "PASS");
  assert.equal(status(clockRun("08:30", win("08:00", "12:00")), "S0-8").status, "FAIL");
  assert.equal(status(clockRun("07:45", win("07:40", "12:00")), "S0-8").status, "FAIL");
  assert.equal(status(clockRun("10:00", win("10:00", "13:00")), "S0-8").status, "PASS");
});
test("F4: a window that overlaps the blackout fails, even if the clock is outside it", () => {
  assert.equal(status(clockRun("05:00", win("05:00", "08:00")), "S0-8").status, "FAIL");
  assert.equal(status(clockRun("05:00", win("05:00", "12:00")), "S0-8").status, "FAIL");
  assert.equal(status(run((f) => f, { window: { start: WS, end: "nope" } }), "S0-8").status, "FAIL");
});
test("F4: a window ending exactly at 07:45 UTC or starting at 10:00 UTC is allowed", () => {
  assert.equal(status(clockRun("05:30", win("04:00", "07:45")), "S0-8").status, "PASS");
  assert.equal(status(clockRun("10:30", win("10:00", "13:00")), "S0-8").status, "PASS");
});

// F2: results are bound to THIS window
const metaFail = (name, metaMut, opts = {}) => test(`F2 FAIL: ${name}`, () => { const o = run((f) => f, { metaMut, ...opts }); assert.equal(o.overall, "FAIL"); assert.equal(status(o, "S0-14").status, "FAIL", status(o, "S0-14").detail); });
metaFail("a sidecar is missing", (m) => { delete m["g06-payment-drain"]; });
// every file moves together, so the age limit cannot be what fails: only the window bound is under test
const allMeta = (m, st, cp) => { for (const n of Object.keys(m)) { m[n].started_at_utc = st; m[n].captured_at_utc = cp; } };
metaFail("a result started before the window", (m) => allMeta(m, at("22:00"), at("23:05")), { now: NOW });
metaFail("one result started before the window while the rest are inside it", (m) => { m["g02-history"].started_at_utc = at("22:59"); });
metaFail("a result captured after the window ended", (m) => allMeta(m, at("23:10"), "2026-10-27T02:05:00Z"), { now: Date.parse("2026-10-27T02:10:00Z") });
metaFail("a result older than N minutes at run time", (m) => { m["g07-sms-claimed-number-duplicates"].captured_at_utc = at("23:05"); m["g07-sms-claimed-number-duplicates"].started_at_utc = at("23:01"); }, { maxAgeMin: 30, now: NOW + 5 * 60e3 });
metaFail("a capture time in the future", (m) => { m["g02-history"].captured_at_utc = at("23:55"); });
metaFail("a capture time that is not a date", (m) => { m["g02-history"].captured_at_utc = "yesterday"; });
metaFail("the result was edited after capture", () => {}, { after: (f) => { f["g06-payment-drain"] = f["g06-payment-drain"] + " "; } });
metaFail("a sidecar names a different file", (m) => { m["g02-history"].file = "g06-payment-drain.sql"; });
metaFail("the sidecar sql sha is not the manifest's", (m) => { m["g02-history"].sql_sha256 = hx("9"); });
metaFail("the runner exited non-zero", (m) => { m["g02-history"].exit_code = 7; });
metaFail("a different runner captured it", (m) => { m["g02-history"].runner_sha256 = hx("9"); });
metaFail("captured under a different manifest", (m) => { m["g02-history"].manifest_sha256 = hx("9"); });
test("F2 FAIL: the manifest unreadable, the pins absent, or the window absent", () => {
  assert.equal(status(run((f) => f, { manifest: null }), "S0-14").status, "FAIL");
  const b = baseline(); delete b.runner_sha256; assert.equal(status(run((f) => f, { baseline: b }), "S0-14").status, "FAIL");
  assert.equal(status(run((f) => f, { window: {} }), "S0-14").status, "FAIL");
  assert.equal(status(run((f) => f, { maxAgeMin: 500 }), "S0-14").status, "FAIL");
});
test("F2: age is measured against the clock, and exactly N minutes is still fine", () => {
  assert.equal(status(run((f) => f, { maxAgeMin: 60 }), "S0-14").status, "PASS");
});

// F3
test("F3: one s1 table absent fails S0-7 although it has no open transaction", () => {
  const o = run((f) => { const r = rowsOf(f, "s1-open-transactions"); r[6].table_present = false; return set(f, "s1-open-transactions", r); });
  assert.equal(status(o, "S0-7").status, "FAIL"); assert.match(status(o, "S0-7").detail, /table_present/);
});
test("F3: a swapped, repeated or unexpected table name fails S0-7", () => {
  for (const mutate of [(r) => { r[0].table_name = "studios"; }, (r) => { r[1].table_name = r[0].table_name; }, (r) => { r[2].table_name = undefined; }]) {
    const o = run((f) => { const r = rowsOf(f, "s1-open-transactions"); mutate(r); return set(f, "s1-open-transactions", r); });
    assert.equal(status(o, "S0-7").status, "FAIL");
  }
});

// F6
test("F6: swapped bound_live / bound_test on one ordinal, or a money class that differs, or 7 baseline studios, fails S0-5", () => {
  const swap = run((f) => { const r = rowsOf(f, "g09c-0214-bound-account-mode"); r[0].bound_live = 0; r[0].bound_test = 1; return set(f, "g09c-0214-bound-account-mode", r); });
  assert.equal(status(swap, "S0-5").status, "FAIL"); assert.match(status(swap, "S0-5").detail, /bound_live/);
  const money = run((f) => { const r = rowsOf(f, "g09b-0214-reach-per-studio"); r[1].charge_attempt_rows = 2; return set(f, "g09b-0214-reach-per-studio", r); });
  assert.equal(status(money, "S0-5").status, "FAIL"); assert.match(status(money, "S0-5").detail, /money class/);
  const b = baseline(); b.g09.studios = 7; delete b.g09.per_ordinal["8"];
  assert.equal(status(run((f) => f, { baseline: b }), "S0-5").status, "FAIL");
});
test("F6: a repeated ordinal in g09b or g09c fails S0-5", () => {
  assert.equal(status(run((f) => { const r = rowsOf(f, "g09b-0214-reach-per-studio"); r[1].studio_ordinal = 1; return set(f, "g09b-0214-reach-per-studio", r); }), "S0-5").status, "FAIL");
  assert.equal(status(run((f) => { const r = rowsOf(f, "g09c-0214-bound-account-mode"); r[1].studio_ordinal = 1; return set(f, "g09c-0214-bound-account-mode", r); }), "S0-5").status, "FAIL");
});

test("F6: two ordinals swapping r2a_reachable keeps every count equal but fails the per-ordinal comparison", () => {
  const o = run((f) => { const r = rowsOf(f, "g09b-0214-reach-per-studio"); r[0].r2a_reachable = true; r[1].r2a_reachable = false; return set(f, "g09b-0214-reach-per-studio", r); });
  assert.equal(status(o, "S0-5").status, "FAIL"); assert.match(status(o, "S0-5").detail, /ordinal 1: reachability/);
});
test("F6: a self-consistent 7-studio baseline and result set still fails (the 8 is literal)", () => {
  const b = baseline(); b.g09.studios = 7; delete b.g09.per_ordinal["8"];
  const o = run((f) => { set(f, "g09a-0214-reach-summary", [{ ...rowsOf(f, "g09a-0214-reach-summary")[0], studios: 7 }]); set(f, "g09b-0214-reach-per-studio", rowsOf(f, "g09b-0214-reach-per-studio").slice(0, 7)); return set(f, "g09c-0214-bound-account-mode", rowsOf(f, "g09c-0214-bound-account-mode").slice(0, 7)); }, { baseline: b });
  assert.equal(status(o, "S0-5").status, "FAIL");
});
test("F7: a baseline that itself records the superseded 0214 fails S0-9 even when the attestation agrees", () => {
  const b = baseline(); b.g3.checksums["0214"] = SUPERSEDED_0214_SHA;
  const a = attest(); a.g3.checksums["0214"] = SUPERSEDED_0214_SHA;
  const o = run((f) => f, { baseline: b, attest: a });
  assert.equal(status(o, "S0-9").status, "FAIL"); assert.match(status(o, "S0-9").detail, /superseded/);
});

// F8: one case per d1..d4 group of G6, so a regex that drops a group cannot survive
test("F8: each of the d1, d2, d3 and d4 groups fails S0-4a on its own", () => {
  const cols = { d1: ["d1_ready", "d1_pending_stripe", "d1_pending_unbindable"], d2: ["d2_refund_pending"], d3: ["d3_claimed_inflight", "d3_unprocessed_unclaimed", "d3_errored_any_type"], d4: ["d4_account_provisioning_open", "d4_customer_provisioning_open"] };
  for (const [g, cs] of Object.entries(cols)) for (const c of cs) {
    const o = run((f) => set(f, "g06-payment-drain", [{ ...rowsOf(f, "g06-payment-drain")[0], [c]: 1 }]));
    assert.equal(status(o, "S0-4a").status, "FAIL", `${g}: ${c}`);
  }
});

test("an unknown required check is a FAIL; a known one named again changes nothing", () => {
  const b = baseline(); b.required_checks = ["S0-2", "S0-99"];
  const o = run((f) => f, { baseline: b });
  assert.equal(o.overall, "FAIL"); assert.equal(o.rows.at(-1).id, "S0-99"); assert.equal(o.rows.at(-1).status, "FAIL");
  const b2 = baseline(); b2.required_checks = ["S0-2"]; assert.equal(run((f) => f, { baseline: b2 }).overall, "PASS");
});
test("--data-only never prints PASS", () => {
  const o = run((f) => f, { dataOnly: true, attest: null });
  assert.equal(o.overall, "DATA-ONLY");
  assert.equal(run((f) => { delete f["g02-history"]; return f; }, { dataOnly: true }).overall, "FAIL");
});

// ---- G11 redefinition (P-4) is opt-in and exact -------------------------------------------
function withG11(h1, h2, total) {
  return (f) => { set(f, "g11-0244-legacy-laser-types", [{ ...rowsOf(f, "g11-0244-legacy-laser-types")[0], wrong_type_rows: total }]); const r = rowsOf(f, "g11b-0244-legacy-laser-classes"); Object.assign(r[3], { package_g11_rows: total, class_h1_number: h1, class_h2_total: h2 }); return set(f, "g11b-0244-legacy-laser-classes", r); };
}
const p4 = (over = {}) => { const b = baseline(); b.g11_rule = "p4_residual"; b.g11_residual = { recorded_by_sam: true, pending_h_requests_resolved: true, h1: 2, h2: 1, ...over }; return b; };
test("P-4 residual: accepted only when the recorded H1/H2 equal the observed ones", () => {
  assert.equal(run(withG11(2, 1, 3), { baseline: p4() }).overall, "PASS");
  assert.equal(run(withG11(3, 1, 4), { baseline: p4() }).overall, "FAIL");
  assert.equal(run(withG11(2, 0, 2), { baseline: p4() }).overall, "FAIL");
});
test("P-4 residual: not recorded by Sam, or a pending H request unresolved, or reconcile false => FAIL", () => {
  assert.equal(run(withG11(2, 1, 3), { baseline: p4({ recorded_by_sam: false }) }).overall, "FAIL");
  assert.equal(run(withG11(2, 1, 3), { baseline: p4({ pending_h_requests_resolved: false }) }).overall, "FAIL");
  const m = (f) => { withG11(2, 1, 3)(f); const r = rowsOf(f, "g11b-0244-legacy-laser-classes"); r[3].reconciles = false; return set(f, "g11b-0244-legacy-laser-classes", r); };
  assert.equal(run(m, { baseline: p4() }).overall, "FAIL");
});
test("P-4 residual: census total above the sum of its classes (an uncategorised shape) => FAIL", () => {
  assert.equal(run(withG11(2, 1, 9), { baseline: p4() }).overall, "FAIL");
});
test("the package rule stays in force when no rule is named, whatever the residual says", () => {
  const b = baseline(); b.g11_residual = { recorded_by_sam: true, pending_h_requests_resolved: true, h1: 2, h2: 1 };
  assert.equal(run(withG11(2, 1, 3), { baseline: b }).overall, "FAIL");
});
test("wrong_type 0 but a class count > 0 is a FAIL (the two reads disagree)", () => {
  const m = (f) => { const r = rowsOf(f, "g11b-0244-legacy-laser-classes"); r[3].class_x1_finalized_or_void = 1; return set(f, "g11b-0244-legacy-laser-classes", r); };
  assert.equal(status(run(m), "S0-6a").status, "FAIL");
});

test("W3: exactly 512 MiB passes, and the two settings are reported", () => {
  const o = run((f) => { const r = rowsOf(f, "w03-table-sizes"); r[0].total_bytes = "536870912"; r[1].total_bytes = 536870911; return set(f, "w03-table-sizes", r); });
  assert.equal(o.overall, "PASS");
  assert.match(status(o, "S0-W3").detail, /statement_timeout=0 lock_timeout=0/);
});
test("W3: row count -1 (never analysed) does not fail; the byte size is the gate", () => {
  assert.equal(run((f) => set(f, "w03-table-sizes", rowsOf(f, "w03-table-sizes").map((r) => ({ ...r, approx_rows: -1 })))).overall, "PASS");
});

test("readRows accepts a bare array and { rows }, rejects everything else", () => {
  assert.ok(readRows("[{\"a\":1}]").rows); assert.ok(readRows("{\"rows\":[{\"a\":1}]}").rows);
  for (const bad of ["", "null", "{}", "{\"rows\":3}", "[1]", "{\"error\":\"x\"}", "not json"]) assert.ok(readRows(bad).error, bad);
});

// ---- S1 read-back ---------------------------------------------------------------------------
const FNS = ["reconcile_card_payment_succeeded", "save_client_card_on_file", ...NEW_0214_FUNCTIONS];
const s1Expected = () => ({ closures: FNS.map((fn) => ({ fn, anon: false, authenticated: false, service_role: fn.startsWith("initialize") })), table_privileges: [{ table: "audit_logs", role: "authenticated", privilege: "insert", held: false }, { table: "audit_logs", role: "service_role", privilege: "insert", held: true }], body_md5: { fn_0227: "a", fn_0228: "b", fn_0236: "c", fn_0241: "d" } });
const s1Readback = () => { const e = s1Expected(); return { history: { applied_count: 245, hosted_max: "0246", distinct_versions_ge_0213: 34 }, closures: clone(e.closures), table_privileges: clone(e.table_privileges), body_md5: clone(e.body_md5) }; };
const s1Census = () => J(versions.map((v) => ({ version: v, objects_checked: v === "0214" ? 30 : 5, present_now: v === "0214" ? 30 : 5 })));
const g10 = () => goodResults()["g10-constraint-names"];
const s1 = (m = (x) => x, census = s1Census()) => { const rb = m(s1Readback()); return evaluateS1({ censusText: census, g10Text: g10(), readback: rb, expected: s1Expected() }); };

test("S1: the clean read-back is PASS", () => { const o = s1(); assert.equal(o.overall, "PASS", JSON.stringify(o.rows.filter((r) => r.status !== "PASS"))); });
test("S1: 0214 present_now = 30 is required (27 fails)", () => {
  const c = J(versions.map((v) => ({ version: v, objects_checked: v === "0214" ? 27 : 5, present_now: v === "0214" ? 27 : 5 })));
  const o = s1((x) => x, c); assert.equal(o.overall, "FAIL"); assert.equal(status(o, "S1-2b").status, "FAIL");
});
test("S1: a census row short of objects_checked fails", () => {
  const c = J(versions.map((v) => ({ version: v, objects_checked: v === "0214" ? 30 : 5, present_now: v === "0230" ? 4 : v === "0214" ? 30 : 5 })));
  assert.equal(status(s1((x) => x, c), "S1-2").status, "FAIL");
});
const s1mut = {
  "history 244": (x) => { x.history.applied_count = 244; return x; },
  "a closure differs": (x) => { x.closures[0].service_role = true; return x; },
  "a new 0214 function missing from the read-back": (x) => { x.closures = x.closures.filter((c) => c.fn !== NEW_0214_FUNCTIONS[2]); return x; },
  "a closure value not boolean": (x) => { x.closures[1].anon = "f"; return x; },
  "audit_logs insert not revoked": (x) => { x.table_privileges[0].held = true; return x; },
  "service_role lost audit_logs insert": (x) => { x.table_privileges[1].held = false; return x; },
  "a replaced body differs": (x) => { x.body_md5.fn_0241 = "z"; return x; },
  "a replaced body missing": (x) => { delete x.body_md5.fn_0236; return x; },
};
for (const [name, m] of Object.entries(s1mut)) test(`S1 FAIL: ${name}`, () => assert.equal(s1(m).overall, "FAIL"));
test("S1: expectations that omit a new 0214 function cannot pass", () => {
  const e = s1Expected(); e.closures = e.closures.filter((c) => c.fn !== NEW_0214_FUNCTIONS[0]);
  assert.equal(evaluateS1({ censusText: s1Census(), g10Text: g10(), readback: s1Readback(), expected: e }).overall, "FAIL");
});
test("S1: missing read-back or expectations fails", () => {
  assert.equal(evaluateS1({ censusText: s1Census(), g10Text: g10(), readback: null, expected: s1Expected() }).overall, "FAIL");
  assert.equal(evaluateS1({ censusText: undefined, g10Text: g10(), readback: s1Readback(), expected: s1Expected() }).overall, "FAIL");
});

// F5: the three new 0214 functions' grants are pinned in the comparator, not copied from `expected`
test("F5: a read-back that opens a new 0214 function fails even when the expectations were edited to agree", () => {
  for (const [i, k] of [[0, "authenticated"], [0, "anon"], [0, "service_role"], [1, "authenticated"], [1, "service_role"], [2, "service_role"], [2, "anon"]]) {
    const e = s1Expected(), rb = s1Readback();
    const fn = NEW_0214_FUNCTIONS[i];
    for (const c of [...e.closures, ...rb.closures]) if (c.fn === fn) c[k] = !c[k];
    const o = evaluateS1({ censusText: s1Census(), g10Text: g10(), readback: rb, expected: e });
    assert.equal(status(o, "S1-3").status, "FAIL", `${fn}.${k}`); assert.match(status(o, "S1-3").detail, /pinned grant/);
  }
});
test("F5: the 0239/0245 service_role pins and the audit_logs privileges are pinned too", () => {
  for (const fn of ["reconcile_card_payment_succeeded", "save_client_card_on_file"]) {
    const e = s1Expected(), rb = s1Readback();
    for (const c of [...e.closures, ...rb.closures]) if (c.fn === fn) c.service_role = true;
    assert.equal(status(evaluateS1({ censusText: s1Census(), g10Text: g10(), readback: rb, expected: e }), "S1-3").status, "FAIL", fn);
  }
  const e = s1Expected(), rb = s1Readback();
  for (const t of [...e.table_privileges, ...rb.table_privileges]) if (t.role === "authenticated") t.held = true;
  assert.equal(status(evaluateS1({ censusText: s1Census(), g10Text: g10(), readback: rb, expected: e }), "S1-3").status, "FAIL");
});

// F1: the command itself, through a symlink and from a path with a space; silence is never a pass
function stage() {
  const root = mkdtempSync(path.join(tmpdir(), "cmp pre flight "));
  const dir = path.join(root, "dir with space"); mkdirSync(dir);
  for (const f of ["compare-preflight.mjs", "compare-preflight-lib.mjs"]) copyFileSync(path.join(HERE, f), path.join(dir, f));
  return { root, dir };
}
const cli = (script, args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
function writeFixtures(root) {
  const f = goodResults(), res = path.join(root, "results"); mkdirSync(res);
  const metas = metasFor(f);
  for (const n of FILES) { writeFileSync(path.join(res, `${n}.json`), f[n]); writeFileSync(path.join(res, `${n}.meta.json`), JSON.stringify(metas[n])); }
  const man = path.join(root, "MANIFEST.sha256");
  writeFileSync(man, FILES.map((n) => `${sha(`sql-${n}`)}  ${n}.sql`).join("\n") + "\n");
  writeFileSync(path.join(root, "baseline.json"), JSON.stringify(baseline())); writeFileSync(path.join(root, "attest.json"), JSON.stringify(attest()));
  return { res, man };
}
test("F1: the command prints a verdict and exits non-zero with no arguments (usage), never silent 0", () => {
  const { dir } = stage();
  const r = cli(path.join(dir, "compare-preflight.mjs"), []);
  assert.equal(r.status, 3); assert.match(r.stderr, /usage/); assert.ok(!r.stdout.includes("OVERALL PASS"));
});
test("F1: through a symlink, and from a path with a space, it still runs and prints a verdict", () => {
  const { root, dir } = stage();
  const link = path.join(root, "link-to-compare.mjs"); symlinkSync(path.join(dir, "compare-preflight.mjs"), link);
  const { res, man } = writeFixtures(root);
  const args = ["--results", res, "--baseline", path.join(root, "baseline.json"), "--attest", path.join(root, "attest.json"), "--window-start", "2026-10-26T23:00:00Z", "--window-end", "2026-10-27T02:00:00Z", "--manifest", man];
  for (const script of [path.join(dir, "compare-preflight.mjs"), link]) {
    const r = cli(script, args);
    assert.match(r.stdout, /^OVERALL (PASS|FAIL|DATA-ONLY)/m, `${script}: ${r.stdout}${r.stderr}`);
    // the real clock is not inside the synthetic 2026 window, so the verdict must be FAIL, with a non-zero exit
    assert.match(r.stdout, /^OVERALL FAIL/m); assert.equal(r.status, 1);
  }
});
test("F1: a crash inside main prints OVERALL FAIL and exits 1, not 0 and not silence", () => {
  const { root, dir } = stage();
  writeFileSync(path.join(dir, "compare-preflight-lib.mjs"), readFileSync(path.join(dir, "compare-preflight-lib.mjs"), "utf8").replace("export function evaluate(", "export function evaluate(){ throw new Error('boom'); }\nexport function evaluateUnused("));
  const { res, man } = writeFixtures(root);
  const r = cli(path.join(dir, "compare-preflight.mjs"), ["--results", res, "--baseline", path.join(root, "baseline.json"), "--attest", path.join(root, "attest.json"), "--window-start", "2026-10-26T23:00:00Z", "--window-end", "2026-10-27T02:00:00Z", "--manifest", man]);
  assert.match(r.stdout, /OVERALL FAIL \(internal error: boom\)/); assert.equal(r.status, 1);
});
test("F1: only PASS prints the exact line OVERALL PASS", () => {
  assert.match(format({ overall: "PASS", rows: [] }), /^OVERALL PASS$/m);
  for (const o of ["FAIL", "DATA-ONLY", "weird"]) assert.doesNotMatch(format({ overall: o, rows: [] }), /^OVERALL PASS/m);
});

// ---- Insurance LOW items F9, D1, D2 ----------------------------------------------------
test("F9: a window that overlaps ONLY the 09:00-10:00 end of the blackout fails; the end boundary is exact", () => {
  assert.deepEqual(BLACKOUT_UTC, { start: [7, 45], end: [10, 0] });
  assert.equal(status(clockRun("10:30", win("09:30", "13:00")), "S0-8").status, "FAIL");
  assert.equal(status(clockRun("10:30", win("09:59", "13:00")), "S0-8").status, "FAIL");
  assert.equal(status(clockRun("11:00", win("10:00", "13:00")), "S0-8").status, "PASS");
  assert.equal(status(clockRun("11:00", win("10:01", "13:00")), "S0-8").status, "PASS");
});
test("F9: a clock at 09:30 or 09:59 fails; at 10:00 it passes", () => {
  assert.equal(status(clockRun("09:30", win("09:00", "12:00")), "S0-8").status, "FAIL");
  assert.equal(status(clockRun("09:59", win("09:00", "12:00")), "S0-8").status, "FAIL");
  assert.equal(status(clockRun("10:00", win("10:00", "13:00")), "S0-8").status, "PASS");
});
test("D1: the manifest FILE must hash to baseline.manifest_sha256, not just agree with the sidecars", () => {
  for (const sh of [hx("9"), null, ""]) {
    const o = run((f) => f, { manifestFileSha256: sh });
    assert.equal(status(o, "S0-14").status, "FAIL"); assert.match(status(o, "S0-14").detail, /MANIFEST\.sha256 file on disk/);
  }
  assert.equal(status(run((f) => f), "S0-14").status, "PASS");
});
test("D1: through the command, an edited manifest on disk fails even when its sidecars were edited to match", () => {
  const { root, dir } = stage();
  const { res, man } = writeFixtures(root);
  const args = ["--results", res, "--baseline", path.join(root, "baseline.json"), "--attest", path.join(root, "attest.json"), "--window-start", "2026-10-26T23:00:00Z", "--window-end", "2026-10-27T02:00:00Z", "--manifest", man];
  const real = createHash("sha256").update(readFileSync(man, "utf8"), "utf8").digest("hex");
  const first = cli(path.join(dir, "compare-preflight.mjs"), args);
  assert.match(first.stdout, /FAIL\s+S0-14.*MANIFEST\.sha256 file on disk/, "the fixture baseline pins hx(b), which is not this file's hash");
  const b = baseline(); b.manifest_sha256 = real; writeFileSync(path.join(root, "baseline.json"), JSON.stringify(b));
  for (const n of FILES) { const m = JSON.parse(readFileSync(path.join(res, `${n}.meta.json`), "utf8")); m.manifest_sha256 = real; writeFileSync(path.join(res, `${n}.meta.json`), JSON.stringify(m)); }
  assert.doesNotMatch(cli(path.join(dir, "compare-preflight.mjs"), args).stdout, /MANIFEST\.sha256 file on disk/);
  writeFileSync(man, readFileSync(man, "utf8") + `${hx("1")}  extra.sql\n`);
  assert.match(cli(path.join(dir, "compare-preflight.mjs"), args).stdout, /FAIL\s+S0-14.*MANIFEST\.sha256 file on disk/);
});
test("D2: 0214 is pinned in the code: the baseline or the attestation naming any other value fails S0-9", () => {
  assert.equal(PINNED_0214_SHA, "a8bdcefe7b01216e986838fe336a9eb3613b6e892bd8de2c101cdd4e2f03751b");
  const other = sha("some other 0214");
  for (const [b, a] of [[other, other], [other, PINNED_0214_SHA], [PINNED_0214_SHA, other]]) {
    const bl = baseline(), at2 = attest(); bl.g3.checksums["0214"] = b; at2.g3.checksums["0214"] = a;
    const o = run((f) => f, { baseline: bl, attest: at2 });
    assert.equal(status(o, "S0-9").status, "FAIL", status(o, "S0-9").detail);
  }
  assert.equal(status(run((f) => f), "S0-9").status, "PASS");
});
