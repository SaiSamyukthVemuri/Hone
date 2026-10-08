// Named check rows for the diagnostic receipts (README "Diagnostic receipts"; operator: minimal, append-only,
// diagnostic; valid append; no torn or malformed accepted record; interrupted writes; concurrent writers;
// unreadable/invalid data never clean; no credentials or unnecessary personal data).
// The API is passed in, so the same rows run against mutants.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import crypto from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { tmp as tmpUnderRoot } from "./support/tmp";
// @ts-expect-error untyped support module
import { canon, checksumOf, receiptProblem } from "./support/receipt-mutants.mjs";
import { markRestrictive } from "./support/tmp";

export type ReceiptsApi = { receiptFrom: (r: any) => any; writeReceipt: (d: string, r: any) => any; readReceipts: (d: string) => any; parseReceipt: (t: string) => any };

const HEAD = "fe62f51f0fd95fc97d2e21eef71d179e2e701358";
const TOOL = "eng-loop-v1@efc7e1865d434ed7ea44aba33cd12b0c2703bcd0";
const TOKEN = "ghp_VERIFYbcFakeToken0Canary0000000000000";
const CHILD = path.resolve(__dirname, "support/receipt-child.mjs");
const RACE = path.resolve(__dirname, "support/receipt-race.mjs");
const LINKCRASH = path.resolve(__dirname, "support/receipt-linkcrash.mjs");
const TOCTOU = path.resolve(__dirname, "support/receipt-toctou.mjs");
/** The final-name pattern observed from the black box; anything else in the directory is not a receipt. */
export const FINAL = /^\d{8}T\d{6}Z-pr\d+-\d+-[0-9a-f]{16}\.json$/;
/** chmod cannot make anything unreadable for root; those two R-ENTRIES cases need a non-root user (noted, not hidden). */
export const IS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;

export function tmp(prefix = "rcpt-") {
  return tmpUnderRoot(prefix);
}

/** Independent validator: README "Diagnostic receipts" (pass 2 documents the schema, the checksum and the reasons
 * rule; tool_version is null or the report's toolVersion format). Shared with the child scripts. */
export function validReceiptText(text: string): { ok: boolean; why?: string; rec?: any } {
  let rec: any;
  if (!text.endsWith("}\n") && !text.endsWith("}")) return { ok: false, why: "not a complete JSON object" };
  try {
    rec = JSON.parse(text);
  } catch (e: any) {
    return { ok: false, why: `JSON: ${e.message}` };
  }
  const problem = receiptProblem(rec);
  return problem === null ? { ok: true, rec } : { ok: false, why: problem };
}

export function report(over: any = {}) {
  return {
    schema: "eng-loop-v1/shepherd@1",
    pr: 800,
    headSha: HEAD,
    baseRef: "claude/build-hone-saas-hOex7",
    production: { ref: "claude/build-hone-saas-hOex7", tip: "6cdd830b0bcc5e3532016bc612bd0298db3533fb" },
    observedAt: "2026-10-07T20:00:00Z",
    toolVersion: TOOL,
    evidenceHash: "a47b5c9b49166c617dba56d768a414dff15fc79e012692e77f1b77d30a3d18d2",
    decision: "FINDINGS_OPEN",
    reasonCodes: ["FINDINGS_OPEN"],
    blocking: { changesRequested: false, openThreads: 1 },
    sourceReferences: ["https://github.com/SaiSamyukthVemuri/Hone/pull/800"],
    nextAction: "Fix the open finding.",
    humanMergeRequired: true,
    ...over,
  };
}

const MAX = 25;
function rowResult(row: string, clause: string) {
  const r: any = { row, clause, checked: 0, violations: [] as any[], total: 0, notes: [] as string[] };
  r.add = (id: string, msg: string) => {
    r.total += 1;
    if (r.violations.length < MAX) r.violations.push({ id, msg });
  };
  return r;
}
const safe = <T>(f: () => T): { v?: T; e?: any } => {
  try {
    return { v: f() };
  } catch (e) {
    return { e };
  }
};

/** Whatever the reader accepts must pass the independent validator; bad data must make it incomplete. */
function readerInvariant(r: any, api: ReceiptsApi, dir: string, id: string, expectComplete: boolean | null) {
  const res = safe(() => api.readReceipts(dir));
  if (res.e) return r.add(id, `readReceipts threw ${res.e?.message}`);
  const read = res.v;
  for (const rec of read.receipts ?? []) {
    const v = validReceiptText(JSON.stringify(rec));
    if (!v.ok) r.add(id, `reader accepted an invalid record (${v.why}): ${JSON.stringify(rec).slice(0, 100)}`);
  }
  if (expectComplete !== null && read.complete !== expectComplete) r.add(id, `complete ${read.complete}, want ${expectComplete} (${JSON.stringify({ invalid: read.invalid?.length ?? read.invalid, interrupted: read.interrupted, unreadable: read.unreadable })})`);
  return read;
}

// ---------------------------------------------------------------------------------------------------------------

