// Synthetic fixtures only: invented counts, no real result. Run: node --test rehearsal/window-0248/tests
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "variants");
const sha = (t) => createHash("sha256").update(t).digest("hex");
const rd = (rel) => readFileSync(path.join(OUT, rel), "utf8");
const clone = (o) => JSON.parse(JSON.stringify(o));
const lib = await import(pathToFileURL(path.join(OUT, "s0a/compare-preflight-lib.mjs")).href);
const { evaluate, FILES, CHECKS, W3_TABLES, S1_TABLES, SEALED_0248_SHA } = lib;
const J = (rows) => JSON.stringify({ rows });

// ---------------------------------------------------------------------------------------------------- comparator variant
const G = { "g02-history-0248": "g02-history-0248", g12: "g12-0243-intake-definers-0248", tx: "s1-open-transactions-0248", w3: "w03-table-sizes-0248" };
const good = () => ({
  [G["g02-history-0248"]]: J([{ applied_count: 245, hosted_max: "0246", versions_ge_0247: 0, rows_0245: 1, rows_0246: 1, last4: "0246,0245,0244,0243" }]),
  [G.g12]: J([{ at_hosted_0246: 1, context_ok: true, owner_not_assumable: true, writer_privileges_ok: true, owner_authority_ok: true, unexpected_callable_definers: 0 }]),
  [G.tx]: J(S1_TABLES.map((t) => ({ at_hosted_0246: 1, table_name: t, xact_age_seconds: 60, table_present: true, old_xact_backends: 0 }))),
  [G.w3]: J(W3_TABLES.map((t) => ({ at_hosted_0246: 1, table_name: t, present: true, total_bytes: 1048576, approx_rows: 1000, statement_timeout: "2min", lock_timeout: "5s" }))),
});
const WS = "2026-10-29T11:00:00Z", WE = "2026-10-29T14:00:00Z", NOW = Date.parse("2026-10-29T11:40:00Z");
const HEAD = "d".repeat(40);
const baseline = (over = {}) => {
  const b = JSON.parse(rd("s0a/BASELINE-W1-0248.json"));
  b.g3.head_sha = HEAD;
  b.runner_sha256 = "a".repeat(64);
  return { ...b, ...over };
};
const manifest = () => Object.fromEntries(FILES.map((n) => [`${n}.sql`, sha(`sql-${n}`)]));
const metas = (files, o = {}) => Object.fromEntries(FILES.filter((n) => typeof files[n] === "string").map((n, i) => [n, {
  file: `${n}.sql`, sql_sha256: sha(`sql-${n}`), result_sha256: sha(files[n]), started_at_utc: `2026-10-29T11:3${i}:00Z`, captured_at_utc: `2026-10-29T11:3${i}:30Z`,
  exit_code: 0, runner_sha256: "a".repeat(64), manifest_sha256: baseline().manifest_sha256, ...(o[n] ?? {}),
}]));
const run = (mut = () => {}, opts = {}) => {
  const f = good(); mut(f);
  const b = opts.baseline ?? baseline();
  const a = opts.attest ?? { g3: { head_sha: HEAD, checksums: { "0248": SEALED_0248_SHA } } };
  const mf = manifest(); if (opts.manifest) opts.manifest(mf);
  const r = evaluate({ files: f, metas: opts.metas ? opts.metas(f) : metas(f), manifest: mf, manifestFileSha256: b.manifest_sha256, baseline: b, attest: a,
    window: { start: WS, end: WE }, maxAgeMin: 30, now: NOW });
  return Object.fromEntries(r.rows.map((x) => [x.id, x]));
};
const st = (rows, id) => rows[id].status;

test("the variant checks exactly the kept set, and none of the dropped 1035-range checks can be required", () => {
  assert.deepEqual(FILES, ["g02-history-0248", "g12-0243-intake-definers-0248", "s1-open-transactions-0248", "w03-table-sizes-0248"]);
  assert.deepEqual(CHECKS.map((c) => c.id), ["S0-1", "S0-2", "S0-6c", "S0-7", "S0-14", "S0-W3", "S0-8", "S0-9", "S0-10", "S0-11", "S0-12", "S0-13"]);
  const rows = run();
  for (const dropped of ["S0-3", "S0-4a", "S0-4b", "S0-5", "S0-6a", "S0-6b"]) assert.equal(rows[dropped], undefined, dropped);
  // a baseline that tries to re-require a dropped check fails closed: an unknown id cannot be treated as passed
  const r = run(() => {}, { baseline: baseline({ required_checks: ["S0-3"] }) });
  assert.equal(st(r, "S0-3"), "FAIL");
});

