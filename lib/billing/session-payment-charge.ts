import "server-only";
import Stripe from "stripe";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { inferStripeLivemode } from "@/lib/stripe/server";
import { getSessionPaymentStripe } from "@/lib/stripe/session-payment-stripe";
import { recordOpsAlert } from "@/lib/ops/alerts";
import { getChargeReadyCardAuthorizationStatus } from "@/lib/consent/current-card-authorization";
import { buildChargeDescription } from "@/lib/billing/charge-description";

// ---------------------------------------------------------------------------
// runSessionPaymentCharge (PR #173).
// ---------------------------------------------------------------------------
//
// Mode-aware execution helper (test or live, per the deployment) for a
// prepared session_payment
// payment_charge_attempts row. Faithful port of
// lib/billing/the (removed, PR #218) legacy manual-fee executor:runManualFeeCharge (PR #146)
// adapted for the canonical payment_charge_attempts ledger
// (migration 0073 + 0074 + the PR #173 claim RPC migration 0075).
//
// What this helper does:
//   1. PR #323: env-gated for live capability. Derives the deployment mode via
//      inferStripeLivemode() and enforces mode-consistency (the row/card/settings
//      /customer must all match it); live charging stays gated by the Stripe
//      key/env layer (getStripe() rejects sk_live_ unless the flag is set).
//   2. Loads the attempt row + re-runs eligibility checks. Card
//      lineage (active, livemode=false, signature matches the
//      stamped id), studio Stripe settings, customer mapping, and
//      crucially a PR #170-style current-card-authorization recheck
//      so a freshly-stale signature blocks the charge.
//   3. Calls the claim_session_payment_charge_attempt RPC. The RPC
//      atomically transitions status='ready' -> 'pending_stripe'
//      and stamps the deterministic idempotency key
//      hone:session_payment:<attemptId>:v1. Caller never bypasses
//      the RPC to claim the row directly.
//   4. Calls the Stripe PaymentIntent create API with
//      confirm=true. The connected account context is the studio's
//      stripe_account_id. The idempotency key is the deterministic
//      shape; Stripe's 24-hour replay covers the network-error
//      retry path.
//   5. Writes the success outcome (status='succeeded', PI id, PI
//      latest_charge id, stripe_status, charged_at) OR the failure
//      outcome (status='failed', failure_code, failure_message_safe,
//      failed_at) on the same row. Records ops_alerts on failure
//      paths with severity matching the manual fee precedent.
//
// What this helper deliberately does NOT do:
//   * Charges only in the deployment's Stripe mode: the row, card,
//     settings, and customer must all match inferStripeLivemode()
//     (mode-consistency guards below); the key/env gate in
//     lib/stripe/server.ts is the platform-level brace.
//   * Does NOT send a receipt email. Receipt path is PR #172's
//     follow-up.
//   * Does NOT refund or retry a failed/cancelled row. PR #173
//     refuses to re-execute any non-'ready' row except the
//     reconciliation path on a stale pending_stripe.
//   * Does NOT set application_fee_amount. PR #169 / docs/16 §12.7
//     pinned 0% Hone platform fee in v1.
//   * Does NOT set statement_descriptor_suffix or receipt_email.
//   * Does NOT touch manual_fee_charge_attempts.
//   * Does NOT add any SMS / email / webhook side effects beyond
//     the existing ops_alert + structured-log surface.

const RECONCILIATION_WINDOW_MINUTES = 60;
const FAILURE_MESSAGE_MAX = 1000;
const FAILURE_CODE_MAX = 100;
// Mode-mismatch refusal (row stripe_livemode vs deployment mode); the
// historical constant/outcome name is kept: renaming is an API change.
const LIVE_MODE_BLOCKED_MESSAGE =
  "This payment's mode does not match the current deployment mode.";
const NEEDS_MANUAL_REVIEW_MESSAGE =
  "This charge is pending and needs manual review before retrying.";
// PR #281: Stripe reported success but Hone could not confirm the local
// ledger write. Surfaced to the practitioner verbatim; carries no card
// data, raw Stripe payload, secrets, or sensitive client data.
const SUCCESS_NOT_PERSISTED_MESSAGE =
  "Stripe reported the payment as succeeded, but Hone could not confirm the local payment record. Review the payment in Stripe and Hone before retrying.";
const GENERIC_LINEAGE_MISMATCH_MESSAGE =
  "Card or studio details no longer match this session payment. Refresh and try again.";
const AUTHENTICATION_REQUIRED_MESSAGE =
  "The saved card requires customer authentication and could not be charged off-session.";

// PR #196: reason-scoped deterministic key. session_payment keeps its
// historical format so in-flight rows replay identically; fee reasons
// get their own namespace.
function buildIdempotencyKey(attemptId: string, chargeReason: string): string {
  if (chargeReason === "session_payment") {
    return `hone:session_payment:${attemptId}:v1`;
  }
  return `hone:${chargeReason}:${attemptId}:v1`;
}

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

function sanitizeFailureCode(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return raw.slice(0, FAILURE_CODE_MAX);
}

function sanitizeFailureMessage(
  raw: string | null | undefined,
): string | null {
  if (!raw) return null;
  // Strip newlines so a multi-line Stripe error cannot break out of a
  // single audit line; cap length so a paste-bomb cannot fill the
  // column.
  return raw.replace(/\s+/g, " ").trim().slice(0, FAILURE_MESSAGE_MAX);
}

export type SessionPaymentChargeResult =
  | {
      ok: true;
      outcome: "succeeded";
      stripePaymentIntentId: string;
      stripeChargeId: string | null;
      /**
       * TRUE only when THIS invocation moved the row to succeeded; FALSE when
       * it short-circuited on a row that was already succeeded before the
       * call.
       *
       * Both are `ok: true` — a replay is a legitimate no-op and the money is
       * settled either way — but they are NOT the same event, and anything
       * that must happen ONCE PER CHARGE (notably the automatic receipt in
       * lib/billing/auto-payment-receipt.ts) keys off the TRANSITION, not the
       * state.
       *
       * Exclusive at the DATABASE, not merely observed here: the succeeded
       * write is a conditional UPDATE scoped to `.eq("status",
       * "pending_stripe")`, so of two concurrent invocations exactly one gets
       * rows back; the loser reports needs_manual_review, never a second
       * committedNow. Both fresh sites additionally sit behind
       * `if (!persistence.persisted) return needs_manual_review`.
       *
       * PAY-ZERO-ROW-RACE-01: that reasoning considered only a second
       * SYNCHRONOUS invocation. The `payment_intent.succeeded` webhook is a
       * THIRD writer (`reconcile_card_payment_succeeded`, 0187) which takes the
       * appointment advisory key and `FOR UPDATE`, so when IT wins the row this
       * invocation's conditional UPDATE matches zero rows and `committedNow`
       * becomes true ZERO times for a charge that really happened. See
       * `concurrentlyReconciled` below.
       *
       * IT IS NO LONGER THE RECEIPT INPUT. `committedNow` answers a question
       * about the LEDGER WRITE, and receipt dispatch turns on a different
       * question about WHOSE CHARGE IT IS -- see `receiptOwnedHere`. Two review
       * rounds each found a duplicate-receipt path because those two questions
       * were being answered by the same field, and each fix closed one branch
       * while its sibling stayed open.
       */
      committedNow: boolean;
      /**
       * TRUE only when ALL of these hold:
       *
       *   1. THIS invocation created and confirmed the PaymentIntent, and
       *   2. Stripe reported it `succeeded`, and
       *   3. the ledger row was ALREADY stamped succeeded by a different
       *      legitimate writer before our conditional UPDATE ran, and
       *   4. an authoritative re-read proved that row records the IDENTICAL
       *      charge — same attempt, PaymentIntent, charge lineage, studio,
       *      client, livemode, amount, currency and charge reason.
       *
       * THE MONEY IS SETTLED AND A RECEIPT IS STILL OWED. This is NOT a replay:
       * a replay short-circuits before any PaymentIntent is created and owes
       * nothing. Here a brand-new real charge exists that nobody has receipted,
       * so `lib/billing/auto-payment-receipt.ts` treats this exactly like
       * `committedNow` for the receipt decision and differently everywhere else.
       *
       * A VERIFICATION FACT, NOT AN OWNERSHIP FACT. It says the ledger is
       * correct and who made it so; it says nothing about whether THIS
       * invocation may send the receipt. That is `receiptOwnedHere`.
       */
      concurrentlyReconciled?: boolean;
      /**
       * WHY THERE IS NO PROCESS-LEVEL RECEIPT-OWNER FIELD HERE.
       *
       * A `receiptOwnedHere` field lived here for one revision, anchored to
       * `claim.result === "claimed"`. It gave exclusivity and lost LIVENESS: when
       * the claim winner died after Stripe succeeded, the invocation that
       * recovered the charge was forbidden to receipt it and nobody could.
       *
       * EMAIL OWNERSHIP IS NOT A FACT ABOUT A PROCESS. It is the durable
       * `receipt_status: null -> sending` claim in
       * `lib/billing/payment-receipt.ts`, which survives a dead process and
       * admits exactly one winner. The two fields above say who moved the MONEY;
       * `lib/billing/auto-payment-receipt.ts` uses them only to decide who may
       * ATTEMPT a send, and the database decides who actually does.
       */
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
      message: string;
      blockingReasons?: string[];
      failureCode?: string | null;
      // PR #281: non-sensitive reconciliation identifiers for the
      // needs_manual_review-after-Stripe-success case. Let an operator
      // bind the indeterminate result to the real Stripe charge + the
      // local attempt row. Never card data / raw payload / secrets.
      stripePaymentIntentId?: string;
      attemptId?: string;
    };

