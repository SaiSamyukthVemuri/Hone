/* eslint-disable @typescript-eslint/no-explicit-any -- receipts are inspected as raw JSON on purpose */
import { describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
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

  it("an UNKNOWN report with no head, no evidence hash and no established tool version is still a valid receipt", () => {
    const built = receiptFrom(
      report({ headSha: null, evidenceHash: null, decision: "UNKNOWN", reasonCodes: ["read_failed"], toolVersion: null }),
    );
    expect(built.ok).toBe(true);
  });

  it("a decision's reasons are [decision], and UNKNOWN's is one closed reason: anything else is not a receipt", () => {
    for (const [decision, reasonCodes] of [
      ["CANDIDATE_READY_FOR_HUMAN_REVIEW", ["read_failed"]],
      ["CI_PENDING", ["CI_FAILED"]],
      ["CI_PENDING", ["CI_PENDING", "CI_PENDING"]],
      ["UNKNOWN", ["CI_PENDING"]],
      ["UNKNOWN", ["read_failed", "malformed"]],
      ["UNKNOWN", []],
    ] as const) {
      expect(receiptFrom(report({ decision, reasonCodes })).ok, `${decision} ${reasonCodes.join(",")}`).toBe(false);
    }
    expect(receiptFrom(report({ toolVersion: "eng-loop-v1@unknown" })).ok).toBe(false);
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
      // Consistent in every field but the checksum: only the checksum can catch this one.
      [
        "consistent but re-decided",
        `${JSON.stringify({ ...parsed, decision: "CANDIDATE_READY_FOR_HUMAN_REVIEW", reasons: ["CANDIDATE_READY_FOR_HUMAN_REVIEW"] })}\n`,
      ],
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

  it("a FIFO, a symlink or an oversized file under a receipt name is invalid — read without hanging, never accepted", () => {
    const dir = tempDir();
    const elsewhere = tempDir();
    try {
      const good = `${JSON.stringify(receiptFrom(report()).receipt)}\n`;
      writeFileSync(path.join(elsewhere, "real.json"), good);
      fsModule.symlinkSync(path.join(elsewhere, "real.json"), path.join(dir, "20261007T210000Z-pr810-1-00000000000000aa.json"));
      fsModule.symlinkSync("/dev/zero", path.join(dir, "20261007T210000Z-pr810-1-00000000000000bb.json"));
      writeFileSync(path.join(dir, "20261007T210000Z-pr810-1-00000000000000cc.json"), "x".repeat(5000));
      const fifo = spawnSync("mkfifo", [path.join(dir, "20261007T210000Z-pr810-1-00000000000000dd.json")]);
      const started = Date.now();
      const r = readReceipts(dir);
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(r.receipts).toEqual([]);
      expect(r.complete).toBe(false);
      const why = Object.fromEntries(r.invalid.map((i: any) => [i.file.slice(-7, -5), i.why]));
      expect(why.aa).toMatch(/unreadable: ELOOP/);
      expect(why.bb).toMatch(/unreadable: ELOOP/);
      expect(why.cc).toBe("too large to be a receipt");
      if (fifo.status === 0) expect(why.dd).toBe("not a regular file");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("publishing is exclusive: when every name collides the write fails and the first receipt stands", () => {
    const dir = tempDir();
    try {
      const fixed = { random: () => "0123456789abcdef", pid: 7 };
      const first = receiptFrom(report({ pr: 810 })).receipt;
      const second = receiptFrom(report({ pr: 810, decision: "CI_FAILED", reasonCodes: ["CI_FAILED"] })).receipt;
      expect(writeReceipt(dir, first, fixed)).toMatchObject({ ok: true });
      const w = writeReceipt(dir, second, fixed);
      expect(w).toMatchObject({ ok: false });
      expect(w.detail).toContain("EEXIST");
      const r = readReceipts(dir);
      expect(r.receipts).toEqual([first]);
      expect(r.interrupted).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a receipt published but whose temporary name cannot be removed is still written, and the leftover is reported", () => {
    const dir = tempDir();
    try {
      const stuck = {
        ...fsModule,
        unlinkSync: () => {
          throw Object.assign(new Error("EIO"), { code: "EIO" });
        },
      };
      const receipt = receiptFrom(report()).receipt;
      expect(writeReceipt(dir, receipt, { fs: stuck })).toMatchObject({ ok: true, leftover: true });
      const r = readReceipts(dir);
      expect(r.receipts).toEqual([receipt]);
      expect(r).toMatchObject({ interrupted: 1, complete: false });
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
