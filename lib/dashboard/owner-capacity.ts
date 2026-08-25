import type { SupabaseClient } from "@supabase/supabase-js";

import { isConsultationService } from "@/lib/booking/consultation";
import { todayInTz } from "@/lib/booking/tz";
import { createClient } from "@/lib/supabase/server";
import type { Studio } from "@/lib/types/database";

import {
  ACTIVE_TREATMENT_BASIS,
  known,
  summarizeBookingDepth,
  summarizeSnapshot,
  unknown,
  type BookingDepth,
  type BriefingAppointment,
  type ClientSnapshot,
  type Fact,
  type PlanEvidence,
  type ServiceClassification,
} from "./owner-capacity-model";

// ===========================================================================
// OWNER CAPACITY — the reads behind /dashboard/capacity
// ===========================================================================
//
// Owner-only operational briefing. READ-ONLY: this module issues no INSERT,
// UPDATE, DELETE or RPC, and touches no payment, email, SMS, Google or
// analytics path.
//
// WHAT THE OWNER GATE IS, STATED PLAINLY: it is an APPLICATION-LAYER check on
// `practitioner.role`, performed by the page before this module is called. It
// is NOT a database boundary. RLS on `clients`, `treatment_plans` and
// `appointments` is `is_studio_member`, so any practitioner of the studio can
// already SELECT these rows directly. This screen decides who is SHOWN the
// aggregate, not who is permitted the underlying data. A real owner-only data
// boundary needs its own migration and its own blast radius; nothing here
// pretends to be one.
//
// SHAPE OF THE READ: ONE statement. The briefing is rooted on the studio's
// current clients, with the plan evidence and the qualifying future bookings
// embedded beneath them. No second request, no offset paging, and no per-client
// query — a studio of six clients and a studio of six hundred cost the same one
// round trip.
//
// NO READ IS EVER CONSUMED AS COMPLETE UNLESS IT PROVABLY IS. Four ways a
// briefing could otherwise lie with total confidence, all closed here:
//
//   * A ROW CEILING. supabase/config.toml sets `max_rows = 1000`, so the Data
//     API truncates a response before any app-side limit is reached. Comparing
//     the returned length against a larger app-side cap proves nothing: a
//     studio with 1,200 clients looks complete at 1,000 rows, and every client
//     beyond the ceiling silently stops existing — including, on this screen,
//     the ones who have no treatment booked. The returned length is checked against
//     the exact count PostgREST reports in Content-Range, which the ceiling
//     does not bound.
//
//   * THE SAME CEILING ON AN EMBEDDED ROWSET. Measured against the local stack,
//     not assumed: a client with 1,100 qualifying appointments comes back with
//     1,000 of them. The clipping is PER PARENT ROW (two clients of 600 each
//     both returned whole in the same response), and Content-Range describes
//     only the ROOT — so nothing in the response says embedded rows went
//     missing. Each client's booking rows are therefore checked against a
//     count of the same filtered population, requested in the same statement.
//
//   * A MULTI-REQUEST ROWSET PRESENTED AS A SNAPSHOT. This module used to issue
//     three independent requests and join their results. Three requests are
//     three snapshots: a plan can be closed and an appointment inserted between
//     them, and the briefing then reports a combination of states that never
//     coexisted — a client counted as in active treatment AND booked, when the
//     plan and the booking were never simultaneously live. Per-request
//     completeness does not help; each response is internally sound and the
//     join across them is still fiction. One statement is one snapshot by
//     construction, which is why the shape above is not merely tidier.
//
//   * A FAILED READ. supabase-js RESOLVES with `{ data: null, error }` rather
//     than rejecting, so a discarded error becomes an empty row set: no active
//     clients, no treatment booked, and a confident, wrong screen. The read fails
//     closed with a safe code and no row data, because no answer is better than
//     a wrong one here.
//
// WHAT SURVIVES THE CEILING, AND WHAT DOES NOT. The EXACT COUNT is reported in
// Content-Range and is not bounded by the row ceiling, so a studio too large to
// enumerate still gets a truthful `totalRecords`. Everything that needs the
// IDENTIFIERS — who is in active treatment, who has no treatment booked, how deeply
// anyone is booked — goes UNKNOWN, because the population those figures are
// computed over was never fully in hand.
//
// That is a real product ceiling for large studios, not a defect to paper over.
// Lifting it needs a database-backed reader that answers inside its own
// transaction (a migration and an RPC), which is a separate change with its own
// blast radius. Slice 1 fails closed instead.
//
// ONE DELIBERATE NARROWING, RECORDED BECAUSE IT IS A BEHAVIOUR CHANGE: committed
// treatment minutes now covers the bookings of CURRENT clients only. It is
// rooted on the client population, so a booking held by an archived client is
// outside the snapshot rather than filtered out of it. The previous shape read
// appointments studio-wide and counted those too.

