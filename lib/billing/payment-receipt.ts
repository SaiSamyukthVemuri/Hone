import "server-only";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { inferStripeLivemode } from "@/lib/stripe/server";
import { sendEmailSafely } from "@/lib/email/send-appointment";
import { recordOpsAlert } from "@/lib/ops/alerts";
import {
  buildPaymentReceiptEmail,
  chargeReasonLabel,
} from "@/lib/email/templates/payment-receipt";

// ---------------------------------------------------------------------------
// sendPaymentChargeReceipt (PR #175).
// ---------------------------------------------------------------------------
//
// Reason-agnostic test-mode receipt sender for the canonical
// payment_charge_attempts ledger (PR #171). Takes a succeeded row,
// resolves the client + studio context, builds the email template
// from lib/email/templates/payment-receipt.ts, and sends it via
// sendEmailSafely. Persists the send result on the row's receipt_*
// columns (migration 0076) so the practitioner UI shows the
// already-sent state across page refreshes and so the action layer
// has atomic duplicate-protection.
//
// What this helper does:
//   1. Runs in the deployment's Stripe mode and refuses a row whose
//      stripe_livemode does not match it (the mode-mismatch guard
//      below); the receipt template then branches on the ROW's mode
//      (test disclaimer vs the lawyer-approved live wording).
//   2. Loads the attempt row + verifies it is studio-scoped,
//      succeeded, and has the Stripe ids the email needs (PI id
//      mandatory; charge id optional).
//   3. Loads the client + studio rows so the email greeting,
//      reason label, and contact line resolve correctly.
//   4. Atomically claims the row via a conditional UPDATE on
//      receipt_status (null OR 'failed' -> 'sending') so two
//      concurrent click events cannot both call Resend.
//   5. Calls sendEmailSafely. The helper itself caps the send at
//      a 15-second timeout and classifies failures as retryable
//      or terminal.
//   6. Writes the result back to the row:
//       ok: true              -> receipt_status='sent',
//                              receipt_sent_at=now(),
//                              receipt_email_to=<client_email>,
//                              clears the failure detail.
//      ok: false, retryable  -> receipt_status=null (releases
//                              the claim so a manual retry can
//                              run later) + ops_alert at
//                              severity 'warning'.
//      ok: false, terminal   -> receipt_status='failed',
//                              receipt_failure_code,
//                              receipt_failure_message_safe +
//                              ops_alert at severity 'critical'.
//
// What this helper does NOT do:
//   * Does NOT create a Stripe PaymentIntent. Does NOT call any
//     Stripe API at all. Receipts are sent via Resend, never
//     through Stripe.
//   * Does NOT calculate or claim tax. Template carries the
//     explicit "No tax calculation" line so the client cannot
//     mistake the receipt for a tax invoice.
//   * Does NOT include a refund affordance or refund policy.
//     Refunds are deferred (docs/16 §5.5).
//   * Does NOT change the row's payment status. The attempt
//     stays succeeded; only the receipt_* columns move.
//   * Does NOT send to the practitioner or the studio owner. The
//     receipt goes to clients.email; if missing or invalid the
//     helper refuses without an email-send attempt.
//   * Does NOT touch manual_fee_charge_attempts. The legacy
//     test-mode runtime keeps its own (currently absent)
//     receipt path.

export type SendPaymentChargeReceiptResult =
  | { ok: true; status: "sent"; emailTo: string }
  | {
      ok: false;
      reason:
        | "not_found"
        | "not_succeeded"
        | "missing_payment_intent"
        | "already_sent"
        | "in_flight"
        | "client_email_missing"
        | "studio_missing"
        | "send_failed_retryable"
        | "send_failed_terminal"
        // The send FAILED (retryably or terminally) and the follow-up
        // write recording that failure ALSO failed, so the row is
        // stranded at receipt_status='sending'. The claim admits only
        // (null, 'failed') and the UI hides Send on 'sending', so the
        // receipt is unretryable until an operator clears the row.
        // Distinct from send_failed_retryable precisely because "try
        // again in a moment" is advice that can never succeed here.
        | "send_failed_state_not_recorded"
        // Codex P2 on 0b808c10. Same stuck-'sending' shape, but the
        // provider result was RETRYABLE (timeout / network), so delivery
        // is UNKNOWN rather than definitively failed. Separate from
        // send_failed_state_not_recorded because the operator
        // instruction differs: reconcile with the provider before
        // clearing, or risk a duplicate receipt.
        | "send_ambiguous_state_not_recorded"
        // PR #175 patch. The Resend call returned ok:true but the
        // follow-up UPDATE to stamp receipt_status='sent' failed.
        // Returning ok:true here would lose the truthful state:
        // the email is in the wild, the row is stuck in 'sending',
        // and a refresh would render "in flight" forever. Surfacing
        // this distinct outcome forces the practitioner UI to show
        // a warning and the operator to reconcile by hand.
        | "sent_but_record_update_failed"
        | "not_authorized"
        | "database_error";
      message: string;
      emailTo?: string;
      sentAt?: string | null;
    };

