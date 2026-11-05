// PREFLIGHT COMPARATOR LIBRARY for the S0a window reads (rollout 0213-0246).
// The command is compare-preflight.mjs, which runs main() unconditionally.
//
//   node compare-preflight.mjs --results <dir> --baseline <baseline.json> --attest <attest.json> \
//        --window-start <UTC> --window-end <UTC> [--max-age-min N] [--manifest <MANIFEST.sha256>]
//
// READS ONLY the 13 result files (and their capture sidecars) that
// run-window-read.sh produces with HONE_WINDOW_RESULT_DIR set, named
// <basename>.json and <basename>.meta.json inside --results, the manifest, plus
// the two small operator files named above. It makes no database call, no network call, and
// never reads any other path. It does not know where OPS keeps old results and
// must never be pointed at them.
//
// Overall PASS only if EVERY required check is present, readable and PASS. Any
// FAIL, unreadable or missing file, missing input, or unknown required check is
// FAIL, which STOPS the cutover. Exit code 0 only for PASS.
//
// What the data can prove (package 1035-ROLLOUT-PACKAGE-FINAL.md section 4, S0):
//   stops 2 3 4 5 6 7 and the file-level part of 13 come from the result files;
//   stops 1 8 9 10 11 12 are facts about people and process, so they are read
//   from the operator attestation file and are REQUIRED. A comparator that
//   skipped them would print PASS for an unprepared window.
//
// --data-only evaluates the data checks and prints DATA-ONLY, never PASS, and
// exits 2: it is for rehearsal, not for the go/no-go.

import { createHash } from "node:crypto";

const sha256 = (text) => createHash("sha256").update(typeof text === "string" ? Buffer.from(text, "utf8") : text).digest("hex");

export const FILES = [
  "g02-history", "g06-payment-drain", "g07-sms-claimed-number-duplicates",
  "g09a-0214-reach-summary", "g09b-0214-reach-per-studio", "g09c-0214-bound-account-mode",
  "g10-constraint-names", "g11-0244-legacy-laser-types", "g11b-0244-legacy-laser-classes",
  "g12-0243-intake-definers", "census-0213-0246", "s1-open-transactions", "w03-table-sizes",
];

export const G2 = { applied_count: 211, hosted_max: "0212", versions_ge_0213: 0, rows_0211: 1, rows_0212: 1,
  name_0212: "email_delivery_events", statements_0212: 73,
  statements_sha256_0212: "bc13731bb8c36b8a1db2f5a5185d0700308e598e92347a3ab87df696814ef142", last4: "0212,0211,0210,0209" };

// Check ids. DATA checks come from the result files; ATTEST checks from the attestation file.
export const CHECKS = [
  ["S0-1", "G1 project-ref is canonical production and an operator is named", "attest"],
  ["S0-2", "G2 hosted history is exactly 211 / max 0212 / none >= 0213 / 0212 hash", "data"],
  ["S0-3", "W-2 census: 34 rows 0213..0246, present_now = 0 on all; G10 = 7", "data"],
  ["S0-4a", "G6 drain: every d1-d4 column is 0", "data"],
  ["S0-4b", "G7: no duplicated live claimed SMS numbers", "data"],
  ["S0-5", "G9 equals the recorded W-1 baseline (summary, per studio, account mode)", "data"],
  ["S0-6a", "G11 under the rule in force", "data"],
  ["S0-6b", "g11b reconciles", "data"],
  ["S0-6c", "G12: no callable intake definer", "data"],
  ["S0-7", "No transaction older than 60 s (s1-open-transactions)", "data"],
  ["S0-14", "Results belong to THIS window: sidecar present, hashes bind, captured inside the window and not older than N minutes", "data"],
  ["S0-W3", "W3: none of the ten tables over 512 MiB; statement_timeout and lock_timeout reported", "data"],
  ["S0-8", "Window outside 07:45-10:00 UTC and holds in place", "attest"],
  ["S0-9", "G3 met at the exact head", "attest"],
  ["S0-10", "G4 recorded and R-6 answered", "attest"],
  ["S0-11", "0242 disposition recorded (bridge READY or R-3)", "attest"],
  ["S0-12", "No permission refusal recorded (DENIAL files empty)", "attest"],
  ["S0-13", "All 13 files present and readable, none refused or errored, all at hosted 0212", "data"],
].map(([id, label, source]) => ({ id, label, source }));

export const W3_TABLES = ["appointments", "appointment_audit", "email_outbound_messages", "payment_charge_attempts", "appointment_settlements", "studio_payment_settings", "clients", "client_intake_forms", "treatment_images", "client_payment_methods"];
export const W3_LIMIT_BYTES = 512 * 1024 * 1024;

export const EXPECTED_STUDIOS = 8; // literal: the W-1 baseline is the 8-studio one (package 1035-ROLLOUT-PACKAGE-FINAL.md 5.1)
export const S1_TABLES = ["appointment_audit", "appointment_settlements", "appointments", "client_intake_forms", "clients", "email_outbound_messages", "payment_charge_attempts", "practitioners", "sessions", "sms_outbound_messages"];
export const BLACKOUT_UTC = { start: [7, 45], end: [10, 0] };
export const DEFAULT_MAX_AGE_MIN = 30;
export const PINNED_0214_SHA = "a8bdcefe7b01216e986838fe336a9eb3613b6e892bd8de2c101cdd4e2f03751b"; // the amended 0214 named in PACKAGE-P2-ADDENDUM.md; the other 33 come from the baseline
export const SUPERSEDED_0214_SHA = "8ff9350eb53070c970b9548e4e4093e2aa878116fd7ad9dc118bfb3d401a3289"; // the unamended file; must never be applied (PACKAGE-P2-ADDENDUM.md)
export const CHECKSUM_VERSIONS = Array.from({ length: 34 }, (_, i) => String(213 + i).padStart(4, "0"));
// S1 closures pinned here, not copied from the operator's expectation (PACKAGE-P2-ADDENDUM.md section 2,
// package section 4 S1). A pin names only the keys it fixes.
export const PINNED_CLOSURES = [
  { fn: "initialize_studio_payment_jurisdiction_from_history", anon: false, authenticated: false, service_role: true, required_in_expected: true },
  { fn: "studio_account_acceptable_for_jurisdiction", anon: false, authenticated: false, service_role: false, required_in_expected: true },
  { fn: "studio_named_stripe_accounts", anon: false, authenticated: false, service_role: false, required_in_expected: true },
  { fn: "reconcile_card_payment_succeeded", service_role: false },
  { fn: "save_client_card_on_file", service_role: false },
];
export const PINNED_TABLE_PRIVILEGES = [
  { table: "audit_logs", role: "authenticated", privilege: "insert", held: false },
  { table: "audit_logs", role: "service_role", privilege: "insert", held: true },
];

const KNOWN = new Set(CHECKS.map((c) => c.id));

const pass = (detail = "") => ({ status: "PASS", detail });
const fail = (detail) => ({ status: "FAIL", detail });

function numEq(v, n) { return typeof v === "number" ? v === n : typeof v === "string" && /^-?\d+$/.test(v) && Number(v) === n; }
function isTrue(v) { return v === true || v === "true" || v === "t"; }
function isFalse(v) { return v === false || v === "false" || v === "f"; }
function int(v) { return typeof v === "number" && Number.isInteger(v) ? v : typeof v === "string" && /^-?\d+$/.test(v) ? Number(v) : NaN; }

// A result file is either a bare array of rows or { rows: [...] }. Anything else,
// including an error object, is unreadable and therefore a failure.
export function readRows(text) {
  let j;
  try { j = JSON.parse(text); } catch { return { error: "not valid JSON" }; }
  const rows = Array.isArray(j) ? j : j && typeof j === "object" && Array.isArray(j.rows) ? j.rows : null;
  if (!rows) return { error: "not an array of rows (error output or unknown shape)" };
  if (rows.some((r) => !r || typeof r !== "object" || Array.isArray(r))) return { error: "a row is not an object" };
  if (j && !Array.isArray(j) && (j.error || j.message) && rows.length === 0) return { error: "error payload with no rows" };
  return { rows };
}

// ---------------------------------------------------------------------------
// G4 under PITR. baseline.recovery_regime is "daily" (the default when absent: the
// original S0-10, unchanged) or "pitr". Under "pitr" the daily g4 fields are REJECTED
// (a recovery point can never be written into backup_id / status / backup_completed_at_utc)
// and a separate g4_pitr attestation is required. Every field must be present with its own
// type; none has a default and none is inferred from another (the base backup is never
// derived from the recovery range, the retention never from an add-on name).
// The selected pre-migration restore point is recorded at row 4, AFTER S0a, so S0-10 at S0a
// checks the PITR reading against the read time and REJECTS a pre_migration_restore_point;
// evaluatePitrPoint (command: --stage row4) checks the point against a fresh reading.
export const RECOVERY_REGIMES = ["daily", "pitr"];
export const G4_PITR_THRESHOLDS = { min_retention_days: 1, earliest_margin_minutes: 0, max_latest_lag_minutes: 1, max_read_age_minutes: 1, max_pre_point_age_minutes: 1 };
export const G4_PITR_KEYS = ["pitr_enabled", "retention_days", "earliest_recovery_at_utc", "latest_recovery_at_utc", "latest_base_backup_status", "latest_base_backup_completed_at_utc", "base_backup_source", "read_at_utc", "read_source"];
export const PITR_POINT_KEYS = ["selected_at_utc", "basis", "restore_point_name", "restore_point_status", "restore_point_completed_at_utc"];
const PITR_SOURCES = ["dashboard", "management_api"];
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const isoMs = (v) => { if (typeof v !== "string" || !ISO_UTC.test(v)) return NaN; const t = Date.parse(v); return Number.isFinite(t) && new Date(t).toISOString().slice(0, 19) + "Z" === v ? t : NaN; }; // the round trip rejects 2026-02-30, which Date.parse rolls over to 2 March
const plain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const nonEmpty = (v) => typeof v === "string" && v.trim().length > 0;

