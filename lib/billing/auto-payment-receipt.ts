import { after } from "next/server";
import {
  sendPaymentChargeReceipt,
  type SendPaymentChargeReceiptResult,
} from "@/lib/billing/payment-receipt";
import type { SessionPaymentChargeResult } from "@/lib/billing/session-payment-charge";
import { recordOpsAlert, type OpsAlertInput } from "@/lib/ops/alerts";

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
// let the rules drift, and the rule that matters most — WHICH invocations may
// send — is the one that must never drift.
//
// ---------------------------------------------------------------------------
// THE TRIGGER IS A TRANSITION, NOT A STATE  (Codex P1 4008091139)
// ---------------------------------------------------------------------------
//
// Two gates, and they are different questions.
//
//   1. IS THE MONEY DEFINITIVELY SETTLED?  `ok === true && outcome ===
//      "succeeded"`. The runner returns that shape only when Stripe succeeded
//      AND Hone durably persisted the succeeded outcome locally.
//
//      THE CASE THIS REFUSES: Stripe charged the card but Hone could not
//      confirm it wrote the ledger. That is `needs_manual_review`, it is
//      `ok: false`, and it must send NO automatic receipt — telling a client
//      "here is your receipt" when we cannot prove what we recorded is the one
//      failure worse than sending nothing.
//
//   2. DID *THIS* INVOCATION COMMIT IT?  `committedNow === true`.
//
//      `ok: true` is also returned for a REPLAY: a double-submit, a retry
//      after a retryable error, a second tab. The row was already succeeded
//      before the call, so the result is `ok: true` — correctly, the money IS
//      settled — but no new charge happened and no new receipt is owed.
//      Sending on state rather than transition makes every replay a fresh
//      automatic send attempt against the client's inbox.
//
//      This is read from the charge runner's OWN result, which is the
//      authoritative claim outcome. It is NOT inferred from a pre-read of
//      `receipt_status`, from a browser-supplied flag, from a process-local
//      Set, or from receipt_status being null — each of those is a second
//      source of truth that can disagree with the money path, and the
//      process-local ones do not survive two serverless instances at all.
//
//      Exclusivity is the DATABASE's, not ours: the succeeded write is a
//      conditional UPDATE scoped to `.eq("status","pending_stripe")`, so of
//      two concurrent invocations exactly one gets rows back and the loser
//      returns `needs_manual_review`. `committedNow: true` therefore happens
//      at most once per attempt, and the second concurrent submission is
//      already stopped by gate 1 before gate 2 is consulted.
//
// The `receipt_status` claim inside `sendPaymentChargeReceipt` is still the
// last line of defence and is NOT removed: it is what makes an automatic send
// and a simultaneous manual click safe. This gate keeps us from leaning on it
// as the ONLY defence, which is what a retryable-failure reset (payment-
// receipt.ts sets `receipt_status` back to null) would otherwise let through.
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
// NO AUTOMATIC RETRY, EVER. Retrying an AMBIGUOUS provider result would defeat
// the atomic claim: delivery is unknown, not failed, and a second attempt
// risks a duplicate receipt in the client's inbox. Ambiguity is reported and
// left for an operator.
//
// ---------------------------------------------------------------------------
// ONE SEND, TWO OBSERVERS  (Codex P1 4008091145)
// ---------------------------------------------------------------------------
//
// `send()` is called EXACTLY ONCE. Two things then watch that single promise:
//
//   * the RESPONSE, which waits at most AUTO_RECEIPT_BUDGET_MS so a
//     practitioner mid-appointment is not held by a slow mail provider; and
//   * a MANAGED CONTINUATION (`after()` from next/server), registered BEFORE
//     the response is released, which observes the SAME operation to its
//     settlement — success, failure, or late rejection — and does the logging
//     and alerting the response no longer waited for.
//
// The continuation NEVER starts a second send. It has no send of its own; it
// awaits the promise the response abandoned. "Abandoned" means unobserved by
// the response, not cancelled: cancelling mid-send is what strands a row at
// `receipt_status='sending'`.
//
// `after()` is the framework's supported post-response mechanism (Next.js
// 15.5.22, stable, already used by lib/analytics/server.ts) and this app
// deploys to Vercel, where `after()` work is executed and billed as part of
// the same invocation.
//
// WHAT THIS IS NOT. `after()` is best-effort post-response execution, NOT a
// durable queue and NOT exactly-once delivery:
//
//   * If the serverless instance is killed — crash, OOM, or the function's
//     max duration elapsing — pending `after()` work dies with it. A send
//     already handed to the provider may still deliver; one that had not yet
//     reached the provider simply does not happen.
//   * Nothing re-runs the continuation. There is no retry, no dead letter,
//     and no recovery on the next request.
//   * The honest guarantee is therefore: AT MOST ONE automatic send per
//     committed charge, with VISIBILITY into how it ended whenever the
//     instance survives long enough to report. Not at-least-once, and not
//     exactly-once.
//
// Durable delivery would need the outbox/queue this task explicitly does not
// authorise. The manual Send button remains the operator's recovery path, and
// the row's `receipt_status` remains the state of record.
//
// ---------------------------------------------------------------------------
// ALERTING IS OUTSIDE THE COMMITTED-PAYMENT BUDGET  (Codex P2 4008091156)
// ---------------------------------------------------------------------------
//
// `recordOpsAlert` does a Supabase insert and then, for critical severity, a
// Resend call — an unbounded second network dependency. Awaiting it on the
// committed-charge response reintroduces exactly the delay the budget above
// exists to prevent, and does so on the WORST path, when something has already
// gone wrong.
//
// So alerts go to the same managed continuation, never to a bare
// fire-and-forget promise. The one case that still awaits is when registration
// is unavailable (outside request scope) — there is no response being held in
// that case, so awaiting preserves visibility at no cost to any budget.
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