const ALREADY_SENT_MESSAGE = "Receipt has already been sent.";
const IN_FLIGHT_MESSAGE =
  "A receipt send is already in flight for this attempt.";
const NOT_SUCCEEDED_MESSAGE =
  "Receipts can only be sent for a succeeded charge.";
const MISSING_PI_MESSAGE =
  "Charge is missing a PaymentIntent id; receipt cannot be built.";
const CLIENT_EMAIL_MISSING_MESSAGE =
  "Client has no email on file. Add one before sending the receipt.";
const STUDIO_MISSING_MESSAGE =
  "Studio details are missing for this attempt.";
const SEND_FAILED_RETRYABLE_MESSAGE =
  "Receipt email failed temporarily. Try again in a moment.";
const SEND_FAILED_TERMINAL_MESSAGE =
  "Receipt email failed and cannot be retried automatically.";
// TERMINAL provider failure + settlement write failure. Definitive
// wording is correct here: sendEmailSafely only classifies a failure as
// non-retryable when it never reached delivery (missing API key, invalid
// recipient, a classified terminal Resend error), so "did not send" is a
// claim we can support. Deliberately does NOT say "try again": the row is
// stuck in 'sending', so a retry cannot get past the claim.
const SEND_FAILED_STATE_NOT_RECORDED_MESSAGE =
  "The receipt did not send, and Hone could not record that. This charge needs an operator to clear it before another attempt.";
// RETRYABLE provider failure + settlement write failure. Codex review of
// 0b808c10 (P2): retryable covers TIMEOUT and NETWORK errors, where Resend
// may already have accepted the email. Saying "the receipt did not send"
// here asserts something we cannot know, and telling an operator that
// clearing the row is the prerequisite to another attempt invites a
// DUPLICATE receipt to a real client. Delivery is reported as UNKNOWN and
// provider reconciliation is required before clearing or resending.
const SEND_AMBIGUOUS_STATE_NOT_RECORDED_MESSAGE =
  "Hone could not confirm whether this receipt was delivered, and could not record the outcome. Check the email provider before clearing this charge or sending again -- the client may already have received it.";
const GENERIC_DB_MESSAGE =
  "We could not record the receipt send. Please try again.";