// PAY-SETTLE / 0187. Practitioner-facing, safe, and specific about WHY: a
// generic "not in a chargeable state" would send Chloe hunting for a card
// problem that does not exist.
const SETTLED_EXTERNALLY_MESSAGE =
  "This appointment already has a recorded outcome (paid another way, or waived), so no card charge was made. The studio owner can correct that record if a card charge is the right thing.";

type ClaimRow = {
  result: string;
  attempt_id: string | null;
  studio_id: string | null;
  client_id: string | null;
  session_id: string | null;
  appointment_id: string | null;
  charge_reason: string | null;
  amount_cents: number | null;
  currency: string | null;
  client_payment_method_id: string | null;
  card_authorization_signature_id: string | null;
  stripe_account_id: string | null;
  stripe_customer_id: string | null;
  stripe_payment_method_id: string | null;
  stripe_payment_intent_id: string | null;
  stripe_idempotency_key: string | null;
  status_before_claim: string | null;
  updated_at: string | null;
};

type CardRow = {
  id: string;
  studio_id: string;
  client_id: string;
  status: string;
  stripe_livemode: boolean;
  stripe_account_id: string;
  stripe_customer_id: string;
  stripe_payment_method_id: string;
  card_authorization_signature_id: string | null;
};

// Re-verifies the card / lineage at charge time. The eligibility
// helper already covered most of this at prepare time, but the
// row could have changed between prepare and charge.
async function loadCardAndVerifyLineage(args: {
  studioId: string;
  clientId: string;
  clientPaymentMethodId: string;
  expectedSignatureId: string;
  expectedStripeAccountId: string;
  expectedStripeCustomerId: string;
  expectedStripePaymentMethodId: string;
}): Promise<
  | { ok: true; card: CardRow }
  | { ok: false; reasons: string[] }
> {
  const admin = createAdminClient();
  const reasons: string[] = [];
  // PR #323: mode-consistency lineage checks compare against the CURRENT
  // deployment mode (inferStripeLivemode()), not a hardcoded false. In test env
  // this is false (identical to before); in live env every lineage row
  // (card / settings / customer) must be live too. These are SECURITY checks
  // (account == customer == PM == attempt share one mode), preserved, only the
  // compared constant changes.
  const livemode = inferStripeLivemode();

  const { data: cardRow } = await admin
    .from("client_payment_methods")
    .select(
      "id, studio_id, client_id, status, stripe_livemode, stripe_account_id, stripe_customer_id, stripe_payment_method_id, card_authorization_signature_id",
    )
    .eq("id", args.clientPaymentMethodId)
    .maybeSingle();
  const card = cardRow as CardRow | null;
  if (!card) {
    reasons.push("Card on file is missing.");
  } else {
    if (card.studio_id !== args.studioId) {
      reasons.push("Card on file does not belong to this studio.");
    }
    if (card.client_id !== args.clientId) {
      reasons.push("Card on file does not belong to this client.");
    }
    if (card.status !== "active") {
      reasons.push("Card on file is not active.");
    }
    if (card.stripe_livemode !== livemode) {
      reasons.push("Card on file mode does not match the deployment mode.");
    }
    if (!card.stripe_account_id) {
      reasons.push("Card on file has no connected account.");
    }
    if (!card.stripe_customer_id) {
      reasons.push("Card on file has no Stripe customer.");
    }
    if (!card.stripe_payment_method_id) {
      reasons.push("Card on file has no Stripe payment method.");
    }
    if (
      card.card_authorization_signature_id !== args.expectedSignatureId
    ) {
      reasons.push(
        "Card authorization signature has changed since the session payment was prepared.",
      );
    }
    if (card.stripe_account_id !== args.expectedStripeAccountId) {
      reasons.push(
        "Stripe connected account on the card no longer matches the prepared attempt.",
      );
    }
    if (card.stripe_customer_id !== args.expectedStripeCustomerId) {
      reasons.push(
        "Stripe customer on the card no longer matches the prepared attempt.",
      );
    }
    if (card.stripe_payment_method_id !== args.expectedStripePaymentMethodId) {
      reasons.push(
        "Stripe payment method on the card no longer matches the prepared attempt.",
      );
    }
  }

  // The studio's currently-configured connected account must match
  // the card row.
  if (card) {
    // Mode-scoped (0103): a studio can hold one settings row per Stripe
    // mode; verify against the CURRENT deployment mode's row only (the
    // stripe_livemode !== livemode belt below stays as defense-in-depth).
    const { data: settings } = await admin
      .from("studio_payment_settings")
      .select("stripe_account_id, stripe_livemode")
      .eq("studio_id", args.studioId)
      .eq("stripe_livemode", livemode)
      .maybeSingle();
    if (!settings) {
      reasons.push("Studio payment settings are missing.");
    } else {
      if (settings.stripe_account_id !== card.stripe_account_id) {
        reasons.push(
          "Studio is now connected to a different Stripe account.",
        );
      }
      if (settings.stripe_livemode !== livemode) {
        reasons.push(
          "Studio payment settings mode does not match the deployment mode.",
        );
      }
    }

    const { data: customer } = await admin
      .from("client_stripe_customers")
      .select("stripe_customer_id")
      .eq("studio_id", args.studioId)
      .eq("client_id", args.clientId)
      .eq("stripe_account_id", card.stripe_account_id)
      .eq("stripe_livemode", livemode)
      .maybeSingle();
    if (!customer) {
      reasons.push("Stripe customer mapping is missing.");
    } else if (customer.stripe_customer_id !== card.stripe_customer_id) {
      reasons.push("Stripe customer mapping does not match the card.");
    }
  }

  if (reasons.length > 0) {
    return { ok: false, reasons };
  }
  return { ok: true, card: card! };
}

