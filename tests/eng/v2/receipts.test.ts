/* eslint-disable @typescript-eslint/no-explicit-any -- receipts are inspected as raw JSON on purpose */
import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import * as fsModule from "node:fs";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { parseReceipt, readReceipts, receiptFrom, writeReceipt } from "../../../scripts/eng/v2/receipts.mjs";

// ===========================================================================
// ENG-LOOP V1 05C: diagnostic receipts (directive §7). Proven here:
//   valid append; no torn or malformed record ever accepted; an interrupted
//   write is reported, never accepted; concurrent writers from separate
//   processes; unreadable or invalid data is never read as clean; no
//   credential or personal information can be recorded.
// ===========================================================================

const MODULE = path.resolve(__dirname, "..", "..", "..", "scripts/eng/v2/receipts.mjs");
const report = (over: any = {}) => ({
  pr: 810,
  headSha: "a".repeat(40),
  evidenceHash: "b".repeat(64),
  decision: "CI_PENDING",
  reasonCodes: ["CI_PENDING"],
  observedAt: "2026-10-07T21:00:00Z",
  toolVersion: `eng-loop-v1@${"c".repeat(40)}`,
  blocking: { detail: "github_pat_SHOULDNEVERBERECORDED0123456789" },
  nextAction: "x",
  sourceReferences: ["https://github.com/SaiSamyukthVemuri/Hone/pull/810"],
  ...over,
});
const tempDir = () => mkdtempSync(path.join(tmpdir(), "hone-receipts-test-"));

describe("receipts: write and read", () => {
  it("a written receipt reads back valid, complete, and carries only the closed fields", () => {
    const dir = tempDir();
    try {
      const built = receiptFrom(report());
      expect(built.ok).toBe(true);
      expect(JSON.stringify(built.receipt)).not.toContain("github_pat_");
      expect(JSON.stringify(built.receipt)).not.toContain("https://");
      const w = writeReceipt(dir, built.receipt);
      expect(w.ok).toBe(true);
      const r = readReceipts(dir);
      expect(r).toMatchObject({ complete: true, invalid: [], interrupted: 0 });
      expect(r.receipts).toEqual([built.receipt]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an UNKNOWN report with no head and no evidence hash is still a valid receipt", () => {
    const built = receiptFrom(report({ headSha: null, evidenceHash: null, decision: "UNKNOWN", reasonCodes: ["read_failed"] }));
    expect(built.ok).toBe(true);
  });

  it("the writer refuses anything outside the closed schema, and writes nothing", () => {
    const dir = tempDir();
    try {
      const good = receiptFrom(report()).receipt;
      const bad = [
        { ...good, checksum: "0".repeat(64) },
        { ...good, token: "github_pat_x" },
        { ...good, decision: "READY" },
        { ...good, reasons: ["looks fine"] },
        { ...good, tool_version: "eng-loop-v1@github_pat_x" },
      ];
      for (const r of bad) expect(writeReceipt(dir, r).ok).toBe(false);
      expect(receiptFrom(report({ decision: "READY" })).ok).toBe(false);
      expect(receiptFrom(null).ok).toBe(false);
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("receipts: damage is reported, never read as clean", () => {
  it("an interrupted write leaves only a .tmp- file: reported as interrupted, never accepted, and not complete", () => {
    const dir = tempDir();
    try {
      writeReceipt(dir, receiptFrom(report()).receipt);
      writeFileSync(path.join(dir, ".tmp-20261007T210000Z-pr810-1-0123456789abcdef.json"), '{"schema":"eng-loop-v1/rec');
      const r = readReceipts(dir);
      expect(r).toMatchObject({ interrupted: 1, complete: false });
      expect(r.receipts).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a writer that dies halfway publishes nothing: no torn receipt can ever appear under a receipt name", () => {
    const dir = tempDir();
    try {
      const crashing = {
        ...fsModule,
        writeSync: (fd: number, text: string) => {
          fsModule.writeSync(fd, text.slice(0, Math.floor(text.length / 2)));
          throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
        },
      };
      const w = writeReceipt(dir, receiptFrom(report()).receipt, { fs: crashing });
      expect(w).toMatchObject({ ok: false });
      expect(w.detail).toContain("ENOSPC");
      const r = readReceipts(dir);
      expect(r).toMatchObject({ receipts: [], invalid: [], interrupted: 1, complete: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a torn, tampered, extended or doubled record is invalid; an unexpected file is invalid", () => {
    const good = `${JSON.stringify(receiptFrom(report()).receipt)}\n`;
    const parsed = JSON.parse(good);
    const variants: Array<[string, string]> = [
      ["torn", good.slice(0, good.length - 20)],
      ["no newline", good.trimEnd()],
      ["two records", good + good],
      ["checksum tampered", `${JSON.stringify({ ...parsed, decision: "CANDIDATE_READY_FOR_HUMAN_REVIEW" })}\n`],
      ["extra field", `${JSON.stringify({ ...parsed, note: "x" })}\n`],
      ["not JSON", "hello\n"],
      ["empty", ""],
    ];
    for (const [label, text] of variants) expect(parseReceipt(text), label).toBeNull();
    const dir = tempDir();
    try {
      writeFileSync(path.join(dir, "20261007T210000Z-pr810-1-0123456789abcdef.json"), variants[3][1]);
      writeFileSync(path.join(dir, "notes.txt"), "x");
      const r = readReceipts(dir);
      expect(r.receipts).toEqual([]);
      expect(r.invalid.map((i: any) => i.file).sort()).toEqual(["20261007T210000Z-pr810-1-0123456789abcdef.json", "notes.txt"]);
      expect(r.complete).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a missing or unreadable directory is not complete: no data is never proof of no failures", () => {
    expect(readReceipts(path.join(tmpdir(), "hone-receipts-does-not-exist-0b1c"))).toMatchObject({
      receipts: [],
      complete: false,
      unreadable: "ENOENT",
    });
  });
});

describe("receipts: concurrent writers in separate processes", () => {
  it("six processes writing twenty receipts each into one directory: 120 valid receipts, no collision", async () => {
    const dir = tempDir();
    try {
      const script = `
        import { receiptFrom, writeReceipt } from ${JSON.stringify(MODULE)};
        const base = ${JSON.stringify(report())};
        let failed = 0;
        for (let i = 0; i < 20; i++) {
          const r = receiptFrom({ ...base, pr: 800 + i });
          if (!r.ok || !writeReceipt(${JSON.stringify(dir)}, r.receipt).ok) failed++;
        }
        process.exitCode = failed;
      `;
      const runs = Array.from({ length: 6 }, () =>
        new Promise<number>((resolve) => {
          const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: "ignore" });
          child.on("exit", (code) => resolve(code ?? -1));
        }),
      );
      expect(await Promise.all(runs)).toEqual([0, 0, 0, 0, 0, 0]);
      const r = readReceipts(dir);
      expect(r).toMatchObject({ complete: true, invalid: [], interrupted: 0 });
      expect(r.receipts).toHaveLength(120);
      for (const f of readdirSync(dir)) expect(readFileSync(path.join(dir, f), "utf8").split("\n")).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
