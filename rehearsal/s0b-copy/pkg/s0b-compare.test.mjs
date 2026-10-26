// node --test s0b-compare.test.mjs   (offline; synthetic results only; uses the pinned templates and the pinned runner in this directory)
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, cpSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { compare, V_FILES, FAR, RUNNER_SHA, COPY_RUNNER_SHA } from "./s0b-compare.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const T = "2026-10-26T12:00:00Z";
const sha = (b) => createHash("sha256").update(b).digest("hex");
const FAR_FILES = V_FILES.slice(2, 6);
const TABLES = ["appointment_payments", "appointments", "client_consent_signatures", "client_intake_forms", "clients", "payment_charge_attempts", "sessions", "studios"];

const history = () => [{ applied_count: 211, hosted_max: "0212", versions_ge_0213: 0, rows_0211: 1, rows_0212: 1, name_0212: "synthetic", statements_0212: 73, statements_sha256_0212: "bc13731bb8c36b8a1db2f5a5185d0700308e598e92347a3ab87df696814ef142", last4: "0212,0211,0210,0209" }];
const catalog = () => [
  { kind: "schema", name: "public", n1: 40, n2: 90, n3: 120, md5: null },
  { kind: "rls", name: "clients", n1: 1, n2: 0, n3: 0, md5: null },
  { kind: "fingerprint", name: "public_functions", n1: 90, n2: 0, n3: 0, md5: "0123456789abcdef0123456789abcdef" },
  { kind: "fingerprint", name: "public_policies", n1: 120, n2: 0, n3: 0, md5: "fedcba9876543210fedcba9876543210" },
];
const studios = () => [1, 2, 3].map((o) => ({ studio_ordinal: o, clients: 10 * o, appointments: 20 * o, sessions: 5 * o, consents: 4 * o, intake_forms: 3 * o, charge_attempts: 2 * o, appointment_payments: o }));
const orphans = () => [{ appointments_without_client: 0, payments_without_appointment: 0, charge_attempts_without_appointment: 0, clients_without_studio: 0 }];
const recovery = (n = 7) => TABLES.map((t) => ({ table_name: t, rows_created_le_t: n, rows_total: n, rows_newer_than_t: 0 }));
const storage = () => [{ objects_le_t: 5, bytes_le_t: 12345 }];
const digests = (n = 7) => TABLES.map((t) => ({ table_name: t, ids: n, ids_md5: "d" + t }));
const buckets = (n = 7) => TABLES.flatMap((t) => [{ table_name: t, bucket: "0a", ids: 3, ids_md5: "x" + t }, { table_name: t, bucket: "1b", ids: n - 3, ids_md5: "y" + t }]);
const base = () => ({ "v7-id-digests": digests(), "v8-id-buckets": buckets(), "v1-history": history(), "v2-catalog": catalog(), "v3-studio-counts": studios(), "v4-orphans": orphans(), "v5-recovery-point": recovery(), "v6-storage-meta": storage() });