export function checkFrom(api: ReceiptsApi) {
  const r = rowResult("R-FROM", "README: closed schema (pr, head, evidenceHash, decision, reasons, observed_at, tool_version, checksum); no credential, login, detail or URL");
  const sensitive = report({
    decision: "UNKNOWN",
    reasonCodes: ["read_failed"],
    blocking: { row: "collection", detail: `gh: HTTP 401 token ${TOKEN} for SaiSamyukthVemuri https://api.github.com/x` },
    evidenceHash: null,
    headSha: null,
    extra: { login: "chatgpt-codex-connector" },
  });
  const legacy = safe(() => api.receiptFrom(report({ toolVersion: "eng-loop-v1@unknown" })));
  r.notes.push(`tool_version "eng-loop-v1@unknown" (pass-1 placeholder; SPEC-SILENT for receipts): ${legacy.e ? "threw" : legacy.v?.ok ? "accepted" : "refused"}`);
  for (const [n, rep] of [["decided", report()], ["sensitive UNKNOWN", sensitive], ["candidate", report({ decision: "CANDIDATE_READY_FOR_HUMAN_REVIEW", reasonCodes: ["CANDIDATE_READY_FOR_HUMAN_REVIEW"] })], ["no tool version (pass 2: null)", report({ toolVersion: null })]] as [string, any][]) {
    r.checked += 1;
    const x = safe(() => api.receiptFrom(rep));
    if (x.e || !x.v?.ok) {
      r.add(n, `receiptFrom refused a valid report: ${x.e?.message ?? x.v?.detail}`);
      continue;
    }
    const text = JSON.stringify(x.v.receipt);
    const v = validReceiptText(text);
    if (!v.ok) r.add(n, `receipt invalid: ${v.why}`);
    if (/ghp_|github_pat_|https?:\/\/|SaiSamyukthVemuri|chatgpt-codex|detail|login/.test(text)) r.add(n, `receipt holds sensitive data: ${text.slice(0, 160)}`);
    const rec = x.v.receipt;
    if (rec.pr !== rep.pr || rec.head !== rep.headSha || rec.evidenceHash !== rep.evidenceHash || rec.decision !== rep.decision || canon(rec.reasons) !== canon(rep.reasonCodes) || rec.observed_at !== rep.observedAt || rec.tool_version !== rep.toolVersion) r.add(n, "receipt disagrees with the report");
  }
  const refuse: [string, any][] = [
    ["decision outside the 13", report({ decision: "MERGE_NOW", reasonCodes: ["MERGE_NOW"] })],
    ["open-set UNKNOWN reason", report({ decision: "UNKNOWN", reasonCodes: ["wrong_base"] })],
    ["reasons disagree with decision (pass 2: reasons is [decision])", report({ decision: "CANDIDATE_READY_FOR_HUMAN_REVIEW", reasonCodes: ["read_failed"] })],
    ["UNKNOWN with reasons [UNKNOWN]", report({ decision: "UNKNOWN", reasonCodes: ["UNKNOWN"] })],
    ["two reasons", report({ decision: "UNKNOWN", reasonCodes: ["read_failed", "malformed"] })],
    ["pr not a positive integer", report({ pr: "800" })],
    ["head not 40 hex", report({ headSha: "fe62f51f0f" })],
    ["tool version carrying a token", report({ toolVersion: `eng-loop-v1@${TOKEN}` })],
    ["observedAt not a time", report({ observedAt: "yesterday" })],
    ["null", null],
    ["a string", "report"],
  ];
  for (const [n, rep] of refuse) {
    r.checked += 1;
    const x = safe(() => api.receiptFrom(rep));
    if (x.e) r.add(n, `receiptFrom threw ${x.e?.message}`);
    else if (x.v?.ok) r.add(n, `receiptFrom accepted it: ${JSON.stringify(x.v.receipt).slice(0, 120)}`);
  }
  return r;
}

export function checkAppend(api: ReceiptsApi) {
  const r = rowResult("R-APPEND", "operator: valid append; README: each receipt one write-once file; read back complete");
  const dir = tmp();
  const written: any[] = [];
  for (let i = 0; i < 6; i += 1) {
    r.checked += 1;
    const rec = api.receiptFrom(report({ pr: 800 + (i % 2), decision: i % 3 === 0 ? "CI_PENDING" : "FINDINGS_OPEN", reasonCodes: [i % 3 === 0 ? "CI_PENDING" : "FINDINGS_OPEN"] })).receipt;
    const w = safe(() => api.writeReceipt(dir, rec));
    if (w.e || !w.v?.ok) r.add(`write ${i}`, `failed: ${w.e?.message ?? w.v?.detail}`);
    else written.push(rec);
  }
  {
    const nul = api.receiptFrom(report({ toolVersion: null, pr: 900 }));
    if (!nul.ok) r.add("tool_version null", `receiptFrom refused: ${nul.detail}`);
    else if (api.writeReceipt(dir, nul.receipt).ok) written.push(nul.receipt);
    else r.add("tool_version null", "write failed");
  }
  // Two identical receipts are two records (append-only, nothing collapses).
  const same = api.receiptFrom(report()).receipt;
  for (const k of [0, 1]) {
    const w = api.writeReceipt(dir, same);
    if (w.ok) written.push(same);
    else r.add(`identical ${k}`, `failed: ${w.detail}`);
  }
  const files = fs.readdirSync(dir);
  if (files.length !== written.length) r.add("files", `${files.length} files for ${written.length} successful writes`);
  for (const f of files) {
    const v = validReceiptText(fs.readFileSync(path.join(dir, f), "utf8"));
    if (!v.ok) r.add(f, `written file invalid: ${v.why}`);
    if ((fs.statSync(path.join(dir, f)).mode & 0o077) !== 0) r.notes.push(`${f} is group/world accessible`);
  }
  const read = readerInvariant(r, api, dir, "read", true);
  if (read && canon((read.receipts ?? []).map(canon).sort()) !== canon(written.map(canon).sort())) r.add("read", `read ${read.receipts?.length} receipts, wrote ${written.length}`);
  return r;
}

