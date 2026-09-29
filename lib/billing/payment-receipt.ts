import "server-only";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { inferStripeLivemode } from "@/lib/stripe/server";
import { sendEmailSafely } from "@/lib/email/send-appointment";
import { buildReceiptDocument } from "@/lib/billing/receipt-document";
import { renderReceiptPdf } from "@/lib/billing/receipt-pdf";
import { UnsupportedReceiptCharacterError } from "@/lib/billing/receipt-fonts";
import {
  resolveReplyTo,
  studioClientContactEmail,
} from "@/lib/email/studio-identity";
import { recordOpsAlert } from "@/lib/ops/alerts";
import {
  buildPaymentReceiptEmail,
  toReceiptFacts,
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
//      receipt_status, so two concurrent senders cannot both call
//      Resend. The admissible set depends on the CALLER'S POLICY:
//        manual    (default): null OR 'failed' -> 'sending'.
//                  Not refund-gated: a practitioner who clicks Send
//                  is deciding about a real document.
//        automatic          : null ONLY, and only while
//                  refund_status IS NULL, in the same statement.
//                  It does not resurrect a 'failed' receipt, and it
//                  will not fire into a charge being refunded.
//      The refund side carries the reciprocal predicate (it will not
//      claim while receipt_status='sending'), so the two operations
//      are mutually exclusive at this one row.
//   5. Calls sendEmailSafely. The helper itself caps the send at
//      a 15-second timeout and classifies failures as retryable
//      or terminal.
//   6. Writes the result back to the row. THE DECIDING QUESTION IS
//      NOT "is this error retryable" BUT "do we know whether an
//      email reached the client":
//
//       ok: true              -> receipt_status='sent',
//                              receipt_sent_at=now(),
//                              receipt_email_to=<client_email>,
//                              clears the failure detail.
//
//      AMBIGUOUS PROVIDER RESULT (timeout, network error, empty
//      response, 429, 5xx, or a shape the classifier does not
//      recognise -- it fails open to retryable): DELIVERY CANNOT BE
//      RULED OUT. That is the whole of the claim, and it is weaker
//      than it looks. We do NOT know the provider was reached: a
//      network error can fire before the request is accepted. We do
//      NOT know no answer arrived: a 429 or a 5xx IS an answer. All
//      that survives is that an email may or may not have gone out.
//      That is enough, because the risk being managed is a DUPLICATE
//      receipt, and only certainty that nothing was sent would
//      justify sending again.
//      So the claim is deliberately HELD: receipt_status STAYS
//      'sending', nothing is released, and no automatic retry
//      follows. An ops_alert at severity 'critical' asks an operator
//      to reconcile with the provider before clearing or resending.
//      Returns send_ambiguous_state_not_recorded.
//
//      KNOWN PRE-DISPATCH FAILURE: the receipt document or its PDF
//      could not be built (including an unsupported character), so
//      the provider was NEVER dispatched to and delivery definitely
//      did not happen. The claim is SAFE TO RELEASE for later
//      recovery: receipt_status -> null, ops_alert at severity
//      'warning', returns receipt_pdf_unavailable. This is the ONLY
//      path in this module that releases the claim.
//      (ONLY AN EMPTY client email is refused before the claim
//      exists -- the pre-claim check is a presence check, nothing
//      more. A nonempty but MALFORMED address passes it, wins the
//      claim, and is then rejected by the sender; a missing provider
//      configuration is likewise classified after the claim. Both are
//      non-retryable, so they settle down the terminal path below and
//      park the row as 'failed'. They do not release it.)
//
//      KNOWN TERMINAL NOT-DELIVERED provider outcome: the provider
//      answered and refused. receipt_status -> 'failed' with
//      receipt_failure_code and receipt_failure_message_safe, plus
//      an ops_alert at severity 'critical'. The automatic policy
//      does not resurrect 'failed'; manual or operator recovery
//      stays explicit.
//
//      Each of the three settlement writes can itself fail. When it
//      does the outcome says so rather than reporting the intended
//      state -- see sent_but_record_update_failed and
//      send_failed_state_not_recorded.
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
        // UNREACHABLE SINCE THE AMBIGUOUS-DELIVERY REPAIR, and retained only so
        // existing consumers keep compiling. Nothing produces it: a retryable
        // provider failure means delivery is UNKNOWN, which now holds the claim
        // and reports `send_ambiguous_state_not_recorded` instead. Its old advice
        // -- "try again in a moment" -- is exactly what must not be offered when a
        // duplicate receipt is the risk, so do not wire this back up.
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
        // PAY-RECEIPT-PDF. The receipt PDF could not be prepared, so NOTHING
        // was sent. Distinct from every send_failed_* reason precisely because
        // no provider was reached and no email left Hone: delivery is not
        // unknown, it definitively did not happen. The claim is released, so a
        // manual Send can try again.
        | "receipt_pdf_unavailable"
        // R1. The AUTOMATIC claim lost, and the re-read shows the row is not
        // held by another sender -- it is refund activity that made the claim
        // inadmissible. Reporting `in_flight` here was false twice over: no send
        // is in flight, and none can start, because the automatic claim requires
        // `refund_status IS NULL` and refund_status is not going back to NULL.
        //
        // IT IS NOT A FAILURE. Nothing was attempted and nothing went wrong; an
        // automatic receipt was deliberately suppressed. It also does not say
        // the refund succeeded -- `pending_stripe`, `succeeded` and `failed` all
        // produce it, because the policy is about refund ACTIVITY existing, not
        // about how the refund turned out.
        //
        // NO AUTOMATIC RECOVERY FOLLOWS, including after a FAILED refund. Once a
        // refund has been started against a charge, whether a receipt is still
        // the right thing to send is a judgement about a real document, and
        // manual recovery owns it. Wiring automatic retry to refund failure
        // would couple two independent operations that have no business
        // driving each other.
        | "blocked_by_refund"
        | "database_error";
      message: string;
      emailTo?: string;
      sentAt?: string | null;
    };

