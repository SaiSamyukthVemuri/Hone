import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { countVersion, fileForVersion } from "./helpers/migration-state";

// 0272 (reserved by OPS: "0258 legal-identity hardening", applied right after
// 0258). Source contract only; behaviour is proved in
// tests/db/hon58-legal-identity-hardening.db.test.ts. No repo-max pin (CLAUDE.md §2).
//
// 0258 is SEALED: this test pins its bytes, so a fix to it can only arrive as a
// new migration like this one.

const SEALED_0258_SHA256 = "12c8109d41059e78fbc7df2af3a5a15b5bfcd3c17e0a5453e385cff0cc1cfd78";
const sql = readFileSync("supabase/migrations/0272_hon58_legal_identity_hardening.sql", "utf8");
const code = sql.replace(/^\s*--.*$/gm, "").replace(/comment on [^;]*;/gi, "");

describe("0272 legal-identity hardening: source contract", () => {
  it("owns exactly one filename", () => {
    expect(countVersion("0272")).toBe(1);
    expect(fileForVersion("0272")).toBe("0272_hon58_legal_identity_hardening.sql");
  });

  it("leaves the sealed 0258 byte-identical", () => {
    const bytes = readFileSync("supabase/migrations/0258_hon58_identity.sql");
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(SEALED_0258_SHA256);
  });

  it("opens its own transaction with lock_timeout inside it", () => {
    expect(code.trim()).toMatch(/^begin;\s*set local lock_timeout = '5s';/);
    expect(code.trim()).toMatch(/commit;$/);
  });

  it("changes no data and creates or drops no table, column, policy or grant to a role", () => {
    expect(code).not.toMatch(/\b(insert\s+into|update\s+public\.|delete\s+from|truncate|drop\s+(table|column|policy|function))/i);
    expect(code).not.toMatch(/\balter\s+table\b|\bcreate\s+(table|policy|index)\b/i);
    expect(code).not.toMatch(/grant[^;]*\b(service_role|anon)\b/i);
  });

  it("moves both 0258 invoker functions to search_path = pg_catalog, pg_temp, and keeps them invoker", () => {
    const fns = [...code.matchAll(/create or replace function public\.(\w+)[\s\S]*?\$\$;/g)];
    expect(fns.map((m) => m[1])).toEqual(["can_use_client_legal_identity", "client_legal_identities_guard"]);
    for (const m of fns) {
      expect(m[0]).toContain("set search_path = pg_catalog, pg_temp");
      expect(m[0]).not.toMatch(/security\s+definer/i);
    }
  });

  it("the guard owns provenance on insert and update: caller's own active practitioner row, database timestamps", () => {
    const guard = code.match(/create or replace function public\.client_legal_identities_guard[\s\S]*?\$\$;/)![0];
    expect(guard).toContain("new.updated_by := (");
    expect(guard).toMatch(/p\.studio_id = new\.studio_id\s+and p\.user_id = auth\.uid\(\)\s+and p\.active = true/);
    expect(guard).toMatch(/new\.created_at := pg_catalog\.now\(\)/);
    expect(guard).toMatch(/new\.updated_at := pg_catalog\.now\(\)/);
    expect(code).toMatch(/create trigger client_legal_identities_guard\s+before insert or update on public\.client_legal_identities/);
  });

  it("re-asserts every default grant by name and grants only authenticated", () => {
    expect(code).toContain("revoke all on function public.can_use_client_legal_identity(uuid) from public, anon, authenticated, service_role;");
    expect(code).toContain("grant execute on function public.can_use_client_legal_identity(uuid) to authenticated;");
    expect(code).toContain("revoke all on function public.client_legal_identities_guard() from public, anon, authenticated, service_role;");
  });
});
