import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Rollback contract for 0353 (waitlist single legal name: one flag column, one CHECK, one new completion command version).
// The behavioural proof is tests/db/waitlist-single-legal-name.db.test.ts.
const ROOT = join(__dirname, "..", "..");
const DOWN_FILE = readFileSync(join(ROOT, "supabase/rollbacks/0353_waitlist_single_legal_name.down.sql"), "utf8");

describe("0353 rollback", () => {
  it("the down file drops the function, the CHECK and the column, in that order", () => {
    expect(DOWN_FILE).toMatch(/^begin;\nset local lock_timeout = '5s';/m);
    expect(DOWN_FILE.trimEnd().endsWith("commit;")).toBe(true);
    const f = DOWN_FILE.indexOf("drop function if exists public.complete_waitlist_profile_by_grant_v2(text, text, text, text[], text, text, boolean, boolean);");
    const c = DOWN_FILE.indexOf("drop constraint if exists new_client_waitlist_entries_single_name_check");
    const col = DOWN_FILE.indexOf("drop column if exists single_legal_name");
    expect(f).toBeGreaterThan(-1);
    expect(c).toBeGreaterThan(f);
    expect(col).toBeGreaterThan(c);
  });
});
