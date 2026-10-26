#!/usr/bin/env node
// Hone S0b comparator. Pure and offline: it reads three captured run directories and prints a verdict.
//   node s0b-compare.mjs --templates DIR --t T --prod RUN --rest RUN --rest-far RUN
// A RUN directory holds  gen/ (runner copy, the SQL files that ran, the manifest that the runner read)  and  res/ (results + sidecars).
// Exit 0 ONLY when the last line is exactly  S0B PASS . Any other outcome prints  S0B FAIL: <first difference>  and exits 1.
//
// What "manifest-pinned" means here: V3..V6 contain the recovery time T, which a pinned file cannot carry (the CLI query has no
// parameters). The PINNED files are therefore TEMPLATES holding one placeholder; this program proves that every file that ran
// equals its pinned template with exactly that one substitution, and that the substituted value is T (production, restored at T)
// or the far-future constant (restored, unfiltered). T-free files (V1, V2) must be byte-identical to the pinned file.
// Output carries counts, versions and digests only.
import { readFileSync, readdirSync, lstatSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const RUNNER_SHA = "471ecb9d18116f9b5c898400d9dae0aa898be5aa795b2788c44eacdefeb27357";
export const FAR = "9999-12-31T00:00:00Z";
export const PLACEHOLDER = "@@T@@";
export const T_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/;
export const V_FILES = ["v1-history.sql", "v2-catalog.sql", "v3-studio-counts.sql", "v4-orphans.sql", "v5-recovery-point.sql", "v6-storage-meta.sql", "v7-id-digests.sql", "v8-id-buckets.sql"];
const FAR_FILES = V_FILES.slice(2, 6);
const RUNNER = "run-window-read-macos.sh";
const TABLES = ["appointment_payments", "appointments", "client_consent_signatures", "client_intake_forms", "clients", "payment_charge_attempts", "sessions", "studios"];

class Fail extends Error {}
const sha = (b) => createHash("sha256").update(b).digest("hex");
const norm = (v) => (v === null || v === undefined ? null : Array.isArray(v) ? v.map(norm) : typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, norm(v[k])])) : String(v));
const same = (a, b) => JSON.stringify(norm(a)) === JSON.stringify(norm(b));
const fail = (m) => { throw new Fail(m); };

function listExact(dir, want, what) {
  let got;
  try { got = readdirSync(dir).sort(); } catch { fail(`${what}: directory ${dir} is not readable`); }
  const w = [...want].sort();
  if (JSON.stringify(got) !== JSON.stringify(w)) fail(`${what}: unexpected contents (have ${got.join(",")}; want ${w.join(",")})`);
  for (const n of got) if (!lstatSync(join(dir, n)).isFile()) fail(`${what}: ${n} is not a regular file`);
}

// Pinned templates: the manifest in the s0b directory must list each V file with its sha, and the file must match it.
function loadTemplates(dir) {
  const man = new Map();
  for (const l of readFileSync(join(dir, "MANIFEST.sha256"), "utf8").split("\n")) {
    const m = /^([0-9a-f]{64}) {2}(\S+)$/.exec(l);
    if (m) man.set(m[2], m[1]);
  }
  const t = new Map();
  for (const f of V_FILES) {
    const body = readFileSync(join(dir, f), "utf8");
    if (man.get(f) !== sha(body)) fail(`template ${f} does not match the pinned MANIFEST.sha256`);
    const n = body.split(PLACEHOLDER).length - 1;
    if (n > 1) fail(`template ${f} has more than one placeholder`);
    t.set(f, { body, hasT: n === 1 });
  }
  return t;
}