/** What the automatic attempt did, reported alongside — never instead of — payment truth. */
export type AutoReceiptOutcome =
  /**
   * Nothing was attempted.
   *
   * `charge_not_definitive` — the charge is not a durably-persisted success.
   * `replay_not_a_new_charge` — the money is settled, but an EARLIER
   * invocation committed it; this one is a replay and owes no receipt.
   */
  | {
      attempted: false;
      reason: "charge_not_definitive" | "replay_not_a_new_charge";
    }
  /** The receipt helper ran and settled within the wait. Result carried verbatim. */
  | { attempted: true; result: SendPaymentChargeReceiptResult }
  /**
   * The helper threw. Delivery is UNKNOWN, exactly like an ambiguous provider
   * result, so it is reported and never retried.
   */
  | { attempted: true; threw: true; message: string }
  /**
   * The send outran the response's wait. The send itself was NOT cancelled and
   * is still running under the managed continuation, which will observe its
   * settlement. Delivery is UNKNOWN at the moment of reporting, so this reads
   * exactly like an ambiguous provider result and is never retried.
   *
   * `continuationManaged` is false when `after()` was unavailable — the send
   * still runs, but nothing guarantees the runtime stays alive to see it end.
   */
  | {
      attempted: true;
      timedOut: true;
      waitedMs: number;
      continuationManaged: boolean;
    };

/**
 * How long the committed-charge response may wait for the receipt.
 *
 * Generous enough that an ordinary send finishes inline — so the action can
 * report a real receipt state — and far short of sendEmailSafely's 15s, so a
 * slow provider cannot hold a practitioner mid-appointment.
 */
export const AUTO_RECEIPT_BUDGET_MS = 5_000;

/** Injectable for tests; production callers pass nothing and get the real helper. */
export type ReceiptSender = typeof sendPaymentChargeReceipt;

/**
 * The framework's post-response scheduler. Injectable so the continuation's
 * registration, its timing, and its unavailable-fallback are all provable
 * without a live request scope.
 */
export type ContinuationScheduler = (work: Promise<unknown>) => void;

/** An alert that can never reject. Alerting failure is never payment failure. */
function safeAlert(input: OpsAlertInput): Promise<void> {
  return (async () => {
    try {
      await recordOpsAlert(input);
    } catch {
      // recordOpsAlert is documented never to throw; belt and braces.
    }
  })();
}

/**
 * Hand work to the managed continuation.
 *
 * Returns false when registration is unavailable (no request scope, or
 * `after()` rejecting the call) so the caller can choose a truthful fallback
 * rather than silently believing the work is managed.
 */
function tryRegister(
  register: ContinuationScheduler,
  work: Promise<unknown>,
): boolean {
  try {
    register(work);
    return true;
  } catch {
    return false;
  }
}

