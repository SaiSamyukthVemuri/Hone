// BASELINE-W1 CANDIDATE proof. Synthetic results only; reads the REAL MANIFEST.sha256 and the UNCHANGED comparator.
// Not one of the comparator's four pinned files: compare-preflight.mjs / -lib.mjs / .test.mjs and run-window-read.sh are untouched.
// Run: node --test baseline-repin-proof.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sha = (t) => createHash("sha256").update(t, "utf8").digest("hex");
const OLD = "c2af651c9b87720e4332e25a4b6b34831f07c5dbf94dc394fcc6805ae8d6b4b2";
const NEW = "2b1608a9ec43caf97bd9ead3fe1d10895652a080a4b8ae0a891a17be3038cd94";

// The comparator's own synthetic fixtures live inside its test file and are not exported. Derive a module from that
// file's text (its tests turned into no-ops, its fixtures exported) so the proof uses the SAME good result set.
const LIB = pathToFileURL(path.join(HERE, "compare-preflight-lib.mjs")).href;
let src = readFileSync(path.join(HERE, "compare-preflight.test.mjs"), "utf8");
src = src.replace('import { test } from "node:test";', "const test = () => {};")
  .replace('"./compare-preflight-lib.mjs"', JSON.stringify(LIB))
  .replace("const HERE = path.dirname(fileURLToPath(import.meta.url));", `const HERE = ${JSON.stringify(HERE)};`)
  + "\nexport { goodResults, metasFor, attest, baseline, manifest, WS, WE, NOW, hx };\n";
const dir = mkdtempSync(path.join(tmpdir(), "repin-proof-"));
const mod = path.join(dir, "fixtures.mjs");
writeFileSync(mod, src);
const fx = await import(pathToFileURL(mod).href);
const { evaluate, evaluateS1, FILES } = await import(LIB);


const manifestText = readFileSync(path.join(HERE, "MANIFEST.sha256"), "utf8");
const realMap = (t) => { const m = {}; for (const line of t.split("\n")) { const x = /^([0-9a-f]{64}) [ *](.+)$/.exec(line); if (x) m[x[2]] = x[1]; } return m; };
const cand = JSON.parse(readFileSync(path.join(HERE, "BASELINE-W1-MACOS-CANDIDATE-2.json"), "utf8"));
const clone = (x) => JSON.parse(JSON.stringify(x));
const man = realMap(manifestText);

// Synthetic window reads, correct per the gate headers, with G9 derived from the candidate itself (8 studios).
function results(mut = (f) => f) {
  const f = fx.goodResults();
  const J = (rows) => JSON.stringify({ rows });
  const ords = Object.keys(cand.g09.per_ordinal).map(Number);
  const money = (e) => (e.money ? 1 : 0), acct = (e) => (e.acct ? 1 : 0);
  f["g09a-0214-reach-summary"] = J([{ at_hosted_0212: 1, studios: cand.g09.studios, reachable_by_setter: cand.g09.reachable_by_setter, refused_account: cand.g09.refused_account, refused_money_only: cand.g09.refused_money_only }]);
  f["g09b-0214-reach-per-studio"] = J(ords.map((o) => { const e = cand.g09.per_ordinal[o]; return { at_hosted_0212: 1, studio_ordinal: o, r2a_reachable: e.r2a_reachable, needs_ack_prices: e.needs_ack_prices, charge_attempt_rows: money(e), settlement_rows: 0, manual_fee_rows: 0, appointment_payment_rows: 0, stripe_charge_rows: 0, pending_booking_payment_rows: 0, acct_provisioning_rows: 0, bound_account_rows: e.bound_live + e.bound_test, saved_card_rows: e.acct && !(e.bound_live + e.bound_test) ? 1 : 0, stripe_customer_rows: 0 }; }));
  f["g09c-0214-bound-account-mode"] = J(ords.map((o) => { const e = cand.g09.per_ordinal[o]; return { at_hosted_0212: 1, studio_ordinal: o, present: true, bound_live: e.bound_live, bound_test: e.bound_test, bound_unknown_mode: 0, observed_country_column_present: false }; }));
  return mut(f) ?? f;
}
function run(f, { baseline = cand, attest } = {}) {
  const msha = sha(manifestText);
  const metas = fx.metasFor(f, { manifest_sha256: msha, runner_sha256: cand.runner_sha256 });
  for (const n of FILES) if (metas[n]) metas[n].sql_sha256 = man[`${n}.sql`];
  const a = attest ?? { ...fx.attest(), project_ref_sha256: cand.project_ref_sha256, g3: { head_sha: cand.g3.head_sha, checksums: clone(cand.g3.checksums) } };
  return evaluate({ files: f, metas, manifest: man, baseline, attest: a, window: { start: fx.WS, end: fx.WE }, now: fx.NOW, manifestFileSha256: msha });
}

