import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// Charting Validation PR 1: a NON-BLOCKING aftercare prompt at the "Done
// charting" boundary. Emergency-safe (always able to continue), never
// auto-marks, no schema/RPC/postcare change. The stamp field
// (sessions.aftercare_and_risks_explained_at) already exists.
function read(rel: string): string {
  return readFileSync(path.resolve(__dirname, "../../../", rel), "utf8");
}
const GUARD = read("app/(app)/clients/[id]/sessions/[sessionId]/DoneChartingButton.tsx");
const PAGE = read("app/(app)/clients/[id]/sessions/[sessionId]/page.tsx");
const ACTIONS = read("app/(app)/records/actions.ts");

describe("Done-charting guard: non-blocking aftercare prompt", () => {
  it("shows the warning only when NOT already marked; already-marked proceeds directly", () => {
    // aftercareExplained true -> proceed() (behaves like the old plain link)
    expect(GUARD).toMatch(/if \(aftercareExplained\) \{\s*proceed\(\);/);
    // not marked -> open the dialog
    expect(GUARD).toMatch(/setOpen\(true\)/);
  });
  it("uses the exact warning copy", () => {
    expect(GUARD).toMatch(/Aftercare not marked/);
    expect(GUARD).toMatch(
      /You can continue, but this session does not show that aftercare\s*\n?\s*and risks were explained\./,
    );
  });
  it("offers exactly the two choices and never blocks", () => {
    expect(GUARD).toMatch(/Mark aftercare explained/);
    expect(GUARD).toMatch(/Continue without marking/);
    // "Continue without marking" always proceeds (emergency-safe)
    expect(GUARD).toMatch(/onClick=\{proceed\}/);
  });
  it("marks ONLY on explicit click, with explicit intent, then proceeds", () => {
    expect(GUARD).toMatch(/fd\.set\("explained", "true"\)/);
    expect(GUARD).toMatch(/const res = await markAction\(fd\)/);
    expect(GUARD).toMatch(/if \(res\.ok\) \{\s*proceed\(\)/);
    // never auto-marks on mount / render
    expect(GUARD).not.toMatch(/useEffect\([^)]*markAction/);
  });
  it("is accessible (dialog role + Escape to close) and touches no completion/postcare/payment", () => {
    expect(GUARD).toMatch(/role="dialog"/);
    expect(GUARD).toMatch(/e\.key === "Escape"/);
    expect(GUARD).not.toMatch(
      /mark_appointment_complete|markAppointmentComplete|postcare|autoSend|stripe|payment|sendEmail|sendSms/i,
    );
  });
});

describe("session page wires the guard from the existing stamp", () => {
  it("passes aftercareExplained derived from aftercare_and_risks_explained_at + the Done href + the existing action", () => {
    expect(PAGE).toMatch(/<DoneChartingButton/);
    expect(PAGE).toMatch(
      /aftercareExplained=\{\s*session\.aftercare_and_risks_explained_at != null\s*\}/,
    );
    expect(PAGE).toMatch(/doneHref=\{`\/clients\/\$\{id\}\?tab=sessions`\}/);
    expect(PAGE).toMatch(/markAction=\{markAftercareExplainedAction\}/);
  });
});

describe("markAftercareExplainedAction hardened to explicit intent", () => {
  it("rejects any value that is not literally 'true' or 'false' (no silent clear)", () => {
    expect(ACTIONS).toMatch(/const explainedRaw = str\(formData\.get\("explained"\), 10\)/);
    expect(ACTIONS).toMatch(
      /if \(explainedRaw !== "true" && explainedRaw !== "false"\) \{\s*return \{ ok: false/,
    );
    expect(ACTIONS).toMatch(/const explained = explainedRaw === "true"/);
  });
  it("no migration / no RPC change in this PR", () => {
    // the action still updates sessions directly; no mark_appointment_complete edit
    expect(ACTIONS).not.toMatch(/mark_appointment_complete/);
  });
});
