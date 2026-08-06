import { describe, expect, it } from "vitest";
import {
  AREA_BUCKET_SEPARATOR,
  buildAreaMinutesBreakdown,
  bucketize,
  resolveAreaBucketLabel,
  type AreaBucketBlock,
  type MinutesBucketBlock,
} from "@/lib/treatment-time/area-bucket";

// THE defect: minutes_performed is stored on the settings BLOCK, but a block
// may treat several structured areas (migration 0128). The old resolver read
// only the legacy `primary_area` — which 0128 defines as the FIRST area — so a
// block treating Left cheek + Right sideburn credited its whole duration to
// Cheek and the sideburn disappeared from the client's breakdown entirely.
//
// The database stores ONE duration and NO allocation among the areas, so the
// rule is: credit the block exactly ONCE, to one bucket that names every area
// it treated. Never to every area, never split evenly, never to the first area
// alone, and never dropping the rest.
//
// `lib/treatment-time/*` had zero behavioural coverage before this file.

// buildAreaMinutesBreakdown IS the production attribution — getTreatmentTimeByArea
// does nothing but load rows and call it — so every assertion below runs against
// the shipped code, not a replica of it.
function bucketMinutes(blocks: ReadonlyArray<MinutesBucketBlock>): {
  byArea: Map<string, number>;
  total: number;
} {
  const rows = buildAreaMinutesBreakdown(blocks);
  const byArea = new Map<string, number>();
  let total = 0;
  for (const r of rows) {
    byArea.set(r.area, r.minutes);
    total += r.minutes;
  }
  return { byArea, total };
}

function sum(map: ReadonlyMap<string, number>): number {
  let n = 0;
  for (const v of map.values()) n += v;
  return n;
}

