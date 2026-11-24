// WHO COULD TAKE AN OPENED SLOT: a pure rule, wired to nothing.
//
// This fixes the matching rule in code and in tests so that the agreed answers can be dropped in later. It reads no table, calls no service, sends
// nothing, and nothing imports it yet. It decides nothing about WHO IS ASKED: the owner reviews and offers, and that flow, its expiry and the consent
// it needs are separate decisions that are not made here.
//
// THE ASSUMPTIONS BELOW ARE PENDING AN OWNER DECISION and each is one small place to change:
//   - a named practitioner is a REQUIREMENT (a person who wants someone specific is not offered another), "any" matches every practitioner;
//   - the slot must be at least as long as the person's minimum; buffers are NOT modelled here (the slot's own length is the engine's answer);
//   - day preference follows the three values the waitlist stores today (weekdays, weekends, both), read in the STUDIO's time zone;
//   - order is the original join date, earliest first; an unknown join date goes last, never first, because it cannot be shown to have waited.

export type DayPreference = "weekdays" | "weekends" | "both";

export type OpenedSlot = {
  practitionerId: string;
  /** ISO instant the slot starts. */
  startsAt: string;
  durationMinutes: number;
  /** The studio's IANA time zone: the weekday is the studio's, not the server's. */
  timeZone: string;
};

export type MatchCandidate = {
  entryId: string;
  /** ISO instant the person first joined, or null when it is not known. */
  joinedAt: string | null;
  /** Null: no day preference stated, so any day. */
  dayPreference: DayPreference | null;
  /** Null: any practitioner. */
  practitionerId: string | null;
  /** Null: no minimum stated. */
  minimumMinutes: number | null;
};

export type ExclusionReason = "other_practitioner" | "slot_too_short" | "day_not_preferred";

export type SlotMatch =
  | { ok: true; eligible: MatchCandidate[]; excluded: Array<{ entryId: string; reason: ExclusionReason }> }
  | { ok: false; reason: "invalid_slot" };

function studioWeekendDay(startsAt: string, timeZone: string): boolean | null {
  // A date with no time ("2026-11-28") parses as UTC midnight, which is the previous evening in the Americas: a wrong weekday read silently. Refused.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(startsAt)) return null;
  const t = Date.parse(startsAt);
  if (!Number.isFinite(t)) return null;
  try {
    const day = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone }).format(new Date(t));
    if (day === "Sat" || day === "Sun") return true;
    if (day === "Mon" || day === "Tue" || day === "Wed" || day === "Thu" || day === "Fri") return false;
    return null;
  } catch {
    return null; // an unknown time zone
  }
}

const joinedMs = (c: MatchCandidate): number => {
  const t = c.joinedAt === null ? Number.NaN : Date.parse(c.joinedAt);
  return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
};

export function matchSlot(slot: OpenedSlot, candidates: readonly MatchCandidate[]): SlotMatch {
  const weekend = studioWeekendDay(slot.startsAt, slot.timeZone);
  if (weekend === null || !Number.isFinite(slot.durationMinutes) || slot.durationMinutes <= 0 || slot.practitionerId === "") {
    return { ok: false, reason: "invalid_slot" };
  }
  const eligible: MatchCandidate[] = [];
  const excluded: Array<{ entryId: string; reason: ExclusionReason }> = [];
  for (const c of candidates) {
    if (c.practitionerId !== null && c.practitionerId !== slot.practitionerId) excluded.push({ entryId: c.entryId, reason: "other_practitioner" });
    else if (c.minimumMinutes !== null && slot.durationMinutes < c.minimumMinutes) excluded.push({ entryId: c.entryId, reason: "slot_too_short" });
    else if ((c.dayPreference === "weekdays" && weekend) || (c.dayPreference === "weekends" && !weekend)) excluded.push({ entryId: c.entryId, reason: "day_not_preferred" });
    else eligible.push(c);
  }
  // Earliest first; ties by entry id so the order never depends on the input order.
  eligible.sort((a, b) => joinedMs(a) - joinedMs(b) || (a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0));
  return { ok: true, eligible, excluded };
}
