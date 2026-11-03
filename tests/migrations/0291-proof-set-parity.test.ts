import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Privacy G2: the application's mailbox-proof set (lib/auth/email-proof.ts) and the database's (0291
// public.session_proves_mailbox) must be IDENTICAL. They are two copies of one decision; a method added to one and not the
// other would let a session pass one gate and fail the other. This reads both sources and compares the sets.
const ts = readFileSync(join(process.cwd(), "lib/auth/email-proof.ts"), "utf8");
const sql = readFileSync(join(process.cwd(), "supabase/migrations/0291_auth_email_proof_invitation_gate.sql"), "utf8");

const tsSet = (name: string): string[] => {
  const m = ts.match(new RegExp(`const ${name}[^=]*=\\s*new Set\\(\\[([^\\]]*)\\]\\)`));
  expect(m, `${name} must be a literal Set in lib/auth/email-proof.ts`).not.toBeNull();
  return [...(m as RegExpMatchArray)[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]).sort();
};

describe("0291 / lib/auth/email-proof.ts proof-set parity", () => {
  it("the mailbox amr methods are identical", () => {
    const m = sql.match(/a ->> 'method' in \(([^)]*)\)/);
    expect(m, "0291 must test the amr method with a literal IN list").not.toBeNull();
    const sqlMethods = [...(m as RegExpMatchArray)[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort();
    expect(sqlMethods).toEqual(tsSet("MAILBOX_METHODS"));
    expect(sqlMethods.length).toBeGreaterThan(0);
  });

  it("the oauth providers are identical (the SQL names each provider it accepts)", () => {
    const providers = [...sql.matchAll(/i\.provider = '([^']+)'/g)].map((x) => x[1]).sort();
    expect(providers).toEqual(tsSet("OAUTH_PROVIDERS"));
  });

  it("the function comment names the same methods as the code (no stale 'otp only')", () => {
    const comment = sql.match(/comment on function public\.session_proves_mailbox\(\) is\s*'([^']*)'/);
    expect(comment).not.toBeNull();
    for (const method of tsSet("MAILBOX_METHODS")) expect((comment as RegExpMatchArray)[1]).toContain(method);
  });
});
