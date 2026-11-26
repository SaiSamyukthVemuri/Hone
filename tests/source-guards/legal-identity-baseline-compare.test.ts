import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// HON-58 source contract: saveLegalIdentityAction must put EVERY loaded name part into the compare of its conditional
// UPDATE, so dropping one (which would turn a part into a blind overwrite) goes red. The DB tests re-type the statement, so
// this is what ties them to the action's real code. Spelling-based, not proof.

const SRC = readFileSync("app/(app)/clients/[id]/legal-identity-actions.ts", "utf8");

describe("saveLegalIdentityAction compare chain", () => {
  it("lists each stored name column against its loaded baseline part", () => {
    for (const [col, part] of [
      ["legal_given_name", "given"],
      ["legal_middle_name", "middle"],
      ["legal_family_name", "family"],
    ]) {
      expect(SRC, col).toMatch(new RegExp(`\\["${col}",\\s*baseline\\.${part}\\]`));
    }
  });

  it("applies every listed pair with .is(null) or .eq(value) before the write", () => {
    expect(SRC).toMatch(/for \(const \[col, value\] of cond\) update = value === null \? update\.is\(col, null\) : update\.eq\(col, value\);/);
    const loop = SRC.indexOf("for (const [col, value] of cond)");
    const run = SRC.indexOf('await update.select("client_id")');
    expect(loop).toBeGreaterThan(0);
    expect(run).toBeGreaterThan(loop);
  });

  it("scopes the update to the client and studio, and treats zero rows as a conflict", () => {
    expect(SRC).toMatch(/\.eq\("client_id", clientId\)\s*\.eq\("studio_id", studio\.id\)/);
    expect(SRC).toMatch(/conflict: !data \|\| data\.length === 0/);
  });
});