const PROD_RUNNER = "run-window-read-macos.sh", COPY_RUNNER = "run-s0b-copy-read-macos.sh";
function mkRun(root, name, files, tValue, results, tamper = {}) {
  const runner = name === "prod" ? PROD_RUNNER : COPY_RUNNER, runnerSha = name === "prod" ? RUNNER_SHA : COPY_RUNNER_SHA;
  const gen = join(root, name, "gen"), res = join(root, name, "res");
  mkdirSync(gen, { recursive: true }); mkdirSync(res, { recursive: true });
  copyFileSync(join(HERE, runner), join(gen, runner));
  for (const f of files) {
    const body = readFileSync(join(HERE, f), "utf8");
    writeFileSync(join(gen, f), body.includes("@@T@@") ? body.replace("@@T@@", tValue) : body);
  }
  const man = files.map((f) => `${sha(readFileSync(join(gen, f)))}  ${f}\n`).join("");
  writeFileSync(join(gen, "MANIFEST.sha256"), man);
  for (const f of files) {
    const stem = f.replace(/\.sql$/, "");
    const rtext = JSON.stringify(results[stem]);
    writeFileSync(join(res, `${stem}.json`), rtext);
    writeFileSync(join(res, `${stem}.meta.json`), JSON.stringify({ file: f, sql_sha256: sha(readFileSync(join(gen, f))), result_sha256: sha(rtext), started_at_utc: "2026-10-26T12:30:00Z", captured_at_utc: "2026-10-26T12:30:01Z", exit_code: 0, runner_sha256: runnerSha, manifest_sha256: sha(man) }) + "\n");
  }
  if (tamper[name]) tamper[name](gen, res);
}
function world({ prod = {}, rest = {}, far = {}, tamper = {}, t = T } = {}) {
  const root = mkdtempSync(join(tmpdir(), "s0b-"));
  const p = { ...base(), ...prod }, r = { ...base(), ...rest }, f = { ...base(), ...far };
  mkRun(root, "prod", V_FILES, t, p, tamper); mkRun(root, "rest", V_FILES, t, r, tamper); mkRun(root, "restfar", FAR_FILES, FAR, f, tamper);
  return { root, args: { templates: HERE, t, prod: join(root, "prod"), rest: join(root, "rest"), restFar: join(root, "restfar") } };
}
const run = (w) => compare(w.args);
const last = (r) => r.lines[r.lines.length - 1];

test("templates: V3..V6 carry exactly one placeholder, V1 and V2 none", () => {
  const n = (f) => readFileSync(join(HERE, f), "utf8").split("@@T@@").length - 1;
  assert.deepEqual(V_FILES.map(n), [0, 0, 1, 1, 1, 1, 1, 1]);
});

test("PASS: a clean restore", () => {
  const w = world(); const r = run(w);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(last(r), "S0B PASS");
  assert.equal(r.lines.filter((l) => l.startsWith("PASS ")).length, 8);
});

test("PASS: production gained rows after T but the T filter hides them (they are not in its T-filtered result)", () => {
  const w = world({ prod: { "v5-recovery-point": TABLES.map((t) => ({ table_name: t, rows_created_le_t: 7, rows_total: 9, rows_newer_than_t: 2 })) } });
  assert.equal(run(w).ok, true);
});

test("FAIL: the restored copy holds a row newer than T", () => {
  const w = world({ rest: { "v5-recovery-point": recovery().map((x) => (x.table_name === "appointments" ? { ...x, rows_total: 8, rows_newer_than_t: 1 } : x)) }, far: { "v5-recovery-point": recovery().map((x) => (x.table_name === "appointments" ? { ...x, rows_total: 8 } : x)) } });
  const r = run(w); assert.equal(r.ok, false); assert.match(last(r), /^S0B FAIL: appointments: restored holds 8 rows/);
});

test("FAIL: a row created before T is missing from the restored copy", () => {
  const miss = studios(); miss[1].clients -= 1;
  const w = world({ rest: { "v3-studio-counts": miss }, far: { "v3-studio-counts": miss } });
  const r = run(w); assert.equal(r.ok, false); assert.match(last(r), /^S0B FAIL: per-studio counts differ \(production@T vs restored@T\) at studio ordinal 2/);
});

test("FAIL: a row deleted before T (restored total below production at T)", () => {
  const w = world({ rest: { "v5-recovery-point": recovery(6) }, far: { "v5-recovery-point": recovery(6) } });
  const r = run(w); assert.equal(r.ok, false); assert.match(last(r), /^S0B FAIL: appointment_payments: rows created at or before T/);
});

test("PASS with NOTE: the copy holds extra rows (deleted in production after T) and no bucket shows a lost row", () => {
  const more = studios().map((x, i) => (i === 0 ? { ...x, clients: x.clients + 2 } : x));
  const rd = digests().map((x) => (x.table_name === "clients" ? { ...x, ids: 9, ids_md5: "other" } : x));
  const rb = buckets().map((x) => (x.table_name === "clients" ? (x.bucket === "0a" ? { ...x, ids: 4, ids_md5: "z" } : { ...x, ids: 5, ids_md5: "w" }) : x));
  const rec = recovery().map((x) => (x.table_name === "clients" ? { ...x, rows_created_le_t: 9, rows_total: 9 } : x));
  const r = run(world({ rest: { "v3-studio-counts": more, "v7-id-digests": rd, "v8-id-buckets": rb, "v5-recovery-point": rec }, far: { "v3-studio-counts": more, "v5-recovery-point": rec } }));
  assert.equal(r.ok, true, r.lines.join("\n")); assert.equal(last(r), "S0B PASS");
  assert.ok(r.lines.some((l) => /^NOTE  post-T deletes signature: clients: the restored copy holds 2 more ids/.test(l)));
});