export function recoveryRegime(baseline) {
  if (!baseline || typeof baseline !== "object") return "daily";
  return baseline.recovery_regime === undefined ? "daily" : baseline.recovery_regime;
}

function pitrThresholds(baseline) {
  const t = baseline && baseline.g4_pitr;
  if (!plain(t)) return { error: "baseline.g4_pitr is missing (required under recovery_regime pitr)" };
  for (const [k, min] of Object.entries(G4_PITR_THRESHOLDS)) {
    if (typeof t[k] !== "number" || !Number.isInteger(t[k]) || t[k] < min) return { error: `baseline.g4_pitr.${k} must be an integer >= ${min}` };
  }
  return { th: t };
}

// g: the g4_pitr attestation. anchorMs: the instant the recovery window must reach back past
// (the read time at S0a; the selected restore point at row 4). selectedMs: only at row 4.
function pitrReadingListed(g, { th, now, anchorMs = null, selectedMs = null, lagWaived = false, coverWaived = false }) {
  if (!plain(g)) return fail("g4_pitr is missing or not an object");
  for (const k of Object.keys(g)) if (!G4_PITR_KEYS.includes(k)) return fail(`g4_pitr.${k} is not an allowed field (a recovery point is never a daily g4 field)`);
  for (const k of G4_PITR_KEYS) if (g[k] === undefined || g[k] === null || g[k] === "") return fail(`g4_pitr.${k} is missing`);
  if (g.pitr_enabled !== true) return fail("g4_pitr.pitr_enabled must be the boolean true");
  if (typeof g.retention_days !== "number" || !Number.isInteger(g.retention_days)) return fail("g4_pitr.retention_days must be an integer");
  if (g.retention_days < th.min_retention_days) return fail(`g4_pitr.retention_days ${g.retention_days} is below the minimum ${th.min_retention_days}`);
  const t = {};
  for (const k of ["earliest_recovery_at_utc", "latest_recovery_at_utc", "latest_base_backup_completed_at_utc", "read_at_utc"]) {
    t[k] = isoMs(g[k]);
    if (!Number.isFinite(t[k])) return fail(`g4_pitr.${k} is not a UTC time (YYYY-MM-DDTHH:MM:SSZ)`);
  }
  if (g.latest_base_backup_status !== "COMPLETED") return fail("g4_pitr.latest_base_backup_status must be COMPLETED");
  for (const k of ["base_backup_source", "read_source"]) if (!PITR_SOURCES.includes(g[k])) return fail(`g4_pitr.${k} must be dashboard or management_api`);
  if (t.read_at_utc > now) return fail("g4_pitr.read_at_utc is in the future");
  if (now - t.read_at_utc > th.max_read_age_minutes * 60e3) return fail(`g4_pitr.read_at_utc is older than ${th.max_read_age_minutes} min: the recovery range moves, read it again`);
  if (t.latest_recovery_at_utc < t.earliest_recovery_at_utc) return fail("g4_pitr.latest_recovery_at_utc is before earliest_recovery_at_utc");
  if (t.latest_recovery_at_utc > t.read_at_utc) return fail("g4_pitr.latest_recovery_at_utc is after read_at_utc");
  if (!lagWaived && t.read_at_utc - t.latest_recovery_at_utc > th.max_latest_lag_minutes * 60e3) return { ...fail(`g4_pitr.latest_recovery_at_utc lags the reading by more than ${th.max_latest_lag_minutes} min`), lagFail: true };
  if (t.latest_base_backup_completed_at_utc > t.read_at_utc) return fail("g4_pitr.latest_base_backup_completed_at_utc is after read_at_utc");
  // C4: base <= latest is an observation, not a gate (PEER-PITR-BACKUPS M1): the provider horizon is archive-driven, a base backup is not.
  const obs = t.latest_base_backup_completed_at_utc > t.latest_recovery_at_utc ? "; observation: the base backup completed after the latest recovery point" : "";
  const anchor = anchorMs === null ? t.read_at_utc : anchorMs;
  if (t.earliest_recovery_at_utc > anchor - th.earliest_margin_minutes * 60e3) return fail(`g4_pitr.earliest_recovery_at_utc does not reach back ${th.earliest_margin_minutes} min before ${anchorMs === null ? "the reading" : "the selected restore point"}`);
  if (selectedMs !== null) {
    if (t.read_at_utc < selectedMs) return fail("g4_pitr.read_at_utc is earlier than the selected restore point (read the range AFTER selecting it)");
    if (!coverWaived && t.latest_recovery_at_utc < selectedMs) return fail("g4_pitr.latest_recovery_at_utc is before the selected restore point (no recovery point covers it yet)");
  }
  return pass(`PITR on, ${g.retention_days} d retention, base backup COMPLETED${obs}`);
}

// ---------------------------------------------------------------------------
// CANDIDATE 4. Under PITR the Management API lists NO base backups (Insurance S0-10-UNDER-PITR), so the two base-backup
// fields have no honest source. baseline.g4_pitr_base.mode says which world applies:
//   "unavailable_under_pitr": the provider range is read by the COMPARATOR from the captured pitr-backups result
//       (--pitr-api <dir>); the dashboard values typed by the operator are only cross-checked; typed base-backup values are
//       REJECTED; r6 must carry base_backup_unverified_ack; the verdict line says UNVERIFIED and never a bare OVERALL PASS.
//   "listed": candidate 3's fields and rules, with base <= latest demoted to an observation.
// The lag rule may instead be met by the IDLE PROOF (Insurance PITR-IDLE-RULE, A0..A8, B): two script-produced WAL status
// reads (--pitr-idle <dir>), evaluated here; no typed idle assertion is ever accepted.
// ---------------------------------------------------------------------------
export const PITR_BASE_MODES = ["unavailable_under_pitr", "listed"];
export const UNVERIFIED_LABEL = "provider range; base backup UNVERIFIED; restore not tested";
export const IDLE_S0_LABEL = "idle path";
export const IDLE_ROW4_LABEL = "idle path, restore target L";
export const verdictLineOf = (quals) => (quals.length ? `OVERALL PASS (${quals.join("; ")})` : "OVERALL PASS");
const BASE_KEYS = ["latest_base_backup_status", "latest_base_backup_completed_at_utc", "base_backup_source"];
const UNAVAILABLE_KEYS = ["pitr_enabled", "retention_days", "earliest_recovery_at_utc", "latest_recovery_at_utc"];
const UNIX_MIN = 1577836800, UNIX_MAX = 4102444800; // 2020-01-01 and 2100-01-01 in Unix seconds: milliseconds or garbage fall outside
const hex64 = (v) => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
const posInt = (v, min = 1) => typeof v === "number" && Number.isInteger(v) && v >= min;
const utcText = (ms) => new Date(ms).toISOString().slice(0, 19) + "Z";

export function pitrBaseMode(baseline) {
  const m = baseline && plain(baseline.g4_pitr_base) ? baseline.g4_pitr_base.mode : undefined;
  return PITR_BASE_MODES.includes(m) ? { mode: m } : { error: `baseline.g4_pitr_base.mode must be one of ${PITR_BASE_MODES.join(", ")}` };
}

function pitrApiConfig(baseline) {
  const c = baseline && baseline.g4_pitr_api;
  if (!plain(c)) return fail("baseline.g4_pitr_api is missing");
  if (!hex64(c.script_sha256) || !hex64(c.supabase_go_sha256)) return fail("baseline.g4_pitr_api.script_sha256 and supabase_go_sha256 must be 64 hex");
  if (!posInt(c.max_capture_age_minutes) || !posInt(c.dashboard_tolerance_seconds, 0)) return fail("baseline.g4_pitr_api.max_capture_age_minutes and dashboard_tolerance_seconds must be integers");
  return { ...pass(), cfg: c };
}

// The captured pitr-backups result: backups.json + its one-line sidecar. api = { text, meta }.
function apiRead(api, { cfg, th, now }) {
  if (!api || typeof api.text !== "string" || !plain(api.meta)) return fail("the pitr-backups result (backups.json and backups.meta.json) is missing: pass --pitr-api <dir>");
  const m = api.meta;
  if (Object.keys(m).sort().join(",") !== "captured_at_utc,command,exit_code,result_sha256,script_sha256,started_at_utc,supabase_go_sha256") return fail("the pitr-api sidecar does not have exactly the keys pitr-backups.sh writes");
  if (m.command !== "backups list") return fail("the pitr-api sidecar command is not: backups list");
  if (m.exit_code !== 0) return fail(`the pitr-api capture exit code is ${m.exit_code}, not 0`);
  if (m.result_sha256 !== sha256(api.text)) return fail("backups.json changed after capture (its sha256 is not the sidecar's)");
  if (m.script_sha256 !== cfg.script_sha256) return fail("backups.json was captured by a different script than the pinned pitr-backups.sh");
  if (m.supabase_go_sha256 !== cfg.supabase_go_sha256) return fail("backups.json was captured by a different supabase-go than the pinned one");
  const st = isoMs(m.started_at_utc), cp = isoMs(m.captured_at_utc);
  if (!Number.isFinite(st) || !Number.isFinite(cp) || cp < st) return fail("the pitr-api capture times are unreadable");
  if (cp > now) return fail("the pitr-api capture time is in the future");
  if (now - cp > cfg.max_capture_age_minutes * 60e3) return fail(`the pitr-api capture is older than ${cfg.max_capture_age_minutes} min: capture it again`);
  let j;
  try { j = JSON.parse(api.text); } catch { return fail("backups.json is not valid JSON"); }
  if (!plain(j)) return fail("backups.json is not a JSON object");
  if (j.pitr_enabled !== true) return fail("the API does not say pitr_enabled is the boolean true");
  if (j.walg_enabled !== true) return fail("the API does not say walg_enabled is the boolean true");
  const pb = j.physical_backup_data;
  if (!plain(pb)) return fail("physical_backup_data is missing");
  const e = pb.earliest_physical_backup_date_unix, l = pb.latest_physical_backup_date_unix;
  for (const [n, v] of [["earliest", e], ["latest", l]]) if (typeof v !== "number" || !Number.isInteger(v) || v < UNIX_MIN || v >= UNIX_MAX) return fail(`the API ${n} recovery point is not whole Unix seconds between 2020 and 2100 (milliseconds, a string or a fraction?)`);
  if (!(e < l)) return fail("the API earliest recovery point is not before the latest");
  if (l * 1000 > cp) return fail("the API latest recovery point is after the capture time (in the future)");
  if (l - e < th.min_retention_days * 86400) return fail(`the API range spans less than ${th.min_retention_days} days`);
  if (!Array.isArray(j.backups)) return fail("backups is missing or not an array");
  if (j.backups.some((b) => !plain(b))) return fail("a backups entry is not an object");
  return { ...pass(`API range ${utcText(e * 1000)}..${utcText(l * 1000)}, captured ${m.captured_at_utc}`), data: { earliestMs: e * 1000, latestMs: l * 1000, startMs: st, readMs: cp, completedPhysical: j.backups.filter((b) => b.is_physical_backup === true && b.status === "COMPLETED").length } };
}

