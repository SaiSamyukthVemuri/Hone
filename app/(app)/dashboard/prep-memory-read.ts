import { createClient } from "@/lib/supabase/server";
import { loadLastChartedTreatmentsForClients } from "@/lib/sessions/last-treatment-loader";
import {
  buildAppointmentPrepMemory,
  prepMemoryInputFromTreatment,
  type AppointmentPrepMemory,
} from "@/lib/sessions/appointment-prep-memory";

// ===========================================================================
// FULL PREVIOUS TREATMENT, ON DEMAND
// ===========================================================================
//
// WHY THIS EXISTS. The Dashboard row shows a compact identity of the previous
// visit and offers "View full last treatment". Previously the FULL
// `AppointmentPrepMemory` was handed to a Client Component to make that
// expansion instant — which meant the browser received every treated area,
// machine setting, probe lot number, tolerance rating, reaction and numbing
// note, and the practitioner's narrative, for EVERY row on the day, before she
// asked to see any of it. Collapsing it in the DOM changes what is *rendered*,
// not what is *transported*.
//
// THE RULE (changed 26 Nov 2026, on the practitioner's explicit request that
// last visit details show directly on the card): the full model is NOT part of
// the page payload. The row's client component asks for it on page view, one
// request per row that has prior treatment, to GET /dashboard/prep-memory
// (app/(app)/dashboard/prep-memory/route.ts). That route re-resolves who is
// asking and which studio they are in, then calls readAppointmentPrepMemory
// below, which fences the appointment to that studio before returning anything
// clinical. So the full details now DO reach the browser for every such row on
// the day, without a click; they never arrive for a row without prior
// treatment, for another studio, or via the page props. The earlier rule
// (nothing crosses until a row is explicitly opened) is retired, and
// docs/03_SECURITY_AND_PRIVACY.md records the change.
//
// WHY A ROUTE AND NOT A SERVER ACTION. Next runs a page's server actions one at
// a time on the client. The details read starts on mount, so as a server action
// it held the queue: a pinned-note save made while it was in flight was not sent
// until it finished, and a reload in that window lost the save. A GET fetch does
// not use that queue, so saving a pin never waits on the details.
//
// This is data minimisation inside an already-authorised session, not a
// tenancy fix — the studio fence was never in doubt.

/** Explicit outcome. `none` and `unavailable` are different facts. */
export type PrepMemoryResult =
  | { status: "loaded"; memory: AppointmentPrepMemory }
  | { status: "none" }
  | { status: "unavailable" };

/** The read's own outcome: a missing or foreign appointment is `not_found`, which the route answers with a 404. */
export type PrepMemoryReadOutcome = PrepMemoryResult | { status: "not_found" };

/**
 * Resolve the full previous treatment for ONE appointment.
 *
 * The browser sends only an appointment id — it says WHAT the practitioner
 * wants to open. The caller (the route) resolves WHO is asking and WHICH studio
 * they are in from the session and passes that studio id here; this function
 * fences the appointment to it. The client id and the history cutoff are read
 * from the appointment row on the server, never accepted from the caller, so a
 * forged client id or an altered `before` cannot widen the answer.
 */
export async function readAppointmentPrepMemory(
  appointmentId: string,
  studioId: string,
): Promise<PrepMemoryReadOutcome> {
  if (typeof appointmentId !== "string" || appointmentId.length === 0 || !studioId) {
    return { status: "unavailable" };
  }
  const studio = { id: studioId };

  try {
    const supabase = await createClient();

    // Fenced on BOTH sides: the id the browser supplied and the studio the
    // server resolved. A foreign appointment returns the same answer as a
    // missing one, so this cannot be used to probe whether an id exists.
    const { data, error } = await supabase
      .from("appointments")
      .select("id, studio_id, client_id, starts_at")
      .eq("id", appointmentId)
      .eq("studio_id", studio.id)
      .maybeSingle();

    if (error) return { status: "unavailable" };
    if (!data) return { status: "not_found" };
    // Belt and braces: the query already fences this, and a silent change to
    // the query above must not become a tenancy hole.
    if (data.studio_id !== studio.id) return { status: "not_found" };

    const loads = await loadLastChartedTreatmentsForClients({
      studioId: studio.id,
      requests: [
        {
          // Same appointment-bounded request shape the page uses. The
          // boundary and the exclusion are server-derived from the row.
          requestKey: data.id,
          clientId: data.client_id,
          before: data.starts_at,
          excludeAppointmentId: data.id,
        },
      ],
    });

    const load = loads.get(data.id);
    if (!load) return { status: "unavailable" };
    if (load.unavailable) return { status: "unavailable" };
    if (!load.treatment) return { status: "none" };

    return {
      status: "loaded",
      memory: buildAppointmentPrepMemory(
        prepMemoryInputFromTreatment(load.treatment),
      ),
    };
  } catch {
    // Never surface a provider or Postgres message to the browser. The row
    // renders "could not be loaded", which is the truthful thing to say and
    // says nothing about why.
    return { status: "unavailable" };
  }
}
