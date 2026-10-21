import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { countVersion, fileForVersion } from "./helpers/migration-state";
const sql = readFileSync("supabase/migrations/0246_intake_questionnaire_snapshot.sql", "utf8");
const code = sql.replace(/^\s*--.*$/gm, "");

describe("0246 prospective-only snapshot boundary", () => {
  it("has one allocated transaction and nullable column without default/adoption", () => {
    expect(countVersion("0246")).toBe(1);
    expect(fileForVersion("0246")).toBe("0246_intake_questionnaire_snapshot.sql");
    expect(code.trim()).toMatch(/^begin;/);
    expect(code).toContain("set local lock_timeout = '5s'");
    expect(code.trim()).toMatch(/commit;$/);
    expect(code).toContain("add column questionnaire_snapshot jsonb;");
    expect(code).not.toMatch(/\bupdate\s+public\.|\bgrant\b|create\s+table|security\s+definer|default\s+/i);
  });
  it("pins exact issue content and guards every update, including NULL adoption and service-role writes", () => {
    expect(code).toContain("approved constant jsonb := $catalogue$");
    expect(code).toContain("new.questionnaire_snapshot <> approved");
    expect(code).toContain("new.questionnaire_snapshot := approved");
    expect(code).toContain("new.questionnaire_snapshot is distinct from old.questionnaire_snapshot");
    expect(code).toContain("before insert or update on public.client_intake_forms");
    expect(code).toContain("from public, anon, authenticated, service_role");
    expect(code).not.toMatch(/auth\.role|session_user|current_user|disable\s+trigger|write_intake_revision/);
  });
  it("uses row-catalogue step limits on save, submit and assisted handoff", () => {
    const client = readFileSync("app/intake/[token]/actions.ts", "utf8");
    const assisted = readFileSync("app/(app)/clients/[id]/intake/actions.ts", "utf8");
    expect(client).toContain("catalogue.steps.some(s => s.id === step)");
    expect(client).toContain('step: catalogue.steps[catalogue.steps.length - 1].id, operation: "submit"');
    expect(assisted).toContain("const lastStep = loaded.catalogue.steps[loaded.catalogue.steps.length - 1].id");
    expect(assisted).toContain('step: lastStep, operation: "handoff"');
  });
  it("only existing trusted creation inserts name the issued catalogue; export remains pending", () => {
    const creators = readFileSync("lib/intake/queries.ts", "utf8");
    expect(creators.match(/questionnaire_snapshot: ISSUED_QUESTIONNAIRE/g)).toHaveLength(2);
    const registry = readFileSync("lib/export/resource-registry.ts", "utf8");
    expect(registry).toMatch(/client_intake_forms:\s*\{\s*kind: "pending",\s*ticket: "TRUTH-01B"/);
  });
});
