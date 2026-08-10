import { sendPostcareToClient } from "@/lib/email/send-appointment";
import type { Studio } from "@/lib/types/database";

// Postcare auto-send (migration 0110). When a studio opts into
// postcare_delivery_mode = 'auto_on_complete', postcare is sent automatically
// after an appointment is marked complete — no manual "Send postcare" click.
//
// Design guarantees (SaaS-ready):
//   * SHARES the appointments.postcare_email_* claim columns with the manual
//     sender, so the two paths are MUTUALLY IDEMPOTENT — postcare is sent at
//     most once even if auto + manual both run.
//   * NEVER sends for cancelled/no_show — the claim UPDATE requires
//     status = 'completed'.
//   * Reuses the EXISTING SAFE postcare email (studio settings only; no
//     clinical/intake data). No new email variant, no health data.
//   * FAIL-SOFT: never throws. A send failure must never fail appointment
//     completion. Failures are recorded (failed_at + safe last_error) and
//     resendable from the appointment page.
//   * Studio-scoped: every query filters studio_id.

const POSTCARE_CLAIM_STALE_MS = 5 * 60_000;

export type PostcareAutoOutcome =
  | "sent"
  | "failed"
  | "not_claimed"
  | "skipped_mode"
  | "skipped_not_completed"
  | "skipped_consultation"
  | "skipped_no_email"
  | "skipped_no_aftercare"
  | "load_error"
  | "threw";

// Pure eligibility gate (unit-testable). Auto-send ONLY when: the studio opted
// into auto_on_complete; the appointment is completed (never cancelled/no_show);
// it is not a bare consultation (the auto path has no "treatment performed"
// attestation, so consultations are skipped for safety); the client has an
// email; and the studio has aftercare text configured.
export function shouldAutoSendPostcare(a: {
  deliveryMode: string | null | undefined;
  status: string | null | undefined;
  serviceModality: string | null | undefined;
  clientEmail: string | null | undefined;
  aftercareText: string | null | undefined;
}): { ok: true } | { ok: false; reason: PostcareAutoOutcome } {
  if (a.deliveryMode !== "auto_on_complete") return { ok: false, reason: "skipped_mode" };
  if (a.status !== "completed") return { ok: false, reason: "skipped_not_completed" };
  if (a.serviceModality === "consultation")
    return { ok: false, reason: "skipped_consultation" };
  if (!a.clientEmail || a.clientEmail.trim().length === 0)
    return { ok: false, reason: "skipped_no_email" };
  if (!a.aftercareText || a.aftercareText.trim().length === 0)
    return { ok: false, reason: "skipped_no_aftercare" };
  return { ok: true };
}

function safeAutoLastError(retryable: boolean): string {
  return retryable
    ? "Automatic postcare send failed (temporary). Resend it from the appointment page."
    : "Automatic postcare send failed. Resend it from the appointment page.";
}

function pickOne<T>(v: T | T[] | null | undefined): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}

function logOutcome(appointmentId: string, outcome: PostcareAutoOutcome): PostcareAutoOutcome {
  // Observability: one structured line per auto-send decision (never PII).
  console.log(
    JSON.stringify({
      event: "postcare_auto_send",
      appointmentId,
      outcome,
      timestamp: new Date().toISOString(),
    }),
  );
  return outcome;
}

// Minimal structural type for the admin client so tests can inject a fake.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AdminLike = { from: (table: string) => any; rpc: (fn: string, args: Record<string, unknown>) => any };

type StudioPostcareRow = {
  id: string;
  name: string;
  owner_email: string;
  timezone: string;
  postcare_delivery_mode: string | null;
  postcare_aftercare_text: string | null;
  postcare_warning_signs_text: string | null;
  postcare_product_recommendations_text: string | null;
  postcare_review_url: string | null;
  postcare_review_prompt_text: string | null;
  postcare_contact_email: string | null;
};