// mode unavailable_under_pitr: the range comes from the API; the typed dashboard values are cross-checked only.
function pitrReadingUnavailable(g, { th, now, cfg, api, anchorMs = null, selectedMs = null, lagWaived = false, coverWaived = false }) {
  if (!plain(g)) return fail("g4_pitr is missing or not an object");
  for (const k of Object.keys(g)) {
    if (BASE_KEYS.includes(k)) return fail(`g4_pitr.${k}: this mode has no base-backup evidence; do not enter a value`);
    if (!UNAVAILABLE_KEYS.includes(k)) return fail(`g4_pitr.${k} is not an allowed field in mode unavailable_under_pitr`);
  }
  for (const k of UNAVAILABLE_KEYS) if (g[k] === undefined || g[k] === null || g[k] === "") return fail(`g4_pitr.${k} is missing`);
  if (g.pitr_enabled !== true) return fail("g4_pitr.pitr_enabled must be the boolean true");
  if (typeof g.retention_days !== "number" || !Number.isInteger(g.retention_days)) return fail("g4_pitr.retention_days must be an integer");
  if (g.retention_days < th.min_retention_days) return fail(`g4_pitr.retention_days ${g.retention_days} is below the minimum ${th.min_retention_days}`);
  const ar = apiRead(api, { cfg, th, now });
  if (ar.status !== "PASS") return ar;
  const d = ar.data;
  if (d.completedPhysical > 0) return fail("the API now lists base backups: use mode listed");
  const te = isoMs(g.earliest_recovery_at_utc), tl = isoMs(g.latest_recovery_at_utc);
  if (!Number.isFinite(te) || !Number.isFinite(tl)) return fail("g4_pitr earliest/latest recovery point is not a UTC time (YYYY-MM-DDTHH:MM:SSZ)");
  const tol = cfg.dashboard_tolerance_seconds * 1000;
  if (Math.abs(te - d.earliestMs) > tol) return fail(`the dashboard earliest recovery point differs from the API by more than ${cfg.dashboard_tolerance_seconds} s`);
  if (Math.abs(tl - d.latestMs) > tol) return fail(`the dashboard latest recovery point differs from the API by more than ${cfg.dashboard_tolerance_seconds} s`);
  if (!lagWaived && d.readMs - d.latestMs > th.max_latest_lag_minutes * 60e3) return { ...fail(`the API latest recovery point lags the capture by more than ${th.max_latest_lag_minutes} min`), lagFail: true };
  const anchor = anchorMs === null ? d.readMs : anchorMs;
  if (d.earliestMs > anchor - th.earliest_margin_minutes * 60e3) return fail(`the API earliest recovery point does not reach back ${th.earliest_margin_minutes} min before ${anchorMs === null ? "the capture" : "the selected restore point"}`);
  if (selectedMs !== null) {
    if (d.startMs < selectedMs) return fail("the pitr-api capture started before the selected restore point (capture it AFTER selecting)");
    if (!coverWaived && d.latestMs < selectedMs) return fail("the API latest recovery point is before the selected restore point (no recovery point covers it yet)");
  }
  return { ...pass(`PITR on (API), ${g.retention_days} d retention, range ${utcText(d.earliestMs)}..${utcText(d.latestMs)}, base backup UNVERIFIED`), data: d };
}

function pitrReading(g, ctx) { return ctx.mode === "unavailable_under_pitr" ? pitrReadingUnavailable(g, ctx) : pitrReadingListed(g, ctx); }

// ---- the idle proof: A0..A8 and the rule-B triggers over two WAL status reads ----
const IDLE_INT_KEYS = ["min_interval_seconds", "interval_margin_seconds", "max_timeout_seconds", "max_interval_seconds", "max_clock_skew_seconds", "horizon_after_archive_seconds", "horizon_before_archive_extra_seconds", "max_start_to_s1_seconds"];
const IDLE_REQUIRED = ["db_now_utc", "postmaster_start_utc", "in_recovery", "lsn_write", "lsn_insert", "lsn_flush", "cur_wal_file", "cur_wal_offset", "archived_count", "last_archived_wal", "last_archived_utc", "failed_count", "archiver_stats_reset_utc", "archive_mode", "archive_timeout_s", "wal_level", "checkpoint_timeout", "wal_segment_size", "wal_segment_size_bytes", "next_xid"];
const parseWal = (s) => { const m = typeof s === "string" ? /^([0-9A-F]{8})([0-9A-F]{8})([0-9A-F]{8})$/.exec(s) : null; return m ? { tli: m[1], log: parseInt(m[2], 16), seg: parseInt(m[3], 16) } : null; };
const isWalLabel = (s) => typeof s === "string" && (/^[0-9A-F]{24}\.[0-9A-F]{8}\.backup$/.test(s) || /^[0-9A-F]{8}\.history$/.test(s));

function idleConfig(baseline) {
  const c = baseline && baseline.g4_pitr_idle;
  if (!plain(c) || c.enabled !== true) return fail("baseline.g4_pitr_idle is missing or not enabled: the idle path is closed");
  for (const k of IDLE_INT_KEYS) if (!posInt(c[k])) return fail(`baseline.g4_pitr_idle.${k} must be a positive integer`);
  for (const k of ["runner_sha256", "manifest_sha256", "wal_status_sql_sha256", "ready_count_sql_sha256"]) if (!hex64(c[k])) return fail(`baseline.g4_pitr_idle.${k} must be 64 hex`);
  return { ...pass(), cfg: c };
}

function idleOne(x, { cfg, file, sqlSha, name }) {
  if (x && x.denied) return fail(`${name}: a permission refusal was recorded: the idle path is closed`);
  if (!x || typeof x.text !== "string" || !plain(x.meta)) return fail(`${name}: result or sidecar missing`);
  const m = x.meta;
  if (m.file !== file) return fail(`${name}: the sidecar names ${m.file}, not ${file}`);
  if (m.sql_sha256 !== sqlSha) return fail(`${name}: captured through a different SQL file than the pinned ${file}`);
  if (m.result_sha256 !== sha256(x.text)) return fail(`${name}: the result changed after capture`);
  if (m.exit_code !== 0) return fail(`${name}: runner exit ${m.exit_code}`);
  if (m.runner_sha256 !== cfg.runner_sha256) return fail(`${name}: captured by a different runner`);
  if (m.manifest_sha256 !== cfg.manifest_sha256) return fail(`${name}: captured under a different manifest`);
  const st = isoMs(m.started_at_utc), cp = isoMs(m.captured_at_utc);
  if (!Number.isFinite(st) || !Number.isFinite(cp) || cp < st) return fail(`${name}: capture times unreadable`);
  const rr = readRows(x.text);
  if (rr.error || rr.rows.length !== 1) return fail(`${name}: the result is not exactly one row`);
  return { ...pass(), data: { row: rr.rows[0], st, cp } };
}

// The .ready count: null when not readable (allowed except for a label), a number when readable, or a FAIL.
function idleReady(x, { cfg, name }) {
  if (!x || x.unreadable) return { count: null };
  const o = idleOne(x, { cfg, file: "pitr-ready-count.sql", sqlSha: cfg.ready_count_sql_sha256, name });
  if (o.status !== "PASS") return { bad: o };
  const c = int(o.data.row.ready_count);
  return Number.isInteger(c) && c >= 0 ? { count: c } : { bad: fail(`${name}: ready_count is not a whole number`) };
}

// The idle proof is anchored on L, the provider latest recovery point, from the API. The dashboard value the operator typed
// must agree with it (rule B: a dashboard/API disagreement closes the idle path), in every mode.
function idleWithHorizon(idle, { baseline, g, ar, cfg, th, now, stage, selectedMs = null }) {
  const typed = isoMs(g.latest_recovery_at_utc); // already validated by the reading that precedes this call
  if (Math.abs(typed - ar.data.latestMs) > cfg.dashboard_tolerance_seconds * 1000) return fail(`the dashboard latest recovery point differs from the API by more than ${cfg.dashboard_tolerance_seconds} s: the idle path is closed`);
  return idleProof(idle, { baseline, L: ar.data.latestMs, th, now, stage, selectedMs });
}

