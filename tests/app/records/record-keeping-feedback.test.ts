import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// PR #280 (Chloe record-keeping feedback). Source/wiring pins proving the
// actions persist each fix same-studio. Behavioral DB proof: tests/db/record-keeping-discard-due.db.test.ts.

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

const ACTIONS = read("app/(app)/records/actions.ts");
const PAGE = read("app/(app)/records/page.tsx");

describe("disinfectant discard/replace-by date", () => {
  it("create + update actions persist discard_due_date", () => {
    expect((ACTIONS.match(/discard_due_date:/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(ACTIONS).toMatch(/dateStr\(formData\.get\("discard_due_date"\)\)/);
  });
});

describe("operator resolved from same-studio staff (free-text fallback)", () => {
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

describe("exposure incident person: same-studio lists, free-text columns only", () => {
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
