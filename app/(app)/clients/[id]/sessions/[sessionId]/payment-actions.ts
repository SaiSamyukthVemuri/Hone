"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { inferStripeLivemode } from "@/lib/stripe/server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { captureServerEvent } from "@/lib/analytics/server";
import {
  getAuthoritativeSessionPaymentAmount,
  loadFailureMessage,
} from "@/lib/billing/authoritative-session-payment";
import { unresolvedAmountMessage } from "@/lib/billing/session-payment-amount";
import {
  getSessionPaymentEligibility,
} from "@/lib/billing/session-payment-eligibility";
import {
  SESSION_PAYMENT_AMOUNT_CEILING_CENTS,
  SESSION_PAYMENT_INTERNAL_NOTE_MAX_LENGTH,
} from "@/lib/billing/session-payment-types";
import {
  runSessionPaymentCharge,
  type SessionPaymentChargeResult,
} from "@/lib/billing/session-payment-charge";
import {
  sendPaymentChargeReceipt,
  type SendPaymentChargeReceiptResult,
} from "@/lib/billing/payment-receipt";
import {
  refundPaymentChargeAttempt,
  type PaymentRefundResult,
} from "@/lib/billing/payment-refund";

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
//   * session_id, expected_amount_cents, internal_note. studio_id,
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
// PR #201: refunds are owner-only across all charge reasons.
const OWNER_ONLY_REFUND_ERROR =
  "Only the studio owner can issue a refund.";
// PR (Chloe workflow fix): the internal note is OPTIONAL. A blank or
// whitespace-only note is stored as NULL (never a fabricated
// placeholder); a non-empty note is preserved verbatim and still
// length-capped. There is intentionally no "note required" error.
const NOTE_TOO_LONG_ERROR =
  `Internal note must be under ${SESSION_PAYMENT_INTERNAL_NOTE_MAX_LENGTH} characters.`;
const AMOUNT_INVALID_ERROR =
  "Enter an amount greater than $0.00.";
const AMOUNT_TOO_LARGE_ERROR =
  `Amount must be $${(SESSION_PAYMENT_AMOUNT_CEILING_CENTS / 100).toFixed(0)} or less.`;
// The ceiling now applies to a price the practitioner CANNOT edit, so telling
// her the amount "must be $X or less" would be unactionable. Point at the
// pricing instead, which is the thing she can actually change.
const AUTHORITATIVE_AMOUNT_TOO_LARGE_ERROR =
  `This configured price is above the supported session-payment limit of $${(
    SESSION_PAYMENT_AMOUNT_CEILING_CENTS / 100
  ).toFixed(0)}. Review the pricing before preparing payment.`;
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

// Parses the browser's expected_amount_cents. This is a STALE-DISPLAY CHECK,
// never authority: it can only cause a rejection, never decide a value.
function parseExpectedCents(
  raw: string,
): { ok: true; cents: number } | { ok: false } {
  if (!/^\d+$/.test(raw)) return { ok: false };
  const cents = Number(raw);
  if (!Number.isSafeInteger(cents) || cents <= 0) return { ok: false };
  return { ok: true, cents };
}