export function checkTamper(api: ReceiptsApi) {
  const r = rowResult("R-TAMPER", "operator: no torn or malformed accepted record; README: a checksum; an invalid file makes the read complete: false");
  const tampers: [string, (rec: any) => string][] = [
    ["decision changed, checksum kept", (rec) => JSON.stringify({ ...rec, decision: "CANDIDATE_READY_FOR_HUMAN_REVIEW", reasons: ["CANDIDATE_READY_FOR_HUMAN_REVIEW"] }) + "\n"],
    ["head changed, checksum kept", (rec) => JSON.stringify({ ...rec, head: "0".repeat(40) }) + "\n"],
    ["checksum zeroed", (rec) => JSON.stringify({ ...rec, checksum: "0".repeat(64) }) + "\n"],
    ["checksum removed", (rec) => { const { checksum, ...rest } = rec; void checksum; return JSON.stringify(rest) + "\n"; }],
    ["extra field, checksum recomputed", (rec) => { const x = { ...rec, detail: "x" }; return JSON.stringify({ ...x, checksum: checksumOf(x) }) + "\n"; }],
    ["token field, checksum recomputed", (rec) => { const x = { ...rec, token: TOKEN }; return JSON.stringify({ ...x, checksum: checksumOf(x) }) + "\n"; }],
    ["decision outside the 13, checksum recomputed", (rec) => { const x = { ...rec, decision: "MERGE_NOW", reasons: ["MERGE_NOW"] }; return JSON.stringify({ ...x, checksum: checksumOf(x) }) + "\n"; }],
    ["open-set reason, checksum recomputed", (rec) => { const x = { ...rec, decision: "UNKNOWN", reasons: ["wrong_base"] }; return JSON.stringify({ ...x, checksum: checksumOf(x) }) + "\n"; }],
    ["pr as string, checksum recomputed", (rec) => { const x = { ...rec, pr: "800" }; return JSON.stringify({ ...x, checksum: checksumOf(x) }) + "\n"; }],
    ["reasons disagree with decision, checksum recomputed (pass 2)", (rec) => { const x = { ...rec, decision: "CANDIDATE_READY_FOR_HUMAN_REVIEW", reasons: ["read_failed"] }; return JSON.stringify({ ...x, checksum: checksumOf(x) }) + "\n"; }],
    ["UNKNOWN with two reasons, checksum recomputed (pass 2)", (rec) => { const x = { ...rec, decision: "UNKNOWN", reasons: ["read_failed", "malformed"] }; return JSON.stringify({ ...x, checksum: checksumOf(x) }) + "\n"; }],
    ["4097 bytes: a valid record padded past 4 KB (pass 2)", (rec) => { const t = JSON.stringify(rec); return t + " ".repeat(4097 - t.length - 1) + "\n"; }],
    ["schema bumped, checksum recomputed", (rec) => { const x = { ...rec, schema: "eng-loop-v1/receipt@2" }; return JSON.stringify({ ...x, checksum: checksumOf(x) }) + "\n"; }],
    ["truncated", (rec) => JSON.stringify(rec).slice(0, 120)],
    ["truncated by one byte", (rec) => JSON.stringify(rec).slice(0, -1)],
    ["empty", () => ""],
    ["NUL bytes", (rec) => JSON.stringify(rec).replace(/,/, ",\u0000")],
    ["BOM prefix", (rec) => "﻿" + JSON.stringify(rec) + "\n"],
    ["two records concatenated", (rec) => JSON.stringify(rec) + JSON.stringify(rec)],
    ["trailing garbage", (rec) => JSON.stringify(rec) + "\nxyz"],
    ["JSON array", (rec) => JSON.stringify([rec])],
    ["JSON null", () => "null"],
  ];
  for (const [n, f] of tampers) {
    r.checked += 1;
    const dir = tmp();
    const good = api.receiptFrom(report()).receipt;
    const w = api.writeReceipt(dir, good);
    if (!w.ok) {
      r.add(n, `setup write failed: ${w.detail}`);
      continue;
    }
    const badName = w.file.replace(/[0-9a-f]{16}\.json$/, "0123456789abcdef.json");
    fs.writeFileSync(path.join(dir, badName), f(good));
    const read = readerInvariant(r, api, dir, n, false);
    if (read && (read.receipts ?? []).length !== 1) r.add(n, `${read.receipts?.length} receipts accepted, want the 1 good one`);
    // The 4 KB limit is a rule of reading files (README "Reading"); parseReceipt parses text, so the oversize case is
    // judged by readReceipts above only.
    if (n.startsWith("4097 bytes")) continue;
    const p = safe(() => api.parseReceipt(fs.readFileSync(path.join(dir, badName), "utf8")));
    if (p.e) r.add(n, `parseReceipt threw ${p.e?.message}`);
    else if (p.v !== null) r.add(n, "parseReceipt accepted it");
  }
  return r;
}

/** Probe: a receipt file whose tool_version is the pass-1 placeholder (SPEC-SILENT: legacy record or invalid). */
export function probeLegacyToolVersion(api: ReceiptsApi): string {
  const dir = tmp();
  const good = api.receiptFrom(report()).receipt;
  const x: any = { ...good, tool_version: "eng-loop-v1@unknown" };
  delete x.checksum;
  fs.writeFileSync(path.join(dir, "20261007T200000Z-pr800-1-00000000000000ee.json"), JSON.stringify({ ...x, checksum: checksumOf(x) }) + "\n");
  const read = api.readReceipts(dir);
  return `reader on a tool_version "eng-loop-v1@unknown" record: complete ${read.complete}, accepted ${read.receipts?.length}`;
}