describe("multi-area blocks: the duration lands in ONE combined bucket", () => {
  const multiArea: AreaBucketBlock & { minutes_performed: number } = {
    block_name: "Main",
    // The legacy projection — the FIRST area only. This is exactly what the
    // old resolver bucketed on, and why the sideburn vanished.
    primary_area: "Cheek",
    minutes_performed: 30,
    structured_areas: [
      { area: "Cheek", laterality: "left", display_order: 0, created_at: "2026-01-01T10:00:00Z", id: "a1" },
      { area: "Sideburn", laterality: "right", display_order: 1, created_at: "2026-01-01T10:00:01Z", id: "a2" },
    ] as never,
  };

  it("names EVERY treated area, not just the first", () => {
    expect(resolveAreaBucketLabel(multiArea)).toBe("Cheek · Sideburn");
  });

  it("does not silently drop the secondary area (the defect)", () => {
    expect(resolveAreaBucketLabel(multiArea)).not.toBe("Cheek");
  });

  it("credits the duration EXACTLY ONCE — one bucket, one entry", () => {
    const { byArea, total } = bucketMinutes([multiArea]);
    expect(byArea.size).toBe(1);
    expect(byArea.get("Cheek · Sideburn")).toBe(30);
    expect(total).toBe(30);
  });

  it("does NOT credit the full duration to every area (that would double-count)", () => {
    const { byArea, total } = bucketMinutes([multiArea]);
    expect(byArea.get("Cheek")).toBeUndefined();
    expect(byArea.get("Sideburn")).toBeUndefined();
    expect(sum(byArea)).toBe(30);
    expect(sum(byArea)).not.toBe(60);
    expect(total).toBe(30);
  });

  it("does NOT fabricate an even split — the database stores no allocation", () => {
    const { byArea } = bucketMinutes([multiArea]);
    expect([...byArea.values()]).toEqual([30]);
    expect([...byArea.values()]).not.toEqual([15, 15]);
  });

  it("orders the combined label by (display_order, created_at, id), not by insertion", () => {
    const scrambled: AreaBucketBlock = {
      structured_areas: [
        { area: "Sideburn", laterality: "right", display_order: 1, created_at: "2026-01-01T10:00:01Z", id: "a2" },
        { area: "Cheek", laterality: "left", display_order: 0, created_at: "2026-01-01T10:00:00Z", id: "a1" },
      ] as never,
    };
    expect(resolveAreaBucketLabel(scrambled)).toBe("Cheek · Sideburn");
  });

  it("uses the shared area separator, not a second display vocabulary", () => {
    expect(AREA_BUCKET_SEPARATOR).toBe(" · ");
    expect(resolveAreaBucketLabel(multiArea)).toContain(AREA_BUCKET_SEPARATOR);
  });

  it("collapses a block that treated the SAME area on both sides into one area", () => {
    const bothSides: AreaBucketBlock = {
      primary_area: "Underarms",
      structured_areas: [
        { area: "Underarms", laterality: "left", display_order: 0, created_at: "t1", id: "a1" },
        { area: "Underarms", laterality: "right", display_order: 1, created_at: "t2", id: "a2" },
      ] as never,
    };
    expect(resolveAreaBucketLabel(bothSides)).toBe("Underarms");
  });

  it("the bucket key depends on the SET of areas, not the tap order (found by adversarial review)", () => {
    // display_order is the practitioner's TAP order: multi-area-editor appends
    // each committed area to the end and the writer stores the index verbatim.
    // Charting Cheek-then-Sideburn one visit and Sideburn-then-Cheek the next
    // must not split one anatomical combination across two breakdown rows.
    const visit1: MinutesBucketBlock = {
      minutes_performed: 30,
      structured_areas: [
        { area: "Cheek", laterality: "left", display_order: 0, created_at: "t1", id: "a1" },
        { area: "Sideburn", laterality: "right", display_order: 1, created_at: "t2", id: "a2" },
      ] as never,
    };
    const visit2: MinutesBucketBlock = {
      minutes_performed: 20,
      structured_areas: [
        { area: "Sideburn", laterality: "right", display_order: 0, created_at: "t1", id: "b1" },
        { area: "Cheek", laterality: "left", display_order: 1, created_at: "t2", id: "b2" },
      ] as never,
    };

    expect(resolveAreaBucketLabel(visit1)).toBe(resolveAreaBucketLabel(visit2));

    const { byArea, total } = bucketMinutes([visit1, visit2]);
    expect(byArea.size).toBe(1);
    expect(byArea.get("Cheek · Sideburn")).toBe(50);
    expect(byArea.get("Sideburn · Cheek")).toBeUndefined();
    expect(total).toBe(50);

    // And the single row carries the whole share.
    const rows = buildAreaMinutesBreakdown([visit1, visit2]);
    expect(rows).toHaveLength(1);
    expect(rows[0].percentage).toBe(100);
  });

  it("three areas charted in any order collapse to ONE bucket", () => {
    const mk = (order: string[], minutes: number): MinutesBucketBlock => ({
      minutes_performed: minutes,
      structured_areas: order.map((area, i) => ({
        area,
        laterality: "not_applicable",
        display_order: i,
        created_at: `t${i}`,
        id: `${area}-${i}`,
      })) as never,
    });
    const rows = buildAreaMinutesBreakdown([
      mk(["Chin", "Jawline", "Neck"], 10),
      mk(["Neck", "Chin", "Jawline"], 10),
      mk(["Jawline", "Neck", "Chin"], 10),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].area).toBe("Chin · Jawline · Neck");
    expect(rows[0].minutes).toBe(30);
  });

  it("dedupes case-insensitively, keeping the first spelling", () => {
    const mixed: AreaBucketBlock = {
      structured_areas: [
        { area: "Chin", laterality: "not_applicable", display_order: 0, created_at: "t1", id: "a1" },
        { area: "chin", laterality: "midline", display_order: 1, created_at: "t2", id: "a2" },
      ] as never,
    };
    expect(resolveAreaBucketLabel(mixed)).toBe("Chin");
  });
});

