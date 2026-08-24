import type { SupabaseClient } from "@supabase/supabase-js";

import { isConsultationService } from "@/lib/booking/consultation";
import { todayInTz } from "@/lib/booking/tz";
import { createClient } from "@/lib/supabase/server";
import type { Studio } from "@/lib/types/database";

import {
  ACTIVE_TREATMENT_BASIS,
  known,
  summarizeBookingDepth,
  summarizeFutureTreatment,
  unknown,
  type BookingDepth,
  type BriefingAppointment,
  type Fact,
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
// SHAPE OF THE READ: three studio-scoped queries issued together. No per-day
// and no per-client query.
//
// NO READ IS EVER CONSUMED AS COMPLETE UNLESS IT PROVABLY IS. Every read below
// goes through `readOnce`, which issues exactly ONE Data API statement and
// throws on a PostgREST error. Three ways a briefing could otherwise lie with
// total confidence, all closed here:
//
//   * A ROW CEILING. supabase/config.toml sets `max_rows = 1000`, so the Data
//     API truncates a response before any app-side limit is reached. Comparing
//     the returned length against a larger app-side cap proves nothing: a
//     studio with 1,200 clients looks complete at 1,000 rows, and every client
//     beyond the ceiling silently stops existing — including, on this screen,
//     the ones who have nothing booked. `readOnce` compares the returned length
//     against the exact count PostgREST reports in Content-Range, which the row
//     ceiling does not bound. Completeness is proved, not assumed, whatever the
//     deployment's ceiling happens to be.
//
//   * A MULTI-REQUEST ROWSET PRESENTED AS A SNAPSHOT. This module used to page
//     with sequential `range()` requests and treat the accumulation as one
//     population. IT CANNOT BE ONE. Offsets are computed against live data, so
//     a row inserted, archived, cancelled or deleted between requests shifts
//     every later offset: read the first 1,000 of 1,050 clients, archive one of
//     them, and the next request returns 49 rows against a new count of 1,049 —
//     the arithmetic says complete while one live client was skipped and one
//     archived client sits in the accumulated rows. No count comparison, retry
//     or cursor fixes that without a database transaction boundary, and this
//     module has no vehicle for one: it is Data API reads only, no RPC.
//
//     So multi-request enumeration was REMOVED from the truth boundary rather
//     than patched. One statement, or the identifiers are not available.
//
//   * A FAILED READ. supabase-js RESOLVES with `{ data: null, error }` rather
//     than rejecting, so a discarded error becomes an empty row set: no active
//     clients, nothing booked, and a confident, wrong screen. `readOnce` fails
//     closed with a safe code and no row data, because no answer is better than
//     a wrong one here.
//
// WHAT SURVIVES THE CEILING, AND WHAT DOES NOT. The EXACT COUNT is reported in
// Content-Range and is not bounded by the row ceiling, so a studio too large to
// enumerate still gets a truthful `totalRecords`. Everything that needs the
// IDENTIFIERS — who is in active treatment, who has nothing booked, how deeply
// anyone is booked — goes UNKNOWN, because the population those figures are
// computed over was never fully in hand.
//
// That is a real product ceiling for large studios, not a defect to paper over.
// Lifting it needs a snapshot-capable, database-backed reader (a migration and
// an RPC that answer inside one transaction), which is a separate change with
// its own blast radius. Slice 1 fails closed instead.

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

type AppointmentRow = {
  id: string;
  client_id: string;
  starts_at: string;
  ends_at: string;
  status: string;
  service: ServiceEmbed | ServiceEmbed[];
};

const APPOINTMENT_SELECT =
  "id, client_id, starts_at, ends_at, status, service:services(modality, name)";

/**
 * What this booking is, or that it cannot be said.
 *
 * `appointments.service_id` is nullable, and the embed is also absent when the
 * service row has been deleted. Either way `isConsultationService` has nothing
 * to read — modality and name are the whole of its input — so the answer is
 * UNKNOWN. It is deliberately NOT reconstructed from duration, the client's
 * history, appointment notes, or any other proxy: those produce a confident
 * classification out of no evidence, which is the failure this whole module is
 * built to refuse.
 */
function classifyService(row: AppointmentRow): ServiceClassification {
  const service = Array.isArray(row.service) ? (row.service[0] ?? null) : row.service;
  if (!service) return "unknown";
  return isConsultationService(service) ? "consultation" : "treatment";
}

function toBriefingAppointment(row: AppointmentRow): BriefingAppointment {
  return {
    id: row.id,
    clientId: row.client_id,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    status: row.status,
    serviceClass: classifyService(row),
  };
}

type Capped<T> = { rows: T[]; truncated: boolean; total: number | null };

type PageResult<T> = {
  data: T[] | null;
  error: { code?: string | null } | null;
  count?: number | null;
};

/**
 * Read one studio-scoped query in ONE Data API statement, or say it could not.
 *
 * COMPLETENESS IS A CONJUNCTION, and nothing weaker will do: PostgREST reported
 * an exact count, AND this single response carried exactly that many rows. Both
 * halves come from the same request, so they describe the same moment — which
 * is the whole reason the read is not allowed to span two of them.
 *
 * `truncated` is true when that could not be established: no count at all, or
 * fewer rows than the count. Either way the identifiers are not in hand, and
 * callers turn that into an UNKNOWN figure. NONE of them treats a short read as
 * a small studio, and none fetches a second page and calls the union exact.
 */
async function readOnce<T>(
  what: string,
  page: (from: number, to: number) => PromiseLike<PageResult<T>>,
): Promise<Capped<T>> {
  const { data, error, count } = await page(0, API_PAGE_SIZE - 1);
  // Fail CLOSED. A swallowed error here renders an empty studio as an idle one.
  if (error) {
    throw new Error(`owner_capacity_read_failed:${what}:${error?.code ?? "unknown"}`);
  }
  const rows = data ?? [];
  const total = typeof count === "number" ? count : null;
  return { rows, truncated: total === null || rows.length !== total, total };
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

// ---------------------------------------------------------------------------
// The briefing
// ---------------------------------------------------------------------------

export async function getOwnerCapacityBriefing(
  studio: Studio,
  supabaseClient?: SupabaseClient,
): Promise<OwnerCapacityBriefing> {
  const supabase = supabaseClient ?? (await createClient());
  const tz = studio.timezone;
  const now = new Date();
  const nowIso = now.toISOString();

  // --- three independent studio-scoped reads, issued together ---------------
  const [clientRows, planRows, futureRows] = await Promise.all([
    readOnce<{ id: string }>("clients", (from, to) =>
      supabase
        .from("clients")
        .select("id", { count: "exact" })
        .eq("studio_id", studio.id)
        .is("archived_at", null)
        .order("id")
        .range(from, to),
    ),
    // The ONE owner-declared authority for "this client is in a course of
    // treatment": an open treatment plan (0024). Never inferred from bookings.
    readOnce<{ client_id: string }>("treatment_plans", (from, to) =>
      supabase
        .from("treatment_plans")
        .select("client_id", { count: "exact" })
        .eq("studio_id", studio.id)
        .eq("status", "active")
        .order("client_id")
        .range(from, to),
    ),
    readOnce<AppointmentRow>(
      "future_appointments",
      (from, to) =>
        supabase
          .from("appointments")
          .select(APPOINTMENT_SELECT, { count: "exact" })
          .eq("studio_id", studio.id)
          .in("status", ["confirmed", "completed"])
          .gte("starts_at", nowIso)
          .order("starts_at")
          .order("id")
          .range(from, to),
    ),
  ]);

  // --- clients --------------------------------------------------------------
  const currentClientIds = new Set(clientRows.rows.map((c) => c.id));
  // The EXACT count survives even when the id list does not: PostgREST reports
  // it in Content-Range, which no row ceiling bounds. A studio too large to
  // enumerate in one statement still gets a truthful total; only the figures
  // that need the ids go unknown.
  const totalRecords: Fact<number> =
    clientRows.total !== null
      ? known(clientRows.total)
      : unknown(notEnumerable("client records"));

  // ACTIVE TREATMENT IS AN INTERSECTION, NOT A PLAN COUNT. The basis is "an
  // open treatment plan for a CURRENT client", so an open plan belonging to an
  // archived client is history and contributes nothing.
  const currentPlanClientIds = new Set(
    planRows.rows.map((p) => p.client_id).filter((id) => currentClientIds.has(id)),
  );

  // ...AND AN EMPTY INTERSECTION IS UNKNOWN, NOT ZERO — however it came to be
  // empty. A studio that keeps no plans and a studio whose every open plan
  // belongs to an archived client are the SAME epistemic state: no evidence
  // that any current client is in a course of treatment. Testing
  // `planRows.rows.length === 0` split those two apart and answered the second
  // with a confident 0, which on a screen about chasing work reads as "nobody
  // needs booking".
  const noCurrentPlanEvidence = currentPlanClientIds.size === 0;
  const activeTreatment: Fact<number> =
    clientRows.truncated
      ? unknown(notEnumerable("client records"))
      : planRows.truncated
        ? unknown(notEnumerable("treatment plans"))
        : noCurrentPlanEvidence
          ? unknown(
              "No open treatment plan for a current client is on file, so who is in active treatment cannot be established. It is not zero.",
            )
          : known(currentPlanClientIds.size);

  // --- booked treatment -----------------------------------------------------
  const futureCapReason = notEnumerable("future appointments");
  const upcoming = futureRows.rows.map(toBriefingAppointment);
  const futureTreatment = summarizeFutureTreatment(upcoming);

  // TWO DIFFERENT BLAST RADII, deliberately not merged.
  //
  // Total committed treatment minutes sums EVERY in-scope future booking, so a
  // single unclassifiable one anywhere makes the total unsound.
  const anyUnclassifiable = futureTreatment.unclassifiedClientIds.size > 0;
  // Booking depth only reads the active-treatment population, so it is only
  // contaminated when the unclassifiable booking belongs to a client IN that
  // population. An orphaned appointment for someone with no open plan cannot
  // change how deeply the treatment clients are booked.
  const unclassifiableInActivePopulation = [
    ...futureTreatment.unclassifiedClientIds,
  ].some((id) => currentPlanClientIds.has(id));

  const futureTreatmentMinutes: Fact<number> = futureRows.truncated
    ? unknown(futureCapReason)
    : anyUnclassifiable
      ? unknown(UNCLASSIFIABLE_BOOKING)
      : known(Math.round(futureTreatment.minutes));

  const depth: Fact<BookingDepth> = !activeTreatment.known
    ? unknown(activeTreatment.reason)
    : futureRows.truncated
      ? unknown(futureCapReason)
      : unclassifiableInActivePopulation
        ? unknown(UNCLASSIFIABLE_BOOKING)
        : known(summarizeBookingDepth(currentPlanClientIds, futureTreatment.countByClient));

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