test("S0-2: the 245 / 0246 / none >= 0247 history, each column with a negative control", () => {
  assert.equal(st(run(), "S0-2"), "PASS");
  const bad = (k, v) => run((f) => { const r = JSON.parse(f["g02-history-0248"]).rows[0]; r[k] = v; f["g02-history-0248"] = J([r]); });
  assert.equal(st(bad("applied_count", 246), "S0-2"), "FAIL");
  assert.equal(st(bad("hosted_max", "0248"), "S0-2"), "FAIL");
  assert.equal(st(bad("versions_ge_0247", 1), "S0-2"), "FAIL");
  assert.equal(st(bad("rows_0246", 0), "S0-2"), "FAIL");
  assert.equal(st(bad("last4", "0248,0246,0245,0244"), "S0-2"), "FAIL");
  assert.equal(st(run((f) => { f["g02-history-0248"] = J([]); }), "S0-2"), "FAIL");
});

test("S0-13 and the guarded reads: the chain guard must be 1 at hosted 0246, and a missing file fails", () => {
  assert.equal(st(run(), "S0-13"), "PASS");
  assert.equal(st(run((f) => { const r = JSON.parse(f[G.g12]).rows; r[0].at_hosted_0246 = 0; f[G.g12] = J(r); }), "S0-13"), "FAIL");
  assert.equal(st(run((f) => { delete f[G.w3]; }), "S0-13"), "FAIL");
  // the 1035 guard column name is NOT accepted
  assert.equal(st(run((f) => { const r = JSON.parse(f[G.tx]).rows.map((x) => ({ ...x, at_hosted_0212: 1, at_hosted_0246: undefined })); f[G.tx] = J(r); }), "S0-13"), "FAIL");
});

test("S0-6c, S0-7, S0-W3 keep their rules (both paths)", () => {
  const r = run();
  for (const id of ["S0-6c", "S0-7", "S0-W3"]) assert.equal(st(r, id), "PASS", id);
  const g12 = (k, v) => run((f) => { const x = JSON.parse(f[G.g12]).rows; x[0][k] = v; f[G.g12] = J(x); });
  // the 0212-era rule is gone: a callable writer and the pinned receptionist command are EXPECTED at 0246, so the count of OTHER callable definers is the gate
  assert.equal(st(g12("unexpected_callable_definers", 1), "S0-6c"), "FAIL");
  for (const k of ["context_ok", "owner_not_assumable", "writer_privileges_ok", "owner_authority_ok"]) assert.equal(st(g12(k, false), "S0-6c"), "FAIL", k);
  assert.equal(st(run((f) => { f[G.g12] = J([{ at_hosted_0246: 1, callable_total: 0, signature: null }]); }), "S0-6c"), "FAIL", "the old g12 columns are not accepted");
  assert.equal(st(run((f) => { const x = JSON.parse(f[G.g12]).rows; f[G.g12] = J([x[0], x[0]]); }), "S0-6c"), "FAIL", "two rows");
  assert.equal(st(run((f) => { const x = JSON.parse(f[G.tx]).rows; x[0].old_xact_backends = 2; f[G.tx] = J(x); }), "S0-7"), "FAIL");
  assert.equal(st(run((f) => { const x = JSON.parse(f[G.w3]).rows; x[0].total_bytes = 600 * 1024 * 1024; f[G.w3] = J(x); }), "S0-W3"), "FAIL");
});

test("S0-14: results must bind to THIS window, this manifest and this runner", () => {
  assert.equal(st(run(), "S0-14"), "PASS");
  assert.equal(st(run(() => {}, { metas: (f) => metas(f, { [G.g12]: { sql_sha256: "e".repeat(64) } }) }), "S0-14"), "FAIL");
  assert.equal(st(run(() => {}, { metas: (f) => metas(f, { [G.tx]: { started_at_utc: "2026-10-29T10:00:00Z" } }) }), "S0-14"), "FAIL");
  assert.equal(st(run(() => {}, { metas: (f) => metas(f, { [G.w3]: { runner_sha256: "9".repeat(64) } }) }), "S0-14"), "FAIL");
});

