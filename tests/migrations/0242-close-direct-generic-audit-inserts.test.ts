import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { exportedResources } from "@/lib/export/resource-registry";

const sql = readFileSync("supabase/migrations/0242_close_direct_generic_audit_inserts.sql", "utf8");
const code = sql.replace(/^\s*--.*$/gm, "");
const helper = readFileSync("lib/audit/governed-writes.ts", "utf8");
const clients = readFileSync("app/(app)/clients/[id]/actions.ts", "utf8");
const exporter = readFileSync("app/(app)/settings/data/actions.ts", "utf8");

describe("0242 closes direct generic audit forgery without expanding authority", () => {
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
    const registry = Object.fromEntries(exportedResources().map(({ resource, disposition }) => [resource, disposition.file]));
    // 0242 is frozen history: every entry it carries is still the registry's file for that resource.
    for (const [resource, file] of Object.entries(JSON.parse(raw!))) expect(registry[resource], resource).toBe(file);
  });
  it("0325 replaces the map with 0242's plus exactly waitlist_decline_answers, and the registry never outruns it", () => {
    const later = readFileSync("supabase/migrations/0325_waitlist_decline_followups.sql", "utf8");
    const raw = sql.match(/\$registry\$([\s\S]*?)\$registry\$/)?.[1];
    const next = later.match(/\$registry\$([\s\S]*?)\$registry\$/)?.[1];
    expect(next).toBeDefined();
    expect(JSON.parse(next!)).toEqual({ ...JSON.parse(raw!), waitlist_decline_answers: "waitlist-decline-answers.csv" });
    const registry = Object.fromEntries(exportedResources().map(({ resource, disposition }) => [resource, disposition.file]));
    // Every exported resource must be in the LATEST map (otherwise a production export would fail its audit step).
    for (const [resource, file] of Object.entries(registry)) expect(JSON.parse(next!)[resource], resource).toBe(file);
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
