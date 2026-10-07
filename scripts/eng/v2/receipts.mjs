// ---------------------------------------------------------------------------
// ENG-LOOP V1 05C: diagnostic receipts. Write-once files under a non-shipping,
// gitignored root (`.eng/receipts/`). They are diagnostic evidence for the
// shadow evaluation, never a release-authority ledger, and `decide()` never
// reads them.
//
// One receipt per file, published atomically: the record is written to an
// exclusive temporary file, fsynced, then renamed into place. So a reader never
// sees a torn record, concurrent writers never collide (unique names, `wx`),
// and an interrupted write leaves only a `.tmp-` file that readers report as
// possibly-missing data and never accept. Every record carries a checksum over
// its canonical JSON, and the reader accepts exactly the closed schema.
//
// A receipt holds no credential and no personal information: a PR number, two
// hashes, a decision and its closed reasons, a time and a tool version.
// ---------------------------------------------------------------------------

import { createHash, randomBytes } from "node:crypto";
import * as nodeFs from "node:fs";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { canonicalJson } from "./contract/strict.mjs";
import { UNKNOWN_REASONS } from "./contract/reasons.mjs";
import { DECISIONS } from "./decision/decide.mjs";

export const RECEIPT_SCHEMA = "eng-loop-v1/receipt@1";
const FIELDS = ["schema", "pr", "head", "evidenceHash", "decision", "reasons", "observed_at", "tool_version", "checksum"];
const REASONS = new Set([...DECISIONS, ...UNKNOWN_REASONS]);
const SHA40 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const TOOL = /^eng-loop-v1@([0-9a-f]{40}(\+dirty)?|unknown)$/;
const PUBLISHED = /^\d{8}T\d{6}Z-pr\d+-\d+-[0-9a-f]{16}\.json$/;

const checksumOf = (record) => createHash("sha256").update(canonicalJson(record)).digest("hex");

/** Does `r` (without its checksum) satisfy the closed schema? */
function validBody(r) {
  return (
    r !== null &&
    typeof r === "object" &&
    r.schema === RECEIPT_SCHEMA &&
    Number.isSafeInteger(r.pr) &&
    r.pr > 0 &&
    (r.head === null || (typeof r.head === "string" && SHA40.test(r.head))) &&
    (r.evidenceHash === null || (typeof r.evidenceHash === "string" && SHA256.test(r.evidenceHash))) &&
    DECISIONS.includes(r.decision) &&
    Array.isArray(r.reasons) &&
    r.reasons.length > 0 &&
    r.reasons.every((x) => REASONS.has(x)) &&
    typeof r.observed_at === "string" &&
    ISO.test(r.observed_at) &&
    typeof r.tool_version === "string" &&
    TOOL.test(r.tool_version)
  );
}

/**
 * Build a receipt from a shepherd report. Only the closed fields are copied, so
 * nothing else a report carries — details, URLs, instrumentation — can leak in.
 *
 * @returns {{ ok: true, receipt } | { ok: false, detail }}
 */
export function receiptFrom(report) {
  try {
    const body = {
      schema: RECEIPT_SCHEMA,
      pr: report.pr,
      head: report.headSha,
      evidenceHash: report.evidenceHash,
      decision: report.decision,
      reasons: [...report.reasonCodes],
      observed_at: report.observedAt,
      tool_version: report.toolVersion,
    };
    if (!validBody(body)) return { ok: false, detail: "the report does not fit the closed receipt schema" };
    return { ok: true, receipt: Object.freeze({ ...body, checksum: checksumOf(body) }) };
  } catch {
    return { ok: false, detail: "the report could not be read" };
  }
}

/**
 * Publish one receipt atomically. Never overwrites; never throws.
 *
 * @returns {{ ok: true, file } | { ok: false, detail }}
 */
export function writeReceipt(
  dir,
  receipt,
  { pid = process.pid, random = () => randomBytes(8).toString("hex"), fs = nodeFs } = {},
) {
  let tmp = null;
  try {
    const { checksum, ...body } = receipt;
    if (!validBody(body) || checksum !== checksumOf(body) || Object.keys(receipt).length !== FIELDS.length) {
      return { ok: false, detail: "refused: not a valid receipt" };
    }
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const name = `${receipt.observed_at.replace(/[-:]/g, "")}-pr${receipt.pr}-${pid}-${random()}.json`;
    tmp = path.join(dir, `.tmp-${name}`);
    const fd = fs.openSync(tmp, "wx", 0o600);
    try {
      fs.writeSync(fd, `${JSON.stringify(receipt)}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, path.join(dir, name));
    return { ok: true, file: name };
  } catch (e) {
    return { ok: false, detail: `receipt not written: ${e?.code ?? "error"}${tmp ? " (a .tmp- file may remain)" : ""}` };
  }
}

/** Parse one published receipt file's text: the closed schema with a matching checksum, or null. */
export function parseReceipt(text) {
  try {
    if (typeof text !== "string" || !text.endsWith("\n") || text.indexOf("\n") !== text.length - 1) return null;
    const r = JSON.parse(text);
    if (r === null || typeof r !== "object" || Array.isArray(r)) return null;
    const keys = Object.keys(r);
    if (keys.length !== FIELDS.length || !FIELDS.every((f) => Object.hasOwn(r, f))) return null;
    const { checksum, ...body } = r;
    if (!validBody(body) || checksum !== checksumOf(body)) return null;
    return Object.freeze(r);
  } catch {
    return null;
  }
}

/**
 * Read every receipt. Invalid, unreadable or possibly-missing data is reported,
 * never skipped silently: `complete` is true only when the directory was read,
 * every published file is a valid receipt and no write was interrupted.
 */
export function readReceipts(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch (e) {
    return Object.freeze({ receipts: [], invalid: [], interrupted: 0, unreadable: e?.code ?? "error", complete: false });
  }
  const receipts = [];
  const invalid = [];
  let interrupted = 0;
  for (const name of names.sort()) {
    if (name.startsWith(".tmp-")) {
      interrupted++;
      continue;
    }
    if (!PUBLISHED.test(name)) {
      invalid.push({ file: name, why: "not a receipt file name" });
      continue;
    }
    let text;
    try {
      text = readFileSync(path.join(dir, name), "utf8");
    } catch (e) {
      invalid.push({ file: name, why: `unreadable: ${e?.code ?? "error"}` });
      continue;
    }
    const r = parseReceipt(text);
    if (r === null) invalid.push({ file: name, why: "not a valid receipt" });
    else receipts.push(r);
  }
  return Object.freeze({
    receipts,
    invalid,
    interrupted,
    unreadable: null,
    complete: invalid.length === 0 && interrupted === 0,
  });
}
