import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// 0335 (I3): the readers of plans/notes/budget must not issue the read, nor render an empty editor, for a viewer without the key. The database returns
// ZERO rows to them, which would otherwise read as "no pinned notes" / an empty personal-notes editor a Save could overwrite stored text from.
const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
const src = (f: string) => strip(readFileSync(f, "utf8"));

describe("I3 readers wait on their key and show RestrictedNote", () => {
  const profile = src("app/(app)/clients/[id]/page.tsx");
  it("profile: pinned notes follow clin.view_records; the card is RestrictedNote without it", () => {
    expect(profile).toMatch(/const needsPinnedNotes = wantsPinnedNotes && canViewRecords;/);
    expect(profile).toMatch(/const pinnedNotesCard = !canViewRecords \? \(\s*<RestrictedNote testId="pinned-notes-not-available" \/>/);
  });
  it("profile: personal notes are read only after client.view_personal_notes, and the editor is not rendered without it", () => {
    expect(profile).toMatch(/requirePermission\(db, studio\.id, "client\.view_personal_notes"/);
    expect(profile).toMatch(/canViewPersonalNotesPromise\.then\(\(ok\) => \(ok \? getClientPersonalNotes\(/);
    expect(profile).toMatch(/activeTab === "notes" && !canViewPersonalNotes && <RestrictedNote/);
    expect(profile).toMatch(/activeTab === "notes" && canViewPersonalNotes && \(\s*<ClientPersonalNotesEditor/);
  });
  it("profile: budget is read only after client.view_budget, independent of clin.view_records, and RestrictedNote without it", () => {
    expect(profile).toMatch(/requirePermission\(db, studio\.id, "client\.view_budget"/);
    expect(profile).toMatch(/activeTab === "treatment" && canViewBudget\s*\?\s*await getClientBudgetContext\(/);
    expect(profile).toMatch(/activeTab === "treatment" && !canViewBudget && <RestrictedNote/);
  });
  it("Today and the appointment briefing do not issue the pinned-notes read without clin.view_records", () => {
    expect(src("app/(app)/dashboard/page.tsx")).toMatch(/canViewRecords \? getPinnedNotesByClient\(/);
    const cal = src("app/(app)/calendar/[id]/page.tsx");
    expect(cal).toMatch(/canViewRecords \? getPinnedNotesForClient\(/);
    expect(cal).toMatch(/canViewRecords \? <PinnedNotesReadonly[^>]*\/> : <RestrictedNote/);
  });
  it("no other module calls the pinned-notes readers (a new caller must be classified here)", () => {
    const { execSync } = require("node:child_process") as typeof import("node:child_process");
    const out = execSync(`grep -rlE "getPinnedNotesForClient\\(|getPinnedNotesByClient\\(" app lib components --include=*.ts --include=*.tsx || true`).toString().split("\n").filter(Boolean).sort();
    expect(out).toEqual(["app/(app)/calendar/[id]/page.tsx", "app/(app)/clients/[id]/page.tsx", "app/(app)/dashboard/page.tsx", "lib/client-pinned-notes/queries.ts"]);
  });
});