test("S0-9: only the sealed 0248 sha256 at the pinned head passes", () => {
  assert.equal(st(run(), "S0-9"), "PASS");
  const withG3 = (g3) => run(() => {}, { attest: { g3 } });
  assert.equal(st(withG3({ head_sha: HEAD, checksums: { "0248": "1".repeat(64) } }), "S0-9"), "FAIL", "altered 0248");
  assert.equal(st(withG3({ head_sha: HEAD, checksums: { "0248": SEALED_0248_SHA, "0247": "2".repeat(64) } }), "S0-9"), "FAIL", "0247 present");
  assert.equal(st(withG3({ head_sha: HEAD, checksums: { "0249": SEALED_0248_SHA } }), "S0-9"), "FAIL", "0249 instead of 0248");
  assert.equal(st(withG3({ head_sha: "c".repeat(40), checksums: { "0248": SEALED_0248_SHA } }), "S0-9"), "FAIL", "wrong head");
  assert.equal(st(run(() => {}, { baseline: baseline({ g3: { head_sha: "0".repeat(40), checksums: { "0248": SEALED_0248_SHA } } }), attest: { g3: { head_sha: "0".repeat(40), checksums: { "0248": SEALED_0248_SHA } } } }), "S0-9"), "FAIL", "OPEN head");
  assert.equal(st(run(() => {}, { baseline: baseline({ g3: { head_sha: HEAD, checksums: { "0248": "1".repeat(64) } } }) }), "S0-9"), "FAIL", "baseline cannot launder the sha");
  assert.equal(SEALED_0248_SHA, "1f6f9ad0026cee66b970e9dc630f1497aa10966df2adb9433d8f8c85bbc44cc3");
});

// ---------------------------------------------------------------------------------------------------- scripts and pins
const s0a = rd("s0a/window-s0a-0248.sh"), s1 = rd("s1read/window-s1read-0248.sh");
const exec = (t) => t.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
const pin = (t, k) => new RegExp(`^${k}=(\\S+)`, "m").exec(t)?.[1];

test("S0a script: pins equal the files they pin; the OPEN head is refused; no S1-range constant remains in executable lines", () => {
  assert.equal(pin(s0a, "MANIFEST_SHA"), sha(rd("s0a/MANIFEST.sha256")));
  assert.equal(pin(s0a, "LIB_SHA"), sha(rd("s0a/compare-preflight-lib.mjs")));
  assert.equal(pin(s0a, "CMP_SHA"), sha(rd("s0a/compare-preflight.mjs")));
  assert.equal(pin(s0a, "RUNNER_SHA"), sha(rd("s0a/run-window-read-macos.sh")));
  assert.equal(pin(s0a, "BASELINE_SHA"), sha(rd("s0a/BASELINE-W1-0248.json")));
  assert.equal(pin(s0a, "G3_SHA"), sha(rd("s0a/G3-CHECKSUMS-0248.txt")));
  assert.equal(JSON.parse(rd("s0a/BASELINE-W1-0248.json")).manifest_sha256, sha(rd("s0a/MANIFEST.sha256")));
  assert.match(s0a, /\[ "\$HEAD_SHA" != 0{40} \] \|\| die "HEAD_SHA is OPEN/);
  assert.equal(pin(s0a, "HEAD_SHA"), "0".repeat(40));
  assert.match(s0a, /^WR="\$ROOT\/window-reads-0248"/m);
  const code = exec(s0a);
  for (const stale of ["0212", "0213", "d189768b", "census", "g06-", "g07-", "g09", "g10-", "g11"]) assert.ok(!code.includes(stale), `stale token ${stale}`);
  const files = /^FILES="([^"]+)"/m.exec(s0a)[1].split(" ");
  assert.deepEqual(files, FILES.map((n) => `${n}.sql`));
  const mf = rd("s0a/MANIFEST.sha256").trim().split("\n").map((l) => l.split("  "));
  assert.deepEqual(mf.map((x) => x[1]), files);
  for (const [h, n] of mf) assert.equal(h, sha(rd(`s0a/${n}`)), n);
  assert.match(s0a, /= 4 \] \|\| die "MANIFEST\.sha256 did not verify exactly 4 gate files"/);
});

