// PREFLIGHT COMPARATOR (command). All logic is in compare-preflight-lib.mjs.
//
// This file runs main() UNCONDITIONALLY: there is no "am I the entry point" guard,
// because that guard was false under a symlink or a path with a space and the
// command then printed nothing and exited 0 (Insurance F1).
//
// The exit code starts at 3 and is cleared to 0 only AFTER the exact line
// "OVERALL PASS" has been printed. Silence, a crash, a usage error and a stub
// all read as non-zero. Exit codes: 0 PASS, 1 FAIL (incl. internal error),
// 2 DATA-ONLY (never a go), 3 usage or no verdict printed.
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FILES, DEFAULT_MAX_AGE_MIN, evaluate, evaluateS1, evaluatePitrPoint, format } from "./compare-preflight-lib.mjs";

process.exitCode = 3;

const argv = process.argv.slice(2);
const get = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };
const readText = (p) => { try { return readFileSync(p, "utf8"); } catch { return undefined; } };
const usage = "usage: compare-preflight.mjs --results <dir> --baseline <file> --attest <file> --window-start <UTC> --window-end <UTC> [--max-age-min N] [--manifest <MANIFEST.sha256>] [--pitr-api <dir>] [--pitr-idle <dir>] [--data-only]\n       compare-preflight.mjs --stage row4 --baseline <file> --attest <row-4 file> --window-start <UTC> --window-end <UTC> [--pitr-api <dir>] [--pitr-idle <dir>]\n       compare-preflight.mjs --stage s1 --census <file> --g10 <file> --readback <file> --baseline <file>";

function manifestMap(p) {
  const t = readText(p);
  if (t === undefined) return null;
  const m = {};
  for (const line of t.split("\n")) { const x = /^([0-9a-f]{64}) [ *](.+)$/.exec(line); if (x) m[x[2]] = x[1]; }
  return m;
}

// The captured pitr-backups result (backups.json + sidecar) and the idle evidence (r1, r2 and their .ready counts).
function pitrApiInput(dir) {
  if (!dir) return null;
  const p = path.join(dir, "backups.json"), mp = path.join(dir, "backups.meta.json");
  return { text: existsSync(p) ? readFileSync(p, "utf8") : undefined, meta: existsSync(mp) ? readJson(mp) : undefined };
}
function pitrIdleInput(dir) {
  if (!dir) return null;
  const one = (sub, stem) => {
    if (existsSync(path.join(dir, sub, "UNREADABLE"))) return { unreadable: true, denied: stem === "pitr-wal-status" };
    const p = path.join(dir, sub, `${stem}.json`), mp = path.join(dir, sub, `${stem}.meta.json`);
    return { text: existsSync(p) ? readFileSync(p, "utf8") : undefined, meta: existsSync(mp) ? readJson(mp) : undefined };
  };
  return { r1: one("r1", "pitr-wal-status"), r2: one("r2", "pitr-wal-status"), r1ready: one("r1ready", "pitr-ready-count"), r2ready: one("r2ready", "pitr-ready-count") };
}

function emit(o) {
  const text = format(o);
  console.log(text);
  // Set the code only after the verdict line is out; PASS is the only 0. The line is "OVERALL PASS" or, when a path
  // with a caveat applied (base backup UNVERIFIED, idle path), "OVERALL PASS (<caveat>)": never a bare PASS then.
  const line = o.verdictLine ?? "OVERALL PASS";
  process.exitCode = o.overall === "PASS" && /^OVERALL PASS( \(.+\))?$/.test(line) && text.split("\n").includes(line) ? 0 : o.overall === "DATA-ONLY" ? 2 : 1;
}

try {
  if (get("--stage") === "row4") {
    emit(evaluatePitrPoint({ baseline: get("--baseline") ? readJson(get("--baseline")) : null, attest: get("--attest") ? readJson(get("--attest")) : null, window: { start: get("--window-start"), end: get("--window-end") }, pitrApi: pitrApiInput(get("--pitr-api")), idle: pitrIdleInput(get("--pitr-idle")) }));
  } else if (get("--stage") === "s1") {
    const base = get("--baseline") ? readJson(get("--baseline")) : null;
    emit(evaluateS1({ censusText: readText(get("--census") ?? ""), g10Text: readText(get("--g10") ?? ""), readback: get("--readback") ? readJson(get("--readback")) : null, expected: base && base.s1 }));
  } else {
    const dir = get("--results");
    if (!dir) { console.error(usage); }
    else {
      const maxAgeMin = get("--max-age-min") === undefined ? DEFAULT_MAX_AGE_MIN : Number(get("--max-age-min"));
      const files = {}, metas = {};
      for (const n of FILES) {
        const p = path.join(dir, `${n}.json`), mp = path.join(dir, `${n}.meta.json`);
        files[n] = existsSync(p) ? readFileSync(p, "utf8") : undefined;
        metas[n] = existsSync(mp) ? readJson(mp) : undefined;
      }
      const manifestPath = get("--manifest") ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "MANIFEST.sha256");
      const manifestText = readText(manifestPath);
      emit(evaluate({
        files, metas, manifest: manifestMap(manifestPath),
        manifestFileSha256: manifestText === undefined ? null : createHash("sha256").update(manifestText, "utf8").digest("hex"),
        baseline: get("--baseline") ? readJson(get("--baseline")) : null,
        attest: get("--attest") ? readJson(get("--attest")) : null,
        window: { start: get("--window-start"), end: get("--window-end") },
        maxAgeMin, dataOnly: argv.includes("--data-only"), pitrApi: pitrApiInput(get("--pitr-api")), idle: pitrIdleInput(get("--pitr-idle")),
      }));
    }
  }
} catch (e) {
  console.log(`OVERALL FAIL (internal error: ${e && e.message ? e.message : e})`);
  process.exitCode = 1;
}
