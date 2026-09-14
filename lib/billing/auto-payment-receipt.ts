import {
  sendPaymentChargeReceipt,
  type SendPaymentChargeReceiptResult,
} from "@/lib/billing/payment-receipt";
import type { SessionPaymentChargeResult } from "@/lib/billing/session-payment-charge";
import { recordOpsAlert } from "@/lib/ops/alerts";

// ===========================================================================
// PAY-RECEIPT-AUTO-01 — the receipt goes out on its own after a card charge
// ===========================================================================
//
// Chloe: "I want Hone to send the receipts automatically. Right now it's a
// manual click after I run the card."
//
// ---------------------------------------------------------------------------
// WHY THIS LIVES AT THE ACTION LAYER AND NOT INSIDE THE STRIPE EXECUTOR
// ---------------------------------------------------------------------------
//
// `runSessionPaymentCharge` owns MONEY. It claims the attempt, talks to
// Stripe, and persists the outcome. Putting an email provider inside it would
// give the money path a second way to be slow and a second way to fail, and
// would make "did the charge commit?" depend on a mail server. The two charge
// actions already hold everything the receipt needs — attemptId, studioId,
// practitionerId — so orchestration belongs exactly here: after money is
// settled, before the response is returned.
//
// ONE HELPER RATHER THAN TWO COPIES. Both canonical charge actions (session
// payment and calendar manual fee) need identical rules. Copying them would
// let the rules drift, and the rule that matters most — WHICH outcomes may
// send — is the one that must never drift.
//
// ---------------------------------------------------------------------------
// THE TRIGGER IS THE NARROWEST DEFINITIVE SUCCESS, AND NOTHING ELSE
// ---------------------------------------------------------------------------
//
// `SessionPaymentChargeResult` is a discriminated union in which `ok: true`
// holds if and ONLY if `outcome === "succeeded"`, and the runner returns that
// shape only when Stripe succeeded AND Hone durably persisted the succeeded
// outcome locally. Every other case — failed, blocked, lineage_mismatch,
// authorization_not_current, needs_manual_review, live_mode_blocked,
// not_found, not_authorized — is `ok: false`.
//
// THE CASE THIS EXISTS TO REFUSE: Stripe charged the card but Hone could not
// confirm it wrote the ledger. That is `needs_manual_review`, it is `ok:
// false`, and it must send NO automatic receipt — telling a client "here is
// your receipt" when we cannot prove what we recorded is the one failure worse
// than sending nothing. Both limbs are checked even though the type makes the
// second redundant, because the guarantee is worth stating twice and a future
// widening of the union would otherwise pass silently.
//
// ---------------------------------------------------------------------------
// A RECEIPT FAILURE MUST NEVER MAKE A SUCCESSFUL CHARGE LOOK FAILED
// ---------------------------------------------------------------------------
//
// The card has been charged. That is monetary truth and it is already durable.
// This function therefore CANNOT throw and CANNOT retry: it swallows every
// provider and transport error into a reported outcome, so the caller returns
// its payment success unchanged and merely carries the receipt state alongside
// it. A practitioner who sees a receipt problem must never be nudged toward
// running the card a second time.
//
// NO AUTOMATIC RETRY, EVER. `sendPaymentChargeReceipt` already claims
// `receipt_status` atomically before it calls the provider, which is what
// makes the automatic send and a simultaneous manual click safe. Retrying an
// AMBIGUOUS provider result here would defeat that: delivery is unknown, not
// failed, and a second attempt risks a duplicate receipt in the client's
// inbox. Ambiguity is reported and left for an operator.
// ===========================================================================

/**
 * Structured, non-sensitive internal log. Matches the file-local convention
 * payment-receipt.ts and the charge runner already use — there is no shared
 * logger module in this codebase, and inventing one here would be scope the
 * task does not authorise.
 */
function logInternal(event: string, detail: unknown): void {
  try {
    console.error(
      JSON.stringify({ event, detail, timestamp: new Date().toISOString() }),
    );
  } catch {
    // Logging must never be the thing that breaks a committed charge.
  }
}

/** What the automatic attempt did, reported alongside — never instead of — payment truth. */
export type AutoReceiptOutcome =
  /** The charge was not definitively successful, so nothing was attempted. */
  | { attempted: false; reason: "charge_not_definitive" }
  /** The receipt helper ran. Its own result is carried through verbatim. */
  | { attempted: true; result: SendPaymentChargeReceiptResult }
  /**
   * The helper threw. Delivery is UNKNOWN, exactly like an ambiguous provider
   * result, so it is reported and never retried.
   */
  | { attempted: true; threw: true; message: string }
  /**
   * The send outran its bound and the response was released without it. The
   * send itself was NOT cancelled and may still complete; delivery is UNKNOWN,
   * so this is reported exactly like an ambiguous provider result and is never
   * retried. The helper's atomic receipt_status claim is what makes abandoning
   * the wait safe: the in-flight attempt still owns the row.
   */
  | { attempted: true; timedOut: true; waitedMs: number };

/**
 * How long the committed-charge response may wait for the receipt.
 *
 * Generous enough that an ordinary send finishes inline — so the action can
 * report a real receipt state — and far short of sendEmailSafely's 15s, so a
 * slow provider cannot hold a practitioner mid-appointment.
 */
export const AUTO_RECEIPT_BUDGET_MS = 5_000;

