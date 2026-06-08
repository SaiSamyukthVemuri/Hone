"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import {
  getSessionPaymentEligibility,
} from "@/lib/billing/session-payment-eligibility";
import {
  SESSION_PAYMENT_AMOUNT_CEILING_CENTS,
  SESSION_PAYMENT_INTERNAL_NOTE_MAX_LENGTH,
} from "@/lib/billing/session-payment-types";

// ---------------------------------------------------------------------------
// prepareSessionPaymentChargeAction (PR #172).
// ---------------------------------------------------------------------------
//
// Practitioner-only. Writes one payment_charge_attempts row with
// charge_reason='session_payment' and status='ready' against the
// chosen session. v1: TEST MODE ONLY. The actual Stripe charge
// will live in a follow-up PR.
//
// What this action does NOT do:
//   * No Stripe call. No PaymentIntent.create. No charge. No refund.
//   * No card retrieval from Stripe. The card lineage on the
//     inserted row comes from the active client_payment_methods
//     row resolved by the eligibility helper.
//   * No email or SMS. No automatic anything.
//   * No client-side amount derivation. Amount comes from the
//     practitioner-confirmed form input, per PR #169's product
//     rule. The eligibility helper carries sessions.price_paid_cents
//     as a non-binding suggestion only.
//
// Inputs (FormData):
//   * session_id, amount_dollars, internal_note. studio_id,
//     client_id, and practitioner_id are resolved server-side; the
//     client cannot supply them. The action also re-reads
//     session.client_id from the eligibility result, so a form
//     post that names a different client_id is ignored.
//
// Duplicate protection:
//   1. Pre-INSERT: eligibility helper refuses to mark eligible
//      when an active row already exists for (session_id,
//      charge_reason='session_payment').
//   2. DB-level: partial unique index
//      payment_charge_attempts_active_session_payment_uniq
//      catches a double-click / two-tab race; the insert raises
//      23505 and this action returns the same calm error as the
//      pre-INSERT path.

export type PrepareSessionPaymentResult =
  | { ok: true; attemptId: string }
  | { ok: false; error: string; blockingReasons?: string[] };

const GENERIC_PRACTITIONER_ERROR =
  "We couldn't prepare this session payment. Please refresh and try again.";
const NOT_AUTHORIZED_ERROR =
  "You don't have permission to prepare a session payment in this studio.";
const NOTE_REQUIRED_ERROR =
  "Add an internal note explaining the reason for this session payment.";
const NOTE_TOO_LONG_ERROR =
  `Internal note must be under ${SESSION_PAYMENT_INTERNAL_NOTE_MAX_LENGTH} characters.`;
const AMOUNT_INVALID_ERROR =
  "Enter an amount greater than $0.00.";
const AMOUNT_TOO_LARGE_ERROR =
  `Amount must be $${(SESSION_PAYMENT_AMOUNT_CEILING_CENTS / 100).toFixed(0)} or less.`;
const DUPLICATE_ATTEMPT_ERROR =
  "A session payment attempt is already prepared for this session.";

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

// Parses an "amount in dollars" form value into integer cents.
// Rejects non-numeric, negative, zero, and >ceiling values. The
// CHECK constraint on payment_charge_attempts.amount_cents
// independently enforces > 0 and <= 200000; this parser surfaces
// a user-facing error before the DB rejects.
function parseAmountCents(raw: string): { ok: true; cents: number } | { ok: false; error: string } {
  const trimmed = raw.replace(/[,$\s]/g, "");
  if (trimmed.length === 0) return { ok: false, error: AMOUNT_INVALID_ERROR };
  const asNumber = Number(trimmed);
  if (!Number.isFinite(asNumber) || asNumber <= 0) {
    return { ok: false, error: AMOUNT_INVALID_ERROR };
  }
  const cents = Math.round(asNumber * 100);
  if (cents <= 0) return { ok: false, error: AMOUNT_INVALID_ERROR };
  if (cents > SESSION_PAYMENT_AMOUNT_CEILING_CENTS) {
    return { ok: false, error: AMOUNT_TOO_LARGE_ERROR };
  }
  return { ok: true, cents };
}

