import { describe, expect, it } from "vitest";
import {
  CHARTED_COUNT_COLUMNS,
  hasCautionFromCounts,
  hasLiveBlocksFromCounts,
  isChartedFromCounts,
  liveBlockCount,
  liveEntryCount,
  liveLaserCount,
  type ChartedEvidenceRow,
} from "@/lib/sessions/history/evidence";

const row = (over: ChartedEvidenceRow = {}): ChartedEvidenceRow => ({
  live_block_count: [{ count: 0 }],
  live_entry_count: [{ count: 0 }],
  live_laser_count: [{ count: 0 }],
  caution_count: [{ count: 0 }],
  ...over,
});

describe("a RECORDED ZERO is an answer; a MISSING count is not", () => {
  it("zero across all three channels is authoritatively NOT charted", () => {
    expect(isChartedFromCounts(row())).toBe(false);
  });

  it("a count that never arrived is UNDECIDABLE, never false", () => {
    expect(isChartedFromCounts({})).toBeNull();
    expect(hasLiveBlocksFromCounts({})).toBeNull();
    expect(hasCautionFromCounts({})).toBeNull();
    expect(liveBlockCount({})).toBeNull();
    expect(liveEntryCount({})).toBeNull();
    expect(liveLaserCount({})).toBeNull();
  });

  it("ONE missing count poisons the charted answer — it is conjunctive", () => {
    // Blocks say charted, entries never arrived. `true` would be luck; `false`
    // would be the defect. It is undecidable.
    expect(
      isChartedFromCounts({
        live_block_count: [{ count: 3 }],
        live_laser_count: [{ count: 0 }],
      }),
    ).toBeNull();
    expect(
      isChartedFromCounts({
        live_block_count: [{ count: 0 }],
        live_entry_count: [{ count: 0 }],
      }),
    ).toBeNull();
  });
});

describe("every shape PostgREST can return that is NOT a count", () => {
  const NOT_A_COUNT: ReadonlyArray<readonly [string, unknown]> = [
    ["an absent column", undefined],
    ["an explicit null", null],
    ["an EMPTY embed array", []],
    ["an object instead of an array", { count: 4 }],
    ["a non-numeric count", [{ count: "4" }]],
    ["a NaN count", [{ count: Number.NaN }]],
    ["an Infinite count", [{ count: Number.POSITIVE_INFINITY }]],
    ["an element with no count at all", [{}]],
  ];

  for (const [label, embed] of NOT_A_COUNT) {
    it(`${label} reads as UNDECIDABLE`, () => {
      expect(liveBlockCount({ live_block_count: embed as never }), label).toBeNull();
      expect(
        hasLiveBlocksFromCounts({ live_block_count: embed as never }),
        label,
      ).toBeNull();
      expect(hasCautionFromCounts({ caution_count: embed as never }), label).toBeNull();
      expect(
        isChartedFromCounts(row({ live_block_count: embed as never })),
        label,
      ).toBeNull();
    });
  }
});

describe("a legacy entry-only visit is charted, and says so", () => {
  it("electrolysis entries alone make it charted", () => {
    // The visit shape with no settings block at all. Inferring charted-ness from
    // blocks reported these as empty, which is how they lost to a newer
    // uncharted session.
    const legacy = row({ live_entry_count: [{ count: 6 }] });
    expect(isChartedFromCounts(legacy)).toBe(true);
    expect(hasLiveBlocksFromCounts(legacy)).toBe(false);
    expect(liveEntryCount(legacy)).toBe(6);
  });

  it("laser entries alone make it charted", () => {
    const laser = row({ live_laser_count: [{ count: 2 }] });
    expect(isChartedFromCounts(laser)).toBe(true);
    expect(liveLaserCount(laser)).toBe(2);
  });

  it("blocks alone make it charted, and carry the setup evidence", () => {
    const blocks = row({ live_block_count: [{ count: 1 }] });
    expect(isChartedFromCounts(blocks)).toBe(true);
    expect(hasLiveBlocksFromCounts(blocks)).toBe(true);
  });
});

describe("the caution decision never touches the block collection", () => {
  it("a positive caution count is a POSITIVE observation", () => {
    expect(hasCautionFromCounts(row({ caution_count: [{ count: 1 }] }))).toBe(true);
  });

  it("zero is authoritative; missing is not", () => {
    expect(hasCautionFromCounts(row({ caution_count: [{ count: 0 }] }))).toBe(false);
    expect(hasCautionFromCounts({ live_block_count: [{ count: 9 }] })).toBeNull();
  });

  it("the caution count is INDEPENDENT of the block count", () => {
    expect(hasCautionFromCounts(row({ live_block_count: [{ count: 5 }] }))).toBe(false);
    expect(hasCautionFromCounts({ caution_count: [{ count: 2 }] })).toBe(true);
  });
});

describe("the aggregate selection names every alias the readers use", () => {
  it("declares all four aggregates", () => {
    for (const alias of [
      "live_block_count:session_blocks(count)",
      "live_entry_count:electrolysis_entries(count)",
      "live_laser_count:laser_entries(count)",
      "caution_count:session_blocks(count)",
    ]) {
      expect(CHARTED_COUNT_COLUMNS).toContain(alias);
    }
  });

  it("the two session_blocks aggregates are DISTINCTLY aliased", () => {
    // They differ only by the filter the caller attaches; a shared alias would
    // make one silently overwrite the other.
    expect(CHARTED_COUNT_COLUMNS.match(/session_blocks\(count\)/g)).toHaveLength(2);
  });

  it("names NO clinical column — it is an aggregate selection, not a projection", () => {
    // The projection law governs the full-detail clinical read. This string must
    // never grow a treatment field, or there would be two projections again.
    for (const clinical of [
      "primary_area", "caution_note", "hairs_treated", "energy_level",
      "probe_lot_number", "tolerance_rating", "reaction_type", "machine_frequency",
    ]) {
      expect(CHARTED_COUNT_COLUMNS).not.toContain(clinical);
    }
  });
});
