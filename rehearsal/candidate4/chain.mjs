// REHEARSAL - NEVER MERGE. Feeds REAL producer output to the candidate-4 comparator (row 4):
//   node chain.mjs api  <window-reads-c4 dir> <pitr-backups.* dir> <script-sha> <out-dir>
//   node chain.mjs idle <window-reads-c4 dir> <pitr-wal.* dir> <runner-sha> <manifest-sha> <out-dir> [api-dir-to-write]
// Prints the comparator's output and exits with its exit code (or 90 when the 07:45-10:00 UTC blackout overlaps the test window).
// Test baseline = baseline 4 with ONLY test-copy values changed: the pitr-backups script sha (api mode), the runner/manifest sha and the
// shortened interval constants N_FLOOR=15 / N_MARGIN=3 of the test copy of pitr-wal-twice.sh (idle mode). The comparator is the real one.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
const [, , mode, wr, src, ...rest] = process.argv;
const iso = (ms) => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.\d+Z$/, "Z");
const base = JSON.parse(readFileSync(path.join(wr, "BASELINE-W1-MACOS-CANDIDATE-5.json"), "utf8"));
const now = Date.now();
const winStart = iso(now - 3600e3), winEnd = iso(now + 3 * 3600e3);
{ // blackout check, as in test.sh
  for (let d = -1; d <= 1; d++) { const day = new Date(now + d * 86400e3); const y = day.getUTCFullYear(), m = day.getUTCMonth(), dd = day.getUTCDate();
    const bs = Date.UTC(y, m, dd, 7, 45), be = Date.UTC(y, m, dd, 10, 0); if (now - 3600e3 < be && now + 3 * 3600e3 > bs) { console.log("SKIP: the test window overlaps 07:45-10:00 UTC"); process.exit(90); } }
}
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
let out, apiDir, sel, latestIso, idleArgs = [], basis;
if (mode === "api") {
  apiDir = src; basis = "latest_at_or_after";
  const meta = readJson(path.join(apiDir, "backups.meta.json")), body = readJson(path.join(apiDir, "backups.json"));
  base.g4_pitr_api.script_sha256 = rest[0]; out = rest[1];
  const latest = body.physical_backup_data.latest_physical_backup_date_unix * 1000;
  sel = latest - 30e3; latestIso = iso(latest);
} else {
  const [runnerSha, manifestSha, outDir, writeApi] = rest; out = outDir; basis = "idle_proven_latest";
  base.g4_pitr_idle.runner_sha256 = runnerSha; base.g4_pitr_idle.manifest_sha256 = manifestSha;
  base.g4_pitr_idle.min_interval_seconds = 15; base.g4_pitr_idle.interval_margin_seconds = 3;
  const rows = (p) => { const j = readJson(p); return Array.isArray(j) ? j[0] : j.rows ? j.rows[0] : j; };
  const r1 = rows(path.join(src, "r1", "pitr-wal-status.json")), r2 = rows(path.join(src, "r2", "pitr-wal-status.json"));
  const m1 = readJson(path.join(src, "r1", "pitr-wal-status.meta.json"));
  const L = Date.parse(r2.last_archived_utc);
  sel = Date.parse(m1.started_at_utc) - 5e3; latestIso = iso(L);
  apiDir = path.join(out, "api"); mkdirSync(apiDir, { recursive: true });
  const body = JSON.stringify({ backups: [], physical_backup_data: { earliest_physical_backup_date_unix: Math.floor(L / 1000) - 8 * 86400, latest_physical_backup_date_unix: Math.floor(L / 1000) }, pitr_enabled: true, region: "us-east-1", walg_enabled: true }, null, 2) + "\n";
  writeFileSync(path.join(apiDir, "backups.json"), body);
  const t = iso(Math.max(now - 1000, Date.parse(m1.started_at_utc)));
  writeFileSync(path.join(apiDir, "backups.meta.json"), JSON.stringify({ command: "backups list", started_at_utc: t, captured_at_utc: t, exit_code: 0, result_sha256: createHash("sha256").update(body).digest("hex"), supabase_go_sha256: base.g4_pitr_api.supabase_go_sha256, script_sha256: base.g4_pitr_api.script_sha256 }) + "\n");
  idleArgs = ["--pitr-idle", src];
}
mkdirSync(out, { recursive: true });
const earliestIso = iso(Date.parse(latestIso) - 8 * 86400e3);
const att = { g4_pitr: { pitr_enabled: true, retention_days: 7, earliest_recovery_at_utc: earliestIso, latest_recovery_at_utc: latestIso }, pre_migration_restore_point: { selected_at_utc: iso(sel), basis } };
if (mode === "api") { const b = readJson(path.join(apiDir, "backups.json")).physical_backup_data; att.g4_pitr.earliest_recovery_at_utc = iso(b.earliest_physical_backup_date_unix * 1000); }
writeFileSync(path.join(out, "att.json"), JSON.stringify(att)); writeFileSync(path.join(out, "base.json"), JSON.stringify(base));
const r = spawnSync(process.execPath, [path.join(wr, "compare-preflight.mjs"), "--stage", "row4", "--baseline", path.join(out, "base.json"), "--attest", path.join(out, "att.json"), "--window-start", winStart, "--window-end", winEnd, "--pitr-api", apiDir, ...idleArgs], { encoding: "utf8" });
process.stdout.write(r.stdout); process.stderr.write(r.stderr); process.exit(r.status ?? 1);