// Safe, fixed copy for a price that moved (or a request that could not say
// what it was showing). Never leaks a DB error or the other amount.
const PRICE_CHANGED_ERROR =
  "The price changed. Refresh and review the current amount before preparing payment.";

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
  let studioTimezone: string;
  try {
    const { practitioner, studio } = await getCurrentPractitionerWithStudio();
    practitionerId = practitioner.id;
    studioId = studio.id;
    studioTimezone = studio.timezone;
  } catch (err) {
    logInternal("session_payment_prepare_auth_failed", { err: String(err) });
    return { ok: false, error: NOT_AUTHORIZED_ERROR };
  }

  const sessionId = strOrEmpty(formData.get("session_id"));
  // F-PAY-001: `amount_dollars` is NOT read. The browser no longer decides the
  // amount; it only tells us which amount it was showing, so a price that moved
  // since the practitioner looked at it can be caught instead of charged.
  const expectedRaw = strOrEmpty(formData.get("expected_amount_cents"));
  const internalNote = strOrEmpty(formData.get("internal_note"));

  if (!sessionId) {
    return { ok: false, error: GENERIC_PRACTITIONER_ERROR };
  }
  const expected = parseExpectedCents(expectedRaw);
  if (!expected.ok) {
    // Missing or malformed: insert nothing. A request that cannot say what it
    // was showing cannot be confirmed against the current price.
    return { ok: false, error: PRICE_CHANGED_ERROR };
  }
  // The internal note is optional (blank/whitespace-only -> NULL, see the
  // insert below). Only the maximum-length cap is enforced here; it still
  // matches the manual-fee ceiling constant and guards against oversized
  // input before the DB is touched.
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

  // THE AMOUNT DECISION. Independently re-loaded from current records — not
  // from the page's props, not from the modal's state, and not from the form.
  // This is the whole point of F-PAY-001: the value inserted below is derived
  // here, server-side, at the moment of preparation.
  const priced = await getAuthoritativeSessionPaymentAmount({
    studioId,
    sessionId,
    studioTimezone,
  });
  if (!priced.ok) {
    return { ok: false, error: loadFailureMessage(priced.failure) };
  }
  // FREE-01. A deliberately $0 service is not a pricing failure — it is a
  // decided price of nothing. It stops here with a calm explanation rather than
  // a warning, and critically it returns BEFORE any payment_charge_attempt is
  // written, so a free visit can never become a chargeable row.
  if (priced.result.kind === "free") {
    return {
      ok: false,
      error: `${priced.result.serviceName} is free — no payment is required, so there is nothing to prepare.`,
    };
  }
  if (priced.result.kind !== "resolved") {
    return { ok: false, error: unresolvedAmountMessage(priced.result) };
  }
  const authoritativeCents = priced.result.amountCents;

  // The ceiling applies to the AUTHORITATIVE amount. It is never clamped and
  // never replaced by the browser's value: a price above the supported ceiling
  // is a pricing problem for a human to look at, not something to quietly
  // reduce.
  if (authoritativeCents > SESSION_PAYMENT_AMOUNT_CEILING_CENTS) {
    return { ok: false, error: AUTHORITATIVE_AMOUNT_TOO_LARGE_ERROR };
  }

  // Stale-display check. If the price moved between render and submit, insert
  // nothing and make the practitioner re-read the new amount. Preparing at a
  // number she never saw would be exactly the failure this PR exists to remove.
  if (expected.cents !== authoritativeCents) {
    return { ok: false, error: PRICE_CHANGED_ERROR };
  }

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
      amount_cents: authoritativeCents,
      currency: "cad",
      status: "ready",
      client_payment_method_id: eligibility.card.id,
      card_authorization_signature_id:
        eligibility.cardAuthorization.signatureId,
      stripe_account_id: eligibility.stripeAccountId,
      stripe_customer_id: eligibility.stripeCustomerId,
      stripe_payment_method_id: eligibility.stripePaymentMethodId,
      // PR #323: write the current deployment mode. In test env this is false
      // (identical to before); the new payment_charge_attempts_live_requires_
      // account_check (0101) is satisfied because stripe_account_id is set above.
      stripe_livemode: inferStripeLivemode(),
      // Optional note: store NULL when blank/whitespace-only (strOrEmpty
      // already trimmed it), never a fabricated placeholder. A real note is
      // written verbatim. Mirrors the refund path's blank-to-null idiom below.
      internal_note: internalNote.length > 0 ? internalNote : null,
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

// ---------------------------------------------------------------------------
// executeSessionPaymentChargeAction (PR #173).
// ---------------------------------------------------------------------------
//
// Practitioner-only. Runs a TEST-MODE-ONLY Stripe PaymentIntent
// against an existing payment_charge_attempts row whose status is
// 'ready' (or 'pending_stripe' on the reconciliation branch).
// The heavy lifting lives in lib/billing/session-payment-charge.ts
// :runSessionPaymentCharge; this action is the server-action entry
// point that:
//
//   * resolves the practitioner + studio from the session, so the
//     browser cannot supply either identity
//   * verifies the explicit confirm_charge flag (defence against
//     accidental double-click charges via a hand-crafted form post)
//   * forwards the attempt_id only
//   * surfaces the helper's result to the UI
//
// No browser-supplied amount, card id, studio id, client id, or
// session id is read. Every value comes from the row resolved by
// attempt_id.

