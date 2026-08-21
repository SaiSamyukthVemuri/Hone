"use server";

import { createClient } from "@/lib/supabase/server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { loadVisitPreparation } from "@/lib/sessions/history/prepare-visit";
import {
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
// The rule this enforces: before the practitioner explicitly opens a row, the
// full model has not crossed to the browser at all.
//
// This is data minimisation inside an already-authorised session, not a
// tenancy fix — the studio fence was never in doubt. It is the difference
// between "she may read this" and "her browser was handed all of it up front".

/** Explicit outcome. `none` and `unavailable` are different facts. */
export type PrepMemoryResult =
  | { status: "loaded"; memory: AppointmentPrepMemory }
  | { status: "none" }
  | { status: "unavailable" };

/**
 * Resolve the full previous treatment for ONE appointment.
 *
 * The browser sends only an appointment id — it says WHAT the practitioner
 * wants to open. Everything that governs whether she may have it is resolved
 * here: her identity, her current studio, and the appointment's own tenancy.
 * The client id and the history cutoff are read from the appointment row on
 * the server, never accepted from the caller, so a forged client id or an
 * altered `before` cannot widen the answer.
 */
export async function loadAppointmentPrepMemory(
  appointmentId: string,
): Promise<PrepMemoryResult> {
  if (typeof appointmentId !== "string" || appointmentId.length === 0) {
    return { status: "unavailable" };
  }

  try {
    const { studio } = await getCurrentPractitionerWithStudio();
    const supabase = await createClient();

    // Fenced on BOTH sides: the id the browser supplied and the studio the
    // server resolved. A foreign appointment returns the same shape as a
    // missing one, so this cannot be used to probe whether an id exists.
    const { data, error } = await supabase
      .from("appointments")
      .select("id, studio_id, client_id, starts_at")
      .eq("id", appointmentId)
      .eq("studio_id", studio.id)
      .maybeSingle();

    if (error) return { status: "unavailable" };
    if (!data) return { status: "none" };
    // Belt and braces: the query already fences this, and a silent change to
    // the query above must not become a tenancy hole.
    if (data.studio_id !== studio.id) return { status: "none" };

    // THE EXACT-VISIT DISCLOSURE, through the same authority the row used.
    //
    // Authority is re-derived here, not carried from the browser: the studio,
    // the client, the boundary and the exclusion all come from the appointment
    // row fetched above, so an id from another studio resolves to nothing.
    //
    // The full clinical record is read ONLY at this point — one visit, on
    // demand, because the practitioner asked. Nothing on the roster path
    // transported it.
    const prep = await loadVisitPreparation({
      studioId: studio.id,
      // Same appointment-bounded request shape the page uses. The boundary and
      // the exclusion are server-derived from the row.
      clientId: data.client_id,
      before: data.starts_at,
      excludeAppointmentId: data.id,
    });

    const treatment = prep.preparation.treatment;
    // A VARIANT, not a boolean beside the data. `no-prior-visit` is the only
    // proven absence; everything else is "we could not establish it", and the
    // row already owns truthful operational copy for that.
    if (treatment.kind === "evidence-unavailable") return { status: "unavailable" };
    if (treatment.kind === "no-prior-visit") return { status: "none" };
    if (!prep.memory) return { status: "unavailable" };

    // Built by the authority's own adapter, whose every evidence channel is a
    // required parameter — so this surface cannot receive a different subset of
    // the clinical record from the one the appointment page renders.
    return { status: "loaded", memory: prep.memory };
  } catch {
    // Never surface a provider or Postgres message to the browser. The row
    // renders "could not be loaded", which is the truthful thing to say and
    // says nothing about why.
    return { status: "unavailable" };
  }
}
