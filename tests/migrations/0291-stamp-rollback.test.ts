import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Insurance S-3: the apply package for held 0291 carries a tested rollback of the CODEX-P2 stamp (table + recorder + the
// previous link check). Source contract here; the behaviour (refusal, opt-in, end state) is proven on a real database by
// tests/db/auth-0291-stamp-rollback.db.test.ts.
const down = readFileSync(join(process.cwd(), "supabase/rollbacks/0291_session_link_proof_stamp.down.sql"), "utf8");
const up = readFileSync(join(process.cwd(), "supabase/migrations/0291_auth_email_proof_invitation_gate.sql"), "utf8");
const code = (src: string) => src.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");

describe("0291 CODEX-P2 rollback (supabase/rollbacks/0291_session_link_proof_stamp.down.sql)", () => {
  it("is one transaction with its own lock_timeout", () => {
    const c = code(down).trim();
    expect(c.startsWith("begin;")).toBe(true);
    expect(c.endsWith("commit;")).toBe(true);
    expect(c).toContain("set local lock_timeout = '5s';");
    expect(c.match(/^begin;$/gm)?.length).toBe(1);
    expect(c.match(/^commit;$/gm)?.length).toBe(1);
  });

  it("refuses (raises) while stamp rows exist, before changing anything, unless the operator opts in", () => {
    const c = code(down);
    const refusal = c.indexOf("0291 stamp rollback refused");
    expect(refusal).toBeGreaterThan(0);
    expect(c).toContain("current_setting('hone.rollback_0291_discard_stamps', true), '') <> 'discard'");
    for (const change of ["create or replace function public.session_link_proof_is_current()", "drop function if exists public.stamp_session_link_proof();", "drop table if exists public.auth_session_link_proofs;"]) {
      expect(c.indexOf(change), change).toBeGreaterThan(refusal);
    }
  });

  it("restores a link check that no longer reads the stamp table, before dropping the table; grants restated", () => {
    const c = code(down);
    const fn = c.slice(c.indexOf("create or replace function public.session_link_proof_is_current()"), c.indexOf("comment on function public.session_link_proof_is_current()"));
    expect(fn).not.toContain("auth_session_link_proofs");
    expect(fn).toContain("(v_recovery > v_anchor and v_recovery < v_session_created)");
    expect(fn).toContain("if v_sent is null and not v_changed then");
    expect(c.indexOf("create or replace function public.session_link_proof_is_current()")).toBeLessThan(c.indexOf("drop table if exists public.auth_session_link_proofs;"));
    for (const role of ["public", "anon", "authenticated", "service_role"]) expect(c).toContain(`revoke execute on function public.session_link_proof_is_current() from ${role};`);
    expect([...c.matchAll(/grant execute on function public\.session_link_proof_is_current\(\) to (\w+);/g)].map((m) => m[1])).toEqual(["authenticated"]);
  });

  it("undoes exactly what CODEX-P2 added to 0291 and nothing else", () => {
    expect(up).toContain("create table if not exists public.auth_session_link_proofs");
    expect(up).toContain("create or replace function public.stamp_session_link_proof()");
    const c = code(down);
    expect([...c.matchAll(/drop (?:function|table) if exists ([\w.]+)/g)].map((m) => m[1]).sort()).toEqual(["public.auth_session_link_proofs", "public.stamp_session_link_proof"]);
    for (const untouched of ["session_proves_mailbox", "my_pending_invitation", "reconcile_my_pending_invitation"]) expect(c).not.toContain(untouched);
  });
});
