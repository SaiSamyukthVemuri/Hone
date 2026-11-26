"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import {
  mapSessionCommandError,
  GENERIC_SESSION_COMMAND_ERROR,
} from "@/lib/sessions/session-command-errors";
import {
  ASSIGNED_ELSEWHERE_RAISED,
  classifyAppointmentForStart,
  sessionStartRefusalHref,
  type StartAppointmentLookup,
} from "@/lib/sessions/session-start-refusal";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import type { Modality } from "@/lib/types/database";
import { captureServerEvent } from "@/lib/analytics/server";
import { startPerfSpan, timed } from "@/lib/observability/perf-timing";
import { dbErrorCode } from "@/lib/logging/error-class";

// HON-45 (Sam's decision): starting a chart does NOT complete the appointment. Completion is a separate,
// explicit act (the Finish appointment control on the session page, or Mark completed on the calendar),
// and it neither sends postcare nor takes payment. This reverses the PR #180 auto-complete on session start.

// Two "+ Log session" taps within this window for the same client +
// practitioner + modality reuse the same session row. Two genuinely
// separate visits (e.g. morning and afternoon) still produce two sessions.
const COALESCE_MINUTES = 90;

// PR #156 (migration 0068). Lightweight UUID v4-ish sanity check. The DB
// enforces the actual UUID validity via the appointment_id FK; this
// guard just refuses obviously-bad input early without a roundtrip and
// makes the error message stable. Empty / not-a-uuid simply collapses
// to "no appointment in context" rather than throwing, so a stale
// search-param doesn't break the create flow.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function startSessionAction(formData: FormData): Promise<void> {
  const clientId = formData.get("client_id");
  const modality = formData.get("modality");
  // PR #156. Optional appointment context. The new-session page
  // forwards ?appointment_id=... from the calendar appointment detail
  // surface or the client-page "Chart session" link on an uncharted
  // past appointment. Both surfaces already know the appointment id
  // server-side; this form field is just the carrier. Tampered values
  // are caught by the lineage check below.
  const appointmentIdRaw = formData.get("appointment_id");

  if (typeof clientId !== "string" || !clientId) {
    throw new Error("Missing client id.");
  }
  if (modality !== "electrolysis" && modality !== "laser") {
    throw new Error("Invalid modality.");
  }

  const { practitioner, studio } = await timed("session-start.identity", () =>
    getCurrentPractitionerWithStudio(),
  );
  const supabase = await createClient();

  // PR #156. Validate the optional appointment lineage BEFORE touching
  // sessions. The lookup runs through the authenticated practitioner's
  // RLS client (no service role); the row is invisible unless the
  // practitioner has studio membership. We additionally re-assert
  // (studio_id, client_id) match the session being created. The form
  // value is treated as untrusted user input.
  let appointmentId: string | null = null;
  if (typeof appointmentIdRaw === "string" && appointmentIdRaw.length > 0) {
    if (!UUID_RE.test(appointmentIdRaw)) {
      // Malformed: answered as a missing appointment, before any lookup.
      redirect(sessionStartRefusalHref(clientId, appointmentIdRaw, "appointment_missing"));
    }
    const { data: appt, error: apptErr } = await timed(
      "session-start.lineage",
      // async, not a bare arrow: a PostgREST builder is a THENABLE, not a
      // Promise, so timed<T> cannot accept it directly.
      async () =>
        await supabase
          .from("appointments")
          .select("id, studio_id, client_id, practitioner_id, status, ends_at")
          .eq("id", appointmentIdRaw)
          .maybeSingle(),
    );
    if (apptErr) {
      throw new Error(`Failed to verify appointment: ${dbErrorCode(apptErr)}`);
    }
    // Each refusal below is EXPECTED (a booking assigned to a colleague, a stale
    // link) and is answered by redirecting back to this client's new-session
    // page with a refusal code, which renders what happened. It used to be
    // thrown, which put the generic error boundary in front of the person.
    // The refusals themselves are unchanged and still happen BEFORE anything is
    // written; start_session (0181) re-enforces them at the database boundary.
    // ONE decision shared with the new-session page. A missing, not-visible or other-studio appointment is the SAME refusal (no existence oracle).
    const decided = classifyAppointmentForStart(appt as StartAppointmentLookup | null, { studioId: studio.id, clientId, practitionerId: practitioner.id });
    if (decided.refusal) {
      redirect(sessionStartRefusalHref(clientId, appointmentIdRaw, decided.refusal));
    }
    if (!appt) throw new Error("unreachable: a missing appointment was refused above");
    appointmentId = appt.id;
  }

  // L18 Phase 3: the coalesce lookup, the appointment-link promotion and the
  // insert are now ONE transaction via start_session (migration 0167).
  //
  // The old sequence read a recent session and then INSERTed if it found none,
  // a read-then-write window in which two concurrent "Start session" clicks
  // could both miss and create DUPLICATE sessions for a single visit. The
  // command takes the lookup FOR UPDATE, so the second caller blocks and then
  // reuses the row the first one created.
  //
  // Appointment validation (same studio, same client, unassigned-or-mine) and
  // the electrolysis-only single-active-plan auto-attach moved into the command
  // with it, so neither can drift from the write.
  //
  // 0181: p_studio_id is the EXPLICIT selected studio. It comes ONLY from
  // getCurrentPractitionerWithStudio() above: the server-side resolver that
  // honours the user's validated studio selection, and never from FormData,
  // searchParams or any other browser-supplied value. The browser does not
  // choose tenant scope.
  //
  // Before 0181 the command resolved the studio itself with an unordered
  // `limit 1` over every active membership, so a practitioner active in two
  // studios could render this page against the SELECTED studio (client found,
  // HTTP 200) and then have the command run against the OTHER one (client
  // absent → "Client not found in this studio." → HTTP 500). The value is
  // still not trusted: the command re-proves an active membership in this
  // studio at the SECURITY DEFINER boundary before it reads anything.
  const rpcSpan = startPerfSpan("session-start.rpc");
  let { data: startRows, error: startErr } = await supabase.rpc("start_session", {
    p_client_id: clientId,
    p_modality: modality as Modality,
    p_appointment_id: appointmentId,
    p_coalesce_minutes: COALESCE_MINUTES,
    p_studio_id: studio.id,
  });

  // REVERSE-SKEW FLOOR. 0181 keeps the four-argument signature so an OLD app
  // survives a NEW database. This handles the other direction: a NEW app
  // against an OLD database: a rolled-back migration, or a deploy that
  // outran the apply. There the five-argument command does not exist and
  // PostgREST answers PGRST202, which would fail EVERY session start for
  // EVERY practitioner, including the single-studio majority this incident
  // never touched. That is strictly worse than the bug being fixed.
  //
  // SAFE TO RETRY, and only because of what PGRST202 means: the function was
  // never RESOLVED, so nothing executed. There is no partial write to
  // duplicate. Exactly one retry, and ONLY on this code: any other error is
  // a real command outcome and is rethrown untouched.
  //
  // HONEST ABOUT WHAT THE FALLBACK IS: on a pre-0181 database the four-arg
  // signature is still 0167's, unordered `limit 1` and all. This does not fix
  // the defect there: it degrades to EXACTLY today's production behaviour
  // (correct for single-studio, the pre-existing bug for multi-studio)
  // instead of a total outage. It is a floor, not a fix. The event below is
  // the operational signal that the database is behind the application.
  if (startErr?.code === "PGRST202") {
    console.error(
      JSON.stringify({
        event: "start_session_studio_aware_signature_missing",
        // Structural only, no client, no practitioner, no studio identity.
        errorClass: "PGRST202",
        modality,
        hadAppointmentContext: appointmentId !== null,
        at: new Date().toISOString(),
      }),
    );
    ({ data: startRows, error: startErr } = await supabase.rpc("start_session", {
      p_client_id: clientId,
      p_modality: modality as Modality,
      p_appointment_id: appointmentId,
      p_coalesce_minutes: COALESCE_MINUTES,
    }));
  }
  rpcSpan.end();

  if (startErr) {
    // The command re-checks lineage; if the assignment changed between the
    // check above and the command (an owner reassigned it meanwhile), answer
    // the same expected refusal rather than the generic error boundary.
    if (appointmentId && mapSessionCommandError(startErr) === ASSIGNED_ELSEWHERE_RAISED) {
      redirect(sessionStartRefusalHref(clientId, appointmentId, "assigned_elsewhere"));
    }
    throw new Error(`Failed to start session: ${mapSessionCommandError(startErr)}`);
  }
  const started = Array.isArray(startRows)
    ? (startRows[0] as { session_id?: string; reused?: boolean } | undefined)
    : (startRows as { session_id?: string; reused?: boolean } | null);
  if (!started?.session_id) {
    throw new Error(`Failed to start session: ${GENERIC_SESSION_COMMAND_ERROR}`);
  }
  const sessionId: string = started.session_id;
  // The command reports whether it reused a session in the coalesce window,
  // which is exactly what the old `existing` lookup told the analytics event.
  const reusedExisting = started.reused === true;

  // CLN-002: an older command can coalesce appointment B onto A's chart.
  // Read the committed lineage through RLS before completing/postcare for B
  // or redirecting to that chart. Missing/unreadable lineage is not permission
  // to proceed. This also contains reverse skew until the additive command
  // repair is applied; it does not claim to repair the database's selection.
  if (appointmentId) {
    const { data: linkedSession, error: linkError } = await supabase
      .from("sessions")
      .select("appointment_id")
      .eq("id", sessionId)
      .eq("studio_id", studio.id)
      .eq("client_id", clientId)
      .maybeSingle();
    if (linkError || !linkedSession || linkedSession.appointment_id !== appointmentId) {
      throw new Error("The chart could not be linked to this appointment. Refresh the appointment and try again.");
    }
  }

  // The appointment detail page shows the linked session, so refresh it. The appointment's STATUS is untouched here.
  if (appointmentId) {
    revalidatePath(`/calendar/${appointmentId}`);
  }

  // Post-response, bounded, never blocks the session-start redirect.
  captureServerEvent({
    actor: { kind: "user", id: practitioner.id },
    event: "session_started",
    properties: {
      studio_id: studio.id,
      modality,
      is_new_session: !reusedExisting,
    },
  });

  const revalidateSpan = startPerfSpan("session-start.revalidate");
  revalidatePath(`/clients/${clientId}`);
  revalidatePath("/dashboard");
  revalidateSpan.end();
  redirect(`/clients/${clientId}/sessions/${sessionId}`);
}