/** A settlement of the single send, captured so neither observer can reject. */
type Settled =
  | { kind: "result"; result: SendPaymentChargeReceiptResult }
  | { kind: "threw"; message: string };

const TIMEOUT = Symbol("auto-receipt-wait-exceeded");

const STRANDED_ADVICE =
  "Delivery is UNKNOWN and the charge row may be stranded at " +
  "receipt_status='sending'. Reconcile with the email provider before " +
  "sending again -- the client may already have it.";

export async function autoSendReceiptAfterCharge(args: {
  charge: SessionPaymentChargeResult;
  attemptId: string;
  studioId: string;
  practitionerId: string;
  /** Test seam only. Production passes nothing. */
  send?: ReceiptSender;
  /** Test seam only. Production uses AUTO_RECEIPT_BUDGET_MS. */
  timeoutMs?: number;
  /** Test seam only. Production uses `after` from next/server. */
  register?: ContinuationScheduler;
}): Promise<AutoReceiptOutcome> {
  const { charge } = args;

  // GATE 1 — is the money definitively settled? Both limbs deliberately, even
  // though the type makes the second redundant: a future widening of the union
  // would otherwise pass silently.
  if (!(charge.ok === true && charge.outcome === "succeeded")) {
    return { attempted: false, reason: "charge_not_definitive" };
  }

  // GATE 2 — did THIS invocation commit it? See the header: a replay is a
  // legitimate `ok: true` that owes no receipt.
  if (charge.committedNow !== true) {
    return { attempted: false, reason: "replay_not_a_new_charge" };
  }

  const send = args.send ?? sendPaymentChargeReceipt;
  const register = args.register ?? after;
  const budgetMs = args.timeoutMs ?? AUTO_RECEIPT_BUDGET_MS;
  const ctx = {
    attemptId: args.attemptId,
    studioId: args.studioId,
    practitionerId: args.practitionerId,
  };

  // THE ONE SEND. There is never a second one, on any path.
  let inFlight: Promise<SendPaymentChargeReceiptResult>;
  try {
    inFlight = send(ctx);
  } catch (err) {
    // Threw synchronously: no provider call is in flight and no claim was
    // taken, so nothing is stranded — but the receipt did not happen and
    // nobody clicked anything, so it still needs to be visible.
    const message = safeStringify(err);
    const alert = safeAlert({
      severity: "critical",
      event: "auto_payment_receipt_threw",
      message:
        "The automatic receipt send threw before reaching the provider. " +
        "No receipt was sent for a committed charge.",
      studioId: args.studioId,
      route: "lib/billing/auto-payment-receipt:autoSendReceiptAfterCharge",
      safeDetails: { attempt_id: args.attemptId, thrown: message },
    });
    if (!tryRegister(register, alert)) await alert;
    logInternal("auto_payment_receipt_threw", { ...ctx, err: message });
    return { attempted: true, threw: true, message };
  }

  // A settled record of THE SAME operation. Because this never rejects,
  // neither the race nor the continuation can produce an unhandled rejection,
  // and a LATE rejection — after the response was already released — lands
  // here as `kind: "threw"` rather than escaping into the runtime.
  const observed: Promise<Settled> = inFlight.then(
    (result) => ({ kind: "result", result }) as const,
    (err) => ({ kind: "threw", message: safeStringify(err) }) as const,
  );

  // Resolved by this function once it knows whether it reported inline. Using
  // an explicit decision rather than a mutable flag keeps the continuation
  // free of any dependence on microtask ordering between the two observers.
  let decide!: (d: "inline" | "late") => void;
  const decision = new Promise<"inline" | "late">((resolve) => {
    decide = resolve;
  });

  const continuation = decision
    .then(async (d) => {
      // The action's response already carried this outcome; nothing is owed.
      if (d === "inline") return;
      // THE SAME operation, still running. Not a new send.
      await reportLateSettlement(await observed, ctx);
    })
    .catch(() => {
      // The continuation is the last observer. It swallows rather than
      // rejecting into the runtime.
    });

  // REGISTERED BEFORE THE RESPONSE IS RELEASED — before the race below is even
  // awaited, so registration cannot lose to a fast send or a fast timeout.
  const continuationManaged = tryRegister(register, continuation);

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // BOUNDED WAIT, BECAUSE THE CHARGE IS ALREADY COMMITTED.
    //
    // Ten lines above the call site in payment-actions.ts sits the rule this
    // has to obey: "a PostHog outage must never delay or fail a COMMITTED
    // charge response". An email provider is a slower dependency than
    // analytics, not a faster one, and the practitioner is holding this
    // response with a client in front of them.
    //
    // The WAIT is bounded; the SEND is not. On expiry the response is released
    // and the send carries on under the continuation registered above.
    const timeout = new Promise<typeof TIMEOUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMEOUT), budgetMs);
    });
    const raced = await Promise.race([observed, timeout]);

    if (raced === TIMEOUT) {
      decide("late");
      logInternal("auto_payment_receipt_wait_exceeded", {
        ...ctx,
        waitedMs: budgetMs,
        continuationManaged,
      });
      return {
        attempted: true,
        timedOut: true,
        waitedMs: budgetMs,
        continuationManaged,
      };
    }

    decide("inline");

    if (raced.kind === "threw") {
      // An ASYNC throw that beat the budget. If it landed after the claim, the
      // row is stranded at 'sending' with delivery UNKNOWN — the condition
      // payment-receipt.ts already treats as critical. This path is the
      // UNATTENDED one: no practitioner clicked anything, so nobody is
      // watching for a failure the way they would after a manual Send.
      const alert = safeAlert({
        severity: "critical",
        event: "auto_payment_receipt_threw",
        message: `The automatic receipt send threw. ${STRANDED_ADVICE}`,
        studioId: args.studioId,
        route: "lib/billing/auto-payment-receipt:autoSendReceiptAfterCharge",
        safeDetails: {
          attempt_id: args.attemptId,
          thrown: raced.message,
        },
      });
      // Out of band: a critical alert does a DB insert AND a Resend call, and
      // this response is a committed charge.
      if (!tryRegister(register, alert)) await alert;
      logInternal("auto_payment_receipt_threw", { ...ctx, err: raced.message });
      return { attempted: true, threw: true, message: raced.message };
    }

    return { attempted: true, result: raced.result };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    // Backstop: an undecided decision would leave the continuation pending and
    // hold the invocation open to its max duration. Resolving twice is a no-op.
    decide("inline");
  }
}