export function checkDirEntries(api: ReceiptsApi) {
  const r = rowResult("R-ENTRIES", "README: an invalid file, or an unreadable directory, makes the read complete: false");
  if (IS_ROOT) r.notes.push("running as root: the two chmod-unreadable cases cannot be constructed and were not run");
  const cases: [string, (dir: string) => void, boolean | null][] = [
    ["missing directory", (dir) => fs.rmSync(dir, { recursive: true }), false],
    ["directory is a file", (dir) => { fs.rmSync(dir, { recursive: true }); fs.writeFileSync(dir, "x"); }, false],
    ...(IS_ROOT ? [] : ([["unreadable directory", (dir: string) => (markRestrictive(dir), fs.chmodSync(dir, 0o000)), false]] as [string, (dir: string) => void, boolean | null][])),
    ...(IS_ROOT ? [] : ([["unreadable receipt file", (dir: string) => { const f = fs.readdirSync(dir)[0] ?? "20261007T200000Z-pr800-1-00000000000000dd.json"; if (!fs.existsSync(path.join(dir, f))) fs.writeFileSync(path.join(dir, f), "{}"); markRestrictive(path.join(dir, f)); fs.chmodSync(path.join(dir, f), 0o000); }, false]] as [string, (dir: string) => void, boolean | null][])),
    ["subdirectory named like a receipt", (dir) => fs.mkdirSync(path.join(dir, "20261007T200000Z-pr800-1-0123456789abcdef.json")), false],
    ["foreign file", (dir) => fs.writeFileSync(path.join(dir, "README.md"), "notes"), false],
    ["dot-file temp", (dir) => fs.writeFileSync(path.join(dir, ".20261007T200000Z-pr800-1-0123456789abcdef.json.tmp"), "{\"schema\":"), false],
    ["leftover in the writer's own temp naming", (dir) => fs.writeFileSync(path.join(dir, ".tmp-20261007T200000Z-pr800-1-0123456789abcdef.json"), "{\"schema\":"), false],
    // Pass 2: "only regular files are read — never through a symlink".
    ["symlink to a valid receipt elsewhere", (dir) => { const other = tmp(); const rec = api.receiptFrom(report({ pr: 801 })).receipt; const w = api.writeReceipt(other, rec); fs.symlinkSync(path.join(other, w.file), path.join(dir, w.file)); }, false],
    ["dangling symlink", (dir) => fs.symlinkSync("/nonexistent/receipt.json", path.join(dir, "20261007T200000Z-pr800-1-00000000000000ff.json")), false],
    ["symlink to a directory", (dir) => fs.symlinkSync(os.tmpdir(), path.join(dir, "20261007T200000Z-pr800-1-00000000000000f1.json")), false],
    ["socket named like a receipt", (dir) => { spawnSync(process.execPath, ["-e", `require("net").createServer().listen(${JSON.stringify(path.join(dir, "20261007T200000Z-pr800-1-00000000000000f2.json"))}, () => process.exit(0))`]); }, false],
    ["a valid record padded to exactly 4 KB (SPEC-SILENT: within the limit)", (dir) => { const rec = api.receiptFrom(report({ pr: 802 })).receipt; const t = JSON.stringify(rec); fs.writeFileSync(path.join(dir, "20261007T200000Z-pr802-1-00000000000000f3.json"), t + " ".repeat(4096 - t.length - 1) + "\n"); }, null],
    ["hard link to a valid receipt elsewhere (a regular file)", (dir) => { const other = tmp(); const rec = api.receiptFrom(report({ pr: 803 })).receipt; const w = api.writeReceipt(other, rec); fs.linkSync(path.join(other, w.file), path.join(dir, w.file)); }, null],
  ];
  for (const [n, mk, want] of cases) {
    r.checked += 1;
    const parent = tmp();
    const dir = path.join(parent, "rc");
    fs.mkdirSync(dir);
    const setup = safe(() => {
      api.writeReceipt(dir, api.receiptFrom(report()).receipt);
      mk(dir);
    });
    if (setup.e) {
      r.add(n, `setup failed: ${setup.e?.message}`);
      continue;
    }
    const read = readerInvariant(r, api, dir, n, want);
    if (want === null && read) r.notes.push(`${n}: complete ${read.complete}, receipts ${read.receipts?.length}`);
    if (n.startsWith("symlink to a valid") && read && (read.receipts ?? []).some((x: any) => x.pr === 801)) r.add(n, "the reader followed a symlink and accepted its target");
    try {
      fs.chmodSync(dir, 0o700);
      for (const f of fs.readdirSync(dir)) if (!fs.lstatSync(path.join(dir, f)).isSymbolicLink()) fs.chmodSync(path.join(dir, f), 0o600);
    } catch {
      /* cleanup only */
    }
  }
  return r;
}

/** FIFO and /dev/zero entries: the reader must neither hang nor exhaust memory. Run in a child with a timeout. */
export function checkHang(receiptsPath: string, mutant = "real", childTimeoutMs = 15_000) {
  const r = rowResult("R-HANG", "operator: unreadable data is never clean; a hostile directory entry must not hang the reader");
  const cases: [string, (dir: string) => void][] = [
    ["FIFO named like a receipt", (dir) => spawnSync("mkfifo", [path.join(dir, "20261007T200000Z-pr800-1-00000000000000aa.json")])],
    ["symlink to /dev/zero named like a receipt", (dir) => fs.symlinkSync("/dev/zero", path.join(dir, "20261007T200000Z-pr800-1-00000000000000bb.json"))],
    ["16 MiB file named like a receipt", (dir) => fs.writeFileSync(path.join(dir, "20261007T200000Z-pr800-1-00000000000000cc.json"), Buffer.alloc(16 * 1024 * 1024, 0x20))],
  ];
  for (const [n, mk] of cases) {
    r.checked += 1;
    const dir = tmp();
    mk(dir);
    const script = `import { receiptsApi } from ${JSON.stringify(path.resolve(__dirname, "support/receipt-mutants.mjs"))};\nconst api = await receiptsApi(${JSON.stringify(receiptsPath)}, ${JSON.stringify(mutant)});\nconst t = Date.now(); const x = api.readReceipts(${JSON.stringify(dir)});\nprocess.stdout.write(JSON.stringify({ complete: x.complete, n: x.receipts.length, ms: Date.now() - t }));`;
    const c = spawnSync(process.execPath, ["--max-old-space-size=256", "--input-type=module", "-e", script], { encoding: "utf8", timeout: childTimeoutMs, killSignal: "SIGKILL" });
    if (c.error || c.signal) r.add(n, `reader did not return within ${childTimeoutMs / 1000} s (${c.signal ?? c.error?.message})`);
    else if (c.status !== 0) r.add(n, `reader crashed: ${c.stderr.split("\n").find((l) => /Error|heap/.test(l)) ?? c.status}`);
    else {
      const out = JSON.parse(c.stdout);
      if (out.complete !== false) r.add(n, `complete ${out.complete}`);
      r.notes.push(`${n}: ${out.ms} ms`);
    }
  }
  return r;
}