test("S0a attestation builder (extracted from the script) yields exactly the sealed 0248 checksum and the comparator accepts it", () => {
  const prog = /cat > "\$ATD\/mk-attest\.mjs" <<'NODE'\n([\s\S]*?)\nNODE\n/.exec(s0a)[1];
  const dir = mkdtempSync(path.join(tmpdir(), "mk-attest-"));
  writeFileSync(path.join(dir, "mk.mjs"), prog);
  const env = { A_G3FILE: path.join(OUT, "s0a/G3-CHECKSUMS-0248.txt"), A_OPERATOR: "op", A_REF: "ref", A_T1: "2026-10-29T11:00:00Z", A_T2: "2026-10-29T11:00:01Z", A_T3: "2026-10-29T11:00:02Z",
    A_MFLAG: "no_flag", A_HEAD: HEAD, A_PITR_ON: "true", A_PITR_RET: "7", A_P_EARLY: "2026-10-22T00:00:00Z", A_P_LATE: "2026-10-29T11:00:00Z", A_R6CHOICE: "accept_rpo",
    A_R6TEXT: "unverified base backup", A_R6REF: "r", A_D0242: "R-3", A_D0242REF: "r", A_OUT: path.join(dir, "a.json") };
  const r = spawnSync("node", [path.join(dir, "mk.mjs")], { env: { ...process.env, ...env }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const att = JSON.parse(readFileSync(env.A_OUT, "utf8"));
  assert.deepEqual(att.g3, { head_sha: HEAD, checksums: { "0248": SEALED_0248_SHA } });
  assert.equal(st(run(() => {}, { attest: att }), "S0-9"), "PASS");
  // negative control: the old 34-line G3 file is refused by the builder
  const old = path.join(dir, "old.txt");
  writeFileSync(old, Array.from({ length: 34 }, (_, i) => `${"a".repeat(64)}  02${String(13 + i).padStart(2, "0")}_x.sql`).join("\n") + "\n");
  assert.notEqual(spawnSync("node", [path.join(dir, "mk.mjs")], { env: { ...process.env, ...env, A_G3FILE: old }, encoding: "utf8" }).status, 0);
});

test("every SQL file passes the runner's lexical rule, is listed once in its manifest, and its guard is hosted 0246", () => {
  const lexical = (body) => {
    const t = body.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n").trim().replace(/;$/, "");
    if (t.includes("/*")) return "block comment";
    if (t.includes(";")) return "semicolon before the end";
    if (!/^(select|with)\s/i.test(t)) return "must start with select or with";
    return null;
  };
  assert.equal(lexical("select 1;\nselect 2"), "semicolon before the end", "negative control: two statements");
  assert.equal(lexical("update t set a=1"), "must start with select or with", "negative control: a write");
  for (const dir of ["s0a", "s1read"]) {
    const mf = rd(`${dir}/MANIFEST.sha256`).trim().split("\n").map((l) => l.split("  "));
    assert.equal(new Set(mf.map((x) => x[1])).size, mf.length);
    for (const [h, n] of mf) { const body = rd(`${dir}/${n}`); assert.equal(h, sha(body), n); assert.equal(lexical(body), null, n); }
  }
  for (const n of ["g12-0243-intake-definers-0248", "s1-open-transactions-0248", "w03-table-sizes-0248"]) {
    const code = exec(rd(`s0a/${n}.sql`)).replace(/--.*$/gm, "");
    assert.match(code, /= '0246'/); assert.ok(!/'0212'/.test(code), n); assert.match(code, /at_hosted_0246/); assert.ok(!/at_hosted_0212/.test(code), n);
  }
});

test("g12 is a dry run of the sealed 0248's own preflight: the offender predicate is a verbatim copy, and the run uses no write", () => {
  const sealed = readFileSync(path.join(ROOT, "src/verify/0248_intake_protected_write_enforcement.sql"), "utf8");
  const g12 = rd("s0a/g12-0243-intake-definers-0248.sql");
  const start = sealed.indexOf("    where n.nspname = 'public' and p.prosecdef and p.oid <> v_writer");
  const end = sealed.indexOf("  ) then\n    raise exception 'Unexpected callable intake definer requires review.'");
  const verbatim = sealed.slice(start, end).replace("p.oid <> v_writer", "p.oid <> o.v_writer").replace("p.proowner = v_owner", "p.proowner = o.v_owner");
  assert.ok(g12.includes(verbatim), "the sealed offender predicate is not carried verbatim");
  assert.match(sealed, /raise exception 'Unexpected callable intake definer requires review\.'/);
  const code = exec(g12).replace(/--.*$/gm, "");
  assert.ok(!/\b(insert|update|delete|alter|drop|create|grant|revoke)\b/i.test(code.replace(/has_table_privilege\([^)]*'UPDATE'\)/g, "")), "a write verb in the read");
  assert.ok(!/callable_total/.test(code), "the 0212-era column is gone");
});

// ---------------------------------------------------------------------------------------------------- S1 read-back variant
test("S1 read-back script: constants, pins, no comparator, and the stage's own verify bundle", () => {
  assert.equal(pin(s1, "MANIFEST_SHA"), sha(rd("s1read/MANIFEST.sha256")));
  assert.equal(pin(s1, "RUNNER_SHA"), sha(rd("s1read/run-window-read-macos.sh")));
  assert.equal(/^FILES="([^"]+)"/m.exec(s1)[1], "s1-history-0248.sql c01_functions-exist.sql c02_function-bodies.sql");
  assert.equal(pin(s1, "NFILES"), "3");
  const code = exec(s1);
  for (const stale of ["compare-preflight", "--stage", "BASELINE", "CMP_SHA", "LIB_SHA", "s1-closures", "s1-table-privileges", "s1-body-md5", "s1-g10", "census"]) assert.ok(!code.includes(stale), stale);
  assert.match(s1, /verify_sha 576ff6bc423dcb41cc4464b645abddb240683126763e8c7e105cc7d6fa5cda66/);
  const list = readFileSync(path.join(ROOT, "src/verify/checks.list"), "utf8").trim().split("\n").map((l) => l.split("\t"));
  for (const [id, f, ssha, esha] of list) {
    assert.equal(sha(rd(`s1read/${f}`)), ssha, `${id} sql sha equals the bundle's`);
    assert.ok(s1.includes(esha), `${id} expected result sha is the bundle's`);
  }
  assert.equal(list[0][3], sha(`[{"n":1}]`), "canonical form: the functions-exist expectation is the sha256 of [{\"n\":1}]");
});