// L: the provider latest recovery point in ms (from the API). stage "s0a" | "row4". Returns PASS (+ data.validUntilMs) or FAIL.
function idleProof(idle, { baseline, L, th, now, stage, selectedMs = null }) {
  const c = idleConfig(baseline);
  if (c.status !== "PASS") return c;
  const cfg = c.cfg;
  if (!plain(idle)) return fail("no idle evidence was given (--pitr-idle <dir> with the r1 and r2 reads)");
  const o1 = idleOne(idle.r1, { cfg, file: "pitr-wal-status.sql", sqlSha: cfg.wal_status_sql_sha256, name: "r1" });
  if (o1.status !== "PASS") return o1;
  const o2 = idleOne(idle.r2, { cfg, file: "pitr-wal-status.sql", sqlSha: cfg.wal_status_sql_sha256, name: "r2" });
  if (o2.status !== "PASS") return o2;
  const R1 = o1.data.row, R2 = o2.data.row;
  // A0: complete, typed, consistent
  for (const [n, R] of [["r1", R1], ["r2", R2]]) for (const k of IDLE_REQUIRED) if (R[k] === undefined || R[k] === null || R[k] === "") return fail(`${n}.${k} is missing or NULL: the idle path is closed`);
  if (!isFalse(R1.in_recovery) || !isFalse(R2.in_recovery)) return fail("the server is in recovery (pg_is_in_recovery is not false)");
  if (R1.postmaster_start_utc !== R2.postmaster_start_utc) return fail("the server restarted between the reads (postmaster start time changed)");
  if (R1.archiver_stats_reset_utc !== R2.archiver_stats_reset_utc) return fail("pg_stat_archiver was reset between the reads");
  const t1 = isoMs(R1.db_now_utc), t2 = isoMs(R2.db_now_utc);
  if (!Number.isFinite(t1) || !Number.isFinite(t2)) return fail("db_now_utc is not a UTC time");
  const skew = cfg.max_clock_skew_seconds * 1000;
  for (const [n, o, t] of [["r1", o1, t1], ["r2", o2, t2]]) if (t < o.data.st - skew || t > o.data.cp + skew) return fail(`${n}: the database clock and the Mac clock differ by more than ${cfg.max_clock_skew_seconds} s`);
  if (o2.data.st < o1.data.cp) return fail("r2 started before r1 was captured");
  // A1: archiving configured
  if (!["on", "always"].includes(R1.archive_mode) || R1.archive_mode !== R2.archive_mode) return fail("archive_mode is not on or always (or changed)");
  const T = int(R1.archive_timeout_s);
  if (!Number.isInteger(T) || T !== int(R2.archive_timeout_s)) return fail("archive_timeout_s is not a whole number of seconds (or changed)");
  if (T <= 0) return fail("archive_timeout is 0: no forced switch exists, the idle path is impossible");
  if (T > cfg.max_timeout_seconds) return fail(`archive_timeout ${T} s is above ${cfg.max_timeout_seconds} s: the idle path is closed`);
  if (!["replica", "logical"].includes(R1.wal_level) || R1.wal_level !== R2.wal_level) return fail("wal_level is not replica or logical (or changed)");
  // N and the interval
  const N = Math.max(cfg.min_interval_seconds, T + cfg.interval_margin_seconds);
  const gap = (t2 - t1) / 1000;
  if (gap < N) return fail(`the reads are ${gap} s apart; at least N=${N} s (max(${cfg.min_interval_seconds}, T+${cfg.interval_margin_seconds})) are required`);
  if (gap > cfg.max_interval_seconds) return fail(`the reads are ${gap} s apart; more than ${cfg.max_interval_seconds} s is stale`);
  // A2: the archiver is healthy
  const ac1 = int(R1.archived_count), ac2 = int(R2.archived_count), fc1 = int(R1.failed_count), fc2 = int(R2.failed_count);
  if (![ac1, ac2, fc1, fc2].every(Number.isInteger)) return fail("archived_count / failed_count are not whole numbers");
  if (ac2 < 1) return fail("archived_count is 0: nothing was ever archived");
  if (fc1 !== fc2) return fail("failed_count rose between the reads: the archiver is failing now");
  const lastArch = isoMs(R2.last_archived_utc);
  if (!Number.isFinite(lastArch)) return fail("last_archived_utc is not a UTC time");
  const lastFail = R2.last_failed_utc === null || R2.last_failed_utc === undefined ? null : isoMs(R2.last_failed_utc);
  if (lastFail !== null && !(lastFail < lastArch)) return fail("the last archive failure is not earlier than the last success");
  // A4: nothing moved
  for (const R of [R1, R2]) if (R.lsn_write !== R.lsn_insert || R.lsn_write !== R.lsn_flush) return fail("the write, insert and flush WAL positions are not equal: WAL is in flight");
  if (R1.lsn_write !== R2.lsn_write) return fail(ac1 === ac2 ? "the WAL position moved between the reads and nothing was archived: writes with a stalled archiver" : "the WAL position moved between the reads: not idle");
  if (ac1 !== ac2 || R1.last_archived_wal !== R2.last_archived_wal) return fail("a WAL segment was archived between the reads: not idle");
  if (R1.next_xid !== R2.next_xid) return fail("a writing transaction started between the reads (next_xid moved)");
  // A3: no backlog
  const segBytes = int(R1.wal_segment_size_bytes);
  if (!Number.isInteger(segBytes) || segBytes <= 0 || segBytes !== int(R2.wal_segment_size_bytes) || 2 ** 32 % segBytes !== 0) return fail("wal_segment_size_bytes is not a power of two dividing 4 GiB (or changed)");
  const perLog = 2 ** 32 / segBytes;
  const r1r = idleReady(idle.r1ready, { cfg, name: "r1 ready count" }), r2r = idleReady(idle.r2ready, { cfg, name: "r2 ready count" });
  if (r1r.bad) return r1r.bad;
  if (r2r.bad) return r2r.bad;
  if ((r1r.count !== null && r1r.count > 0) || (r2r.count !== null && r2r.count > 0)) return fail("archive_status holds .ready files: completed WAL segments are waiting to be archived");
  const lw = R2.last_archived_wal;
  if (isWalLabel(lw)) {
    if (r1r.count !== 0 || r2r.count !== 0) return fail("the last archived file is a backup or history label and the .ready count is not readable as 0 in both reads: the idle path is closed");
  } else {
    const S = parseWal(lw);
    if (!S) return fail("last_archived_wal is neither a segment name nor a backup/history label");
    const nxt = S.seg + 1 === perLog ? { log: S.log + 1, seg: 0 } : { log: S.log, seg: S.seg + 1 };
    for (const [n, R] of [["r1", R1], ["r2", R2]]) {
      const cur = parseWal(R.cur_wal_file);
      if (!cur) return fail(`${n}: cur_wal_file is not a WAL segment name`);
      if (cur.tli !== S.tli) return fail(`${n}: the current WAL segment is on a different timeline than the last archived one`);
      if (cur.log !== nxt.log || cur.seg !== nxt.seg) return fail(`${n}: the current WAL segment is not the one right after the last archived segment (a backlog of completed segments)`);
    }
  }
  // A6: the provider horizon is explained by the archive
  if (L > lastArch + cfg.horizon_after_archive_seconds * 1000) return fail(`the provider latest recovery point is more than ${cfg.horizon_after_archive_seconds} s after the last archived WAL`);
  if (lastArch - L > (T + cfg.horizon_before_archive_extra_seconds) * 1000) return fail(`the provider latest recovery point is more than T+${cfg.horizon_before_archive_extra_seconds} s older than the last archived WAL: the horizon is not derived from this archiver`);
  // A7: freshness
  if (o2.data.cp > now) return fail("r2 was captured in the future");
  if (stage === "row4") {
    if (selectedMs === null || t1 < selectedMs) return fail("r1 was read before the selected restore point (read both AFTER selecting)");
    if (now - o2.data.cp > cfg.max_start_to_s1_seconds * 1000) return fail(`r2 is older than ${cfg.max_start_to_s1_seconds} s: read the two reads again`);
  } else if (now - o2.data.cp > th.max_read_age_minutes * 60e3) return fail(`r2 is older than ${th.max_read_age_minutes} min`);
  return { ...pass(`idle proven: L ${utcText(L)}, T ${T} s, N ${N} s (read ${gap} s apart), LSN ${R2.lsn_write}, last archived ${R2.last_archived_utc}`), data: { validUntilMs: t2 + cfg.max_start_to_s1_seconds * 1000, L } };
}

function pitrPoint(p, { th, now, ws, we }) {
  if (!plain(p)) return { r: fail("pre_migration_restore_point is missing or not an object") };
  for (const k of Object.keys(p)) if (!PITR_POINT_KEYS.includes(k)) return { r: fail(`pre_migration_restore_point.${k} is not an allowed field`) };
  for (const k of ["selected_at_utc", "basis"]) if (p[k] === undefined || p[k] === null || p[k] === "") return { r: fail(`pre_migration_restore_point.${k} is missing`) };
  const sel = isoMs(p.selected_at_utc);
  if (!Number.isFinite(sel)) return { r: fail("pre_migration_restore_point.selected_at_utc is not a UTC time (YYYY-MM-DDTHH:MM:SSZ)") };
  if (sel > now) return { r: fail("pre_migration_restore_point.selected_at_utc is in the future") };
  if (!Number.isFinite(ws) || !Number.isFinite(we) || sel < ws || sel > we) return { r: fail("pre_migration_restore_point.selected_at_utc is outside the window") };
  if (now - sel > th.max_pre_point_age_minutes * 60e3) return { r: fail(`pre_migration_restore_point.selected_at_utc is older than ${th.max_pre_point_age_minutes} min: select it again just before S1`) };
  if (!["latest_at_or_after", "named_restore_point", "idle_proven_latest"].includes(p.basis)) return { r: fail("pre_migration_restore_point.basis must be latest_at_or_after, named_restore_point or idle_proven_latest (a bare idle accept is a recorded manual decision outside this comparator; idle_proven_latest is accepted only with the idle evidence)") };
  const named = ["restore_point_name", "restore_point_status", "restore_point_completed_at_utc"];
  if (p.basis !== "named_restore_point") {
    for (const k of named) if (p[k] !== undefined) return { r: fail(`pre_migration_restore_point.${k} belongs to basis named_restore_point only`) };
  } else {
    for (const k of named) if (p[k] === undefined || p[k] === null || p[k] === "") return { r: fail(`pre_migration_restore_point.${k} is missing (required for basis named_restore_point)`) };
    if (!nonEmpty(p.restore_point_name)) return { r: fail("pre_migration_restore_point.restore_point_name must be a non-empty string") };
    if (p.restore_point_status !== "AVAILABLE") return { r: fail("pre_migration_restore_point.restore_point_status must be AVAILABLE") };
    const c = isoMs(p.restore_point_completed_at_utc);
    if (!Number.isFinite(c)) return { r: fail("pre_migration_restore_point.restore_point_completed_at_utc is not a UTC time (YYYY-MM-DDTHH:MM:SSZ)") };
    if (c < sel) return { r: fail("pre_migration_restore_point.restore_point_completed_at_utc is before selected_at_utc") };
    if (c > now) return { r: fail("pre_migration_restore_point.restore_point_completed_at_utc is in the future") };
  }
  return { r: pass(`selected ${p.selected_at_utc}, basis ${p.basis}`), sel };
}

