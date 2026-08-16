import {
  localDateString,
  localMinutesSinceMidnight,
  localTimeString,
  utcInstantFromLocal,
} from "../tz";

// THE PURE AVAILABILITY SEMANTICS for authenticated internal booking.
//
// Everything here is a total function of its arguments: no Supabase, no
// network, no React. The server-side resolver that READS a window lands with
// the surface migration; this module is only the meaning of the answer.
//
// THE DISTINCTION THIS EXISTS TO KEEP
//   SUGGESTED      a packed anchor from the smart-scheduling set -- advisory.
//   AVAILABLE      inside the practitioner's real working-hours window.
//   OUTSIDE HOURS  genuinely outside it: owner-only, acknowledged, audited.
//   UNKNOWN        the window could not be read. NOT a fact about the day.
//
// Collapsing any pair of those is the defect class this model exists to end.

export type AvailabilityWindow =
  | { kind: "open"; openTime: string; closeTime: string } // "HH:MM"
  // The practitioner genuinely does not work then. This is KNOWLEDGE.
  | { kind: "closed" }
  // The configuration could not be READ. This is the ABSENCE of knowledge, and
  // it is not the same fact as "closed": treating it as closed lets a transient
  // failure be reported as an out-of-hours condition, which an owner can then
  // acknowledge, persisting an exception that was never true.
  | { kind: "unknown" };

export type RequestedTimeVerdict =
  | "inside_availability"
  | "outside_availability"
  | "practitioner_closed"
  | "availability_unknown";

/** Both endpoints projected into studio-local time from their UTC instants. */
export type LocalInterval = {
  startDate: string;
  startMinutes: number;
  endDate: string;
  endMinutes: number;
};

// Mirrors what the database validator does: it computes the end by adding the
// duration to the UTC INSTANT and only then converts to local. Adding minutes
// to the local wall clock is NOT the same thing -- on a DST-transition day the
// two disagree by an hour, in both directions, which makes the client precheck
// contradict the validator it claims to mirror.
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

// The window is measured on the SERVICE end, never a buffered end: the trailing
// studio buffer is allowed to spill past closing time. An appointment may not
// run into the next local date, and an end at exactly local midnight lands on
// the next date here just as it does in Postgres.
export function classifyAgainstWindow(
  window: AvailabilityWindow,
  interval: LocalInterval,
): RequestedTimeVerdict {
  // UNKNOWN is checked FIRST and never collapses into a factual verdict.
  if (window.kind === "unknown") return "availability_unknown";
  if (window.kind === "closed") return "practitioner_closed";
  const open = localMinutesSinceMidnight(window.openTime);
  const close = localMinutesSinceMidnight(window.closeTime);
  if (interval.endDate !== interval.startDate) return "outside_availability";
  if (interval.startMinutes < open || interval.endMinutes > close) {
    return "outside_availability";
  }
  return "inside_availability";
}

// A CUSTOM DURATION IS A SEMANTIC DIFFERENCE, NOT A POPULATED FIELD. A dragged
// length edited back to the service's own default is an ordinary appointment;
// treating the field's presence as "custom" told practitioners a standard
// booking needed an exception.
export function normalizeDurationOverride(
  chosenMinutes: number | null,
  serviceDefaultMinutes: number | null,
): number | null {
  if (chosenMinutes == null) return null;
  if (serviceDefaultMinutes != null && chosenMinutes === serviceDefaultMinutes) {
    return null;
  }
  return chosenMinutes;
}

// WHY an exception is required -- which is not the same question as WHETHER one
// is required. A caller-supplied length needs the shared database flag even
// when the time is squarely inside working hours, and describing that as
// "outside your normal availability" asks the practitioner to affirm something
// false about their own schedule.
export type OverrideReason =
  | "practitioner_closed"
  | "outside_availability"
  | "custom_duration";

export type ManualTimeDecision = {
  timeValid: boolean;
  // An UNREADABLE or unloaded window is no more "known" than no window at all.
  // Failing closed says "do not treat this as ordinary"; it does NOT say "this
  // is outside availability", and only the second is a claim the database
  // persists forever.
  windowKnown: boolean;
  verdict: RequestedTimeVerdict | null;
  requiresOutsideOverride: boolean;
  overrideReason: OverrideReason | null;
};

const MANUAL_TIME_RE = /^\d{2}:\d{2}$/;
const LOCAL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function decideManualTime(input: {
  window: AvailabilityWindow | null;
  localDate: string;
  localTime: string;
  timezone: string;
  /** The AUTHORITATIVE service length -- never a client-held snapshot. */
  serviceDurationMinutes: number | null;
  customDurationMinutes: number | null;
}): ManualTimeDecision {
  const timeValid = MANUAL_TIME_RE.test(input.localTime);
  // Normalised HERE as well as at any call site, so the answer is right for
  // every caller rather than only the ones that remembered.
  const customDurationMinutes = normalizeDurationOverride(
    input.customDurationMinutes,
    input.serviceDurationMinutes,
  );
  const duration = customDurationMinutes ?? input.serviceDurationMinutes;
  const resolvable =
    timeValid &&
    input.window !== null &&
    duration != null &&
    LOCAL_DATE_RE.test(input.localDate);
  // Built through the SAME helper the surfaces use to compute the instant they
  // submit, so the time being classified is the time that will be booked.
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
    customDurationMinutes != null || verdict !== "inside_availability";
  // A genuinely out-of-hours time is reported as such even when a custom length
  // also applies: that is the more serious fact and the one the
  // acknowledgement is really about. `availability_unknown` yields NO reason --
  // there is nothing truthful to say.
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
    windowKnown: input.window !== null && input.window.kind !== "unknown",
    verdict,
    requiresOutsideOverride,
    overrideReason,
  };
}

// A selected suggestion belongs to the date it was offered for. The instant
// alone does not say so, which is how a slot picked on the previous date stayed
// submittable while the form displayed a new one.
export function selectedSlotMatchesDate(input: {
  startsAtIso: string | null;
  formDate: string;
  timezone: string;
}): boolean {
  if (!input.startsAtIso) return false;
  const d = new Date(input.startsAtIso);
  if (Number.isNaN(d.getTime())) return false;
  return localDateString(d, input.timezone) === input.formDate;
}