// PR #281: a payment may only return a NORMAL 'succeeded' result when
// Stripe succeeded AND Hone persisted that success on the local ledger
// row. writeSucceededOutcome reports which of those happened so the
// caller never reports a clean success it could not persist. Mirrors
// the refund helper's writeOkErr || okWriteZeroRows -> needs_manual_review
// posture (lib/billing/payment-refund.ts).
type SuccessPersistenceResult =
  | { persisted: true; by: "this_invocation" }
  /**
   * The row is correct and records THIS charge, but a different legitimate
   * writer stamped it first. Still `persisted: true`, so every existing
   * `if (!persistence.persisted)` guard keeps its meaning untouched.
   *
   * OWNERSHIP IS NOT A PERSISTENCE FACT and is deliberately absent here. An
   * earlier revision returned `receiptOwed` from this union, which put the
   * ownership rule inside the writer and left each call site to combine it with
   * `by` -- so `concurrentlyReconciled` got the gate and `committedNow` did not.
   * Ownership now lives in ONE place (`claim.result === "claimed"`) and travels
   * on the RESULT, not on the persistence outcome.
   */
  | { persisted: true; by: "concurrent_writer" }
  | { persisted: false; reason: "db_error" | "zero_rows" };

// Snapshots a successful PaymentIntent back onto the attempt row.
// Returns whether the success outcome was durably persisted: the
// caller must NOT report a normal success unless persisted === true.
/**
 * Is a zero-row succeeded write PROVABLY the benign concurrent-writer race?
 *
 * PAY-ZERO-ROW-RACE-01. A zero-row conditional UPDATE says only "the row left
 * pending_stripe before I got there". It does NOT say who moved it or why, and
 * the two possibilities are opposites:
 *
 *   BENIGN    the `payment_intent.succeeded` webhook reconciled the IDENTICAL
 *             charge onto the row microseconds earlier. The ledger is already
 *             right and nothing is owed but the receipt.
 *   DANGEROUS the row was cancelled, failed, blocked, settled in cash, or
 *             stamped with a DIFFERENT PaymentIntent. Real money moved against
 *             a row that does not record it.
 *
 * Today both raise CRITICAL, which is why a correct ledger woke an operator.
 * This proves which one happened BEFORE any alert is written, and every single
 * fact must line up: anything missing, mismatched, unreadable or terminal falls
 * through to CRITICAL. The default is manual review; benign is the exception
 * that must be earned.
 */
async function classifyZeroRowSuccessWrite(args: {
  attemptId: string;
  studioId: string;
  clientId: string;
  pi: Stripe.PaymentIntent;
  expectedChargeReason: string | null;
  expectedLatestChargeId: string | null;
}): Promise<
  | { benign: true; row: ZeroRowRecheckRow }
  | { benign: false; why: string; observedStatus: string | null }
> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("payment_charge_attempts")
    .select(
      "id, studio_id, client_id, status, charge_reason, amount_cents, currency, " +
        "stripe_livemode, stripe_payment_intent_id, stripe_charge_id, " +
        "cancelled_at, refund_status",
    )
    .eq("id", args.attemptId)
    .maybeSingle();

  // UNREADABLE IS NOT BENIGN. A read error or a missing row leaves us unable to
  // say anything about a real charge, which is the definition of manual review.
  if (error) {
    return { benign: false, why: `recheck_read_error:${error.code ?? "unknown"}`, observedStatus: null };
  }
  if (!data) {
    return { benign: false, why: "recheck_row_missing", observedStatus: null };
  }
  const row = data as unknown as ZeroRowRecheckRow;

  // Every predicate is stated separately so the alert can name WHICH one failed.
  // `pi.amount` and `pi.currency` are Stripe's own numbers, so the money facts
  // are compared against the provider rather than against our own expectations.
  const checks: ReadonlyArray<readonly [boolean, string]> = [
    [row.id === args.attemptId, "attempt_id_mismatch"],
    [row.status === "succeeded", "status_not_succeeded"],
    [row.studio_id === args.studioId, "studio_mismatch"],
    [row.client_id === args.clientId, "client_mismatch"],
    [row.stripe_payment_intent_id === args.pi.id, "payment_intent_mismatch"],
    [row.stripe_livemode === args.pi.livemode, "livemode_mismatch"],
    [row.amount_cents === args.pi.amount, "amount_mismatch"],
    [
      (row.currency ?? "").toLowerCase() === (args.pi.currency ?? "").toLowerCase(),
      "currency_mismatch",
    ],
    [row.charge_reason === args.expectedChargeReason, "charge_reason_mismatch"],
    [row.cancelled_at === null, "row_cancelled"],
    // ANY refund activity at all, not just a COMPLETED one. `!== "succeeded"`
    // accepted `pending_stripe`, i.e. a refund already in flight with an unknown
    // Stripe outcome — and then sent the client an automatic receipt for money
    // that is on its way back. Before this repair every zero-row write stayed
    // fail-closed, so that was a regression, not a pre-existing gap. NULL is the
    // only benign value.
    [row.refund_status === null, "refund_in_progress_or_done"],
    // CHARGE LINEAGE, AND IT IS DELIBERATELY ASYMMETRIC.
    //
    // A NULL ROW VALUE is compatible: the concurrent writer coalesces and may not
    // have persisted the charge id yet, so its absence proves nothing either way
    // and every other identity and money fact still has to match.
    //
    // A NON-NULL ROW VALUE MUST BE PROVEN EQUAL. An earlier revision also
    // accepted any row value whenever the PROVIDER's latest_charge was null,
    // which is a different exception entirely and was not the one documented: a
    // missing provider charge id cannot establish that some arbitrary charge on
    // the row is this charge. That would let a conflicting lineage suppress the
    // critical alert and, with ownership, trigger a receipt.
    [
      row.stripe_charge_id === null
        ? true
        : args.expectedLatestChargeId !== null &&
          row.stripe_charge_id === args.expectedLatestChargeId,
      "charge_id_mismatch",
    ],
  ];
  for (const [ok, why] of checks) {
    if (!ok) return { benign: false, why, observedStatus: row.status };
  }
  return { benign: true, row };
}

type ZeroRowRecheckRow = {
  id: string;
  studio_id: string;
  client_id: string;
  status: string;
  charge_reason: string | null;
  amount_cents: number;
  currency: string | null;
  stripe_livemode: boolean;
  stripe_payment_intent_id: string | null;
  stripe_charge_id: string | null;
  cancelled_at: string | null;
  refund_status: string | null;
};

