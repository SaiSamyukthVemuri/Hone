import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { countVersion, fileForVersion } from "./helpers/migration-state";

// 0266 (provisional number, taken from the next free slot named in Sam's HON-58
// Q1 decision; OPS records the reservation). Source contract only; behaviour is
// proved in tests/db/legal-name-access.db.test.ts. No repo-max pin (CLAUDE.md §2).

const FILE = "supabase/migrations/0266_legal_name_receptionist_access.sql";
const sql = readFileSync(FILE, "utf8");
const code = sql.replace(/^\s*--.*$/gm, "").replace(/comment on [^;]*;/gi, "");

describe("0266 legal-name receptionist access: source contract", () => {
  it("owns exactly one filename and does not edit 0258", () => {
    expect(countVersion("0266")).toBe(1);
    expect(fileForVersion("0266")).toBe("0266_legal_name_receptionist_access.sql");
    expect(code).not.toMatch(/alter\s+table\s+public\.client_legal_identities|create or replace function public\.can_use_client_legal_identity/i);
  });

  it("opens its own transaction with lock_timeout inside it", () => {
    expect(code.trim()).toMatch(/^begin;\s*set local lock_timeout = '5s';/);
    expect(code.trim()).toMatch(/commit;$/);
  });

  it("the switch defaults OFF, there is no backfill and no data change", () => {
    expect(code).toMatch(/receptionist_access boolean not null default false/);
    expect(code).not.toMatch(/\b(update\s+public\.(?!studio_legal_name_access)|delete\s+from|truncate\s+public|default\s+true)/i);
    // the only inserts: the default OFF row and the audit row, both inside the command
    expect([...code.matchAll(/insert\s+into\s+public\.(\w+)/gi)].map((m) => m[1]).sort()).toEqual(["client_legal_name_access_audit", "studio_legal_name_access"]);
  });

  it("only the legal-identity SELECT policy moves to the read predicate; writes stay on the 0258 predicate", () => {
    expect(code).toContain("drop policy client_legal_identities_select on public.client_legal_identities;");
    expect(code).toMatch(/create policy client_legal_identities_select[\s\S]*?using \(public\.can_read_client_legal_identity\(studio_id\)\);/);
    expect(code).not.toMatch(/client_legal_identities_(insert|update)/);
  });

  it("the read predicate is owner/practitioner OR an ACTIVE receptionist of that studio with the switch ON, defaulting to false", () => {
    const fn = code.match(/create function public\.can_read_client_legal_identity[\s\S]*?\$\$;/)![0];
    expect(fn).toMatch(/security definer/);
    expect(fn).toMatch(/set search_path = pg_catalog, pg_temp\n/);
    expect(fn).toContain("public.is_studio_member(target_studio_id)");
    expect(fn).toContain("public.receptionist_actor_id(target_studio_id) is not null");
    expect(fn).toMatch(/coalesce\(\s*\(select s\.receptionist_access[\s\S]*?false\)/);
  });

  it("the command is owner-only for THIS studio and audits in the same function", () => {
    const fn = code.match(/create function public\.set_receptionist_legal_name_access[\s\S]*?\$\$;/)![0];
    expect(fn).toMatch(/p\.studio_id = p_studio_id and p\.user_id = auth\.uid\(\) and p\.active and p\.role = 'owner'/);
    expect(fn).toContain("using errcode = '42501'");
    expect(fn).toMatch(/insert into public\.client_legal_name_access_audit/);
    expect(fn).toMatch(/v_old is not distinct from p_enabled then\s+return false/);
  });

  it("every default grant is revoked by name; only authenticated is granted; no table write grant exists", () => {
    for (const f of [
      "public.set_receptionist_legal_name_access(uuid, boolean)",
      "public.can_read_client_legal_identity(uuid)",
      "public.receptionist_client_contacts_v2(uuid, text, integer)",
      "public.client_legal_name_access_audit_immutable()",
    ]) expect(code).toContain(`revoke all on function ${f} from public, anon, authenticated, service_role;`);
    expect(code).toContain("revoke all on public.studio_legal_name_access from public, anon, authenticated, service_role;");
    expect(code).toContain("grant select on public.studio_legal_name_access to authenticated;");
    expect(code).toContain("grant select on public.client_legal_name_access_audit to authenticated;");
    expect(code).not.toMatch(/grant[^;]*\b(service_role|anon)\b/i);
    expect(code).not.toMatch(/grant[^;]*\b(insert|update|delete)\b[^;]*studio_legal_name_access/i);
  });

  it("the audit's identity sequence is revoked from every API role by name (Privacy G6)", () => {
    expect(code).toContain("revoke all on sequence public.client_legal_name_access_audit_id_seq from public, anon, authenticated, service_role;");
  });

  it("the receptionist finder never reads or matches the legal table or the stored name behind a preferred one", () => {
    const fn = code.match(/create function public\.receptionist_client_contacts_v2[\s\S]*?\$\$;/)![0];
    expect(fn).not.toMatch(/client_legal_identities|legal_/);
    // no intake or consent fact: the 0243-pinned set of intake-reading definers is unchanged
    expect(fn).not.toMatch(/client_intake_forms|client_consent_signatures/);
    expect(fn).toContain("coalesce(nullif(pg_catalog.btrim(c.preferred_name), ''), c.name) as display_name");
    expect(fn).toMatch(/d\.display_name ilike v_pattern/);
    expect(fn).not.toMatch(/\bc\.name ilike/);
  });

  it("closes the 0216 v1 finder by privilege (its source is pinned by 0243) and never re-creates it", () => {
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      expect(code).toContain(`revoke execute on function public.receptionist_client_contacts(uuid, text, integer) from ${role};`);
    }
    expect(code).not.toMatch(/create (or replace )?function public\.receptionist_client_contacts\(/);
  });

  it("the desk calendar projection shows the display identity, keeps its grants, and v2 carries name_on_file", () => {
    const cal = code.match(/create or replace function public\.receptionist_calendar[\s\S]*?\$\$;/)![0];
    expect(cal).toMatch(/coalesce\(nullif\(pg_catalog\.btrim\(c\.preferred_name\), ''\), c\.name\)/);
    expect(cal).not.toMatch(/\bc\.name\s*\n\s*from/);
    for (const role of ["public", "anon", "service_role"]) expect(code).toContain(`revoke execute on function public.receptionist_calendar(uuid, timestamptz, timestamptz) from ${role};`);
    expect(code).toContain("grant execute on function public.receptionist_calendar(uuid, timestamptz, timestamptz) to authenticated;");
    expect(code.match(/create function public\.receptionist_client_contacts_v2[\s\S]*?\$\$;/)![0]).toMatch(/name_on_file\s+boolean/);
  });
});