test("candidate carries the pins: runner 471ecb9d, manifest 2b1608a9 = the real manifest, 0214 amended, 34 checksums, 8 studios", () => {
  assert.equal(cand.runner_sha256.slice(0, 8), "471ecb9d");
  assert.equal(cand.manifest_sha256, sha(manifestText));
  assert.equal(Object.keys(cand.g3.checksums).length, 34);
  assert.equal(cand.g3.checksums["0214"].slice(0, 8), "a8bdcefe");
  assert.equal(Object.keys(cand.g09.per_ordinal).length, 8);
  assert.equal(cand.project_ref_sha256, sha("alhhybgqdmcdyzpybykj"));
});
test("a synthetic set correct per the gate headers gives OVERALL PASS with every row PASS", () => {
  const o = run(results());
  assert.equal(o.overall, "PASS", JSON.stringify(o.rows.filter((r) => r.status !== "PASS")));
  assert.equal(o.rows.filter((r) => r.status !== "PASS").length, 0);
});
const R = (f, k, fn) => { const j = JSON.parse(f[k]); fn(j.rows); f[k] = JSON.stringify(j); };
const wrong = {
  "g09a reachable_by_setter off by one": (f) => R(f, "g09a-0214-reach-summary", (r) => { r[0].reachable_by_setter += 1; }),
  "g09c bound_live off by one on ordinal 7": (f) => R(f, "g09c-0214-bound-account-mode", (r) => { r.find((x) => x.studio_ordinal === 7).bound_live = 0; }),
  "a ninth studio appears": (f) => R(f, "g09b-0214-reach-per-studio", (r) => { r.push({ ...r[0], studio_ordinal: 9 }); }),
  "history applied_count 212": (f) => R(f, "g02-history", (r) => { r[0].applied_count = 212; }),
  "census present_now 1": (f) => R(f, "census-0213-0246", (r) => { r[3].present_now = 1; }),
  "G11 wrong_type_rows 1 under the package rule": (f) => R(f, "g11-0244-legacy-laser-types", (r) => { r[0].wrong_type_rows = 1; }),
};
for (const [name, m] of Object.entries(wrong)) test(`one wrong count FAILs: ${name}`, () => {
  const o = run(results((f) => { m(f); return f; }));
  assert.equal(o.overall, "FAIL");
  assert.notEqual(o.rows.filter((r) => r.status === "FAIL").length, 0);
});
test("candidate passes schema/shape: every baseline read is satisfied (no 'missing' FAIL text on any row)", () => {
  const o = run(results());
  for (const r of o.rows) assert.doesNotMatch(r.detail ?? "", /missing|must pin|is not exactly/i, r.id);
});
test("a wrong 0214 checksum (superseded 8ff9350e) in the candidate FAILs S0-9; a wrong runner hash FAILs S0-14", () => {
  const b1 = clone(cand); b1.g3.checksums["0214"] = "8ff9350eb53070c970b9548e4e4093e2aa878116fd7ad9dc118bfb3d401a3289";
  assert.equal(run(results(), { baseline: b1 }).rows.find((r) => r.id === "S0-9").status, "FAIL");
  const b2 = clone(cand); b2.runner_sha256 = "ec9b7c568a69d3b776ee9c643bcb52eb567639ab9cb0c995b33f59cf6d974468";
  assert.equal(run(results(), { baseline: b2 }).rows.find((r) => r.id === "S0-14").status, "FAIL");
});
test("the candidate's s1 block passes the S1 read-back shape check (synthetic read-back equal to it)", () => {
  const e = clone(cand.s1);
  const rb = { history: { applied_count: 245, hosted_max: "0246", distinct_versions_ge_0213: 34 }, closures: clone(e.closures), table_privileges: clone(e.table_privileges), body_md5: clone(e.body_md5) };
  const versions = Object.keys(cand.g3.checksums);
  const census = JSON.stringify(versions.map((v) => ({ version: v, objects_checked: v === "0214" ? 30 : 5, present_now: v === "0214" ? 30 : 5 })));
  const g10 = JSON.stringify(Array.from({ length: 7 }, (_, i) => ({ con_oid: i, present: true, present_total: 7 })));
  const o = evaluateS1({ censusText: census, g10Text: g10, readback: rb, expected: e });
  assert.equal(o.overall, "PASS", JSON.stringify(o.rows.filter((r) => r.status !== "PASS")));
  rb.body_md5.start_session = "0".repeat(32);
  assert.equal(evaluateS1({ censusText: census, g10Text: g10, readback: rb, expected: e }).overall, "FAIL");
});

test("candidate 2: ordinal 8 equals the preflight g09b/g09c row (reachable, needs_ack_prices true, no account, no money, bound 0/0)", () => {
  assert.deepEqual(cand.g09.per_ordinal["8"], { r2a_reachable: true, needs_ack_prices: true, acct: false, money: false, bound_live: 0, bound_test: 0 });
  assert.equal(cand.g09.reachable_by_setter, 4);
});
// Real 25 Oct preflight captures (informational), when the OPS tree is beside this one.
const PRE = path.join(HERE, "..", "..", "01-ops", "preflight-results", "results-preflight.fL3mPk");
import { existsSync } from "node:fs";
test("real preflight results, --data-only: S0-5 PASS under candidate 2, and S0-5 is the only row that differs from candidate 1", { skip: !existsSync(PRE) }, () => {
  const files = {}, metas = {};
  for (const n of FILES) { files[n] = readFileSync(path.join(PRE, `${n}.json`), "utf8"); metas[n] = JSON.parse(readFileSync(path.join(PRE, `${n}.meta.json`), "utf8")); }
  const ev = (b) => evaluate({ files, metas, manifest: man, baseline: b, attest: null, window: { start: "2026-10-25T23:55:00Z", end: "2026-10-25T23:56:00Z" }, maxAgeMin: 120, dataOnly: true, now: Date.parse("2026-10-25T23:56:00Z"), manifestFileSha256: sha(manifestText) });
  const old = JSON.parse(readFileSync(path.join(HERE, "BASELINE-W1-MACOS-CANDIDATE.json"), "utf8"));
  const a = ev(cand), b = ev(old);
  assert.equal(a.rows.find((r) => r.id === "S0-5").status, "PASS");
  assert.equal(b.rows.find((r) => r.id === "S0-5").status, "FAIL");
  const diff = a.rows.filter((r, i) => r.status !== b.rows[i].status).map((r) => r.id);
  assert.deepEqual(diff, ["S0-5"]);
  assert.equal(a.overall, "DATA-ONLY");
});
