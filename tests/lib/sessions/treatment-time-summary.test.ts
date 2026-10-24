import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";

import {
  formatMinutes,
  summarizeTreatmentTime,
  type TreatmentTimeBlock,
} from "@/lib/sessions/treatment-time-summary";
import { SessionTreatmentTime } from "@/components/session-treatment-time";

// HON-59 first slice. The chart sums the minutes recorded on a session's
// treatment areas and says what that number is not: not the visit length, not
// split by practitioner, not a billing total. These tests pin the arithmetic,
// the honesty of the copy, and that nothing attributes or bills.

function block(p: Partial<TreatmentTimeBlock> = {}): TreatmentTimeBlock {
  return {
    minutes_performed: null,
    started_at: null,
    ended_at: null,
    deleted_at: null,
    ...p,
  };
}

const render = (blocks: TreatmentTimeBlock[]) =>
  renderToStaticMarkup(createElement(SessionTreatmentTime, { blocks }));

/** Visible text only, so assertions read what the practitioner reads. */
const text = (markup: string) =>
  markup.replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/\s+/g, " ").trim();

describe("summarizeTreatmentTime", () => {
  it("sums UNEQUAL area minutes and counts the areas that carry them", () => {
    const s = summarizeTreatmentTime([
      block({ minutes_performed: 40 }),
      block({ minutes_performed: 15 }),
      block({ minutes_performed: 5 }),
    ]);
    expect(s).toEqual({
      areaCount: 3,
      areasWithMinutes: 3,
      recordedMinutes: 60,
      overlapRecorded: false,
    });
  });

  it("does not count an area without minutes as zero minutes recorded", () => {
    const s = summarizeTreatmentTime([
      block({ minutes_performed: 20 }),
      block({ minutes_performed: null }),
      block({ minutes_performed: 0 }),
    ]);
    expect(s.areaCount).toBe(3);
    // 0 is a recorded value; null is not.
    expect(s.areasWithMinutes).toBe(2);
    expect(s.recordedMinutes).toBe(20);
  });

  it("excludes removed areas, and ignores negative or non-finite minutes", () => {
    const s = summarizeTreatmentTime([
      block({ minutes_performed: 30 }),
      block({ minutes_performed: 99, deleted_at: "2026-10-20T10:00:00Z" }),
      block({ minutes_performed: -5 }),
      block({ minutes_performed: Number.NaN }),
    ]);
    expect(s.areaCount).toBe(3);
    expect(s.areasWithMinutes).toBe(1);
    expect(s.recordedMinutes).toBe(30);
  });

  it("an edit to one area's minutes changes the sum on the next read (edit + reload)", () => {
    const before = [block({ minutes_performed: 25 }), block({ minutes_performed: 10 })];
    expect(summarizeTreatmentTime(before).recordedMinutes).toBe(35);
    const afterEdit = [before[0], { ...before[1], minutes_performed: 18 }];
    expect(summarizeTreatmentTime(afterEdit).recordedMinutes).toBe(43);
    // Reload = the same rows read again: same answer, no hidden state.
    expect(summarizeTreatmentTime(afterEdit.map((b) => ({ ...b })))).toEqual(
      summarizeTreatmentTime(afterEdit),
    );
  });

  it("flags OVERLAP only when two areas' recorded intervals actually overlap", () => {
    const overlapping = summarizeTreatmentTime([
      block({ minutes_performed: 30, started_at: "2026-10-20T10:00:00Z", ended_at: "2026-10-20T10:30:00Z" }),
      block({ minutes_performed: 30, started_at: "2026-10-20T10:15:00Z", ended_at: "2026-10-20T10:45:00Z" }),
    ]);
    expect(overlapping.overlapRecorded).toBe(true);

    // A long area containing a short one, with a later area between them in
    // sort order, is still found.
    const nested = summarizeTreatmentTime([
      block({ started_at: "2026-10-20T10:00:00Z", ended_at: "2026-10-20T11:00:00Z" }),
      block({ started_at: "2026-10-20T10:05:00Z", ended_at: "2026-10-20T10:06:00Z" }),
      block({ started_at: "2026-10-20T10:40:00Z", ended_at: "2026-10-20T10:50:00Z" }),
    ]);
    expect(nested.overlapRecorded).toBe(true);
  });

  it("sequential, touching, partial or invalid intervals are NOT overlap", () => {
    expect(
      summarizeTreatmentTime([
        block({ started_at: "2026-10-20T10:00:00Z", ended_at: "2026-10-20T10:30:00Z" }),
        block({ started_at: "2026-10-20T10:30:00Z", ended_at: "2026-10-20T11:00:00Z" }),
      ]).overlapRecorded,
    ).toBe(false);
    expect(
      summarizeTreatmentTime([
        block({ started_at: "2026-10-20T10:00:00Z", ended_at: null }),
        block({ started_at: "2026-10-20T10:10:00Z", ended_at: "2026-10-20T10:20:00Z" }),
        block({ started_at: "2026-10-20T10:15:00Z", ended_at: "2026-10-20T10:12:00Z" }),
      ]).overlapRecorded,
    ).toBe(false);
    // A removed area's interval never creates overlap.
    expect(
      summarizeTreatmentTime([
        block({ started_at: "2026-10-20T10:00:00Z", ended_at: "2026-10-20T10:30:00Z" }),
        block({
          started_at: "2026-10-20T10:10:00Z",
          ended_at: "2026-10-20T10:20:00Z",
          deleted_at: "2026-10-20T12:00:00Z",
        }),
      ]).overlapRecorded,
    ).toBe(false);
  });

  it("formats minutes plainly", () => {
    expect(formatMinutes(0)).toBe("0 min");
    expect(formatMinutes(45)).toBe("45 min");
    expect(formatMinutes(60)).toBe("1 h");
    expect(formatMinutes(95)).toBe("1 h 35 min");
  });
});

