import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// HON-12 (RECORDS-01): the overdue-disinfectant notice must open the EXISTING
// edit action of the overdue record (the same Records edit form that records a
// replacement date and writes the audit history), not just the section. Source
// guards on the Records page: no parallel flow, the one requested record is
// fetched studio-scoped, and the requested id is never echoed.

const page = readFileSync("app/(app)/records/page.tsx", "utf8");

describe("records page: the disinfectant notice's target record", () => {
  it("still uses the existing update action and edit form (no parallel records flow)", () => {
    expect(page).toContain("action={updateDisinfectantRecordAction}");
    expect(page).toContain("<EditDisinfectantForm");
  });
  it("fetches the ONE requested record when it is not among the listed rows, and builds the audit from the placed rows", () => {
    expect(page).toContain("getDisinfectantRecordForNotice(studioId, focusRecordId)");
    expect(page).toContain("placeFocusedRecord(");
    expect(page).toMatch(/getAuditEventsByRecord\(\s*studioId,\s*"disinfectant",\s*records\.map/);
  });
  it("never echoes the requested id into the page", () => {
    expect(page).not.toMatch(/\{focusRecordId\}|\{sp\.record\}/);
  });
});
