import type { SupabaseClient } from "@supabase/supabase-js";
import {
  dayOfWeekFromLocalDate,
  localDateString,
  localMinutesSinceMidnight,
  localTimeString,
  utcInstantFromLocal,
} from "./tz";
import {
  getStudioWideDaySafe,
  getStudioWideOverrideDaySafe,
} from "./studio-wide-availability";

// THE ONE availability-window authority for authenticated internal surfaces.
//
// WHY THIS FILE EXISTS
// --------------------
// Hone had exactly two notions of "can this time be booked", and they were
// conflated into one:
//
//   SMART SUGGESTION  a packed anchor set (opening edge, each reservation
//                     boundary, an hourly fallback, the closing edge). It is a
//                     deliberately SMALL, efficient subset of the legal times.
//   AVAILABILITY      the practitioner's actual working-hours window.
//
// `getAvailableSlots` produces the first. Nothing produced the second, so the
// internal booking action asked the only question it could: "is the requested
// instant an exact member of the suggestion set?" A practitioner who wanted
// 15:30 on a 09:00-17:00 day with a 15:10 suggestion was therefore told the time
// was unavailable, and the only route to it was a control whose machine meaning
// is `allow_outside_availability` -- a flag that is persisted on the appointment
// row (`booked_outside_availability`), stamped into the audit record, attributed
// to an authorising owner, and which disables the buffer trigger for that row
// forever. An ordinary working time was being recorded as an out-of-hours
// exception.
//
// This module answers the SECOND question on its own, so "not one of the
// suggestions" can stop being reported as an availability violation.
//
// WHY THE WINDOW RESOLUTION LIVES HERE AND NOT IN slots.ts
// --------------------------------------------------------
// `getAvailableSlots` resolved the window inline. Re-deriving it anywhere else
// would create a second, subtly different booking calendar -- precisely the
// failure mode Hone has already paid for elsewhere. So the resolution moved
// here and `getAvailableSlots` now calls it: there is ONE precedence
// implementation, and the slot engine and the manual-time check cannot drift.
//
// The precedence below is the same one `validate_appointment_availability`
// implements in SQL for capacity-ON studios (migration 0152, the
// `order by (practitioner_id is not null) desc limit 1` pair):
//
//   capacity ON   practitioner-specific override -> studio-wide override
//                 -> practitioner-specific default -> studio-wide default
//   capacity OFF  studio-wide override -> studio-wide default
//
// The OFF path uses the migration-order-safe studio-wide loaders so a
// rolled-back studio's RETAINED practitioner rows are ignored rather than
// making a single-row read throw.

export type AvailabilityStudio = {
  id: string;
  timezone: string;
  // Migration 0134. Per-practitioner windows require BOTH the studio flag and
  // an explicit practitionerId; absent/false is studio-wide, exactly as the
  // slot engine treats it.
  practitioner_capacity_enabled?: boolean;
};

// The resolved open/close window for one (studio, practitioner, date).
//
// Full-day blockouts are NOT folded in here. They are read by
// `readFullDayBlockout` below so that each caller states its own policy for a
// FAILED blockout read at the call site, in the open:
//
//   * slot generation has always continued as though there were no blockout
//     (the error was discarded). That behaviour reaches the PUBLIC booking and
//     reschedule pages, so it is preserved byte-for-byte rather than quietly
//     hardened as a side effect of this refactor.
//   * the manual-time check is new and fails CLOSED: an unreadable blockout
//     table must never be read as "no time off", because that would book a
//     client onto a day the practitioner deliberately took off.
//
// Folding both into one function would have silently given the public pages the
// stricter policy. Two functions make the difference impossible to miss.
export type AvailabilityWindow =
  | { kind: "open"; openTime: string; closeTime: string } // "HH:MM"
  | { kind: "closed" };

export type FullDayBlockoutRead = {
  // A blockout row covers this date.
  blocked: boolean;
  // The read itself failed. `blocked` is then meaningless; the caller decides.
  readFailed: boolean;
};