function logInternal(event: string, detail: unknown): void {
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

function sanitiseSafe(s: string, max: number): string {
  return s.replace(/\s+/g, " ").trim().slice(0, max);
}

// A send FAILED and the follow-up write that records that failure also
// failed, so the row is stranded at receipt_status='sending'. Shared by
// the retryable-release and terminal-park branches because the operator
// consequence is identical: the claim predicate admits only
// (null, 'failed') and the UI hides Send on 'sending', so nothing can
// move this row without a hand fix.
//
// Deliberately NOT shared with the provider-SUCCESS persistence failure
// (`sent_but_record_update_failed`): there an email is already in the
// wild and the operator instruction is the opposite one -- do not send
// again. Collapsing the two would lose exactly the distinction PR #175
// was written to preserve.
//
// No email is sent, re-sent, or retried here. It only reports.
async function reportSettlementFailure(args: {
  event: string;
  message: string;
  attempt: AttemptRow;
  studioId: string;
  dbError: { code?: string | null; message?: string | null };
  providerError: string;
  // Whether DELIVERY is unknown (retryable: timeout / network, where the
  // provider may have accepted the email) or definitively did not happen
  // (terminal). Drives both the practitioner copy and the operator
  // instruction, because clearing a stuck row is only safe when we know
  // no email went out.
  deliveryUnknown: boolean;
  reason:
    | "send_failed_state_not_recorded"
    | "send_ambiguous_state_not_recorded";
}): Promise<SendPaymentChargeReceiptResult> {
  logInternal(args.event, {
    code: args.dbError.code ?? null,
    message: args.dbError.message ?? null,
    attemptId: args.attempt.id,
  });
  await recordOpsAlert({
    severity: "critical",
    event: args.event,
    message: args.message,
    studioId: args.studioId,
    clientId: args.attempt.client_id,
    route: "lib/billing/payment-receipt:sendPaymentChargeReceipt",
    safeDetails: {
      attempt_id: args.attempt.id,
      charge_reason: args.attempt.charge_reason,
      stuck_receipt_status: "sending",
      // The operator's first question is "did the client get an email?".
      // Answering it in the alert is what keeps a reconciliation from
      // becoming a duplicate send.
      delivery: args.deliveryUnknown ? "unknown" : "not_delivered",
      provider_error: args.providerError,
      db_code: args.dbError.code ?? null,
    },
  });
  return {
    ok: false,
    reason: args.reason,
    message: args.deliveryUnknown
      ? SEND_AMBIGUOUS_STATE_NOT_RECORDED_MESSAGE
      : SEND_FAILED_STATE_NOT_RECORDED_MESSAGE,
  };
}

type AttemptRow = {
  id: string;
  studio_id: string;
  client_id: string;
  charge_reason: string | null;
  amount_cents: number;
  currency: string;
  status: string;
  stripe_livemode: boolean;
  stripe_payment_intent_id: string | null;
  stripe_charge_id: string | null;
  charged_at: string | null;
  client_payment_method_id: string | null;
  receipt_status: string | null;
  receipt_sent_at: string | null;
  receipt_email_to: string | null;
};

type StudioRow = {
  id: string;
  name: string;
  owner_email: string | null;
  postcare_contact_email: string | null;
};

type ClientRow = {
  id: string;
  studio_id: string;
  name: string;
  email: string | null;
};

// Resolve the studio's reply-to address using the same fallback
// chain the postcare email uses: postcare_contact_email beats
// owner_email; if neither is set we pass null and the template
// omits the contact line.
function resolveStudioContactEmail(studio: StudioRow): string | null {
  const override = studio.postcare_contact_email?.trim();
  if (override && override.length > 0) return override;
  const fallback = studio.owner_email?.trim();
  if (fallback && fallback.length > 0) return fallback;
  return null;
}

export async function sendPaymentChargeReceipt(args: {
  attemptId: string;
  studioId: string;
  practitionerId: string;
}): Promise<SendPaymentChargeReceiptResult> {
  const admin = createAdminClient();

  // 1) Load the attempt row scoped by studio. The auth gate
  // already ensured the practitioner belongs to args.studioId;
  // the .eq("studio_id") here is defence-in-depth.
  const { data: attemptRow } = await admin
    .from("payment_charge_attempts")
    .select(
      "id, studio_id, client_id, charge_reason, amount_cents, currency, status, stripe_livemode, stripe_payment_intent_id, stripe_charge_id, charged_at, client_payment_method_id, receipt_status, receipt_sent_at, receipt_email_to",
    )
    .eq("id", args.attemptId)
    .eq("studio_id", args.studioId)
    .maybeSingle();
  if (!attemptRow) {
    return {
      ok: false,
      reason: "not_found",
      message: "Charge attempt not found.",
    };
  }
  const attempt = attemptRow as AttemptRow;
  if (attempt.status !== "succeeded") {
    return {
      ok: false,
      reason: "not_succeeded",
      message: NOT_SUCCEEDED_MESSAGE,
    };
  }
  // PR #323: mode-consistency guard. The receipt is now live-CAPABLE. It refuses
  // only rows whose mode does not match the deployment mode (in test env this is
  // `!== false`, unchanged). NOTE (docs/16): #324 must NOT proceed until the live
  // receipt wording (lib/email/templates/payment-receipt.ts live branch) has
  // legal/accounting sign-off. No live receipt is sent in #323 (env is test → no
  // live row exists).
  if (attempt.stripe_livemode !== inferStripeLivemode()) {
    return {
      ok: false,
      reason: "not_authorized",
      message: "Receipt mode does not match the deployment mode.",
    };
  }
  if (!attempt.stripe_payment_intent_id) {
    return {
      ok: false,
      reason: "missing_payment_intent",
      message: MISSING_PI_MESSAGE,
    };
  }
  if (!attempt.charged_at) {
    return {
      ok: false,
      reason: "missing_payment_intent",
      message: MISSING_PI_MESSAGE,
    };
  }

  // Already-sent and in-flight short-circuits BEFORE we look up
  // any client / studio data. The UI relies on these to show the
  // calm "already sent" state.
  if (attempt.receipt_status === "sent") {
    return {
      ok: false,
      reason: "already_sent",
      message: ALREADY_SENT_MESSAGE,
      emailTo: attempt.receipt_email_to ?? undefined,
      sentAt: attempt.receipt_sent_at,
    };
  }
  if (attempt.receipt_status === "sending") {
    return {
      ok: false,
      reason: "in_flight",
      message: IN_FLIGHT_MESSAGE,
    };
  }

  // 2) Load the client + studio rows. Both are studio-scoped.
  const { data: clientRow } = await admin
    .from("clients")
    .select("id, studio_id, name, email")
    .eq("id", attempt.client_id)
    .eq("studio_id", args.studioId)
    .maybeSingle();
  if (!clientRow) {
    return {
      ok: false,
      reason: "client_email_missing",
      message: CLIENT_EMAIL_MISSING_MESSAGE,
    };
  }
  const client = clientRow as ClientRow;
  const clientEmail = client.email?.trim() ?? "";
  if (clientEmail.length === 0) {
    return {
      ok: false,
      reason: "client_email_missing",
      message: CLIENT_EMAIL_MISSING_MESSAGE,
    };
  }

  const { data: studioRow } = await admin
    .from("studios")
    .select("id, name, owner_email, postcare_contact_email")
    .eq("id", args.studioId)
    .maybeSingle();
  if (!studioRow) {
    return {
      ok: false,
      reason: "studio_missing",
      message: STUDIO_MISSING_MESSAGE,
    };
  }
  const studio = studioRow as StudioRow;

  // 3) Atomic claim. The UPDATE matches on (id, studio_id,
  //    status='succeeded', receipt_status IN (null, 'failed'))
  //    so a row already in 'sending' or 'sent' refuses the
  //    transition. Returning the post-update row lets us
  //    distinguish "I claimed it" (data non-null) from "someone
  //    else got there first" (data null).
  const { data: claimedRows, error: claimErr } = await admin
    .from("payment_charge_attempts")
    .update({
      receipt_status: "sending",
      // Clear any prior failure detail so a retry starts fresh.
      receipt_failure_code: null,
      receipt_failure_message_safe: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", attempt.id)
    .eq("studio_id", args.studioId)
    .eq("status", "succeeded")
    .or("receipt_status.is.null,receipt_status.eq.failed")
    .select("id");
  if (claimErr) {
    logInternal("payment_receipt_claim_failed", {
      code: claimErr.code,
      message: claimErr.message,
      attemptId: attempt.id,
    });
    return {
      ok: false,
      reason: "database_error",
      message: GENERIC_DB_MESSAGE,
    };
  }
  if (!claimedRows || claimedRows.length === 0) {
    // The row moved between our SELECT and the UPDATE. Re-check
    // the current state to surface the right reason.
    const { data: re } = await admin
      .from("payment_charge_attempts")
      .select("receipt_status, receipt_sent_at, receipt_email_to")
      .eq("id", attempt.id)
      .maybeSingle();
    if (re?.receipt_status === "sent") {
      return {
        ok: false,
        reason: "already_sent",
        message: ALREADY_SENT_MESSAGE,
        emailTo: (re.receipt_email_to as string | null) ?? undefined,
        sentAt: (re.receipt_sent_at as string | null) ?? null,
      };
    }
    return {
      ok: false,
      reason: "in_flight",
      message: IN_FLIGHT_MESSAGE,
    };
  }

  // 4) DISPLAY-ONLY read: the card last-4 for the live receipt's "Payment
  //    method: Card ending in {last4}" line (lawyer-approved copy). Scoped to
  //    the attempt's (studio, client, payment method, livemode) tuple so tenant
  //    isolation holds; selects ONLY last4 (never a full card number or other
  //    card data). This changes no charge/refund/webhook behavior. It only
  //    enriches the receipt display. If the card row is missing, last4 stays
  //    null and the template renders the neutral "Card on file" fallback (the
  //    receipt is never blocked over a missing display detail).
  let cardLast4: string | null = null;
  if (attempt.client_payment_method_id) {
    const { data: cardRow } = await admin
      .from("client_payment_methods")
      .select("last4")
      .eq("id", attempt.client_payment_method_id)
      .eq("studio_id", attempt.studio_id)
      .eq("client_id", attempt.client_id)
      .eq("stripe_livemode", attempt.stripe_livemode)
      .maybeSingle();
    const raw = (cardRow?.last4 as string | null | undefined)?.trim();
    cardLast4 = raw ? raw : null;
  }

  // 5) Build the email + send.
  const { subject, html, text } = buildPaymentReceiptEmail({
    studioName: studio.name,
    studioContactEmail: resolveStudioContactEmail(studio),
    clientName: client.name,
    chargeReasonLabel: chargeReasonLabel(attempt.charge_reason),
    amountCents: attempt.amount_cents,
    currencyCode: attempt.currency,
    chargedAt: new Date(attempt.charged_at),
    stripePaymentIntentId: attempt.stripe_payment_intent_id,
    stripeChargeId: attempt.stripe_charge_id,
    last4: cardLast4,
    // PR #323: pass the row's actual mode so a live row (once one exists, after
    // the #324 env flip) renders the live-copy branch. In test env every row is
    // stripe_livemode=false, so this stays the test-mode receipt today.
    livemode: attempt.stripe_livemode,
  });

  const sendResult = await sendEmailSafely({
    to: clientEmail,
    subject,
    html,
    text,
  });

  // 5) Persist outcome.
  if (sendResult.ok) {
    const { error: writeErr } = await admin
      .from("payment_charge_attempts")
      .update({
        receipt_status: "sent",
        receipt_sent_at: new Date().toISOString(),
        receipt_email_to: clientEmail,
        receipt_failure_code: null,
        receipt_failure_message_safe: null,
      })
      .eq("id", attempt.id)
      .eq("studio_id", args.studioId)
      .eq("receipt_status", "sending");
    if (writeErr) {
      // PR #175 patch. Pre-patch this branch only logged and
      // returned ok:true. That was unsafe: the email landed in
      // the wild, the row stayed at receipt_status='sending',
      // future refresh showed "in flight" forever, future sends
      // were blocked by the stuck claim, AND no ops_alert was
      // created. The truthful state is "we sent the email but
      // we could not persist that fact" -- surface it as a
      // distinct non-clean outcome and force the operator to
      // reconcile by hand before any further action.
      logInternal("payment_receipt_sent_record_update_failed", {
        code: writeErr.code,
        message: writeErr.message,
        attemptId: attempt.id,
      });
      await recordOpsAlert({
        severity: "critical",
        event: "payment_receipt_sent_record_update_failed",
        message:
          "Receipt email may have been delivered, but Hone failed to persist receipt_status='sent'. Manual reconciliation required before retrying.",
        studioId: args.studioId,
        clientId: attempt.client_id,
        route: "lib/billing/payment-receipt:sendPaymentChargeReceipt",
        safeDetails: {
          attempt_id: attempt.id,
          charge_reason: attempt.charge_reason,
          receipt_email_to: clientEmail,
          db_code: writeErr.code ?? null,
        },
      });
      return {
        ok: false,
        reason: "sent_but_record_update_failed",
        message:
          "The receipt email may have been sent, but Hone could not record it. Do not send again until this is checked.",
        emailTo: clientEmail,
      };
    }
    return { ok: true, status: "sent", emailTo: clientEmail };
  }

  // Send failed. Distinguish retryable from terminal so a
  // transient Resend 5xx does NOT lock the row into 'failed'
  // forever; the retryable path releases the claim back to null
  // so a manual click can try again.
  if (sendResult.retryable) {
    const { error: releaseErr } = await admin
      .from("payment_charge_attempts")
      .update({
        receipt_status: null,
        receipt_failure_code: null,
        receipt_failure_message_safe: null,
      })
      .eq("id", attempt.id)
      .eq("studio_id", args.studioId)
      .eq("receipt_status", "sending");
    if (releaseErr) {
      // The release is what makes a retryable failure retryable. If it
      // fails the row stays 'sending', the claim admits only
      // (null, 'failed'), and ReceiptSubPanel hides the Send button on
      // 'sending' -- so the receipt is permanently unretryable through
      // the normal path. Saying "try again in a moment" here would be
      // advice that can never succeed, so this returns a distinct
      // outcome and raises the persistence failure (not the provider
      // failure) to the operator.
      return await reportSettlementFailure({
        // Retryable covers TIMEOUT and NETWORK errors, so DELIVERY IS
        // UNKNOWN: Resend may have accepted the email. Clearing this row
        // without checking the provider first can duplicate a real
        // client receipt.
        deliveryUnknown: true,
        reason: "send_ambiguous_state_not_recorded",
        event: "payment_receipt_release_failed",
        message:
          "Receipt delivery is UNKNOWN (retryable provider failure: the email may have been accepted) and Hone could not release receipt_status back to null. The row is stuck in 'sending'. Reconcile with the email provider BEFORE clearing this row or sending again.",
        attempt,
        studioId: args.studioId,
        dbError: releaseErr,
        providerError: sanitiseSafe(sendResult.error, 200),
      });
    }
    await recordOpsAlert({
      severity: "warning",
      event: "payment_receipt_send_failed_retryable",
      message:
        "Receipt email failed with a retryable error; row released for manual retry.",
      studioId: args.studioId,
      clientId: attempt.client_id,
      route: "lib/billing/payment-receipt:sendPaymentChargeReceipt",
      safeDetails: {
        attempt_id: attempt.id,
        charge_reason: attempt.charge_reason,
        error: sanitiseSafe(sendResult.error, 200),
      },
    });
    return {
      ok: false,
      reason: "send_failed_retryable",
      message: SEND_FAILED_RETRYABLE_MESSAGE,
    };
  }

  // Terminal failure. Pin the failure detail on the row so the
  // UI can render "Receipt failed: <code>" and the operator
  // sees the message via the ops alert.
  const safeCode = sanitiseSafe("send_failed", 100);
  const safeMessage = sanitiseSafe(sendResult.error, 1000);
  const { error: terminalErr } = await admin
    .from("payment_charge_attempts")
    .update({
      receipt_status: "failed",
      receipt_failure_code: safeCode,
      receipt_failure_message_safe: safeMessage,
    })
    .eq("id", attempt.id)
    .eq("studio_id", args.studioId)
    .eq("receipt_status", "sending");
  if (terminalErr) {
    // Same stuck-'sending' shape as the release path above, plus the
    // failure code/message never land, so ReceiptSubPanel cannot even
    // render "Receipt failed: <code>". Parking the row as 'failed' is
    // what makes a terminal failure operator-visible AND retryable
    // after investigation; without it the row is neither.
    return await reportSettlementFailure({
      // Terminal means sendEmailSafely never reached delivery (missing
      // API key, invalid recipient, classified terminal error), so
      // "not delivered" is a claim we can support.
      deliveryUnknown: false,
      reason: "send_failed_state_not_recorded",
      event: "payment_receipt_terminal_record_failed",
      message:
        "Receipt send failed terminally, but Hone could not persist receipt_status='failed'. The row is stuck in 'sending' and the receipt cannot be retried until an operator clears it.",
      attempt,
      studioId: args.studioId,
      dbError: terminalErr,
      providerError: safeMessage,
    });
  }
  await recordOpsAlert({
    severity: "critical",
    event: "payment_receipt_send_failed_terminal",
    message:
      "Receipt email failed with a non-retryable error. The row is parked as receipt_status='failed' for operator review.",
    studioId: args.studioId,
    clientId: attempt.client_id,
    route: "lib/billing/payment-receipt:sendPaymentChargeReceipt",
    safeDetails: {
      attempt_id: attempt.id,
      charge_reason: attempt.charge_reason,
      error: safeMessage,
    },
  });
  return {
    ok: false,
    reason: "send_failed_terminal",
    message: SEND_FAILED_TERMINAL_MESSAGE,
  };
}
