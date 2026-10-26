// BASELINE-W1 CANDIDATE 3 proof (recovery_regime pitr). Synthetic results only. Run: node --test baseline-candidate3-proof.test.mjs
// Not one of the comparator's pinned files. It proves (1) the ONLY non-underscore differences from candidate 2 are
// planned_duration_minutes 60 -> 110, recovery_regime and g4_pitr, and (2) candidate 3 with a PITR attestation
// gives OVERALL PASS on the same synthetic set that candidate 2 passes with the daily attestation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sha = (t) => createHash("sha256").update(t, "utf8").digest("hex");
const rd = (n) => JSON.parse(readFileSync(path.join(HERE, n), "utf8"));
const c2 = rd("BASELINE-W1-MACOS-CANDIDATE-2.json"), c3 = rd("BASELINE-W1-MACOS-CANDIDATE-3.json");
const live = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => !k.startsWith("_")));

test("diff against candidate 2: only planned_duration_minutes (60 -> 110), recovery_regime and g4_pitr differ outside the underscore notes", () => {
  const a = live(c2), b = live(c3);
  const changed = Object.keys({ ...a, ...b }).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k])).sort();
  assert.deepEqual(changed, ["g4_pitr", "planned_duration_minutes", "recovery_regime"]);
  assert.equal(a.planned_duration_minutes, 60); assert.equal(b.planned_duration_minutes, 110);
  assert.equal(a.recovery_regime, undefined); assert.equal(b.recovery_regime, "pitr");
  assert.deepEqual(b.g4_pitr, { min_retention_days: 7, earliest_margin_minutes: 5, max_latest_lag_minutes: 30, max_read_age_minutes: 60, max_pre_point_age_minutes: 30 });
  for (const k of ["runner_sha256", "manifest_sha256", "project_ref_sha256", "g3", "g09", "g11_rule", "required_checks", "s1", "g4_max_age_hours"]) assert.equal(JSON.stringify(b[k]), JSON.stringify(a[k]), k);
  assert.equal(c3.runner_sha256.slice(0, 8), "471ecb9d"); assert.equal(c3.manifest_sha256.slice(0, 8), "2b1608a9");
});

// reuse the comparator test file's synthetic fixtures (its tests turned into no-ops, its fixtures exported)
const LIB = pathToFileURL(path.join(HERE, "compare-preflight-lib.mjs")).href;
let src = readFileSync(path.join(HERE, "compare-preflight.test.mjs"), "utf8");
src = src.replace('import { test } from "node:test";', "const test = () => {};").replace('"./compare-preflight-lib.mjs"', JSON.stringify(LIB))
  .replace("const HERE = path.dirname(fileURLToPath(import.meta.url));", `const HERE = ${JSON.stringify(HERE)};`) + "\nexport { goodResults, metasFor, attest, manifest, WS, WE, NOW };\n";
const dir = mkdtempSync(path.join(tmpdir(), "c3-proof-"));
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
const at = (m) => `2026-10-26T${m}:00Z`;
const pitrAttest = () => { const a = fx.attest(); delete a.g4; a.project_ref_sha256 = c3.project_ref_sha256; a.g3 = { head_sha: c3.g3.head_sha, checksums: JSON.parse(JSON.stringify(c3.g3.checksums)) };
  a.g4_pitr = { pitr_enabled: true, retention_days: 7, earliest_recovery_at_utc: at("01:35"), latest_recovery_at_utc: at("23:35"), latest_base_backup_status: "COMPLETED", latest_base_backup_completed_at_utc: at("23:30"), base_backup_source: "management_api", read_at_utc: at("23:38"), read_source: "dashboard" }; return a; };
const run = (attest, baseline = c3) => { const f = results(); const msha = sha(manifestText); const metas = fx.metasFor(f, { manifest_sha256: msha, runner_sha256: c3.runner_sha256 }); for (const n of FILES) if (metas[n]) metas[n].sql_sha256 = man[`${n}.sql`];
  return evaluate({ files: f, metas, manifest: man, baseline, attest, window: { start: fx.WS, end: fx.WE }, now: fx.NOW, manifestFileSha256: msha }); };

test("candidate 3 with a PITR attestation: OVERALL PASS, every row PASS", () => { const o = run(pitrAttest()); assert.equal(o.overall, "PASS", JSON.stringify(o.rows.filter((r) => r.status !== "PASS"))); });
test("candidate 3 with a daily g4 attestation FAILS S0-10 (the mislabel control against the real candidate)", () => {
  const a = fx.attest(); a.project_ref_sha256 = c3.project_ref_sha256; a.g3 = { head_sha: c3.g3.head_sha, checksums: JSON.parse(JSON.stringify(c3.g3.checksums)) };
  const o = run(a); assert.equal(o.overall, "FAIL"); assert.equal(o.rows.find((r) => r.id === "S0-10").status, "FAIL");
});
test("candidate 2 still passes with the daily attestation (nothing regressed for the daily regime)", () => {
  const a = fx.attest(); a.project_ref_sha256 = c2.project_ref_sha256; a.g3 = { head_sha: c2.g3.head_sha, checksums: JSON.parse(JSON.stringify(c2.g3.checksums)) };
  const o = run(a, c2); assert.equal(o.overall, "PASS", JSON.stringify(o.rows.filter((r) => r.status !== "PASS")));
});
test("planned_duration_minutes 110 binds: a window with 109 minutes left FAILS S0-8, 111 passes", () => {
  const f = results(); const msha = sha(manifestText); const metas = fx.metasFor(f, { manifest_sha256: msha, runner_sha256: c3.runner_sha256 }); for (const n of FILES) if (metas[n]) metas[n].sql_sha256 = man[`${n}.sql`];
  const ev = (end) => evaluate({ files: f, metas, manifest: man, baseline: c3, attest: pitrAttest(), window: { start: fx.WS, end }, now: fx.NOW, manifestFileSha256: msha }).rows.find((r) => r.id === "S0-8").status;
  assert.equal(ev("2026-10-27T01:29:00Z"), "FAIL"); assert.equal(ev("2026-10-27T01:31:00Z"), "PASS");
});
