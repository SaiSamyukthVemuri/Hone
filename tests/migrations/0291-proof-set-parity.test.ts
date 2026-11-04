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
    // 'email' is the S-2b address-binding lookup (the account's own email identity), not an oauth provider.
    const providers = [...sql.matchAll(/i\.provider = '([^']+)'/g)].map((x) => x[1]).filter((p) => p !== "email").sort();
    expect(providers).toEqual(tsSet("OAUTH_PROVIDERS"));
  });

  it("the function comment names the same methods as the code (no stale 'otp only')", () => {
    const comment = sql.match(/comment on function public\.session_proves_mailbox\(\) is\s*'([^']*)'/);
    expect(comment).not.toBeNull();
    for (const method of tsSet("MAILBOX_METHODS")) expect((comment as RegExpMatchArray)[1]).toContain(method);
  });

  it("S-2b: both sides define a NEVER-CHANGED account the same way, and neither compares whole-second amr timestamps", () => {
    // TS: email_change_sent_at present, or an email identity whose updated_at differs from (or lacks) created_at = changed.
    expect(ts).toContain("const sent = user?.email_change_sent_at;");
    expect(ts).toContain('if (norm(identity.provider) !== "email") continue;');
    expect(ts).toContain("if (created === null || updated === null || created !== updated) return \"changed\";");
    expect(ts).toContain('if (emailChangeState(user) === "never_changed" && amr.some(');
    // SQL: the same definition.
    expect(sql).toContain("(acct.email_change_sent_at is null and not ident.changed)");
    expect(sql).toContain("bool_or(i.created_at is null or i.updated_at is null or i.updated_at <> i.created_at)");
    expect(sql).toMatch(/where i\.user_id = auth\.uid\(\) and i\.provider = 'email'/);
    // Neither side compares the JWT's whole-second amr timestamp any more (Codex P1): the SQL compares microsecond timestamps
    // (credential issue time between the last change and the session's creation); the TS defers a changed account to it.
    const code = (src: string) => src.split("\n").filter((l) => !/^\s*(--|\/\/|\*|\/\*)/.test(l)).join("\n");
    expect(code(sql)).not.toMatch(/floor\(|'timestamp'/);
    expect(code(ts)).not.toMatch(/entry\.timestamp|Math\.floor/);
    expect(sql).toContain("credential.issued_at > greatest(acct.email_change_sent_at, ident.last_update)");
    expect(sql).toContain("credential.issued_at < sess.created_at");
    expect(sql).toContain("(values (acct.recovery_sent_at), (acct.confirmation_sent_at))");
    // the session is the caller's own: matched by id AND user, the uuid cast guarded inside a CASE (Privacy Y1)
    expect(sql).toContain("where s.user_id = auth.uid()");
    expect(sql).toMatch(/s\.id = case when \(auth\.jwt\(\) ->> 'session_id'\) ~ '[^']+'\s+then \(auth\.jwt\(\) ->> 'session_id'\)::uuid end/);
    // link-type proof in SQL goes through the one function the app also calls
    expect(sql).toContain("and public.session_link_proof_is_current())");
    expect(ts).toContain('rpc("session_link_proof_is_current")');
    // the unusable column stays unused on both sides
    expect(code(sql)).not.toMatch(/u\.updated_at|users\.updated_at/);
    expect(code(ts)).not.toMatch(/user\??\.updated_at/);
  });

  it("grants: session_link_proof_is_current is revoked from all four roles by name and granted to authenticated only; session_proves_mailbox stays internal", () => {
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      expect(sql).toContain(`revoke execute on function public.session_link_proof_is_current() from ${role};`);
      expect(sql).toContain(`revoke execute on function public.session_proves_mailbox() from ${role};`);
    }
    expect([...sql.matchAll(/grant execute on function public\.session_link_proof_is_current\(\) to (\w+);/g)].map((m) => m[1])).toEqual(["authenticated"]);
    expect(sql).not.toMatch(/grant execute on function public\.session_proves_mailbox\(\)/);
  });
});
