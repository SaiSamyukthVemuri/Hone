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
// goes through `readAll`, which pages against an EXACT count and throws on a
// PostgREST error. Two ways a briefing could otherwise lie with total
// confidence, both closed here:
//
//   * A ROW CEILING. supabase/config.toml sets `max_rows = 1000`, so the Data
//     API truncates a response long before any app-side limit is reached.
//     Comparing the returned length against a larger app-side cap therefore
//     proves nothing: a studio with 1,200 clients looks complete at 1,000 rows,
//     and every client beyond the ceiling silently stops existing — including,
//     on this screen, the ones who have nothing booked. `readAll` compares
//     against the count PostgREST reports in Content-Range, which the row
//     ceiling does not bound, so completeness is proved rather than assumed —
//     and it stays correct whatever the deployment's ceiling happens to be.
//
//   * A FAILED READ. supabase-js RESOLVES with `{ data: null, error }` rather
//     than rejecting, so a discarded error becomes an empty row set: no active
//     clients, nothing booked, and a confident, wrong screen. `readAll` fails
//     closed with a safe code and no row data, because no answer is better than
//     a wrong one here.
//
// Beyond the per-read ceilings below, the figures that row set feeds go
// UNKNOWN, never truncated.

/** supabase/config.toml `max_rows`. One page may not exceed the Data API's own ceiling. */
const API_PAGE_SIZE = 1_000;

const READ_CAPS = {
  clients: 10_000,
  futureAppointments: 10_000,
} as const;

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

function toBriefingAppointment(row: AppointmentRow): BriefingAppointment {
  const service = Array.isArray(row.service) ? (row.service[0] ?? null) : row.service;
  return {
    id: row.id,
    clientId: row.client_id,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    status: row.status,
    // No service at all is treatment, not a consultation.
    isConsultation: service ? isConsultationService(service) : false,
  };
}

type Capped<T> = { rows: T[]; truncated: boolean; total: number | null };

type PageResult<T> = {
  data: T[] | null;
  error: { code?: string | null } | null;
  count?: number | null;
};

/**
 * Read every row of one studio-scoped query, or say so.
 *
 * `truncated` is true when completeness could NOT be established — either the
 * cap was reached before the count was satisfied, or PostgREST reported no
 * count at all. Callers turn that into an UNKNOWN figure; none of them treat a
 * short read as a small studio.
 */
async function readAll<T>(
  what: string,
  cap: number,
  page: (from: number, to: number) => PromiseLike<PageResult<T>>,
): Promise<Capped<T>> {
  const rows: T[] = [];
  let total: number | null = null;
  for (;;) {
    const from = rows.length;
    const to = Math.min(from + API_PAGE_SIZE, cap) - 1;
    if (to < from) break; // the ceiling below is the limit, not the data
    const { data, error, count } = await page(from, to);
    // Fail CLOSED. A swallowed error here renders an empty studio as an idle one.
    if (error) {
      throw new Error(
        `owner_capacity_read_failed:${what}:${error?.code ?? "unknown"}`,
      );
    }
    if (typeof count === "number") total = count;
    const batch = data ?? [];
    rows.push(...batch);
    if (batch.length === 0) break;
    if (total !== null && rows.length >= total) break;
  }
  // No count at all means completeness was never established; say so rather
  // than assume it.
  return { rows, truncated: total === null || rows.length < total, total };
}

function tooLarge(what: string, cap: number): string {
  return `This studio has more than ${cap.toLocaleString()} ${what} in range; this briefing does not report a partial figure.`;
}

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
    readAll<{ id: string }>("clients", READ_CAPS.clients, (from, to) =>
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
    readAll<{ client_id: string }>("treatment_plans", READ_CAPS.clients, (from, to) =>
      supabase
        .from("treatment_plans")
        .select("client_id", { count: "exact" })
        .eq("studio_id", studio.id)
        .eq("status", "active")
        .order("client_id")
        .range(from, to),
    ),
    readAll<AppointmentRow>(
      "future_appointments",
      READ_CAPS.futureAppointments,
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
  const activeClientIds = new Set(clientRows.rows.map((c) => c.id));
  // The EXACT count survives even when the id list does not: PostgREST reports
  // it in Content-Range, which no row ceiling bounds. A studio too large to
  // enumerate still gets a truthful total; only the figures that need the ids
  // go unknown.
  const totalRecords: Fact<number> =
    clientRows.total !== null
      ? known(clientRows.total)
      : unknown(tooLarge("client records", READ_CAPS.clients));

  // An active plan for an archived client is history, not current care.
  const planClientIds = new Set(
    planRows.rows.map((p) => p.client_id).filter((id) => activeClientIds.has(id)),
  );
  // ZERO PLANS IS NOT ZERO CLIENTS. A studio that does not keep treatment plans
  // has an unanswerable question here, and printing "0 active treatment clients"
  // would be a lie with consequences on a screen about chasing work.
  const noPlanEvidence = !planRows.truncated && planRows.rows.length === 0;
  const activeTreatment: Fact<number> =
    clientRows.truncated || planRows.truncated
      ? unknown(tooLarge("client records", READ_CAPS.clients))
      : noPlanEvidence
        ? unknown(
            "This studio has no open treatment plans on file, so who is in active treatment cannot be established. It is not zero.",
          )
        : known(planClientIds.size);

  // --- booked treatment -----------------------------------------------------
  const futureCapReason = tooLarge("future appointments", READ_CAPS.futureAppointments);
  const upcoming = futureRows.rows.map(toBriefingAppointment);
  const futureTreatment = summarizeFutureTreatment(upcoming);

  const futureTreatmentMinutes: Fact<number> = futureRows.truncated
    ? unknown(futureCapReason)
    : known(Math.round(futureTreatment.minutes));

  const depth: Fact<BookingDepth> = !activeTreatment.known
    ? unknown(activeTreatment.reason)
    : futureRows.truncated
      ? unknown(futureCapReason)
      : known(summarizeBookingDepth(planClientIds, futureTreatment.countByClient));

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
