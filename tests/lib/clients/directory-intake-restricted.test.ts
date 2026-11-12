import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildDirectoryRows, parseDirectoryParams, queryDirectory, type DirectoryAggregates } from "@/lib/clients/directory-query";
import { projectStaffRow } from "@/lib/clients/directory-rules";

// F-I5-1 (Team review of #1429): readCurrentIntake was ungated. A viewer without clin.view_intake_status / clin.view_intake must see the directory's
// intake column and intake filter as RESTRICTED, never "Not submitted" and never an empty "nothing needs review" (the #1341 P2 class).
const row = (id: string) => projectStaffRow({ id, name: `C ${id}`, preferred_name: null, pronouns: null, email: null, phone: null, archived_at: null });
const rows = [row("1"), row("2")];
const P = (over: Partial<ReturnType<typeof parseDirectoryParams>> = {}) => ({ ...parseDirectoryParams({}), ...over });
const restricted: DirectoryAggregates = { nextAppointments: new Map(), intake: null, intakeRestricted: true };
const keyed: DirectoryAggregates = { nextAppointments: new Map(), intake: new Map([["1", "submitted"]]) };
const unavailable: DirectoryAggregates = { nextAppointments: new Map(), intake: null };

describe("directory intake: restricted is its own state", () => {
  it("every row is restricted, not not_submitted and not unavailable", () => {
    expect(buildDirectoryRows(rows, restricted).map((r) => r.intake)).toEqual(["restricted", "restricted"]);
    expect(queryDirectory(rows, restricted, P()).intakeRestricted).toBe(true);
    expect(queryDirectory(rows, restricted, P()).intakeUnavailable).toBe(false);
  });
  it("the intake_review filter returns no rows and is flagged restricted, not blocked as a failed read", () => {
    const page = queryDirectory(rows, restricted, P({ filters: ["intake_review"] }));
    expect(page.rows).toEqual([]);
    expect(page.intakeRestricted).toBe(true);
    expect(page.blockedFilters).toEqual([]);
  });
  it("controls: a keyed viewer sees real states; a failed read stays unavailable", () => {
    expect(buildDirectoryRows(rows, keyed).map((r) => r.intake)).toEqual(["awaiting_review", "not_submitted"]);
    expect(queryDirectory(rows, keyed, P({ filters: ["intake_review"] })).rows.map((r) => r.id)).toEqual(["1"]);
    expect(buildDirectoryRows(rows, unavailable).map((r) => r.intake)).toEqual(["unavailable", "unavailable"]);
  });
});

describe("the directory page reads intake only behind the gate", () => {
  const page = readFileSync("app/(app)/clients/page.tsx", "utf8");
  it("both readCurrentIntake calls wait on intakeAllowed and the aggregates carry intakeRestricted", () => {
    expect(page).toMatch(/clin\.view_intake_status/);
    expect(page).toMatch(/clin\.view_intake"/);
    expect(page).toMatch(/intakeAllowedPromise\.then\(\(ok\) => \(ok \? readCurrentIntake\(db, studio\.id\) : null\)\)/);
    expect(page).toMatch(/intakeAllowed \? readCurrentIntake\(db, studio\.id, pageIds\) : Promise\.resolve\(null\)/);
    expect(page.match(/intakeRestricted/g)!.length).toBeGreaterThanOrEqual(3);
  });
  it("the view says so", () => {
    const ui = readFileSync("app/(app)/clients/ClientsDirectory.tsx", "utf8");
    expect(ui).toContain('restricted: "Not available to your role"');
    expect(ui).toContain("directory-intake-filter-restricted");
  });
});
