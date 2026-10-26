// BASELINE-W1 CANDIDATE 4 proof. Synthetic results only. Run: node --test baseline-candidate4-proof.test.mjs
// Not one of the comparator's pinned files. It proves (1) the ONLY non-underscore differences from candidate 3 are the three
// added blocks g4_pitr_base, g4_pitr_api and g4_pitr_idle (and the text diff is those blocks plus the _candidate note), and
// (2) candidate 4 with a PITR attestation and a captured pitr-backups result gives the labelled PASS on the synthetic set.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sha = (t) => createHash("sha256").update(t, "utf8").digest("hex");
const rd = (n) => JSON.parse(readFileSync(path.join(HERE, n), "utf8"));
const c3 = rd("BASELINE-W1-MACOS-CANDIDATE-3.json"), c4 = rd("BASELINE-W1-MACOS-CANDIDATE-4.json");
const live = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => !k.startsWith("_")));


// reuse the comparator test file's synthetic fixtures (its tests turned into no-ops, its fixtures exported)
const LIB = pathToFileURL(path.join(HERE, "compare-preflight-lib.mjs")).href;
let src = readFileSync(path.join(HERE, "compare-preflight.test.mjs"), "utf8");
src = src.replace('import { test } from "node:test";', "const test = () => {};").replace('"./compare-preflight-lib.mjs"', JSON.stringify(LIB))
  .replace("const HERE = path.dirname(fileURLToPath(import.meta.url));", `const HERE = ${JSON.stringify(HERE)};`) + "\nexport { goodResults, metasFor, attest, manifest, WS, WE, NOW };\n";
const dir = mkdtempSync(path.join(tmpdir(), "c4-proof-"));
writeFileSync(path.join(dir, "fixtures.mjs"), src);
const fx = await import(pathToFileURL(path.join(dir, "fixtures.mjs")).href);
const { evaluate, FILES } = await import(LIB);
const manifestText = readFileSync(path.join(HERE, "MANIFEST.sha256"), "utf8");
const man = Object.fromEntries(manifestText.split("\n").map((l) => /^([0-9a-f]{64}) [ *](.+)$/.exec(l)).filter(Boolean).map((x) => [x[2], x[1]]));

// the candidate-2 proof builds its g09 results from the baseline; do the same here from candidate 3 (identical g09)
const J = (rows) => JSON.stringify({ rows });
function results() {
  const f = fx.goodResults(); const ords = Object.keys(c3.g09.per_ordinal).map(Number); const money = (e) => (e.money ? 1 : 0), acct = (e) => (e.acct ? 1 : 0);
  f["g09a-0214-reach-summary"] = J([{ at_hosted_0212: 1, studios: c3.g09.studios, reachable_by_setter: c3.g09.reachable_by_setter, refused_account: c3.g09.refused_account, refused_money_only: c3.g09.refused_money_only }]);
  f["g09b-0214-reach-per-studio"] = J(ords.map((o) => { const e = c3.g09.per_ordinal[o]; return { at_hosted_0212: 1, studio_ordinal: o, r2a_reachable: e.r2a_reachable, needs_ack_prices: e.needs_ack_prices, charge_attempt_rows: money(e), settlement_rows: 0, manual_fee_rows: 0, appointment_payment_rows: 0, stripe_charge_rows: 0, pending_booking_payment_rows: 0, acct_provisioning_rows: 0, bound_account_rows: e.bound_live + e.bound_test, saved_card_rows: e.acct && !(e.bound_live + e.bound_test) ? 1 : 0, stripe_customer_rows: 0 }; }));
  f["g09c-0214-bound-account-mode"] = J(ords.map((o) => { const e = c3.g09.per_ordinal[o]; return { at_hosted_0212: 1, studio_ordinal: o, present: true, bound_live: e.bound_live, bound_test: e.bound_test, bound_unknown_mode: 0, observed_country_column_present: false }; }));
  return f;
}

