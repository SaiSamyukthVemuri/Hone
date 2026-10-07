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
