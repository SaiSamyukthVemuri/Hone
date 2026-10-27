// node --test baseline-candidate5-proof.test.mjs : BASELINE-W1-MACOS-CANDIDATE-5.json differs from candidate 4 ONLY by g4_pitr_api.min_span_days = 6 (and its _candidate note).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const load = (n) => JSON.parse(readFileSync(join(HERE, n), "utf8"));
const strip = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => !k.startsWith("_")));
test("candidate 5 = candidate 4 + g4_pitr_api.min_span_days 6, nothing else", () => {
  const c4 = strip(load("BASELINE-W1-MACOS-CANDIDATE-4.json")), c5 = strip(load("BASELINE-W1-MACOS-CANDIDATE-5.json"));
  assert.equal(c5.g4_pitr_api.min_span_days, 6);
  delete c5.g4_pitr_api.min_span_days;
  assert.deepEqual(c5, c4);
});
test("the typed retention minimum and every other threshold are candidate 4's", () => {
  const c5 = load("BASELINE-W1-MACOS-CANDIDATE-5.json");
  assert.deepEqual(c5.g4_pitr, { min_retention_days: 7, earliest_margin_minutes: 5, max_latest_lag_minutes: 30, max_read_age_minutes: 60, max_pre_point_age_minutes: 30 });
  assert.equal(c5.g4_pitr_api.max_capture_age_minutes, 60); assert.equal(c5.g4_pitr_api.dashboard_tolerance_seconds, 1);
  assert.equal(c5.runner_sha256, "471ecb9d18116f9b5c898400d9dae0aa898be5aa795b2788c44eacdefeb27357");
});
test("the c4 originals are kept beside the new files", () => {
  for (const f of ["compare-preflight-lib.mjs.c4", "compare-preflight.test.mjs.c4", "window-s0a.sh.c4", "window-row4.sh.c4", "DOWNLOAD-C4.txt.c4", "WINDOW-COMMAND-MACOS-C4.md.c4"]) assert.ok(readFileSync(join(HERE, f)).length > 0, f);
  assert.equal(createHash("sha256").update(readFileSync(join(HERE, "compare-preflight-lib.mjs.c4"))).digest("hex").slice(0, 8), "813425d4");
});