export async function readFullDayBlockout(
  supabase: SupabaseClient,
  studioId: string,
  dateStr: string,
): Promise<FullDayBlockoutRead> {
  const { data, error } = await supabase
    .from("studio_blockouts")
    .select("starts_on, ends_on")
    .eq("studio_id", studioId)
    .lte("starts_on", dateStr)
    .gte("ends_on", dateStr);
  if (error) return { blocked: false, readFailed: true };
  return { blocked: (data ?? []).length > 0, readFailed: false };
}

type WindowRow = {
  is_open: boolean;
  open_time: string | null;
  close_time: string | null;
};

// Strips seconds from a "HH:MM:SS" coming back from a postgres time column.
function trimTime(t: string | null): string | null {
  if (!t) return null;
  return t.slice(0, 5);
}

function toWindow(row: WindowRow | null): AvailabilityWindow {
  if (!row) return { kind: "closed" };
  const openTime = trimTime(row.open_time);
  const closeTime = trimTime(row.close_time);
  if (!row.is_open || !openTime || !closeTime) return { kind: "closed" };
  return { kind: "open", openTime, closeTime };
}

export async function resolveAvailabilityWindow(
  supabase: SupabaseClient,
  studio: AvailabilityStudio,
  dateStr: string,
  practitionerId?: string | null,
): Promise<AvailabilityWindow> {
  // Derived from the CALENDAR DATE, not from an instant.
  //
  // This used to be localDayOfWeek(new Date(`${dateStr}T12:00:00Z`), tz), taken
  // verbatim from the slot engine so the two could not disagree. They agreed --
  // and both were wrong in UTC+13/UTC+14, where noon UTC on a Monday is already
  // Tuesday locally, so a Monday booking was measured against Tuesday's hours.
  //
  // Harmless while it only shifted which suggestions appeared. Not harmless
  // once this resolution became the authority for manual-time booking: 0152
  // fences the database's working-hours block behind `if v_cap then`, so a
  // capacity-OFF studio has no second opinion and would accept a Monday time
  // that only fits Tuesday's schedule. The slot engine now calls this same
  // function, so both are corrected together and there is still one calendar.
  const dow = dayOfWeekFromLocalDate(dateStr);

  const capacityOn =
    studio.practitioner_capacity_enabled === true &&
    practitionerId !== undefined &&
    practitionerId !== null;

  if (!capacityOn) {
    // OFF: studio-wide only, via the migration-order-safe loaders. Nothing here
    // references the 0134/0135 columns, so this is byte-for-byte the flag-off
    // behaviour the slot engine has always had.
    const override = await getStudioWideOverrideDaySafe(supabase, studio.id, dateStr);
    if (override) return toWindow(override as WindowRow);
    const def = await getStudioWideDaySafe(supabase, studio.id, dow);
    return toWindow(def as WindowRow | null);
  }

  // ON: practitioner-specific row wins over the studio-wide fallback, overrides
  // win over defaults. Two maybeSingle probes per level keep each read unique.
  const pOverride = (
    await supabase
      .from("studio_availability_overrides")
      .select("is_open, open_time, close_time")
      .eq("studio_id", studio.id)
      .eq("effective_date", dateStr)
      .eq("practitioner_id", practitionerId)
      .maybeSingle()
  ).data as WindowRow | null;
  if (pOverride) return toWindow(pOverride);

  const sOverride = (
    await supabase
      .from("studio_availability_overrides")
      .select("is_open, open_time, close_time")
      .eq("studio_id", studio.id)
      .eq("effective_date", dateStr)
      .is("practitioner_id", null)
      .maybeSingle()
  ).data as WindowRow | null;
  if (sOverride) return toWindow(sOverride);

  const pDefault = (
    await supabase
      .from("studio_availability_default")
      .select("is_open, open_time, close_time")
      .eq("studio_id", studio.id)
      .eq("day_of_week", dow)
      .eq("practitioner_id", practitionerId)
      .maybeSingle()
  ).data as WindowRow | null;
  if (pDefault) return toWindow(pDefault);

  const sDefault = (
    await supabase
      .from("studio_availability_default")
      .select("is_open, open_time, close_time")
      .eq("studio_id", studio.id)
      .eq("day_of_week", dow)
      .is("practitioner_id", null)
      .maybeSingle()
  ).data as WindowRow | null;
  return toWindow(sDefault);
}