test("diff against candidate 3: only g4_pitr_base, g4_pitr_api and g4_pitr_idle are added outside the underscore notes", () => {
  const a = live(c3), b = live(c4);
  const changed = Object.keys({ ...a, ...b }).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k])).sort();
  assert.deepEqual(changed, ["g4_pitr_api", "g4_pitr_base", "g4_pitr_idle"]);
  for (const k of changed) assert.equal(a[k], undefined);
  for (const k of Object.keys(a)) assert.equal(JSON.stringify(b[k]), JSON.stringify(a[k]), k);
  assert.deepEqual(b.g4_pitr_base, { mode: "unavailable_under_pitr" });
  assert.deepEqual(Object.fromEntries(Object.entries(b.g4_pitr_idle).filter(([k]) => !k.endsWith("sha256"))), { enabled: true, min_interval_seconds: 600, interval_margin_seconds: 180, max_timeout_seconds: 1200, max_interval_seconds: 1800, max_clock_skew_seconds: 60, horizon_after_archive_seconds: 60, horizon_before_archive_extra_seconds: 300, max_start_to_s1_seconds: 600 });
  assert.equal(b.g4_pitr_idle.runner_sha256, c3.runner_sha256);
  assert.equal(b.g4_pitr_api.script_sha256.slice(0, 8), "85407d0b"); assert.equal(b.g4_pitr_api.supabase_go_sha256.slice(0, 8), "dce26b75");
  assert.equal(b.g4_pitr_api.max_capture_age_minutes, 60); assert.equal(b.g4_pitr_api.dashboard_tolerance_seconds, 1);
  assert.equal(b.g4_pitr_idle.manifest_sha256.slice(0, 8), "089226bd"); assert.equal(b.g4_pitr_idle.wal_status_sql_sha256.slice(0, 8), "c91d7a49"); assert.equal(b.g4_pitr_idle.ready_count_sql_sha256.slice(0, 8), "339dd620");
  assert.equal(c4.runner_sha256.slice(0, 8), "471ecb9d"); assert.equal(c4.manifest_sha256.slice(0, 8), "2b1608a9");
});
test("the text diff against candidate 3 is exactly the _candidate note and the three added blocks", () => {
  const t3 = readFileSync(path.join(HERE, "BASELINE-W1-MACOS-CANDIDATE-3.json"), "utf8").split("\n"), t4 = readFileSync(path.join(HERE, "BASELINE-W1-MACOS-CANDIDATE-4.json"), "utf8").split("\n");
  const strip = (ls) => ls.filter((l) => !l.startsWith('  "_candidate"'));
  const a = strip(t3), b = strip(t4);
  const added = b.length - a.length; assert.ok(added > 0);
  const k = b.findIndex((l) => l === '  "g4_pitr_base": {');
  assert.deepEqual([...b.slice(0, k), ...b.slice(k + added)], a);
  assert.ok(b.slice(k, k + added).join("\n").includes('"g4_pitr_idle"'));
});
if (existsSync(path.join(HERE, "..", "pitr-status", "pitr-backups.sh"))) test("the pins equal the real files (pitr-backups.sh, the status SQL files, the pitr-status manifest)", () => {
  const f = (n) => sha(readFileSync(path.join(HERE, "..", "pitr-status", n), "utf8"));
  assert.equal(c4.g4_pitr_api.script_sha256, f("pitr-backups.sh")); assert.equal(c4.g4_pitr_idle.wal_status_sql_sha256, f("pitr-wal-status.sql"));
  assert.equal(c4.g4_pitr_idle.ready_count_sql_sha256, f("pitr-ready-count.sql")); assert.equal(c4.g4_pitr_idle.manifest_sha256, f("MANIFEST.sha256"));
});
const iso = (ms) => new Date(ms).toISOString().slice(0, 19) + "Z";
const apiFor = (b) => { const latest = fx.NOW - 5 * 60e3, earliest = latest - 7 * 86400e3 - 30 * 60e3, cap = fx.NOW - 120e3;
  const text = JSON.stringify({ region: "synthetic-region-1", walg_enabled: true, pitr_enabled: true, backups: [], physical_backup_data: { earliest_physical_backup_date_unix: earliest / 1000, latest_physical_backup_date_unix: latest / 1000 } }, null, 2) + "\n";
  return { latest, earliest, api: { text, meta: { command: "backups list", started_at_utc: iso(cap - 5e3), captured_at_utc: iso(cap), exit_code: 0, result_sha256: sha(text), supabase_go_sha256: b.g4_pitr_api.supabase_go_sha256, script_sha256: b.g4_pitr_api.script_sha256 } } }; };