const check = (() => {
  const prog = /cat > "\$TMPD\/check-0248\.mjs" <<'NODE'\n([\s\S]*?)\nNODE\n/.exec(s1)[1];
  const dir = mkdtempSync(path.join(tmpdir(), "chk-"));
  writeFileSync(path.join(dir, "check.mjs"), prog);
  return (results) => {
    const res = path.join(dir, `r${Math.random().toString(36).slice(2)}`); mkdirSync(res);
    for (const [n, v] of Object.entries(results)) if (v !== undefined) writeFileSync(path.join(res, `${n}.json`), JSON.stringify(v));
    const r = spawnSync("node", [path.join(dir, "check.mjs")], { env: { ...process.env, A_RES: res }, encoding: "utf8" });
    return { status: r.status, out: r.stdout + r.stderr };
  };
})();
const PASS_LINE = "OVERALL PASS (0248 read-back: history and 2 verify-bundle checks; read-only, not a promotion)";
const goodRb = () => ({
  "s1-history-0248": [{ applied_count: 246, hosted_max: "0248", rows_0248: 1, rows_0247: 0, versions_ge_0247: 1, versions_above_0248: 0, versions_0213_0246_once_each: 34 }],
  "c01_functions-exist": [{ n: 1 }],
  "c02_function-bodies": [{ proname: "advance_intake_revision", md5: "48669dd8dba82d0d15984631ea8af739" }],
});

test("S1 read-back verdict program: the good end state passes; each wrong end state is refused with no PASS line", () => {
  const ok = check(goodRb());
  assert.equal(ok.status, 0, ok.out);
  assert.ok(ok.out.split("\n").includes(PASS_LINE));
  const refuse = (name, mut) => { const g = goodRb(); mut(g); const r = check(g); assert.notEqual(r.status, 0, name); assert.ok(!r.out.includes("OVERALL PASS"), name); };
  refuse("247 rows (a second file landed)", (g) => { g["s1-history-0248"][0].applied_count = 247; });
  refuse("max 0250", (g) => { g["s1-history-0248"][0].hosted_max = "0250"; });
  refuse("0247 present", (g) => { g["s1-history-0248"][0].rows_0247 = 1; g["s1-history-0248"][0].versions_ge_0247 = 2; });
  refuse("0248 missing", (g) => { g["s1-history-0248"][0].rows_0248 = 0; g["s1-history-0248"][0].hosted_max = "0246"; });
  refuse("something above 0248", (g) => { g["s1-history-0248"][0].versions_above_0248 = 1; });
  refuse("chain below the stage broken", (g) => { g["s1-history-0248"][0].versions_0213_0246_once_each = 33; });
  refuse("function absent", (g) => { g["c01_functions-exist"] = [{ n: 0 }]; });
  refuse("function reported twice", (g) => { g["c01_functions-exist"] = [{ n: 2 }]; });
  refuse("body md5 differs", (g) => { g["c02_function-bodies"][0].md5 = "0".repeat(32); });
  refuse("a second function row", (g) => { g["c02_function-bodies"].push({ proname: "other", md5: "1".repeat(32) }); });
  refuse("result file missing", (g) => { g["c02_function-bodies"] = undefined; });
  refuse("string where a number belongs in the bundle's row", (g) => { g["c01_functions-exist"] = [{ n: "1" }]; });
});