async function writeSucceededOutcome(args: {
  attemptId: string;
  studioId: string;
  clientId: string;
  pi: Stripe.PaymentIntent;
  /**
   * The attempt's charge_reason as this invocation read it, compared against the
   * re-read so a zero-row race cannot be blessed across a different charge kind.
   */
  expectedChargeReason: string | null;
}): Promise<SuccessPersistenceResult> {
  const admin = createAdminClient();
  const latestCharge =
    typeof args.pi.latest_charge === "string"
      ? args.pi.latest_charge
      : (args.pi.latest_charge?.id ?? null);
  const { data: updatedRows, error } = await admin
    .from("payment_charge_attempts")
    .update({
      status: "succeeded",
      stripe_payment_intent_id: args.pi.id,
      stripe_charge_id: latestCharge,
      stripe_status: args.pi.status,
      charged_at: new Date().toISOString(),
      failed_at: null,
      failure_code: null,
      failure_message_safe: null,
    })
    .eq("id", args.attemptId)
    .eq("status", "pending_stripe")
    .select("id");
  if (error) {
    // PR #281: the PaymentIntent already succeeded at Stripe, so a DB
    // error on the succeeded-outcome write is a real-money / unstamped-
    // ledger split. PR #263 only logged this to stderr; raise a CRITICAL
    // ops alert (the operator's wake-up signal) and tell the caller the
    // success was NOT persisted so it returns needs_manual_review rather
    // than a clean success. The webhook payment_intent.succeeded handler
    // (PR #179) remains the eventual-consistency backstop; the row stays
    // 'pending_stripe' for it to reconcile.
    logInternal("session_payment_succeeded_write_failed", {
      code: error.code,
      message: error.message,
      attemptId: args.attemptId,
    });
    await recordOpsAlert({
      severity: "critical",
      event: "session_payment_succeeded_write_failed",
      message:
        "PaymentIntent succeeded but Hone could not persist the succeeded outcome on the attempt row (DB error). The charge is real on Stripe; the row stays 'pending_stripe' until reconciled (webhook backstop or manual). Manual reconciliation required.",
      studioId: args.studioId,
      clientId: args.clientId,
      stripePaymentIntentId: args.pi.id,
      route: "lib/billing/session-payment-charge:writeSucceededOutcome",
      safeDetails: {
        attempt_id: args.attemptId,
        attempted_status: "succeeded",
        db_code: error.code ?? null,
      },
    });
    return { persisted: false, reason: "db_error" };
  }
  // PR #263: zero-row detection. A status-conditional UPDATE that
  // matches no row (the attempt left 'pending_stripe' before this
  // write) returns no error but persists nothing. The PaymentIntent
  // already succeeded at Stripe, so a silent no-op would leave the
  // ledger row unstamped while real money moved. Surface for manual
  // reconciliation instead of continuing as if the outcome was recorded.
  if (!updatedRows || updatedRows.length === 0) {
    // PAY-ZERO-ROW-RACE-01. CLASSIFY BEFORE ALERTING.
    //
    // A real incident (2026-09-27, pi_3UKQ8h…) woke an operator at CRITICAL for a
    // ledger that was already completely correct: the payment_intent.succeeded
    // webhook's reconcile command had stamped the identical charge 2.1s earlier.
    // The alert was true about the zero rows and false about everything an
    // operator would act on.
    //
    // So the row is re-read FIRST and the alert is only written if the benign
    // race cannot be proved. Establishing safety before the alert write is
    // deliberate: a critical money alert that turns out to be noise is not a
    // harmless false positive, it is a cost on the one signal that must stay
    // trustworthy.
    const verdict = await classifyZeroRowSuccessWrite({
      attemptId: args.attemptId,
      studioId: args.studioId,
      clientId: args.clientId,
      pi: args.pi,
      expectedChargeReason: args.expectedChargeReason,
      expectedLatestChargeId: latestCharge,
    });

    if (verdict.benign) {
      // THE LEDGER IS RIGHT AND NO MONEY IS AT RISK. Recorded at WARNING, not
      // critical: the race is real, worth watching and worth a paging-free
      // signal, but there is nothing for a human to reconcile. Only `critical`
      // pages (lib/ops/alerts.ts), so this stays out of the manual-review queue
      // while remaining visible if the race becomes frequent.
      // THIS ALERT MAKES NO RECEIPT CLAIM AT ALL, and that is the point.
      //
      // It is written here, inside the charge writer, BEFORE the action layer
      // calls autoSendReceiptAfterCharge -- so it cannot know whether a receipt
      // was dispatched, let alone delivered. An earlier revision said "dispatched
      // it automatically"; a later one branched on a process-level owner. Both
      // asserted more than this point in the code can support.
      //
      // Email ownership is the durable `receipt_status: null -> sending` claim in
      // lib/billing/payment-receipt.ts. This invocation is eligible to ATTEMPT a
      // send because it holds a succeeded PaymentIntent for this attempt, and the
      // database decides whether it actually sends. So the alert reports the MONEY
      // verdict and says explicitly that the receipt outcome is recorded
      // elsewhere.
      logInternal("session_payment_succeeded_write_concurrent_reconciliation", {
        attemptId: args.attemptId,
      });
      await recordOpsAlert({
        severity: "warning",
        event: "session_payment_succeeded_write_concurrent_reconciliation",
        message:
          "The succeeded-outcome update affected zero rows because another legitimate writer " +
          "(normally the payment_intent.succeeded webhook) had already persisted the IDENTICAL " +
          "charge on this attempt. Verified by authoritative re-read: same attempt, PaymentIntent, " +
          "charge lineage, studio, client, livemode, amount, currency and charge reason. " +
          "The ledger is correct and NO money reconciliation is required. " +
          "Automatic receipt dispatch is attempted by the action layer and owned by the durable " +
          "receipt_status claim; this alert asserts no receipt outcome of any kind.",
        studioId: args.studioId,
        clientId: args.clientId,
        stripePaymentIntentId: args.pi.id,
        route: "lib/billing/session-payment-charge:writeSucceededOutcome",
        safeDetails: {
          attempt_id: args.attemptId,
          attempted_status: "succeeded",
          resolution: "concurrent_writer_already_persisted",
          receipt_outcome_recorded_elsewhere: true,
        },
      });
      return { persisted: true, by: "concurrent_writer" };
    }

    // NOT PROVABLY BENIGN — unchanged behaviour, and the reason is now named so
    // the operator is told WHICH fact failed rather than only that rows were zero.
    logInternal("session_payment_succeeded_write_zero_rows", {
      attemptId: args.attemptId,
      recheck: verdict.why,
    });
    await recordOpsAlert({
      severity: "critical",
      event: "session_payment_succeeded_write_zero_rows",
      message:
        "PaymentIntent succeeded but the succeeded-outcome update affected zero rows (the attempt was no longer 'pending_stripe'), and an authoritative re-read could NOT prove the row records this same charge. The ledger row may be unstamped, or stamped with a different charge, while the charge is real on Stripe. Manual reconciliation required.",
      studioId: args.studioId,
      clientId: args.clientId,
      stripePaymentIntentId: args.pi.id,
      route: "lib/billing/session-payment-charge:writeSucceededOutcome",
      safeDetails: {
        attempt_id: args.attemptId,
        attempted_status: "succeeded",
        recheck_failed: verdict.why,
        observed_status: verdict.observedStatus,
      },
    });
    // PR #281: a zero-row success write is NOT a normal success. The
    // caller must return needs_manual_review with the reconciliation ids.
    return { persisted: false, reason: "zero_rows" };
  }
  return { persisted: true, by: "this_invocation" };
}

async function writeFailedOutcome(args: {
  attemptId: string;
  studioId: string;
  clientId: string;
  paymentIntentId: string | null;
  stripeStatus: string | null;
  failureCode: string | null | undefined;
  failureMessage: string | null | undefined;
}): Promise<void> {
  const admin = createAdminClient();
  const { data: updatedRows, error } = await admin
    .from("payment_charge_attempts")
    .update({
      status: "failed",
      stripe_payment_intent_id: args.paymentIntentId,
      stripe_status: args.stripeStatus,
      failed_at: new Date().toISOString(),
      failure_code: sanitizeFailureCode(args.failureCode),
      failure_message_safe: sanitizeFailureMessage(args.failureMessage),
    })
    .eq("id", args.attemptId)
    .eq("status", "pending_stripe")
    .select("id");
  if (error) {
    // PR #310: a DB error on the FAILED-outcome write previously logged to
    // stderr only, leaving it invisible to ops_alerts / the manual-review
    // queue: weaker than the succeeded-outcome path (PR #281). No charge was
    // captured (Stripe did NOT succeed), but the reported outcome ('failed')
    // now diverges from a row that may stay 'pending_stripe'. Raise a CRITICAL
    // ops alert, symmetric with writeSucceededOutcome, so failure-persistence
    // failures are as observable as success-persistence failures. Alerting
    // only: the caller still returns 'failed' (no flow/money change).
    logInternal("session_payment_failed_write_failed", {
      code: error.code,
      message: error.message,
      attemptId: args.attemptId,
    });
    await recordOpsAlert({
      severity: "critical",
      event: "session_payment_failed_write_failed",
      message:
        "Stripe reported the payment as failed/non-success, but Hone could not persist the failed outcome on the attempt row (DB error). No charge was captured; the row may stay 'pending_stripe' until reconciled (webhook backstop or manual). Manual review required.",
      studioId: args.studioId,
      clientId: args.clientId,
      stripePaymentIntentId: args.paymentIntentId,
      route: "lib/billing/session-payment-charge:writeFailedOutcome",
      safeDetails: {
        attempt_id: args.attemptId,
        attempted_status: "failed",
        stripe_status: args.stripeStatus ?? null,
        db_code: error.code ?? null,
      },
    });
    return;
  }
  // PR #263: zero-row detection. A failed-outcome update that matches no
  // 'pending_stripe' row persisted nothing; the row may be stuck in
  // 'pending_stripe' (or was already moved by a concurrent writer) while
  // the caller reports 'failed'. Surface for manual review rather than
  // silently diverging the stored row from the reported outcome.
  if (!updatedRows || updatedRows.length === 0) {
    // PR #310: promoted from warning to CRITICAL so it surfaces in the
    // critical-only manual-review queue (via the existing 'session_payment_'
    // prefix), symmetric with the succeeded-outcome zero-row alert.
    logInternal("session_payment_failed_write_zero_rows", {
      attemptId: args.attemptId,
    });
    await recordOpsAlert({
      severity: "critical",
      event: "session_payment_failed_write_zero_rows",
      message:
        "A failed-outcome update affected zero rows (the attempt was no longer 'pending_stripe'). The attempt row may not reflect the reported failure. Manual review required.",
      studioId: args.studioId,
      clientId: args.clientId,
      stripePaymentIntentId: args.paymentIntentId,
      route: "lib/billing/session-payment-charge:writeFailedOutcome",
      safeDetails: {
        attempt_id: args.attemptId,
        attempted_status: "failed",
        stripe_status: args.stripeStatus ?? null,
      },
    });
  }
}

