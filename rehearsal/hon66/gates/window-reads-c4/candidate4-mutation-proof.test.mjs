// Named-mutant proof for the candidate-4 rules that the generic pitr-mutation-proof.test.mjs cannot reach (it deletes `fail(` lines only):
// the verdict LABELS, their propagation and the entry's exit-code rule. Each mutant is one exact edit of a COPY of the comparator; the
// comparator's own test file (C4 tests) must go red. A label nothing proves could be dropped silently. Synthetic only.
// Run: node --test candidate4-mutation-proof.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = "compare-preflight-lib.mjs", ENTRY = "compare-preflight.mjs";
const MUTANTS = [
  ["S0 idle label dropped", LIB, "        quals.push(IDLE_S0_LABEL);\n", ""],
  ["S0 UNVERIFIED label dropped (unavailable mode prints no caveat)", LIB, "const quals = unavailable ? [UNVERIFIED_LABEL] : [];", "const quals = [];"],
  ["verdictLineOf returns a bare line", LIB, "export const verdictLineOf = (quals) => (quals.length ? `OVERALL PASS (${quals.join(\"; \")})` : \"OVERALL PASS\");", "export const verdictLineOf = (quals) => \"OVERALL PASS\";"],
  ["row qualifier propagation dropped (rows map)", LIB, ", qualifier: skipped ? undefined : r.qualifier };", " };"],
  ["S0 verdictLine ignores the S0-10 qualifier", LIB, "verdictLineOf(overall === \"PASS\" && s10 && s10.qualifier ? s10.qualifier : [])", "verdictLineOf([])"],
  ["row 4 UNVERIFIED label dropped for a non-idle basis", LIB, "    if (r2.status === \"PASS\" && unavailable && !r2.qualifier) r2 = { ...r2, qualifier: [UNVERIFIED_LABEL] };\n", ""],
  ["row 4 qualifier not stored on the row", LIB, "    rows[rows.length - 1].qualifier = r2.qualifier;\n", ""],
  ["row 4 verdictLine ignores the qualifiers", LIB, "verdictLine: verdictLineOf(overall === \"PASS\" ? rows.flatMap((r) => r.qualifier ?? []) : [])", "verdictLine: verdictLineOf([])"],
  ["row 4 idle label dropped", LIB, "qualifier: [...(unavailable ? [UNVERIFIED_LABEL] : []), IDLE_ROW4_LABEL] }", "qualifier: [...(unavailable ? [UNVERIFIED_LABEL] : [])] }"],
  ["format prints a bare line whatever the verdict", LIB, "overall === \"PASS\" ? (verdictLine ?? \"OVERALL PASS\") :", "overall === \"PASS\" ? \"OVERALL PASS\" :"],
  ["entry exit rule accepts only the bare line", ENTRY, "/^OVERALL PASS( \\(.+\\))?$/.test(line)", "line === \"OVERALL PASS\""],
  ["entry never passes --pitr-api to the S0 comparator", ENTRY, "pitrApi: pitrApiInput(get(\"--pitr-api\")), idle: pitrIdleInput(get(\"--pitr-idle\")),\n      }));", "pitrApi: null, idle: null,\n      }));"],
  ["entry never passes --pitr-api to row 4", ENTRY, "pitrApi: pitrApiInput(get(\"--pitr-api\")), idle: pitrIdleInput(get(\"--pitr-idle\")) }));", "pitrApi: null, idle: pitrIdleInput(get(\"--pitr-idle\")) }));"],
  ["entry never passes --pitr-idle to row 4", ENTRY, "pitrApi: pitrApiInput(get(\"--pitr-api\")), idle: pitrIdleInput(get(\"--pitr-idle\")) }));", "pitrApi: pitrApiInput(get(\"--pitr-api\")), idle: null }));"],
  ["entry ignores the UNREADABLE marker", ENTRY, "if (existsSync(path.join(dir, sub, \"UNREADABLE\"))) return { unreadable: true, denied: stem === \"pitr-wal-status\" };", ""],
  ["the dashboard latest is not cross-checked against the API on the idle path", LIB, "  if (Math.abs(typed - ar.data.latestMs) > cfg.dashboard_tolerance_seconds * 1000) return fail(", "  if (false) return fail("],
  ["the unverified-base-backup ack is not required", LIB, "if (r.base_backup_unverified_ack !== true) return fail(", "if (false) return fail("],
  ["a COMPLETED physical entry does not force mode listed", LIB, "if (d.completedPhysical > 0) return fail(", "if (false) return fail("],
  ["base <= latest is a gate again in mode listed", LIB, "  const obs = t.latest_base_backup_completed_at_utc > t.latest_recovery_at_utc ? \"; observation: the base backup completed after the latest recovery point\" : \"\";", "  if (t.latest_base_backup_completed_at_utc > t.latest_recovery_at_utc) return fail(\"g4_pitr.latest_base_backup_completed_at_utc is after latest_recovery_at_utc\");\n  const obs = \"\";"],
];
test("the mutation set is not empty", () => assert.ok(MUTANTS.length >= 18));
for (const [name, file, find, repl] of MUTANTS) {
  test(`mutant turns the C4 suite red: ${name}`, () => {
    const src = readFileSync(path.join(HERE, file), "utf8");
    assert.equal(src.split(find).length - 1, 1, `the mutated text must occur exactly once in ${file}`);
    const d = mkdtempSync(path.join(tmpdir(), "c4named-"));
    for (const f of [LIB, ENTRY, "compare-preflight.test.mjs"]) copyFileSync(path.join(HERE, f), path.join(d, f));
    cpSync(path.join(HERE, "fixtures"), path.join(d, "fixtures"), { recursive: true });
    writeFileSync(path.join(d, file), src.replace(find, () => repl));
    const r = spawnSync(process.execPath, ["--test", "--test-name-pattern", "C4", path.join(d, "compare-preflight.test.mjs")], { encoding: "utf8", cwd: d, env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "NODE_TEST_CONTEXT")) });
    assert.notEqual(r.status, 0, `the suite stayed green with this mutant: ${name}`);
  });
}
