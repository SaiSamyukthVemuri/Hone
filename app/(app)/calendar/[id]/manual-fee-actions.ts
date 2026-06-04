"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import {
  getManualFeeChargeEligibility,
  MANUAL_FEE_INTERNAL_NOTE_MAX_LENGTH,
  type ManualFeeChargeType,
} from "@/lib/billing/manual-fee-eligibility";

// ---------------------------------------------------------------------------
// prepareManualFeeChargeAction (PR #145).
// ---------------------------------------------------------------------------
//
// Practitioner-only. Writes one manual_fee_charge_attempts row with
// status='ready' against the chosen (appointment, charge_type) pair.
//
// What this action does NOT do:
//   * No Stripe call. No PaymentIntent.create. No charge. No refund.
//   * No card retrieval from Stripe. The card data on the eligibility
//     summary comes from Hone's own client_payment_methods row.
//   * No email or SMS. No automatic anything.
//   * No fee amount accepted from the browser. Amount comes from
//     studios.<type>_fee_cents resolved server-side by the eligibility
//     helper.
//
// Inputs (FormData):
//   * appointment_id, charge_type, internal_note. studio_id and
//     practitioner_id are resolved server-side; the client cannot
//     supply them.
//
// Duplicate protection:
//   1. Pre-INSERT: eligibility helper refuses to mark eligible when an
//      active row already exists for (appointment, charge_type).
//   2. DB-level: partial unique index
//      manual_fee_charge_attempts_active_per_appt_type catches a
//      double-click / two-tab race; the insert raises 23505 and this
//      action returns the same calm error as the pre-INSERT path.

export type PrepareManualFeeChargeResult =
  | { ok: true; attemptId: string }
  | { ok: false; error: string; blockingReasons?: string[] };

const GENERIC_PRACTITIONER_ERROR =
  "We couldn't prepare this fee charge. Please refresh and try again.";
const NOT_AUTHORIZED_ERROR =
  "You don't have permission to prepare a fee charge for this appointment.";
const NOTE_REQUIRED_ERROR =
  "Add an internal note explaining the reason for this charge.";
const NOTE_TOO_LONG_ERROR =
  `Internal note must be under ${MANUAL_FEE_INTERNAL_NOTE_MAX_LENGTH} characters.`;
const INVALID_CHARGE_TYPE_ERROR =
  "Pick a charge type before preparing the fee charge.";
const DUPLICATE_ATTEMPT_ERROR =
  "A fee charge is already prepared for this appointment.";

function logInternal(event: string, detail: unknown) {
  try {
    console.error(
      JSON.stringify({
        event,
        detail,
        timestamp: new Date().toISOString(),
      }),
    );
  } catch {
    console.error(event, detail);
  }
}

function strOrEmpty(v: FormDataEntryValue | null): string {
  return typeof v === "string" ? v.trim() : "";
}

function isManualFeeChargeType(v: string): v is ManualFeeChargeType {
  return v === "late_cancel" || v === "no_show";
}

export async function prepareManualFeeChargeAction(
  formData: FormData,
): Promise<PrepareManualFeeChargeResult> {
  // Practitioner auth. The Stripe Connect Phase 1 backend already
  // requires a session for /calendar/[id] to render; this action
  // mirrors that by resolving the practitioner from the session
  // cookie via getCurrentPractitionerWithStudio. The studio_id used
  // for every subsequent lookup is the studio the practitioner
  // belongs to, never a value posted by the form.
  let practitionerId: string;
  let studioId: string;
  try {
    const { practitioner, studio } = await getCurrentPractitionerWithStudio();
    practitionerId = practitioner.id;
    studioId = studio.id;
  } catch (err) {
    logInternal("manual_fee_prepare_auth_failed", { err: String(err) });
    return { ok: false, error: NOT_AUTHORIZED_ERROR };
  }

  const appointmentId = strOrEmpty(formData.get("appointment_id"));
  const rawChargeType = strOrEmpty(formData.get("charge_type"));
  const internalNote = strOrEmpty(formData.get("internal_note"));

  if (!appointmentId) {
    return { ok: false, error: GENERIC_PRACTITIONER_ERROR };
  }
  if (!rawChargeType || !isManualFeeChargeType(rawChargeType)) {
    return { ok: false, error: INVALID_CHARGE_TYPE_ERROR };
  }
  if (internalNote.length === 0) {
    return { ok: false, error: NOTE_REQUIRED_ERROR };
  }
  if (internalNote.length > MANUAL_FEE_INTERNAL_NOTE_MAX_LENGTH) {
    return { ok: false, error: NOTE_TOO_LONG_ERROR };
  }

  const eligibility = await getManualFeeChargeEligibility({
    studioId,
    appointmentId,
    chargeType: rawChargeType,
  });
  if (!eligibility.eligible) {
    return {
      ok: false,
      error:
        "This appointment is not eligible for a fee charge right now.",
      blockingReasons: eligibility.blockingReasons,
    };
  }

  // Resolve client_id from the eligibility summary. The helper already
  // confirmed the appointment exists under our studio_id; .client.id is
  // populated when the appointment lookup succeeded.
  const clientId = eligibility.client.id;

  const admin = createAdminClient();
  const { data: inserted, error: insertErr } = await admin
    .from("manual_fee_charge_attempts")
    .insert({
      studio_id: studioId,
      appointment_id: appointmentId,
      client_id: clientId,
      confirmed_by_practitioner_id: practitionerId,
      charge_type: rawChargeType,
      amount_cents: eligibility.amountCents,
      currency: eligibility.currency,
      status: "ready",
      client_payment_method_id: eligibility.cardPaymentMethodId,
      card_authorization_signature_id:
        eligibility.cardAuthorizationSignatureId,
      appointment_policy_acknowledgement_id:
        eligibility.policyAcknowledgementId,
      policy_snapshot_hash: eligibility.policySnapshotHash,
      internal_note: internalNote,
      timing_classification: eligibility.timingClassification,
    })
    .select("id")
    .single();

  if (insertErr) {
    // Postgres unique violation code is 23505. The partial unique
    // index manual_fee_charge_attempts_active_per_appt_type catches
    // the race between two concurrent prepare submissions (e.g.
    // double-click, two-tab) that both passed the pre-INSERT
    // eligibility check. The user-facing error matches what we
    // would have shown if the pre-INSERT check had caught it.
    if (insertErr.code === "23505") {
      return { ok: false, error: DUPLICATE_ATTEMPT_ERROR };
    }
    logInternal("manual_fee_prepare_insert_failed", {
      code: insertErr.code,
      message: insertErr.message,
      appointmentId,
    });
    return { ok: false, error: GENERIC_PRACTITIONER_ERROR };
  }

  // Force the appointment detail page to re-render so the prepared
  // attempt shows up immediately.
  revalidatePath(`/calendar/${appointmentId}`);

  return { ok: true, attemptId: inserted.id };
}