// ---------------------------------------------------------------------------------------------------------------
// Fault injection at the fs layer (black box: whatever the writer calls, the fault lands there).

function withFsFault<T>(name: string, mode: "throw" | "half", fn: () => T, code = "EIO") {
  const orig = (fs as any)[name];
  const calls: any[] = [];
  const renames: string[] = [];
  const origRename = fs.renameSync;
  (fs as any)[name] = function (...args: any[]) {
    calls.push(args.map((a) => (typeof a === "string" ? a : typeof a)));
    if (mode === "half" && (name === "writeSync" || name === "writeFileSync")) {
      const data = args[1];
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
      orig.call(fs, args[0], buf.subarray(0, Math.floor(buf.length / 2)));
    }
    throw Object.assign(new Error(`injected ${name} fault`), { code });
  };
  if (name !== "renameSync") {
    (fs as any).renameSync = function (from: any, to: any, ...rest: any[]) {
      renames.push(String(to));
      return (origRename as any).call(fs, from, to, ...rest);
    };
  }
  syncBuiltinESMExports();
  try {
    const out = safe(fn);
    return { ...out, calls, renames };
  } finally {
    (fs as any)[name] = orig;
    (fs as any).renameSync = origRename;
    syncBuiltinESMExports();
  }
}

export function checkFaults(api: ReceiptsApi) {
  const r = rowResult("R-FAULT", "README (pass 2): exclusive temporary file, fsynced, then hard-linked to its final name, which fails rather than replace; the temporary name removed; a reader never sees a torn record; an interrupted write makes the read complete: false");
  const faults: [string, "throw" | "half", string][] = [
    ["openSync", "throw", "EIO"],
    ["writeSync", "half", "EIO"],
    ["writeFileSync", "half", "EIO"],
    ["fsyncSync", "throw", "EIO"],
    ["closeSync", "throw", "EIO"],
    ["renameSync", "throw", "EIO"],
    ["linkSync", "throw", "EIO"],
    ["linkSync", "throw", "EPERM"],
    ["linkSync", "throw", "EEXIST"],
    ["linkSync", "throw", "EXDEV"],
    ["unlinkSync", "throw", "EIO"],
  ];
  for (const [fn, mode, code] of faults) {
    r.checked += 1;
    const id = `${fn} ${code}`;
    const dir = tmp();
    const rec = api.receiptFrom(report()).receipt;
    const res = withFsFault(fn, mode, () => api.writeReceipt(dir, rec), code);
    const hit = res.calls.length > 0;
    r.notes.push(`${id}: ${hit ? "hit" : "not used"}${hit ? `, writeReceipt ${res.e ? "threw " + res.e.message : JSON.stringify(res.v)}` : ""}`);
    for (const to of res.renames) if (FINAL.test(path.basename(to))) r.add(id, `a receipt was published by rename (${path.basename(to)}), which replaces rather than fails`);
    if (!hit) continue;
    if (res.e) r.add(id, `writeReceipt threw on an injected ${fn} fault: ${res.e.message}`);
    const entries = fs.readdirSync(dir);
    const finals = entries.filter((x) => FINAL.test(x));
    if (res.v?.ok && (finals.length !== 1 || !validReceiptText(fs.readFileSync(path.join(dir, finals[0]), "utf8")).ok)) r.add(id, `reported ok but the directory holds ${JSON.stringify(entries)}`);
    if (fn === "linkSync" && finals.length > 0) r.add(id, `link failed (${code}) yet a final record exists: ${finals.join(", ")}`);
    if (fn === "linkSync" && res.v?.ok) r.add(id, `link failed (${code}) yet writeReceipt reported ok`);
    // README (final pass): a receipt whose temporary name cannot be removed after it was published is still written.
    if (fn === "unlinkSync" && finals.length === 1 && res.v?.ok !== true) r.add(id, `the record was published but writeReceipt reported ${JSON.stringify(res.v ?? res.e?.message)}`);
    if (fn === "unlinkSync") r.notes.push(`${id}: writeReceipt ${JSON.stringify(res.v)}`);
    for (const f of finals) {
      const v = validReceiptText(fs.readFileSync(path.join(dir, f), "utf8"));
      if (!v.ok) r.add(id, `a torn final-named record after a ${fn} fault: ${f} (${v.why})`);
    }
    const leftovers = entries.filter((x) => !FINAL.test(x));
    const read = readerInvariant(r, api, dir, `${id} fault`, leftovers.length > 0 ? false : null);
    if (read && (read.receipts ?? []).length !== finals.length) r.add(id, `reader counted ${read.receipts?.length} receipts for ${finals.length} published record(s)`);
    if (leftovers.length) r.notes.push(`${id}: left ${leftovers.join(", ")}`);
  }
  return r;
}

