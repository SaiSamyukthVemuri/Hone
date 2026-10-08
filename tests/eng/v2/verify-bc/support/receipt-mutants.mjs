// Unsafe receipt-layer mutants, built by wrapping the real receipts.mjs exports (never by reading them).

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function canon(v) {
  if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
  if (v && typeof v === "object") return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}";
  return JSON.stringify(v);
}
/** The checksum as observed from the black box: sha256 of the canonical JSON of every other field. */
export function checksumOf(rec) {
  const { checksum, ...rest } = rec;
  void checksum;
  return crypto.createHash("sha256").update(canon(rest)).digest("hex");
}

const DECISIONS = ["NOT_OPEN", "DRAFT_HOLD", "NEEDS_REFRESH", "CI_FAILED", "EXTERNAL_BLOCKED", "CI_NOT_STARTED", "CI_INCOMPLETE", "CI_PENDING", "EXTERNAL_PENDING", "REVIEW_MISSING", "FINDINGS_OPEN", "CANDIDATE_READY_FOR_HUMAN_REVIEW", "UNKNOWN"];
const REASONS = ["read_failed", "malformed", "pr_key_moved", "unstable_snapshot", "ci_candidate_listing_too_large", "review_evidence_too_large", "external_contexts_too_large", "unrecognized_ci_status", "unrecognized_ci_conclusion", "unrecognized_context_state", "base_ref", "base_ref_changed", "shared_head", "base_history_unverified", "fork_head", "diff_too_large", "ci_definition_changed", "ci_definition_mismatch"];
const KEYS = JSON.stringify(["checksum", "decision", "evidenceHash", "head", "observed_at", "pr", "reasons", "schema", "tool_version"]);

/** Independent receipt validator, from README "Diagnostic receipts" (pass 2: schema, checksum and reasons rule are
 * documented; tool_version is null or the report's toolVersion format). */
export function receiptProblem(rec) {
  if (!rec || typeof rec !== "object" || Array.isArray(rec)) return "not an object";
  if (JSON.stringify(Object.keys(rec).sort()) !== KEYS) return `keys ${Object.keys(rec).sort()}`;
  if (rec.schema !== "eng-loop-v1/receipt@1") return "schema";
  if (!Number.isSafeInteger(rec.pr) || rec.pr <= 0) return "pr";
  if (rec.head !== null && !/^[0-9a-f]{40}$/.test(rec.head)) return "head";
  if (rec.evidenceHash !== null && !/^[0-9a-f]{64}$/.test(rec.evidenceHash)) return "evidenceHash";
  if (!DECISIONS.includes(rec.decision)) return "decision";
  if (!Array.isArray(rec.reasons) || rec.reasons.length !== 1 || (rec.decision === "UNKNOWN" ? !REASONS.includes(rec.reasons[0]) : rec.reasons[0] !== rec.decision)) return "reasons";
  if (typeof rec.observed_at !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(rec.observed_at)) return "observed_at";
  if (rec.tool_version !== null && !(typeof rec.tool_version === "string" && /^eng-loop-v1@[0-9a-f]{40}(\+dirty)?$/.test(rec.tool_version))) return "tool_version";
  if (rec.checksum !== checksumOf(rec)) return "checksum";
  return null;
}

/** The publication name observed from the black box: <observed_at compact>-pr<pr>-<pid>-<16 hex>.json */
function finalName(rec) {
  return `${String(rec.observed_at).replace(/[-:]/g, "").replace(/\.\d+/, "")}-pr${rec.pr}-${process.pid}-${crypto.randomBytes(8).toString("hex")}.json`;
}

