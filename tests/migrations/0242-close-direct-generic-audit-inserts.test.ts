import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
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
  it("requires existing service authority without granting anything or rewriting history", () => {
    expect(code).toContain("if not has_table_privilege('service_role', 'public.audit_logs', 'INSERT')");
    expect(code).not.toMatch(/\bgrant\s/i);
    expect(code).not.toMatch(/create\s+(?:function|table|policy)|update\s+public\.audit_logs|delete\s+from\s+public\.audit_logs/i);
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