// What a requested time IS, relative to actual availability. Deliberately NOT a
// boolean: "closed that day" and "outside the hours you work that day" are
// different facts and the practitioner is told which one applies.
export type RequestedTimeVerdict =
  | "inside_availability"
  | "outside_availability"
  | "practitioner_closed";

// PURE. Mirrors `validate_appointment_availability` (migration 0152) exactly:
//
//   if v_end_date <> v_local_date then return 'outside_availability'; end if;
//   if v_start_time < v_open or v_end_time > v_close then
//     return 'outside_availability';
//   end if;
//
// Three properties of that rule are load-bearing and are reproduced literally:
//
//   1. The window is checked on the SERVICE end, never the buffered end. The
//      trailing studio buffer is allowed to spill past closing time. The slot
//      engine's own fit filter agrees (`start + duration > close`), and
//      migration 0170 states the rule outright. Subtracting the buffer here
//      would refuse the last appointment of every day that Hone already offers.
//   2. Both endpoints are LOCAL PROJECTIONS OF UTC INSTANTS, because that is
//      what the SQL does: it computes `p_ends_at` by adding the duration to the
//      UTC instant and only then converts it with `at time zone v_tz`.
//
//      An earlier version of this comment claimed the SQL compared local
//      wall-clock time and added the duration in that domain. That is true of
//      the START and false of the END, and the difference is exactly one hour
//      on a DST-transition day -- which is how the precheck came to disagree
//      with the validator it claims to mirror. See localInterval below.
//   3. An appointment may not cross local midnight into the next date. The SQL
//      refuses it before it ever compares against close, so a 23:30 booking
//      cannot pass by arithmetic that wraps.
//
// The interval as the DATABASE sees it: both endpoints projected into studio
// local time from their UTC instants.
export type LocalInterval = {
  startDate: string; // "YYYY-MM-DD"
  startMinutes: number;
  endDate: string; // "YYYY-MM-DD"
  endMinutes: number;
};
// Project (start instant, duration) into studio-local endpoints the SAME way
// migration 0152 does:
//
//   v_ends_at    := p_starts_at + duration        -- UTC INSTANT arithmetic
//   v_local_end  := p_ends_at at time zone v_tz   -- then converted to local
//
// This is not the same as adding the duration to the local wall clock, and on a
// DST-transition day the two disagree by an hour. A 60-minute appointment
// starting 01:30 the morning of spring-forward really ends at 03:30 local, not
// 02:30; fall-back has the inverse discrepancy. Adding minutes to wall-clock
// time made the app precheck disagree with the validator, in both directions:
// it could accept a booking the database then refuses, and -- worse -- refuse a
// booking the database would have accepted, demanding the persistent
// outside-availability override for an ordinary appointment. Deriving both
// endpoints from instants removes the disagreement by construction.
export function localInterval(
  startsAt: Date,
  durationMinutes: number,
  timezone: string,
): LocalInterval {
  const endsAt = new Date(startsAt.getTime() + durationMinutes * 60_000);
  return {
    startDate: localDateString(startsAt, timezone),
    startMinutes: localMinutesSinceMidnight(localTimeString(startsAt, timezone)),
    endDate: localDateString(endsAt, timezone),
    endMinutes: localMinutesSinceMidnight(localTimeString(endsAt, timezone)),
  };
}