// Row 4 (after the holds and the S0a reads, immediately before S1): the selected restore point against a fresh PITR reading.
export function evaluatePitrPoint({ baseline, attest, window = {}, now = Date.now(), pitrApi = null, idle = null }) {
  const rows = [];
  const add = (id, label, r) => rows.push({ id, label, source: "attest", required: true, status: r.status, detail: r.detail });
  const regime = recoveryRegime(baseline);
  const md = regime === "pitr" ? pitrBaseMode(baseline) : { error: "" };
  const ac = pitrApiConfig(baseline);
  add("R4-0", "recovery_regime is pitr, the thresholds and the base mode are pinned", regime !== "pitr" ? fail(`baseline.recovery_regime is ${JSON.stringify(regime)}; the row-4 check applies only under pitr`) : (() => { const x = pitrThresholds(baseline); if (x.error) return fail(x.error); if (md.error) return fail(md.error); return md.mode === "unavailable_under_pitr" && ac.status !== "PASS" ? ac : pass(); })());
  const th = regime === "pitr" && pitrThresholds(baseline).th && !md.error && (md.mode !== "unavailable_under_pitr" || ac.status === "PASS") ? pitrThresholds(baseline).th : null;
  const A = plain(attest) ? attest : null;
  const keysOk = A && Object.keys(A).every((k) => k === "g4_pitr" || k === "pre_migration_restore_point");
  const ws = Date.parse(window.start), we = Date.parse(window.end);
  let sel = NaN;
  if (!th) {
    add("R4-1", "selected pre-migration restore point recorded and inside the window", fail("not evaluated: R4-0 failed"));
    add("R4-2", "fresh PITR reading covers the selected restore point", fail("not evaluated: R4-0 failed"));
  } else if (!A || !keysOk) {
    const why = !A ? "row-4 attestation missing or unreadable" : Object.keys(A).some((k) => /idle/i.test(k)) ? "a typed idle assertion is never accepted: idle is proven only from --pitr-idle result files" : "the row-4 attestation holds only g4_pitr and pre_migration_restore_point";
    add("R4-1", "selected pre-migration restore point recorded and inside the window", fail(why));
    add("R4-2", "fresh PITR reading covers the selected restore point", fail(why));
  } else {
    const pp = pitrPoint(A.pre_migration_restore_point, { th, now, ws, we });
    add("R4-1", "selected pre-migration restore point recorded and inside the window", pp.r);
    sel = pp.sel === undefined ? NaN : pp.sel;
    const unavailable = md.mode === "unavailable_under_pitr";
    const ctx = { th, now, mode: md.mode, cfg: ac.cfg, api: pitrApi, anchorMs: sel, selectedMs: sel };
    let r2;
    if (!Number.isFinite(sel)) r2 = fail("needs a valid selected restore point (R4-1)");
    else if (A.pre_migration_restore_point.basis !== "idle_proven_latest") r2 = pitrReading(A.g4_pitr, ctx);
    else {
      // IDLE_PROVEN: the recovery target is the provider latest point L, not the selected time (Insurance row4_idle).
      const ar = ac.status === "PASS" ? apiRead(pitrApi, { cfg: ac.cfg, th, now }) : ac;
      const pr = ar.status === "PASS" ? pitrReading(A.g4_pitr, { ...ctx, lagWaived: true, coverWaived: true }) : ar;
      const ip = pr.status === "PASS" ? idleWithHorizon(idle, { baseline, g: A.g4_pitr, ar, cfg: ac.cfg, th, now, stage: "row4", selectedMs: sel }) : pr;
      r2 = ip.status === "PASS" ? { ...pass(`${ip.detail}; restore_target=${utcText(ip.data.L)} valid_until=${utcText(ip.data.validUntilMs)}`), qualifier: [...(unavailable ? [UNVERIFIED_LABEL] : []), IDLE_ROW4_LABEL] } : ip;
    }
    if (r2.status === "PASS" && unavailable && !r2.qualifier) r2 = { ...r2, qualifier: [UNVERIFIED_LABEL] };
    add("R4-2", "fresh PITR reading covers the selected restore point", r2);
    rows[rows.length - 1].qualifier = r2.qualifier;
  }
  const overall = rows.every((r) => r.status === "PASS") ? "PASS" : "FAIL";
  return { overall, rows, verdictLine: verdictLineOf(overall === "PASS" ? rows.flatMap((r) => r.qualifier ?? []) : []) };
}