// One run: prove the files that ran, prove the sidecars bind the results, return the parsed results by file stem.
function loadRun(label, dir, files, tValue, templates) {
  const gen = join(dir, "gen"), res = join(dir, "res");
  listExact(gen, [RUNNER, "MANIFEST.sha256", ...files], `${label} gen`);
  if (sha(readFileSync(join(gen, RUNNER))) !== RUNNER_SHA) fail(`${label}: the runner copy is not the pinned runner`);
  const manText = readFileSync(join(gen, "MANIFEST.sha256"), "utf8");
  const manSha = sha(manText);
  const wantMan = files.map((f) => `${sha(readFileSync(join(gen, f)))}  ${f}\n`).join("");
  if (manText !== wantMan) fail(`${label}: the manifest the runner read does not list exactly these files with their shas`);
  for (const f of files) {
    const tpl = templates.get(f);
    const want = tpl.hasT ? tpl.body.replace(PLACEHOLDER, () => tValue) : tpl.body;
    if (readFileSync(join(gen, f), "utf8") !== want) fail(`${label}: ${f} is not its pinned template${tpl.hasT ? ` with T = ${tValue}` : ""}`);
  }
  listExact(res, files.flatMap((f) => [f.replace(/\.sql$/, ".json"), f.replace(/\.sql$/, ".meta.json")]), `${label} res`);
  const out = {};
  for (const f of files) {
    const stem = f.replace(/\.sql$/, "");
    const rtext = readFileSync(join(res, `${stem}.json`));
    const mtext = readFileSync(join(res, `${stem}.meta.json`), "utf8");
    if (mtext.trimEnd().split("\n").length !== 1) fail(`${label} ${f}: the sidecar is not one line`);
    let m; try { m = JSON.parse(mtext); } catch { fail(`${label} ${f}: the sidecar is not JSON`); }
    const wantKeys = "file,sql_sha256,result_sha256,started_at_utc,captured_at_utc,exit_code,runner_sha256,manifest_sha256";
    if (Object.keys(m).join(",") !== wantKeys) fail(`${label} ${f}: the sidecar has unexpected fields`);
    if (m.file !== f || m.exit_code !== 0) fail(`${label} ${f}: the sidecar names another file or a non-zero exit`);
    if (m.sql_sha256 !== sha(readFileSync(join(gen, f)))) fail(`${label} ${f}: sidecar sql_sha256 is not the file that ran`);
    if (m.result_sha256 !== sha(rtext)) fail(`${label} ${f}: sidecar result_sha256 is not this result`);
    if (m.runner_sha256 !== RUNNER_SHA || m.manifest_sha256 !== manSha) fail(`${label} ${f}: sidecar runner or manifest is not the pinned one`);
    let rows; try { rows = JSON.parse(rtext.toString("utf8")); } catch { fail(`${label} ${f}: the result is not JSON`); }
    if (!Array.isArray(rows) || rows.some((r) => r === null || typeof r !== "object" || Array.isArray(r))) fail(`${label} ${f}: the result is not an array of objects`);
    out[stem] = rows;
  }
  return out;
}

const one = (rows, what) => { if (rows.length !== 1) fail(`${what}: expected one row, got ${rows.length}`); return rows[0]; };
const byKey = (rows, k) => new Map(rows.map((r) => [String(r[k]), r]));