/** Forced name collision (constant randomness): a second record must never replace the first (write-once). */
export function checkCollision(api: ReceiptsApi) {
  const r = rowResult("R-COLLIDE", "README (pass 2): write-once by construction — a name collision fails the write and never replaces another receipt; operator: append-only");
  r.checked += 1;
  const dir = tmp();
  const a = api.receiptFrom(report({ decision: "CI_PENDING", reasonCodes: ["CI_PENDING"] })).receipt;
  const b = api.receiptFrom(report({ decision: "FINDINGS_OPEN", reasonCodes: ["FINDINGS_OPEN"] })).receipt;
  // Make every randomness source constant, so two writes in one process and one second get the same name.
  const restores: (() => void)[] = [];
  const override = (obj: any, key: string, value: any) => {
    if (!obj) return;
    const desc = Object.getOwnPropertyDescriptor(obj, key);
    try {
      Object.defineProperty(obj, key, { value, configurable: true, writable: true, enumerable: desc?.enumerable ?? true });
      restores.push(() => (desc ? Object.defineProperty(obj, key, desc) : delete obj[key]));
    } catch {
      /* not overridable: that source stays random */
    }
  };
  override(crypto, "randomBytes", (n: number, cb?: any) => {
    const buf = Buffer.alloc(n, 7);
    return cb ? cb(null, buf) : buf;
  });
  override(crypto, "randomUUID", () => "77777777-7777-4777-8777-777777777777");
  override(crypto, "getRandomValues", (arr: any) => (arr.fill(7), arr));
  override(crypto, "randomInt", () => 7);
  override((globalThis as any).crypto, "randomUUID", () => "77777777-7777-4777-8777-777777777777");
  override((globalThis as any).crypto, "getRandomValues", (arr: any) => (arr.fill(7), arr));
  override(Math, "random", () => 0.5);
  syncBuiltinESMExports();
  let wa: any, wb: any;
  try {
    wa = safe(() => api.writeReceipt(dir, a));
    wb = safe(() => api.writeReceipt(dir, b));
  } finally {
    for (const f of restores.reverse()) f();
    syncBuiltinESMExports();
  }
  const files = fs.readdirSync(dir);
  const contents = files.map((f) => validReceiptText(fs.readFileSync(path.join(dir, f), "utf8")).rec);
  const haveA = contents.some((c) => c && c.decision === "CI_PENDING");
  const okB = wb.v?.ok === true;
  r.notes.push(`names: ${JSON.stringify(files)}; first ${JSON.stringify(wa.v ?? wa.e?.message)}; second ${JSON.stringify(wb.v ?? wb.e?.message)}`);
  if (wa.v?.ok && !haveA) r.add("collision", "the first record was replaced by the second (not write-once)");
  if (wa.v?.ok && okB) r.add("collision", "a name collision did not fail the second write (README pass 2: it fails the write)");
  if (okB && !contents.some((c) => c && c.decision === "FINDINGS_OPEN")) r.add("collision", "the second write reported ok but its record is not on disk");
  if (wa.v?.ok && okB && files.length !== 2) r.add("collision", `both writes reported ok but ${files.length} files exist`);
  readerInvariant(r, api, dir, "after collision", null);
  return r;
}

function runChild(receiptsPath: string, mutant: string, dir: string, mode: string, count: number, id: number): Promise<{ code: number | null; signal: string | null; out: string }> {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [CHILD, receiptsPath, mutant, dir, mode, String(count), String(id)]);
    let out = "";
    c.stdout.on("data", (d) => (out += d));
    c.on("close", (code, signal) => resolve({ code, signal, out }));
  });
}

export async function checkConcurrency(api: ReceiptsApi, receiptsPath: string, mutant = "real", children = 12, writes = 40) {
  const r = rowResult("R-CONC", "operator: concurrent-writer behaviour; README: concurrent writers cannot collide");
  const dir = tmp();
  const kids = await Promise.all(Array.from({ length: children }, (_, i) => runChild(receiptsPath, mutant, dir, "batch", writes, i)));
  let ok = 0;
  for (const k of kids) {
    r.checked += 1;
    if (k.code !== 0) {
      r.add("child", `exit ${k.code}`);
      continue;
    }
    ok += JSON.parse(k.out).ok;
  }
  const files = fs.readdirSync(dir);
  if (files.length !== ok) r.add("count", `${files.length} files on disk for ${ok} successful writes (lost or merged records)`);
  for (const f of files) if (!validReceiptText(fs.readFileSync(path.join(dir, f), "utf8")).ok) r.add(f, "invalid record on disk");
  const read = readerInvariant(r, api, dir, "read", true);
  if (read && read.receipts?.length !== ok) r.add("read", `read ${read.receipts?.length}, wrote ${ok}`);
  return r;
}