// files: { name -> text | undefined }. baseline / attest: parsed objects or null.
export function evaluate({ files, metas = {}, manifest = null, baseline, attest, window = {}, maxAgeMin = DEFAULT_MAX_AGE_MIN, dataOnly = false, now = Date.now(), manifestFileSha256 = null, pitrApi = null, idle = null }) {
  const parsed = {};
  const fileIssues = [];
  for (const n of FILES) {
    const t = files[n];
    if (t === undefined) { fileIssues.push(`${n}: missing`); continue; }
    const r = readRows(t);
    if (r.error) { fileIssues.push(`${n}: ${r.error}`); continue; }
    if (r.rows.length === 0) { fileIssues.push(`${n}: no rows (a missing census is not a zero)`); continue; }
    parsed[n] = r.rows;
  }
  const have = (...ns) => ns.every((n) => parsed[n]);
  const need = (ns, fn) => (have(...ns) ? fn(...ns.map((n) => parsed[n])) : fail(`unreadable input: ${ns.filter((n) => !parsed[n]).join(", ")}`));
  const res = {};

  // S0-13 file level
  if (fileIssues.length) res["S0-13"] = fail(fileIssues.join("; "));
  else {
    const notAt = FILES.filter((n) => n !== "g02-history" && n !== "census-0213-0246" && parsed[n].some((r) => !numEq(r.at_hosted_0212, 1)));
    res["S0-13"] = notAt.length ? fail(`chain guard value is not 1 in: ${notAt.join(", ")}`) : pass("13 files readable; chain guard is 1 in the 11 files that carry it (g02 and the census have none)");
  }

  res["S0-2"] = need(["g02-history"], (rows) => {
    if (rows.length !== 1) return fail(`expected 1 row, got ${rows.length}`);
    const r = rows[0];
    const bad = Object.entries(G2).filter(([k, v]) => (typeof v === "number" ? !numEq(r[k], v) : r[k] !== v)).map(([k]) => k);
    return bad.length ? fail(`differs: ${bad.join(", ")}`) : pass();
  });

  const censusCheck = () => need(["census-0213-0246", "g10-constraint-names"], (c, g) => {
    const want = []; for (let v = 213; v <= 246; v++) want.push(String(v).padStart(4, "0"));
    const got = c.map((r) => r.version);
    if (c.length !== 34 || want.some((v) => got.filter((x) => x === v).length !== 1)) return fail(`census rows are not exactly versions 0213..0246 once each (${c.length} rows)`);
    const bad = c.filter((r) => !numEq(r.present_now, 0) || !(int(r.objects_checked) >= 0)).map((r) => r.version);
    if (bad.length) return fail(`present_now != 0 or unreadable on ${bad.join(",")}`);
    if (g.length !== 7 || g.some((r) => !isTrue(r.present)) || g.some((r) => !numEq(r.present_total, 7))) return fail("G10: expected 7 rows, present true, present_total 7");
    return pass("34/34 absent, G10 = 7");
  });
  res["S0-3"] = censusCheck();

  res["S0-4a"] = need(["g06-payment-drain"], (rows) => {
    if (rows.length !== 1) return fail(`expected 1 row, got ${rows.length}`);
    const r = rows[0];
    const required = ["d1_ready", "d1_pending_stripe", "d1_pending_unbindable", "d2_refund_pending", "d3_claimed_inflight", "d3_unprocessed_unclaimed", "d3_errored_any_type", "d4_account_provisioning_open", "d4_customer_provisioning_open"];
    const missing = required.filter((k) => !(k in r));
    if (missing.length) return fail(`columns missing: ${missing.join(", ")}`);
    const dcols = Object.keys(r).filter((k) => /^d[1-5]_/.test(k));
    const nonzero = dcols.filter((k) => !numEq(r[k], 0));
    return nonzero.length ? fail(`non-zero: ${nonzero.map((k) => `${k}=${r[k]}`).join(", ")} (each needs an individual disposition; this comparator does not accept one)`) : pass();
  });

  res["S0-4b"] = need(["g07-sms-claimed-number-duplicates"], (rows) => {
    if (rows.length !== 1) return fail(`expected 1 row, got ${rows.length}`);
    const r = rows[0];
    return numEq(r.duplicated_numbers, 0) && numEq(r.rows_in_duplicates, 0) ? pass() : fail(`duplicated_numbers=${r.duplicated_numbers}, rows_in_duplicates=${r.rows_in_duplicates}`);
  });

  res["S0-5"] = (() => {
    const b = baseline && baseline.g09;
    if (!b || b.studios !== EXPECTED_STUDIOS) return fail(`W-1 baseline missing, or baseline.g09.studios is not the literal ${EXPECTED_STUDIOS}`);
    if (!b.per_ordinal || typeof b.per_ordinal !== "object") return fail("baseline.g09.per_ordinal missing");
    for (const o of Array.from({ length: EXPECTED_STUDIOS }, (_, i) => String(i + 1))) {
      const e = b.per_ordinal[o];
      if (!e || typeof e.r2a_reachable !== "boolean" || typeof e.needs_ack_prices !== "boolean" || typeof e.acct !== "boolean" || typeof e.money !== "boolean" || !Number.isInteger(e.bound_live) || !Number.isInteger(e.bound_test)) return fail(`baseline ordinal ${o} lacks r2a_reachable, needs_ack_prices, acct, money, bound_live and bound_test`);
    }
    return need(["g09a-0214-reach-summary", "g09b-0214-reach-per-studio", "g09c-0214-bound-account-mode"], (a, pb, c) => {
      if (a.length !== 1) return fail("g09a: expected 1 row");
      const s = a[0];
      for (const k of ["studios", "reachable_by_setter", "refused_account", "refused_money_only"]) if (!numEq(s[k], b[k])) return fail(`g09a ${k}=${s[k]}, baseline ${b[k]}`);
      if (pb.length !== EXPECTED_STUDIOS || c.length !== EXPECTED_STUDIOS) return fail(`row count: g09b ${pb.length}, g09c ${c.length}, expected ${EXPECTED_STUDIOS} (ordinals may have shifted)`);
      const moneyCols = ["charge_attempt_rows", "settlement_rows", "manual_fee_rows", "appointment_payment_rows", "stripe_charge_rows", "pending_booking_payment_rows"];
      const acctCols = ["acct_provisioning_rows", "bound_account_rows", "saved_card_rows", "stripe_customer_rows"];
      const seen = new Set();
      for (const r of pb) {
        const o = String(r.studio_ordinal);
        const e = b.per_ordinal[o];
        if (!e || seen.has(o)) return fail(`g09b ordinal ${o} is not in the baseline or repeats`);
        seen.add(o);
        const money = moneyCols.some((k) => int(r[k]) > 0), acct = acctCols.some((k) => int(r[k]) > 0);
        if (isTrue(r.r2a_reachable) !== e.r2a_reachable || isTrue(r.needs_ack_prices) !== e.needs_ack_prices) return fail(`g09b ordinal ${o}: reachability or needs_ack_prices differs from baseline`);
        if (money !== e.money || acct !== e.acct) return fail(`g09b ordinal ${o}: money class (money=${money}, acct=${acct}) differs from baseline`);
      }
      const reach = pb.filter((r) => isTrue(r.r2a_reachable)).length;
      if (!numEq(s.reachable_by_setter, reach)) return fail("g09a reachable_by_setter disagrees with g09b");
      const seenC = new Set();
      for (const r of c) {
        const o = String(r.studio_ordinal);
        const p = pb.find((x) => String(x.studio_ordinal) === o), e = b.per_ordinal[o];
        if (!p || !e || seenC.has(o)) return fail(`g09c ordinal ${o} has no g09b row or repeats`);
        seenC.add(o);
        if (!numEq(r.bound_unknown_mode, 0) || !isFalse(r.observed_country_column_present)) return fail(`g09c ordinal ${o}: unknown-mode account or observed-country column present`);
        if (int(r.bound_live) !== e.bound_live || int(r.bound_test) !== e.bound_test) return fail(`g09c ordinal ${o}: bound_live/bound_test (${r.bound_live}/${r.bound_test}) differ from baseline (${e.bound_live}/${e.bound_test})`);
        if (int(r.bound_live) + int(r.bound_test) !== int(p.bound_account_rows)) return fail(`g09c ordinal ${o}: bound_live + bound_test != g09b bound_account_rows`);
      }
      return pass(`${EXPECTED_STUDIOS}-studio baseline holds, per ordinal incl. account mode and money class`);
    });
  })();

  // G11 rule. "package": any count > 0 fails (the rule in force until Sam redefines it).
  // "p4_residual": Photos' section 3, only when baseline.g11_residual names the exact recorded counts.
  const g11 = need(["g11-0244-legacy-laser-types", "g11b-0244-legacy-laser-classes"], (a, b) => {
    if (a.length !== 1) return { rule: fail("g11: expected 1 row"), recon: fail("g11 unreadable") };
    const wrong = int(a[0].wrong_type_rows);
    const all = b.find((r) => r.leaf_key === "ALL_ROWS");
    const recon = all && isTrue(all.reconciles) && numEq(all.package_g11_rows, wrong) ? pass() : fail(all ? `reconciles=${all.reconciles}, package_g11_rows=${all.package_g11_rows}, g11 wrong_type_rows=${wrong}` : "g11b has no ALL_ROWS row");
    if (!Number.isFinite(wrong)) return { rule: fail("g11 wrong_type_rows unreadable"), recon };
    if (wrong === 0) {
      const classes = all ? ["class_n_non_object_blob", "class_x1_finalized_or_void", "class_x2_soft_deleted", "class_h1_number", "class_h2_total"].filter((k) => !numEq(all[k], 0)) : ["no ALL_ROWS"];
      return { rule: classes.length ? fail(`wrong_type_rows is 0 but class counts are not: ${classes.join(", ")}`) : pass("0"), recon };
    }
    const mode = baseline && baseline.g11_rule;
    if (mode !== "p4_residual") return { rule: fail(`wrong_type_rows=${wrong} > 0 under the package rule (G11 > 0 stops S0)`), recon };
    const rs = baseline.g11_residual;
    if (!rs || rs.recorded_by_sam !== true || rs.pending_h_requests_resolved !== true || !Number.isInteger(rs.h1) || !Number.isInteger(rs.h2)) return { rule: fail("p4_residual needs g11_residual {recorded_by_sam:true, pending_h_requests_resolved:true, h1, h2}"), recon };
    if (!all) return { rule: fail("g11b has no ALL_ROWS row"), recon };
    const classSum = ["class_n_non_object_blob", "class_x1_finalized_or_void", "class_x2_soft_deleted", "class_h1_number", "class_h2_total"].reduce((s, k) => s + int(all[k]), 0);
    if (!(classSum >= 0) || wrong > classSum) return { rule: fail(`census total ${wrong} exceeds the sum of its classes ${classSum}`), recon };
    if (int(all.class_h1_number) !== rs.h1 || int(all.class_h2_total) !== rs.h2) return { rule: fail(`H1/H2 observed ${all.class_h1_number}/${all.class_h2_total}, recorded ${rs.h1}/${rs.h2}`), recon };
    return { rule: pass(`p4 residual accepted: H1 ${rs.h1}, H2 ${rs.h2}; N/X1/X2 report only`), recon };
  });
  if (g11.rule) { res["S0-6a"] = g11.rule; res["S0-6b"] = g11.recon; } else { res["S0-6a"] = g11; res["S0-6b"] = g11; }

  res["S0-6c"] = need(["g12-0243-intake-definers"], (rows) => {
    const bad = rows.filter((r) => !numEq(r.callable_total, 0) || (r.signature !== null && r.signature !== undefined && isTrue(r.callable)));
    return bad.length ? fail("a listed definer is callable by anon, authenticated or service_role") : pass();
  });

  res["S0-7"] = need(["s1-open-transactions"], (rows) => {
    if (rows.length !== S1_TABLES.length) return fail(`expected ${S1_TABLES.length} rows, got ${rows.length}`);
    const names = rows.map((r) => r.table_name);
    if (S1_TABLES.some((t) => names.filter((n) => n === t).length !== 1) || names.some((n) => !S1_TABLES.includes(n))) return fail("table set is not exactly the ten scanned tables");
    const absent = rows.filter((r) => !isTrue(r.table_present)).map((r) => r.table_name);
    if (absent.length) return fail(`table_present is not true for ${absent.join(", ")}: nothing was scanned there`);
    const bad = rows.filter((r) => !numEq(r.old_xact_backends, 0));
    return bad.length ? fail(`old_xact_backends > 0 on ${bad.length} row(s)`) : pass();
  });

  res["S0-W3"] = need(["w03-table-sizes"], (rows) => {
    if (rows.length !== W3_TABLES.length) return fail(`expected ${W3_TABLES.length} rows, got ${rows.length}`);
    const names = rows.map((r) => r.table_name);
    const wrong = W3_TABLES.filter((t) => names.filter((n) => n === t).length !== 1);
    if (wrong.length || names.some((n) => !W3_TABLES.includes(n))) return fail(`table set is not exactly the ten named tables (${wrong.join(", ") || "unexpected name"})`);
    const absent = rows.filter((r) => !isTrue(r.present)).map((r) => r.table_name);
    if (absent.length) return fail(`table missing: ${absent.join(", ")}`);
    const bad = rows.filter((r) => !(int(r.total_bytes) >= 0)).map((r) => r.table_name);
    if (bad.length) return fail(`total_bytes unreadable: ${bad.join(", ")}`);
    const over = rows.filter((r) => int(r.total_bytes) > W3_LIMIT_BYTES).map((r) => `${r.table_name}=${r.total_bytes}`);
    const st = new Set(rows.map((r) => r.statement_timeout)), lt = new Set(rows.map((r) => r.lock_timeout));
    const settings = `statement_timeout=${[...st].join("/")} lock_timeout=${[...lt].join("/")}`;
    if (st.has(undefined) || lt.has(undefined) || st.size !== 1 || lt.size !== 1) return fail(`settings missing or inconsistent (${settings})`);
    return over.length ? fail(`over 512 MiB: ${over.join(", ")}; ${settings}`) : pass(settings);
  });

  // S0-14: bind the results to THIS window (Insurance F2).
  res["S0-14"] = (() => {
    const ws = Date.parse(window.start), we = Date.parse(window.end);
    if (!Number.isFinite(ws) || !Number.isFinite(we) || we <= ws) return fail("--window-start / --window-end missing or invalid");
    if (!(maxAgeMin > 0 && maxAgeMin <= 120)) return fail("max age must be 1..120 minutes");
    if (!manifest || typeof manifest !== "object") return fail("MANIFEST.sha256 unreadable");
    if (!baseline || manifestFileSha256 !== baseline.manifest_sha256) return fail("the MANIFEST.sha256 file on disk does not hash to baseline.manifest_sha256");
    if (!baseline || !/^[0-9a-f]{64}$/.test(baseline.runner_sha256 ?? "") || !/^[0-9a-f]{64}$/.test(baseline.manifest_sha256 ?? "")) return fail("baseline must pin runner_sha256 and manifest_sha256 (64 hex)");
    const problems = [];
    for (const n of FILES) {
      const m = metas[n], t = files[n];
      if (!m || typeof m !== "object") { problems.push(`${n}: no capture sidecar`); continue; }
      if (typeof t !== "string") { problems.push(`${n}: no result`); continue; }
      const rsha = sha256(t);
      if (m.file !== `${n}.sql`) problems.push(`${n}: sidecar names ${m.file}`);
      if (m.sql_sha256 !== manifest[`${n}.sql`]) problems.push(`${n}: sidecar sql sha is not the manifest's`);
      if (m.result_sha256 !== rsha) problems.push(`${n}: result file changed after capture`);
      if (m.exit_code !== 0) problems.push(`${n}: runner exit ${m.exit_code}`);
      if (m.runner_sha256 !== baseline.runner_sha256) problems.push(`${n}: captured by a different runner`);
      if (m.manifest_sha256 !== baseline.manifest_sha256) problems.push(`${n}: captured under a different manifest`);
      const st = Date.parse(m.started_at_utc), cp = Date.parse(m.captured_at_utc);
      if (!Number.isFinite(st) || !Number.isFinite(cp) || cp < st) { problems.push(`${n}: capture times unreadable`); continue; }
      if (st < ws) problems.push(`${n}: started before the window`);
      if (cp > we) problems.push(`${n}: captured after the window ended`);
      if (cp > now + 60e3) problems.push(`${n}: captured in the future`);
      if (now - cp > maxAgeMin * 60e3) problems.push(`${n}: captured ${Math.round((now - cp) / 60e3)} min ago (> ${maxAgeMin})`);
    }
    return problems.length ? fail(problems.join("; ")) : pass(`all 13 captured inside the window, none older than ${maxAgeMin} min`);
  })();
  const resultHashes = Object.fromEntries(FILES.filter((n) => typeof files[n] === "string").map((n) => [n, sha256(files[n])]));

  // Attested checks. Each is itemised: a bare boolean proves nothing (Insurance F7).
  const A = attest && typeof attest === "object" ? attest : null;
  const att = (fn) => (A ? fn(A) : fail("attestation file missing or unreadable"));
  const hex = (v, n) => typeof v === "string" && new RegExp(`^[0-9a-f]{${n}}$`).test(v);
  const when = (v) => { const t = Date.parse(v); return Number.isFinite(t) && t <= now ? t : NaN; };
  const named = (v) => typeof v === "string" && v.trim().length > 0;
  res["S0-1"] = att((a) => {
    if (!named(a.operator)) return fail("operator not named");
    if (!hex(a.project_ref_sha256, 64) || !baseline || a.project_ref_sha256 !== baseline.project_ref_sha256) return fail("project_ref_sha256 is missing or does not equal the pinned canonical-production value");
    return pass();
  });
  res["S0-8"] = att((a) => {
    const ws = Date.parse(window.start), we = Date.parse(window.end);
    if (!Number.isFinite(ws) || !Number.isFinite(we) || we <= ws) return fail("--window-start / --window-end missing or invalid");
    if (we - ws > 36 * 3600e3) return fail("window longer than 36 h cannot be checked against the daily blackout");
    const h = a.holds;
    const need3 = ["cron_job_org_paused", "people_hold_in_place", "maintenance_flag_decision"];
    if (!h || typeof h !== "object") return fail("holds missing: " + need3.join(", "));
    for (const k of need3) { if (!h[k] || !named(h[k].confirmed_by) || !Number.isFinite(when(h[k].at_utc))) return fail(`hold ${k} lacks confirmed_by or a valid at_utc not in the future`); }
    if (!["no_flag", "flag_on"].includes(h.maintenance_flag_decision.choice)) return fail("maintenance_flag_decision.choice must be no_flag or flag_on");
    if (now < ws || now > we) return fail("the real clock is outside the declared window");
    if (!Number.isInteger(baseline?.planned_duration_minutes) || baseline.planned_duration_minutes <= 0) return fail("baseline.planned_duration_minutes missing");
    if (we - now < baseline.planned_duration_minutes * 60e3) return fail(`only ${Math.round((we - now) / 60e3)} min of the window remain; ${baseline.planned_duration_minutes} planned`);
    const inBlackout = (t) => { const d = new Date(t); const m = d.getUTCHours() * 60 + d.getUTCMinutes(); return m >= BLACKOUT_UTC.start[0] * 60 + BLACKOUT_UTC.start[1] && m < BLACKOUT_UTC.end[0] * 60 + BLACKOUT_UTC.end[1]; };
    if (inBlackout(now)) return fail(`the real clock (${new Date(now).toISOString()}) is inside 07:45-10:00 UTC`);
    for (let d = Date.UTC(new Date(ws).getUTCFullYear(), new Date(ws).getUTCMonth(), new Date(ws).getUTCDate() - 1); d <= we; d += 86400e3) {
      const bs = d + (BLACKOUT_UTC.start[0] * 60 + BLACKOUT_UTC.start[1]) * 60e3, be = d + (BLACKOUT_UTC.end[0] * 60 + BLACKOUT_UTC.end[1]) * 60e3;
      if (ws < be && we > bs) return fail("window overlaps 07:45-10:00 UTC");
    }
    return pass();
  });
  res["S0-9"] = att((a) => {
    const g = a.g3, b = baseline && baseline.g3;
    if (!g || !b) return fail("g3 attestation or baseline.g3 missing");
    if (!hex(g.head_sha, 40) || g.head_sha !== b.head_sha) return fail("g3.head_sha is not the pinned final head (40 hex)");
    const got = g.checksums, want = b.checksums;
    if (!got || !want || typeof got !== "object" || typeof want !== "object") return fail("g3.checksums or baseline.g3.checksums missing");
    if (Object.keys(want).length !== 34 || CHECKSUM_VERSIONS.some((v) => !hex(want[v], 64))) return fail("baseline.g3.checksums is not exactly 34 sha256 values 0213..0246");
    if (Object.keys(got).length !== 34 || CHECKSUM_VERSIONS.some((v) => !hex(got[v], 64))) return fail("g3.checksums is not exactly 34 sha256 values 0213..0246");
    if (got["0214"] === SUPERSEDED_0214_SHA || want["0214"] === SUPERSEDED_0214_SHA) return fail("0214 is the superseded unamended file (8ff9350e...)");
    if (got["0214"] !== PINNED_0214_SHA || want["0214"] !== PINNED_0214_SHA) return fail("0214 is not the amended file pinned in the comparator (a8bdcefe...)");
    const diff = CHECKSUM_VERSIONS.filter((v) => got[v] !== want[v]);
    return diff.length ? fail(`checksum differs from the package at: ${diff.join(", ")}`) : pass("34/34 checksums equal the pinned list");
  });
  res["S0-10"] = att((a) => {
    const regime = recoveryRegime(baseline);
    if (!RECOVERY_REGIMES.includes(regime)) return fail(`baseline.recovery_regime ${JSON.stringify(regime)} is unknown (daily or pitr)`);
    const r = a.r6;
    const r6ok = r && ["S0b", "accept_rpo"].includes(r.choice) && named(r.answer_text) && named(r.reference);
    if (regime === "pitr") {
      if (a.g4 !== undefined) return fail("g4 (the daily backup fields) is rejected under recovery_regime pitr; use g4_pitr");
      if (a.pre_migration_restore_point !== undefined) return fail("pre_migration_restore_point is recorded at row 4, after S0a; it is rejected here and checked by --stage row4");
      const x = pitrThresholds(baseline);
      if (x.error) return fail(x.error);
      const md = pitrBaseMode(baseline);
      if (md.error) return fail(md.error);
      if (Object.keys(a).some((k) => /idle/i.test(k))) return fail("a typed idle assertion is never accepted: idle is proven only from --pitr-idle result files");
      const unavailable = md.mode === "unavailable_under_pitr";
      const ac = pitrApiConfig(baseline);
      if (unavailable && ac.status !== "PASS") return ac;
      const ctx = { th: x.th, now, mode: md.mode, cfg: ac.cfg, api: pitrApi };
      const quals = unavailable ? [UNVERIFIED_LABEL] : [];
      let pr = pitrReading(a.g4_pitr, ctx), extra = "";
      if (pr.status !== "PASS" && pr.lagFail) {
        const ar = ac.status === "PASS" ? apiRead(pitrApi, { cfg: ac.cfg, th: x.th, now }) : ac;
        if (ar.status !== "PASS") return fail(`${pr.detail}; the idle path needs a valid --pitr-api result: ${ar.detail}`);
        const ip = idleWithHorizon(idle, { baseline, g: a.g4_pitr, ar, cfg: ac.cfg, th: x.th, now, stage: "s0a" });
        if (ip.status !== "PASS") return fail(`${pr.detail}; idle proof: ${ip.detail}`);
        pr = pitrReading(a.g4_pitr, { ...ctx, lagWaived: true });
        quals.push(IDLE_S0_LABEL);
        extra = `; ${ip.detail}`;
      }
      if (pr.status !== "PASS") return pr;
      if (!r6ok) return fail("r6 needs choice S0b|accept_rpo, answer_text and reference");
      if (unavailable) {
        if (r.base_backup_unverified_ack !== true) return fail("r6.base_backup_unverified_ack must be the boolean true under mode unavailable_under_pitr (the base backup is UNVERIFIED)");
        if (r.choice === "accept_rpo" && !/unverified base backup/i.test(r.answer_text)) return fail("under accept_rpo the r6 answer_text must name the unverified base backup");
      } else if (r.base_backup_unverified_ack !== undefined) return fail("r6.base_backup_unverified_ack belongs to mode unavailable_under_pitr only");
      return { ...pass(`${pr.detail}${extra}`), qualifier: quals };
    }
    if (a.g4_pitr !== undefined || a.pre_migration_restore_point !== undefined) return fail("g4_pitr / pre_migration_restore_point are rejected under recovery_regime daily");
    const g = a.g4;
    if (!g || !named(g.backup_id) || g.status !== "COMPLETED" || !Number.isFinite(when(g.backup_completed_at_utc))) return fail("g4 needs backup_id, status COMPLETED and a valid backup_completed_at_utc");
    const maxH = baseline && baseline.g4_max_age_hours;
    if (!Number.isInteger(maxH) || maxH <= 0) return fail("baseline.g4_max_age_hours missing");
    if (now - when(g.backup_completed_at_utc) > maxH * 3600e3) return fail(`the backup is older than ${maxH} h`);
    if (!r6ok) return fail("r6 needs choice S0b|accept_rpo, answer_text and reference");
    return pass();
  });
  res["S0-11"] = att((a) => a.disposition_0242 && ["bridge_ready", "R-3"].includes(a.disposition_0242.choice) && named(a.disposition_0242.reference) ? pass() : fail("disposition_0242 needs choice bridge_ready|R-3 and a reference"));
  res["S0-12"] = att((a) => Array.isArray(a.denial_files) && a.denial_files.length === 0 && numEq(a.runner_refusals, 0) ? pass() : fail("denial_files must be [] and runner_refusals 0"));

  // Required set: all known checks, plus anything named in baseline.required_checks. An unknown id fails.
  const reqIn = baseline && Array.isArray(baseline.required_checks) ? baseline.required_checks : [];
  const unknown = reqIn.filter((id) => !KNOWN.has(id));
  const required = new Set([...KNOWN, ...reqIn.filter((id) => KNOWN.has(id))]);

  const rows = CHECKS.map((c) => {
    const r = res[c.id] ?? fail("not evaluated");
    const skipped = dataOnly && c.source === "attest";
    return { id: c.id, label: c.label, source: c.source, required: required.has(c.id), status: skipped ? "NOT-EVALUATED" : r.status, detail: skipped ? "--data-only" : r.detail, qualifier: skipped ? undefined : r.qualifier };
  });
  for (const id of unknown) rows.push({ id, label: "unknown required check", source: "n/a", required: true, status: "FAIL", detail: "a required check this comparator does not know cannot be treated as passed" });

  const failed = rows.filter((r) => r.required && r.status === "FAIL");
  const notEval = rows.filter((r) => r.required && r.status === "NOT-EVALUATED");
  const overall = failed.length ? "FAIL" : notEval.length ? "DATA-ONLY" : rows.filter((r) => r.required).every((r) => r.status === "PASS") ? "PASS" : "FAIL";
  const s10 = res["S0-10"];
  return { overall, rows, resultHashes, verdictLine: verdictLineOf(overall === "PASS" && s10 && s10.qualifier ? s10.qualifier : []) };
}