export function classifyAgainstWindow(
  window: AvailabilityWindow,
  interval: LocalInterval,
): RequestedTimeVerdict {
  if (window.kind === "closed") return "practitioner_closed";
  const open = localMinutesSinceMidnight(window.openTime);
  const close = localMinutesSinceMidnight(window.closeTime);
  // An appointment may not run into the next local date. The SQL refuses this
  // before it ever compares against close, so a 23:30 booking cannot pass by
  // arithmetic that wraps -- and an end at exactly local midnight lands on the
  // next date here just as `v_local_end::date` does in Postgres.
  if (interval.endDate !== interval.startDate) return "outside_availability";
  if (interval.startMinutes < open || interval.endMinutes > close) {
    return "outside_availability";
  }
  return "inside_availability";
}

// THE MANUAL-TIME DECISION, shared by both authenticated booking surfaces.
//
// PURE, and deliberately not a boolean pair scattered across two components.
// The calendar Quick Book drawer and the client-profile Book form previously
// each carried their own version of "is this an override?", which is how they
// drifted into different laws (the client page hid manual time behind isOwner;
// the drawer did not). One function means one law.
//
// It answers three questions the UI needs:
//   verdict                 what the typed time IS, or null when it cannot yet
//                           be determined (no time typed, window not loaded).
//   requiresOutsideOverride whether this booking must travel the owner-only
//                           outside-hours path, which is also exactly when
//                           allow_outside_availability may be posted.
//   windowKnown             whether the availability window actually loaded.
//
// FAILS CLOSED in both directions:
//   * a null verdict (unknown window, unparseable time) requires the override
//     rather than waving the booking through;
//   * `timeValid` is returned so a caller can block submit on an unparseable
//     time WITHOUT relying on requiresOutsideOverride to do that job.
//
// WHY `windowKnown` IS SEPARATE FROM `requiresOutsideOverride`.
// Failing closed says "do not treat this as an ordinary booking". It does NOT
// say "this time is outside availability" -- and the two are not
// interchangeable, because the second one is an ASSERTION ABOUT THE WORLD that
// the database persists forever (booked_outside_availability, an
// outside_availability audit entry, an authorising owner, and the buffer
// trigger disabled for that row).
//
// An unloaded window is not evidence of anything. If a caller renders the
// outside-hours warning and posts allow_outside_availability off the back of a
// window that never arrived -- an in-flight refetch after a date or
// practitioner change, or a failed slot load -- then a time squarely inside
// working hours is filed as an out-of-hours exception. That is exactly the
// defect this module exists to remove, re-entering through the one state where
// nothing is known.
//
// So callers must gate the manual path on `windowKnown`: you may not assert a
// time is outside availability unless you know the availability. It is exposed
// here, once, rather than left as an `availabilityWindow === null` check
// duplicated in each surface, because two copies of this rule is how the two
// booking surfaces drifted apart in the first place.
//
// A CUSTOM LENGTH always requires the override. That is not a UI preference: a
// caller-supplied duration is owner-only inside create_internal_appointment_v2
// (a non-owner passing p_duration_override_minutes gets 'not_authorized'), and
// the server action couples it to this flag. Changing that coupling would need
// a migration, so it is deliberately untouched here.
//
// BUT THE REASON IS NOT THE SAME AS THE VERDICT, and the UI must not conflate
// them. A dragged 45-minute appointment at 10:00 on a 09:00-17:00 day is
// FACTUALLY INSIDE the practitioner's working hours; it needs the shared
// database flag only because that flag is also what authorises a custom length.
// Telling the practitioner "this is outside your normal availability" and
// asking them to affirm it is a false statement about their own schedule --
// the same class of lie this module exists to remove. `overrideReason` carries
// the factual reason so each surface can say the true thing.
export type OverrideReason =
  // The practitioner does not work that day at all.
  | "practitioner_closed"
  // The time genuinely falls outside the day's working-hours window.
  | "outside_availability"
  // The time is INSIDE working hours; only the custom length needs an exception.
  | "custom_duration";

export type ManualTimeDecision = {
  timeValid: boolean;
  windowKnown: boolean;
  verdict: RequestedTimeVerdict | null;
  requiresOutsideOverride: boolean;
  // Why the override is required, or null when it is not (or cannot yet be
  // determined). Never infer this from `requiresOutsideOverride` alone.
  overrideReason: OverrideReason | null;
};