test("FAIL: extra ids in the copy but a bucket shows a lost row", () => {
  const rd = digests().map((x) => (x.table_name === "clients" ? { ...x, ids: 9, ids_md5: "other" } : x));
  const rb = buckets().map((x) => (x.table_name === "clients" ? (x.bucket === "0a" ? { ...x, ids: 2, ids_md5: "z" } : { ...x, ids: 7, ids_md5: "w" }) : x));
  const r = run(world({ rest: { "v7-id-digests": rd, "v8-id-buckets": rb } })); assert.equal(r.ok, false); assert.match(last(r), /^S0B FAIL: clients: .*1 lost/);
});

test("FAIL: fewer ids in the copy (lost rows)", () => {
  const rd = digests().map((x) => (x.table_name === "sessions" ? { ...x, ids: 6 } : x));
  const r = run(world({ rest: { "v7-id-digests": rd } })); assert.equal(r.ok, false); assert.match(last(r), /^S0B FAIL: sessions: the restored copy holds 1 fewer ids/);
});

test("FAIL: same number of ids but a different digest", () => {
  const rd = digests().map((x) => (x.table_name === "appointments" ? { ...x, ids_md5: "changed" } : x));
  const r = run(world({ rest: { "v7-id-digests": rd } })); assert.equal(r.ok, false); assert.match(last(r), /^S0B FAIL: appointments: same number of ids but the id digest differs/);
});

test("FAIL: extra studios in the copy (ordinals shift)", () => {
  const rd = digests().map((x) => (x.table_name === "studios" ? { ...x, ids: 8, ids_md5: "o" } : x));
  const rb = buckets().map((x) => (x.table_name === "studios" ? (x.bucket === "0a" ? { ...x, ids: 4, ids_md5: "z" } : x) : x));
  const r = run(world({ rest: { "v7-id-digests": rd, "v8-id-buckets": rb } })); assert.equal(r.ok, false); assert.match(last(r), /^S0B FAIL: studios: the copy holds 1 more studios/);
});

test("FAIL: unfiltered restored count differs from T-filtered", () => {
  const w = world({ far: { "v3-studio-counts": studios().map((s) => ({ ...s, sessions: s.sessions + 1 })) } });
  const r = run(w); assert.equal(r.ok, false); assert.match(last(r), /restored@unfiltered/);
});

test("FAIL: migration history differs", () => {
  const h = history(); h[0].applied_count = 210;
  const r = run(world({ rest: { "v1-history": h } })); assert.equal(r.ok, false); assert.match(last(r), /^S0B FAIL: migration history differs/);
});

test("FAIL: production history is not 211/0212 (after S1)", () => {
  const h = history(); h[0].hosted_max = "0246"; h[0].versions_ge_0213 = 34; h[0].applied_count = 245;
  const r = run(world({ prod: { "v1-history": h }, rest: { "v1-history": h } })); assert.equal(r.ok, false); assert.match(last(r), /valid only BEFORE S1/);
});

test("FAIL: catalog fingerprint differs (a policy changed)", () => {
  const c = catalog(); c[3].md5 = "00000000000000000000000000000000";
  const r = run(world({ rest: { "v2-catalog": c } })); assert.equal(r.ok, false); assert.match(last(r), /^S0B FAIL: catalog fingerprint differs at fingerprint:public_policies/);
});

test("FAIL: an orphan on the restored copy", () => {
  const o = orphans(); o[0].appointments_without_client = 1;
  const r = run(world({ rest: { "v4-orphans": o } })); assert.equal(r.ok, false); assert.match(last(r), /^S0B FAIL: orphans on restored@T: appointments_without_client=1/);
});