const ALREADY_SENT_MESSAGE = "Receipt has already been sent.";
const IN_FLIGHT_MESSAGE =
  "A receipt send is already in flight for this attempt.";
// Says what happened and what to do, and asserts nothing about the refund's
// outcome or about any email. No client detail: this is read by whoever is
// looking at the charge, and by the ops alert.
const BLOCKED_BY_REFUND_MESSAGE =
  "Automatic receipt delivery was skipped because refund activity exists for " +
  "this charge. Review the payment and refund state before sending a receipt " +
  "manually.";
const NOT_SUCCEEDED_MESSAGE =
  "Receipts can only be sent for a succeeded charge.";
const MISSING_PI_MESSAGE =
  "Charge is missing a PaymentIntent id; receipt cannot be built.";
const CLIENT_EMAIL_MISSING_MESSAGE =
  "Client has no email on file. Add one before sending the receipt.";
const STUDIO_MISSING_MESSAGE =
  "Studio details are missing for this attempt.";
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
/**
 * PAY-RECEIPT-PDF. The receipt PDF could not be prepared. Release the claim so
 * a manual Send can retry, and send NOTHING.
 *
 * Why this is its own path rather than a reuse of the retryable send failure:
 * no provider was reached, so DELIVERY IS NOT UNKNOWN. That distinction drives
 * the operator instruction. "Reconcile with the provider before resending"
 * would be wrong advice here -- there is nothing to reconcile, and the honest
 * instruction is simply "try again".
 *
 * If the release itself fails the row is stuck at 'sending' and the UI hides
 * Send, so that case escalates through the same reporter the send paths use,
 * with deliveryUnknown FALSE because nothing was ever dispatched.
 */
