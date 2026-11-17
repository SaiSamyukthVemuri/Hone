import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Each migration's apply record is ONE section of the ledger. A merge that carries a section across twice leaves two identical
// copies, which reads as two applies; this fails on the second copy (the heading carries the migration number).
const LEDGER = readFileSync(join(__dirname, "..", "..", "docs/production/migration-ledger.md"), "utf8");

describe("the migration ledger: apply sections", () => {
  it("each `### The NNNN apply` heading appears once", () => {
    const headings = LEDGER.split("\n").filter((l) => /^### The \d{4} apply\b/.test(l));
    const seen = new Set<string>();
    const repeated = headings.filter((h) => (seen.has(h) ? true : (seen.add(h), false)));
    expect(repeated, "a ledger apply section is present twice").toEqual([]);
    expect(headings.length).toBeGreaterThan(0);
  });
});
