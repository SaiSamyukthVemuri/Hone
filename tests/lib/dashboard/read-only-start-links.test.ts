import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveNextAction } from "@/lib/dashboard/next-action";
import { resolveDayNextAction } from "@/lib/dashboard/day-next-action";
import { buildMissingRecordsAssistant } from "@/lib/dashboard/missing-records-assistant";

// Team's sweep follow-up (#1351 update 12): the dashboard still offered "Chart appointment" / start-a-session links to a viewer without
// clin.edit_records. Starting a chart creates a session, so those links are withdrawn in read-only chart mode.

const read = (p: string) => readFileSync(p, "utf8");
const base = { clientId: "c1", appointmentId: "a1", hasHistory: true, sessionId: null as string | null, hasChartedArea: false };

describe("next action (Today rows)", () => {
  it("completed without a session: an editor is offered the chart, a read-only viewer is offered the appointment", () => {
    expect(resolveNextAction({ ...base, status: "completed", canEditRecords: true })).toEqual({
      label: "Chart appointment", href: "/clients/c1/sessions/new?appointment_id=a1", chip: "Charting needed",
    });
    const ro = resolveNextAction({ ...base, status: "completed", canEditRecords: false });
    expect(ro).toEqual({ label: "Open appointment", href: "/calendar/a1", chip: "Charting needed" });
    expect(ro.href).not.toContain("/sessions/new");
  });
  it("the day wrapper passes the flag through on every branch (asked and not asked)", () => {
    for (const history of [{ asked: true as const, hasHistory: true }, { asked: false as const }]) {
      const out = resolveDayNextAction({ clientId: "c1", appointmentId: "a1", status: "completed", sessionId: null, hasChartedArea: false, history, canEditRecords: false });
      expect(out.href).not.toContain("/sessions/new");
    }
  });
  it("a linked session is unaffected (continuing/viewing is not starting)", () => {
    for (const canEditRecords of [true, false]) {
      expect(resolveNextAction({ ...base, status: "completed", sessionId: "s1", canEditRecords }).href).toBe("/clients/c1/sessions/s1");
    }
  });
});

describe("missing-records assistant", () => {
  const input = {
    unchartedAppointments: [{ appointmentId: "a1", clientId: "c1", clientName: "Client One", startedAt: "2026-11-01T15:00:00Z" }],
    sessions: [], incompleteIntakes: [],
  };
  it("an editor gets the start link; a read-only viewer gets the appointment, never a session-start URL", () => {
    const edit = buildMissingRecordsAssistant({ ...input, canEditRecords: true }).items[0];
    expect(edit).toMatchObject({ actionLabel: "Chart appointment", href: "/clients/c1/sessions/new?appointment_id=a1" });
    const ro = buildMissingRecordsAssistant({ ...input, canEditRecords: false }).items[0];
    expect(ro).toMatchObject({ actionLabel: "Open appointment", href: "/calendar/a1" });
    expect(JSON.stringify(ro)).not.toContain("/sessions/new");
  });
});

describe("source pins", () => {
  it("every dashboard source that can build a /sessions/new link reads canEditRecords", () => {
    for (const f of ["lib/dashboard/next-action.ts", "lib/dashboard/missing-records-assistant.ts"]) {
      const src = read(f);
      expect(src, f).toContain("/sessions/new");
      expect(src, f).toMatch(/canEditRecords/);
    }
  });
  it("no other dashboard file builds a session-start URL", () => {

    const hits = execFileSync("grep", ["-rln", "sessions/new", "app/(app)/dashboard", "lib/dashboard"], { encoding: "utf8" }).split("\n").filter(Boolean).sort();
    expect(hits).toEqual(["lib/dashboard/missing-records-assistant.ts", "lib/dashboard/next-action.ts"]);
  });
  it("the page asks clin.edit_records only after clin.view_records and hands it to every row; the assistant asks after its own view check", () => {
    const page = read("app/(app)/dashboard/page.tsx");
    expect(page).toMatch(/const canEditRecords = canViewRecords && \(await requirePermission\(supabase, studio\.id, "clin\.edit_records"\)\)\.allowed;/);
    expect(page).toContain("canEditRecords={canEditRecords}");
    expect(page).toMatch(/resolveDayNextAction\(\{\s*canEditRecords,/);
    const a = read("lib/dashboard/missing-records-assistant.ts");
    expect(a.indexOf('"clin.view_records"')).toBeLessThan(a.indexOf('"clin.edit_records"'));
  });
});