export type ExecuteSessionPaymentResult =
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
        | "authorization_not_current"
        | "not_found"
        | "not_authorized";
      error: string;
      blockingReasons?: string[];
      failureCode?: string | null;
    };

export async function executeSessionPaymentChargeAction(
  formData: FormData,
): Promise<ExecuteSessionPaymentResult> {
  let practitionerId: string;
  let studioId: string;
  let studioTimezone: string;
  try {
    const { practitioner, studio } = await getCurrentPractitionerWithStudio();
    practitionerId = practitioner.id;
    studioId = studio.id;
    studioTimezone = studio.timezone;
  } catch (err) {
    logInternal("session_payment_execute_auth_failed", { err: String(err) });
    return {
      ok: false,
      outcome: "not_authorized",
      error: NOT_AUTHORIZED_ERROR,
    };
  }

  const attemptId = strOrEmpty(formData.get("attempt_id"));
  const confirmCharge = strOrEmpty(formData.get("confirm_charge"));
  // Optional context fields used only to construct the
  // revalidatePath after a terminal-state result. Never trusted
  // for any execution decision; the action reads everything from
  // the row.
  const clientId = strOrEmpty(formData.get("client_id"));
  const sessionId = strOrEmpty(formData.get("session_id"));

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
      // Mode-aware (PR C): a LIVE operator must never be told a real
      // charge is a "test charge" at the confirmation step.
      error: inferStripeLivemode()
        ? "Confirm the charge before running it."
        : "Confirm the test charge before running it.",
    };
  }

  // FREE-01 / review 3777045531. A `ready` attempt prepared at a POSITIVE price
  // survives a later change of the service to $0. This action otherwise works
  // purely from the stored row, so it would happily charge the stale positive
  // amount for a visit every other surface now presents as "No payment
  // required". Re-resolve the CURRENT authoritative price and refuse if it is
  // free.
  //
  // The session id is read from the attempt ROW, never from the browser — the
  // form's session_id is used only for revalidatePath and is untrusted here.
  // The lookup is studio-scoped, so it cannot reach another tenant's attempt.
  {
    const admin = createAdminClient();
    const { data: attemptRow } = await admin
      .from("payment_charge_attempts")
      .select("session_id")
      .eq("id", attemptId)
      .eq("studio_id", studioId)
      .maybeSingle();
    const attemptSessionId = (attemptRow as { session_id?: string | null } | null)
      ?.session_id;
    if (attemptSessionId) {
      const repriced = await getAuthoritativeSessionPaymentAmount({
        studioId,
        sessionId: attemptSessionId,
        studioTimezone,
      });
      if (repriced.ok && repriced.result.kind === "free") {
        return {
          ok: false,
          outcome: "blocked",
          error: `${repriced.result.serviceName} is free — no payment is required, so this charge was not run.`,
        };
      }
    }
  }

  const result: SessionPaymentChargeResult = await runSessionPaymentCharge({
    attemptId,
    studioId,
    practitionerId,
  });

  // Force the session detail page to re-render so the new status
  // shows up immediately. We use the path the caller submitted IF
  // the helper resolved one; otherwise revalidate the broader
  // /clients path to cover both the session page and any session
  // list surfaces.
  if (clientId && sessionId) {
    revalidatePath(`/clients/${clientId}/sessions/${sessionId}`);
  } else {
    revalidatePath("/clients");
  }

  if (result.ok) {
    // Post-response, bounded: a PostHog outage must never delay or fail a
    // COMMITTED charge response (P1/P2-ANALYTICS-03).
    captureServerEvent({
      actor: { kind: "user", id: practitionerId },
      event: "payment_charge_executed",
      properties: { studio_id: studioId },
    });
    return {
      ok: true,
      outcome: "succeeded",
      stripePaymentIntentId: result.stripePaymentIntentId,
      stripeChargeId: result.stripeChargeId,
    };
  }
  return {
    ok: false,
    outcome: result.outcome,
    error: result.message,
    blockingReasons: result.blockingReasons,
    failureCode: result.failureCode ?? null,
  };
}