export async function checkCrash(api: ReceiptsApi, receiptsPath: string, mutant = "real", rounds = 40) {
  const r = rowResult("R-CRASH", "operator: safe handling of interrupted writes; README: a reader never sees a torn record; an interrupted write → complete: false");
  const dir = tmp();
  for (let i = 0; i < rounds; i += 1) {
    r.checked += 1;
    const c = spawn(process.execPath, [CHILD, receiptsPath, mutant, dir, "loop", "0", String(i)]);
    await new Promise((res) => setTimeout(res, 60 + ((i * 37) % 140)));
    c.kill("SIGKILL");
    await new Promise((res) => c.on("close", res));
  }
  const files = fs.readdirSync(dir);
  const finals = files.filter((f) => FINAL.test(f));
  const others = files.filter((f) => !FINAL.test(f));
  let torn = 0;
  for (const f of finals) {
    const v = validReceiptText(fs.readFileSync(path.join(dir, f), "utf8"));
    if (!v.ok) {
      torn += 1;
      if (torn <= 3) r.add(f, `torn or invalid final record after SIGKILL (${v.why})`);
    }
  }
  if (torn > 3) r.add("torn", `${torn} torn final records in total`);
  r.notes.push(`${finals.length} final records, ${others.length} other entries after ${rounds} kills: ${others.slice(0, 3).join(", ")}`);
  const read = readerInvariant(r, api, dir, "read after crashes", others.length > 0 || torn > 0 ? false : true);
  if (read && read.receipts?.length !== finals.length - torn) r.add("read", `read ${read.receipts?.length} receipts, ${finals.length - torn} valid finals on disk`);
  if (read && others.length > 0 && !(read.interrupted > 0 || (read.invalid?.length ?? 0) > 0)) r.add("read", "leftover temporary files were not reported as interrupted or invalid");
  return r;
}

// ---------------------------------------------------------------------------------------------------------------
// Pass 2: races against the reader, and a crash between publication and cleanup.

function runNode(args: string[], timeoutMs: number): Promise<{ code: number | null; signal: string | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, args);
    let out = "";
    let err = "";
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (err += d));
    const t = setTimeout(() => c.kill("SIGKILL"), timeoutMs);
    c.on("close", (code, signal) => {
      clearTimeout(t);
      resolve({ code, signal, out, err });
    });
  });
}

export const RACE_MODES = ["symlink", "fifo", "dir", "socket", "grow"] as const;

/** R-RACE: an entry swapped under the reader (TOCTOU between lstat/open/fstat), or a file growing during the read. */
export async function checkRace(api: ReceiptsApi, receiptsPath: string, mutant = "real", ms = 2500, modes: readonly string[] = RACE_MODES) {
  const r = rowResult("R-RACE", "README (pass 2): only regular files are read — never through a symlink, never blocking on a FIFO, never more than 4 KB — even while an entry is swapped or grows during the read");
  const valid = api.receiptFrom(report()).receipt;
  const other = api.receiptFrom(report({ pr: 999 })).receipt;
  for (const mode of modes) {
    r.checked += 1;
    const dir = tmp();
    const stage = tmp();
    const name = "20261007T200000Z-pr800-1-00000000000000aa.json";
    const [sw, rd] = await Promise.all([
      runNode([RACE, "swapper", mode, dir, name, stage, String(ms), JSON.stringify(valid) + "\n", JSON.stringify(other) + "\n"], ms + 20_000),
      runNode([RACE, "reader", receiptsPath, mutant, dir, String(ms)], ms + 15_000),
    ]);
    if (rd.signal) {
      r.add(mode, `the reader did not finish (killed after ${ms + 15_000} ms: a blocked read)`);
      continue;
    }
    let o: any;
    try {
      o = JSON.parse(rd.out);
    } catch {
      r.add(mode, `reader crashed: ${rd.err.split("\n").find((l) => /Error/.test(l)) ?? rd.code}`);
      continue;
    }
    r.notes.push(`${mode}: ${o.reads} reads, max ${o.maxMs} ms, ${o.accepted} accepted, swaps ${JSON.parse(sw.out || "{}").swaps ?? "?"}`);
    // A blocked read never returns (the child timeout catches it); a starved runner can make a single read slow, so the
    // per-read limit only flags reads far beyond any scheduling delay.
    if (o.maxMs > 10_000) r.add(mode, `a read took ${o.maxMs} ms (blocked on the swapped entry)`);
    if (o.foreign > 0) r.add(mode, `${o.foreign} record(s) read through a symlink were accepted`);
    if (o.invalidAccepted > 0) r.add(mode, `${o.invalidAccepted} torn or invalid record(s) accepted`);
    if (o.threw > 0) r.add(mode, `readReceipts threw ${o.threw} time(s): ${o.firstThrow}`);
    if (o.reads < 1) r.add(mode, "no read completed");
  }
  return r;
}

/** R-LINKCRASH: SIGKILL after the hard link and before the temporary name is removed. */
export async function checkLinkCrash(api: ReceiptsApi, receiptsPath: string) {
  const r = rowResult("R-LINKCRASH", "README (pass 2): a crash between the hard link and removing the temporary name leaves one published record, counted once; the interrupted write makes the read complete: false");
  r.checked += 1;
  const dir = tmp();
  const rec = api.receiptFrom(report()).receipt;
  const c = await runNode([LINKCRASH, receiptsPath, dir, JSON.stringify(rec)], 20_000);
  const entries = fs.readdirSync(dir);
  const finals = entries.filter((x) => FINAL.test(x));
  const others = entries.filter((x) => !FINAL.test(x));
  r.notes.push(`child ${c.signal ? "killed by " + c.signal : "exited " + c.code} (${c.out.slice(0, 80)}); finals ${finals.length}, others ${others.join(", ") || "none"}`);
  if (c.signal !== "SIGKILL") {
    r.add("setup", `the cleanup step was not intercepted (${c.out.slice(0, 80)})`);
    return r;
  }
  if (finals.length !== 1) r.add("publication", `${finals.length} published records after a crash in cleanup`);
  for (const f of finals) if (!validReceiptText(fs.readFileSync(path.join(dir, f), "utf8")).ok) r.add(f, "published record invalid");
  const read = readerInvariant(r, api, dir, "after the crash", others.length > 0 ? false : null);
  if (read && (read.receipts ?? []).length !== finals.length) r.add("count", `the reader counted ${read.receipts?.length} receipts for ${finals.length} published record (double count through the temporary name?)`);
  return r;
}

