import type { SupabaseClient } from "@supabase/supabase-js";
import {
  localMinutesSinceMidnight,
  localTimeString12h,
  minutesToHHMM,
  utcInstantFromLocal,
} from "./tz";
import {
  readFullDayBlockout,
  resolveAvailabilityWindow,
} from "./availability-window";

export type Slot = {
  start: string; // ISO UTC
  end: string; // ISO UTC
  // Client-facing 12-hour label (e.g. "9:00 AM"). Built with the
  // localTimeString12h formatter so public booking + reschedule slot
  // buttons read in the format clients expect. Internal practitioner
  // surfaces don't consume this field; they format their own labels
  // via localTimeString (24-hour) directly.
  startLabel: string;
};

// Public-only past-time guard for slot lists.
//
// Returns the subset of `slots` whose `start` instant is strictly
// after `now`. The shared helper exists so public booking, public
// reschedule, and the public next-available helpers cannot drift
// apart on what "future slot" means (PR #149 found that the
// reschedule slot list lacked this filter while public booking
// already had it).
//
// What this is NOT
// ----------------
// * NOT used by the practitioner calendar quick-book drawer or by
//   the internal slot helpers in app/(app)/calendar/actions.ts.
//   Practitioners intentionally see past slots for charting
//   workflows; only the PUBLIC surfaces (cancel/reschedule/book
//   tokenized + slug routes) apply this filter.
// * NOT a lead-time / buffer. A slot starting one minute from now
//   still passes. Add a separate helper if a real "n-hour lead time"
//   becomes a per-studio setting.
//
// `now` defaults to `new Date()` so callers don't need to plumb a
// clock; tests pass an explicit `now` so the filter is deterministic.
export function filterFutureSlots(
  slots: ReadonlyArray<Slot>,
  now: Date = new Date(),
): Slot[] {
  const nowMs = now.getTime();
  return slots.filter((s) => new Date(s.start).getTime() > nowMs);
}

type StudioRow = {
  id: string;
  timezone: string;
  default_appointment_duration_minutes: number;
  buffer_minutes: number;
  // Migration 0134: when true AND a practitionerId is supplied, slot generation
  // is per-practitioner (0135 availability + the practitioner's resource_key
  // reservations). Optional/absent => today's studio-wide behaviour.
  practitioner_capacity_enabled?: boolean;
};

// Migration 0030: slots now reads the unified shadow table
// studio_calendar_reservations, which holds protected intervals for
// confirmed appointments (with trailing buffer), one-off timed
// blocks, and full-day blockouts. Only the interval is selected;
// category labels and private notes never reach the public page.
type ReservationRow = {
  starts_at: string;
  ends_at: string;
  source_kind?: string;
  source_id?: string;
};

// One optional, SERVER-CONTROLLED reservation exclusion, so an appointment being
// MOVED does not count its OWN shadow reservation as a conflict against its new
// candidate times. Every OTHER reservation: other appointments, timed blocks,
// recurring-break occurrences, full-day blockouts: remains a conflict.
//
// Two callers pass it, and in BOTH the id is derived server-side; the browser
// never supplies it:
//   * the authenticated practitioner move-slot server action;
//   * the PUBLIC RESCHEDULE read surfaces (migration 0171). Counting the
//     original's own reservation hid every slot adjacent to it, and did not
//     model the final transaction: reschedule_appointment_v2 cancels the
//     original, which deletes that reservation, BEFORE inserting the successor.
//     public.public_reschedule_slot_candidates applies the identical exclusion
//     in SQL so the offered set and the accepted set cannot diverge.
//
// PUBLIC BOOKING never passes it: there is no appointment being moved.
export type ReservationExclusion = {
  sourceKind: "appointment";
  sourceId: string;
};

