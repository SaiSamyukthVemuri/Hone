import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// J-1 (Insurance): the 0292 hook's allow-list must equal the app's mailbox proof set plus oauth. A method the hook admits
// but the app refuses (the earlier email/signup and invite) is a session that signs in and then proves nothing; a method the
// app trusts but the hook refuses would lock a legitimate flow out. Source-contract test: reads the migration text.

const ts = readFileSync(join(process.cwd(), "lib/auth/email-proof.ts"), "utf8");
const sql = readFileSync(join(process.cwd(), "supabase/migrations/0292_auth_block_password_tokens_hook.sql"), "utf8");

function appMailboxMethods(): string[] {
  const m = ts.match(/const MAILBOX_METHODS[^=]*=\s*new Set\(\[([^\]]*)\]\)/);
  expect(m, "lib/auth/email-proof.ts must declare MAILBOX_METHODS as a literal Set").not.toBeNull();
  return [...m![1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

function allowList(): string[] {
  const m = sql.match(/if method in \(([^)]*)\) then/);
  expect(m, "0292 must have exactly one `if method in (...) then` allow-list").not.toBeNull();
  return [...m![1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort();
}

describe("0292 hook allow-list parity with the proof set", () => {
  it("equals MAILBOX_METHODS plus oauth, exactly", () => {
    expect(allowList()).toEqual([...appMailboxMethods(), "oauth"].sort());
  });
  it("does not admit the methods measured as outside the proof set", () => {
    for (const m of ["password", "email/signup", "invite"]) expect(allowList()).not.toContain(m);
  });
});
