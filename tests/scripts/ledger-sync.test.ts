import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs without types
import { getMigrationState } from "../../scripts/migration-state.mjs";
// @ts-expect-error plain .mjs without types
import { MARKER, markedRows, renderDerivedRows, syncLedgerText } from "../../scripts/ledger-sync.mjs";

// The ledger's repo-max and next-free rows are DERIVED: written only by `npm run ledger:sync`, marked, and equal to what the script writes.
const LEDGER = readFileSync("docs/production/migration-ledger.md", "utf8");
const state = (max: string, next: number, file = `${max}_x.sql`) => ({ repo_migration_max: max, next_free_migration_number: next, files: ["0001_a.sql", file] });
const SAMPLE = [
  "# Ledger",
  "## Current state (sample)",
  "| **Hosted (production) migration max** | **0300** |",
  "| **Repo migration max** | **0301** (`0301_x.sql`), derived. |",
  "| **Next free number** | Next free number is **0302** by this tree's derived filenames, **not claimed**. |",
  "## Previous state",
  "| **Repo migration max** | **0100** |",
].join("\n");

describe("syncLedgerText (pure)", () => {
  it("rewrites exactly the two derived rows of the CURRENT block and leaves earlier blocks and other rows alone", () => {
    const { text, changed } = syncLedgerText(SAMPLE, state("0310", 311));
    expect(changed).toBe(true);
    expect(text).toContain("| **Hosted (production) migration max** | **0300** |");
    expect(text).toContain("| **Repo migration max** | **0100** |");
    expect(text).toContain("**0310** (`0310_x.sql`)");
    expect(text).toContain("Next free number is **0311**");
    expect(text.match(new RegExp(MARKER, "g"))?.length).toBe(2);
  });
  it("is idempotent: a second run changes nothing", () => {
    const once = syncLedgerText(SAMPLE, state("0310", 311)).text;
    expect(syncLedgerText(once, state("0310", 311)).changed).toBe(false);
  });
  it("NEGATIVE CONTROL: a block with no repo-max or next-free row is refused", () => {
    expect(() => syncLedgerText("## Current state\n| **Hosted** | x |", state("0310", 311))).toThrow(/Repo migration max/);
  });
  it("NEGATIVE CONTROL: no current-state block is refused", () => {
    expect(() => syncLedgerText("# nothing", state("0310", 311))).toThrow(/Current state/);
  });
});

describe("the committed ledger", () => {
  const s = getMigrationState();
  it("both derived rows carry the marker", () => {
    expect(markedRows(LEDGER).length).toBe(2);
  });
  it("NEGATIVE CONTROL (hand edit): the marked rows equal exactly what ledger:sync would write", () => {
    const r = renderDerivedRows(s);
    expect(markedRows(LEDGER)).toEqual([r.repo, r.next]);
    expect(syncLedgerText(LEDGER, s).changed).toBe(false);
  });
  it("NEGATIVE CONTROL (stale max): the same ledger against a newer derived state is reported as changed", () => {
    const newer = { ...s, repo_migration_max: "9999", next_free_migration_number: 10000, files: [...s.files, "9999_future.sql"] };
    expect(syncLedgerText(LEDGER, newer).changed).toBe(true);
  });
});