// ---------------------------------------------------------------------------
// sendPaymentChargeReceiptAction (PR #175).
// ---------------------------------------------------------------------------
//
// Practitioner-only. Sends a test-mode receipt for a succeeded
// row on payment_charge_attempts. The heavy lifting lives in
// lib/billing/payment-receipt.ts:sendPaymentChargeReceipt; this
// action is the server-action entry point that:
//
//   * resolves the practitioner + studio from the session so the
//     browser cannot supply either identity
//   * forwards only attempt_id (the row carries every other
//     field the helper needs)
//   * revalidates the session detail page so the new receipt
//     state shows up immediately
//   * surfaces the helper's result to the UI
//
// The action is reason-agnostic: the helper itself maps
// charge_reason to a label. Today only session_payment rows
// exist; when late_cancellation_fee and no_show_fee start
// writing to payment_charge_attempts, the same action handles
// them with no code change.

export type SendPaymentReceiptActionResult =
  | { ok: true; outcome: "sent"; emailTo: string }
  | {
      ok: false;
      outcome:
        | "not_found"
        | "not_succeeded"
        | "missing_payment_intent"
        | "already_sent"
        | "in_flight"
        | "client_email_missing"
        | "studio_missing"
        | "send_failed_retryable"
        | "send_failed_terminal"
        // PR #175 patch. The email landed but the row UPDATE to
        // receipt_status='sent' failed; the UI surfaces a warning
        // and tells the practitioner not to send again until an
        // operator reconciles by hand.
        | "sent_but_record_update_failed"
        | "not_authorized"
        | "database_error";
      error: string;
      emailTo?: string;
      sentAt?: string | null;
    };

export async function sendPaymentChargeReceiptAction(
  formData: FormData,
): Promise<SendPaymentReceiptActionResult> {
  let practitionerId: string;
  let studioId: string;
  let studioTimezone: string;
  try {
    const { practitioner, studio } = await getCurrentPractitionerWithStudio();
    practitionerId = practitioner.id;
    studioId = studio.id;
    studioTimezone = studio.timezone;
  } catch (err) {
    logInternal("payment_receipt_action_auth_failed", { err: String(err) });
    return {
      ok: false,
      outcome: "not_authorized",
      error: NOT_AUTHORIZED_ERROR,
    };
  }

  const attemptId = strOrEmpty(formData.get("attempt_id"));
  const clientId = strOrEmpty(formData.get("client_id"));
  const sessionId = strOrEmpty(formData.get("session_id"));
  if (!attemptId) {
    return {
      ok: false,
      outcome: "not_found",
      error: GENERIC_PRACTITIONER_ERROR,
    };
  }

  const result: SendPaymentChargeReceiptResult =
    await sendPaymentChargeReceipt({
      attemptId,
      studioId,
      practitionerId,
    });

  if (clientId && sessionId) {
    revalidatePath(`/clients/${clientId}/sessions/${sessionId}`);
  } else {
    revalidatePath("/clients");
  }

  if (result.ok) {
    return { ok: true, outcome: "sent", emailTo: result.emailTo };
  }
  return {
    ok: false,
    outcome: result.reason,
    error: result.message,
    emailTo: result.emailTo,
    sentAt: result.sentAt,
  };
}

// ---------------------------------------------------------------------------
// refundPaymentChargeAttemptAction (PR #178).
// ---------------------------------------------------------------------------
//
// Practitioner-only. Refunds a succeeded test-mode row on
// payment_charge_attempts. The heavy lifting lives in
// lib/billing/payment-refund.ts:refundPaymentChargeAttempt; this
// action is the server-action entry point that:
//
//   * resolves the practitioner + studio from the session so the
//     browser cannot supply either identity
//   * forwards attempt_id and an optional practitioner-supplied
//     internal_note; the helper itself reads the canonical amount
//     from the attempt row (never trusts a browser-supplied amount)
//   * revalidates the session detail page so the new refund
//     state shows up immediately
//   * surfaces the helper's result to the UI
//
// The action is reason-agnostic: the helper records charge_reason
// as Stripe-refund metadata. Today only session_payment rows reach
// status='succeeded', but the same action refunds future
// late_cancellation_fee and no_show_fee rows without code change.

