import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { countVersion, fileForVersion } from "./helpers/migration-state";

// 0281 identity revisions, identity audit and the atomic profile save: source contract. Behaviour is proved in
// tests/db/identity-atomic-save.db.test.ts. No repo-max pin (CLAUDE.md section 2).
const FILE = "supabase/migrations/0281_identity_revisions_audit_atomic_save.sql";
const sql = readFileSync(FILE, "utf8");
const code = sql.replace(/^\s*--.*$/gm, "");

describe("0281 source contract", () => {
  it("is the only file with its number and opens its own transaction with a lock timeout inside it", () => {
    expect(countVersion("0281")).toBe(1);
    expect(fileForVersion("0281")).toContain("0281_identity_revisions_audit_atomic_save.sql");
    expect(code).toMatch(/^\s*begin;\s*set local lock_timeout = '5s';/m);
    expect(code.trimEnd()).toMatch(/commit;$/);
  });

  it("AT1: the audit is readable by owner and practitioner only (the legal-identity gate), never by is_studio_member alone", () => {
    expect(code).toMatch(/create policy client_identity_audit_select[\s\S]*?using \(public\.can_use_client_legal_identity\(studio_id\)\)/);
    expect(code).not.toMatch(/client_identity_audit_select[^;]*is_studio_member/);
    expect(code).toMatch(/revoke all on public\.client_identity_audit from public, anon, authenticated, service_role;/);
    expect(code).toMatch(/grant select on public\.client_identity_audit to authenticated;/);
    expect(code).not.toMatch(/grant (insert|update|delete)[^;]*client_identity_audit/);
  });

  it("AT2: the clients trigger fires on EVERY insert and update and overwrites the revision columns", () => {
    expect(code).toMatch(/create trigger clients_identity_guard\s+before insert or update on public\.clients/);
    expect(code).not.toMatch(/before insert or update of name/);
    expect(code).toMatch(/new\.name_revision := 1;/);
    expect(code).toMatch(/new\.name_revision := old\.name_revision;/);
    expect(code).toMatch(/new\.preferred_name_revision := old\.preferred_name_revision;/);
  });

  it("AT4: the header claims no column privilege that the file does not contain", () => {
    expect(sql).not.toMatch(/column privileges below/);
    expect(code).not.toMatch(/grant update \(/i);
  });

  it("the trigger functions and the save function revoke all four API roles by name; the save is invoker-rights", () => {
    for (const fn of ["clients_identity_guard()", "client_legal_identities_revision()"]) {
      expect(code).toContain(`revoke all on function public.${fn} from public, anon, authenticated, service_role;`);
    }
    expect(code).toContain(
      "revoke all on function public.update_client_profile_if_unchanged(uuid, uuid, jsonb, jsonb) from public, anon, authenticated, service_role;",
    );
    expect(code).toContain("grant execute on function public.update_client_profile_if_unchanged(uuid, uuid, jsonb, jsonb) to authenticated;");
    expect(code).toMatch(/security invoker/);
  });
});