/** R-TOCTOU: the receipt-named entry is swapped exactly before the reader's own lstat, open, fstat or read call. */
export async function checkToctou(api: ReceiptsApi, receiptsPath: string, mutant = "real") {
  const r = rowResult("R-TOCTOU", "README (pass 2): never through a symlink, never blocking on a FIFO, only regular files — also when the entry is swapped between the reader's checks and its open, or between its open and fstat");
  const valid = api.receiptFrom(report()).receipt;
  const other = api.receiptFrom(report({ pr: 999 })).receipt;
  const name = "20261007T200000Z-pr800-1-00000000000000ab.json";
  for (const at of ["lstatSync", "openSync", "fstatSync", "readSync"]) {
    for (const kind of ["symlink", "fifo", "dir"]) {
      const id = `${kind} swapped in before ${at}`;
      const dir = tmp();
      const stage = tmp();
      fs.writeFileSync(path.join(dir, name), JSON.stringify(valid) + "\n");
      const hostile = path.join(stage, "h");
      if (kind === "symlink") {
        fs.writeFileSync(path.join(stage, "other.json"), JSON.stringify(other) + "\n");
        fs.symlinkSync(path.join(stage, "other.json"), hostile);
      } else if (kind === "fifo") spawnSync("mkfifo", [hostile]);
      else fs.mkdirSync(hostile);
      const c = await runNode([TOCTOU, receiptsPath, dir, name, hostile, at, mutant], 30_000);
      if (c.signal) {
        r.checked += 1;
        r.add(id, "the reader blocked (killed after 30 s)");
        continue;
      }
      let o: any;
      try {
        o = JSON.parse(c.out);
      } catch {
        r.checked += 1;
        r.add(id, `reader crashed: ${c.err.split("\n").find((l) => /Error/.test(l)) ?? c.code}`);
        continue;
      }
      if (!o.swapped) {
        r.notes.push(`${id}: the reader never calls ${at}`);
        continue;
      }
      r.checked += 1;
      if (o.prs.includes(999)) r.add(id, "accepted the record behind a symlink swapped in");
      if (o.ms > 10_000) r.add(id, `read took ${o.ms} ms`);
      r.notes.push(`${id}: complete ${o.complete}, accepted ${JSON.stringify(o.prs)}`);
    }
  }
  return r;
}

/** Run fn with every randomness source the writer could use made constant (same technique as R-COLLIDE). */
function withConstantRandom<T>(fn: () => T): T {
  const restores: (() => void)[] = [];
  const override = (obj: any, key: string, value: any) => {
    if (!obj) return;
    const desc = Object.getOwnPropertyDescriptor(obj, key);
    try {
      Object.defineProperty(obj, key, { value, configurable: true, writable: true, enumerable: desc?.enumerable ?? true });
      restores.push(() => (desc ? Object.defineProperty(obj, key, desc) : delete obj[key]));
    } catch {
      /* not overridable */
    }
  };
  override(crypto, "randomBytes", (n: number, cb?: any) => {
    const buf = Buffer.alloc(n, 7);
    return cb ? cb(null, buf) : buf;
  });
  override(crypto, "randomUUID", () => "77777777-7777-4777-8777-777777777777");
  override(crypto, "getRandomValues", (arr: any) => (arr.fill(7), arr));
  override(crypto, "randomInt", () => 7);
  override((globalThis as any).crypto, "randomUUID", () => "77777777-7777-4777-8777-777777777777");
  override((globalThis as any).crypto, "getRandomValues", (arr: any) => (arr.fill(7), arr));
  override(Math, "random", () => 0.5);
  syncBuiltinESMExports();
  try {
    return fn();
  } finally {
    for (const f of restores.reverse()) f();
    syncBuiltinESMExports();
  }
}

/** R-WSYMLINK: a symlink planted at the writer's temporary or final name (predictable here) is never written through. */
export function checkWriterSymlink(api: ReceiptsApi) {
  const r = rowResult("R-WSYMLINK", "README (pass 2): an exclusive temporary file, then a hard link that fails rather than replace — so a planted symlink at either name is never followed or replaced");
  const rec = api.receiptFrom(report()).receipt;
  const finalName = `20261007T200000Z-pr800-${process.pid}-0707070707070707.json`;
  for (const [n, planted] of [["temporary name", `.tmp-${finalName}`], ["final name", finalName]] as [string, string][]) {
    r.checked += 1;
    const dir = tmp();
    const outside = path.join(tmp(), "victim.txt");
    fs.writeFileSync(outside, "untouched\n");
    fs.symlinkSync(outside, path.join(dir, planted));
    const w = safe(() => withConstantRandom(() => api.writeReceipt(dir, rec)));
    const victim = fs.readFileSync(outside, "utf8");
    r.notes.push(`symlink at the ${n}: writeReceipt ${w.e ? "threw " + w.e.message : JSON.stringify(w.v)}; entries ${JSON.stringify(fs.readdirSync(dir))}`);
    if (victim !== "untouched\n") r.add(n, "the writer wrote through a planted symlink into a file outside the directory");
    if (w.e) r.add(n, `writeReceipt threw: ${w.e.message}`);
    if (fs.lstatSync(path.join(dir, planted)).isSymbolicLink() === false && n === "final name") r.add(n, "the planted entry at the final name was replaced");
    if (w.v?.ok && n === "final name") r.add(n, "a write reported ok although its final name was taken");
    readerInvariant(r, api, dir, `after the ${n} symlink`, false);
  }
  return r;
}
