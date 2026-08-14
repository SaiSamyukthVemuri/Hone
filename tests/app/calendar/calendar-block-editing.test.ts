import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR C: edit/delete one-off timed blocks from the calendar, OWNER-ONLY, reusing
// the existing owner-gated Settings actions (no new server action, no migration,
// no RLS change). vitest env is "node" (no DOM) → verified by source pins.
function read(rel: string): string {
  return readFileSync(path.resolve(__dirname, "../../../", rel), "utf8");
}
const DRAWER = read("app/(app)/calendar/TimedBlockEditDrawer.tsx");
const DAYCOL = read("app/(app)/calendar/DayColumn.tsx");
const PAGE = read("app/(app)/calendar/page.tsx");
const AVAIL_ACTIONS = read("app/(app)/settings/availability/actions.ts");

describe("reuses the existing OWNER-GATED actions (no new action, no RLS change)", () => {
  it("the drawer imports updateTimedBlockAction + deleteTimedBlockAction from Settings", () => {
    expect(DRAWER).toMatch(/import \{[\s\S]*updateTimedBlockAction,[\s\S]*deleteTimedBlockAction,[\s\S]*\} from "@\/app\/\(app\)\/settings\/availability\/actions"/);
  });
  it("those actions remain owner-gated (assertOwnerWithStudio), unchanged", () => {
    const upd = AVAIL_ACTIONS.slice(AVAIL_ACTIONS.indexOf("export async function updateTimedBlockAction"), AVAIL_ACTIONS.indexOf("export async function deleteTimedBlockAction"));
    expect(upd).toMatch(/assertOwnerWithStudio\(\)/);
    const del = AVAIL_ACTIONS.slice(AVAIL_ACTIONS.indexOf("export async function deleteTimedBlockAction"));
    expect(del).toMatch(/assertOwnerWithStudio\(\)/);
  });
  it("the drawer builds the SAME formData shape the actions expect", () => {
    for (const k of ["id", "date", "start_local", "end_local", "category", "private_note"]) {
      expect(DRAWER).toContain(`fd.set("${k}"`);
    }
  });
});

describe("owner: edit + delete controls", () => {
  const ownerBranch = DRAWER.slice(DRAWER.indexOf("{!isOwner ? ("));
  it("owner sees the editable form (date + start/end time inputs + category + note)", () => {
    expect(ownerBranch).toMatch(/type="date"/);
    expect(ownerBranch.match(/type="time"/g)?.length).toBe(2); // start + end
    expect(ownerBranch).toMatch(/<select/); // category
  });
  it("save calls the reused update action", () => {
    expect(DRAWER).toMatch(/await updateTimedBlockAction\(fd\)/);
  });
  it("delete is behind an explicit confirmation, then calls the reused delete action", () => {
    expect(DRAWER).toMatch(/confirmingDelete \?/);
    expect(DRAWER).toMatch(/Delete this block\?/);
    expect(DRAWER).toMatch(/await deleteTimedBlockAction\(fd\)/);
  });
  it("time/date inputs stay 24h machine values (type=time/date), display range uses the preference", () => {
    expect(DRAWER).toMatch(/hour12: false/); // input formatter is 24h
    expect(DRAWER).toMatch(/formatClockLabel\(timeForInput\(/); // displayed range honors 12h/24h
  });
});

describe("non-owner: read-only, no edit/delete controls exposed", () => {
  it("non-owner branch shows the read-only copy and NO form/save/delete", () => {
    // the !isOwner branch is the read-only panel; the editable form is in the else
    const readonlyPanel = DRAWER.slice(DRAWER.indexOf("{!isOwner ? ("), DRAWER.indexOf(") : ("));
    expect(readonlyPanel).toMatch(/Only studio owners can edit or remove blocked time/);
    expect(readonlyPanel).not.toMatch(/updateTimedBlockAction|deleteTimedBlockAction|type="time"|<select/);
  });
});

describe("calendar wiring: timed blocks clickable, recurring breaks not; drag safe", () => {
  it("the timed-block card is clickable → opens the edit drawer", () => {
    expect(DAYCOL).toMatch(/onClick=\{\(\) => setEditingBlock\(tb\)\}/);
    expect(DAYCOL).toMatch(/<TimedBlockEditDrawer[\s\S]*?block=\{editingBlock\}[\s\S]*?isOwner=\{isOwner\}/);
  });
  it("recurring-break cards are NOT clickable (managed in Settings, different model)", () => {
    const recurring = DAYCOL.slice(DAYCOL.indexOf("recurringBreaks.map"), DAYCOL.indexOf("timedBlocks.map"));
    expect(recurring).not.toMatch(/onClick=/);
  });
  it("a block click stops propagation so it never triggers empty-slot booking / drag", () => {
    expect(DAYCOL).toMatch(/e\.stopPropagation\(\);\s*\n\s*onClick\(\);/);
  });
  it("owner status is resolved from role and threaded to DayColumn", () => {
    expect(PAGE).toMatch(/const isOwner = practitioner\.role === "owner"/);
    expect(PAGE).toMatch(/isOwner=\{isOwner\}/);
  });
});
