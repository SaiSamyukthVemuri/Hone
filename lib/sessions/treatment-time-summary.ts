import type { SessionBlock } from "@/lib/types/database";

// HON-59 (first slice, no schema). The minutes a session's treatment areas
// recorded, summed, and labelled for what they are.
//
// What this is NOT, deliberately:
//   - not the visit's elapsed time. sessions.ended_at is not written by the
//     chart, so Hone does not know how long the visit lasted;
//   - not split by practitioner. session_blocks carries no author, so any
//     per-practitioner split would be invented;
//   - not a billing total. Billing/unit rules for multi-practitioner visits
//     are undecided (HON-59: "do not infer billable totals").
//
// Only area-level minutes (session_blocks.minutes_performed) are summed. The
// legacy per-pass minutes on electrolysis_entries are NOT added in: a block
// and its passes can both carry minutes, and adding both would double-count.

export type TreatmentTimeBlock = Pick<
  SessionBlock,
  "minutes_performed" | "started_at" | "ended_at" | "deleted_at"
>;

export type TreatmentTimeSummary = {
  /** Live (not removed) treatment areas. */
  areaCount: number;
  /** Areas with a recorded, non-negative minutes value. */
  areasWithMinutes: number;
  /** Sum of those minutes. */
  recordedMinutes: number;
  /**
   * True only when at least two areas carry BOTH a start and an end and two
   * of those intervals overlap, i.e. the record itself shows concurrent work.
   * False means "not shown to overlap", never "proven sequential".
   */
  overlapRecorded: boolean;
};

function interval(b: TreatmentTimeBlock): [number, number] | null {
  if (!b.started_at || !b.ended_at) return null;
  const s = Date.parse(b.started_at);
  const e = Date.parse(b.ended_at);
  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return null;
  return [s, e];
}

export function summarizeTreatmentTime(
  blocks: ReadonlyArray<TreatmentTimeBlock>,
): TreatmentTimeSummary {
  const live = blocks.filter((b) => b.deleted_at == null);
  let areasWithMinutes = 0;
  let recordedMinutes = 0;
  for (const b of live) {
    const m = b.minutes_performed;
    if (typeof m === "number" && Number.isFinite(m) && m >= 0) {
      areasWithMinutes += 1;
      recordedMinutes += m;
    }
  }

  const intervals = live
    .map(interval)
    .filter((i): i is [number, number] => i !== null)
    .sort((a, b) => a[0] - b[0]);
  let overlapRecorded = false;
  for (let i = 1; i < intervals.length; i++) {
    // Touching end-to-start (10:30 end, 10:30 start) is sequential.
    if (intervals[i][0] < intervals[i - 1][1]) {
      overlapRecorded = true;
      break;
    }
  }

  return {
    areaCount: live.length,
    areasWithMinutes,
    recordedMinutes,
    overlapRecorded,
  };
}

export function formatMinutes(total: number): string {
  if (total < 60) return `${total} min`;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}