// Smart/packed scheduling. Slots are no longer a fixed every-15-minute grid
// (which produced 10:00/10:15/10:30/… and arbitrary mid-day gaps). Instead
// candidate starts are ANCHORED to (1) the opening time and (2) immediately
// after each existing reservation's protected end, plus a COARSE fallback so a
// long empty stretch still offers a few choices instead of a single slot.
// FALLBACK_GRANULARITY_MINUTES is intentionally coarse (hourly). It only
// fills empty windows; the precise anchors do the packing.
const FALLBACK_GRANULARITY_MINUTES = 60;

// EDGE PACKING: the free-window model, and the one boundary it was missing.
//
// Conceptually the day is:   availability window − protected reservations
//                          = a list of FREE WINDOWS
// and each free window deserves two precise anchors:
//
//   LEFT-PACK , the earliest legal start in the window.
//   RIGHT-PACK, the latest legal start that still fits before the window's
//                right edge.
//
// The anchor families above ALREADY implement that model for every window
// bounded by reservations:
//   * left-pack  of the first window            = the opening anchor      (1)
//   * left-pack  of a post-reservation window   = conflict.end            (2)
//   * right-pack of a pre-reservation window    = conflict.start − d − b  (2b)
//
// The single gap is the LAST free window, whose right edge is CLOSING TIME
// rather than a reservation start. Nothing generated `close − duration`, so the
// most tightly packed end-of-day start simply did not exist as a candidate. On a
// 09:00–17:00 day with a 45-minute service the hourly fallback walk from the
// OPENING edge ends at 16:00 (16:00 + 45 = 16:45), stranding 16:45–17:00, while
// 16:15 would have consumed the closing window exactly. The asymmetry is
// structural: every family is derived from the opening edge or from a
// reservation, and never from the closing edge.
//
// BUFFER SEMANTICS AT THE CLOSING EDGE, deliberately NOT symmetric with (2b).
//
//   right-pack before a RESERVATION = reservation.start − duration − buffer
//   right-pack before CLOSING TIME  = close − duration          (NO buffer)
//
// That is not an oversight; it is Hone's existing, authoritative rule. The fit
// filter below tests the SERVICE end against close (`start + duration > close`)
// and lets the trailing studio buffer spill past closing time, and the database
// agrees: `validate_appointment_availability` tests `v_end_time > v_close`, and
// migration 0170's port states the same rule ("THE WINDOW IS CHECKED ON THE
// SERVICE END, NOT THE BUFFERED END"). Subtracting the buffer here would refuse
// the last slot of every day that the loader already offers today.
//
// So the closing anchor is exactly the maximal start satisfying the existing fit
// filter, which is also why it is computed in the UTC-instant domain
// (`closeMs − durationMs`) rather than by walking local minutes. The filter it
// mirrors lives in that domain, so the two cannot disagree, and a duration is a
// real elapsed span: across a DST transition the anchor stays exactly `duration`
// of wall-clock-independent time before close, which is the correct meaning.
//
// SCOPE: INTERNAL SURFACES ONLY, and why that is not timidity.
//
// The PUBLIC booking and PUBLIC reschedule commands do not merely validate a
// submitted time against broad rules; migrations 0170/0171 RE-DERIVE this
// candidate set in SQL (public_booking_slot_candidates /
// public_reschedule_slot_candidates) and require EXACT millisecond membership,
// returning 'not_a_public_slot' otherwise. Adding a fourth anchor family here
// without porting it there would make the public page offer 16:15 and the
// database refuse it: the precise display-vs-acceptance divergence the SQL port
// exists to prevent, and it would break the two behavioural parity suites that
// assert set equality between the engines.
//
// Enabling this for the public surfaces therefore requires a migration that
// ports the closing anchor into both SQL functions, in the same change. Until
// then the option is opt-in and only the INTERNAL practitioner surfaces (which
// validate through validate_appointment_availability, broad rules, no grid
// membership) pass it. Public callers omit it and are byte-for-byte unchanged.
export type SlotPackingOptions = {
  // Adds the closing-edge right-pack anchor (`close − duration`) and suppresses
  // the coarse fallback candidate it dominates. INTERNAL SURFACES ONLY. See the
  // scope note above before passing this from a public route.
  packAgainstClosingEdge?: boolean;
};