const c4Attest = (x) => { const a = fx.attest(); delete a.g4; a.project_ref_sha256 = c4.project_ref_sha256; a.g3 = { head_sha: c4.g3.head_sha, checksums: JSON.parse(JSON.stringify(c4.g3.checksums)) };
  a.g4_pitr = { pitr_enabled: true, retention_days: 7, earliest_recovery_at_utc: iso(x.earliest), latest_recovery_at_utc: iso(x.latest) };
  a.r6 = { choice: "S0b", answer_text: "A restore test is the plan.", reference: "decision-ref-3", base_backup_unverified_ack: true }; return a; };
const run = (attest, baseline = c4, pitrApi) => { const f = results(); const msha = sha(manifestText); const metas = fx.metasFor(f, { manifest_sha256: msha, runner_sha256: c4.runner_sha256 }); for (const n of FILES) if (metas[n]) metas[n].sql_sha256 = man[`${n}.sql`];
  return evaluate({ files: f, metas, manifest: man, baseline, attest, window: { start: fx.WS, end: fx.WE }, now: fx.NOW, manifestFileSha256: msha, pitrApi }); };

test("candidate 4 with a PITR attestation and a captured pitr-backups result: every row PASS and the labelled verdict line", () => {
  const x = apiFor(c4); const o = run(c4Attest(x), c4, x.api);
  assert.equal(o.overall, "PASS", JSON.stringify(o.rows.filter((r) => r.status !== "PASS")));
  assert.equal(o.verdictLine, "OVERALL PASS (provider range; base backup UNVERIFIED; restore not tested)");
});
test("candidate 4 without the pitr-api input FAILS S0-10 and the overall", () => { const x = apiFor(c4); const o = run(c4Attest(x), c4, null); assert.equal(o.overall, "FAIL"); assert.equal(o.rows.find((r) => r.id === "S0-10").status, "FAIL"); });
test("candidate 4 with a typed base-backup claim FAILS S0-10 (the anti-mislabel control against the real candidate)", () => {
  const x = apiFor(c4); const a = c4Attest(x); a.g4_pitr.latest_base_backup_status = "COMPLETED";
  const o = run(a, c4, x.api); assert.equal(o.rows.find((r) => r.id === "S0-10").status, "FAIL");
});
test("candidate 4 with a daily g4 attestation FAILS S0-10", () => {
  const a = fx.attest(); a.project_ref_sha256 = c4.project_ref_sha256; a.g3 = { head_sha: c4.g3.head_sha, checksums: JSON.parse(JSON.stringify(c4.g3.checksums)) };
  const o = run(a, c4, apiFor(c4).api); assert.equal(o.rows.find((r) => r.id === "S0-10").status, "FAIL");
});
test("candidate 3 (no g4_pitr_base) FAILS S0-10 under this comparator: a baseline without a mode is refused", () => {
  const x = apiFor(c4); const a = c4Attest(x); a.project_ref_sha256 = c3.project_ref_sha256; a.g3 = { head_sha: c3.g3.head_sha, checksums: JSON.parse(JSON.stringify(c3.g3.checksums)) };
  const o = run(a, c3, x.api); const r = o.rows.find((q) => q.id === "S0-10"); assert.equal(r.status, "FAIL"); assert.ok(r.detail.includes("g4_pitr_base.mode"));
});
test("planned_duration_minutes 110 binds: a window with 109 minutes left FAILS S0-8, 111 passes", () => {
  const f = results(); const msha = sha(manifestText); const metas = fx.metasFor(f, { manifest_sha256: msha, runner_sha256: c4.runner_sha256 }); for (const n of FILES) if (metas[n]) metas[n].sql_sha256 = man[`${n}.sql`];
  const x = apiFor(c4);
  const ev = (end) => evaluate({ files: f, metas, manifest: man, baseline: c4, attest: c4Attest(x), window: { start: fx.WS, end }, now: fx.NOW, manifestFileSha256: msha, pitrApi: x.api }).rows.find((r) => r.id === "S0-8").status;
  assert.equal(ev("2026-10-27T01:29:00Z"), "FAIL"); assert.equal(ev("2026-10-27T01:31:00Z"), "PASS");
});