export type RefundPaymentActionResult =
  | {
      ok: true;
      outcome: "succeeded";
      stripeRefundId: string;
      refundedAt: string;
      refundAmountCents: number;
    }
  | {
      ok: false;
      outcome:
        | "live_mode_blocked"
        | "not_found"
        | "not_authorized"
        | "not_succeeded"
        | "missing_charge_id"
        | "missing_payment_intent_id"
        | "missing_charged_at"
        | "already_refunded"
        | "refund_in_flight"
        | "amount_invalid"
        | "claim_lost"
        | "failed"
        | "needs_manual_review"
        | "database_error";
      error: string;
      failureCode?: string | null;
    };

export async function refundPaymentChargeAttemptAction(
  formData: FormData,
): Promise<RefundPaymentActionResult> {
  let practitionerId: string;
  let studioId: string;
  let studioTimezone: string;
  try {
    const { practitioner, studio } = await getCurrentPractitionerWithStudio();
    // PR #201 (live payments gate preparation): refunds are
    // OWNER-ONLY, consistently across session payments and fees.
    // Any active practitioner can still charge and send receipts;
    // moving money back out of the studio's balance is restricted
    // to the studio owner ahead of controlled live enablement.
    if (practitioner.role !== "owner") {
      // PR #296: record the denied (non-owner) refund attempt. Safe IDs +
      // event name only — no client name/email/phone, no health/treatment
      // data, no Stripe secret or raw payload.
      logInternal("payment_refund_denied_not_owner", {
        studioId: studio.id,
        practitionerId: practitioner.id,
      });
      return {
        ok: false,
        outcome: "not_authorized",
        error: OWNER_ONLY_REFUND_ERROR,
      };
    }
    practitionerId = practitioner.id;
    studioId = studio.id;
    studioTimezone = studio.timezone;
  } catch (err) {
    logInternal("payment_refund_action_auth_failed", { err: String(err) });
    return {
      ok: false,
      outcome: "not_authorized",
      error: NOT_AUTHORIZED_ERROR,
    };
  }

  const attemptId = strOrEmpty(formData.get("attempt_id"));
  const clientId = strOrEmpty(formData.get("client_id"));
  const sessionId = strOrEmpty(formData.get("session_id"));
  // The browser cannot supply an amount. The helper reads it from
  // the attempt row.
  const internalNoteRaw = strOrEmpty(formData.get("internal_note"));
  const internalNote =
    internalNoteRaw.length > 0 ? internalNoteRaw : null;

  if (!attemptId) {
    return {
      ok: false,
      outcome: "not_found",
      error: GENERIC_PRACTITIONER_ERROR,
    };
  }

  const result: PaymentRefundResult = await refundPaymentChargeAttempt({
    attemptId,
    studioId,
    practitionerId,
    internalNote,
  });

  if (clientId && sessionId) {
    revalidatePath(`/clients/${clientId}/sessions/${sessionId}`);
  } else {
    revalidatePath("/clients");
  }

  if (result.ok) {
    // Post-response, bounded: a PostHog outage must never delay or fail a
    // COMMITTED refund response (P1/P2-ANALYTICS-03).
    captureServerEvent({
      actor: { kind: "user", id: practitionerId },
      event: "payment_refunded",
      properties: { studio_id: studioId },
    });
    return {
      ok: true,
      outcome: "succeeded",
      stripeRefundId: result.stripeRefundId,
      refundedAt: result.refundedAt,
      refundAmountCents: result.refundAmountCents,
    };
  }
  return {
    ok: false,
    outcome: result.outcome,
    error: result.message,
    failureCode: result.failureCode ?? null,
  };
}
