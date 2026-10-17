// Crash between publication and cleanup (pass 2: "hard-linked to its final name … and the temporary name is
// removed"). Any removal of a temporary name kills this process with SIGKILL, so the publication step has run and
// the cleanup step has not.
// argv: <receipts.mjs> <dir> <receipt JSON>
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const [modulePath, dir, recJson] = process.argv.slice(2);
const isTemp = (p) => typeof p === "string" && !/\/\d{8}T\d{6}Z-pr\d+-\d+-[0-9a-f]{16}\.json$/.test(p);
for (const name of ["unlinkSync", "rmSync", "rmdirSync"]) {
  const orig = fs[name];
  fs[name] = function (p, ...rest) {
    if (isTemp(String(p))) {
      fs.writeSync(1, JSON.stringify({ killedAt: name }));
      process.kill(process.pid, "SIGKILL");
    }
    return orig.call(this, p, ...rest);
  };
}
syncBuiltinESMExports();
const { writeReceipt } = await import(modulePath);
const w = writeReceipt(dir, JSON.parse(recJson));
process.stdout.write(JSON.stringify({ returned: w }));