/** String(err) that cannot itself throw. */
function safeStringify(err: unknown): string {
  let raw: string;
  try {
    raw = String(err);
  } catch {
    raw = "unstringifiable error";
  }
  // Matches the sanitisation the neighbouring billing paths apply: newlines
  // stripped and length capped, because this message reaches a browser.
  return raw.replace(/\s+/g, " ").trim().slice(0, 200);
}

/** Injectable for tests; production callers pass nothing and get the real helper. */
export type ReceiptSender = typeof sendPaymentChargeReceipt;

export async function autoSendReceiptAfterCharge(args: {
  charge: SessionPaymentChargeResult;
  attemptId: string;
  studioId: string;
  practitionerId: string;
  /** Test seam only. Production passes nothing. */
  send?: ReceiptSender;
  /** Test seam only. Production uses AUTO_RECEIPT_BUDGET_MS. */
  timeoutMs?: number;
}): Promise<AutoReceiptOutcome> {
  const { charge } = args;

  // THE ONLY GATE. Both limbs, deliberately — see the header.
  if (!(charge.ok === true && charge.outcome === "succeeded")) {
    return { attempted: false, reason: "charge_not_definitive" };
  }

  const send = args.send ?? sendPaymentChargeReceipt;
  const budgetMs = args.timeoutMs ?? AUTO_RECEIPT_BUDGET_MS;

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // BOUNDED, BECAUSE THE CHARGE IS ALREADY COMMITTED.
    //
    // Ten lines above the call site in payment-actions.ts sits the rule this
    // has to obey: "a PostHog outage must never delay or fail a COMMITTED
    // charge response". An email provider is a slower dependency than
    // analytics, not a faster one — sendEmailSafely allows 15s — and the
    // practitioner is holding this response with a client in front of them.
    //
    // So the WAIT is bounded, not the send. On expiry the response is released
    // and the send carries on: it already holds the atomic receipt_status
    // claim, so nothing else can duplicate it, and the row it eventually
    // writes is the truth the next render reads. Racing rather than cancelling
    // is deliberate — cancelling mid-send is what strands a row at 'sending'.
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), budgetMs);
    });
    const raced = await Promise.race([
      send({
        attemptId: args.attemptId,
        studioId: args.studioId,
        practitionerId: args.practitionerId,
      }),
      timeout,
    ]);

    if (raced === "timeout") {
      logInternal("auto_payment_receipt_timed_out", {
        attemptId: args.attemptId,
        studioId: args.studioId,
        waitedMs: budgetMs,
      });
      return { attempted: true, timedOut: true, waitedMs: budgetMs };
    }
    return { attempted: true, result: raced };
  } catch (err) {
    // The charge is already committed. Whatever happened here, the caller's
    // payment success is unchanged and this is reported, not thrown.
    //
    // `safeMessage` is computed defensively: String(err) on a pathological
    // thrown value can itself throw, and doing that INSIDE the catch would
    // escape this function and reject an action whose money already settled.
    const safeMessage = safeStringify(err);

    // AN OPS ALERT, NOT JUST A CONSOLE LINE. If the throw landed after the
    // claim, the row is stranded at 'sending' with delivery UNKNOWN — the
    // condition payment-receipt.ts already treats as critical. This path is
    // the UNATTENDED one: no practitioner clicked anything, so nobody is
    // watching for a failure the way they would after a manual Send.
    try {
      await recordOpsAlert({
        severity: "critical",
        event: "auto_payment_receipt_threw",
        message:
          "The automatic receipt send threw. Delivery is UNKNOWN and the charge " +
          "row may be stranded at receipt_status='sending'. Reconcile with the " +
          "email provider before sending again -- the client may already have it.",
        studioId: args.studioId,
        route: "lib/billing/auto-payment-receipt:autoSendReceiptAfterCharge",
        safeDetails: {
          attempt_id: args.attemptId,
          thrown: safeMessage,
        },
      });
    } catch {
      // recordOpsAlert is documented never to throw; belt and braces, because
      // an alerting failure must not become a payment failure.
    }

    logInternal("auto_payment_receipt_threw", {
      attemptId: args.attemptId,
      studioId: args.studioId,
      err: safeMessage,
    });
    return { attempted: true, threw: true, message: safeMessage };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Collapse the outcome into what a surface may truthfully say.
 *
 * "sent" is claimed ONLY when the helper recorded `sent`. Everything that is
 * merely in motion, or whose delivery cannot be established, reads as pending
 * — never as sent, and never as a reason to re-run the card.
 */
export function describeAutoReceipt(
  outcome: AutoReceiptOutcome,
): "not_attempted" | "sent" | "pending" | "needs_attention" {
  if (!outcome.attempted) return "not_attempted";
  if ("threw" in outcome) return "pending";
  if ("timedOut" in outcome) return "pending";
  const r = outcome.result;
  if (r.ok) return "sent";
  switch (r.reason) {
    // Already delivered by the other path (a manual click that won the race).
    case "already_sent":
      return "sent";
    // In motion, or delivery genuinely unknown. NOT a failure, and NOT a
    // prompt to retry: a duplicate receipt is the risk here, not a missing one.
    case "in_flight":
    case "send_ambiguous_state_not_recorded":
    case "sent_but_record_update_failed":
      return "pending";
    default:
      return "needs_attention";
  }
}
