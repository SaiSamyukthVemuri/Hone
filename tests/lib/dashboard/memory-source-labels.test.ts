import { describe, expect, it } from "vitest";
import { memorySourceLabels, studioDayLabel, type MemorySources } from "@/lib/dashboard/memory-source-labels";
import { compactSummary } from "@/lib/dashboard/today-treatment-summary";
import { toDashboardPrepSummary, toDisclosureSummary } from "@/lib/dashboard/dashboard-prep-summary";
import { buildTodayWorkflow, type TodayWorkflowInput } from "@/lib/dashboard/today-workflow";
import type { AppointmentPrepMemory } from "@/lib/sessions/appointment-prep-memory";

// Where a Today-row memory line came from, said out loud. Synthetic data only.
const NOW = "2026-11-12T15:00:00Z";
const TZ = "America/New_York";
const src = (over: Partial<MemorySources> = {}): MemorySources => ({ latestAt: "2026-11-10T15:00:00Z", notes: null, setup: null, ...over });

describe("memorySourceLabels", () => {
  it("the same visit is dated, with no excuse", () => {
    const l = memorySourceLabels(
      src({ notes: { at: "2026-11-10T15:00:00Z", isLatest: true }, setup: { at: "2026-11-10T15:00:00Z", isLatest: true } }),
      NOW,
      TZ,
    );
    expect(l).toEqual({ notes: "Notes from 10 Nov", setup: "Setup from 10 Nov" });
  });
  it("an earlier source names its own date AND the latest visit's, and why", () => {
    const l = memorySourceLabels(
      src({ notes: { at: "2026-10-03T15:00:00Z", isLatest: false }, setup: { at: "2026-10-20T15:00:00Z", isLatest: false } }),
      NOW,
      TZ,
    );
    expect(l.notes).toBe("Notes from 3 Oct (the latest visit on 10 Nov has no notes)");
    expect(l.setup).toBe("Setup from 20 Oct (the latest visit on 10 Nov has no charted treatment)");
  });
  it("never presents an earlier source as the latest, even when the latest date cannot be shown", () => {
    const l = memorySourceLabels({ latestAt: null, notes: { at: "2026-10-03T15:00:00Z", isLatest: false }, setup: null }, NOW, TZ);
    expect(l.notes).toBe("Notes from 3 Oct (an earlier visit)");
  });
  it("no source means no label (no history is not a source)", () => {
    expect(memorySourceLabels(src(), NOW, TZ)).toEqual({ notes: null, setup: null });
    expect(memorySourceLabels(null, NOW, TZ)).toEqual({ notes: null, setup: null });
    expect(memorySourceLabels(undefined, NOW, TZ)).toEqual({ notes: null, setup: null });
  });
  it("adds the year only when the source is not in the studio's current year", () => {
    expect(studioDayLabel("2025-12-30T15:00:00Z", NOW, TZ)).toBe("30 Dec 2025");
    expect(studioDayLabel("2026-01-02T15:00:00Z", NOW, TZ)).toBe("2 Jan");
  });
  it("dates are the STUDIO's calendar day, not UTC and not the server's", () => {
    // 2026-10-04T02:30Z is 3 Oct 22:30 in New York.
    expect(studioDayLabel("2026-10-04T02:30:00Z", NOW, "America/New_York")).toBe("3 Oct");
    expect(studioDayLabel("2026-10-04T02:30:00Z", NOW, "UTC")).toBe("4 Oct");
    expect(studioDayLabel("2026-10-04T02:30:00Z", NOW, "Pacific/Auckland")).toBe("4 Oct");
  });
  it("an unusable date or timezone never throws and never invents a date", () => {
    expect(studioDayLabel("not a date", NOW, TZ)).toBeNull();
    expect(studioDayLabel("2026-10-03T15:00:00Z", NOW, "Not/AZone")).toBe("3 Oct");
    expect(memorySourceLabels(src({ notes: { at: "nope", isLatest: false } }), NOW, TZ).notes).toBeNull();
  });
});

describe("the labels reach the row through the workflow, and only with something to label", () => {
  const base: TodayWorkflowInput = {
    appointmentId: "a", clientId: "c", clientName: "Test Client", timeLabel: "9:00 AM", status: "confirmed", serviceName: null,
    unavailable: false, hasHistory: true, nextVisitNote: "plan text", cautionNote: null, setupLine: "27.12 MHz",
    reminders: [], intake: "none", charting: "none",
    notesSourceLabel: "Notes from 3 Oct (the latest visit on 10 Nov has no notes)",
    setupSourceLabel: "Setup from 20 Oct (the latest visit on 10 Nov has no charted treatment)",
  };
  const one = (over: Partial<TodayWorkflowInput>) => buildTodayWorkflow([{ ...base, ...over }]).items[0];
  it("carries both labels when notes and setup are shown", () => {
    const w = one({});
    expect(w.notesSourceLabel).toContain("3 Oct");
    expect(w.setupSourceLabel).toContain("20 Oct");
  });
  it("no note shown means no notes label; no setup shown means no setup label", () => {
    const w = one({ nextVisitNote: null, cautionNote: null, setupLine: null });
    expect(w.notesSourceLabel).toBeNull();
    expect(w.setupSourceLabel).toBeNull();
  });
  it("a failed or absent history read shows no source line at all", () => {
    expect(one({ hasHistory: false }).notesSourceLabel).toBeNull();
    expect(one({ unavailable: true, hasHistory: false }).notesSourceLabel).toBeNull();
  });
  it("an input without labels (older callers) labels nothing", () => {
    const { notesSourceLabel: _n, setupSourceLabel: _s, ...legacy } = base;
    void _n; void _s;
    const w = buildTodayWorkflow([legacy]).items[0];
    expect(w.notesSourceLabel).toBeNull();
    expect(w.setupSourceLabel).toBeNull();
  });
});

describe("the treatment strip's date is the studio's calendar day (no server-locale date)", () => {
  const memory = { startedAt: "2026-10-04T02:30:00Z", modality: "electrolysis", areaHeadline: "Chin", totalMinutes: 30 } as unknown as AppointmentPrepMemory;
  it("uses the studio timezone when given one", () => {
    expect(compactSummary(memory, "America/New_York")).toContain("Oct 3, 2026");
    expect(compactSummary(memory, "UTC")).toContain("Oct 4, 2026");
  });
  it("the dashboard summary passes the timezone through and carries the plan note's source line", () => {
    const s = toDashboardPrepSummary({ memory, unavailable: false, planNote: "plan", timeZone: "America/New_York", planSourceLabel: "Notes from 3 Oct (the latest visit on 10 Nov has no notes)" });
    expect(s.compactSummary).toContain("Oct 3, 2026");
    expect(s.rememberSource).toContain("3 Oct");
    expect(toDashboardPrepSummary({ memory: null, unavailable: false, planNote: null, planSourceLabel: "x" }).rememberSource).toBeNull();
    // The browser-bound projection still carries no note and no source line.
    expect(Object.keys(toDisclosureSummary(s)).sort()).toEqual(["compactSummary", "hasTreatment", "unavailable"]);
  });
});
