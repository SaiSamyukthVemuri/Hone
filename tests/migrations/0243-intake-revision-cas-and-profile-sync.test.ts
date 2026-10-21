import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
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
  it("stages additive callers before enforcing ordinary protected DML without a caller bypass", () => {
    const additiveGuard = code.slice(code.indexOf("create function public.advance_intake_revision"), code.indexOf("create trigger"));
    expect(additiveGuard).not.toMatch(/raise exception|current_user|v_writer_owner/);
    expect(additiveGuard).toContain("new.revision := old.revision + 1");
    const writer = code.slice(code.indexOf("create function public.write_intake_revision"), code.indexOf("revoke execute on function public.write_intake_revision"));
    expect(additiveGuard).toMatch(/security invoker set search_path = ''/);
    expect(writer).toMatch(/security definer set search_path = ''/);
    expect(code).toContain("client_intake_forms_zz_advance_revision");
    expect(code).toContain("pg_catalog.pg_has_role(v_role.oid, v_owner, 'MEMBER')");
    expect(code).toContain("pg_catalog.pg_has_role(v_role.oid, v_owner, 'SET')");
    expect(code).toContain("p.oid = v_guard and not p.prosecdef and p.proowner = v_owner");
    expect(code).toContain("Unsafe intake revision command privileges.");
    expect(code).toContain("Unexpected callable intake definer requires review.");
    expect(additiveGuard).not.toMatch(/current_setting|session_user|pg_trigger_depth|auth\.uid/);
  });
  it("permits only the exact reviewed read-only receptionist delegate, never a name-only exception", () => {
    const foundation = readFileSync("supabase/migrations/0216_receptionist_membership_foundation.sql", "utf8");
    const body = foundation.split("create or replace function public.receptionist_client_contacts(")[1].split("as $$")[1].split("$$;")[0];
    const fingerprint = createHash("sha256").update(body).digest("hex");
    expect(code).toContain(`pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p.prosrc, 'UTF8')), 'hex') = '${fingerprint}'`);
    expect(code).toContain("public.receptionist_client_contacts(pg_catalog.uuid,pg_catalog.text,pg_catalog.int4)");
    expect(code).toContain("p.proowner = v_owner and p.provolatile = 's' and p.prokind = 'f'");
    expect(code).toContain("p.proconfig = array['search_path=pg_catalog, pg_temp']::text[]");
    expect(code).toContain(") is not true");
    expect(code).toContain("and not pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')");
    expect(code).toContain("and not pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE')");
    expect(body).not.toMatch(/\b(?:insert|update|delete|execute|perform)\b/i);
    expect(body).toContain("public.receptionist_actor_id(p_studio_id)");
    expect(body).toContain("f.studio_id = c.studio_id");
    expect(body).toContain("c.studio_id = p_studio_id");
    const helperBody = foundation.split("create or replace function public.receptionist_actor_id(")[1].split("as $$")[1].split("$$;")[0];
    const helperFingerprint = createHash("sha256").update(helperBody).digest("hex");
    expect(code).toContain(`pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(helper.prosrc, 'UTF8')), 'hex') = '${helperFingerprint}'`);
    expect(code).toContain("helper.proowner = p.proowner and helper.prosecdef");
    expect(code).toContain("helper.provolatile = 's' and helper.prokind = 'f'");
    expect(code).toContain("a.grantee <> helper.proowner");
    expect(code).toContain("a.grantee <> p.proowner and a.is_grantable");
    expect(code).toContain("a.grantee <> v_owner and a.is_grantable");
    expect(code).toContain("and not pg_catalog.has_function_privilege('authenticated', helper.oid, 'EXECUTE')");
    expect(helperBody).not.toMatch(/\b(?:insert|update|delete|execute|perform)\b/i);
    expect(helperBody).toContain("sr.user_id = auth.uid()");
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
      expect(code).toContain(`select '${outcome}'::pg_catalog.text, null::pg_catalog.text`);
    }
  });
  it("keeps the scoped CAS predicate on the actual UPDATE and returns its new revision", () => {
    expect(code).toMatch(/f\.status = 'in_progress' and f\.revision = p_expected_revision/);
    expect(code).toContain("returning f.revision::pg_catalog.text into v_revision");
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
    expect(code).toContain("p_operation <> 'submit' and p_profile <> '{}'::pg_catalog.jsonb");
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
