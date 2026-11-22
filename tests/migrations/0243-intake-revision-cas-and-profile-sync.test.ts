import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
const publicAction = readFileSync("app/intake/[token]/actions.ts", "utf8");
const assisted = readFileSync("app/(app)/clients/[id]/intake/actions.ts", "utf8");

describe("0243 intake callers name the revision they saw", () => {
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
