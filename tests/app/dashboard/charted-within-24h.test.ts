import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  summarizeChartedWithin24h,
  CHARTED_WINDOW_DAYS,
  CHARTED_WITHIN_MS,
} from "@/lib/dashboard/practice-metrics";

// PR #225: charted-within-24h treatment-memory loop metric. The pure
// summarizer is tested directly; loader scoping and UI wording are
// source-pinned (no browser E2E yet).

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

const METRICS = read("lib/dashboard/practice-metrics.ts");
const SNAPSHOT = read("app/(app)/dashboard/practice-snapshot.tsx");

const ENDS = "2026-06-10T17:00:00.000Z";

function row(offsetHours: number | null) {
  return {
    endsAt: ENDS,
    firstChartedAt:
      offsetHours === null
        ? null
        : new Date(
            new Date(ENDS).getTime() + offsetHours * 60 * 60 * 1000,
          ).toISOString(),
  };
}

describe("summarizeChartedWithin24h (pure)", () => {
  it("all recent completed sessions charted within 24h", () => {
    expect(
      summarizeChartedWithin24h([row(1), row(12), row(23.9)]),
    ).toEqual({ completedCount: 3, chartedWithin24hCount: 3 });
  });

  it("charting after 24h counts in the denominator only", () => {
    expect(summarizeChartedWithin24h([row(2), row(30), row(48)])).toEqual({
      completedCount: 3,
      chartedWithin24hCount: 1,
    });
  });

  it("exactly 24h counts as within (inclusive boundary)", () => {
    expect(summarizeChartedWithin24h([row(24)])).toEqual({
      completedCount: 1,
      chartedWithin24hCount: 1,
    });
    expect(summarizeChartedWithin24h([row(24.01)])).toEqual({
      completedCount: 1,
      chartedWithin24hCount: 0,
    });
  });

  it("charting BEFORE the appointment ended still counts (charted during the visit)", () => {
    expect(summarizeChartedWithin24h([row(-0.5)])).toEqual({
      completedCount: 1,
      chartedWithin24hCount: 1,
    });
  });

  it("no charting artifact means not charted", () => {
    expect(summarizeChartedWithin24h([row(null), row(3)])).toEqual({
      completedCount: 2,
      chartedWithin24hCount: 1,
    });
  });

  it("zero recent completed sessions", () => {
    expect(summarizeChartedWithin24h([])).toEqual({
      completedCount: 0,
      chartedWithin24hCount: 0,
    });
  });

  it("unparseable timestamps are not counted as charted", () => {
    expect(
      summarizeChartedWithin24h([
        { endsAt: "not a date", firstChartedAt: "2026-06-10T18:00:00Z" },
      ]),
    ).toEqual({ completedCount: 1, chartedWithin24hCount: 0 });
  });

  it("window/threshold constants are the documented v1 values", () => {
    expect(CHARTED_WINDOW_DAYS).toBe(7);
    expect(CHARTED_WITHIN_MS).toBe(24 * 60 * 60 * 1000);
  });
});

describe("loader: scoping and definition pins", () => {
  it("denominator is completed appointments ended in the rolling window, studio-scoped", () => {
    expect(METRICS).toMatch(
      /\.from\("appointments"\)[\s\S]*?\.select\("id, ends_at"\)[\s\S]*?\.eq\("studio_id", studioId\)[\s\S]*?\.eq\("status", "completed"\)[\s\S]*?\.gte\("ends_at", windowStartIso\)[\s\S]*?\.lte\("ends_at", nowIso\)/,
    );
  });

  it("numerator walks LINKED non-deleted sessions to non-deleted blocks, studio-scoped", () => {
    expect(METRICS).toMatch(
      /\.from\("sessions"\)[\s\S]*?\.eq\("studio_id", studioId\)[\s\S]*?\.in\("appointment_id"[\s\S]*?\.is\("deleted_at", null\)/,
    );
    expect(METRICS).toMatch(
      /\.from\("session_blocks"\)[\s\S]*?\.eq\("studio_id", studioId\)[\s\S]*?\.in\("session_id"[\s\S]*?\.is\("deleted_at", null\)/,
    );
  });

  it("only status completed enters the denominator (no confirmed/cancelled/no_show)", () => {
    // The charted-24h read pins status='completed'; cancelled and
    // no-show rows can never appear in either count.
    expect(METRICS).toMatch(/\.eq\("status", "completed"\)/);
  });

  it("uses the user-scoped client; no admin/service-role access", () => {
    expect(METRICS).not.toMatch(/admin-server|createAdminClient|service_role/);
  });

  it("documents that the metric is never grouped or ranked by practitioner", () => {
    expect(METRICS).toMatch(/never grouped or ranked\s*(\/\/\s*)?by practitioner/);
  });
});

describe("dashboard card: safe wording", () => {
  it("renders the metric with the required copy", () => {
    expect(SNAPSHOT).toMatch(/Charted within 24h/);
    expect(SNAPSHOT).toMatch(/Recently completed sessions with charting saved within 24/);
    expect(SNAPSHOT).toMatch(/No recent completed sessions yet\./);
    expect(SNAPSHOT).toMatch(/Keeps Before Today and Treatment Intelligence current\./);
    expect(SNAPSHOT).toMatch(
      /\{metrics\.chartedWithin24h\.chartedWithin24hCount\}\//,
    );
  });

  it("no score/compliance/monitoring or ranking language anywhere on the snapshot", () => {
    for (const banned of [
      /compliance/i,
      /performance score/i,
      /\bscore\b/i,
      /\branking\b/i,
      /\bmonitoring\b/i,
      /\bblame/i,
    ]) {
      expect(SNAPSHOT).not.toMatch(banned);
    }
  });

  it("no practitioner-level grouping on the card", () => {
    // The snapshot may mention practitioners only outside the charted
    // card; the charted card block itself names no practitioner.
    const card = SNAPSHOT.slice(
      SNAPSHOT.indexOf('title="Charted within 24h"'),
      SNAPSHOT.indexOf("</Card>", SNAPSHOT.indexOf('title="Charted within 24h"')),
    );
    expect(card).not.toMatch(/practitioner|operator|display_name/i);
  });
});
