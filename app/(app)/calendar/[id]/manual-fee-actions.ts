"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import {
  getManualFeeChargeEligibility,
  MANUAL_FEE_INTERNAL_NOTE_MAX_LENGTH,
  type ManualFeeChargeType,
} from "@/lib/billing/manual-fee-eligibility";
import { runSessionPaymentCharge } from "@/lib/billing/session-payment-charge";

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
// PR #201: refunds are owner-only across all charge reasons.
const OWNER_ONLY_REFUND_ERROR =
  "Only the studio owner can issue a refund.";
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

  // PR #196 unification: fee attempts write the CANONICAL
  // payment_charge_attempts ledger (charge_reason no_show_fee /
  // late_cancellation_fee) so they inherit receipts, refunds, webhook
  // reconciliation, and the live-mode guards. The legacy
  // manual_fee_charge_attempts table gets no new runtime writes.
  // Stripe lineage is frozen onto the row at prepare time, exactly
  // like session payments: card row + studio settings re-read here.
  const admin = createAdminClient();
  const { data: cardRow } = await admin
    .from("client_payment_methods")
    .select("id, stripe_account_id, stripe_customer_id, stripe_payment_method_id")
    .eq("id", eligibility.cardPaymentMethodId)
    .eq("studio_id", studioId)
    .maybeSingle();
  if (!cardRow) {
    return { ok: false, error: GENERIC_PRACTITIONER_ERROR };
  }
  const chargeReason =
    rawChargeType === "no_show" ? "no_show_fee" : "late_cancellation_fee";
  const { data: inserted, error: insertErr } = await admin
    .from("payment_charge_attempts")
    .insert({
      studio_id: studioId,
      appointment_id: appointmentId,
      client_id: clientId,
      created_by_practitioner_id: practitionerId,
      charge_reason: chargeReason,
      amount_cents: eligibility.amountCents,
      currency: eligibility.currency,
      status: "ready",
      stripe_livemode: false,
      client_payment_method_id: eligibility.cardPaymentMethodId,
      card_authorization_signature_id:
        eligibility.cardAuthorizationSignatureId,
      stripe_account_id: cardRow.stripe_account_id,
      stripe_customer_id: cardRow.stripe_customer_id,
      stripe_payment_method_id: cardRow.stripe_payment_method_id,
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

// ---------------------------------------------------------------------------
// chargeManualFeeAttemptAction (PR #146).
// ---------------------------------------------------------------------------
//
// Runs a TEST-MODE-ONLY Stripe PaymentIntent against an existing
// manual_fee_charge_attempts row whose status is 'ready' (or
// pending_stripe under the recovery branch). The heavy lifting lives
// in lib/billing/manual-fee-charge.ts:runManualFeeCharge; this action
// is the server-action entry point that:
//
//   * resolves the practitioner + studio from the session, so the
//     browser cannot supply either identity
//   * verifies the explicit confirm_charge flag
//   * forwards the attempt_id only
//   * surfaces the helper's result to the UI
//
// No browser-supplied amount, card id, studio id, client id, or
// charge type is read. Every value comes from the row resolved by
// attempt_id.

export type ChargeManualFeeAttemptResult =
  | {
      ok: true;
      outcome: "succeeded";
      stripePaymentIntentId: string;
      stripeChargeId: string | null;
    }
  | {
      ok: false;
      outcome:
        | "failed"
        | "needs_manual_review"
        | "blocked"
        | "live_mode_blocked"
        | "lineage_mismatch"
        | "not_found"
        | "not_authorized";
      error: string;
      blockingReasons?: string[];
      failureCode?: string | null;
    };

export async function chargeManualFeeAttemptAction(
  formData: FormData,
): Promise<ChargeManualFeeAttemptResult> {
  let practitionerId: string;
  let studioId: string;
  try {
    const { practitioner, studio } = await getCurrentPractitionerWithStudio();
    practitionerId = practitioner.id;
    studioId = studio.id;
  } catch (err) {
    logInternal("manual_fee_charge_auth_failed", { err: String(err) });
    return {
      ok: false,
      outcome: "not_authorized",
      error: NOT_AUTHORIZED_ERROR,
    };
  }

  const attemptId = strOrEmpty(formData.get("attempt_id"));
  const confirmCharge = strOrEmpty(formData.get("confirm_charge"));
  if (!attemptId) {
    return {
      ok: false,
      outcome: "not_found",
      error: GENERIC_PRACTITIONER_ERROR,
    };
  }
  if (confirmCharge !== "true") {
    return {
      ok: false,
      outcome: "blocked",
      error:
        "Confirm the charge before running it.",
    };
  }

  // PR #196: fee attempts execute through the unified canonical
  // executor (claim RPC + idempotency key + live-mode guards +
  // webhook-reconcilable metadata). authorization_not_current maps to
  // blocked for the card's existing outcome union.
  const raw = await runSessionPaymentCharge({
    attemptId,
    studioId,
    practitionerId,
  });
  const result =
    !raw.ok && raw.outcome === "authorization_not_current"
      ? { ...raw, outcome: "blocked" as const }
      : raw;

  // The detail page will read the updated row on next render.
  // We don't know the appointment id from here without another lookup;
  // we revalidate the broader /calendar path to cover both the detail
  // page and any list surfaces that show prepared attempts.
  revalidatePath("/calendar");

  if (result.ok) {
    return {
      ok: true,
      outcome: "succeeded",
      stripePaymentIntentId: result.stripePaymentIntentId,
      stripeChargeId: result.stripeChargeId,
    };
  }
  return {
    ok: false,
    outcome:
      result.outcome === "authorization_not_current"
        ? "blocked"
        : result.outcome,
    error: result.message,
    blockingReasons: result.blockingReasons,
    failureCode: result.failureCode ?? null,
  };
}

// ---------------------------------------------------------------------------
// cancelManualFeeChargeAttemptAction (PR #146).
// ---------------------------------------------------------------------------
//
// Practitioner withdraws a prepared 'ready' attempt without ever
// touching Stripe. This is NOT a refund. It moves a never-charged
// attempt to status='cancelled' and records who did it and why.
//
// Allowed transition: ready -> cancelled. The conditional UPDATE on
// status='ready' refuses any other source state (pending_stripe /
// succeeded / failed / blocked / cancelled).

const CANCEL_REASON_MAX = 500;

export type CancelManualFeeAttemptResult =
  | { ok: true }
  | { ok: false; error: string };

export async function cancelManualFeeChargeAttemptAction(
  formData: FormData,
): Promise<CancelManualFeeAttemptResult> {
  let practitionerId: string;
  let studioId: string;
  try {
    const { practitioner, studio } = await getCurrentPractitionerWithStudio();
    practitionerId = practitioner.id;
    studioId = studio.id;
  } catch (err) {
    logInternal("manual_fee_cancel_auth_failed", { err: String(err) });
    return { ok: false, error: NOT_AUTHORIZED_ERROR };
  }

  const attemptId = strOrEmpty(formData.get("attempt_id"));
  const reason = strOrEmpty(formData.get("cancelled_reason"));
  if (!attemptId) {
    return { ok: false, error: GENERIC_PRACTITIONER_ERROR };
  }
  if (reason.length === 0) {
    return {
      ok: false,
      error: "Add a short reason before cancelling the prepared fee.",
    };
  }
  if (reason.length > CANCEL_REASON_MAX) {
    return {
      ok: false,
      error: `Reason must be under ${CANCEL_REASON_MAX} characters.`,
    };
  }

  const admin = createAdminClient();
  // Conditional UPDATE on status='ready' refuses non-ready source
  // states atomically. We re-check studio_id as a defence-in-depth
  // against a future caller that forgets to pass an attempt scoped
  // to this practitioner's studio.
  const { data, error } = await admin
    .from("payment_charge_attempts")
    .update({
      status: "cancelled",
      cancelled_at: new Date().toISOString(),
      cancelled_by_practitioner_id: practitionerId,
      cancelled_reason: reason,
    })
    .eq("id", attemptId)
    .eq("studio_id", studioId)
    .eq("status", "ready")
    .select("id, appointment_id")
    .maybeSingle();
  if (error) {
    logInternal("manual_fee_cancel_update_failed", {
      code: error.code,
      message: error.message,
      attemptId,
    });
    return { ok: false, error: GENERIC_PRACTITIONER_ERROR };
  }
  if (!data) {
    return {
      ok: false,
      error: "This prepared fee can no longer be cancelled.",
    };
  }

  revalidatePath(`/calendar/${data.appointment_id}`);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// PR #196: receipt + refund for fee attempts. Thin wrappers over the
// reason-agnostic canonical helpers; same auth shape as the session
// payment actions, revalidating the appointment page instead.
// ---------------------------------------------------------------------------
import { sendPaymentChargeReceipt } from "@/lib/billing/payment-receipt";
import { refundPaymentChargeAttempt } from "@/lib/billing/payment-refund";

export type FeeReceiptActionResult = { ok: true } | { ok: false; error: string };

export async function sendFeeReceiptAction(
  formData: FormData,
): Promise<FeeReceiptActionResult> {
  let practitionerId: string, studioId: string;
  try {
    const { practitioner, studio } = await getCurrentPractitionerWithStudio();
    practitionerId = practitioner.id;
    studioId = studio.id;
  } catch {
    return { ok: false, error: NOT_AUTHORIZED_ERROR };
  }
  const attemptId = strOrEmpty(formData.get("attempt_id"));
  const appointmentId = strOrEmpty(formData.get("appointment_id"));
  if (!attemptId || !appointmentId) {
    return { ok: false, error: GENERIC_PRACTITIONER_ERROR };
  }
  const result = await sendPaymentChargeReceipt({
    attemptId,
    studioId,
    practitionerId,
  });
  revalidatePath(`/calendar/${appointmentId}`);
  if (!result.ok) return { ok: false, error: result.message };
  return { ok: true };
}

export async function refundFeeAttemptAction(
  formData: FormData,
): Promise<FeeReceiptActionResult> {
  let practitionerId: string, studioId: string;
  try {
    const { practitioner, studio } = await getCurrentPractitionerWithStudio();
    // PR #201 (live payments gate preparation): refunds are
    // OWNER-ONLY, consistently across session payments and fees
    // (same rule as refundPaymentChargeAttemptAction).
    if (practitioner.role !== "owner") {
      return { ok: false, error: OWNER_ONLY_REFUND_ERROR };
    }
    practitionerId = practitioner.id;
    studioId = studio.id;
  } catch {
    return { ok: false, error: NOT_AUTHORIZED_ERROR };
  }
  const attemptId = strOrEmpty(formData.get("attempt_id"));
  const appointmentId = strOrEmpty(formData.get("appointment_id"));
  if (!attemptId || !appointmentId) {
    return { ok: false, error: GENERIC_PRACTITIONER_ERROR };
  }
  const result = await refundPaymentChargeAttempt({
    attemptId,
    studioId,
    practitionerId,
  });
  revalidatePath(`/calendar/${appointmentId}`);
  if (!result.ok) return { ok: false, error: result.message };
  return { ok: true };
}
