import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { exportedResources } from "@/lib/export/resource-registry";
import { countVersion, fileForVersion } from "./helpers/migration-state";

const sql = readFileSync("supabase/migrations/0242_close_direct_generic_audit_inserts.sql", "utf8");
const code = sql.replace(/^\s*--.*$/gm, "");
const helper = readFileSync("lib/audit/governed-writes.ts", "utf8");
const clients = readFileSync("app/(app)/clients/[id]/actions.ts", "utf8");
const exporter = readFileSync("app/(app)/settings/data/actions.ts", "utf8");

describe("0242 closes direct generic audit forgery without expanding authority", () => {
  it("uses its allocated filename once, with a bounded transaction", () => {
    expect(countVersion("0242")).toBe(1);
    expect(fileForVersion("0242")).toBe("0242_close_direct_generic_audit_inserts.sql");
    expect(code.trim()).toMatch(/^begin;/);
    expect(code).toContain("set local lock_timeout = '5s';");
    expect(code.trim()).toMatch(/commit;$/);
  });
  it("closes PUBLIC/anon/authenticated table and column grants, independently of policies", () => {
    expect(code).toContain('drop policy if exists "audit_logs: members insert" on public.audit_logs');
    expect(code).toContain("revoke insert on table public.audit_logs from public, anon, authenticated");
    expect(code).toContain("revoke insert (%I) on table public.audit_logs from public, anon, authenticated");
    for (const role of ["anon", "authenticated"]) {
      expect(code).toContain(`has_table_privilege('${role}', 'public.audit_logs', 'INSERT')`);
      expect(code).toContain(`has_any_column_privilege('${role}', 'public.audit_logs', 'INSERT')`);
    }
  });
  it("requires existing table authority, only explicit narrow EXECUTE, no history rewrite", () => {
    expect(code).toContain("if not has_table_privilege('service_role', 'public.audit_logs', 'INSERT')");
    expect(code).not.toMatch(/grant\s+(?:insert|update|delete|select)|grant[^;]+on\s+table/i);
    expect(code.match(/grant execute on function/g)).toHaveLength(2);
    expect(code).not.toMatch(/create\s+(?:table|policy)|update\s+public\.audit_logs|delete\s+from\s+public\.audit_logs/i);
    expect(code).not.toMatch(/drop policy[^;]+members read/);
    expect(code).not.toContain("record_clinical_records_audit");
  });
  it("the three user action writers use a typed server-only helper, without a generic transport", () => {
    expect(helper).toContain('import "server-only"');
    expect(helper).not.toContain('"use server"');
    expect(helper).toContain("getCurrentPractitionerWithStudio()");
    expect(helper).toContain('practitioner.role !== "owner"');
    expect(helper).toContain('studio.id !== input.expectedStudioId');
    expect(helper).toContain('.eq("id", input.clientId).eq("studio_id", studio.id)');
    expect(helper).not.toMatch(/actor_id:\s*input\.|studio_id:\s*input\.|action:\s*input\.action|metadata:\s*input\.metadata/);
    expect(helper).not.toContain('"clinical_records_');
  });
  it("migrates exactly the three existing callers while preserving their failure gates", () => {
    expect(clients).not.toContain('.from("audit_logs").insert');
    expect(exporter).not.toContain('.from("audit_logs").insert');
    expect(clients).toContain('change: "archive", archivedAt: nowIso');
    expect(clients).toContain('change: "unarchive"');
    expect(clients.match(/if \(auditErr\)/g)).toHaveLength(2);
    expect(exporter).toContain("await recordStudioExportAudit({");
    expect(exporter).toContain("if (auditError)");
    expect(exporter).toContain("Could not record the export audit entry. Try again.");
  });
});

describe("0242 atomic governed service commands", () => {
  it("pins the operation-specific SQL metadata map to the actual export registry", () => {
    const raw = sql.match(/\$registry\$([\s\S]*?)\$registry\$/)?.[1];
    expect(raw).toBeDefined();
    expect(JSON.parse(raw!)).toEqual(Object.fromEntries(exportedResources().map(({ resource, disposition }) => [resource, disposition.file])));
  });
  it("preserves0178 SELECT-only runtimes and validates actual trusted owner separately from ACLs", () => {
    const frozen = readFileSync("supabase/migrations/0178_practitioner_identity_boundary.sql", "utf8");
    expect(frozen).toContain("revoke all privileges on table public.practitioners");
    expect(frozen).toContain("grant select on table public.practitioners");
    expect(code).not.toMatch(/grant\s+update|alter\s+role|create\s+role|grant[^;]+to\s+(?:anon|authenticated)/i);
    expect(code).toContain("v_function is null or v_owner is null or not exists");
    expect(code.indexOf("v_function is null")).toBeLessThan(code.indexOf("lateral pg_catalog.aclexplode"));
    expect(code).toContain("p.proconfig=array['search_path=\"\"','lock_timeout=5s']::pg_catalog.text[]");
    expect(code).toContain("pg_catalog.pg_has_role(v_role.oid,v_owner,'MEMBER')");
    expect(code).toContain("pg_catalog.pg_has_role(v_role.oid,v_owner,'SET')");
    expect(code).toContain("v_owner<>v_expected_owner");
    expect(code).toContain("pg_catalog.has_table_privilege(v_expected_owner,v_required.table_name,v_required.privilege_name)");
    expect(code).toContain("Runtime practitioner identity boundary unexpectedly widened");
  });
  it("binds membership locks and audit insertion in each narrow transaction", () => {
    for (const name of ["record_client_archive_audit_governed", "record_studio_export_audit_governed"]) {
      const start = code.indexOf(`create function public.${name}(`);
      const body = code.slice(start, code.indexOf("$$;", start));
      expect(start).toBeGreaterThan(-1);
      expect(body).toContain("security definer set search_path = ''");
      expect(body).toContain("p.user_id=p_user_id");
      expect(body.indexOf("for update")).toBeLessThan(body.indexOf("insert into public.audit_logs"));
      expect(code).toContain(`grant execute on function public.${name}(`);
    }
    expect(code).toContain("p.active is true and p.role='owner' for update");
    expect(helper).not.toContain('.from("audit_logs").insert');
    expect(helper).toContain('admin.rpc("record_studio_export_audit_governed"');
    expect(helper).toContain('recorded !== true');
    expect(code).toContain("a.grantee<>v_owner and a.is_grantable");
  });
});
