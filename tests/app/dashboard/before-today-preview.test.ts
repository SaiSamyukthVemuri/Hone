import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compactBeforeToday } from "@/lib/dashboard/before-today-previews";
import type { BeforeToday } from "@/lib/sessions/before-today";

// PR #212: compact Before-today previews on the Dashboard Today
// roster. Same PR #211 pipeline, compacted; three batched reads for
// the whole roster, never per-appointment.

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

const PAGE = read("app/(app)/dashboard/page.tsx");
const PREVIEWS = read("lib/dashboard/before-today-previews.ts");
const SNAPSHOT = read("app/(app)/dashboard/practice-snapshot.tsx");
const OVERVIEW = read("app/(app)/clients/[id]/page.tsx");

function briefing(over: Partial<BeforeToday> = {}): BeforeToday {
  return {
    hasHistory: true,
    lastTreated: {
      startedAt: "2026-06-11T00:54:00Z",
      modality: "electrolysis",
      areasLine: "Upper lip and Chin",
      minutes: 30,
      probeLot: "460941",
    },
    remember: {
      watchLines: ["start lower next time"],
      plan: "Start lower on upper lip.",
      hasNotes: true,
    },
    response: {
      toleranceRating: 3,
      reactionLabel: "Mild redness",
      reactionNotes: null,
      hasAny: true,
    },
    setup: {
      frequency: "27.12 MHz",
      probe: "Ballet F3",
      modeLabel: "Thermolysis",
      energyLevel: null,
      areaName: "Chin",
    },
    latestSetupLine: "27.12 MHz · Ballet F3 · Thermolysis",
    reminders: [],
    ...over,
  };
}

describe("compactBeforeToday", () => {
  it("no charted history collapses to the compact empty state", () => {
    const p = compactBeforeToday(
      briefing({ hasHistory: false, lastTreated: null }),
    );
    expect(p.hasHistory).toBe(false);
    expect(p.rememberLine).toBeNull();
  });

  it("Watch wins over Plan for the single Remember line", () => {
    expect(compactBeforeToday(briefing()).rememberLine).toBe(
      "start lower next time",
    );
    const planOnly = compactBeforeToday(
      briefing({
        remember: {
          watchLines: [],
          plan: "Start lower on upper lip.",
          hasNotes: true,
        },
      }),
    );
    expect(planOnly.rememberLine).toBe("Start lower on upper lip.");
    const none = compactBeforeToday(
      briefing({
        remember: {
          watchLines: [],
          plan: null,
          hasNotes: false,
        },
      }),
    );
    expect(none.rememberLine).toBeNull();
  });

  it("records line summarizes (count, not checklist) and agrees with the full card", () => {
    expect(compactBeforeToday(briefing()).recordsLine).toBe(
      "Records look complete.",
    );
    expect(
      compactBeforeToday(briefing({ reminders: ["a"] })).recordsLine,
    ).toBe("Records: 1 reminder");
    expect(
      compactBeforeToday(briefing({ reminders: ["a", "b"] })).recordsLine,
    ).toBe("Records: 2 reminders");
  });

  it("setup line passes through; null means Not recorded at render time", () => {
    expect(compactBeforeToday(briefing()).setupLine).toBe(
      "27.12 MHz · Ballet F3 · Thermolysis",
    );
    expect(
      compactBeforeToday(briefing({ latestSetupLine: null })).setupLine,
    ).toBeNull();
  });
});

describe("placement + reuse", () => {
  it("each Today roster row renders the compact preview", () => {
    expect(PAGE).toMatch(/beforeToday=\{beforeTodayPreviews\.get\(appt\.client_id\)/);
    expect(PAGE).toMatch(/Before today/);
    // Chloe dashboard-memory fix: the Remember note is rendered WHOLE — the
    // 70-char cap is gone. Full-visibility is pinned in its own suite
    // (tests/app/dashboard/dashboard-memory-visibility.test.ts).
    expect(PAGE).toMatch(/Remember: \{beforeToday\.rememberLine\}/);
    expect(PAGE).toMatch(/Latest setup: \{beforeToday\.setupLine \?\? "Not recorded"\}/);
    expect(PAGE).toMatch(/No charted history yet\./);
    expect(PAGE).toMatch(/No watch\/plan note\./);
    // Empty roster state untouched.
    expect(PAGE).toMatch(/No appointments today\./);
  });

  it("preview is NOT in the snapshot metric cards; full card stays on the Overview", () => {
    expect(SNAPSHOT).not.toMatch(/BeforeToday|Remember:/);
    expect(OVERVIEW).toMatch(/<BeforeTodayCard/);
  });

  it("the preview reuses the exact PR #211 pipeline (no duplicated rules)", () => {
    for (const fn of [
      "pickLastTreatment",
      "pickPreClientWatchPlanSource",
      "buildLastSessionSummary",
      "buildTreatmentIntelligence",
      "buildBeforeToday",
      "compactBeforeToday",
    ]) {
      expect(PREVIEWS).toMatch(new RegExp(fn));
    }
  });

  it("batched: four bounded reads for the roster, never per-appointment", () => {
    // sessions, session_blocks, clients, and (migration 0128) session_block_areas
    // — each ONE bounded query over the whole roster, never a per-appointment or
    // per-session read (no N+1). The areas read is keyed by the loaded block ids.
    expect(PREVIEWS.match(/\.from\(/g)?.length).toBe(4);
    expect(PREVIEWS).toMatch(/\.in\("client_id", ids\)/);
    expect(PREVIEWS).toMatch(/\.in\("session_id", sessionIds\)/);
    expect(PREVIEWS).toMatch(/\.from\("session_block_areas"\)/);
    expect(PREVIEWS).toMatch(/\.in\(\s*\n?\s*"session_block_id",/);
    // One previews call per page load, fed with the whole roster.
    expect(PAGE).toMatch(
      /getBeforeTodayPreviews\(\s*\n?\s*studio\.id,\s*\n?\s*visibleAppointments\.map/,
    );
  });
});

describe("safety", () => {
  it("read-only and no unsafe wording", () => {
    expect(PREVIEWS).not.toMatch(/\.insert\(|\.update\(|\.delete\(/);
    for (const p of [
      /\bbest\b/i,
      /recommend/i,
      /\bsafest\b/i,
      /\bcaused\b/i,
      /diagnos/i,
      /predicted|\bsuccess\b|should use|clinically proven/i,
    ]) {
      expect(PREVIEWS).not.toMatch(p);
    }
  });
});
