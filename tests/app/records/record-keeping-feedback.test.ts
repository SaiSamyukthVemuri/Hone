import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// PR #280 (Chloe record-keeping feedback). The forms are not DOM-rendered here
// (node env), so these are source/wiring pins proving each fix is in place +
// persisted same-studio. Behavioral DB proof: tests/db/record-keeping-discard-due.db.test.ts.

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

const FORMS = read("app/(app)/records/record-forms.tsx");
const ACTIONS = read("app/(app)/records/actions.ts");
const PAGE = read("app/(app)/records/page.tsx");

describe("disinfectant discard/replace-by date + read-time alert", () => {
  it("forms have a distinct discard/replace-by field separate from prepared + actual discarded", () => {
    expect(FORMS).toMatch(/name="discard_due_date"/);
    expect(FORMS).toMatch(/Discard \/ replace by/);
    expect(FORMS).toMatch(/Actual date discarded/);
    expect(FORMS).toMatch(/name="date_prepared"/);
    expect(FORMS).toMatch(/name="date_discarded"/);
  });
  it("create + update actions persist discard_due_date", () => {
    expect((ACTIONS.match(/discard_due_date:/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(ACTIONS).toMatch(/dateStr\(formData\.get\("discard_due_date"\)\)/);
  });
  it("the page computes read-time due/overdue status (no cron/notification)", () => {
    expect(PAGE).toMatch(/disinfectantDueStatus\(r, today\)/);
    expect(PAGE).toMatch(/todayInTz\(timezone\)/);
    expect(PAGE).not.toMatch(/practitioner_notifications|recordPractitionerNotification|api\/cron/);
  });
});

describe("operator dropdown from same-studio staff (free-text fallback)", () => {
  it("renders an OperatorPicker fed by a same-studio staff list", () => {
    expect(FORMS).toMatch(/function OperatorPicker/);
    expect(FORMS).toMatch(/name="operator_practitioner_id"/);
    expect(FORMS).toMatch(/Other \(type a name\)/);
    expect(PAGE).toMatch(/getPractitionersForStudio\(studioId\)/);
  });
  it("the action resolves a SAME-STUDIO active practitioner (cross-studio falls back to free text)", () => {
    expect(ACTIONS).toMatch(/async function resolveOperator/);
    expect(ACTIONS).toMatch(/from\("practitioners"\)[\s\S]*\.eq\("id", selId\)[\s\S]*\.eq\("studio_id", studioId\)[\s\S]*\.eq\("active", true\)/);
  });
  it("edit now also writes the operator FK (not just the name)", () => {
    const updateBody = ACTIONS.slice(
      ACTIONS.indexOf("export async function updateDisinfectantRecordAction"),
      ACTIONS.indexOf("export async function updateExposureIncidentRecordAction"),
    );
    expect(updateBody).toMatch(/operator_practitioner_id: operator\.operator_practitioner_id/);
    expect(updateBody).toMatch(/operator_name: operator\.operator_name/);
  });
});

describe("exposure incident person selector + same-studio autofill", () => {
  it("renders a Client/Staff/Other selector that autofills the free-text fields", () => {
    expect(FORMS).toMatch(/function ExposedPersonPicker/);
    expect(FORMS).toMatch(/Staff \/ myself/);
    // the three stored fields remain the actual free-text inputs
    expect(FORMS).toMatch(/name="exposed_person_full_name"/);
    expect(FORMS).toMatch(/name="exposed_person_phone"/);
    expect(FORMS).toMatch(/name="exposed_person_address"/);
  });
  it("the client + staff lists are same-studio (server-fed), no FK stored", () => {
    expect(PAGE).toMatch(/getClientsForStudio\(studioId\)/);
    expect(PAGE).toMatch(/getPractitionersForStudio\(studioId\)/);
    // exposure actions still write only the existing free-text columns (no client_id FK)
    expect(ACTIONS).not.toMatch(/exposed_person_client_id|exposed_person_practitioner_id/);
  });
  it("exposure save actions are unchanged (still free-text columns only)", () => {
    expect(ACTIONS).toMatch(/exposed_person_full_name: exposedName/);
    expect(ACTIONS).toMatch(/exposure incident history is owner-only/i);
  });
});

describe("scope: no cron/email/SMS/notification added in this PR", () => {
  it("no new cron route or notification writes in record-keeping", () => {
    expect(FORMS).not.toMatch(/api\/cron|recordPractitionerNotification|sendEmail|sendSms/i);
    expect(ACTIONS).not.toMatch(/api\/cron|recordPractitionerNotification|sendEmail|sendSms/i);
  });
});