/**
 * supabase/config.toml `max_rows` — the most rows ONE Data API statement can
 * return. Requesting this range is an upper bound, never a promise: a
 * deployment whose real ceiling is lower simply returns fewer rows than the
 * exact count, which `readOnce` reports as incomplete exactly the same way.
 */
const API_PAGE_SIZE = 1_000;

// ---------------------------------------------------------------------------
// Public shape
// ---------------------------------------------------------------------------

export type OwnerCapacityBriefing = {
  timezone: string;
  todayLocal: string;
  generatedAt: string;

  clients: {
    /** Non-archived client records. Not a measure of who is in treatment. */
    totalRecords: Fact<number>;
    activeTreatment: Fact<number>;
    activeTreatmentWithoutFutureBooking: Fact<number>;
    /** How "active treatment client" was established, for the screen to state. */
    activeTreatmentBasis: string;
  };

  /** How deeply the active treatment clients are booked. */
  depth: Fact<BookingDepth>;
  /** Real treatment time already on the calendar, in minutes. Excludes buffers. */
  futureTreatmentMinutes: Fact<number>;
};

// ---------------------------------------------------------------------------
// Row plumbing
// ---------------------------------------------------------------------------

type ServiceEmbed = { modality: string | null; name: string } | null;

type BookingRow = {
  id: string;
  starts_at: string;
  ends_at: string;
  status: string;
  service: ServiceEmbed | ServiceEmbed[];
};

type CountEmbed = ReadonlyArray<{ count: number }>;

type ClientRow = {
  id: string;
  plan_count: CountEmbed;
  bookings: BookingRow[];
  booking_count: CountEmbed;
};

/**
 * ONE statement, and every alias in it earns its place.
 *
 * `plan_count` is a COUNT, not rows: the briefing only ever asks "does this
 * client have an open plan at all", and a count cannot be clipped, so the plan
 * evidence carries no ceiling risk whatsoever.
 *
 * `bookings` must be rows — treatment, consultation and unclassifiable can only
 * be told apart by looking at the service. `booking_count` is the same
 * population counted, so the rows can be checked against it per client.
 */
const CAPACITY_SELECT = `
  id,
  plan_count:treatment_plans(count),
  bookings:appointments(id, starts_at, ends_at, status, service:services(modality, name)),
  booking_count:appointments(count)
`;

const BOOKED_STATUSES = ["confirmed", "completed"] as const;

function classifyService(row: BookingRow): ServiceClassification {
  const service = Array.isArray(row.service) ? (row.service[0] ?? null) : row.service;
  if (!service) return "unknown";
  return isConsultationService(service) ? "consultation" : "treatment";
}

function toBriefingAppointment(row: BookingRow, clientId: string): BriefingAppointment {
  return {
    id: row.id,
    clientId,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    status: row.status,
    serviceClass: classifyService(row),
  };
}

/**
 * An embedded aggregate arrives as a one-element array. Absent, empty, or
 * carrying anything that is not a finite non-negative number is UNUSABLE, and
 * unusable is reported as such — never coerced to a number, because every
 * coercion here invents evidence.
 */
