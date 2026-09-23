import "server-only";
import type { Service, Studio, StudioAvailabilityDefault } from "@/lib/types/database";
import { isBookableByNewClient } from "@/lib/booking/consultation";
import { createClient } from "@/lib/supabase/server";
import { getStudioWideDefaultsSafe } from "@/lib/booking/studio-wide-availability";
import { isValidTimeZone } from "@/lib/studios/new-studio";
import { isNewClientWaitlistEnabled } from "@/lib/booking/new-client-waitlist";
import {
  CONSENT_SETTINGS_HREF,
  getTreatmentConsentReadiness,
  type TreatmentConsentReadiness,
} from "@/lib/consent/launch-readiness";
import { getActiveServices } from "@/lib/booking/queries";

// ===========================================================================
// ONB-02 — CANONICAL NEW-CLIENT BOOKING READINESS
// ===========================================================================
//
// ONE authoritative answer to: "can this studio genuinely accept a NEW client
// right now?"
//
// THE GAP THIS CLOSES. Five partial authorities already answer neighbouring
// questions, and two of them disagree about this one:
//
//   * `isPubliclyBookable` gates the public booking PAGE on "at least one
//     active service". `publicBookAppointmentAction` gates a NEW client's
//     booking on `isBookableByNewClient` — active, this studio's, AND a
//     consultation. A studio whose only active services are ordinary
//     treatments therefore renders a page that looks bookable and refuses the
//     booking. The page is not wrong to be vague in public (it must not
//     disclose which piece is missing), but the OWNER-facing answer has to be
//     the action's rule, not the page's.
//
//   * `computeBookingReadiness` answers "may this studio publish a booking
//     link" over six structural items. It does not ask for a consultation
//     specifically, and it has no consent input at all.
//
// This module does not replace either. It COMPOSES the existing authorities
// and adds none of its own:
//
//   services            -> getActiveServices + isBookableByNewClient
//                          (the SAME predicate the booking action enforces)
//   availability        -> getStudioWideDefaultsSafe (practitioner_id IS NULL,
//                          the same scope public booking reads)
//   booking link/route  -> studios.slug (what getStudioBySlug resolves on)
//   booking settings    -> the studio columns the slot generator requires
//   treatment consent   -> getTreatmentConsentReadiness (already three-state)
//
// DELIBERATELY NOT COMPOSED. `practitioner_capacity_booking_enabled`
// (migration 0136) reads like a booking kill-switch and is not one: it selects
// the practitioner-ASSIGNMENT mode inside the SQL booking commands, it is
// false on every studio, and production takes real bookings with it false.
// Treating it as a gate would report every studio NOT_READY.
//
// THREE STATES, AND THE ASYMMETRY BETWEEN THEM.
//
//   READY      every authority answered, and every requirement satisfied.
//   NOT_READY  at least one requirement is PROVEN unsatisfied.
//   UNKNOWN    no proven blocker, but some authority could not answer.
//
// UNKNOWN NEVER COLLAPSES TO NOT_READY. A failed consent read reported as
// "not ready" tells an owner to build a form they already have; reported as
// "ready" it green-lights a launch on no evidence. This is the same rule
// `getTreatmentConsentReadiness` and `getCardAuthorizationCapability` already
// apply, and it is why `getActiveServices` / `getStudioWideDefaultsSafe` are
// caught here rather than allowed to throw: an exception would take out the
// whole surface, and a swallowed one would become a confident "0 services".
//
// READY REQUIRES COMPLETE EVIDENCE — it is the one state that may never be
// returned while any authority is unavailable. NOT_READY only requires ONE
// proven blocker, so it stays available even when another authority is down;
// `unavailable` is carried on it so no caller can mistake a partial blocker
// list for an exhaustive one.
// ===========================================================================

/** An authority that can fail to answer. `studio` is not one: it is a row the caller already holds. */
export type ReadinessAuthority = "services" | "availability" | "treatment_consent";

export type NewClientBlockerKey =
  | "studio_name"
  | "booking_link"
  | "booking_settings"
  | "consultation_service"
  | "availability"
  | "treatment_consent"
  | "bookable_window"
  | "wait_admission";

export type NewClientBlocker = {
  key: NewClientBlockerKey;
  /** A factual statement of what is missing. Never a diagnosis of why. */
  label: string;
  href: string;
};

export type NewClientReadiness =
  | { status: "ready" }
  | {
      status: "not_ready";
      blockers: NewClientBlocker[];
      /** Present only when a blocker is proven; never derived from an absent authority. */
      nextStep: NewClientBlocker | null;
      /** Non-empty means `blockers` is NOT exhaustive. */
      unavailable: ReadinessAuthority[];
    }
  | { status: "unknown"; unavailable: ReadinessAuthority[] };

/**
 * Fixed order. The next actionable step is the first PROVEN blocker in it, so
 * the same studio is always sent to the same place; it is not a priority
 * judgement and it is never reordered per studio.
 */
