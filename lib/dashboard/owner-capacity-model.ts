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
// never zero — and never a confident guess in either direction. A studio that records no treatment plans does not have zero
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
 * What a future booking IS, as far as the studio's own records can say.
 *
 * The third member is the point. `appointments.service_id` is NULLABLE, and the
 * embedded service also disappears when a service row is deleted, so "no
 * service on this appointment" is a real production state — not a hypothetical.
 * It carries NO modality and NO name, which are the only two things
 * `isConsultationService` reads, so the classification genuinely cannot be
 * made.
 *
 * It previously collapsed into `treatment`, on the reasoning that booked studio
 * time with a client is treatment unless proven otherwise. That is a guess
 * wearing a fact's clothes, and it fails in the direction that matters: a
 * consultation whose service was later deleted was counted as booked treatment,
 * which both inflated committed treatment minutes and removed its client from
 * the "nothing booked" list an owner uses to decide who to chase.
 */
export type ServiceClassification = "consultation" | "treatment" | "unknown";

/**
 * An appointment reduced to the fields the briefing reasons about.
 * `serviceClass` is resolved by the loader through `isConsultationService`, the
 * same predicate the public booking page and its server guard share — this
 * module never re-decides it, and never infers it from duration, client
 * history, notes or anything else.
 */
export type BriefingAppointment = {
  id: string;
  clientId: string;
  startsAt: string;
  endsAt: string;
  status: string;
  serviceClass: ServiceClassification;
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
  /**
   * Clients holding an in-scope future booking whose service class could not be
   * established. These appointments are folded into NEITHER count above — they
   * are the reason a caller must degrade a figure to UNKNOWN rather than the
   * contents of one.
   *
   * Carried as CLIENT IDS, not a bare flag, so a caller can ask the narrower
   * question: booking depth is only contaminated when an unclassifiable
   * booking belongs to a client in the active-treatment population, whereas
   * total committed treatment minutes is contaminated by any of them.
   */
  readonly unclassifiedClientIds: ReadonlySet<string>;
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
  const unclassifiedClientIds = new Set<string>();
  let minutes = 0;
  for (const a of upcoming) {
    if (!isActiveBooking(a)) continue;
    // NEITHER counted NOR discarded. Skipping it silently would report the
    // client as having nothing booked; counting it would report time the studio
    // may never spend treating. Record who it belongs to and let the caller
    // degrade the affected figure instead.
    if (a.serviceClass === "unknown") {
      unclassifiedClientIds.add(a.clientId);
      continue;
    }
    if (a.serviceClass === "consultation") continue;
    countByClient.set(a.clientId, (countByClient.get(a.clientId) ?? 0) + 1);
    const span = new Date(a.endsAt).getTime() - new Date(a.startsAt).getTime();
    if (Number.isFinite(span) && span > 0) minutes += span / 60_000;
  }
  return { countByClient, minutes, unclassifiedClientIds };
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

// ---------------------------------------------------------------------------
// The snapshot
// ---------------------------------------------------------------------------

/**
 * One current client as the single analytics statement returned them, with the
 * two pieces of evidence hung off them.
 *
 * `bookingsComplete` exists because the Data API clips an EMBEDDED rowset at the
 * same ceiling it clips a top-level one — measured, not assumed: a client with
 * 1,100 qualifying appointments came back with 1,000 of them, and the response's
 * Content-Range describes only the ROOT, so nothing in the response body says
 * rows went missing. The loader therefore asks for the true count alongside the
 * rows and compares them per client; this flag is that comparison's answer.
 */
/**
 * What the snapshot can say about one client's open-plan evidence.
 *
 * THREE STATES, NOT TWO. The embedded plan COUNT cannot be clipped, but
 * "cannot be clipped" is not "always present": an absent, malformed or
 * non-numeric aggregate is a real shape, and collapsing it into `none` reports
 * a client as having no open plan when the truth is that nobody looked
 * successfully. That understates the active-treatment population while still
 * publishing it as a known number — the worst combination available.
 *
 * `none` is reserved for a count that was genuinely read and was genuinely
 * zero. That is a fact, and it is not the same fact as an unreadable count.
 */
export type PlanEvidence = "open" | "none" | "unknown";

export type ClientSnapshot = {
  clientId: string;
  /** Open-plan evidence, derived from a COUNT and never from rows. */
  planEvidence: PlanEvidence;
  /** False when this client's booking rows were clipped by the embed ceiling. */
  bookingsComplete: boolean;
  bookings: ReadonlyArray<BriefingAppointment>;
};

export type SnapshotSummary = {
  readonly activeTreatmentClientIds: ReadonlySet<string>;
  /**
   * False when ANY current client's plan evidence could not be established.
   *
   * It is deliberately a property of the WHOLE population rather than a set of
   * offending clients: the figures it guards are counts OVER that population,
   * so one unreadable client makes the count itself unprovable. Omitting that
   * client from `activeTreatmentClientIds` and publishing the remainder is
   * precisely the understated-but-confident number this flag exists to prevent.
   */
  readonly planEvidenceComplete: boolean;
  readonly treatmentCountByClient: ReadonlyMap<string, number>;
  readonly treatmentMinutes: number;
  readonly unclassifiedClientIds: ReadonlySet<string>;
  /** Clients whose booking evidence was clipped, so nothing may be summed over them. */
  readonly incompleteBookingClientIds: ReadonlySet<string>;
};

/**
 * Fold the whole snapshot at once. Every figure the briefing reports is derived
 * from THIS one value, so no two of them can describe different moments.
 *
 * The per-booking rules are unchanged and still live in `summarizeFutureTreatment`
 * — this only regroups them around the client rows the single statement returns.
 */
export function summarizeSnapshot(
  clients: ReadonlyArray<ClientSnapshot>,
): SnapshotSummary {
  const treatment = summarizeFutureTreatment(clients.flatMap((c) => [...c.bookings]));
  return {
    activeTreatmentClientIds: new Set(
      clients.filter((c) => c.planEvidence === "open").map((c) => c.clientId),
    ),
    planEvidenceComplete: clients.every((c) => c.planEvidence !== "unknown"),
    treatmentCountByClient: treatment.countByClient,
    treatmentMinutes: treatment.minutes,
    unclassifiedClientIds: treatment.unclassifiedClientIds,
    incompleteBookingClientIds: new Set(
      clients.filter((c) => !c.bookingsComplete).map((c) => c.clientId),
    ),
  };
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
