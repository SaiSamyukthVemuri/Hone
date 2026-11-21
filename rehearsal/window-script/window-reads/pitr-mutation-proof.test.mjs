// Mutation proof for the PITR rules: delete each rule line of the G4-under-PITR code in a COPY of the comparator,
// run the comparator's own test file against that copy, and require it to go red. A rule whose removal changes no
// test result is a rule nothing proves. Synthetic only. Run: node --test pitr-mutation-proof.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const lib = readFileSync(path.join(HERE, "compare-preflight-lib.mjs"), "utf8").split("\n");
const from = lib.findIndex((l) => l.startsWith("export const RECOVERY_REGIMES"));
const to = lib.findIndex((l) => l.startsWith("// files: { name -> text"));
const s010 = lib.findIndex((l) => l.includes('res["S0-10"] = att('));
const s011 = lib.findIndex((l) => l.includes('res["S0-11"] = att('));
assert.ok(from > 0 && to > from && s010 > to && s011 > s010);
// rule lines: every line that refuses (fail) inside the PITR helpers, and the PITR / regime lines of S0-10
const inScope = (i) => (i > from && i < to) || (i > s010 && i < s011);
const isRule = (l) => /\bfail\(/.test(l) && !/^\s*(\/\/|const |function |export )/.test(l);
const idx = lib.map((l, i) => i).filter((i) => inScope(i) && isRule(lib[i]) && !/g4_max_age_hours|backup_id|the backup is older|g4 needs backup_id/.test(lib[i]));

test("the mutation set is not empty", () => assert.ok(idx.length >= 40, `only ${idx.length} rule lines`));

for (const i of idx) {
  test(`removing line ${i + 1} turns the suite red: ${lib[i].trim().slice(0, 110)}`, () => {
    const d = mkdtempSync(path.join(tmpdir(), "pitr-mut-"));
    const mutant = lib.slice(0, i).concat(["/* rule removed */"], lib.slice(i + 1)).join("\n");
    writeFileSync(path.join(d, "compare-preflight-lib.mjs"), mutant);
    for (const f of ["compare-preflight.mjs", "compare-preflight.test.mjs"]) copyFileSync(path.join(HERE, f), path.join(d, f));
    const r = spawnSync(process.execPath, ["--test", path.join(d, "compare-preflight.test.mjs")], { encoding: "utf8", cwd: d, env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "NODE_TEST_CONTEXT")) });
    assert.notEqual(r.status, 0, `the suite stayed green with this rule removed: ${lib[i].trim()}`);
  });
}
