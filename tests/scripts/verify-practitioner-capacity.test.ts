import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Source-grep guards for scripts/verify-practitioner-capacity.mjs. The script
// shells `supabase db query --linked`, which CI cannot do, so we pin its
// READ-ONLY, no-secret, no-PII, fail-closed contract at the source level.

const SCRIPT = readFileSync(
  join(process.cwd(), "scripts/verify-practitioner-capacity.mjs"),
  "utf8",
);
// Strip comments so the doc-comment (which names the operations it avoids)
// cannot satisfy or trip the greps.
const CODE = SCRIPT.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("verify-practitioner-capacity: read-only DB access", () => {
  it("reads via `supabase db query --linked`", () => {
    expect(CODE).toMatch(/"db",\s*"query",\s*"--linked"/);
  });
  it("never uses db push / db execute / migration apply", () => {
    expect(CODE).not.toMatch(/db\s+push|"push"/);
    expect(CODE).not.toMatch(/db\s+execute|"execute"/);
    expect(CODE).not.toMatch(/migration\s+(up|repair)|migrations?\s+apply/i);
  });
  it("performs no writes and never toggles the capacity flag", () => {
    expect(CODE).not.toMatch(
      /\b(insert\s+into|update\s+\w+\s+set|delete\s+from|upsert|drop\s+|alter\s+|create\s+(table|policy|index|trigger|function))\b/i,
    );
    // No WRITE to the flag (a SET clause). Reading it in a WHERE predicate
    // (`where practitioner_capacity_enabled = true`) is expected and allowed.
    expect(CODE).not.toMatch(/set\s+practitioner_capacity_enabled/i);
    expect(CODE).not.toMatch(/update\s+public\.studios/i);
  });
});

describe("verify-practitioner-capacity: no PII", () => {
  it("never selects client/practitioner PII columns", () => {
    // No `select *`, and no reference to any client/practitioner PII column.
    // ("name" alone is intentionally NOT forbidden — it is a reporting-helper
    // parameter here, not a selected column; the column tokens below are the
    // real PII surface and never appear in this read-only aggregate script.)
    expect(CODE).not.toMatch(/select\s+\*/i);
    expect(CODE).not.toMatch(
      /\b(email|phone|display_name|private_note|skin_notes|date_of_birth|contraindications)\b/i,
    );
  });
});

describe("verify-practitioner-capacity: fail-closed + covers required checks", () => {
  it("exits non-zero on FAIL or INCOMPLETE", () => {
    expect(CODE).toMatch(/process\.exit\(\s*failed\s*>\s*0\s*\|\|\s*incompleteN\s*>\s*0\s*\?\s*1\s*:\s*0\s*\)/);
  });
  it("covers dormancy, OFF-parity, integrity, orphans, eligibility, and overlaps", () => {
    for (const fn of [
      "checkSchemaPresent",
      "checkDormant",
      "checkOffParity",
      "checkIntegrity",
      "checkOrphans",
      "checkEligibility",
      "checkOverlaps",
    ]) {
      expect(CODE).toContain(fn);
    }
  });
});
