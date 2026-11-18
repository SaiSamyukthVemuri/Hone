// TODAY ROW MEMORY: where each line came from (pure; no I/O, no clock, no timezone of its own).
//
// The Today row's Remember, Caution and Latest setup lines are NOT always from the client's latest visit,
// and that is deliberate: a newer visit with no notes does not hide earlier guidance (PR #203, HON-10 row
// 2), and a newer visit with no charted treatment does not blank the last charted setup. What was missing
// is the SAYING: the lines carried no date and no source, so weeks-old guidance read as "from last time".
//
// These labels say it. They never change WHICH visit is picked; they describe the pick already made.
//   same visit      "Notes from 10 Nov"
//   earlier visit   "Notes from 3 Oct (the latest visit on 10 Nov has no notes)"
//                   "Setup from 3 Oct (the latest visit on 10 Nov has no charted setup)"
// Dates are the STUDIO's calendar days, formatted on the server, never the server's or the viewer's locale.
// "The latest visit" is the newest live, non-void session before this appointment: a draft or incomplete
// session counts as a visit (it is a charting state, not evidence of no visit), a void or deleted one does not.

export type MemorySourcePoint = {
  /** The source session's start (ISO). */
  at: string;
  /** True when this source IS the latest visit, so nothing was skipped. */
  isLatest: boolean;
};

export type MemorySources = {
  /** Start of the latest live, non-void visit before this appointment; null when there is none. */
  latestAt: string | null;
  /** Where the plan/caution notes came from; null when no note exists. */
  notes: MemorySourcePoint | null;
  /**
   * What `notes` is a source OF. "notes" (default): the Today pick, which skips a visit only when it has neither a plan nor a caution,
   * so "has no notes" is true of every skipped visit. "plan": the off-Today plan line, which is the newest "for next visit" note only,
   * so a skipped newer visit may well have cautions or other notes; the reason must say what is actually missing.
   */
  notesKind?: "notes" | "plan";
  /** Where the latest setup/treatment came from; null when none is charted. */
  setup: MemorySourcePoint | null;
};

export const NO_MEMORY_SOURCES: MemorySources = { latestAt: null, notes: null, setup: null };

export type MemorySourceLabels = { notes: string | null; setup: string | null };

/** "3 Oct" in the studio's calendar, with the year only when it is not the current studio year. */
export function studioDayLabel(iso: string, nowIso: string, timeZone: string): string | null {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  const fmt = (tz: string, opts: Intl.DateTimeFormatOptions, d: Date) => new Intl.DateTimeFormat("en-GB", { timeZone: tz, ...opts }).format(d);
  const run = (tz: string) => {
    const year = fmt(tz, { year: "numeric" }, at);
    const nowYear = fmt(tz, { year: "numeric" }, new Date(nowIso));
    return fmt(tz, year === nowYear ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" }, at);
  };
  try {
    return run(timeZone);
  } catch {
    return run("UTC");
  }
}

export function memorySourceLabels(
  sources: MemorySources | null | undefined,
  nowIso: string,
  timeZone: string,
): MemorySourceLabels {
  if (!sources) return { notes: null, setup: null };
  const latest = sources.latestAt ? studioDayLabel(sources.latestAt, nowIso, timeZone) : null;
  const label = (what: string, point: MemorySourcePoint | null, missing: string): string | null => {
    if (!point) return null;
    const day = studioDayLabel(point.at, nowIso, timeZone);
    if (!day) return null;
    if (point.isLatest) return `${what} from ${day}`;
    // An earlier source: always say so. If the latest visit's own date cannot be shown, still say it is earlier.
    return latest
      ? `${what} from ${day} (the latest visit on ${latest} ${missing})`
      : `${what} from ${day} (an earlier visit)`;
  };
  return {
    notes:
      sources.notesKind === "plan"
        ? label("Plan", sources.notes, "has no plan for next time")
        : label("Notes", sources.notes, "has no notes"),
    setup: label("Setup", sources.setup, "has no charted setup"),
  };
}