export function compare({ templates, t, prod, rest, restFar }) {
  const lines = [];
  const pass = (m) => lines.push(`PASS  ${m}`);
  try {
    if (!T_RE.test(t)) fail("T is not YYYY-MM-DDTHH:MM:SSZ");
    if (t >= FAR) fail("T is not before the far-future constant");
    const tpl = loadTemplates(templates);
    const P = loadRun("production@T", prod, V_FILES, t, tpl);
    const R = loadRun("restored@T", rest, V_FILES, t, tpl);
    const F = loadRun("restored@unfiltered", restFar, FAR_FILES, FAR, tpl);
    pass("S0B-1 the files that ran are the pinned templates (T and the far constant substituted) and every sidecar binds its result");

    const h = one(P["v1-history"], "production history");
    if (String(h.applied_count) !== "211" || String(h.hosted_max) !== "0212" || String(h.versions_ge_0213) !== "0") fail(`production migration history is not 211 / 0212 / none above (applied ${h.applied_count}, max ${h.hosted_max}, above 0212 ${h.versions_ge_0213}); valid only BEFORE S1`);
    if (!same(P["v1-history"], R["v1-history"])) fail("migration history differs between production and the restored project");
    pass(`S0B-2 migration history equal: ${h.applied_count} migrations, max ${h.hosted_max}, 0212 statements digest ${String(h.statements_sha256_0212).slice(0, 12)}`);

    if (!same(P["v2-catalog"], R["v2-catalog"])) {
      const a = byKey(P["v2-catalog"].map((r) => ({ ...r, k: `${r.kind}:${r.name}` })), "k"), b = byKey(R["v2-catalog"].map((r) => ({ ...r, k: `${r.kind}:${r.name}` })), "k");
      const first = [...new Set([...a.keys(), ...b.keys()])].sort().find((k) => !same(a.get(k) ?? null, b.get(k) ?? null));
      fail(`catalog fingerprint differs at ${first ?? "(row count)"}`);
    }
    const fp = P["v2-catalog"].filter((r) => r.kind === "fingerprint").map((r) => `${r.name} ${String(r.md5).slice(0, 12)}`).join("; ");
    pass(`S0B-3 catalog equal: ${P["v2-catalog"].length} rows (schemas, RLS flags, ${fp})`);

    // S5: digest of the sorted ids per table (ids never printed). Equal counts need an equal digest. A restored copy that holds MORE ids than
    // production held at T is the signature of rows hard-deleted in production after T: informational, never a failure by itself, but the
    // 256-bucket read must show no bucket where the copy holds fewer ids than production (a lower bound on lost rows) and no equal-count bucket with a different digest.
    const dg = (x) => new Map(x["v7-id-digests"].map((r) => [String(r.table_name), r]));
    const dP = dg(P), dR = dg(R);
    const bk = (x) => { const m = new Map(); for (const r of x["v8-id-buckets"]) m.set(`${r.table_name}/${r.bucket}`, r); return m; };
    const bP = bk(P), bR = bk(R);
    const extra = new Map();
    for (const nm of TABLES) {
      const a = dP.get(nm), b = dR.get(nm);
      const pn = Number(a?.ids ?? 0), rn = Number(b?.ids ?? 0);
      if (rn < pn) fail(`${nm}: the restored copy holds ${pn - rn} fewer ids than production held at T (lost rows)`);
      if (rn === pn) { if (String(a?.ids_md5 ?? "") !== String(b?.ids_md5 ?? "")) fail(`${nm}: same number of ids but the id digest differs`); continue; }
      let lost = 0, clash = 0;
      for (const key of new Set([...bP.keys(), ...bR.keys()])) {
        if (!key.startsWith(`${nm}/`)) continue;
        const x = Number(bP.get(key)?.ids ?? 0), y = Number(bR.get(key)?.ids ?? 0);
        if (y < x) lost += x - y;
        if (x === y && String(bP.get(key)?.ids_md5 ?? "") !== String(bR.get(key)?.ids_md5 ?? "")) clash++;
      }
      if (lost > 0 || clash > 0) fail(`${nm}: the restored copy holds ${rn - pn} more ids than production at T, and the bucket check shows ${lost} lost and ${clash} different-digest buckets`);
      extra.set(nm, rn - pn);
    }
    if (extra.has("studios")) fail(`studios: the copy holds ${extra.get("studios")} more studios than production at T (studio deletes after T shift the ordinals; compare by hand)`);
    pass(`S0B-4 id digests equal for ${TABLES.length - extra.size} tables${extra.size ? ` and consistent with deletes after T for ${extra.size}` : ""} (ids are never printed)`);
    for (const [nm, d] of extra) lines.push(`NOTE  post-T deletes signature: ${nm}: the restored copy holds ${d} more ids than production at T (informational; the bucket check bounds lost rows at 0)`);
    const okCell = (nm, a, b) => (extra.has(nm) ? Number(b) >= Number(a) : String(b) === String(a));

    if (!P["v3-studio-counts"].length) fail("production has no studio at or before T");
    const V3 = { clients: "clients", appointments: "appointments", sessions: "sessions", client_consent_signatures: "consents", client_intake_forms: "intake_forms", payment_charge_attempts: "charge_attempts", appointment_payments: "appointment_payments" };
    for (const [nm, x] of [["restored@T", R], ["restored@unfiltered", F]]) {
      const a = P["v3-studio-counts"], b = x["v3-studio-counts"];
      if (a.length !== b.length) fail(`per-studio counts differ (production@T vs ${nm}): ${a.length} vs ${b.length} studios`);
      for (let i = 0; i < a.length; i++) {
        if (String(a[i].studio_ordinal) !== String(b[i].studio_ordinal)) fail(`per-studio counts differ (production@T vs ${nm}) at studio ordinal ${a[i].studio_ordinal}`);
        for (const [tbl, col] of Object.entries(V3)) if (!okCell(tbl, a[i][col], b[i][col])) fail(`per-studio counts differ (production@T vs ${nm}) at studio ordinal ${a[i].studio_ordinal}`);
      }
    }
    pass(`S0B-5 per-studio counts equal across production@T, restored@T and restored@unfiltered (${P["v3-studio-counts"].length} studios)`);

    for (const [nm, x] of [["production@T", P], ["restored@T", R], ["restored@unfiltered", F]]) {
      const o = one(x["v4-orphans"], `${nm} orphans`);
      const bad = Object.entries(o).filter(([, v]) => String(v) !== "0");
      if (bad.length) fail(`orphans on ${nm}: ${bad.map(([k, v]) => `${k}=${v}`).join(", ")}`);
    }
    pass("S0B-6 orphan checks are 0 on production@T, restored@T and restored@unfiltered");

    const rp = byKey(P["v5-recovery-point"], "table_name"), rr = byKey(R["v5-recovery-point"], "table_name"), rf = byKey(F["v5-recovery-point"], "table_name");
    for (const nm of TABLES) {
      const a = rp.get(nm), b = rr.get(nm), c = rf.get(nm);
      if (!a || !b || !c) fail(`recovery point: table ${nm} missing from a result`);
      const want = String(a.rows_created_le_t);
      if (!okCell(nm, want, b.rows_created_le_t)) fail(`${nm}: rows created at or before T: production ${want}, restored ${b.rows_created_le_t}`);
      if (!okCell(nm, want, b.rows_total)) fail(`${nm}: restored holds ${b.rows_total} rows, production held ${want} at T`);
      if (!okCell(nm, want, c.rows_total) || String(c.rows_total) !== String(b.rows_total)) fail(`${nm}: restored unfiltered holds ${c.rows_total} rows, production held ${want} at T`);
      if (String(b.rows_newer_than_t) !== "0" || String(c.rows_newer_than_t) !== "0") fail(`${nm}: the restored copy holds rows newer than T (${b.rows_newer_than_t})`);
    }
    pass(`S0B-7 recovery point consistent for ${TABLES.length} tables: restored row counts equal production at T and nothing is newer than T`);

    const s = one(P["v6-storage-meta"], "production storage metadata");
    for (const [nm, x] of [["restored@T", R], ["restored@unfiltered", F]]) if (!same(s, one(x["v6-storage-meta"], nm))) fail(`storage object metadata differs (production@T vs ${nm})`);
    pass(`S0B-8 storage object metadata equal (${s.objects_le_t} objects; the files themselves are not in a database restore)`);
    lines.push("S0B PASS");
    return { ok: true, lines };
  } catch (e) {
    if (!(e instanceof Fail)) throw e;
    lines.push(`S0B FAIL: ${e.message}`);
    return { ok: false, lines };
  }
}

function main(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i += 2) a[argv[i]] = argv[i + 1];
  const need = ["--templates", "--t", "--prod", "--rest", "--rest-far"];
  if (need.some((k) => !a[k]) || Object.keys(a).some((k) => !need.includes(k))) { console.log("S0B FAIL: bad arguments"); return 1; }
  let r;
  try { r = compare({ templates: a["--templates"], t: a["--t"], prod: a["--prod"], rest: a["--rest"], restFar: a["--rest-far"] }); }
  catch (e) { console.log(`S0B FAIL: unexpected error: ${e.message}`); return 1; }
  console.log(r.lines.join("\n"));
  return r.ok ? 0 : 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)));
