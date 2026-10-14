// Deterministic TOCTOU injection against readReceipts (pass 2: "only regular files are read — never through a
// symlink, never blocking on a FIFO"). The receipt-named entry is swapped for a hostile one exactly before the
// reader's own call of <at> (openSync: the lstat→open window; fstatSync: the open→fstat window; readSync: the
// fstat→read window). Runs in a child so that a blocking open cannot hang the test.
// argv: <receipts.mjs> <dir> <name> <hostile path> <at> <mutant>
import fs from "node:fs";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";

const [modulePath, dir, name, hostile, at, mutant] = process.argv.slice(2);
const target = path.join(dir, name);
const seen = [];
let swapped = false;
for (const fn of ["openSync", "fstatSync", "readSync", "lstatSync", "statSync", "readFileSync", "readdirSync", "closeSync"]) {
  const orig = fs[fn];
  fs[fn] = function (...args) {
    seen.push(fn);
    const first = args[0];
    const aboutTarget = fn === "openSync" || fn === "lstatSync" || fn === "statSync" || fn === "readFileSync" ? String(first) === target : true;
    if (!swapped && fn === at && aboutTarget) {
      swapped = true;
      fs.renameSync(hostile, target);
    }
    return orig.apply(this, args);
  };
}
syncBuiltinESMExports();
const { receiptsApi } = await import("./receipt-mutants.mjs");
const api = await receiptsApi(modulePath, mutant);
const t0 = Date.now();
const r = api.readReceipts(dir);
process.stdout.write(
  JSON.stringify({ swapped, ms: Date.now() - t0, complete: r.complete, prs: (r.receipts ?? []).map((x) => x.pr), calls: [...new Set(seen)] }),
);
