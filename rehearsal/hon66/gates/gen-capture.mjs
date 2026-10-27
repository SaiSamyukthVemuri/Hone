// REHEARSAL - NEVER MERGE. Writes a synthetic pitr-backups.sh result directory (backups.json + backups.meta.json, bound to the REAL pins
// 85407d0b / dce26b75) and prints "EARLIEST LATEST" in UTC. usage: gen-capture.mjs <dir> <latest-offset-seconds> <captured-offset-seconds> [real-layout] [bad-json]
// The real capture also holds backups.err and a cwd/ directory: "real-layout" writes them too.
import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
const [, , dir, lo, co, layout] = process.argv;
const now = Math.floor(Date.now() / 1000);
const latest = now + Number(lo), captured = now + Number(co), earliest = latest - 8 * 86400;
const iso = (s) => new Date(s * 1000).toISOString().replace(/\.\d+Z$/, "Z");
const body = JSON.stringify({ backups: [], physical_backup_data: { earliest_physical_backup_date_unix: earliest, latest_physical_backup_date_unix: latest }, pitr_enabled: true, region: "us-east-1", walg_enabled: true }, null, 2) + "\n";
mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700);
writeFileSync(path.join(dir, "backups.json"), body, { mode: 0o600 });
const meta = { command: "backups list", started_at_utc: iso(captured), captured_at_utc: iso(captured), exit_code: 0, result_sha256: createHash("sha256").update(body).digest("hex"), supabase_go_sha256: "174a90e23b8dfe9ab4e2d2c2e91d4b6b2520fe5be968721555727f16c1bab43c", script_sha256: "cb5995276775565839f61b7c000726e91993fa5f03597726a9a74b48537f7faa" };
writeFileSync(path.join(dir, "backups.meta.json"), JSON.stringify(meta) + "\n", { mode: 0o600 });
if (layout === "real-layout") { writeFileSync(path.join(dir, "backups.err"), "", { mode: 0o600 }); mkdirSync(path.join(dir, "cwd"), { mode: 0o700 }); }
console.log(`${iso(earliest)} ${iso(latest)}`);