export const RECEIPT_MUTANTS = {
  "R-M1 accepts a tampered checksum": (real) => ({
    ...real,
    readReceipts: (dir) => {
      const r = real.readReceipts(dir);
      if (r.unreadable) return r;
      const accepted = new Set(r.receipts.map((x) => canon(x)));
      const receipts = [...r.receipts];
      let fixed = 0;
      for (const f of fs.readdirSync(dir)) {
        let rec;
        try {
          rec = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
        } catch {
          continue;
        }
        if (!rec || typeof rec !== "object" || accepted.has(canon(rec))) continue;
        const repaired = { ...rec, checksum: checksumOf(rec) };
        if (real.parseReceipt(JSON.stringify(repaired) + "\n") !== null || real.parseReceipt(JSON.stringify(repaired)) !== null) {
          receipts.push(rec);
          fixed += 1;
        }
      }
      const invalid = Array.isArray(r.invalid) ? r.invalid.slice(fixed) : r.invalid;
      return { ...r, receipts, invalid, complete: (invalid?.length ?? 0) === 0 && !r.interrupted && !r.unreadable };
    },
  }),
  "R-M2 interrupted writes counted as complete": (real) => ({
    ...real,
    readReceipts: (dir) => {
      const r = real.readReceipts(dir);
      return { ...r, interrupted: 0, complete: (r.invalid?.length ?? 0) === 0 && !r.unreadable };
    },
  }),
  "R-M3 unreadable directory read as clean": (real) => ({
    ...real,
    readReceipts: (dir) => {
      const r = real.readReceipts(dir);
      return r.unreadable ? { receipts: [], invalid: [], interrupted: 0, unreadable: null, complete: true } : r;
    },
  }),
  "R-M4 non-atomic writer (writes the final file in place)": (real) => ({
    ...real,
    writeReceipt: (dir, rec) => {
      const text = JSON.stringify(rec) + "\n";
      const name = `${String(rec.observed_at).replace(/[-:]/g, "").replace(/\.\d+/, "")}-pr${rec.pr}-${process.pid}-${crypto.randomBytes(8).toString("hex")}.json`;
      const fd = fs.openSync(path.join(dir, name), "w");
      fs.writeSync(fd, text.slice(0, Math.floor(text.length / 2)));
      const until = Date.now() + 2;
      while (Date.now() < until) {
        /* a window a crash can land in */
      }
      fs.writeSync(fd, text.slice(Math.floor(text.length / 2)));
      fs.closeSync(fd);
      return { ok: true, file: name };
    },
  }),
  "R-M5 receipt carries the failure detail": (real) => ({
    ...real,
    receiptFrom: (report) => {
      const r = real.receiptFrom(report);
      if (!r.ok) return r;
      const rec = { ...r.receipt, detail: report?.blocking?.detail ?? null };
      return { ok: true, receipt: { ...rec, checksum: checksumOf(rec) } };
    },
  }),
  // Pass 2 mutants (README "Diagnostic receipts" at 738a4537).
  "R-M7 overwriting publish (rename instead of an exclusive link)": (real) => ({
    ...real,
    writeReceipt: (dir, rec) => {
      const name = finalName(rec);
      const tmp = path.join(dir, `.tmp-${name}`);
      const fd = fs.openSync(tmp, "wx", 0o600);
      fs.writeSync(fd, JSON.stringify(rec) + "\n");
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fs.renameSync(tmp, path.join(dir, name));
      return { ok: true, file: name };
    },
  }),
  "R-M8 symlink-following reader": (real) => ({
    ...real,
    readReceipts: (dir) => {
      const r = real.readReceipts(dir);
      if (r.unreadable) return r;
      const receipts = [...r.receipts];
      let followed = 0;
      for (const f of fs.readdirSync(dir)) {
        let st;
        try {
          st = fs.lstatSync(path.join(dir, f));
        } catch {
          continue;
        }
        if (!st.isSymbolicLink()) continue;
        try {
          const rec = real.parseReceipt(fs.readFileSync(path.join(dir, f), "utf8"));
          if (rec) {
            receipts.push(rec);
            followed += 1;
          }
        } catch {
          /* dangling */
        }
      }
      const invalid = Array.isArray(r.invalid) ? r.invalid.slice(followed) : r.invalid;
      return { ...r, receipts, invalid, complete: (invalid?.length ?? 0) === 0 && !r.interrupted && !r.unreadable };
    },
  }),
  "R-M9 reasons-consistency rule dropped": (real) => ({
    ...real,
    receiptFrom: (report) => {
      const r = real.receiptFrom(report);
      if (r.ok || !report || typeof report !== "object") return r;
      const probe = real.receiptFrom({ ...report, reasonCodes: report.decision === "UNKNOWN" ? ["malformed"] : [report.decision] });
      if (!probe.ok) return r;
      const rec = { ...probe.receipt, reasons: report.reasonCodes };
      delete rec.checksum;
      return { ok: true, receipt: { ...rec, checksum: checksumOf(rec) } };
    },
    writeReceipt: (dir, rec) => {
      const w = real.writeReceipt(dir, rec);
      if (w.ok || receiptProblem(rec) !== "reasons") return w;
      const name = finalName(rec);
      fs.writeFileSync(path.join(dir, name), JSON.stringify(rec) + "\n", { flag: "wx" });
      return { ok: true, file: name };
    },
    readReceipts: (dir) => {
      const r = real.readReceipts(dir);
      if (r.unreadable) return r;
      const accepted = new Set(r.receipts.map((x) => canon(x)));
      const receipts = [...r.receipts];
      let extra = 0;
      for (const f of fs.readdirSync(dir)) {
        try {
          const rec = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
          if (!accepted.has(canon(rec)) && receiptProblem(rec) === "reasons") {
            receipts.push(rec);
            extra += 1;
          }
        } catch {
          /* not JSON */
        }
      }
      const invalid = Array.isArray(r.invalid) ? r.invalid.slice(extra) : r.invalid;
      return { ...r, receipts, invalid, complete: (invalid?.length ?? 0) === 0 && !r.interrupted && !r.unreadable };
    },
  }),
  "R-M10 reader blocks on a FIFO": (real) => ({
    ...real,
    readReceipts: (dir) => {
      try {
        for (const f of fs.readdirSync(dir)) {
          const p = path.join(dir, f);
          if (fs.lstatSync(p).isFIFO()) fs.readFileSync(p);
        }
      } catch {
        /* fall through */
      }
      return real.readReceipts(dir);
    },
  }),
  "R-M11 reader accepts files over 4 KB": (real) => ({
    ...real,
    readReceipts: (dir) => {
      const r = real.readReceipts(dir);
      if (r.unreadable) return r;
      const receipts = [...r.receipts];
      let extra = 0;
      for (const f of fs.readdirSync(dir)) {
        try {
          const p = path.join(dir, f);
          const st = fs.lstatSync(p);
          if (!st.isFile() || st.size <= 4096) continue;
          const rec = real.parseReceipt(fs.readFileSync(p, "utf8").trim() + "\n");
          if (rec) {
            receipts.push(rec);
            extra += 1;
          }
        } catch {
          /* ignore */
        }
      }
      const invalid = Array.isArray(r.invalid) ? r.invalid.slice(extra) : r.invalid;
      return { ...r, receipts, invalid, complete: (invalid?.length ?? 0) === 0 && !r.interrupted && !r.unreadable };
    },
  }),
  "R-M6 overwriting writer (deterministic name)": (real) => ({
    ...real,
    writeReceipt: (dir, rec) => {
      const name = `pr${rec.pr}-${rec.head}.json`;
      fs.writeFileSync(path.join(dir, name), JSON.stringify(rec) + "\n");
      return { ok: true, file: name };
    },
  }),
};

export async function receiptsApi(receiptsModulePath, mutant) {
  const m = await import(receiptsModulePath);
  const real = { receiptFrom: m.receiptFrom, writeReceipt: m.writeReceipt, readReceipts: m.readReceipts, parseReceipt: m.parseReceipt };
  return mutant && mutant !== "real" ? RECEIPT_MUTANTS[mutant](real) : real;
}
