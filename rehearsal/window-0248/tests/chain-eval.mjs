// REHEARSAL - NEVER MERGE. Evaluates the REAL results of the 0248 S0a read set (captured from a fresh CI database) with the variant comparator.
// usage: node chain-eval.mjs <results-dir> <expect: pass|g12-fails>
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const V = path.join(ROOT, "variants/s0a");
const { evaluate, FILES, SEALED_0248_SHA } = await import(pathToFileURL(path.join(V, "compare-preflight-lib.mjs")).href);
const [dir, expect] = process.argv.slice(2);
const sha = (t) => createHash("sha256").update(t).digest("hex");
const manifest = Object.fromEntries(readFileSync(path.join(V, "MANIFEST.sha256"), "utf8").trim().split("\n").map((l) => { const [h, n] = l.split("  "); return [n, h]; }));
const baseline = JSON.parse(readFileSync(path.join(V, "BASELINE-W1-0248.json"), "utf8"));
const HEAD = "d".repeat(40);
baseline.g3.head_sha = HEAD;
const files = {}, metas = {};
const now = Date.now();
for (const n of FILES) {
  files[n] = readFileSync(path.join(dir, `${n}.json`), "utf8");
  metas[n] = { file: `${n}.sql`, sql_sha256: manifest[`${n}.sql`], result_sha256: sha(files[n]), started_at_utc: new Date(now - 60e3).toISOString().slice(0, 19) + "Z",
    captured_at_utc: new Date(now - 30e3).toISOString().slice(0, 19) + "Z", exit_code: 0, runner_sha256: baseline.runner_sha256, manifest_sha256: baseline.manifest_sha256 };
}
const r = evaluate({ files, metas, manifest, manifestFileSha256: baseline.manifest_sha256, baseline, attest: { g3: { head_sha: HEAD, checksums: { "0248": SEALED_0248_SHA } } },
  window: { start: new Date(now - 600e3).toISOString().slice(0, 19) + "Z", end: new Date(now + 3600e3).toISOString().slice(0, 19) + "Z" }, maxAgeMin: 30, now });
const by = Object.fromEntries(r.rows.map((x) => [x.id, x]));
const DATA = ["S0-2", "S0-6c", "S0-7", "S0-W3", "S0-13", "S0-14"];
for (const id of DATA) console.log(`${by[id].status.padEnd(5)} ${id} ${by[id].detail ?? ""}`);
if (expect === "pass") process.exit(DATA.every((id) => by[id].status === "PASS") ? 0 : 1);
if (expect === "g12-fails") process.exit(by["S0-6c"].status === "FAIL" && /unexpected_callable_definers/.test(by["S0-6c"].detail) && DATA.filter((id) => id !== "S0-6c").every((id) => by[id].status === "PASS") ? 0 : 1);
process.exit(2);
