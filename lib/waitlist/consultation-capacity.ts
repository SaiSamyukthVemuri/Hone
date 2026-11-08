// How many consultations actually fit a selected window.
//
// PURE. The slots come from the canonical public-slot engine (real service
// duration, blocked time, existing reservations and availability rules), so
// nothing about hours or length is assumed here. This module answers the one
// question the engine's per-slot list does not: how many of those slots can be
// held AT ONCE.
//
// OVERLAPPING STARTS. The engine lists every legal start, so a 60-minute service
// offers 9:00 and 9:30. Counting both would promise two consultations in a window
// that holds one. The count is the largest set of starts whose protected spans
// (start .. end + the studio buffer) do not overlap, chosen greedily by earliest
// finish, which is optimal for interval scheduling.
//
// ONE RESOURCE. The engine does not say which practitioner a slot belongs to, so
// this treats the studio as one calendar. That is a LOWER bound for a
// multi-practitioner studio: it never over-promises.

export type FitSlot = { start: string; end: string };

export function consultationsThatFit(slots: readonly FitSlot[], bufferMinutes: number): number {
  const gapMs = Math.max(0, bufferMinutes) * 60_000;
  const spans = slots
    .map((s) => ({ start: Date.parse(s.start), end: Date.parse(s.end) }))
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start)
    .sort((a, b) => a.end - b.end || a.start - b.start);
  let count = 0;
  let freeFrom = -Infinity;
  for (const s of spans) {
    if (s.start >= freeFrom) {
      count += 1;
      freeFrom = s.end + gapMs;
    }
  }
  return count;
}

export type CapacityEstimate = {
  /** Consultations that fit the window if nothing else is booked first. */
  fit: number;
  /** Invitations sent and not yet booked, from every batch for this window. */
  outstanding: number;
  /** What is left to offer: fit minus outstanding, never below zero. */
  open: number;
};

/**
 * `outstanding` is the count of LIVE (sent, unexpired, unredeemed) invitations.
 * A booked invitation is NOT subtracted: its appointment is already a
 * reservation in the slot list, so subtracting it again would count it twice.
 */
export function estimateCapacity(fit: number, outstanding: number): CapacityEstimate {
  const f = Math.max(0, Math.floor(fit));
  const o = Math.max(0, Math.floor(outstanding));
  return { fit: f, outstanding: o, open: Math.max(0, f - o) };
}

export const CAPACITY_NOTE =
  "Availability can change at any time. Nothing is reserved for an invitation until the person books.";

const slots = (n: number) => `${n} consultation slot${n === 1 ? "" : "s"}`;
const people = (n: number) => `${n} more ${n === 1 ? "person" : "people"}`;

/**
 * The allowance, in the owner's words: "N consultation slots available · You can invite M more people."
 *
 * Both numbers are lower bounds. The slot count treats the studio as one calendar (it never
 * over-promises but may under-count), and when 0323 is not applied the competing count covers every
 * live invitation whatever its dates, so M can only be too small. The note says so rather than
 * presenting a minimum as exact.
 */
export function allowanceHeadline(
  c: CapacityEstimate,
  outstandingScope: "window" | "all" = "window",
): { headline: string; short: string; note: string } {
  const headline = `${slots(c.fit)} available \u00b7 You can invite ${people(c.open)}.`;
  const short = `You can invite ${people(c.open)}`;
  const lowerBound =
    outstandingScope === "all"
      ? "These are minimums, and the invitations already out are counted whatever dates they cover."
      : "These are minimums: the count never over-promises but may under-count.";
  return {
    headline,
    short,
    note: `Next 14 days, any day or time. ${lowerBound} Availability can change; invitations don't reserve appointments.`,
  };
}

/**
 * The words beside the number in the composer, for the dates and days actually chosen.
 */
export function capacityLines(c: CapacityEstimate, outstandingScope: "window" | "all" = "window"): string[] {
  const lines = [allowanceHeadline(c, outstandingScope).headline];
  if (c.outstanding > 0) {
    lines.push(
      outstandingScope === "all"
        ? `${c.outstanding} invitation${c.outstanding === 1 ? " is" : "s are"} already out and not yet booked (this counts every live invitation, whatever dates it covers), so about ${c.open} more could be offered.`
        : `${c.outstanding} invitation${c.outstanding === 1 ? " is" : "s are"} already out for these dates and not yet booked, so about ${c.open} more could be offered.`,
    );
  }
  lines.push(CAPACITY_NOTE);
  return lines;
}