const MANUAL_TIME_RE = /^\d{2}:\d{2}$/;
const LOCAL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function decideManualTime(input: {
  // The server-resolved window for the loaded (studio, target, date). null when
  // it has not loaded or the load failed.
  window: AvailabilityWindow | null;
  // The studio-local date the manual time belongs to, "YYYY-MM-DD".
  localDate: string;
  // Studio-local "HH:MM" as typed.
  localTime: string;
  // Studio IANA timezone. Required because the END of the appointment is
  // derived from the UTC instant, exactly as the database derives it.
  timezone: string;
  // The selected service's authoritative default length.
  serviceDurationMinutes: number | null;
  // A drag-derived custom length, already parsed/validated, else null.
  customDurationMinutes: number | null;
}): ManualTimeDecision {
  const timeValid = MANUAL_TIME_RE.test(input.localTime);
  const duration = input.customDurationMinutes ?? input.serviceDurationMinutes;
  const resolvable =
    timeValid &&
    input.window !== null &&
    duration != null &&
    LOCAL_DATE_RE.test(input.localDate);
  // Built through utcInstantFromLocal -- the SAME helper both surfaces use to
  // compute the `starts_at` they submit -- so the time being classified is the
  // instant that will actually be booked, DST conventions included.
  const verdict = resolvable
    ? classifyAgainstWindow(
        input.window!,
        localInterval(
          utcInstantFromLocal(input.localDate, input.localTime, input.timezone),
          duration!,
          input.timezone,
        ),
      )
    : null;
  const requiresOutsideOverride =
    input.customDurationMinutes != null || verdict !== "inside_availability";
  // Precedence: a genuinely out-of-hours time is reported as such even when a
  // custom length is also in play, because that is the more serious fact and
  // the one the acknowledgement is really about. "custom_duration" is reserved
  // for a time that is otherwise perfectly ordinary.
  const overrideReason: OverrideReason | null = !requiresOutsideOverride
    ? null
    : verdict === "practitioner_closed"
      ? "practitioner_closed"
      : verdict === "outside_availability"
        ? "outside_availability"
        : verdict === "inside_availability"
          ? "custom_duration"
          : null;
  return {
    timeValid,
    windowKnown: input.window !== null,
    verdict,
    requiresOutsideOverride,
    overrideReason,
  };
}

// Server-side convenience: resolve the window for the studio-local date the
// instant falls on, then classify. This is the form the internal booking action
// uses, and it is the ONLY authority for working hours when practitioner
// capacity is OFF -- migration 0152 fences every hours check behind
// `if v_cap then`, so a capacity-OFF database accepts any instant the
// application hands it. That is not a reason to trust the browser: this runs on
// the server, from the server-resolved studio + target, and the browser's own
// verdict is used solely to decide which copy to render.
export async function classifyRequestedTime(
  supabase: SupabaseClient,
  studio: AvailabilityStudio,
  startsAt: Date,
  durationMinutes: number,
  practitionerId?: string | null,
): Promise<RequestedTimeVerdict> {
  const dateStr = localDateString(startsAt, studio.timezone);
  // FAIL CLOSED on an unreadable blockout table. See the note on
  // FullDayBlockoutRead: this path is the only working-hours authority a
  // capacity-OFF studio has, so "we could not tell" must resolve to "no".
  const blockout = await readFullDayBlockout(supabase, studio.id, dateStr);
  if (blockout.blocked || blockout.readFailed) return "practitioner_closed";
  const window = await resolveAvailabilityWindow(
    supabase,
    studio,
    dateStr,
    practitionerId,
  );
  // Both endpoints projected from instants, matching the validator. See
  // localInterval for why wall-clock addition was wrong across DST.
  return classifyAgainstWindow(
    window,
    localInterval(startsAt, durationMinutes, studio.timezone),
  );
}