test("FAIL: storage metadata differs", () => {
  const r = run(world({ rest: { "v6-storage-meta": [{ objects_le_t: 4, bytes_le_t: 12345 }] } })); assert.equal(r.ok, false); assert.match(last(r), /storage object metadata differs/);
});

test("FAIL: a generated file was edited after it was generated (not its pinned template)", () => {
  const w = world({ tamper: { rest: (gen) => writeFileSync(join(gen, "v4-orphans.sql"), readFileSync(join(gen, "v4-orphans.sql"), "utf8") + "\n-- edited\n") } });
  const r = run(w); assert.equal(r.ok, false); assert.match(last(r), /^S0B FAIL: restored@T/);
});

test("FAIL: a file that ran carries another T than the one declared", () => {
  const root = mkdtempSync(join(tmpdir(), "s0b-"));
  mkRun(root, "prod", V_FILES, "2026-10-26T11:00:00Z", base()); mkRun(root, "rest", V_FILES, T, base()); mkRun(root, "restfar", FAR_FILES, FAR, base());
  const r = compare({ templates: HERE, t: T, prod: join(root, "prod"), rest: join(root, "rest"), restFar: join(root, "restfar") });
  assert.equal(r.ok, false); assert.match(last(r), /^S0B FAIL: production@T: v3-studio-counts\.sql is not its pinned template with T = 2026-10-26T12:00:00Z/);
});

test("FAIL: the unfiltered run used T instead of the far constant", () => {
  const root = mkdtempSync(join(tmpdir(), "s0b-"));
  mkRun(root, "prod", V_FILES, T, base()); mkRun(root, "rest", V_FILES, T, base()); mkRun(root, "restfar", FAR_FILES, T, base());
  const r = compare({ templates: HERE, t: T, prod: join(root, "prod"), rest: join(root, "rest"), restFar: join(root, "restfar") });
  assert.equal(r.ok, false); assert.match(last(r), /restored@unfiltered/);
});

test("FAIL: the runner copy is not the pinned runner", () => {
  const w = world({ tamper: { prod: (gen) => writeFileSync(join(gen, "run-window-read-macos.sh"), "#!/bin/bash\nexit 0\n") } });
  const r = run(w); assert.equal(r.ok, false); assert.match(last(r), /^S0B FAIL: production@T: the runner copy is not the pinned runner/);
});

test("FAIL: a result was edited after capture (sidecar hash)", () => {
  const w = world({ tamper: { rest: (gen, res) => writeFileSync(join(res, "v6-storage-meta.json"), "[{\"objects_le_t\":5,\"bytes_le_t\":12345} ]") } });
  const r = run(w); assert.equal(r.ok, false); assert.match(last(r), /result_sha256 is not this result/);
});

test("FAIL: an extra file in a result directory", () => {
  const w = world({ tamper: { rest: (gen, res) => writeFileSync(join(res, "stray.json"), "[]") } });
  const r = run(w); assert.equal(r.ok, false); assert.match(last(r), /unexpected contents/);
});

test("FAIL: bad T, quoted T, future-of-far T are refused before any file is read", () => {
  const w = world();
  for (const t of ["2026-10-26", "2026-10-26T12:00:00+00:00", "2026-10-26T12:00:00Z'; drop table x;--", "9999-12-31T00:00:00Z", "9999-12-31T00:00:01Z"]) {
    const r = compare({ ...w.args, t }); assert.equal(r.ok, false, t); assert.match(last(r), /^S0B FAIL: T is not/);
  }
});

test("FAIL: a template that does not match the pinned manifest", () => {
  const dir = mkdtempSync(join(tmpdir(), "s0b-tpl-")); cpSync(HERE, dir, { recursive: true });
  writeFileSync(join(dir, "v3-studio-counts.sql"), readFileSync(join(dir, "v3-studio-counts.sql"), "utf8") + "\n");
  const w = world(); const r = compare({ ...w.args, templates: dir });
  assert.equal(r.ok, false); assert.match(last(r), /template v3-studio-counts\.sql does not match the pinned MANIFEST/);
  rmSync(dir, { recursive: true, force: true });
});

