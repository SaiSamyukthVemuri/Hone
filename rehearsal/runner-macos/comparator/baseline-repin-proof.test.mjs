// BASELINE-REPIN proof. Synthetic results only; reads the REAL MANIFEST.sha256 and the UNCHANGED comparator.
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
const { evaluate, FILES } = await import(LIB);

const manifestText = readFileSync(path.join(HERE, "MANIFEST.sha256"), "utf8");
const realMap = (t) => { const m = {}; for (const line of t.split("\n")) { const x = /^([0-9a-f]{64}) [ *](.+)$/.exec(line); if (x) m[x[2]] = x[1]; } return m; };
const oldText = manifestText.split("\n").filter((l) => !/ g09d-0214-currency-history\.sql$/.test(l)).join("\n");

// A correctly bound sidecar set: the runner stamps each sidecar with the manifest FILE's hash and the file's own sql sha.
function run({ manifestFile, baselineSha }) {
  const files = fx.goodResults();
  const man = realMap(manifestFile), msha = sha(manifestFile);
  const metas = fx.metasFor(files, { manifest_sha256: msha });
  for (const n of FILES) metas[n].sql_sha256 = man[`${n}.sql`];
  const baseline = { ...fx.baseline(), manifest_sha256: baselineSha };
  return evaluate({ files, metas, manifest: man, baseline, attest: fx.attest(), window: { start: fx.WS, end: fx.WE }, now: fx.NOW, manifestFileSha256: msha });
}
const s014 = (o) => o.rows.find((r) => r.id === "S0-14");

test("the real manifest is the 14-file one and hashes to the new pin; without the g09d line it is the old pin", () => {
  assert.equal(manifestText.split("\n").filter(Boolean).length, 14);
  assert.equal(sha(manifestText), NEW);
  assert.equal(sha(oldText), OLD);
  assert.ok(FILES.every((n) => realMap(manifestText)[`${n}.sql`]), "the comparator's 13 names are all in the 14-line manifest");
});
test("NEW baseline + sidecars bound to the real 14-file manifest: S0-14 PASS and the whole set PASS", () => {
  const o = run({ manifestFile: manifestText, baselineSha: NEW });
  assert.equal(s014(o).status, "PASS", s014(o).detail);
  assert.equal(o.overall, "PASS", JSON.stringify(o.rows.filter((r) => r.status !== "PASS")));
});
test("OLD c2af651c baseline against the real 14-file manifest: S0-14 FAIL (manifest file on disk), overall FAIL, even with sidecars bound correctly", () => {
  const o = run({ manifestFile: manifestText, baselineSha: OLD });
  assert.equal(s014(o).status, "FAIL");
  assert.match(s014(o).detail, /MANIFEST\.sha256 file on disk does not hash to baseline\.manifest_sha256/);
  assert.equal(o.overall, "FAIL");
});
test("control: the OLD baseline passes against the OLD 13-line manifest, and the NEW baseline fails against it (the check bites both ways)", () => {
  assert.equal(s014(run({ manifestFile: oldText, baselineSha: OLD })).status, "PASS");
  assert.equal(s014(run({ manifestFile: oldText, baselineSha: NEW })).status, "FAIL");
});
test("a baseline pinning the NEW sha but sidecars stamped with the OLD manifest hash fails (captured under a different manifest)", () => {
  const files = fx.goodResults(), man = realMap(manifestText);
  const metas = fx.metasFor(files, { manifest_sha256: OLD });
  for (const n of FILES) metas[n].sql_sha256 = man[`${n}.sql`];
  const o = evaluate({ files, metas, manifest: man, baseline: { ...fx.baseline(), manifest_sha256: NEW }, attest: fx.attest(), window: { start: fx.WS, end: fx.WE }, now: fx.NOW, manifestFileSha256: sha(manifestText) });
  assert.equal(s014(o).status, "FAIL");
  assert.match(s014(o).detail, /captured under a different manifest/);
});