describe("SessionTreatmentTime (rendered)", () => {
  it("renders nothing for a session with no treatment areas yet", () => {
    expect(render([])).toBe("");
    expect(render([block({ minutes_performed: 30, deleted_at: "2026-10-20T10:00:00Z" })])).toBe("");
  });

  it("shows the sum, the area coverage, and what the number is NOT", () => {
    const t = text(render([block({ minutes_performed: 40 }), block({ minutes_performed: 15 }), block()]));
    expect(t).toContain("Recorded treatment time");
    expect(t).toContain("55 min across 2 of 3 areas");
    expect(t).toContain("not the visit's length");
    expect(t).toContain("not split by practitioner");
    expect(t).toContain("not a billing total");
    expect(t).not.toMatch(/overlap|same time/i);
  });

  it("says when no minutes are recorded instead of showing 0 min", () => {
    const t = text(render([block(), block()]));
    expect(t).toContain("No minutes recorded on these areas yet.");
    expect(t).not.toContain("0 min");
  });

  it("warns that overlapping areas can sum past elapsed time", () => {
    const t = text(
      render([
        block({ minutes_performed: 30, started_at: "2026-10-20T10:00:00Z", ended_at: "2026-10-20T10:30:00Z" }),
        block({ minutes_performed: 30, started_at: "2026-10-20T10:15:00Z", ended_at: "2026-10-20T10:45:00Z" }),
      ]),
    );
    expect(t).toContain("1 h across 2 areas");
    expect(t).toContain("recorded at the same time");
  });

  it("names no practitioner and shows no money", () => {
    const t = text(render([block({ minutes_performed: 40 }), block({ minutes_performed: 15 })]));
    expect(t).not.toMatch(/\$|£|€|price|charge|cents|paid|invoice|unit/i);
    expect(t).not.toMatch(/author|performed by|recorded by|charted by/i);
  });
});

describe("wiring and boundaries (source)", () => {
  const read = (p: string) => readFileSync(p, "utf8");
  const code = (p: string) =>
    read(p)
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

  it("the session chart renders the summary from its live blocks", () => {
    const view = code("app/(app)/clients/[id]/sessions/[sessionId]/session-blocks-view.tsx");
    expect(view).toContain('import { SessionTreatmentTime } from "@/components/session-treatment-time"');
    expect(view).toMatch(/<SessionTreatmentTime blocks=\{blocks\} \/>/);
  });

  it("the summary reads only area minutes and times: no financial, practitioner or entry fields", () => {
    for (const p of ["lib/sessions/treatment-time-summary.ts", "components/session-treatment-time.tsx"]) {
      const src = code(p);
      expect(src).not.toMatch(/price|cents|paid|payment|charge|practitioner_id|display_name|entries/i);
      expect(src).not.toMatch(/from\(|createClient|supabase/);
    }
  });
});
