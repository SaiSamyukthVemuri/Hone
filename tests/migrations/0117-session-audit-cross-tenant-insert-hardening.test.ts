import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

// Migration 0117: tighten the session_audit INSERT policy so a new audit row is
// insertable ONLY for a session in a studio the caller is an active member of
// (plus the existing actor binding), closing a confirmed cross-tenant
// integrity-write. Carries the repo-max tripwire (moved here from 0116). The
// behavioral proof lives in tests/db/session-audit-cross-tenant.db.test.ts.

const MIGRATIONS_DIR = path.resolve(__dirname, "../../supabase/migrations");
const FILE = "0117_session_audit_cross_tenant_insert_hardening.sql";
const SQL = readFileSync(path.join(MIGRATIONS_DIR, FILE), "utf8");
const SQL_CODE = SQL.replace(/--.*$/gm, "");

describe("0117 — number", () => {
  it("0117 exists; the repo-max tripwire now lives in the 0118 test", () => {
    const maxNum = Math.max(
      ...readdirSync(MIGRATIONS_DIR)
        .map((f) => /^(\d{4})_.*\.sql$/.exec(f))
        .filter(Boolean)
        .map((m) => Number((m as RegExpExecArray)[1])),
    );
    // 0117 is no longer newest (0118 added intake terminal-immutability).
    expect(maxNum).toBeGreaterThanOrEqual(117);
    expect(FILE).toMatch(/^0117_/);
  });
});

describe("0117 — session_audit cross-tenant INSERT hardening", () => {
  it("replaces the session_audit INSERT policy (drop + create)", () => {
    expect(SQL_CODE).toMatch(
      /drop policy if exists "session_audit_studio_member_insert" on public\.session_audit;/,
    );
    expect(SQL_CODE).toMatch(
      /create policy "session_audit_studio_member_insert"\s+on public\.session_audit for insert/,
    );
  });

  it("keeps the actor binding AND adds the session-in-my-studio binding", () => {
    // Actor still bound to the caller's own active practitioners.
    expect(SQL_CODE).toMatch(
      /edited_by_practitioner_id in \(\s*select id from public\.practitioners\s+where user_id = auth\.uid\(\) and active = true\s*\)/,
    );
    // NEW: the target session must be in a studio the caller is a member of.
    expect(SQL_CODE).toMatch(/and session_id in \(/);
    expect(SQL_CODE).toMatch(/join public\.clients c on s\.client_id = c\.id/);
    expect(SQL_CODE).toMatch(/where c\.studio_id in \(/);
  });

  it("changes ONLY the INSERT policy — no SELECT/UPDATE/DELETE policy, no grant, no schema/data change", () => {
    // Only the INSERT policy is dropped/created.
    expect(SQL_CODE).not.toMatch(/for (select|update|delete)/i);
    expect(SQL_CODE).not.toMatch(/studio_member_read/);
    expect(SQL_CODE).not.toMatch(/\bgrant\b|\brevoke\b/i);
    expect(SQL_CODE).not.toMatch(/alter table/i);
    expect(SQL_CODE).not.toMatch(/add column|drop column/i);
    expect(SQL_CODE).not.toMatch(/^\s*update\s/im);
    expect(SQL_CODE).not.toMatch(/^\s*delete\s+from/im);
    expect(SQL_CODE).not.toMatch(/^\s*insert\s+into/im);
    // Exactly one policy dropped + one created.
    expect((SQL_CODE.match(/drop policy/gi) ?? []).length).toBe(1);
    expect((SQL_CODE.match(/create policy/gi) ?? []).length).toBe(1);
  });
});
