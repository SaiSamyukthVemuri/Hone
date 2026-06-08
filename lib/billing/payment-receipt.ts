import "server-only";
import { createAdminClient } from "@/lib/supabase/admin-server";
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
//   1. Refuses to run in live mode (inferStripeLivemode is the
//      brace; the payment_charge_attempts_livemode_false_check on
//      the row is the belt; the helper does not need its own
//      env-var read because the row-level CHECK + the upstream
//      action's auth gate already cover the test-mode posture).
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
      "id, studio_id, client_id, charge_reason, amount_cents, currency, status, stripe_livemode, stripe_payment_intent_id, stripe_charge_id, charged_at, receipt_status, receipt_sent_at, receipt_email_to",
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
  if (attempt.stripe_livemode !== false) {
    // The DB CHECK already prevents this row from existing.
    // Belt-and-braces: refuse to send a live-mode receipt even
    // if the CHECK were ever relaxed by a future migration.
    return {
      ok: false,
      reason: "not_authorized",
      message:
        "Live-mode receipts are not enabled for this test-mode release.",
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

  // 4) Build the email + send.
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
      logInternal("payment_receipt_sent_write_failed", {
        code: writeErr.code,
        message: writeErr.message,
        attemptId: attempt.id,
      });
      // The email landed; the only operator harm is that the
      // UI will not immediately show "sent." Surface the
      // success anyway and let the next page render reconcile
      // by reading the DB row.
    }
    return { ok: true, status: "sent", emailTo: clientEmail };
  }

  // Send failed. Distinguish retryable from terminal so a
  // transient Resend 5xx does NOT lock the row into 'failed'
  // forever; the retryable path releases the claim back to null
  // so a manual click can try again.
  if (sendResult.retryable) {
    await admin
      .from("payment_charge_attempts")
      .update({
        receipt_status: null,
        receipt_failure_code: null,
        receipt_failure_message_safe: null,
      })
      .eq("id", attempt.id)
      .eq("studio_id", args.studioId)
      .eq("receipt_status", "sending");
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
  await admin
    .from("payment_charge_attempts")
    .update({
      receipt_status: "failed",
      receipt_failure_code: safeCode,
      receipt_failure_message_safe: safeMessage,
    })
    .eq("id", attempt.id)
    .eq("studio_id", args.studioId)
    .eq("receipt_status", "sending");
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
