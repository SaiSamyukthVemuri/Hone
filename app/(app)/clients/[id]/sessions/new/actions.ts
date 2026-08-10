"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import {
  mapSessionCommandError,
  GENERIC_SESSION_COMMAND_ERROR,
} from "@/lib/sessions/session-command-errors";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
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
      await autoSendPostcareOnComplete(args.appointmentId, args.studioId, args.practitionerId);
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

  // L18 Phase 3: the coalesce lookup, the appointment-link promotion and the
  // insert are now ONE transaction via start_session (migration 0167).
  //
  // The old sequence read a recent session and then INSERTed if it found none —
  // a read-then-write window in which two concurrent "Start session" clicks
  // could both miss and create DUPLICATE sessions for a single visit. The
  // command takes the lookup FOR UPDATE, so the second caller blocks and then
  // reuses the row the first one created.
  //
  // Appointment validation (same studio, same client, unassigned-or-mine) and
  // the electrolysis-only single-active-plan auto-attach moved into the command
  // with it, so neither can drift from the write.
  const { data: startRows, error: startErr } = await supabase.rpc("start_session", {
    p_client_id: clientId,
    p_modality: modality as Modality,
    p_appointment_id: appointmentId,
    p_coalesce_minutes: COALESCE_MINUTES,
  });
  if (startErr) {
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
    actor: { kind: "user", id: practitioner.id },
    event: "session_started",
    properties: {
      studio_id: studio.id,
      modality,
      is_new_session: !reusedExisting,
    },
  });

  revalidatePath(`/clients/${clientId}`);
  revalidatePath("/dashboard");
  redirect(`/clients/${clientId}/sessions/${sessionId}`);
}
