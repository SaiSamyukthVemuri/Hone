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
    expect(ts).toContain('if (norm((identity as ProofIdentity).provider) !== "email") continue;');
    // EA-1: TS has no "missing field" case in SQL (the row set is data); a non-array identities value is changed in TS.
    expect(ts).toContain('if (!Array.isArray(identities)) return "changed";');
    expect(ts).toContain("if (created === null || updated === null || created !== updated) return \"changed\";");
    expect(ts).toContain('if (emailChangeState(user) === "never_changed" && amr.some(');
    // SQL: the same definition.
    expect(sql).toContain("if v_sent is null and not v_changed then\n    return true;");
    expect(sql).toContain("bool_or(i.created_at is null or i.updated_at is null or i.updated_at <> i.created_at)");
    expect(sql).toContain("where i.user_id = v_uid and i.provider = 'email';");
    // Neither side compares the JWT's whole-second amr timestamp any more (Codex P1): the SQL compares microsecond timestamps
    // (credential issue time between the last change and the session's creation); the TS defers a changed account to it.
    const code = (src: string) => src.split("\n").filter((l) => !/^\s*(--|\/\/|\*|\/\*)/.test(l)).join("\n");
    expect(code(sql)).not.toMatch(/floor\(|'timestamp'/);
    expect(code(ts)).not.toMatch(/entry\.timestamp|Math\.floor/);
    expect(sql).toContain("v_anchor := greatest(v_sent, v_last_update);");
    expect(sql).toContain("(v_recovery > v_anchor and v_recovery < v_session_created)");
    expect(sql).toContain("or (v_confirmation > v_anchor and v_confirmation < v_session_created)");
    // AW1(b): the never-changed return comes BEFORE the only statement that reads auth.sessions.
    const fn = sql.slice(sql.indexOf("create or replace function public.session_link_proof_is_current()"), sql.indexOf("comment on function public.session_link_proof_is_current()"));
    expect(fn).toContain("language plpgsql stable security definer");
    expect(fn.indexOf("if v_sent is null and not v_changed then")).toBeGreaterThan(0);
    expect(fn.indexOf("if v_sent is null and not v_changed then")).toBeLessThan(fn.indexOf("from auth.sessions s"));
    const fnCode = fn.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");
    expect(fnCode.split("auth.sessions").length - 1, "auth.sessions is read in exactly one statement").toBe(1);
    // CODEX-P2: the stamp is consulted only after the window, against the SAME current anchor, for the caller's own session.
    expect(fn).toContain("where p.session_id = v_session_id::uuid and p.user_id = v_uid and p.anchor = v_anchor);");
    // the session is the caller's own: matched by id AND user, the uuid cast guarded inside a CASE (Privacy Y1)
    expect(sql).toContain("where s.id = v_session_id::uuid and s.user_id = v_uid;");
    expect(sql).toMatch(/or v_session_id !~ '\^\[0-9a-fA-F\]\{8\}-[^']+\$' then\s+return false;/);
    // link-type proof in SQL goes through the one function the app also calls
    expect(sql).toContain("and public.session_link_proof_is_current())");
    expect(ts).toContain('fn: LinkProofFunction = "session_link_proof_is_current"');
    expect(ts).toContain('export type LinkProofFunction = "session_link_proof_is_current" | "stamp_session_link_proof";');
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
    // CODEX-P2: the stamp recorder has the same grant shape; the stamp table is closed to every API role.
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      expect(sql).toContain(`revoke execute on function public.stamp_session_link_proof() from ${role};`);
      expect(sql).toContain(`revoke all on table public.auth_session_link_proofs from ${role};`);
    }
    expect([...sql.matchAll(/grant execute on function public\.stamp_session_link_proof\(\) to (\w+);/g)].map((m) => m[1])).toEqual(["authenticated"]);
    expect(sql).not.toMatch(/grant [a-z, ]+ on (table )?public\.auth_session_link_proofs/);
    expect(sql).toContain("alter table public.auth_session_link_proofs enable row level security;");
  });
});
