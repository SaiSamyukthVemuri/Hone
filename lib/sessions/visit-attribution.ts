import { summarizeTreatmentTime, type TreatmentTimeBlock } from "@/lib/sessions/treatment-time-summary";

// HON-59 (no schema). Several practitioners' contributions to ONE visit.
//
// The existing model already carries the author: a session has exactly one
// practitioner and its blocks inherit that author (session_blocks has no author
// column of its own). A visit with two practitioners is therefore two sessions
// linked to the same appointment. This reads that shape; it adds none.
//
// Distinguishes, and never merges:
//   * each practitioner's own recorded minutes (their sessions' live blocks);
//   * summedMinutes: the sum of those, i.e. practitioner treatment time;
//   * recordedSpanMinutes: the time covered by recorded block intervals (the
//     union), only when every counted block has a start and an end. It is NOT
//     the visit's elapsed time; Hone does not record that.
// A chart for another appointment, or for none, is refused, never folded in.
// Unknown stays unknown. Nothing here is billable, a unit or a charge.

export type VisitSession = {
  id: string;
  practitionerId: string;
  appointmentId: string | null;
  blocks: ReadonlyArray<TreatmentTimeBlock>;
};

export type PractitionerContribution = {
  practitionerId: string;
  sessionIds: string[];
  areaCount: number;
  /** null: no area of theirs carries minutes (unknown, not zero). */
  recordedMinutes: number | null;
};

export type VisitAttribution = {
  practitioners: PractitionerContribution[];
  /** Sum of the known per-practitioner minutes; null when none is known. */
  summedMinutes: number | null;
  /** Union of recorded block intervals; null unless every live block has one. */
  recordedSpanMinutes: number | null;
  /** True only when two different practitioners' recorded intervals overlap. */
  concurrentRecorded: boolean;
  /** Some contribution has no recorded minutes, so the sum is a floor. */
  hasUnknown: boolean;
  /** Sessions refused because they belong to another visit or none. */
  excludedSessionCount: number;
};

type Interval = [start: number, end: number, practitionerId: string];

export function attributeVisit(
  appointmentId: string,
  sessions: ReadonlyArray<VisitSession>,
): VisitAttribution {
  const byPractitioner = new Map<string, PractitionerContribution>();
  const intervals: Interval[] = [];
  let excluded = 0;
  let allLiveBlocksTimed = true;
  let anyLive = false;

  for (const s of sessions) {
    if (s.appointmentId !== appointmentId) {
      excluded += 1;
      continue;
    }
    const sum = summarizeTreatmentTime(s.blocks);
    const c = byPractitioner.get(s.practitionerId) ?? {
      practitionerId: s.practitionerId,
      sessionIds: [],
      areaCount: 0,
      recordedMinutes: null,
    };
    c.sessionIds.push(s.id);
    c.areaCount += sum.areaCount;
    if (sum.areasWithMinutes > 0) c.recordedMinutes = (c.recordedMinutes ?? 0) + sum.recordedMinutes;
    byPractitioner.set(s.practitionerId, c);

    for (const b of s.blocks) {
      if (b.deleted_at != null) continue;
      anyLive = true;
      const st = b.started_at ? Date.parse(b.started_at) : NaN;
      const en = b.ended_at ? Date.parse(b.ended_at) : NaN;
      if (Number.isFinite(st) && Number.isFinite(en) && en > st) intervals.push([st, en, s.practitionerId]);
      else allLiveBlocksTimed = false;
    }
  }

  const practitioners = [...byPractitioner.values()];
  const known = practitioners.filter((p) => p.recordedMinutes !== null);
  const summedMinutes = known.length ? known.reduce((n, p) => n + (p.recordedMinutes as number), 0) : null;

  intervals.sort((a, b) => a[0] - b[0]);
  let concurrent = false;
  let covered = 0;
  let curEnd = -Infinity;
  let curOwner = "";
  for (const [st, en, who] of intervals) {
    if (st < curEnd && who !== curOwner) concurrent = true;
    if (st >= curEnd) {
      covered += en - st;
      curEnd = en;
      curOwner = who;
    } else if (en > curEnd) {
      covered += en - curEnd;
      curEnd = en;
      curOwner = who;
    }
  }

  return {
    practitioners,
    summedMinutes,
    recordedSpanMinutes: anyLive && allLiveBlocksTimed ? Math.round(covered / 60_000) : null,
    concurrentRecorded: concurrent,
    hasUnknown: practitioners.some((p) => p.recordedMinutes === null),
    excludedSessionCount: excluded,
  };
}