describe("single structured area: behaviour is unchanged", () => {
  it("buckets under the bare area, exactly as before", () => {
    expect(
      resolveAreaBucketLabel({
        primary_area: "Chin",
        structured_areas: [
          { area: "Chin", laterality: "left", display_order: 0, created_at: "t", id: "a" },
        ] as never,
      }),
    ).toBe("Chin");
  });

  it("does NOT fragment by side — a left and a right block share one bucket", () => {
    const left: AreaBucketBlock & { minutes_performed: number } = {
      minutes_performed: 20,
      structured_areas: [
        { area: "Underarms", laterality: "left", display_order: 0, created_at: "t", id: "a" },
      ] as never,
    };
    const right: AreaBucketBlock & { minutes_performed: number } = {
      minutes_performed: 10,
      structured_areas: [
        { area: "Underarms", laterality: "right", display_order: 0, created_at: "t", id: "b" },
      ] as never,
    };
    const { byArea } = bucketMinutes([left, right]);
    expect(byArea.size).toBe(1);
    expect(byArea.get("Underarms")).toBe(30);
    expect(byArea.get("Left Underarms")).toBeUndefined();
  });
});

describe("legacy fallback: unchanged", () => {
  it("uses primary_area when there are no structured rows", () => {
    expect(
      resolveAreaBucketLabel({ primary_area: "Upper lip", block_name: "Main" }),
    ).toBe("Upper lip");
  });

  it("falls back to a meaningful block name", () => {
    expect(resolveAreaBucketLabel({ block_name: "Neckline" })).toBe("Neckline");
  });

  it("buckets generic block names as Other", () => {
    expect(resolveAreaBucketLabel({ block_name: "Main" })).toBe("Other");
    expect(resolveAreaBucketLabel({ block_name: "Treatment 1" })).toBe("Other");
    expect(resolveAreaBucketLabel({ block_name: "  " })).toBe("Other");
    expect(resolveAreaBucketLabel({})).toBe("Other");
  });

  it("bucketize keeps its original contract", () => {
    expect(bucketize(null)).toBe("Other");
    expect(bucketize("main")).toBe("Other");
    expect(bucketize("Treatment 12")).toBe("Other");
    expect(bucketize(" Chin ")).toBe("Chin");
  });

  it("an empty structured_areas array falls through to legacy", () => {
    expect(
      resolveAreaBucketLabel({ primary_area: "Chin", structured_areas: [] }),
    ).toBe("Chin");
  });

  it("structured rows whose names are all blank fall through to legacy", () => {
    expect(
      resolveAreaBucketLabel({
        primary_area: "Chin",
        structured_areas: [
          { area: "   ", laterality: "left", display_order: 0, created_at: "t", id: "a" },
        ] as never,
      }),
    ).toBe("Chin");
  });
});

