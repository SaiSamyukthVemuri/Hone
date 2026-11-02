import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { countVersion, fileForVersion } from "./helpers/migration-state";

// 0275: source contract. Behaviour is proved in tests/db/receptionist-removal-invitations.db.test.ts (CI only).
const sql = readFileSync("supabase/migrations/0275_receptionist_removal_revokes_invitations.sql", "utf8");
const code = sql.replace(/^\s*--.*$/gm, "");

describe("0275: removal revokes outstanding invitations", () => {
  it("owns one filename and opens its own transaction with lock_timeout inside", () => {
    expect(countVersion("0275")).toBe(1);
    expect(fileForVersion("0275")).toBe("0275_receptionist_removal_revokes_invitations.sql");
    expect(code.trim()).toMatch(/^begin;\s*set local lock_timeout = '5s';/);
    expect(code.trim()).toMatch(/commit;$/);
  });
  it("replaces only set_studio_receptionist_active, keeps its signature, and adds no table, column, index or drop", () => {
    expect(code.match(/create or replace function/gi)).toHaveLength(1);
    expect(code).toMatch(/create or replace function public\.set_studio_receptionist_active\(\s*p_studio_id\s+uuid,\s*p_owner_practitioner_id\s+uuid,\s*p_receptionist_id\s+uuid,\s*p_active\s+boolean\s*\)\s*returns text/);
    expect(code).not.toMatch(/\b(create\s+table|alter\s+table|create\s+(unique\s+)?index|drop\s+|truncate|delete\s+from)\b/i);
  });
  it("revokes only this studio's PENDING RECEPTIONIST invitations for the row's email, and only on deactivation", () => {
    const upd = code.match(/update public\.pending_invitations[\s\S]*?;/)![0];
    expect(upd).toMatch(/status = 'revoked'/);
    expect(upd).toMatch(/studio_id = p_studio_id/);
    expect(upd).toMatch(/role = 'receptionist'/);
    expect(upd).toMatch(/status = 'pending'/);
    expect(upd).toMatch(/lower\(email\) = lower\(v_row\.email\)/);
    expect(code).toMatch(/if not p_active and v_row\.email is not null then/);
    expect(code.indexOf("update public.pending_invitations")).toBeLessThan(code.indexOf("return 'no_change'"));
  });
  it("revokes execute from public, anon and authenticated by name and grants service_role only", () => {
    const sig = "public\\.set_studio_receptionist_active\\(uuid, uuid, uuid, boolean\\)";
    for (const r of ["public", "anon", "authenticated"]) expect(code).toMatch(new RegExp(`revoke execute on function ${sig} from ${r};`));
    expect(code).toMatch(new RegExp(`grant execute on function ${sig} to service_role;`));
    expect(code).not.toMatch(/to (anon|authenticated|public);/);
  });
});