export async function prepareSessionPaymentChargeAction(
  formData: FormData,
): Promise<PrepareSessionPaymentResult> {
  // Practitioner auth. Same pattern as
  // prepareManualFeeChargeAction (PR #145). The session detail
  // page already required the practitioner to be authenticated
  // for the page to render; this action mirrors that gate so a
  // direct form post without a session is rejected.
  let practitionerId: string;
  let studioId: string;
  try {
    const { practitioner, studio } = await getCurrentPractitionerWithStudio();
    practitionerId = practitioner.id;
    studioId = studio.id;
  } catch (err) {
    logInternal("session_payment_prepare_auth_failed", { err: String(err) });
    return { ok: false, error: NOT_AUTHORIZED_ERROR };
  }

  const sessionId = strOrEmpty(formData.get("session_id"));
  const amountRaw = strOrEmpty(formData.get("amount_dollars"));
  const internalNote = strOrEmpty(formData.get("internal_note"));

  if (!sessionId) {
    return { ok: false, error: GENERIC_PRACTITIONER_ERROR };
  }
  const amountParsed = parseAmountCents(amountRaw);
  if (!amountParsed.ok) {
    return { ok: false, error: amountParsed.error };
  }
  if (internalNote.length === 0) {
    return { ok: false, error: NOTE_REQUIRED_ERROR };
  }
  if (internalNote.length > SESSION_PAYMENT_INTERNAL_NOTE_MAX_LENGTH) {
    return { ok: false, error: NOTE_TOO_LONG_ERROR };
  }

  const eligibility = await getSessionPaymentEligibility({
    studioId,
    sessionId,
  });
  if (!eligibility.eligible) {
    return {
      ok: false,
      error:
        "This session is not eligible for a session payment right now.",
      blockingReasons: eligibility.blockingReasons,
    };
  }

  // Resolve client_id from the eligibility summary. The helper
  // already confirmed the session exists under our studio_id and
  // returned the client tied to that row; we never read the
  // client_id from the form.
  const clientId = eligibility.client.id;
  const appointmentId = eligibility.appointment.id ?? null;

  const admin = createAdminClient();
  const { data: inserted, error: insertErr } = await admin
    .from("payment_charge_attempts")
    .insert({
      studio_id: studioId,
      charge_reason: "session_payment",
      client_id: clientId,
      // Stamp appointment_id when the session is appointment-linked
      // (the v1 chargeability proxy requires it). The reason_shape
      // CHECK keeps appointment_id OPTIONAL for session_payment so
      // a future freeform-session path does not need a migration to
      // relax the FK; for v1 every prepared row carries the
      // appointment_id.
      appointment_id: appointmentId,
      session_id: sessionId,
      created_by_practitioner_id: practitionerId,
      amount_cents: amountParsed.cents,
      currency: "cad",
      status: "ready",
      client_payment_method_id: eligibility.card.id,
      card_authorization_signature_id:
        eligibility.cardAuthorization.signatureId,
      stripe_account_id: eligibility.stripeAccountId,
      stripe_customer_id: eligibility.stripeCustomerId,
      stripe_payment_method_id: eligibility.stripePaymentMethodId,
      // The CHECK guarantees this is false; the explicit write is
      // intentional so a future PR that flips the default cannot
      // silently change the v1 row shape.
      stripe_livemode: false,
      internal_note: internalNote,
    })
    .select("id")
    .single();

  if (insertErr) {
    // Postgres unique violation code is 23505. The partial unique
    // index payment_charge_attempts_active_session_payment_uniq
    // catches the race between two concurrent prepare submissions
    // (e.g. double-click, two-tab) that both passed the pre-INSERT
    // eligibility check. The user-facing error matches what we
    // would have shown if the pre-INSERT check had caught it.
    if (insertErr.code === "23505") {
      return { ok: false, error: DUPLICATE_ATTEMPT_ERROR };
    }
    logInternal("session_payment_prepare_insert_failed", {
      code: insertErr.code,
      message: insertErr.message,
      sessionId,
    });
    return { ok: false, error: GENERIC_PRACTITIONER_ERROR };
  }

  // Force the session detail page to re-render so the prepared
  // attempt shows up immediately.
  revalidatePath(`/clients/${clientId}/sessions/${sessionId}`);

  return { ok: true, attemptId: inserted.id };
}