describe("TOTAL INVARIANCE — the attribution label moves, the total never does", () => {
  // A realistic mixed history: legacy blocks, single-area blocks, and
  // multi-area blocks with two and three areas.
  const history: Array<AreaBucketBlock & { minutes_performed: number | null }> = [
    { block_name: "Main", primary_area: "Chin", minutes_performed: 20 },
    {
      primary_area: "Cheek",
      minutes_performed: 30,
      structured_areas: [
        { area: "Cheek", laterality: "left", display_order: 0, created_at: "t1", id: "a1" },
        { area: "Sideburn", laterality: "right", display_order: 1, created_at: "t2", id: "a2" },
      ] as never,
    },
    {
      primary_area: "Neck",
      minutes_performed: 12,
      structured_areas: [
        { area: "Neck", laterality: "bilateral", display_order: 0, created_at: "t1", id: "b1" },
      ] as never,
    },
    {
      primary_area: "Chin",
      minutes_performed: 18,
      structured_areas: [
        { area: "Chin", laterality: "midline", display_order: 0, created_at: "t1", id: "c1" },
        { area: "Jawline", laterality: "left", display_order: 1, created_at: "t2", id: "c2" },
        { area: "Neck", laterality: "bilateral", display_order: 2, created_at: "t3", id: "c3" },
      ] as never,
    },
    { block_name: "Treatment 2", minutes_performed: 5 },
    { primary_area: "Chin", minutes_performed: null },
    { primary_area: "Chin", minutes_performed: 0 },
  ];

  // The behaviour BEFORE this change: primary_area, else bucketize(block_name).
  function legacyBucket(b: AreaBucketBlock): string {
    const structured = b.primary_area?.trim();
    if (structured && structured.length > 0) return structured;
    return bucketize(b.block_name ?? null);
  }

  const EXPECTED_TOTAL = 20 + 30 + 12 + 18 + 5;

  it("the sum of the breakdown equals the global total", () => {
    const { byArea, total } = bucketMinutes(history);
    expect(total).toBe(EXPECTED_TOTAL);
    expect(sum(byArea)).toBe(EXPECTED_TOTAL);
  });

  it("the total is IDENTICAL to the pre-refactor total, minute for minute", () => {
    let legacyTotal = 0;
    const legacyByArea = new Map<string, number>();
    for (const b of history) {
      const minutes = b.minutes_performed ?? 0;
      if (minutes === 0) continue;
      const area = legacyBucket(b);
      legacyByArea.set(area, (legacyByArea.get(area) ?? 0) + minutes);
      legacyTotal += minutes;
    }
    const { byArea, total } = bucketMinutes(history);

    expect(total).toBe(legacyTotal);
    expect(sum(byArea)).toBe(sum(legacyByArea));
  });

  it("the reported percentages can never exceed 100 (a per-area credit would break this)", () => {
    const rows = buildAreaMinutesBreakdown(history);
    const pct = rows.reduce((n, r) => n + r.percentage, 0);
    // Rounding can move the sum a point or two either way; a double-counted
    // multi-area block would push it far past 100.
    expect(pct).toBeGreaterThanOrEqual(97);
    expect(pct).toBeLessThanOrEqual(103);
    for (const r of rows) expect(r.percentage).toBeLessThanOrEqual(100);
  });

  it("the breakdown is sorted by minutes, descending", () => {
    const rows = buildAreaMinutesBreakdown(history);
    const minutes = rows.map((r) => r.minutes);
    expect(minutes).toEqual([...minutes].sort((a, b) => b - a));
  });

  it("an all-empty history returns an empty breakdown, not a zero row", () => {
    expect(buildAreaMinutesBreakdown([])).toEqual([]);
    expect(
      buildAreaMinutesBreakdown([{ primary_area: "Chin", minutes_performed: 0 }]),
    ).toEqual([]);
  });

  it("no block contributes to more than one bucket", () => {
    for (const b of history) {
      const minutes = b.minutes_performed ?? 0;
      if (minutes === 0) continue;
      const { byArea, total } = bucketMinutes([b]);
      expect(byArea.size).toBe(1);
      expect(total).toBe(minutes);
    }
  });

  it("every structured area that was treated appears SOMEWHERE in the breakdown", () => {
    const { byArea } = bucketMinutes(history);
    const labels = [...byArea.keys()].join(" | ");
    for (const name of ["Chin", "Cheek", "Sideburn", "Neck", "Jawline"]) {
      expect(labels).toContain(name);
    }
    // The precise regression: under the old rule "Sideburn" and "Jawline"
    // appeared nowhere at all.
    expect(labels).toContain("Sideburn");
    expect(labels).toContain("Jawline");
  });

  it("zero-minute and null-minute blocks are skipped, not bucketed as 0", () => {
    const { byArea } = bucketMinutes([
      { primary_area: "Ghost", minutes_performed: null },
      { primary_area: "Ghost", minutes_performed: 0 },
    ]);
    expect(byArea.size).toBe(0);
  });
});