async function releaseAfterPdfFailure(args: {
  attempt: AttemptRow;
  studioId: string;
  admin: ReturnType<typeof createAdminClient>;
  error: unknown;
}): Promise<SendPaymentChargeReceiptResult> {
  const safeError = sanitiseSafe(
    args.error instanceof Error ? args.error.message : String(args.error),
    200,
  );
  const unsupported = args.error instanceof UnsupportedReceiptCharacterError;
  const { error: releaseErr } = await args.admin
    .from("payment_charge_attempts")
    .update({
      receipt_status: null,
      receipt_failure_code: null,
      receipt_failure_message_safe: null,
    })
    .eq("id", args.attempt.id)
    .eq("studio_id", args.studioId)
    .eq("receipt_status", "sending");

  if (releaseErr) {
    return await reportSettlementFailure({
      // Nothing was dispatched: this is a definitively-did-not-happen case,
      // never an ambiguous one.
      deliveryUnknown: false,
      reason: "send_failed_state_not_recorded",
      event: "payment_receipt_pdf_release_failed",
      message:
        "The receipt PDF could not be prepared, so NO email was sent, and Hone " +
        "could not release receipt_status back to null. The row is stuck in " +
        "'sending'. No client email went out; clear the row to allow a retry.",
      attempt: args.attempt,
      studioId: args.studioId,
      dbError: releaseErr,
      providerError: safeError,
    });
  }

  logInternal("payment_receipt_pdf_failed", {
    attemptId: args.attempt.id,
    err: safeError,
  });
  await recordOpsAlert({
    severity: "warning",
    event: "payment_receipt_pdf_failed",
    message:
      "The receipt PDF could not be prepared, so no receipt email was sent. " +
      "The charge is unaffected and the receipt can be sent again manually.",
    studioId: args.studioId,
    clientId: args.attempt.client_id,
    route: "lib/billing/payment-receipt:releaseAfterPdfFailure",
    safeDetails: { attempt_id: args.attempt.id, error: safeError },
  });
  return {
    ok: false,
    reason: "receipt_pdf_unavailable",
    // "Try again" is the right advice for a transient render failure and the
    // WRONG advice for an unsupported character, which will fail identically
    // every time. Same outcome code, honest instruction.
    message: unsupported
      ? "Hone could not prepare the receipt PDF because the client or studio " +
        "name contains characters it cannot render, so no receipt was sent. " +
        "The payment is unaffected. Send the receipt manually, or contact " +
        "support to have the name updated."
      : "Hone could not prepare the receipt PDF, so no receipt was sent. The " +
        "payment is unaffected. Try sending the receipt again.",
  };
}

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
  // COMMS-01A: delegates to the shared authority. This was a THIRD copy of
  // the same precedence; three copies cannot be kept in agreement by hand.
  return studioClientContactEmail(studio);
}

/**
 * WHICH `receipt_status` VALUES THIS CALLER MAY CLAIM.
 *
 * ONE SENDER, TWO POLICIES -- deliberately not two senders, because a second
 * implementation is a second place for the claim to drift.
 *
 * `automatic`  NULL only. An automatic caller is one of possibly several
 *              concurrent charge/recovery invocations for the same attempt, and
 *              it must never resurrect a `failed` receipt: that decision belongs
 *              to a human who has looked at why it failed.
 *
 * `manual`     NULL or `failed`. A practitioner clicking Send after reading the
 *              failure is the authorised recovery path, and this preserves
 *              exactly today's behaviour for it.
 *
 * NEITHER POLICY MAY CLAIM `sending` OR `sent`. That is what makes the claim the
 * single durable owner of email delivery.
 */
export type ReceiptClaimPolicy = "automatic" | "manual";