// Idempotent, FAIL-SOFT postcare auto-send. Call after an appointment is marked
// complete; it is a no-op unless the studio opted into auto_on_complete. Returns
// an outcome for logging/tests; it NEVER throws.
export async function autoSendPostcareOnComplete(
  appointmentId: string,
  studioId: string,
  // B8 / 0177: the SERVER-RESOLVED practitioner completing the appointment.
  // The database authenticates the actor, so auto-send needs a real one — and
  // both completion call sites already have it. Inventing a system actor would
  // have put an identity in the boundary that no human is accountable for.
  actorPractitionerId: string,
  deps?: {
    admin?: AdminLike;
    sendPostcare?: typeof sendPostcareToClient;
  },
): Promise<PostcareAutoOutcome> {
  try {
    let admin = deps?.admin;
    if (!admin) {
      const { createAdminClient } = await import("@/lib/supabase/admin-server");
      admin = createAdminClient() as unknown as AdminLike;
    }
    const send = deps?.sendPostcare ?? sendPostcareToClient;

    const { data: appt, error: loadErr } = await admin
      .from("appointments")
      .select(
        "id, status, starts_at, postcare_email_sent_at, postcare_email_send_attempts, client:clients(name, email), service:services(name, modality), studio:studios(id, name, owner_email, timezone, postcare_delivery_mode, postcare_aftercare_text, postcare_warning_signs_text, postcare_product_recommendations_text, postcare_review_url, postcare_review_prompt_text, postcare_contact_email), practitioner:practitioners!appointments_practitioner_same_studio_fk(display_name)",
      )
      .eq("id", appointmentId)
      .eq("studio_id", studioId)
      .maybeSingle();
    if (loadErr || !appt) return logOutcome(appointmentId, "load_error");

    const client = pickOne(appt.client as { name: string | null; email: string | null } | null);
    const service = pickOne(appt.service as { name: string | null; modality: string | null } | null);
    const studio = pickOne(appt.studio as StudioPostcareRow | null);
    const performer = pickOne(appt.practitioner as { display_name: string | null } | null);
    if (!studio) return logOutcome(appointmentId, "load_error");

    const gate = shouldAutoSendPostcare({
      deliveryMode: studio.postcare_delivery_mode as string | null | undefined,
      status: appt.status as string | null | undefined,
      serviceModality: service?.modality,
      clientEmail: client?.email,
      aftercareText: studio.postcare_aftercare_text as string | null | undefined,
    });
    if (!gate.ok) return logOutcome(appointmentId, gate.reason);

    // Idempotent FIRST-SEND claim (mirrors the manual sendPostcareEmailAction):
    // only a COMPLETED, not-yet-sent appointment with no fresh claim is claimed.
    // .select("id") proves exactly one row was won, so a duplicate completion
    // (or a concurrent manual send) cannot double-send. The status='completed'
    // filter is the belt-and-suspenders guard against cancelled/no_show.
    // B8 / 0177 — CLAIM THROUGH THE COMMAND. The database owns the claim
    // timestamp, the attempt counter, the five-minute stale window, the
    // completed-only rule and the actor check; this helper owns none of them.
    const { data: claimRows, error: claimErr } = await admin.rpc(
      "claim_postcare_send",
      {
        p_appointment_id: appointmentId,
        p_studio_id: studioId,
        p_actor_practitioner_id: actorPractitionerId,
        p_is_resend: false,
      },
    );
    const claim = (Array.isArray(claimRows) ? claimRows[0] : claimRows) as
      | { result: string; claimed_at: string | null }
      | null
      | undefined;
    // Any refusal — including the app-first window where 0177 is not yet
    // applied and the function does not exist — ends here, BEFORE the provider.
    // There is deliberately no direct-UPDATE fallback.
    if (claimErr || !claim || claim.result !== "claimed" || !claim.claimed_at) {
      return logOutcome(appointmentId, "not_claimed");
    }
    // Forwarded byte-for-byte; re-deriving it would break the token.
    const claimToken = claim.claimed_at;

    const result = await send({
      clientName: client?.name ?? "",
      clientEmail: client!.email as string,
      studio: studio as unknown as Studio,
      practitionerName: performer?.display_name ?? null,
      serviceName: service?.name ?? null,
      startsAt: appt.starts_at ? new Date(appt.starts_at as string) : null,
      aftercareText: (studio.postcare_aftercare_text as string | null) ?? null,
      warningSignsText: (studio.postcare_warning_signs_text as string | null) ?? null,
      productRecommendationsText:
        (studio.postcare_product_recommendations_text as string | null) ?? null,
      reviewUrl: (studio.postcare_review_url as string | null) ?? null,
      reviewPromptText: (studio.postcare_review_prompt_text as string | null) ?? null,
    });

    if (!result.ok) {
      // Record the failure honestly (safe generic last_error, never raw
      // provider/PII) and clear the claim so it stays resendable. Do NOT set
      // sent_at — a failed first send stays "not sent".
      // Settle the failure under the exact token. Safe copy is derived in SQL
      // from `retryable` alone; no provider text crosses this boundary.
      await admin.rpc("settle_postcare_send", {
        p_appointment_id: appointmentId,
        p_studio_id: studioId,
        p_claimed_at: claimToken,
        p_success: false,
        p_retryable: result.retryable ?? false,
      });
      return logOutcome(appointmentId, "failed");
    }

    // Provider success — now (and only now) stamp sent_at and clear failure +
    // claim. The appointment page's existing status UI reflects this.
    // Settle the success under the exact token. The DB clock stamps sent_at.
    await admin.rpc("settle_postcare_send", {
      p_appointment_id: appointmentId,
      p_studio_id: studioId,
      p_claimed_at: claimToken,
      p_success: true,
      p_retryable: false,
    });
    return logOutcome(appointmentId, "sent");
  } catch (err) {
    // FAIL-SOFT: a postcare auto-send failure must NEVER fail appointment
    // completion. Swallow + log.
    console.error(
      JSON.stringify({
        event: "postcare_auto_send_threw",
        appointmentId,
        message: err instanceof Error ? err.message : String(err),
        timestamp: new Date().toISOString(),
      }),
    );
    return "threw";
  }
}