// RUNNER-MACOS: when Sam runs the macOS variant, every sidecar carries the VARIANT's hash as runner_sha256
// (it hashes its own file), so baseline.runner_sha256 must be that hash; the pinned runner's ec9b7c56 then fails S0-14.
const VARIANT_SHA = sha(readFileSync(path.join(HERE, "run-window-read-macos.sh"), "utf8"));
const PINNED_RUNNER_SHA = sha(readFileSync(path.join(HERE, "run-window-read.sh"), "utf8"));
function runWithRunner({ stamped, pinned }) {
  const files = fx.goodResults(), man = realMap(manifestText), msha = sha(manifestText);
  const metas = fx.metasFor(files, { manifest_sha256: msha, runner_sha256: stamped });
  for (const n of FILES) metas[n].sql_sha256 = man[`${n}.sql`];
  return evaluate({ files, metas, manifest: man, baseline: { ...fx.baseline(), manifest_sha256: NEW, runner_sha256: pinned }, attest: fx.attest(), window: { start: fx.WS, end: fx.WE }, now: fx.NOW, manifestFileSha256: msha });
}
test("RUNNER-MACOS: sidecars stamped with the variant's hash pass only against a baseline pinning the variant", () => {
  assert.notEqual(VARIANT_SHA, PINNED_RUNNER_SHA);
  assert.match(PINNED_RUNNER_SHA, /^ec9b7c56/);
  assert.equal(s014(runWithRunner({ stamped: VARIANT_SHA, pinned: VARIANT_SHA })).status, "PASS");
  const o = runWithRunner({ stamped: VARIANT_SHA, pinned: PINNED_RUNNER_SHA });
  assert.equal(s014(o).status, "FAIL"); assert.match(s014(o).detail, /captured by a different runner/);
  assert.equal(s014(runWithRunner({ stamped: PINNED_RUNNER_SHA, pinned: PINNED_RUNNER_SHA })).status, "PASS");
});