test("CLI: exits 0 only with S0B PASS as the last line; exits 1 with S0B FAIL otherwise", () => {
  const w = world(); const a = w.args;
  const cli = (extra = {}) => spawnSync(process.execPath, [join(HERE, "s0b-compare.mjs"), "--templates", a.templates, "--t", extra.t ?? a.t, "--prod", a.prod, "--rest", a.rest, "--rest-far", a.restFar], { encoding: "utf8" });
  const ok = cli(); assert.equal(ok.status, 0); assert.equal(ok.stdout.trimEnd().split("\n").pop(), "S0B PASS");
  const bad = cli({ t: "nope" }); assert.equal(bad.status, 1); assert.match(bad.stdout.trimEnd().split("\n").pop(), /^S0B FAIL: /);
  const noargs = spawnSync(process.execPath, [join(HERE, "s0b-compare.mjs")], { encoding: "utf8" }); assert.equal(noargs.status, 1);
});

// S0B-COPY-POOLER: production runs carry 471ecb9d, the restored project's runs carry the aws-0 variant. Either swapped -> FAIL.
const swapRunner = (from, to) => (gen) => { rmSync(join(gen, from)); copyFileSync(join(HERE, to), join(gen, to)); };
test("the variant is not the production runner and the two pins differ", () => {
  assert.notEqual(RUNNER_SHA, COPY_RUNNER_SHA);
  assert.equal(sha(readFileSync(join(HERE, COPY_RUNNER))), COPY_RUNNER_SHA);
  assert.equal(sha(readFileSync(join(HERE, PROD_RUNNER))), RUNNER_SHA);
});
test("FAIL: the production run carries the variant runner", () => {
  const w = world({ tamper: { prod: swapRunner(PROD_RUNNER, COPY_RUNNER) } });
  const r = run(w); assert.equal(r.ok, false); assert.match(last(r), /^S0B FAIL: production@T gen: unexpected contents/);
});
test("FAIL: the restored@T run carries the production runner", () => {
  const w = world({ tamper: { rest: swapRunner(COPY_RUNNER, PROD_RUNNER) } });
  const r = run(w); assert.equal(r.ok, false); assert.match(last(r), /^S0B FAIL: restored@T gen: unexpected contents/);
});
test("FAIL: the restored@unfiltered run carries the production runner", () => {
  const w = world({ tamper: { restfar: swapRunner(COPY_RUNNER, PROD_RUNNER) } });
  const r = run(w); assert.equal(r.ok, false); assert.match(last(r), /^S0B FAIL: restored@unfiltered gen: unexpected contents/);
});
test("FAIL: a restored run whose sidecar names the production runner", () => {
  const w = world({ tamper: { rest: (gen, res) => { const p = join(res, "v1-history.meta.json"); writeFileSync(p, readFileSync(p, "utf8").replace(COPY_RUNNER_SHA, RUNNER_SHA)); } } });
  const r = run(w); assert.equal(r.ok, false); assert.match(last(r), /^S0B FAIL: restored@T v1-history\.sql: sidecar runner or manifest is not the pinned one/);
});
test("FAIL: a production run whose sidecar names the variant", () => {
  const w = world({ tamper: { prod: (gen, res) => { const p = join(res, "v1-history.meta.json"); writeFileSync(p, readFileSync(p, "utf8").replace(RUNNER_SHA, COPY_RUNNER_SHA)); } } });
  const r = run(w); assert.equal(r.ok, false); assert.match(last(r), /^S0B FAIL: production@T v1-history\.sql: sidecar runner or manifest is not the pinned one/);
});
test("FAIL: the variant copy in a restored run was edited", () => {
  const w = world({ tamper: { rest: (gen) => writeFileSync(join(gen, COPY_RUNNER), "#!/bin/bash\nexit 0\n") } });
  const r = run(w); assert.equal(r.ok, false); assert.match(last(r), /^S0B FAIL: restored@T: the runner copy is not the pinned runner/);
});
