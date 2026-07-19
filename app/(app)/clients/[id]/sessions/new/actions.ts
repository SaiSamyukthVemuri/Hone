"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { getActiveTreatmentPlansForClient } from "@/lib/treatment-plans/queries";
import type { Modality } from "@/lib/types/database";
import { captureServerEvent } from "@/lib/analytics/server";

// PR #180. Loaded from a separate scope so the RPC call can use the
// service role (the mark_appointment_complete RPC is SECURITY DEFINER
// and expects the service-role context; calling it through the
// authenticated supabase client would still work but mirrors the
// pattern in app/(app)/calendar/actions.ts:markAppointmentCompleteAction).
// Dynamic import keeps the cold-path admin client out of every
// session-start request.
async function maybeMarkAppointmentCompletedOnSessionStart(args: {
  appointmentId: string;
  studioId: string;
  practitionerId: string;
  status: string;
  endsAt: string;
}): Promise<void> {
  // PR #180. Auto-complete contract:
  //   * Only confirmed appointments are eligible (cancelled / no_show /
  //     completed are explicitly skipped per the prompt's safety rules).
  //   * Only past appointments (ends_at <= now()) are sent to the RPC
  //     because the RPC refuses the future case anyway; calling it
  //     would just waste a roundtrip + log a noisy error.
  //   * Failure is fail-soft. The session has already been created;
  //     the practitioner can still mark the appointment completed by
  //     hand via the calendar Mark completed button (PR #180 also
  //     restores that). A failed auto-complete is logged but never
  //     thrown so the session-start UX is never blocked by it.
  if (args.status !== "confirmed") {
    return;
  }
  const endsAtMs = new Date(args.endsAt).getTime();
  if (!Number.isFinite(endsAtMs) || endsAtMs > Date.now()) {
    return;
  }
  try {
    const { createAdminClient } = await import("@/lib/supabase/admin-server");
    const admin = createAdminClient();
    const { error: rpcErr } = await admin.rpc("mark_appointment_complete", {
      p_appointment_id: args.appointmentId,
      p_studio_id: args.studioId,
      p_practitioner_id: args.practitionerId,
    });
    if (rpcErr) {
      console.error(
        JSON.stringify({
          event: "session_start_auto_mark_complete_rpc_error",
          appointmentId: args.appointmentId,
          code: rpcErr.code,
          message: rpcErr.message,
          timestamp: new Date().toISOString(),
        }),
      );
    } else {
      // Migration 0110: appointment is now completed — auto-send postcare if the
      // studio opted in. Fail-soft + idempotent (never throws), so a postcare
      // failure never blocks session start or completion.
      const { autoSendPostcareOnComplete } = await import(
        "@/app/(app)/calendar/postcare-auto-send"
      );
      await autoSendPostcareOnComplete(args.appointmentId, args.studioId);
    }
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "session_start_auto_mark_complete_threw",
        appointmentId: args.appointmentId,
        message: err instanceof Error ? err.message : String(err),
        timestamp: new Date().toISOString(),
      }),
    );
  }
}

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

  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  const supabase = await createClient();

  // PR #156. Validate the optional appointment lineage BEFORE touching
  // sessions. The lookup runs through the authenticated practitioner's
  // RLS client (no service role); the row is invisible unless the
  // practitioner has studio membership. We additionally re-assert
  // (studio_id, client_id) match the session being created. The form
  // value is treated as untrusted user input.
  let appointmentId: string | null = null;
  // PR #180. The auto-complete-on-session-start path also needs the
  // appointment's current status + ends_at; widen the SELECT here so
  // we make the decision off a single roundtrip. The values are only
  // consumed if appointmentId resolves successfully.
  let appointmentStatus: string | null = null;
  let appointmentEndsAt: string | null = null;
  if (typeof appointmentIdRaw === "string" && appointmentIdRaw.length > 0) {
    if (!UUID_RE.test(appointmentIdRaw)) {
      throw new Error("Invalid appointment id.");
    }
    const { data: appt, error: apptErr } = await supabase
      .from("appointments")
      .select("id, studio_id, client_id, practitioner_id, status, ends_at")
      .eq("id", appointmentIdRaw)
      .maybeSingle();
    if (apptErr) {
      throw new Error(`Failed to verify appointment: ${apptErr.message}`);
    }
    if (!appt) {
      throw new Error("Appointment not found.");
    }
    if (appt.studio_id !== studio.id) {
      // Studio mismatch is a hard reject: a tampered form value cannot
      // bind a session to another studio's appointment. RLS would
      // already have refused the lookup, but the check is defence in
      // depth.
      throw new Error("Appointment is not in your studio.");
    }
    if (appt.client_id !== clientId) {
      // Same studio, different client. Refuse: a session is per-client,
      // and linking it to another client's appointment would corrupt
      // both clients' treatment timelines.
      throw new Error("Appointment is for a different client.");
    }
    // PR #156 patch. Practitioner lineage: refuse a session-to-
    // appointment link when the appointment is assigned to a
    // different practitioner. The appointments table currently
    // allows practitioner_id to be non-null on every active booking
    // surface (public booking + calendar create both stamp the
    // practitioner), but historically a few legacy rows may carry
    // null; we treat null as "unassigned, anyone in the studio may
    // chart" rather than reject outright. Same-studio + same-client
    // is preserved as the absolute floor. The session itself still
    // records the current practitioner via the server-resolved
    // practitioner.id on the insert below; this check is about which
    // appointment the session links TO, not who performed it.
    if (appt.practitioner_id && appt.practitioner_id !== practitioner.id) {
      throw new Error("Appointment is assigned to a different practitioner.");
    }
    appointmentId = appt.id;
    appointmentStatus = (appt.status as string | null) ?? null;
    appointmentEndsAt = (appt.ends_at as string | null) ?? null;
  }

  const cutoff = new Date(Date.now() - COALESCE_MINUTES * 60 * 1000).toISOString();
  const { data: existing, error: lookupErr } = await supabase
    .from("sessions")
    .select("id, appointment_id")
    .eq("studio_id", studio.id)
    .eq("client_id", clientId)
    .eq("practitioner_id", practitioner.id)
    .eq("modality", modality as Modality)
    .gte("started_at", cutoff)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (lookupErr) {
    throw new Error(`Failed to look up session: ${lookupErr.message}`);
  }

  let sessionId: string;
  if (existing) {
    // Reusing a recent session (coalesce window): leave its treatment_plan_id
    // exactly as-is. Auto-attach only applies to genuinely new sessions, so
    // we never override a plan the practitioner already chose or detached.
    //
    // PR #156. appointment_id is the same shape: we never overwrite a
    // link the practitioner already chose. We DO promote a null link
    // to a verified appointment id (the practitioner clicked "Chart
    // session" from the appointment detail page; the existing row was
    // logged without that context); the row stays single-source-of-
    // truth for the visit and the FK gets stamped at the moment we
    // learn it. If the existing row already has a different
    // appointment_id we leave it; that scenario only happens if two
    // distinct write-forwards landed in the same 90-minute window and
    // is rare enough that silently keeping the older link is safer
    // than guessing.
    sessionId = existing.id;
    if (appointmentId && !existing.appointment_id) {
      const { error: updateErr } = await supabase
        .from("sessions")
        .update({ appointment_id: appointmentId })
        .eq("id", existing.id)
        .is("appointment_id", null);
      if (updateErr) {
        // Non-fatal: the session row is already valid and complete;
        // the missing FK is a memory hint, not a correctness invariant.
        // Log and continue so the practitioner is not blocked by an
        // alert-table write failure.
        console.error(
          JSON.stringify({
            event: "session_appointment_link_update_failed",
            sessionId: existing.id,
            appointmentId,
            code: updateErr.code,
            message: updateErr.message,
            timestamp: new Date().toISOString(),
          }),
        );
      }
    }
  } else {
    // Auto-attach (Session Logging Phase 2), electrolysis-only: treatment
    // plans, schedules, and planned-vs-actual TTT are electrolysis-centered,
    // so auto-attaching a laser session to an active electrolysis plan would
    // be confusing. Laser sessions are therefore never auto-attached (they
    // can still be attached manually on the session page). For an
    // electrolysis session, attach only when the client has exactly one
    // active plan; zero or multiple active plans → leave unattached (the
    // session page's TreatmentPlanAttachment widget shows a chooser for the
    // multiple case). Closed plans never qualify;
    // getActiveTreatmentPlansForClient filters to status='active' and scopes
    // by studio_id + client_id (a foreign client simply yields no plans).
    // No new query/action; reuses the existing helper. treatment_plan_id is
    // the only added insert field.
    let autoPlanId: string | null = null;
    if (modality === "electrolysis") {
      const activePlans = await getActiveTreatmentPlansForClient(
        studio.id,
        clientId,
      );
      if (activePlans.length === 1) autoPlanId = activePlans[0].id;
    }

    const { data, error } = await supabase
      .from("sessions")
      .insert({
        studio_id: studio.id,
        client_id: clientId,
        practitioner_id: practitioner.id,
        performed_by_practitioner_id: practitioner.id,
        modality: modality as Modality,
        treatment_plan_id: autoPlanId,
        // PR #156. Validated above against (studio_id, client_id);
        // null when the create flow had no appointment in scope.
        appointment_id: appointmentId,
      })
      .select("id")
      .single();
    if (error) {
      throw new Error(`Failed to start session: ${error.message}`);
    }
    sessionId = data.id;
  }

  // PR #180. Auto-mark the linked appointment completed BEFORE
  // revalidate so the calendar / appointment detail page sees the
  // new terminal status when the practitioner navigates back. The
  // call is gated to confirmed + past appointments (skipped for
  // cancelled / no_show / completed, and for future appointments
  // the RPC would refuse anyway). Fail-soft: the helper logs but
  // never throws so a failed auto-complete cannot break session
  // start. The practitioner can still complete the appointment
  // by hand via the calendar Mark completed button.
  if (appointmentId && appointmentStatus && appointmentEndsAt) {
    await maybeMarkAppointmentCompletedOnSessionStart({
      appointmentId,
      studioId: studio.id,
      practitionerId: practitioner.id,
      status: appointmentStatus,
      endsAt: appointmentEndsAt,
    });
    revalidatePath(`/calendar/${appointmentId}`);
  }

  // Post-response, bounded, never blocks the session-start redirect.
  captureServerEvent({
    distinctId: practitioner.id,
    event: "session_started",
    properties: {
      studio_id: studio.id,
      modality,
      is_new_session: !existing,
    },
  });

  revalidatePath(`/clients/${clientId}`);
  revalidatePath("/dashboard");
  redirect(`/clients/${clientId}/sessions/${sessionId}`);
}
