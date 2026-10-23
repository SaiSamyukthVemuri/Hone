// Child process for receipt crash and concurrency scenarios.
// argv: <receipts.mjs path> <mutant|real> <dir> <mode: loop|batch> <count> <id>
import { receiptsApi } from "./receipt-mutants.mjs";

const [modulePath, mutant, dir, mode, countArg, id] = process.argv.slice(2);
const api = await receiptsApi(modulePath, mutant);
const HEAD = "fe62f51f0fd95fc97d2e21eef71d179e2e701358";
const TOOL = "eng-loop-v1@efc7e1865d434ed7ea44aba33cd12b0c2703bcd0";

function report(i, identical) {
  const decisions = ["FINDINGS_OPEN", "CI_PENDING", "CANDIDATE_READY_FOR_HUMAN_REVIEW", "REVIEW_MISSING"];
  const decision = identical ? "FINDINGS_OPEN" : decisions[i % decisions.length];
  return {
    pr: identical ? 800 : 800 + (i % 50),
    headSha: HEAD,
    evidenceHash: (identical ? "a" : (Number(id) * 1000 + i).toString(16).padStart(4, "0")).padEnd(64, "b").slice(0, 64),
    decision,
    reasonCodes: [decision],
    observedAt: "2026-10-07T20:00:00Z",
    toolVersion: TOOL,
    blocking: { changesRequested: false, openThreads: 1 },
    humanMergeRequired: true,
  };
}

let ok = 0, fail = 0;
const files = [];
const count = Number(countArg);
for (let i = 0; mode === "loop" || i < count; i += 1) {
  const r = api.receiptFrom(report(i, i % 2 === 0));
  if (!r.ok) {
    fail += 1;
    continue;
  }
  const w = api.writeReceipt(dir, r.receipt);
  if (w.ok) {
    ok += 1;
    files.push(w.file);
  } else fail += 1;
}
process.stdout.write(JSON.stringify({ ok, fail, files }));