const BLOCKER_ORDER: NewClientBlockerKey[] = [
  "studio_name",
  "booking_link",
  "consultation_service",
  "availability",
  "bookable_window",
  "booking_settings",
  "treatment_consent",
  // LAST ON PURPOSE. It is not a setup step a studio can "fix" by filling
  // something in -- it is a deliberate admission choice. Ordering it above the
  // structural blockers would send an operator to the waitlist screen when what
  // they actually still need is a consultation service.
  "wait_admission",
];

const BLOCKERS: Record<NewClientBlockerKey, Omit<NewClientBlocker, "key">> = {
  studio_name: { label: "Studio name is not set.", href: "/settings/studio" },
  // A FACT, NOT A DIAGNOSIS -- the rule every other label follows. It states
  // what is true of admission today; it does not call the studio
  // misconfigured, because it is not.
  wait_admission: {
    label: "New clients join the waitlist instead of booking directly.",
    href: "/settings/waitlist",
  },
  booking_link: { label: "Booking link is not set.", href: "/settings/booking" },
  booking_settings: {
    label: "Booking settings are incomplete.",
    href: "/settings/booking",
  },
  consultation_service: {
    label: "No active consultation service a new client can book.",
    href: "/settings/services",
  },
  availability: {
    label: "No open day in the weekly availability.",
    href: "/settings/availability",
  },
  bookable_window: {
    label: "No open window long enough to fit a consultation.",
    href: "/settings/availability",
  },
  treatment_consent: {
    label: "No live treatment consent form.",
    href: CONSENT_SETTINGS_HREF,
  },
};

/**
 * EVERY key the authority owns, exhaustive BY CONSTRUCTION.
 *
 * Derived from `BLOCKERS`, which is a `Record<NewClientBlockerKey, …>` — so
 * TypeScript already refuses to compile a new key that is not given an entry.
 * Reading the list from there means a key cannot be added to the union and
 * then quietly go unrendered by a consumer, which is exactly how the
 * booking_settings blocker reached an owner as "nothing left to do".
 *
 * A hand-written array would not do this: it is just `NewClientBlockerKey[]`,
 * and omitting a member of a union from an array is not a type error.
 */
export const NEW_CLIENT_BLOCKER_KEYS = Object.keys(
  BLOCKERS,
) as NewClientBlockerKey[];

/** What the caller loaded. Each fallible authority carries its own availability. */
export type NewClientReadinessEvidence = {
  studio: Pick<
    Studio,
    | "name"
    | "slug"
    | "timezone"
    | "default_appointment_duration_minutes"
    | "buffer_minutes"
    | "public_booking_horizon_months"
  >;
  services: { ok: true; services: Service[] } | { ok: false };
  availability:
    | { ok: true; days: Pick<StudioAvailabilityDefault, "is_open" | "open_time" | "close_time">[] }
    | { ok: false };
  treatmentConsent: TreatmentConsentReadiness;
};

function nonEmpty(s: string | null | undefined): boolean {
  return typeof s === "string" && s.trim().length > 0;
}

/**
 * The one open-day predicate.
 *
 * `open_time` / `close_time` are Postgres `time` columns, so a present value is
 * always "HH:MM:SS" and never "". `nonEmpty` and a bare `typeof === "string"`
 * therefore agree on every row the database can produce; `nonEmpty` is used
 * because it stays correct if the column ever widens to text.
 */
export function isOpenDay(
  d: Pick<StudioAvailabilityDefault, "is_open" | "open_time" | "close_time">,
): boolean {
  return d.is_open === true && nonEmpty(d.open_time) && nonEmpty(d.close_time);
}

/**
 * Minutes from midnight for a Postgres `time` value ("HH:MM" or "HH:MM:SS").
 * Returns null for anything it cannot read, so an unparseable window is never
 * silently treated as a long one.
 */