// ---------------------------------------------------------------------------
// S1 read-back (after 0246). Inputs: the census and G10 re-run (same files as S0,
// read at S1), plus ONE read-back file built by OPS from the package's S1
// read-back queries, and the expectations. The read-back format is defined here:
//   { history: { applied_count, hosted_max, distinct_versions_ge_0213 },
//     closures: [ { fn, anon, authenticated, service_role } ],     // has_function_privilege(..., 'execute')
//     table_privileges: [ { table, role, privilege, held } ],
//     body_md5: { "<function>": "<md5(prosrc)>" } }
// expected (baseline file, key "s1"):
//   { closures: [ { fn, anon, authenticated, service_role } ],     // MUST include the three new 0214 functions
//     table_privileges: [ ... same shape ... ],
//     body_md5: { "<function>": "<md5 of the source file body>" } } // 0227 0228 0236 0241
// The intended grants of the three new 0214 functions and the 0239/0245 service_role
// and audit_logs pins are hard-coded above (PINNED_CLOSURES, PINNED_TABLE_PRIVILEGES),
// so an `expected` file that disagrees with the addendum cannot launder them.
export const NEW_0214_FUNCTIONS = ["initialize_studio_payment_jurisdiction_from_history", "studio_account_acceptable_for_jurisdiction", "studio_named_stripe_accounts"];
export const BODY_MD5_FUNCTIONS = ["0227", "0228", "0236", "0241"];