/**
 * Observe the settlement the response no longer waited for.
 *
 * Runs inside the managed continuation, which is already outside the
 * committed-charge response budget, so it awaits its alerts directly. It sends
 * nothing and retries nothing — it only records how the one send ended.
 */
async function reportLateSettlement(
  late: Settled,
  ctx: { attemptId: string; studioId: string; practitionerId: string },
): Promise<void> {
  if (late.kind === "threw") {
    logInternal("auto_payment_receipt_late_threw", {
      ...ctx,
      err: late.message,
    });
    await safeAlert({
      severity: "critical",
      event: "auto_payment_receipt_late_threw",
      message:
        `The automatic receipt send threw after the response was released. ${STRANDED_ADVICE}`,
      studioId: ctx.studioId,
      route: "lib/billing/auto-payment-receipt:reportLateSettlement",
      safeDetails: { attempt_id: ctx.attemptId, thrown: late.message },
    });
    return;
  }

  const r = late.result;
  logInternal("auto_payment_receipt_late_settled", {
    ...ctx,
    ok: r.ok,
    reason: r.ok ? null : r.reason,
  });

  // It landed, just slowly. Nothing to alert.
  if (r.ok) return;

  // Benign: another path owns it, or already delivered it.
  if (r.reason === "already_sent" || r.reason === "in_flight") return;

  // The stuck-at-'sending' family: an operator must reconcile before any
  // resend, because a duplicate receipt is the risk, not a missing one.
  const stateUnknown =
    r.reason === "send_ambiguous_state_not_recorded" ||
    r.reason === "send_failed_state_not_recorded" ||
    r.reason === "sent_but_record_update_failed";

  await safeAlert({
    severity: stateUnknown ? "critical" : "warning",
    event: "auto_payment_receipt_late_failed",
    message: stateUnknown
      ? `A slow automatic receipt ended in an unrecorded state. ${STRANDED_ADVICE}`
      : "A slow automatic receipt failed after the response was released. " +
        "The charge is unaffected; the receipt can be sent manually.",
    studioId: ctx.studioId,
    route: "lib/billing/auto-payment-receipt:reportLateSettlement",
    safeDetails: { attempt_id: ctx.attemptId, reason: r.reason },
  });
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