// PR #320: safely finalize a PaymentIntent that resolved to `requires_action`
// (off-session SCA). A `requires_action` PI is NOT terminal on Stripe: the
// cardholder could complete authentication out-of-band and the PI could later
// succeed. But webhook reconciliation only flips rows from ready/pending_stripe
// (payment-webhook-reconciliation.ts), so writing terminal 'failed' here would
// leave Hone permanently 'failed' while Stripe succeeded: a real-money
// divergence. So we CANCEL the PI first (voiding it so Stripe can never succeed
// it), then record terminal 'failed'. If the cancel FAILS, the Stripe outcome is
// unresolved: we do NOT claim terminal certainty: we leave the row
// pending_stripe (a valid reconciliation source) and route to manual review.
// The single paymentIntents.cancel call site in the codebase (pinned in
// scripts/check-stripe-gates.mjs). Runs only in test mode today (the live-mode
// early return gates all charging).
async function finalizeRequiresActionPaymentIntent(args: {
  stripe: Stripe;
  pi: Stripe.PaymentIntent;
  stripeAccountId: string;
  attemptId: string;
  studioId: string;
  clientId: string;
  sessionId: string | null;
  appointmentId: string | null;
  route: string;
}): Promise<SessionPaymentChargeResult> {
  try {
    const canceled = await args.stripe.paymentIntents.cancel(
      args.pi.id,
      undefined,
      { stripeAccount: args.stripeAccountId },
    );
    // PI is now 'canceled' on Stripe and can never succeed: terminal 'failed'
    // is now truthful and cannot diverge.
    await writeFailedOutcome({
      attemptId: args.attemptId,
      studioId: args.studioId,
      clientId: args.clientId,
      paymentIntentId: args.pi.id,
      stripeStatus: canceled.status,
      failureCode: "requires_action_canceled",
      failureMessage: AUTHENTICATION_REQUIRED_MESSAGE,
    });
    await recordOpsAlert({
      severity: "warning",
      event: "session_payment_requires_action_canceled",
      message:
        "Off-session PaymentIntent required authentication; canceled to keep Hone and Stripe consistent (terminal failed).",
      studioId: args.studioId,
      clientId: args.clientId,
      route: args.route,
      safeDetails: {
        attempt_id: args.attemptId,
        session_id: args.sessionId,
        appointment_id: args.appointmentId,
        stripe_payment_intent_id: args.pi.id,
        canceled_status: canceled.status,
      },
    });
    return {
      ok: false,
      outcome: "failed",
      message: AUTHENTICATION_REQUIRED_MESSAGE,
      failureCode: "requires_action_canceled",
    };
  } catch (cancelErr) {
    // Cancel FAILED: Stripe outcome is UNRESOLVED (the PI may still complete).
    // Do NOT write terminal 'failed'. Leave the row pending_stripe so a later
    // success can still reconcile, and route to manual review. Never silently
    // claim terminal certainty when the Stripe outcome is unknown.
    logInternal("session_payment_requires_action_cancel_failed", {
      attemptId: args.attemptId,
      paymentIntentId: args.pi.id,
      message: cancelErr instanceof Error ? cancelErr.message : String(cancelErr),
    });
    await recordOpsAlert({
      severity: "critical",
      event: "session_payment_requires_action_cancel_failed",
      message:
        "Off-session PaymentIntent required authentication and could NOT be canceled; Stripe outcome is unresolved. Row stays pending_stripe for manual review (do not assume failed).",
      studioId: args.studioId,
      clientId: args.clientId,
      route: args.route,
      safeDetails: {
        attempt_id: args.attemptId,
        session_id: args.sessionId,
        appointment_id: args.appointmentId,
        stripe_payment_intent_id: args.pi.id,
        reason: "cancel_failed",
      },
    });
    return {
      ok: false,
      outcome: "needs_manual_review",
      message: NEEDS_MANUAL_REVIEW_MESSAGE,
      stripePaymentIntentId: args.pi.id,
      attemptId: args.attemptId,
    };
  }
}

// Pending reconciliation branch. Stale pending_stripe rows with a
// known PaymentIntent id: read the PI back from Stripe to recover
// the true status without re-creating.
async function reconcileExistingPaymentIntent(args: {
  attemptId: string;
  studioId: string;
  clientId: string;
  sessionId: string;
  appointmentId: string | null;
  stripeAccountId: string;
  paymentIntentId: string;
  /** Compared against the row on a zero-row recheck. */
  expectedChargeReason: string | null;
}): Promise<SessionPaymentChargeResult> {
  const stripe = getSessionPaymentStripe();
  let pi: Stripe.PaymentIntent;
  try {
    pi = await stripe.paymentIntents.retrieve(
      args.paymentIntentId,
      undefined,
      { stripeAccount: args.stripeAccountId },
    );
  } catch (err) {
    logInternal("session_payment_reconcile_retrieve_failed", {
      attemptId: args.attemptId,
      paymentIntentId: args.paymentIntentId,
      message: err instanceof Error ? err.message : String(err),
    });
    await recordOpsAlert({
      severity: "critical",
      event: "session_payment_needs_manual_review",
      message:
        "Stripe PaymentIntent retrieve failed during reconciliation; row stays pending_stripe.",
      studioId: args.studioId,
      clientId: args.clientId,
      route: "lib/billing/session-payment-charge:reconcileExistingPaymentIntent",
      safeDetails: {
        attempt_id: args.attemptId,
        session_id: args.sessionId,
        appointment_id: args.appointmentId,
        stripe_payment_intent_id: args.paymentIntentId,
        reason: "retrieve_failed",
      },
    });
    return {
      ok: false,
      outcome: "needs_manual_review",
      message: NEEDS_MANUAL_REVIEW_MESSAGE,
    };
  }
  if (pi.status === "succeeded") {
    const persistence = await writeSucceededOutcome({
      attemptId: args.attemptId,
      studioId: args.studioId,
      clientId: args.clientId,
      pi,
      expectedChargeReason: args.expectedChargeReason,
    });
    if (!persistence.persisted) {
      // PR #281: Stripe says succeeded but Hone could not persist it
      // (DB error or zero-row update). writeSucceededOutcome already
      // raised the critical ops alert. Never report a clean success.
      return {
        ok: false,
        outcome: "needs_manual_review",
        message: SUCCESS_NOT_PERSISTED_MESSAGE,
        stripePaymentIntentId: pi.id,
        attemptId: args.attemptId,
      };
    }
    const latestCharge =
      typeof pi.latest_charge === "string"
        ? pi.latest_charge
        : (pi.latest_charge?.id ?? null);
    return {
      ok: true,
      outcome: "succeeded",
      stripePaymentIntentId: pi.id,
      stripeChargeId: latestCharge,
      // Three independent facts: the WRITE, who else wrote it, and WHOSE CHARGE
      // it is. The last is threaded from the claim, never re-derived here.
      committedNow: persistence.by === "this_invocation",
      concurrentlyReconciled: persistence.by === "concurrent_writer",
    };
  }
  // PR #320: requires_action is not terminal on Stripe: cancel before failing.
  if (pi.status === "requires_action") {
    return finalizeRequiresActionPaymentIntent({
      stripe,
      pi,
      stripeAccountId: args.stripeAccountId,
      attemptId: args.attemptId,
      studioId: args.studioId,
      clientId: args.clientId,
      sessionId: args.sessionId,
      appointmentId: args.appointmentId,
      route: "lib/billing/session-payment-charge:reconcileExistingPaymentIntent",
    });
  }
  await writeFailedOutcome({
    attemptId: args.attemptId,
    studioId: args.studioId,
    clientId: args.clientId,
    paymentIntentId: pi.id,
    stripeStatus: pi.status,
    failureCode: pi.last_payment_error?.code ?? pi.status,
    failureMessage:
      pi.last_payment_error?.message ?? `PaymentIntent status: ${pi.status}`,
  });
  await recordOpsAlert({
    severity: "warning",
    event: "session_payment_charge_failed",
    message: `Reconciled PaymentIntent status: ${pi.status}`,
    studioId: args.studioId,
    clientId: args.clientId,
    route: "lib/billing/session-payment-charge:reconcileExistingPaymentIntent",
    safeDetails: {
      attempt_id: args.attemptId,
      session_id: args.sessionId,
      appointment_id: args.appointmentId,
      stripe_payment_intent_id: pi.id,
      stripe_status: pi.status,
      failure_code: pi.last_payment_error?.code ?? pi.status,
    },
  });
  return {
    ok: false,
    outcome: "failed",
    // requires_action is handled by finalizeRequiresActionPaymentIntent above.
    message:
      pi.last_payment_error?.message ?? "PaymentIntent did not succeed.",
    failureCode: pi.last_payment_error?.code ?? pi.status,
  };
}