export function evaluateS1({ censusText, g10Text, readback, expected }) {
  const out = [];
  const add = (id, label, r) => out.push({ id, label, required: true, status: r.status, detail: r.detail });
  const cr = censusText === undefined ? { error: "missing" } : readRows(censusText);
  const gr = g10Text === undefined ? { error: "missing" } : readRows(g10Text);
  if (cr.error || gr.error || !cr.rows.length || !gr.rows.length) {
    add("S1-2", "census re-run readable", fail(`census: ${cr.error ?? "ok"}; g10: ${gr.error ?? "ok"}`));
  } else {
    const want = []; for (let v = 213; v <= 246; v++) want.push(String(v).padStart(4, "0"));
    const rows = cr.rows;
    const shape = rows.length === 34 && want.every((v) => rows.filter((r) => r.version === v).length === 1);
    const eq = shape && rows.every((r) => int(r.objects_checked) >= 0 && int(r.present_now) === int(r.objects_checked));
    const r0214 = rows.find((r) => r.version === "0214");
    add("S1-2", "census: present_now = objects_checked on every row (34 rows)", eq ? pass() : fail(shape ? "present_now != objects_checked on a row" : "census is not exactly 0213..0246 once each"));
    add("S1-2b", "0214 row: objects_checked = 30 and present_now = 30 (P-2: three new functions)", r0214 && numEq(r0214.objects_checked, 30) && numEq(r0214.present_now, 30) ? pass() : fail(`0214 objects_checked=${r0214?.objects_checked}, present_now=${r0214?.present_now}`));
    add("S1-2c", "G10 = 7", gr.rows.length === 7 && gr.rows.every((r) => isTrue(r.present) && numEq(r.present_total, 7)) ? pass() : fail("G10 is not 7"));
  }
  const rb = readback && typeof readback === "object" ? readback : null;
  const ex = expected && typeof expected === "object" ? expected : null;
  if (!rb || !ex) { add("S1-1", "history 245", fail("read-back or expectations missing")); add("S1-3", "privilege closures", fail("read-back or expectations missing")); add("S1-4", "replaced bodies", fail("read-back or expectations missing")); }
  else {
    const h = rb.history;
    add("S1-1", "history 211 -> 245, max 0246, 34 distinct new versions", h && numEq(h.applied_count, 245) && h.hosted_max === "0246" && numEq(h.distinct_versions_ge_0213, 34) ? pass() : fail("history is not 245 / 0246 / 34"));
    const lc = (a) => (Array.isArray(a) ? a : []);
    const exC = lc(ex.closures), obC = lc(rb.closures);
    const missingNew = NEW_0214_FUNCTIONS.filter((f) => !exC.some((c) => c.fn === f) || !obC.some((c) => c.fn === f));
    let r = missingNew.length ? fail(`the three new 0214 functions must be in both expected and observed closures; missing: ${missingNew.join(", ")}`) : null;
    if (!r) {
      const pinBad = [];
      for (const pin of PINNED_CLOSURES) {
        const o = obC.find((x) => x.fn === pin.fn), e = exC.find((x) => x.fn === pin.fn);
        if (!o) { pinBad.push(`${pin.fn}: not observed`); continue; }
        for (const k of ["anon", "authenticated", "service_role"]) if (k in pin && (o[k] !== pin[k] || (e && e[k] !== pin[k]))) pinBad.push(`${pin.fn}.${k} must be ${pin[k]}`);
      }
      for (const pin of PINNED_TABLE_PRIVILEGES) {
        const o = lc(rb.table_privileges).find((x) => x.table === pin.table && x.role === pin.role && x.privilege === pin.privilege);
        const e = lc(ex.table_privileges).find((x) => x.table === pin.table && x.role === pin.role && x.privilege === pin.privilege);
        if (!o || o.held !== pin.held || (e && e.held !== pin.held)) pinBad.push(`${pin.role}:${pin.privilege}:${pin.table} must be ${pin.held}`);
      }
      if (pinBad.length) r = fail(`pinned grant mismatch: ${pinBad.join("; ")}`);
    }
    if (!r) {
      const bad = exC.filter((c) => { const o = obC.find((x) => x.fn === c.fn); return !o || ["anon", "authenticated", "service_role"].some((k) => c[k] !== o[k] || typeof o[k] !== "boolean"); }).map((c) => c.fn);
      const tp = lc(ex.table_privileges).filter((t) => { const o = lc(rb.table_privileges).find((x) => x.table === t.table && x.role === t.role && x.privilege === t.privilege); return !o || o.held !== t.held; }).map((t) => `${t.role}:${t.privilege}:${t.table}`);
      r = bad.length || tp.length ? fail(`closure mismatch: ${[...bad, ...tp].join(", ")}`) : exC.length === 0 ? fail("expected closures are empty") : pass(`${exC.length} function closures incl. the 3 new 0214 functions, ${lc(ex.table_privileges).length} table privileges`);
    }
    add("S1-3", "privilege closures read back (including the 3 new 0214 functions)", r);
    const em = ex.body_md5 && typeof ex.body_md5 === "object" ? ex.body_md5 : {}, om = rb.body_md5 && typeof rb.body_md5 === "object" ? rb.body_md5 : {};
    const names = Object.keys(em);
    add("S1-4", "replaced bodies match by md5(prosrc) (0227, 0228, 0236, 0241)", names.length >= 4 && names.every((n) => typeof em[n] === "string" && om[n] === em[n]) ? pass() : fail(names.length < 4 ? "fewer than 4 expected bodies" : `mismatch: ${names.filter((n) => om[n] !== em[n]).join(", ")}`));
  }
  const overall = out.every((r) => r.status === "PASS") ? "PASS" : "FAIL";
  return { overall, rows: out };
}

export function format({ overall, rows, verdictLine }) {
  // The ONLY line a caller may read as a go is the exact text "OVERALL PASS".
  const lines = rows.map((r) => `${r.status.padEnd(13)} ${r.id.padEnd(6)} ${r.required ? "REQ" : "   "} ${r.label}${r.detail ? `  -- ${r.detail}` : ""}`);
  lines.push("", overall === "PASS" ? (verdictLine ?? "OVERALL PASS") : overall === "DATA-ONLY" ? "OVERALL DATA-ONLY (attestations not evaluated; this is NOT a go)" : "OVERALL FAIL  -> STOP THE CUTOVER");
  return lines.join("\n");
}
