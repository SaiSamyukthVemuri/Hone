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

  // W2 (Privacy): the allow-list is checked against what the hook was MEASURED to receive, not only against literals.
  const measured = JSON.parse(readFileSync(join(process.cwd(), "tests/db/fixtures/hook-measured-methods.json"), "utf8")) as {
    legitimate_flows_received: Record<string, string>;
    refused_by_design_received: Record<string, string>;
  };
  it("every method the hook was measured to receive on a legitimate flow is accepted by the hook (allow-list or the refresh rule)", () => {
    const list = allowList();
    for (const [flow, method] of Object.entries(measured.legitimate_flows_received)) {
      const ok = method === "token_refresh" ? /authentication_method\s*=\s*'token_refresh'|method\s*=\s*'token_refresh'/.test(sql) : list.includes(method);
      expect(ok, `${flow}: the hook received '${method}' and the migration must accept it`).toBe(true);
    }
  });
  it("every method measured as refused-by-design is not on the allow-list", () => {
    for (const [flow, method] of Object.entries(measured.refused_by_design_received)) {
      expect(allowList(), flow).not.toContain(method);
    }
  });
  it("the measured legitimate link methods are exactly the app proof-set methods (otp, magiclink, recovery)", () => {
    const linkMethods = Object.values(measured.legitimate_flows_received).filter((m) => m !== "token_refresh");
    expect([...new Set(linkMethods)].sort()).toEqual(appMailboxMethods().sort());
  });
});