// The packing contract for AUTHENTICATED PRACTITIONER surfaces: the calendar
// quick-book drawer, the client-page booking form, and move/reassign. Those
// three book through create_internal_appointment_v2 / move_or_reassign_appointment,
// which validate via validate_appointment_availability, hours, blockouts,
// overlap and buffer, but NO exact grid membership, so a newly packed candidate
// is accepted by the database exactly as it is offered.
//
// Shared as one frozen object so a surface that shows slots and the re-check
// that accepts them cannot drift apart: move-appointment-actions.ts generates
// the list twice (display, then server-side re-verification) and both must
// agree, or a slot the practitioner can see becomes unbookable.
export const INTERNAL_SLOT_PACKING: SlotPackingOptions = Object.freeze({
  packAgainstClosingEdge: true,
});

export async function getAvailableSlots(
  supabase: SupabaseClient,
  studio: StudioRow,
  dateStr: string,
  serviceDurationMinutes?: number,
  excludeReservation?: ReservationExclusion,
  practitionerId?: string | null,
  options?: SlotPackingOptions,
): Promise<Slot[]> {
  const tz = studio.timezone;
  // Per-practitioner generation is opt-in: it requires BOTH the studio flag
  // (0134) AND an explicit practitionerId. When off, NOTHING below references
  // the 0134/0135 columns (practitioner_id / resource_key), so this path is
  // byte-for-byte today's studio-wide behaviour and safe before those
  // migrations are applied.
  const capacityOn =
    studio.practitioner_capacity_enabled === true &&
    practitionerId !== undefined &&
    practitionerId !== null;
  const buffer = Math.max(0, studio.buffer_minutes ?? 0);
  const duration =
    serviceDurationMinutes ?? studio.default_appointment_duration_minutes ?? 60;

  // Blockout. Policy PRESERVED EXACTLY: a blockout row yields no slots, and a
  // FAILED read is discarded (generation continues as though there were none),
  // which is what this code has always done. This function feeds the PUBLIC
  // booking and reschedule pages, so hardening that read here would be an
  // unrelated behaviour change to public surfaces. The new manual-time check
  // fails closed instead; see readFullDayBlockout.
  const blockout = await readFullDayBlockout(supabase, studio.id, dateStr);
  if (blockout.blocked) return [];

  // The open window now comes from the SHARED resolver in
  // lib/booking/availability-window.ts, which holds the single implementation
  // of the default/override precedence (studio-wide for capacity OFF;
  // practitioner-specific winning over studio-wide for capacity ON, matching
  // validate_appointment_availability's `order by (practitioner_id is not null)
  // desc limit 1` pair in migration 0152).
  //
  // It used to live inline here, which meant the ONLY code that knew a
  // practitioner's real working hours was the code that generates packed
  // suggestions. Anything else that needed the window -- notably "is this
  // manually chosen time actually inside your hours?" -- had no way to ask, and
  // the internal booking action ended up substituting "is it one of the
  // suggestions?" instead. Extracting it is what lets a second caller ask the
  // real question without building a second, subtly different booking calendar.
  //
  // Generation semantics are unchanged: a closed or absent window yields NO
  // slots, exactly as `if (!isOpen || !openTime || !closeTime) return []` did.
  //
  // The weekday it resolves against is now derived from the CALENDAR DATE
  // rather than from a noon-UTC instant round-tripped through the studio zone.
  // That round trip returned the NEXT day's weekday in UTC+13/UTC+14, so a
  // Monday generated Tuesday's hours. It is corrected inside the shared
  // resolver, so the slot engine and the manual-time check are fixed together
  // and still share exactly one calendar.
  const window = await resolveAvailabilityWindow(
    supabase,
    studio,
    dateStr,
    practitionerId,
  );
  if (window.kind !== "open") return [];
  const openTime: string = window.openTime;
  const closeTime: string = window.closeTime;

  // Load every reservation whose interval overlaps the day's
  // availability window. The shadow holds appointment protected
  // intervals, one-off timed blocks, and full-day blockouts as
  // concrete UTC ranges. Filtering only on starts_at would miss a
  // late previous-day reservation whose interval extends into the
  // day we are searching.
  const windowStartUtc = utcInstantFromLocal(dateStr, "00:00", tz);
  const windowEndUtc = new Date(windowStartUtc.getTime() + 36 * 3600 * 1000);
  // ON: the practitioner's own timeline: resource_key = practitionerId already
  // holds their appointments PLUS every studio-wide block fanned to them (0134),
  // so different practitioners run in parallel. OFF: studio-wide (today).
  const reservationBase = supabase
    .from("studio_calendar_reservations")
    .select("starts_at, ends_at, source_kind, source_id")
    .lt("starts_at", windowEndUtc.toISOString())
    .gt("ends_at", windowStartUtc.toISOString());
  const { data: reservations } = await (capacityOn
    ? reservationBase.eq("resource_key", practitionerId)
    : reservationBase.eq("studio_id", studio.id));

  const durationMs = duration * 60_000;
  const bufferMs = buffer * 60_000;

  // Conflict intervals are SOURCE-AWARE. Post-migration 0152 the appointment
  // shadow rows in studio_calendar_reservations store the ACTUAL treatment
  // interval (starts_at, ends_at) with NO trailing buffer, so the protected end
  // must be reconstructed per source:
  //   - appointment rows: protectedEnd = ends_at + the CURRENT studio buffer.
  //     This matches the authoritative DB buffer validator (0152's
  //     enforce_appointment_buffer / appointment_buffer_conflict); without it the
  //     generator would offer a start at an appointment's actual end that the DB
  //     then rejects (e.g. 14:00 right after a 13:00–14:00 appt with a 30-min buffer).
  //   - timed_block / recurring-break / full_day_blockout rows: raw (starts_at,
  //     ends_at). These carry no buffer and MUST NOT be widened past their end.
  const conflicts = ((reservations ?? []) as ReservationRow[])
    // Exclude ONLY the exact own-reservation of the appointment being moved (the
    // (source_kind, source_id) pair is unique). Every other reservation stays a conflict.
    .filter(
      (r) =>
        !(
          excludeReservation !== undefined &&
          r.source_kind === excludeReservation.sourceKind &&
          r.source_id === excludeReservation.sourceId
        ),
    )
    .map((r) => {
      const start = new Date(r.starts_at).getTime();
      const actualEnd = new Date(r.ends_at).getTime();
      // Re-apply the current buffer ONLY for appointments (0152 stores actual ends).
      const protectedEnd =
        r.source_kind === "appointment" ? actualEnd + bufferMs : actualEnd;
      return { start, end: protectedEnd };
    });

  const openMin = localMinutesSinceMidnight(openTime);
  const closeMin = localMinutesSinceMidnight(closeTime);

  const openStartMs = utcInstantFromLocal(dateStr, openTime, tz).getTime();
  const closeMs = utcInstantFromLocal(dateStr, closeTime, tz).getTime();

  // Candidate slot starts come from three sources (NOT "every 15 minutes"):
  const candidateMs = new Set<number>();
  // PRECISE anchors: the packing candidates: the opening edge, each
  // reservation boundary, and (when enabled) the closing edge. Tracked apart
  // from the coarse hourly fallback so the dominance rule below can suppress a
  // merely-arbitrary grid time without ever suppressing a real packing anchor.
  // A candidate can belong to both sets (e.g. an appointment that happens to end
  // on the hour); membership here always wins.
  const preciseMs = new Set<number>();

  // (1) the opening anchor + (3) a COARSE fallback grid from opening. Generated
  //     in LOCAL minutes and converted per-step via utcInstantFromLocal so DST
  //     is handled exactly like the old grid (the fallback step is hourly, so
  //     an empty day shows 10:00, 11:00, 12:00 … not 10:00/10:15/10:30/…).
  for (let m = openMin; m + duration <= closeMin; m += FALLBACK_GRANULARITY_MINUTES) {
    const ms = utcInstantFromLocal(dateStr, minutesToHHMM(m), tz).getTime();
    candidateMs.add(ms);
    // The FIRST step is the opening anchor: a genuine left-pack, not a
    // fallback artifact. Every later step is coarse.
    if (m === openMin) preciseMs.add(ms);
  }

  // (2) immediately after each existing reservation's SOURCE-AWARE protected end
  //     (appointment: actual end + current buffer; timed blocks / breaks /
  //     blockouts: raw end. See the conflicts map above). The conflict's `end`
  //     IS the earliest legal next start, so this packs a new client right after
  //     the previous one exactly as the DB buffer validator would allow.
  for (const c of conflicts) {
    candidateMs.add(c.end);
    preciseMs.add(c.end);
    // (2b) immediately BEFORE each reservation: the LATEST start whose protected
    //      interval [start, start + duration + buffer) exactly TOUCHES this
    //      reservation's start: i.e. reservation.start − duration − buffer.
    //      Symmetric to the forward anchor above (which packs right after). The
    //      window + overlap filter below drop it if it falls before open,
    //      overruns close, or collides with another reservation. This is the
    //      useful "11:30" slot that a coarse opening grid + forward-only anchors
    //      could never surface.
    candidateMs.add(c.start - durationMs - bufferMs);
    preciseMs.add(c.start - durationMs - bufferMs);
  }

  // (4) the CLOSING-EDGE right-pack anchor: the last free window's missing
  //     right-pack (see the EDGE PACKING note above). `close − duration` is
  //     precisely the maximal start the fit filter below accepts, so the trailing
  //     studio buffer is deliberately NOT subtracted: Hone fits the SERVICE end
  //     against close and lets the buffer spill past it, exactly as the
  //     authoritative DB validator does. The window and overlap filters still
  //     apply, so this is dropped on a day whose tail is already reserved or
  //     whose window is shorter than one service.
  //
  // LIMITATION, recorded deliberately: Hone models ONE open/close pair per date
  // per practitioner (studio_availability_default / _overrides each carry a
  // single open_time + close_time), so there is exactly one closing edge to pack.
  // Split availability is expressed today as a timed block inside one window,
  // which the reservation families already pack from both sides. If Hone ever
  // gains true multi-window availability, this anchor must become per-window or
  // only the final window's right edge will be packed.
  const closingAnchorMs = closeMs - durationMs;
  // Is the anchor genuinely NEW, or does the tail already pack exactly? On a
  // 09:00–17:00 day a 60-minute service already has 16:00 from the hourly walk,
  // and `close − duration` IS 16:00. There is nothing to repair. Recording this
  // BEFORE the anchor is added is what lets the dominance rule below guarantee it
  // never removes a candidate without offering a better one in its place.
  const closingAnchorIsNew = !candidateMs.has(closingAnchorMs);
  if (options?.packAgainstClosingEdge === true) {
    candidateMs.add(closingAnchorMs);
    preciseMs.add(closingAnchorMs);
  }

  // The window + overlap contract, as ONE predicate. The closing anchor has to be
  // tested for offerability before the loop (the dominance rule may only suppress
  // a candidate when something strictly better genuinely survives), and the loop
  // has to apply exactly the same rule, so both read this, and the two cannot
  // drift apart into a state where a slot is suppressed in favour of an anchor
  // that was itself filtered out.
  const isOfferable = (startMs: number): boolean => {
    // Stay inside the open window and leave room for the full service duration
    // before close (the trailing buffer may extend past close, as before).
    if (startMs < openStartMs) return false;
    if (startMs + durationMs > closeMs) return false;
    // Same half-open overlap rule as the DB exclusion: the candidate's
    // protected interval [start, end + currentBuffer) must not overlap any
    // existing protected interval. Touching is allowed.
    const protectedEndMs = startMs + durationMs + bufferMs;
    return !conflicts.some((c) => startMs < c.end && protectedEndMs > c.start);
  };

  // The dominance rule may only fire when a strictly better-packed anchor is
  // genuinely being ADDED and genuinely survives the filters.
  const dominanceActive =
    options?.packAgainstClosingEdge === true &&
    closingAnchorIsNew &&
    isOfferable(closingAnchorMs);

  // AT MOST ONE candidate may be suppressed, and it is the single grid time the
  // closing anchor REPLACES: the LATEST coarse, offerable candidate that starts
  // before the anchor and strands the tail.
  //
  // Resolving one target up front (rather than testing a predicate inside the
  // loop) is what bounds the rule to a one-for-one trade. The stranding
  // condition `close − (start + duration) < duration` is satisfied across an
  // interval (close − 2·duration, close − duration) that is `duration` wide, so
  // as soon as the service runs longer than FALLBACK_GRANULARITY_MINUTES that
  // interval spans MORE THAN ONE hourly step. A per-candidate predicate then
  // removed several slots to add one: a 91-minute service on a 09:00–17:00 day
  // dropped both 14:00 and 15:00 for a single 15:29 anchor, taking the offered
  // count from 7 to 6. Only the last of those is the one the anchor stands in
  // for; the earlier ones are ordinary "book earlier in the day" choices.
  let suppressedMs: number | null = null;
  if (dominanceActive) {
    for (const ms of candidateMs) {
      if (ms >= closingAnchorMs) continue;
      if (preciseMs.has(ms)) continue;
      if (closeMs - (ms + durationMs) >= durationMs) continue;
      if (!isOfferable(ms)) continue;
      if (suppressedMs === null || ms > suppressedMs) suppressedMs = ms;
    }
  }

  const slots: Slot[] = [];
  for (const slotStartMs of [...candidateMs].sort((a, b) => a - b)) {
    if (!isOfferable(slotStartMs)) continue;

    // GAP MINIMISATION: drop the ONE coarse grid time the closing anchor
    // replaces (resolved above as `suppressedMs`). The conditions that selected
    // it were:
    //
    //   (a) `dominanceActive`, packing is on, the closing anchor is genuinely
    //       NEW, and it survived the filters, so a strictly better-packed slot
    //       is really on offer and the list can never become empty.
    //   (b) the candidate is COARSE, never a precise anchor. The opening anchor,
    //       the slot immediately after a real appointment, and the backward-packed
    //       slot before one are each a packing decision in their own right. The
    //       16:00 that follows a 15:00–16:00 appointment means "finish at 16:45
    //       and go home"; that is a legitimate choice, not a grid artifact.
    //   (c) it starts strictly BEFORE the anchor, so the anchor itself, and any
    //       candidate coinciding with it, is never suppressed.
    //   (d) it STRANDS THE TAIL: the treatment window left after its service end
    //       is shorter than one more service (`close − (start + duration) <
    //       duration`), so nothing of this length can follow it before close.
    //
    // (d) is measured on the SERVICE end, not the buffered end: the same edge
    // Hone fits against close everywhere else. An earlier revision folded the
    // buffer into this test and it suppressed far too much: with a 60-minute
    // service and a 30-minute buffer it removed 15:00 while adding nothing,
    // because the buffer made a candidate two hours from close look terminal.
    // The residual that matters is treatment time, so the buffer has no part in
    // it. That is also why a 30-minute service keeps 16:00 AND gains 16:30
    // (residual 30 is not short), while a 45-minute service trades 16:00 for
    // 16:15 (residual 15 is).
    //
    // "One more service" uses THIS request's duration. Hone has no authoritative
    // shortest-bookable-duration concept, and inventing one would mean a new
    // service query on a hot path to support an unproven heuristic.
    if (dominanceActive && slotStartMs === suppressedMs) continue;

    const slotStart = new Date(slotStartMs);
    slots.push({
      start: slotStart.toISOString(),
      end: new Date(slotStartMs + durationMs).toISOString(),
      startLabel: localTimeString12h(slotStart, tz),
    });
  }

  return slots;
}