// Entry point. Caller MUST already have resolved practitioner +
// studio from the session.
export async function runSessionPaymentCharge(args: {
  attemptId: string;
  studioId: string;
  practitionerId: string;
}): Promise<SessionPaymentChargeResult> {
  // PR #323: the hard `inferStripeLivemode() === true` dormancy early-return was
  // removed to make the executor live-CAPABLE. Live charging stays gated by the
  // env/key layer: getStripe() (assertStripeKeyAllowed) throws on an sk_live_
  // key unless STRIPE_ALLOW_LIVE_MODE === "true", so with the current test key
  // this path is unreached in live and every row below stays test-mode.
  const livemode = inferStripeLivemode();

  const admin = createAdminClient();

  // 2. Load the attempt row scoped by studio_id. The row carries
  //    everything we need to validate lineage + call Stripe.
  const { data: attemptRow } = await admin
    .from("payment_charge_attempts")
    .select(
      "id, studio_id, charge_reason, client_id, session_id, appointment_id, amount_cents, currency, status, stripe_livemode, client_payment_method_id, card_authorization_signature_id, stripe_account_id, stripe_customer_id, stripe_payment_method_id, stripe_payment_intent_id, stripe_idempotency_key, updated_at",
    )
    .eq("id", args.attemptId)
    .eq("studio_id", args.studioId)
    .maybeSingle();
  if (!attemptRow) {
    return {
      ok: false,
      outcome: "not_found",
      message: "Session payment attempt not found.",
    };
  }
  // Reason guard (PR #196 unification): the three canonical charge
  // reasons execute through this one audited path. Anything else
  // refuses.
  if (
    attemptRow.charge_reason !== "session_payment" &&
    attemptRow.charge_reason !== "no_show_fee" &&
    attemptRow.charge_reason !== "late_cancellation_fee"
  ) {
    return {
      ok: false,
      outcome: "blocked",
      message: "This attempt has an unsupported charge reason.",
    };
  }
  // Row-level mode-consistency guard: the attempt row's mode must match the
  // deployment mode (test env → must be false; live env → must be true).
  if (attemptRow.stripe_livemode !== livemode) {
    return {
      ok: false,
      outcome: "live_mode_blocked",
      message: LIVE_MODE_BLOCKED_MESSAGE,
    };
  }

  // Already-succeeded short-circuit. Repeat clicks on a succeeded
  // row are a no-op.
  if (attemptRow.status === "succeeded") {
    return {
      ok: true,
      outcome: "succeeded",
      stripePaymentIntentId: attemptRow.stripe_payment_intent_id ?? "",
      stripeChargeId: null,
      // Already succeeded BEFORE this call: a replay, not a new charge.
      committedNow: false,
    };
  }
  // Refuse retry of terminal-non-success states.
  if (
    attemptRow.status === "failed" ||
    attemptRow.status === "cancelled" ||
    attemptRow.status === "blocked"
  ) {
    return {
      ok: false,
      outcome: "blocked",
      message: "This session payment cannot be retried.",
    };
  }

  // 3. PR #170 + PR #177 current-card-authorization recheck. The
  //    signature stamped at prepare time may have been the current
  //    version then but the template could have been re-edited
  //    (version bumped) between prepare and execute, OR the active
  //    card row's pointer could have drifted in that window (a
  //    card replacement / restore path). The charge-ready helper
  //    is stricter than the base PR #170 helper: it ALSO verifies
  //    that the active card row's card_authorization_signature_id
  //    equals the current signed_current signature. The execute
  //    invariant is the AND of all three:
  //
  //      cardAuth.signatureId == active_card.card_authorization_signature_id
  //      cardAuth.signatureId == attemptRow.card_authorization_signature_id
  //      active_card.card_authorization_signature_id == attemptRow.card_authorization_signature_id
  //
  //    The first equality is enforced by the charge-ready helper.
  //    The second is enforced here. The third is enforced by
  //    loadCardAndVerifyLineage below (step 4).
  const cardAuth = await getChargeReadyCardAuthorizationStatus({
    studioId: attemptRow.studio_id,
    clientId: attemptRow.client_id,
  });
  // PAY-READ-01 PR B. Authority is UNKNOWN because a read failed. The
  // catch-all below would already refuse (its condition is
  // `!== "signed_current"`), so this branch is not what makes execute fail
  // closed - it is what stops the refusal LYING. The catch-all message says
  // "Card authorization is no longer current. Ask the client to re-sign",
  // which on a database timeout is false twice over: nothing is known to be
  // out of date, and sending the client to re-sign is a repair for a problem
  // they do not have.
  //
  // The outcome code stays `authorization_not_current` deliberately. It is an
  // internal classification meaning "not permitted to charge", already mapped
  // to "blocked" by the manual-fee caller, which surfaces this message
  // verbatim. Minting a new outcome would ripple into that consumer and its
  // pinned tests for no safety gain.
  if (cardAuth.kind === "authorization_unverified") {
    return {
      ok: false,
      outcome: "authorization_not_current",
      message:
        "Card authorization could not be verified. Refresh and try again.",
    };
  }
  if (cardAuth.kind === "signed_current_but_card_pointer_stale") {
    return {
      ok: false,
      outcome: "authorization_not_current",
      message:
        "Client must re-sign the current card authorization for the card on file.",
    };
  }
  if (cardAuth.kind !== "signed_current") {
    return {
      ok: false,
      outcome: "authorization_not_current",
      message:
        "Card authorization is no longer current. Ask the client to re-sign the updated card authorization before charging this session.",
    };
  }
  if (cardAuth.signatureId !== attemptRow.card_authorization_signature_id) {
    return {
      ok: false,
      outcome: "authorization_not_current",
      message:
        "Card authorization signature has changed since the session payment was prepared. Prepare a new attempt against the current signature.",
    };
  }

  // 4. Lineage recheck. The card row + studio settings + customer
  //    mapping must all still resolve consistently with the values
  //    stamped on the attempt.
  if (
    !attemptRow.client_payment_method_id ||
    !attemptRow.card_authorization_signature_id ||
    !attemptRow.stripe_account_id ||
    !attemptRow.stripe_customer_id ||
    !attemptRow.stripe_payment_method_id
  ) {
    return {
      ok: false,
      outcome: "blocked",
      message: "Session payment attempt is missing required card lineage.",
    };
  }
  const lineage = await loadCardAndVerifyLineage({
    studioId: attemptRow.studio_id,
    clientId: attemptRow.client_id,
    clientPaymentMethodId: attemptRow.client_payment_method_id,
    expectedSignatureId: attemptRow.card_authorization_signature_id,
    expectedStripeAccountId: attemptRow.stripe_account_id,
    expectedStripeCustomerId: attemptRow.stripe_customer_id,
    expectedStripePaymentMethodId: attemptRow.stripe_payment_method_id,
  });
  if (!lineage.ok) {
    return {
      ok: false,
      outcome: "lineage_mismatch",
      message: GENERIC_LINEAGE_MISMATCH_MESSAGE,
      blockingReasons: lineage.reasons,
    };
  }
  const card = lineage.card;

  // 5. Atomically claim the attempt. Idempotency key is deterministic
  //    so a retry produces the same key.
  const idempotencyKey = buildIdempotencyKey(attemptRow.id, attemptRow.charge_reason ?? "session_payment");
  const { data: claimRows, error: claimErr } = await admin.rpc(
    "claim_session_payment_charge_attempt",
    {
      p_attempt_id: attemptRow.id,
      p_practitioner_id: args.practitionerId,
      p_idempotency_key: idempotencyKey,
    },
  );
  if (claimErr) {
    logInternal("session_payment_claim_rpc_failed", {
      code: claimErr.code,
      message: claimErr.message,
      attemptId: attemptRow.id,
    });
    return {
      ok: false,
      outcome: "failed",
      message: livemode
        ? "We could not start the charge. Please try again."
        : "We could not start the test charge. Please try again.",
    };
  }
  const claim = (Array.isArray(claimRows) ? claimRows[0] : claimRows) as
    | ClaimRow
    | null;
  if (!claim) {
    return {
      ok: false,
      outcome: "failed",
      message: livemode
        ? "We could not start the charge. Please try again."
        : "We could not start the test charge. Please try again.",
    };
  }

  if (claim.result === "already_succeeded") {
    return {
      ok: true,
      outcome: "succeeded",
      stripePaymentIntentId: claim.stripe_payment_intent_id ?? "",
      stripeChargeId: null,
      // The claim RPC found it already succeeded: a replay, not a charge.
      committedNow: false,
    };
  }
  // PAY-SETTLE / 0187. TERMINAL, AND BEFORE ANY STRIPE CALL.
  //
  // THE DEFECT THIS CLOSES. The branches around it recognise a fixed set of
  // claim results and everything else FALLS THROUGH to the create-and-confirm
  // call in step 6b below. 0187 taught the claim command to refuse
  // a visit already recorded as paid in cash / by e-transfer / another way /
  // waived — and the database does refuse: it takes the shared appointment
  // advisory key, returns `settled_externally`, and leaves the attempt in
  // `ready`. But an unrecognised result reached Stripe anyway, so the client's
  // card was charged for a visit the studio had already been paid for, and the
  // success write then matched zero rows (the attempt was never moved to
  // pending_stripe) and reported manual review. That is precisely the
  // double-collection this release exists to prevent, arriving through the one
  // layer above the guarantee.
  //
  // Handled as `blocked` rather than as a new outcome member deliberately:
  // `blocked` already means "not in a chargeable state", it is accepted by
  // every existing consumer union (the manual-fee action narrows the union and
  // would have to be widened for a new member), and a new member is exactly the
  // kind of thing that falls through a narrower switch somewhere else. The
  // specificity belongs in the message, which is what the practitioner reads.
  //
  // NOTHING IS WRITTEN HERE. No Stripe call, no status transition, no receipt,
  // no success/failure/manual-review record. The attempt stays exactly as the
  // database left it, so the owner can correct the settlement and charge, or
  // cancel the attempt, with no residue either way.
  if (claim.result === "settled_externally") {
    return {
      ok: false,
      outcome: "blocked",
      message: SETTLED_EXTERNALLY_MESSAGE,
    };
  }

  if (
    claim.result === "not_found" ||
    claim.result === "not_authorized" ||
    claim.result === "not_ready"
  ) {
    return {
      ok: false,
      outcome:
        claim.result === "not_authorized" ? "not_authorized" : "blocked",
      message:
        claim.result === "not_authorized"
          ? "You don't have permission to charge this session payment."
          : "This session payment is not in a chargeable state.",
    };
  }

  // 6a. Pending reconciliation: row is already pending_stripe.
  if (claim.result === "already_pending") {
    if (claim.stripe_payment_intent_id) {
      return reconcileExistingPaymentIntent({
        attemptId: attemptRow.id,
        studioId: attemptRow.studio_id,
        clientId: attemptRow.client_id,
        sessionId: attemptRow.session_id,
        appointmentId: attemptRow.appointment_id,
        stripeAccountId: card.stripe_account_id,
        paymentIntentId: claim.stripe_payment_intent_id,
        expectedChargeReason: attemptRow.charge_reason ?? null,
      });
    }
    // No PI id on the row. Check whether the claim is recent enough
    // to retry-create with the same idempotency key.
    const claimedAt = claim.updated_at
      ? new Date(claim.updated_at).getTime()
      : 0;
    const ageMin = (Date.now() - claimedAt) / 60000;
    if (
      claimedAt > 0 &&
      Number.isFinite(ageMin) &&
      ageMin <= RECONCILIATION_WINDOW_MINUTES
    ) {
      // Fall through to the create-and-confirm path with the same
      // deterministic key.
    } else {
      await recordOpsAlert({
        severity: "critical",
        event: "session_payment_needs_manual_review",
        message:
          "Pending claim is older than the reconciliation window and has no PaymentIntent id.",
        studioId: attemptRow.studio_id,
        clientId: attemptRow.client_id,
        route: "lib/billing/session-payment-charge:runSessionPaymentCharge",
        safeDetails: {
          attempt_id: attemptRow.id,
          session_id: attemptRow.session_id,
          appointment_id: attemptRow.appointment_id,
          reason: "stale_pending_no_pi",
          age_minutes_floor: Math.floor(ageMin),
        },
      });
      return {
        ok: false,
        outcome: "needs_manual_review",
        message: NEEDS_MANUAL_REVIEW_MESSAGE,
      };
    }
  }

  // 6b. Create + confirm the PaymentIntent. Off-session because the
  //     practitioner is taking the action, not the cardholder. The
  //     metadata block carries every Hone identity column the future
  //     webhook handler or a manual reconciler needs to bind a
  //     leaked-back PaymentIntent to this attempt.
  const stripe = getSessionPaymentStripe();
  let pi: Stripe.PaymentIntent;
  try {
    pi = await stripe.paymentIntents.create(
      {
        amount: attemptRow.amount_cents,
        currency: attemptRow.currency,
        customer: card.stripe_customer_id,
        payment_method: card.stripe_payment_method_id,
        confirm: true,
        off_session: true,
        // PR #320: accurate per-reason description (no "…for session null" on fees).
        description: buildChargeDescription(attemptRow),
        metadata: {
          hone_studio_id: attemptRow.studio_id,
          hone_client_id: attemptRow.client_id,
          hone_session_id: attemptRow.session_id,
          hone_appointment_id: attemptRow.appointment_id ?? "",
          hone_session_payment_charge_attempt_id: attemptRow.id,
          hone_charge_reason: attemptRow.charge_reason,
          hone_card_authorization_signature_id:
            attemptRow.card_authorization_signature_id,
          hone_environment: livemode ? "live" : "test",
        },
      },
      {
        stripeAccount: card.stripe_account_id,
        idempotencyKey,
      },
    );
  } catch (err) {
    if (err instanceof Stripe.errors.StripeError) {
      const decline = err as unknown as {
        code?: string;
        type?: string;
        message?: string;
        payment_intent?: { id?: string; status?: string };
      };
      const paymentIntent = decline.payment_intent;
      const piId = paymentIntent?.id ?? null;
      const piStatus = paymentIntent?.status ?? null;
      await writeFailedOutcome({
        attemptId: attemptRow.id,
        studioId: attemptRow.studio_id,
        clientId: attemptRow.client_id,
        paymentIntentId: piId,
        stripeStatus: piStatus,
        failureCode: err.code ?? piStatus,
        failureMessage: err.message,
      });
      logInternal("session_payment_stripe_error", {
        attemptId: attemptRow.id,
        type: err.type,
        code: err.code,
      });
      await recordOpsAlert({
        severity:
          err.code === "authentication_required" ? "critical" : "warning",
        event: "session_payment_charge_failed",
        message: err.message || "Stripe error during PaymentIntent create.",
        studioId: attemptRow.studio_id,
        clientId: attemptRow.client_id,
        route: "lib/billing/session-payment-charge:runSessionPaymentCharge",
        safeDetails: {
          attempt_id: attemptRow.id,
          session_id: attemptRow.session_id,
          appointment_id: attemptRow.appointment_id,
          stripe_payment_intent_id: piId,
          failure_code: err.code ?? null,
          stripe_status: piStatus,
          stripe_error_type: err.type,
        },
      });
      return {
        ok: false,
        outcome: "failed",
        message:
          err.code === "authentication_required"
            ? AUTHENTICATION_REQUIRED_MESSAGE
            : (err.message || "Stripe could not charge the saved card."),
        failureCode: err.code ?? null,
      };
    }
    // Unknown error AFTER claim: leave row pending_stripe and force
    // manual reconciliation. Same logic as manual fee: a transient
    // network error after Stripe accepted the request could have
    // already moved money.
    logInternal("session_payment_stripe_unknown_error", {
      attemptId: attemptRow.id,
      message: err instanceof Error ? err.message : String(err),
    });
    await recordOpsAlert({
      severity: "critical",
      event: "session_payment_needs_manual_review",
      message:
        "Unknown error after claim; row stays pending_stripe. Reconcile via Stripe dashboard.",
      studioId: attemptRow.studio_id,
      clientId: attemptRow.client_id,
      route: "lib/billing/session-payment-charge:runSessionPaymentCharge",
      safeDetails: {
        attempt_id: attemptRow.id,
        session_id: attemptRow.session_id,
        appointment_id: attemptRow.appointment_id,
        reason: "unknown_error_after_claim",
      },
    });
    return {
      ok: false,
      outcome: "needs_manual_review",
      message: NEEDS_MANUAL_REVIEW_MESSAGE,
    };
  }

  // 7. Stripe accepted the create+confirm. The PI either succeeded
  //    or sits in requires_action / requires_payment_method.
  if (pi.status === "succeeded") {
    // PR #281: success is authoritative ONLY if Hone also persisted the
    // succeeded outcome on the ledger row. If persistence failed (DB
    // error or zero-row update), writeSucceededOutcome already raised the
    // critical ops alert; return needs_manual_review with the
    // reconciliation ids instead of a clean success. No retry is issued
    // (the deterministic idempotency key + Stripe 24h replay already
    // guard against a double charge), so this cannot move money twice.
    const persistence = await writeSucceededOutcome({
      attemptId: attemptRow.id,
      studioId: attemptRow.studio_id,
      clientId: attemptRow.client_id,
      pi,
      expectedChargeReason: attemptRow.charge_reason ?? null,
      // OWNERSHIP IS THE DATABASE TRANSITION, NOT THE STRIPE CALL.
      //
      // This was hardcoded `true` and that was wrong. The `already_pending`
      // branch above DELIBERATELY lets several requests fall through to the
      // create-and-confirm call below with the same deterministic idempotency
      // key, so Stripe returns the SAME succeeded PaymentIntent to all of them.
      // Every one of them reaches this line having "created" the charge, so every
      // loser would have become `concurrentlyReconciled` and called the automatic
      // sender.
      //
      // (The provider method is deliberately not named in prose here: the repo's
      // Stripe call-site inventory guards count that literal to pin exactly one
      // create site, and they count source text rather than parsed calls.)
      //
      // The database receipt claim only SERIALIZES those senders, it does not
      // reduce them to one: `payment-receipt.ts` resets `receipt_status` back to
      // null on a retryable failure, so a second sender could then deliver a
      // duplicate receipt to a client. That is precisely the hole
      // `auto-payment-receipt.ts`'s header warned about when it said gate 2 must
      // not lean on the claim as the ONLY defence.
      //
      // Only ONE invocation can win `ready -> pending_stripe`, so only that one
      // may own the receipt. An `already_pending` fallthrough is an idempotent
      // replay of somebody else's charge, whatever Stripe hands it back.
    });
    if (!persistence.persisted) {
      return {
        ok: false,
        outcome: "needs_manual_review",
        message: SUCCESS_NOT_PERSISTED_MESSAGE,
        stripePaymentIntentId: pi.id,
        attemptId: attemptRow.id,
      };
    }
    const latestCharge =
      typeof pi.latest_charge === "string"
        ? pi.latest_charge
        : (pi.latest_charge?.id ?? null);
    return {
      ok: true,
      outcome: "succeeded",
      stripePaymentIntentId: pi.id,
      stripeChargeId: latestCharge,
      // THREE INDEPENDENT FACTS, and keeping them independent is the point of
      // this revision. `committedNow` = did I write the row.
      // `concurrentlyReconciled` = did a verified concurrent writer write the
      // identical charge. `receiptOwnedHere` = did I win the claim. Receipt
      // eligibility is their conjunction, decided in auto-payment-receipt.ts;
      // no branch here may substitute one for another.
      committedNow: persistence.by === "this_invocation",
      concurrentlyReconciled: persistence.by === "concurrent_writer",
    };
  }

  // PR #320: requires_action (off-session SCA) is NOT terminal on Stripe,
  // cancel the PI before recording failure so a later out-of-band authentication
  // success cannot leave Hone 'failed' while Stripe succeeded.
  if (pi.status === "requires_action") {
    return finalizeRequiresActionPaymentIntent({
      stripe,
      pi,
      stripeAccountId: card.stripe_account_id,
      attemptId: attemptRow.id,
      studioId: attemptRow.studio_id,
      clientId: attemptRow.client_id,
      sessionId: attemptRow.session_id,
      appointmentId: attemptRow.appointment_id,
      route: "lib/billing/session-payment-charge:runSessionPaymentCharge",
    });
  }

  // Other non-success status (e.g. requires_payment_method), genuinely terminal
  // for an off-session charge (Stripe will not auto-succeed it), so record failed.
  await writeFailedOutcome({
    attemptId: attemptRow.id,
    studioId: attemptRow.studio_id,
    clientId: attemptRow.client_id,
    paymentIntentId: pi.id,
    stripeStatus: pi.status,
    failureCode: pi.last_payment_error?.code ?? pi.status,
    failureMessage:
      pi.last_payment_error?.message ??
      `PaymentIntent status: ${pi.status}`,
  });
  await recordOpsAlert({
    // requires_action is handled + alerted in finalizeRequiresActionPaymentIntent
    // above, so this path is always a plain (warning-level) charge failure.
    severity: "warning",
    event: "session_payment_charge_failed",
    message: `PaymentIntent status post-create: ${pi.status}`,
    studioId: attemptRow.studio_id,
    clientId: attemptRow.client_id,
    route: "lib/billing/session-payment-charge:runSessionPaymentCharge",
    safeDetails: {
      attempt_id: attemptRow.id,
      session_id: attemptRow.session_id,
      appointment_id: attemptRow.appointment_id,
      stripe_payment_intent_id: pi.id,
      stripe_status: pi.status,
      failure_code: pi.last_payment_error?.code ?? pi.status,
    },
  });
  return {
    ok: false,
    outcome: "failed",
    message:
      pi.last_payment_error?.message ??
      "Stripe could not charge the saved card.",
    failureCode: pi.last_payment_error?.code ?? pi.status,
  };
}
