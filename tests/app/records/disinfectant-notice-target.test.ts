import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// HON-12 (RECORDS-01): the overdue-disinfectant notice must open the EXISTING
// edit action of the overdue record (the same Records edit form that records a
// replacement date and writes the audit history), not just the section. Source
// guards on the Records page: it reads the notice's `record` parameter, anchors
// each row, and renders the focused row's edit form open. No parallel flow.

const page = readFileSync("app/(app)/records/page.tsx", "utf8");

describe("records page: the disinfectant notice's target record", () => {
  it("accepts a `record` search parameter", () => {
    expect(page).toMatch(/searchParams: Promise<\{[^}]*record\?: string/);
  });
  it("passes the requested record to the disinfectants section", () => {
    expect(page).toMatch(/DisinfectantsSection\(\{[^}]*focusRecordId/);
  });
  it("gives every disinfectant row the anchor the notice links to", () => {
    expect(page).toContain("id={disinfectantRecordAnchor(r.id)}");
  });
  it("opens the focused row's existing Edit form (details open)", () => {
    expect(page).toMatch(/<details open=\{editOpen\}/);
    expect(page).toMatch(/editOpen=\{r\.id === focusId\}/);
  });
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