// COMPARATOR-REPIN (D2, 25 Oct): the macOS variant is the reviewed runner 471ecb9d. BASELINE-MACOS-PROPOSED.json edits two
// baseline fields. Proof that the edited baseline passes S0-14 on sidecars the macOS runner writes, fails on sidecars from
// the pinned Linux runner and from the earlier variant copies, and that the 126 comparator tests are not touched.
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync } from "node:fs";
const ACCEPTED = "471ecb9d18116f9b5c898400d9dae0aa898be5aa795b2788c44eacdefeb27357";
const OLD_VARIANTS = [
  "891119ac17c8fb9970e4de09f6cac3307d8de672175cf348e5268f4ea58756c9",
  "d7cc1b24" + "0".repeat(56), // only the prefix of d7cc1b24 is recorded; any value other than ACCEPTED must fail the same way
];
const proposal = JSON.parse(readFileSync(path.join(HERE, "BASELINE-MACOS-PROPOSED.json"), "utf8"));
const edited = (() => {
  const b = { ...fx.baseline() };
  for (const e of proposal.edits) b[e.path] = e.proposed;
  return b;
})();
function evalWith(stamped, baseline = edited) {
  const files = fx.goodResults(), man = realMap(manifestText), msha = sha(manifestText);
  const metas = fx.metasFor(files, { manifest_sha256: msha, runner_sha256: stamped });
  for (const n of FILES) metas[n].sql_sha256 = man[`${n}.sql`];
  return evaluate({ files, metas, manifest: man, baseline, attest: fx.attest(), window: { start: fx.WS, end: fx.WE }, now: fx.NOW, manifestFileSha256: msha });
}
test("COMPARATOR-REPIN: the proposal edits exactly runner_sha256 and manifest_sha256, to the accepted runner and the 14-file manifest", () => {
  assert.deepEqual(proposal.edits.map((e) => e.path), ["runner_sha256", "manifest_sha256"]);
  assert.equal(proposal.edits[0].proposed, ACCEPTED);
  assert.equal(proposal.edits[1].proposed, NEW);
  assert.equal(proposal.edits[0].current, PINNED_RUNNER_SHA);
  assert.equal(proposal.edits[1].current, OLD);
  assert.equal(sha(readFileSync(path.join(HERE, "run-window-read-macos.sh"), "utf8")), ACCEPTED, "the variant on disk is the accepted runner");
  const diffKeys = Object.keys(edited).filter((k) => JSON.stringify(edited[k]) !== JSON.stringify(fx.baseline()[k]));
  assert.deepEqual(diffKeys.sort(), ["manifest_sha256", "runner_sha256"], "no other baseline field is touched");
});
test("COMPARATOR-REPIN: the edited baseline PASSES S0-14 (and the whole set) on sidecars stamped by the macOS runner", () => {
  const o = evalWith(ACCEPTED);
  assert.equal(s014(o).status, "PASS", s014(o).detail);
  assert.equal(o.overall, "PASS", JSON.stringify(o.rows.filter((r) => r.status !== "PASS")));
});
test("COMPARATOR-REPIN: sidecars from the pinned Linux runner ec9b7c56 FAIL S0-14 against the edited baseline", () => {
  const o = evalWith(PINNED_RUNNER_SHA);
  assert.equal(s014(o).status, "FAIL"); assert.match(s014(o).detail, /captured by a different runner/); assert.equal(o.overall, "FAIL");
});
test("COMPARATOR-REPIN: sidecars from the earlier variant copies 891119ac and d7cc1b24 FAIL S0-14", () => {
  for (const s of OLD_VARIANTS) {
    const o = evalWith(s);
    assert.equal(s014(o).status, "FAIL", s.slice(0, 8)); assert.match(s014(o).detail, /captured by a different runner/); assert.equal(o.overall, "FAIL");
  }
});
test("COMPARATOR-REPIN: a mixed result directory (one Linux sidecar among macOS ones) FAILS", () => {
  const files = fx.goodResults(), man = realMap(manifestText), msha = sha(manifestText);
  const metas = fx.metasFor(files, { manifest_sha256: msha, runner_sha256: ACCEPTED });
  for (const n of FILES) metas[n].sql_sha256 = man[`${n}.sql`];
  metas[FILES[0]].runner_sha256 = PINNED_RUNNER_SHA;
  const o = evaluate({ files, metas, manifest: man, baseline: edited, attest: fx.attest(), window: { start: fx.WS, end: fx.WE }, now: fx.NOW, manifestFileSha256: msha });
  assert.equal(s014(o).status, "FAIL"); assert.match(s014(o).detail, new RegExp(`${FILES[0]}: captured by a different runner`));
});
test("COMPARATOR-REPIN: the edited baseline is not the Linux baseline (the old runner pin no longer passes macOS sidecars)", () => {
  const linux = { ...edited, runner_sha256: PINNED_RUNNER_SHA };
  assert.equal(s014(evalWith(ACCEPTED, linux)).status, "FAIL");
  assert.equal(s014(evalWith(PINNED_RUNNER_SHA, linux)).status, "PASS");
});
// Sidecar PARITY: a sidecar really written by the macOS variant (run with its CLI stubbed in a test copy, exactly as
// real-bin-gate.sh does) has the same keys the comparator fixtures use, so the synthetic proof above is about the real format.
test("COMPARATOR-REPIN: a sidecar written by the macOS variant has exactly the comparator's sidecar keys, and its runner_sha256 is the variant's own hash", () => {
  const t = mkdtempSync(path.join(tmpdir(), "mac-sidecar-"));
  const variant = readFileSync(path.join(HERE, "run-window-read-macos.sh"), "utf8");
  const stubBin = path.join(t, "bin"); writeFileSync(stubBin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const stubSha = sha(readFileSync(stubBin, "utf8"));
  const copy = variant
    .replace(/^SUPABASE_GO_SHA256=.*/m, `SUPABASE_GO_SHA256=${stubSha}`)
    .replace(/^run_cli\(\) \{.*/m, 'run_cli() { echo "[]"; }');
  assert.notEqual(copy, variant);
  mkdirSync(path.join(t, "d")); mkdirSync(path.join(t, "cwd/supabase/.temp"), { recursive: true }); mkdirSync(path.join(t, "out"));
  writeFileSync(path.join(t, "d/run-window-read-macos.sh"), copy, { mode: 0o755 });
  writeFileSync(path.join(t, "d/gate.sql"), "select 1;\n");
  writeFileSync(path.join(t, "d/MANIFEST.sha256"), `${sha("select 1;\n")}  gate.sql\n`);
  const ref = "abcdefghijklmnopqrst";
  writeFileSync(path.join(t, "cwd/supabase/.temp/project-ref"), ref + "\n");
  writeFileSync(path.join(t, "cwd/supabase/.temp/pooler-url"), `postgresql://postgres.${ref}@aws-1-us-east-1.pooler.supabase.com:5432/postgres\n`);
  writeFileSync(path.join(t, "cwd/supabase/.temp/cli-latest"), "v2.102.0");
  execFileSync("/bin/bash", [path.join(t, "d/run-window-read-macos.sh"), "gate.sql"], {
    cwd: path.join(t, "cwd"), stdio: "pipe",
    env: { PATH: "/usr/bin:/bin", HOME: t, HONE_WINDOW_PROJECT_REF: ref, SUPABASE_DB_PASSWORD: "synthetic-not-a-secret", HONE_SUPABASE_BIN: stubBin, HONE_WINDOW_RESULT_DIR: path.join(t, "out") },
  });
  const meta = JSON.parse(readFileSync(path.join(t, "out/gate.meta.json"), "utf8"));
  const fixtureKeys = Object.keys(Object.values(fx.metasFor(fx.goodResults()))[0]).sort();
  assert.deepEqual(Object.keys(meta).sort(), fixtureKeys);
  assert.equal(meta.runner_sha256, sha(copy), "the sidecar names the runner file that wrote it (the test copy here; 471ecb9d for the real file)");
  assert.equal(meta.exit_code, 0);
  assert.ok(readdirSync(path.join(t, "out")).includes("gate.json"));
});