function minutesOfDay(t: string | null | undefined): number | null {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec((t ?? "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * Can this open window hold a service of `duration` minutes?
 *
 * THE PUBLIC SLOT ENGINE'S OWN BOUNDARY, not a second opinion. lib/booking/slots.ts
 * filters a candidate on the SERVICE end against closing time -- `start + duration
 * > close` is refused -- and deliberately lets the trailing studio buffer spill
 * past closing. `validate_appointment_availability` agrees in SQL: it tests
 * `v_end_time > v_close`. So the buffer is NOT subtracted here; doing so would
 * refuse windows the booking path accepts, which is the same drift in the other
 * direction.
 *
 * The earliest candidate a day can offer starts at `open`, so a window can hold
 * the service exactly when `close - open >= duration`.
 */
export function windowFitsDuration(
  d: Pick<StudioAvailabilityDefault, "is_open" | "open_time" | "close_time">,
  durationMinutes: number,
): boolean {
  if (!isOpenDay(d)) return false;
  if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) return false;
  const open = minutesOfDay(d.open_time);
  const close = minutesOfDay(d.close_time);
  if (open == null || close == null) return false;
  return close - open >= durationMinutes;
}

/** Pure. No I/O, so every state below is reachable in a unit test. */
export function computeNewClientReadiness(
  evidence: NewClientReadinessEvidence,
): NewClientReadiness {
  const { studio, services, availability, treatmentConsent } = evidence;

  const unavailable: ReadinessAuthority[] = [];
  if (!services.ok) unavailable.push("services");
  if (!availability.ok) unavailable.push("availability");
  if (!treatmentConsent.ok) unavailable.push("treatment_consent");

  // Only PROVEN failures become blockers. An authority that did not answer
  // contributes nothing here — that is the whole no-collapse rule.
  const proven: NewClientBlockerKey[] = [];

  // WAIT ADMISSION IS PART OF THE QUESTION, NOT A SEPARATE ONE.
  //
  // This module answers "can this studio accept a new client RIGHT NOW?". A
  // studio running WAIT has ordinary new-client admission deliberately PAUSED:
  // the public surface routes a new client to the queue instead of to a booking.
  // Every structural prerequisite below can pass while that is true, so without
  // this the canonical answer is READY for a studio that will not, in fact, take
  // a new client directly.
  //
  // This states the ADMISSION boundary, not a capability failure, and it does
  // not weaken the booking action: the gate is the same
  // `isNewClientWaitlistEnabled` the public route already consults, read from
  // the server-resolved slug. Nothing here decides whether WAIT is on -- it
  // only reports it truthfully.
  if (isNewClientWaitlistEnabled(studio.slug)) proven.push("wait_admission");

  if (!nonEmpty(studio.name)) proven.push("studio_name");
  if (!nonEmpty(studio.slug)) proven.push("booking_link");
  if (
    !nonEmpty(studio.timezone) ||
    !isValidTimeZone(studio.timezone) ||
    typeof studio.default_appointment_duration_minutes !== "number" ||
    typeof studio.buffer_minutes !== "number" ||
    typeof studio.public_booking_horizon_months !== "number"
  ) {
    proven.push("booking_settings");
  }
  if (services.ok && !services.services.some((s) => isBookableByNewClient(s))) {
    proven.push("consultation_service");
  }
  if (availability.ok && !availability.days.some(isOpenDay)) {
    proven.push("availability");
  }
  // THE PAIRING, which neither fact proves on its own.
  //
  // "A consultation exists" and "a day is open" were each true for a studio
  // whose only window was 09:00-09:30 and whose only consultation ran 60
  // minutes: the public slot engine generated ZERO appointments because every
  // candidate's service end passed closing time. READY on two independently
  // true facts is exactly the disagreement this module exists to end.
  //
  // Reported ONLY when both halves exist. With no consultation, or no open day,
  // the blocker above already names the missing half; adding this one would tell
  // an owner to lengthen a window they have not opened yet.
  if (services.ok && availability.ok) {
    const bookable = services.services.filter((s) => isBookableByNewClient(s));
    const openWindows = availability.days.filter(isOpenDay);
    const anyPairFits = openWindows.some((w) =>
      bookable.some((s) => windowFitsDuration(w, s.default_duration_minutes)),
    );
    if (bookable.length > 0 && openWindows.length > 0 && !anyPairFits) {
      proven.push("bookable_window");
    }
  }
  if (treatmentConsent.ok && !treatmentConsent.ready) {
    proven.push("treatment_consent");
  }

  if (proven.length > 0) {
    const blockers = BLOCKER_ORDER.filter((k) => proven.includes(k)).map(
      (key) => ({ key, ...BLOCKERS[key] }),
    );
    return {
      status: "not_ready",
      blockers,
      nextStep: blockers[0] ?? null,
      unavailable,
    };
  }

  // No proven blocker. READY is the one answer that needs every authority.
  if (unavailable.length > 0) return { status: "unknown", unavailable };
  return { status: "ready" };
}

/**
 * Load the evidence and answer. Each fallible read is caught INDIVIDUALLY so
 * one failed authority costs exactly its own answer rather than the whole
 * result — and never becomes a false zero.
 */
export async function getNewClientReadiness(
  studio: NewClientReadinessEvidence["studio"] & { id: string },
): Promise<NewClientReadiness> {
  const [services, availability, treatmentConsent] = await Promise.all([
    getActiveServices(studio.id).then(
      (s) => ({ ok: true, services: s }) as const,
      () => ({ ok: false }) as const,
    ),
    // P2: THE SAME SCOPE PUBLIC BOOKING USES, NOT A WIDER ONE.
    //
    // `getAvailabilityDefaults` returns EVERY row for the studio, including
    // retained practitioner-specific ones. Public booking reads studio-wide
    // availability -- `practitioner_id IS NULL` -- so a studio whose only open
    // rows belong to a practitioner, with every studio-wide day closed, answered
    // READY while the public booking page offered nothing.
    //
    // `getStudioWideDefaultsSafe` is that scope, and it already carries the two
    // behaviours this needs: a legacy fallback for a database without the column,
    // and fail-closed on any other error rather than an empty list that would read
    // as "no open days" and quietly become a blocker.
    createClient()
      .then((supabase) => getStudioWideDefaultsSafe(supabase, studio.id))
      .then(
      (days) => ({ ok: true, days }) as const,
      () => ({ ok: false }) as const,
    ),
    // Already result-bearing; it never throws and never collapses.
    getTreatmentConsentReadiness(studio.id),
  ]);

  return computeNewClientReadiness({
    studio,
    services,
    availability,
    treatmentConsent,
  });
}
