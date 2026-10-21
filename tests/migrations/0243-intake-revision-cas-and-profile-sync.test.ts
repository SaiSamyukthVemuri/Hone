import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { countVersion, fileForVersion } from "./helpers/migration-state";

const sql = readFileSync("supabase/migrations/0243_intake_revision_cas_and_profile_sync.sql", "utf8");
const code = sql.replace(/^\s*--.*$/gm, "");
const publicAction = readFileSync("app/intake/[token]/actions.ts", "utf8");
const assisted = readFileSync("app/(app)/clients/[id]/intake/actions.ts", "utf8");

describe("0243 scoped intake revision and atomic profile contract", () => {
  it("is allocated once with the governed file; global maximum stays derived", () => {
    expect(countVersion("0243")).toBe(1);
    expect(fileForVersion("0243")).toBe("0243_intake_revision_cas_and_profile_sync.sql");
  });
  it("is one bounded transaction without modifying the frozen terminal guards", () => {
    expect(code.trim()).toMatch(/^begin;/);
    expect(code).toContain("set local lock_timeout = '5s';");
    expect(code.trim()).toMatch(/commit;$/);
    expect(code).not.toMatch(/(?:replace|drop)\s+function\s+public\.(?:set_updated_at|enforce_intake_terminal_immutability)/i);
  });
  it("never accepts a caller counter and bumps every existing writer", () => {
    expect(code).toMatch(/new\.revision := 0/);
    expect(code).toMatch(/new\.revision := old\.revision \+ 1/);
    expect(code).toMatch(/before insert or update on public\.client_intake_forms/);
  });
  it("locks the exact scoped intake and rejects missing, terminal and stale revisions", () => {
    expect(code).toMatch(/f\.id = p_intake_id and f\.studio_id = p_studio_id\s+and f\.client_id = p_client_id and f\.deleted_at is null\s+for update/);
    expect(code).toContain("v_intake.revision <> p_expected_revision");
    expect(code).toContain("v_intake.status <> 'in_progress'");
    for (const outcome of ["not_available", "terminal", "conflict"]) {
      expect(code).toContain(`select '${outcome}'::text, null::text`);
    }
  });
  it("keeps the scoped CAS predicate on the actual UPDATE and returns its new revision", () => {
    expect(code).toMatch(/f\.status = 'in_progress' and f\.revision = p_expected_revision/);
    expect(code).toContain("returning f.revision::text into v_revision");
  });
  it("locks intake before client and rolls back profile failure instead of swallowing it", () => {
    const intakeLock = code.indexOf("select f.* into v_intake");
    const clientLock = code.indexOf("perform 1 from public.clients");
    const submit = code.indexOf("update public.client_intake_forms f");
    const profile = code.indexOf("update public.clients c set");
    expect(clientLock).toBeGreaterThan(intakeLock);
    expect(submit).toBeGreaterThan(clientLock);
    expect(profile).toBeGreaterThan(submit);
    expect(code).toContain("raise exception 'Intake profile update unavailable'");
    expect(code).not.toMatch(/exception\s+when/);
    expect(code).toContain("else c.allergies ||");
    expect(code).toContain("where c.id = p_client_id and c.studio_id = p_studio_id");
  });
  it("has no browser execution grant or generic profile patch", () => {
    expect(code).toMatch(/write_intake_revision\([^;]+from public, anon, authenticated;/);
    expect(code).toMatch(/grant execute on function public\.write_intake_revision\([^;]+to service_role;/);
    expect(code).not.toMatch(/grant\s+(?:all|execute)[^;]+to\s+(?:anon|authenticated)/i);
    expect(code).toContain("v_profile_key not in");
    expect(code).toContain("p_operation <> 'submit' and p_profile <> '{}'::jsonb");
  });
  it("public and assisted merges name the revision they saw; only the submit winner notifies", () => {
    expect(publicAction).toContain("intakeRevision(payload.expectedRevision)");
    expect(assisted).toContain("intakeRevision(payload.expectedRevision)");
    expect(assisted).toContain('formData.get("expected_revision")');
    expect(assisted).not.toContain('operation: "submit"');
    const submit = publicAction.slice(publicAction.indexOf("export async function submitIntakeAction"));
    expect(submit.indexOf("if (!written.ok) return written")).toBeLessThan(submit.indexOf("recordPractitionerNotification({"));
    expect(publicAction).not.toContain("await syncIntakeToClient");
  });
});