function embeddedCount(embed: CountEmbed | null | undefined): number | null {
  const n = embed?.[0]?.count;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Open-plan evidence for one client, as three states rather than two.
 *
 * `?? 0` used to stand here, which collapsed an unreadable count into "no open
 * plan". The count itself cannot be clipped — but that is not the same as
 * always being present, and the collapse quietly removed a client from the
 * active-treatment population while the population was still published as a
 * KNOWN number. A genuinely-read zero is a fact; an unreadable count is not the
 * same fact.
 */
function planEvidenceOf(embed: CountEmbed | null | undefined): PlanEvidence {
  const n = embeddedCount(embed);
  if (n === null) return "unknown";
  return n > 0 ? "open" : "none";
}

type Snapshot = {
  clients: ClientSnapshot[];
  /** The exact number of current clients, which no ceiling bounds. */
  totalClients: number | null;
  /** True when the ROOT population could not be listed in this one response. */
  rootTruncated: boolean;
};

/**
 * Read the whole briefing in ONE Data API statement, or say it could not.
 *
 * WHY ONE STATEMENT AND NOT THREE. Three requests are three snapshots. Between
 * them a plan can be closed and an appointment inserted, and the briefing then
 * reports a combination of states that never coexisted — an active-treatment
 * client shown as booked whose plan and booking were never simultaneously live.
 * Per-request completeness does not help: each response is internally sound and
 * the JOIN across them is still fiction. Rooting on clients and embedding both
 * kinds of evidence puts the whole join inside one PostgreSQL statement, which
 * is one snapshot by construction.
 *
 * COMPLETENESS IS CHECKED AT BOTH LEVELS, because the ceiling applies at both:
 *
 *   * ROOT — Content-Range reports the exact client count; the response is
 *     complete only when it carried exactly that many rows.
 *   * EMBED — measured behaviour, not an assumption: a client with 1,100
 *     qualifying appointments returns 1,000 of them, per parent row, and the
 *     response says nothing about the loss. Each client's rows are therefore
 *     checked against `booking_count`, which is the same filtered population
 *     counted rather than listed.
 */
async function readSnapshot(
  supabase: SupabaseClient,
  studioId: string,
  nowIso: string,
): Promise<Snapshot> {
  const { data, error, count } = await supabase
    .from("clients")
    .select(CAPACITY_SELECT, { count: "exact" })
    .eq("studio_id", studioId)
    .is("archived_at", null)
    // Both plan aliases are filtered identically, or the count would answer a
    // different question from the one being asked.
    .eq("plan_count.status", "active")
    .eq("plan_count.studio_id", studioId)
    // ...and so are both booking aliases, or the per-client comparison below
    // would compare two different populations and see phantom truncation.
    .in("bookings.status", [...BOOKED_STATUSES])
    .gte("bookings.starts_at", nowIso)
    .eq("bookings.studio_id", studioId)
    .in("booking_count.status", [...BOOKED_STATUSES])
    .gte("booking_count.starts_at", nowIso)
    .eq("booking_count.studio_id", studioId)
    .order("id")
    .range(0, API_PAGE_SIZE - 1);

  // Fail CLOSED. A swallowed error here renders an empty studio as an idle one.
  if (error) {
    throw new Error(`owner_capacity_read_failed:capacity_snapshot:${error?.code ?? "unknown"}`);
  }

  const rows = (data ?? []) as unknown as ClientRow[];
  const totalClients = typeof count === "number" ? count : null;
  const clients: ClientSnapshot[] = rows.map((row) => {
    const bookings = row.bookings ?? [];
    const trueBookings = embeddedCount(row.booking_count);
    return {
      clientId: row.id,
      // Three states. An unreadable count is not evidence of absence.
      planEvidence: planEvidenceOf(row.plan_count),
      // No count to check against is the same as a short read: not established.
      bookingsComplete: trueBookings !== null && bookings.length === trueBookings,
      bookings: bookings.map((b) => toBriefingAppointment(b, row.id)),
    };
  });

  return {
    clients,
    totalClients,
    rootTruncated: totalClients === null || rows.length !== totalClients,
  };
}

/**
 * Why an identifier-dependent figure is missing. Truthful for both causes: the
 * response ceiling clipped the rows, or PostgREST reported no count to check
 * them against.
 */
function notEnumerable(what: string): string {
  return `This studio's ${what} could not be listed in a single read (one request returns at most ${API_PAGE_SIZE.toLocaleString()} rows), so this briefing does not report a partial figure.`;
}

/**
 * A future booking whose service is gone or was never set. Named once so the
 * screen says the same thing wherever it surfaces.
 */
const UNCLASSIFIABLE_BOOKING =
  "A future appointment has no service on record, so whether it is treatment or a consultation cannot be established; this briefing does not guess.";

const PLAN_EVIDENCE_UNREADABLE =
  "The open-plan evidence for at least one current client could not be read, so the active-treatment population cannot be proven complete. A count over the clients that did answer would be lower than the truth, so none is reported.";

const CLIPPED_BOOKINGS =
  "One client has more future appointments than a single read can return, so the bookings behind this figure are not all in hand.";

// ---------------------------------------------------------------------------
// The briefing
// ---------------------------------------------------------------------------

export async function getOwnerCapacityBriefing(
  studio: Studio,
  supabaseClient: SupabaseClient | undefined = undefined,
): Promise<OwnerCapacityBriefing> {
  const supabase = supabaseClient ?? (await createClient());
  const tz = studio.timezone;
  const nowIso = new Date().toISOString();

  const snapshot = await readSnapshot(supabase, studio.id, nowIso);
  const summary = summarizeSnapshot(snapshot.clients);

  // The EXACT count survives even when the rows do not: Content-Range reports
  // it and no row ceiling bounds it. A studio too large to enumerate in one
  // statement still gets a truthful total; only the figures that need the
  // IDENTIFIERS go unknown.
  const totalRecords: Fact<number> =
    snapshot.totalClients !== null
      ? known(snapshot.totalClients)
      : unknown(notEnumerable("client records"));

  const rootReason = notEnumerable("client records");

  // ACTIVE TREATMENT IS AN INTERSECTION, NOT A PLAN COUNT — and it is now an
  // intersection by CONSTRUCTION: the plan evidence is embedded under the
  // current clients, so a plan belonging to an archived client is not in the
  // result at all rather than being filtered out afterwards.
  //
  // AN EMPTY INTERSECTION IS UNKNOWN, NOT ZERO, however it came to be empty. A
  // studio that keeps no plans and a studio whose every open plan belongs to an
  // archived client are the SAME epistemic state: no evidence that any current
  // client is in a course of treatment.
  // ONE UNREADABLE CLIENT INVALIDATES THE POPULATION, not just its own row.
  // Dropping that client from `activeIds` and publishing the remainder is
  // exactly how a confident, understated count gets onto the screen — checked
  // BEFORE the empty-intersection branch, because an all-unreadable studio
  // would otherwise be reported as "no plans on file", which is a different
  // claim from "the plans could not be read".
  const activeIds = summary.activeTreatmentClientIds;
  const activeTreatment: Fact<number> = snapshot.rootTruncated
    ? unknown(rootReason)
    : !summary.planEvidenceComplete
      ? unknown(PLAN_EVIDENCE_UNREADABLE)
      : activeIds.size === 0
        ? unknown(
            "No open treatment plan for a current client is on file, so who is in active treatment cannot be established. It is not zero.",
          )
        : known(activeIds.size);

  // TWO DIFFERENT BLAST RADII, deliberately not merged.
  //
  // Total committed treatment minutes sums EVERY booking in the snapshot, so it
  // is unsound if ANY booking anywhere is unclassifiable or was clipped.
  const anyUnclassifiable = summary.unclassifiedClientIds.size > 0;
  const anyClipped = summary.incompleteBookingClientIds.size > 0;
  // Booking depth reads only the active-treatment population, so it is only
  // contaminated by a client IN that population. An orphaned appointment
  // belonging to someone with no open plan cannot change how deeply the
  // treatment clients are booked.
  const contaminatedInActive = (ids: ReadonlySet<string>) =>
    [...ids].some((id) => activeIds.has(id));

  const futureTreatmentMinutes: Fact<number> = snapshot.rootTruncated
    ? unknown(rootReason)
    : anyUnclassifiable
      ? unknown(UNCLASSIFIABLE_BOOKING)
      : anyClipped
        ? unknown(CLIPPED_BOOKINGS)
        : known(Math.round(summary.treatmentMinutes));

  const depth: Fact<BookingDepth> = !activeTreatment.known
    ? unknown(activeTreatment.reason)
    : contaminatedInActive(summary.unclassifiedClientIds)
      ? unknown(UNCLASSIFIABLE_BOOKING)
      : contaminatedInActive(summary.incompleteBookingClientIds)
        ? unknown(CLIPPED_BOOKINGS)
        : known(summarizeBookingDepth(activeIds, summary.treatmentCountByClient));

  const activeTreatmentWithoutFutureBooking: Fact<number> = depth.known
    ? known(depth.value.zero)
    : unknown(depth.reason);

  return {
    timezone: tz,
    todayLocal: todayInTz(tz),
    generatedAt: nowIso,
    clients: {
      totalRecords,
      activeTreatment,
      activeTreatmentWithoutFutureBooking,
      activeTreatmentBasis: ACTIVE_TREATMENT_BASIS,
    },
    depth,
    futureTreatmentMinutes,
  };
}
