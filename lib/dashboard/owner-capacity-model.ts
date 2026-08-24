// ===========================================================================
// OWNER CAPACITY — the derivations, with no I/O
// ===========================================================================
//
// The owner briefing at /dashboard/capacity answers one operational question
// from current studio truth: which of the studio's active treatment clients
// have nothing on the calendar. This module holds every rule it applies; the
// loader beside it holds every read.
//
// THE ONE DISCIPLINE THIS FILE EXISTS TO ENFORCE: an absent input is UNKNOWN,
// never zero. A studio that records no treatment plans does not have zero
// active treatment clients — it has an unanswerable question, and printing "0"
// would read as "nobody is in treatment" on a screen an owner uses to decide
// whether to chase work. Every derived figure therefore travels as a `Fact<T>`.
//
// SCOPE. This is OWNER-CAP Slice 1. Treatment access, weekly capacity,
// new-client demand and conversion are later slices and are deliberately not
// modelled here — no placeholder, no stub, no half-answer.

// ---------------------------------------------------------------------------
// Fact<T> — a value, or the reason there isn't one
// ---------------------------------------------------------------------------

export type Fact<T> =
  | { readonly known: true; readonly value: T }
  | { readonly known: false; readonly reason: string };

export function known<T>(value: T): Fact<T> {
  return { known: true, value };
}

export function unknown<T>(reason: string): Fact<T> {
  return { known: false, reason };
}

// ---------------------------------------------------------------------------
// Appointments
// ---------------------------------------------------------------------------

/**
 * An appointment reduced to the fields the briefing reasons about.
 * `isConsultation` is resolved by the loader through `isConsultationService`,
 * the same predicate the public booking page and its server guard share — this
 * module never re-decides it.
 *
 * An appointment with NO service is treatment, not a consultation: it is booked
 * studio time with a client, and calling it a consultation would quietly drop
 * it out of the booked-treatment counts below.
 */
export type BriefingAppointment = {
  id: string;
  clientId: string;
  startsAt: string;
  endsAt: string;
  status: string;
  isConsultation: boolean;
};

const ACTIVE_STATUSES = new Set(["confirmed", "completed"]);

/** Active = the studio is actually committed to it. Cancelled and no-show are not. */
export function isActiveBooking(a: Pick<BriefingAppointment, "status">): boolean {
  return ACTIVE_STATUSES.has(a.status);
}

// ---------------------------------------------------------------------------
// Booked treatment
// ---------------------------------------------------------------------------

export type FutureTreatment = {
  /** Future active TREATMENT appointments per client. Consultations excluded. */
  readonly countByClient: ReadonlyMap<string, number>;
  /** Real treatment time on the calendar, in minutes. Buffers excluded. */
  readonly minutes: number;
};

/**
 * Fold the upcoming appointments into per-client treatment counts and total
 * committed treatment time.
 *
 * Consultations are excluded on purpose: a booked consultation is not the
 * client's next treatment, so counting it would report an active client as
 * "booked" when the thing on the calendar is a conversation.
 *
 * Buffers are excluded too. `blocked_ends_at` carries the buffer and is what
 * the calendar reserves, but an owner reading "treatment time booked" means
 * time spent treating, not time the diary is unavailable.
 */
export function summarizeFutureTreatment(
  upcoming: ReadonlyArray<BriefingAppointment>,
): FutureTreatment {
  const countByClient = new Map<string, number>();
  let minutes = 0;
  for (const a of upcoming) {
    if (a.isConsultation || !isActiveBooking(a)) continue;
    countByClient.set(a.clientId, (countByClient.get(a.clientId) ?? 0) + 1);
    const span = new Date(a.endsAt).getTime() - new Date(a.startsAt).getTime();
    if (Number.isFinite(span) && span > 0) minutes += span / 60_000;
  }
  return { countByClient, minutes };
}

export type BookingDepth = {
  zero: number;
  oneOrMore: number;
  twoOrMore: number;
  threeOrMore: number;
};

/**
 * How deeply the studio's active treatment clients are actually booked.
 *
 * `activeClientIds` is the active-treatment-client set. A client in that set
 * with no future treatment is counted in `zero` — they are the latent-demand
 * signal, and they are NOT converted into projected hours anywhere: nobody
 * knows when they will book.
 *
 * The bands are cumulative (a client with three future treatments counts in
 * `oneOrMore`, `twoOrMore` and `threeOrMore`), so they read as "at least this
 * deep" rather than as a partition.
 */
export function summarizeBookingDepth(
  activeClientIds: ReadonlySet<string>,
  futureTreatmentCountByClient: ReadonlyMap<string, number>,
): BookingDepth {
  const depth: BookingDepth = { zero: 0, oneOrMore: 0, twoOrMore: 0, threeOrMore: 0 };
  for (const id of activeClientIds) {
    const n = futureTreatmentCountByClient.get(id) ?? 0;
    if (n === 0) depth.zero += 1;
    if (n >= 1) depth.oneOrMore += 1;
    if (n >= 2) depth.twoOrMore += 1;
    if (n >= 3) depth.threeOrMore += 1;
  }
  return depth;
}

/**
 * How "active treatment client" was established, stated on the screen itself.
 *
 * It is a single owner-declared authority — an open treatment plan (0024) — and
 * naming it is not decoration: an owner who keeps no plans must be able to see
 * WHY the number is unavailable, or they will read the absence as a defect.
 */
export const ACTIVE_TREATMENT_BASIS =
  "A client with an open treatment plan (the client's Treatment tab). Hone records no other explicit statement that someone is in a course of treatment, and a client record on its own is not one.";