export async function sendPaymentChargeReceipt(args: {
  attemptId: string;
  studioId: string;
  practitionerId: string;
  /**
   * Defaults to `manual` so every existing caller keeps its current behaviour;
   * the automatic sender passes `automatic` explicitly.
   */
  claimPolicy?: ReceiptClaimPolicy;
}): Promise<SendPaymentChargeReceiptResult> {
  const claimPolicy: ReceiptClaimPolicy = args.claimPolicy ?? "manual";
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
  if (attempt.receipt_status === "failed" && claimPolicy === "automatic") {
    // NOT an error and not something to retry here. A failed receipt is an
    // operator decision, and an automatic caller reporting it as claimable would
    // be the first step towards automatically resending it.
    return {
      ok: false,
      reason: "in_flight",
      message: IN_FLIGHT_MESSAGE,
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
  //
  //    THE CLAIM IS THE ONE DURABLE OWNER OF EMAIL DELIVERY. No process-level
  //    fact grants it. Several concurrent charge invocations may legitimately
  //    reach this point for the same attempt -- the claim winner sends, everyone
  //    else is told `in_flight` or `already_sent`.
  //
  //    AND THE ADMISSIBLE SET DEPENDS ON THE CALLER. `manual` keeps
  //    (null, 'failed'); `automatic` admits NULL alone, because an automatic
  //    caller must never resurrect a receipt a human has not looked at.
  const claimQuery = admin
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
    .eq("status", "succeeded");
  //    THE AUTOMATIC CLAIM ALSO CARRIES THE REFUND PREDICATE. On its own that
  //    closes exactly ONE ordering -- refund-first -- and nothing more. This
  //    predicate cannot stop a refund that begins AFTER the claim is won, because
  //    a WHERE clause constrains this statement, not some later statement in
  //    another request.
  //
  //    THE OTHER ORDERING IS CLOSED BY THE RECIPROCAL PREDICATE in
  //    `refundPaymentChargeAttempt`, which refuses to claim while
  //    `receipt_status = 'sending'`. Only the PAIR makes the two operations
  //    mutually exclusive, and it is mutual exclusion of the two CLAIMS on one
  //    row -- not a transaction held open across the PDF render, the email
  //    dispatch or the Stripe call, none of which are inside any transaction
  //    here. What is guaranteed is that a refund cannot start between this claim
  //    and its settlement, because the row it would have to claim is taken.
  //
  //    `classifyZeroRowSuccessWrite` already refuses a benign verdict unless
  //    `refund_status` is NULL -- but it checks that at READ time, and the claim
  //    below runs later. `refundPaymentChargeAttempt` writes `refund_status`
  //    on this same row independently, so a refund starting in the gap left the
  //    charge eligible: the claim filtered only `receipt_status`, matched, and an
  //    automatic receipt went to the client while their refund was in flight.
  //    Checking a condition and then acting on it in a separate statement is not
  //    the same as requiring it, and the row is the only place that difference
  //    can be settled.
  //
  //    MANUAL IS DELIBERATELY NOT GATED THIS WAY. A practitioner sending a
  //    receipt for a charge that was later refunded is making a decision about a
  //    real document, and manual recovery owns that decision; the automatic path
  //    is the one that must never make it on its own.
  const { data: claimedRows, error: claimErr } = await (claimPolicy ===
  "automatic"
    ? claimQuery.is("receipt_status", null).is("refund_status", null)
    : claimQuery.or("receipt_status.is.null,receipt_status.eq.failed")
  ).select("id");
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
    // The row moved between our SELECT and the UPDATE. Re-read to say WHY we
    // lost, because the losers are not alike and the caller acts on the
    // difference.
    //
    // `refund_status` IS PART OF THE ANSWER and must be selected. The automatic
    // claim carries `refund_status IS NULL`, so refund activity is one of the
    // two reasons this UPDATE can match zero rows -- and it was invisible to a
    // re-read that looked only at the receipt columns. Every such loser was
    // reported as `in_flight`, which sent the reader looking for a send that
    // did not exist and would never start.
    const { data: re } = await admin
      .from("payment_charge_attempts")
      .select("receipt_status, receipt_sent_at, receipt_email_to, refund_status")
      .eq("id", attempt.id)
      .maybeSingle();

    // Delivered. True under either policy, and checked first because it is the
    // only branch that can report an address and a timestamp.
    if (re?.receipt_status === "sent") {
      return {
        ok: false,
        reason: "already_sent",
        message: ALREADY_SENT_MESSAGE,
        emailTo: (re.receipt_email_to as string | null) ?? undefined,
        sentAt: (re.receipt_sent_at as string | null) ?? null,
      };
    }

    // Genuinely held by another sender. `sending` is inadmissible to both
    // policies, so this is the one loser that really is waiting on an email.
    if (re?.receipt_status === "sending") {
      return { ok: false, reason: "in_flight", message: IN_FLIGHT_MESSAGE };
    }

    // Not held, and not sent -- so under the AUTOMATIC policy the remaining
    // reason the claim could be refused is its refund predicate.
    //
    // MANUAL IS NOT CLASSIFIED THIS WAY, because manual is not refund-gated: a
    // manual claim never loses on account of a refund, so saying it did would
    // be a new falsehood in place of the one being removed.
    // `typeof === "string"`, not `!== null`. If this re-read ever stops
    // selecting refund_status the value is `undefined`, and `undefined !== null`
    // is TRUE -- every automatic loser would be reported as refund-blocked. The
    // narrow check makes a missing column read as "no refund activity known",
    // which is the harmless direction: the claim already refused, so only the
    // REASON is at stake here, never whether an email goes out.
    if (claimPolicy === "automatic" && typeof re?.refund_status === "string") {
      return {
        ok: false,
        reason: "blocked_by_refund",
        message: BLOCKED_BY_REFUND_MESSAGE,
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

  // 5b) PAY-RECEIPT-PDF. The PDF is rendered from the SAME canonical document
  //     the email above rendered, so the attachment cannot disagree with the
  //     body it arrives with.
  //
  //     ONE EMAIL OR NONE. A receipt is not release-complete without its PDF,
  //     so a preparation failure must not send a receipt that is missing its
  //     attachment. Nothing has reached a provider at this point, so delivery
  //     is not ambiguous -- it definitively has not happened -- and the right
  //     move is to release the claim and let a practitioner retry by hand.
  let receiptPdf: Buffer;
  let pdfFileName: string;
  try {
    const doc = buildReceiptDocument(
      toReceiptFacts({
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
        livemode: attempt.stripe_livemode,
      }),
    );
    pdfFileName = doc.pdfFileName;
    receiptPdf = Buffer.from(await renderReceiptPdf(doc));
  } catch (err) {
    return await releaseAfterPdfFailure({
      attempt,
      studioId: args.studioId,
      admin,
      error: err,
    });
  }

  const sendResult = await sendEmailSafely({
    studioIdentity: {
      displayName: studio.name,
      replyTo: resolveReplyTo(resolveStudioContactEmail(studio)),
    },
    to: clientEmail,
    subject,
    html,
    text,
    // Exactly one attachment: the receipt the body describes.
    attachments: [{ filename: pdfFileName, content: receiptPdf }],
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

  // ===========================================================================
  // AMBIGUOUS DELIVERY DOES NOT REOPEN THE CLAIM
  // ===========================================================================
  //
  // `retryable` covers TIMEOUT, NETWORK FAILURE, an EMPTY RESPONSE and 5xx --
  // every case where the request reached Resend, or may have, and DELIVERY IS
  // UNKNOWN. The email may already be in the client's inbox.
  //
  // THIS BRANCH USED TO RELEASE `receipt_status` BACK TO NULL, and the comment
  // sitting in it named the exact hazard that made that wrong: "Resend may have
  // accepted the email. Clearing this row without checking the provider first
  // can duplicate a real client receipt." It said so on the failure-to-release
  // path, and then the success path cleared the row anyway.
  //
  // It was survivable while only a practitioner's click could re-enter here. It
  // is not survivable now: several concurrent charge invocations may each reach
  // the sender for one attempt, so a released claim is an open invitation for the
  // next one to send a second receipt for a charge that may already have been
  // receipted.
  //
  // SO THE CLAIM IS HELD. The row stays `sending`, which is the truthful
  // representation of what Hone knows -- a send was started and its outcome is
  // unknown -- and no caller, automatic or manual, may claim it. An operator
  // reconciles with the provider and then decides. That is a deliberate loss of
  // automatic retry on an ambiguous outcome, and the trade is the right way
  // round: a missing receipt is recoverable by a person, a duplicate one is not.
  //
  // A FAILURE BEFORE DISPATCH IS DIFFERENT AND STILL RELEASES. PDF generation,
  // an unusable recipient or missing configuration never reach the provider, so
  // delivery is definitively "no" rather than "unknown" -- see
  // `releaseAfterPdfFailure`, which keeps that behaviour and says why.
  if (sendResult.retryable) {
    await recordOpsAlert({
      // CRITICAL, NOT WARNING, and the change of severity follows the change of
      // behaviour. Releasing the claim used to make this self-healing -- a
      // practitioner could click Send again -- so `warning` was right. Holding
      // the claim means the row is parked at 'sending', no caller can claim it,
      // and the receipt CANNOT proceed without a person reconciling with the
      // provider. That is the same shape this file already raises at critical
      // when a release fails, and it needs the same attention.
      severity: "critical",
      event: "payment_receipt_send_ambiguous_claim_held",
      message:
        "Receipt delivery is UNKNOWN (retryable provider failure: timeout, network, empty response or 5xx, so the email may have been accepted). " +
        "receipt_status is deliberately LEFT AT 'sending' rather than released, so no automatic or manual caller can send a second receipt for this charge. " +
        "RECONCILE WITH THE EMAIL PROVIDER before clearing this row or sending again.",
      studioId: args.studioId,
      clientId: attempt.client_id,
      route: "lib/billing/payment-receipt:sendPaymentChargeReceipt",
      safeDetails: {
        attempt_id: attempt.id,
        charge_reason: attempt.charge_reason,
        claim_policy: claimPolicy,
        claim_released: false,
        delivery_unknown: true,
        error: sanitiseSafe(sendResult.error, 200),
      },
    });
    return {
      ok: false,
      // The row is parked at 'sending' on purpose, which is the same shape the
      // failed-to-release case reports -- and now for the same reason, so the
      // operator instruction is identical: reconcile before acting.
      reason: "send_ambiguous_state_not_recorded",
      message:
        "Receipt delivery is UNKNOWN and Hone has deliberately kept the receipt claim so nothing can send twice. Reconcile with the email provider before sending again.",
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
