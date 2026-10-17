// Race harness for the receipt reader (pass 2: "only regular files are read — never through a symlink, never
// blocking on a FIFO, never more than 4 KB").
//   swapper <mode> <dir> <name> <stageDir> <ms> <validText> <otherText>
//   reader  <receipts.mjs> <mutant> <dir> <ms>
// The swapper replaces one receipt-named entry atomically (rename) between a regular, valid receipt (pr 800) and a
// hostile entry; the reader loops readReceipts and reports what it accepted and how long each read took.

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { receiptsApi, receiptProblem } from "./receipt-mutants.mjs";

const [role, ...args] = process.argv.slice(2);

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

if (role === "swapper") {
  const [mode, dir, name, stage, msArg, validText, otherText] = args;
  const until = Date.now() + Number(msArg);
  const target = path.join(dir, name);
  const putRegular = () => {
    fs.writeFileSync(path.join(stage, "reg.tmp"), validText);
    fs.renameSync(path.join(stage, "reg.tmp"), target);
  };
  let server = null;
  if (mode === "symlink") fs.writeFileSync(path.join(stage, "other.json"), otherText);
  if (mode === "fifo") spawnSync("mkfifo", [path.join(stage, "fifo")]);
  if (mode === "dir") fs.mkdirSync(path.join(stage, "d"));
  if (mode === "socket") {
    server = net.createServer();
    await new Promise((res) => server.listen(path.join(stage, "sock"), res));
  }
  let swaps = 0;
  while (Date.now() < until) {
    try {
      if (mode === "symlink") {
        putRegular();
        try {
          fs.unlinkSync(path.join(stage, "ln.tmp"));
        } catch {
          /* first pass */
        }
        fs.symlinkSync(path.join(stage, "other.json"), path.join(stage, "ln.tmp"));
        fs.renameSync(path.join(stage, "ln.tmp"), target);
      } else if (mode === "fifo" || mode === "socket") {
        const hostile = path.join(stage, mode === "fifo" ? "fifo" : "sock");
        putRegular();
        fs.renameSync(hostile, target);
        fs.renameSync(target, hostile);
      } else if (mode === "dir") {
        putRegular();
        fs.unlinkSync(target);
        fs.renameSync(path.join(stage, "d"), target);
        fs.renameSync(target, path.join(stage, "d"));
      } else if (mode === "grow") {
        fs.writeFileSync(target, "");
        for (let i = 0; i < validText.length; i += 16) {
          fs.appendFileSync(target, validText.slice(i, i + 16));
          sleepMs(1);
        }
        for (let i = 0; i < 6; i += 1) {
          fs.appendFileSync(target, " ".repeat(1024));
          sleepMs(1);
        }
        fs.unlinkSync(target);
      }
      swaps += 1;
    } catch {
      /* a reader may race us; keep churning */
    }
  }
  if (server) server.close();
  process.stdout.write(JSON.stringify({ swaps }));
  process.exit(0);
}

if (role === "reader") {
  const [modulePath, mutant, dir, msArg] = args;
  const api = await receiptsApi(modulePath, mutant);
  const until = Date.now() + Number(msArg);
  const out = { reads: 0, maxMs: 0, accepted: 0, foreign: 0, invalidAccepted: 0, completeWithHostile: 0, threw: 0, firstThrow: null };
  while (Date.now() < until) {
    const t0 = Date.now();
    try {
      const r = api.readReceipts(dir);
      for (const rec of r.receipts ?? []) {
        out.accepted += 1;
        if (rec.pr !== 800) out.foreign += 1;
        if (receiptProblem(rec) !== null) out.invalidAccepted += 1;
      }
    } catch (e) {
      out.threw += 1;
      out.firstThrow ??= String(e?.message ?? e);
    }
    out.maxMs = Math.max(out.maxMs, Date.now() - t0);
    out.reads += 1;
  }
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}
