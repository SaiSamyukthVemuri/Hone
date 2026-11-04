import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Read-only chart mode (Roles): clin.view_records without clin.edit_records shows the chart and offers no control that changes it. The actions
// refuse on their own (tests/lib/permissions/edit-refusal-copy.test.ts); these pins keep the PAGE from offering what would be refused.
const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const PAGE = read("app/(app)/clients/[id]/sessions/[sessionId]/page.tsx");
const VIEW = read("app/(app)/clients/[id]/sessions/[sessionId]/session-blocks-view.tsx");
const LINE = read("components/session-performer-line.tsx");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("session page in read-only mode", () => {
  const src = strip(PAGE);
  it("asks the edit key once, after the view gate, and never turns a missing edit key into not-found", () => {
    const view = src.indexOf('"clin.view_records"');
    const edit = src.indexOf('"clin.edit_records"');
    expect(view).toBeGreaterThan(-1);
    expect(edit).toBeGreaterThan(view);
    expect(src).toMatch(/const canEditRecords = \(await requirePermission\(permissionClient, studio\.id, "clin\.edit_records", \{ client: id \}\)\)\.allowed;/);
    expect(src).not.toMatch(/clin\.edit_records[^\n]*\n?[^\n]*notFound\(\)/);
  });
  it("says why the chart is locked, in the edit copy", () => {
    expect(src).toContain('data-testid="chart-read-only-note"');
    expect(src).toContain("{EDIT_RECORDS_REFUSAL}");
  });
  it.each([
    ["EditSessionStartedAt", /\{canEditRecords && \(\s*<EditSessionStartedAt/],
    ["CopyPreviousAreasPanel", /canEditRecords &&\s*session\.modality === "electrolysis"/],
    ["DeleteSessionForm", /\{!isFinalized && canEditRecords && \(\s*<div className="pt-6">\s*<DeleteSessionForm/],
    ["NextVisitNoteForm", /isFinalized \|\| !canEditRecords \?/],
    ["DoneChartingButton", /isFinalized \|\| !canEditRecords \?\s*\(\s*<Link/],
  ])("%s is withdrawn", (_n, re) => expect(src).toMatch(re));
  // Codex P2 on #1351: controls whose actions refuse must not be offered at all (a laser form would let a user type details first).
  it.each([
    ["LogLaserEntryForm (laser)", /\{!isFinalized && canEditRecords && \(\s*<LogLaserEntryForm/],
    ["AftercareExplainedToggle", /\{!isFinalized && canEditRecords && \(\s*<AftercareExplainedToggle/],
  ])("%s is withdrawn", (_n, re) => expect(src).toMatch(re));
  it("hands read-only to LaserEntriesSection, which drops the remove control", () => {
    expect(src).toMatch(/<LaserEntriesSection[\s\S]*?readOnly=\{!canEditRecords\}/);
    expect(src).toMatch(/readOnly \? undefined : \(\s*<RemovePassButton/);
    expect(src).toMatch(/function LaserEntriesSection\([\s\S]*?readOnly = false/);
  });
  it("no chart-changing control is rendered outside a canEditRecords / readOnly guard", () => {
    for (const comp of ["LogLaserEntryForm", "AftercareExplainedToggle", "RemovePassButton", "EditSessionStartedAt", "DeleteSessionForm"]) {
      const i = src.search(new RegExp(`<${comp}[\\s>]`));
      expect(i, comp).toBeGreaterThan(-1);
      expect(src.slice(Math.max(0, i - 160), i), `${comp} must sit behind the edit gate`).toMatch(/canEditRecords|readOnly/);
    }
  });
  it("hands read-only to the blocks view and the performer line", () => {
    expect(src).toMatch(/<SessionBlocksView[\s\S]*?readOnly=\{!canEditRecords\}/);
    expect(src).toMatch(/<SessionPerformerLine[\s\S]*?readOnly=\{!canEditRecords\}/);
  });
});

describe("blocks view and performer line honour readOnly", () => {
  const v = strip(VIEW);
  it("hides add area, edit area, remove area, add pass and remove pass; never auto-opens an editor", () => {
    expect(v).toMatch(/readOnly \? null : adding \?/);
    expect(v).toMatch(/editing && !readOnly \?/);
    expect(v).toMatch(/\{!readOnly && \(\s*<div className="flex flex-wrap items-start justify-end gap-3">/);
    expect(v).toMatch(/readOnly \? undefined : \(\s*<RemovePassButton/);
    expect(v).toMatch(/readOnly \? null : addingPass \?/);
    expect(v).toMatch(/autoEdit=\{!readOnly && block\.id === autoEditBlockId\}/);
  });
  it("the performer line keeps its text and loses only the Edit button", () => {
    const l = strip(LINE);
    expect(l).toMatch(/\{!readOnly && \(\s*<button\s+type="button"\s+onClick=\{\(\) => setEditing\(true\)\}/);
    expect(l).toContain("Performed by");
  });
});
