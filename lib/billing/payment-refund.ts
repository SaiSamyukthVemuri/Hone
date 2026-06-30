import "server-only";
import Stripe from "stripe";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { getStripe, inferStripeLivemode } from "@/lib/stripe/server";
import { recordOpsAlert } from "@/lib/ops/alerts";

// ---------------------------------------------------------------------------
// PR #178. refundPaymentChargeAttempt.
// ---------------------------------------------------------------------------
//
// Test-mode-only manual refund helper for a succeeded
// payment_charge_attempts row. Reason-agnostic by construction:
// today only `session_payment` rows reach status='succeeded' in
// production, but the same helper will refund a future
// `late_cancellation_fee` or `no_show_fee` row without code
// change. The discriminator the helper reads is the row's
// charge_reason (recorded as metadata on the Stripe refund).
//
// What this helper DOES
// ---------------------
//   1. Refuses to run in live mode (inferStripeLivemode() === true
//      short-circuits with outcome 'live_mode_blocked'; the
//      payment_charge_attempts_livemode_false_check on the row +
//      the Stripe key gate are the braces).
//   2. Loads the attempt row. Verifies studio scope (the action
//      layer is responsible for resolving studio_id from the
//      authenticated practitioner; this helper additionally re-
//      checks that the row belongs to that studio).
//   3. Validates eligibility:
//      * status = 'succeeded'
//      * stripe_livemode = false (defence in depth)
//      * stripe_charge_id is not null
//      * stripe_payment_intent_id is not null (PaymentIntent
//        flow; refund must reference the Charge id directly)
//      * charged_at is not null
//      * refund_status is null OR refund_status = 'failed'
//        (failed refunds may be retried; succeeded refunds and
//        in-flight refunds are refused)
//      * amount_cents > 0
//   4. Atomically claims the refund slot via a conditional UPDATE
//      matching the eligibility predicates. Sets refund_status =
//      'pending_stripe', refund_idempotency_key (deterministic),
//      refund_amount_cents (v1: equals amount_cents), refund_
//      initiated_by_practitioner_id, refund_internal_note,
//      refunded_at = null (cleared in case of a prior failed
//      attempt), stripe_refund_id = null, refund_failure_code =
//      null, refund_failure_message_safe = null. The claim is the
//      only place that goes null/failed -> pending_stripe.
//   5. Calls the Stripe refunds SDK (refund creation) with
//      {charge, amount, metadata} + {stripeAccount, idempotencyKey}.
//      The call site is below; this docblock deliberately does NOT
//      repeat the SDK access verbatim because the gate script
//      counts substring occurrences and PR #178's allowlist is
//      exactly one. The connected-account
//      context is the studio's stripe_account_id. The
//      deterministic idempotency key is hone:payment_refund:
//      <attemptId>:v1 so a network-retry produces the same key
//      and Stripe's 24-hour replay catches the duplicate. No
//      application_fee_amount. No transfer reversal (Connect
//      'direct charge' mode does not require reverse_transfer for
//      the studio-as-MoR posture).
//   6. Writes the outcome onto the same row:
//        success -> refund_status='succeeded', stripe_refund_id,
//                    refunded_at = now()
//        failure (terminal Stripe error) -> refund_status='failed',
//                    refund_failure_code, refund_failure_message_safe
//        unknown (network error / no response after claim) ->
//                    leaves refund_status='pending_stripe'; records
//                    a critical ops_alert with the deterministic
//                    idempotency key so a future reconciliation can
//                    safely re-query Stripe for that key.
//
// What this helper DOES NOT do
// ----------------------------
//   * No new PaymentIntent / SetupIntent / Charge create call.
//   * No live mode. The function refuses immediately.
//   * No automatic refund triggered by anything other than a
//     practitioner click via the action layer.
//   * No webhook reconciliation. The row's refund_status reflects
//     the helper's own outcome, not a webhook-driven flip.
//     A future PR may add charge.refunded handling; today the
//     refund row's status is the source of truth.
//   * No partial refund. v1 sets refund_amount_cents = amount_cents
//     always. The CHECK refund_amount_cents <= amount_cents leaves
//     room for a later partial-refund PR to write a smaller
//     value without migration.
//   * No multiple refunds per attempt. The partial unique on
//     stripe_refund_id (migration 0078) enforces 1 per attempt.
//   * No client portal refund UI. Refunds are practitioner-only.
//   * No SMS, no email refund receipt. (A future PR may add a
//     reason-agnostic refund receipt mirroring PR #175.)
//   * No DML against manual_fee_charge_attempts.
//   * No RLS relaxation.

const FAILURE_MESSAGE_MAX = 1000;
const FAILURE_CODE_MAX = 100;
const LIVE_MODE_BLOCKED_MESSAGE =
  "Live refunds are not enabled for this test-mode release.";
const ROUTE = "lib/billing/payment-refund:refundPaymentChargeAttempt";

function buildRefundIdempotencyKey(attemptId: string): string {
  return `hone:payment_refund:${attemptId}:v1`;
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
  return raw.replace(/\s+/g, " ").trim().slice(0, FAILURE_MESSAGE_MAX);
}

function sanitizeInternalNote(
  raw: string | null | undefined,
): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  // Migration 0078 caps this at 500.
  return trimmed.replace(/\s+/g, " ").slice(0, 500);
}

export type PaymentRefundResult =
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
      message: string;
      failureCode?: string | null;
    };

type AttemptRow = {
  id: string;
  studio_id: string;
  client_id: string;
  charge_reason: string;
  status: string;
  stripe_livemode: boolean;
  stripe_account_id: string | null;
  stripe_payment_intent_id: string | null;
  stripe_charge_id: string | null;
  amount_cents: number;
  charged_at: string | null;
  refund_status: string | null;
  refund_amount_cents: number | null;
  refunded_at: string | null;
  stripe_refund_id: string | null;
};

export async function refundPaymentChargeAttempt(args: {
  attemptId: string;
  studioId: string;
  practitionerId: string;
  internalNote?: string | null;
}): Promise<PaymentRefundResult> {
  // ============================================================
  // 1. Live-mode dormancy guard.
  // ============================================================
  if (inferStripeLivemode()) {
    return {
      ok: false,
      outcome: "live_mode_blocked",
      message: LIVE_MODE_BLOCKED_MESSAGE,
    };
  }

  const admin = createAdminClient();

  // ============================================================
  // 2. Load the attempt. The action layer has already resolved
  //    studioId from the practitioner; we re-check scope here so
  //    a stale URL or a malicious attemptId from another studio
  //    cannot pass the gate.
  // ============================================================
  const { data: rawRow, error: loadErr } = await admin
    .from("payment_charge_attempts")
    .select(
      "id, studio_id, client_id, charge_reason, status, stripe_livemode, stripe_account_id, stripe_payment_intent_id, stripe_charge_id, amount_cents, charged_at, refund_status, refund_amount_cents, refunded_at, stripe_refund_id",
    )
    .eq("id", args.attemptId)
    .maybeSingle();
  if (loadErr) {
    logInternal("payment_refund_load_failed", {
      attemptId: args.attemptId,
      code: loadErr.code,
      message: loadErr.message,
    });
    return {
      ok: false,
      outcome: "database_error",
      message: "We could not load this charge to refund it. Please try again.",
    };
  }
  const attempt = rawRow as AttemptRow | null;
  if (!attempt) {
    return {
      ok: false,
      outcome: "not_found",
      message: "Charge not found.",
    };
  }
  if (attempt.studio_id !== args.studioId) {
    return {
      ok: false,
      outcome: "not_authorized",
      message: "Charge does not belong to this studio.",
    };
  }

  // ============================================================
  // 2b. Owner-only re-check — defense in depth (PR #296). Refund
  //     INITIATION is owner-only and is already gated in BOTH action
  //     callers (refundPaymentChargeAttemptAction, refundFeeAttemptAction).
  //     Re-verify it HERE so a FUTURE caller that reaches this helper
  //     without the action-layer gate still cannot move money out as a
  //     non-owner. The actor is scoped to the same studio as the resolved
  //     studioId; this runs BEFORE the claim UPDATE and the Stripe refund.
  //     Reads only the existing practitioners.role column — no schema change.
  // ============================================================
  const { data: actorRow, error: actorErr } = await admin
    .from("practitioners")
    .select("role")
    .eq("id", args.practitionerId)
    .eq("studio_id", args.studioId)
    .eq("active", true)
    .maybeSingle();
  if (actorErr || !actorRow || actorRow.role !== "owner") {
    // Safe IDs + event name only — no client name/email/phone, no health/
    // treatment data, no Stripe secret or raw payload.
    logInternal("payment_refund_helper_not_owner", {
      attemptId: args.attemptId,
      studioId: args.studioId,
      practitionerId: args.practitionerId,
      actorLoadError: actorErr ? actorErr.code : null,
    });
    return {
      ok: false,
      outcome: "not_authorized",
      message: "Only the studio owner can issue a refund.",
    };
  }

  // ============================================================
  // 3. Eligibility predicates. Each branch returns a distinct
  //    outcome so the action layer + UI can render the precise
  //    reason. Test-mode invariants enforced even though the
  //    DB CHECK already guarantees stripe_livemode=false.
  // ============================================================
  if (attempt.status !== "succeeded") {
    return {
      ok: false,
      outcome: "not_succeeded",
      message: "Only a succeeded test charge can be refunded.",
    };
  }
  if (attempt.stripe_livemode !== false) {
    return {
      ok: false,
      outcome: "live_mode_blocked",
      message: LIVE_MODE_BLOCKED_MESSAGE,
    };
  }
  if (!attempt.stripe_charge_id) {
    return {
      ok: false,
      outcome: "missing_charge_id",
      message: "This charge has no Stripe charge id and cannot be refunded.",
    };
  }
  if (!attempt.stripe_payment_intent_id) {
    return {
      ok: false,
      outcome: "missing_payment_intent_id",
      message: "This charge has no Stripe payment intent id.",
    };
  }
  if (!attempt.charged_at) {
    return {
      ok: false,
      outcome: "missing_charged_at",
      message: "This charge has no charged-at timestamp.",
    };
  }
  if (!attempt.amount_cents || attempt.amount_cents <= 0) {
    return {
      ok: false,
      outcome: "amount_invalid",
      message: "Charge amount is not eligible for refund.",
    };
  }
  if (attempt.refund_status === "succeeded") {
    return {
      ok: false,
      outcome: "already_refunded",
      message: "This charge has already been refunded.",
    };
  }
  if (attempt.refund_status === "pending_stripe") {
    return {
      ok: false,
      outcome: "refund_in_flight",
      message:
        "A refund is already in flight for this charge. Wait a moment and refresh.",
    };
  }
  if (!attempt.stripe_account_id) {
    return {
      ok: false,
      outcome: "database_error",
      message: "Charge has no connected Stripe account.",
    };
  }

  // ============================================================
  // 4. Atomic claim. Conditional UPDATE matching the same
  //    predicates a second click would also pass; only one row
  //    will be returned. Loser of the race sees claim_lost and
  //    the UI re-reads to surface the in-flight / succeeded
  //    state. The claim establishes the row's
  //    refund_idempotency_key BEFORE any Stripe call so a
  //    network-retry can use the same key.
  // ============================================================
  const idempotencyKey = buildRefundIdempotencyKey(attempt.id);
  const refundAmountCents = attempt.amount_cents;
  const { data: claimedRows, error: claimErr } = await admin
    .from("payment_charge_attempts")
    .update({
      refund_status: "pending_stripe",
      refund_idempotency_key: idempotencyKey,
      refund_amount_cents: refundAmountCents,
      refund_initiated_by_practitioner_id: args.practitionerId,
      refund_internal_note: sanitizeInternalNote(args.internalNote),
      stripe_refund_id: null,
      refund_failure_code: null,
      refund_failure_message_safe: null,
      refunded_at: null,
    })
    .eq("id", attempt.id)
    .eq("studio_id", args.studioId)
    .eq("status", "succeeded")
    .eq("stripe_livemode", false)
    .or("refund_status.is.null,refund_status.eq.failed")
    .select("id");
  if (claimErr) {
    logInternal("payment_refund_claim_failed", {
      attemptId: attempt.id,
      code: claimErr.code,
      message: claimErr.message,
    });
    return {
      ok: false,
      outcome: "database_error",
      message: "We could not start the refund. Please try again.",
    };
  }
  if (!claimedRows || claimedRows.length === 0) {
    // Two concurrent clicks both passed the pre-claim SELECT but
    // only one wins the UPDATE; the loser sees zero rows.
    return {
      ok: false,
      outcome: "claim_lost",
      message:
        "Another refund attempt is already in flight or the charge is no longer eligible. Refresh and try again.",
    };
  }

  // ============================================================
  // 5. Stripe refund. Connect direct-charge mode passes the
  //    studio's connected account context. v1 always refunds the
  //    full amount; the schema's CHECK leaves room for a later
  //    partial-refund PR to send a smaller amount.
  //    Metadata records the Hone identity tuple + charge reason
  //    + environment=test so an operator triaging the Stripe
  //    dashboard can find the source row.
  //    Idempotency key is keyed on the attempt id so a Stripe
  //    SDK retry / a same-Stripe-keyed redelivery cannot produce
  //    a second refund object.
  // ============================================================
  const stripe = getStripe();
  let refund: Stripe.Refund | null = null;
  try {
    refund = await stripe.refunds.create(
      {
        charge: attempt.stripe_charge_id,
        amount: refundAmountCents,
        metadata: {
          hone_payment_charge_attempt_id: attempt.id,
          hone_studio_id: attempt.studio_id,
          hone_client_id: attempt.client_id,
          hone_charge_reason: attempt.charge_reason,
          hone_environment: "test",
        },
      },
      {
        stripeAccount: attempt.stripe_account_id,
        idempotencyKey,
      },
    );
  } catch (err) {
    // Distinguish a terminal Stripe error (StripeError with code +
    // message) from a network / unknown error. Terminal errors
    // can be classified; network errors leave the row pending so
    // a manual reconciliation can re-query Stripe with the
    // deterministic idempotency key.
    if (err instanceof Stripe.errors.StripeError) {
      const code = sanitizeFailureCode(err.code ?? err.type);
      const safeMessage =
        sanitizeFailureMessage(err.message) ??
        "Stripe refused this refund.";
      const { data: failedRows, error: writeFailedErr } = await admin
        .from("payment_charge_attempts")
        .update({
          refund_status: "failed",
          refund_failure_code: code,
          refund_failure_message_safe: safeMessage,
          stripe_refund_id: null,
          refunded_at: null,
        })
        .eq("id", attempt.id)
        .eq("refund_status", "pending_stripe")
        .select("id");
      // PR #263: a zero-row update (no matching pending_stripe row)
      // persisted nothing even though Stripe terminally refused the
      // refund. Treat it like a write error so the failed outcome is
      // never silently dropped.
      const failedWriteZeroRows =
        !writeFailedErr && (!failedRows || failedRows.length === 0);
      if (writeFailedErr || failedWriteZeroRows) {
        logInternal("payment_refund_write_failed_outcome_failed", {
          attemptId: attempt.id,
          code: writeFailedErr?.code ?? null,
          message: writeFailedErr?.message ?? null,
          zeroRows: failedWriteZeroRows,
        });
        await recordOpsAlert({
          severity: "critical",
          event: "payment_refund_failed_write_failed",
          message:
            "Stripe refund returned a terminal error, but Hone could not stamp the failed outcome on the attempt row (DB error or zero-row update). Manual reconciliation required.",
          studioId: attempt.studio_id,
          clientId: attempt.client_id,
          route: ROUTE,
          safeDetails: {
            attempt_id: attempt.id,
            charge_reason: attempt.charge_reason,
            stripe_charge_id: attempt.stripe_charge_id,
            stripe_failure_code: code,
            db_code: writeFailedErr?.code ?? null,
            zero_rows: failedWriteZeroRows,
          },
        });
      }
      await recordOpsAlert({
        severity: "warning",
        event: "payment_refund_failed",
        message:
          "Stripe refused the refund. The attempt row carries the sanitised failure code and message.",
        studioId: attempt.studio_id,
        clientId: attempt.client_id,
        route: ROUTE,
        safeDetails: {
          attempt_id: attempt.id,
          charge_reason: attempt.charge_reason,
          stripe_charge_id: attempt.stripe_charge_id,
          stripe_failure_code: code,
        },
      });
      return {
        ok: false,
        outcome: "failed",
        message: safeMessage,
        failureCode: code,
      };
    }

    // Non-Stripe error (network, timeout, etc.). The row stays
    // pending_stripe; an operator reconciliation can re-query
    // Stripe using the deterministic idempotency key. The
    // critical ops_alert is the operator's wake-up signal.
    const safeMessage =
      sanitizeFailureMessage(
        err instanceof Error ? err.message : String(err),
      ) ?? "Refund Stripe call did not return a response.";
    logInternal("payment_refund_stripe_unknown_outcome", {
      attemptId: attempt.id,
      message: safeMessage,
    });
    await recordOpsAlert({
      severity: "critical",
      event: "payment_refund_stripe_unknown_outcome",
      message:
        "Stripe refund call did not return a clear outcome. The attempt row remains in refund_status='pending_stripe' until reconciled with the deterministic idempotency key.",
      studioId: attempt.studio_id,
      clientId: attempt.client_id,
      route: ROUTE,
      safeDetails: {
        attempt_id: attempt.id,
        charge_reason: attempt.charge_reason,
        stripe_charge_id: attempt.stripe_charge_id,
        refund_idempotency_key: idempotencyKey,
      },
    });
    return {
      ok: false,
      outcome: "needs_manual_review",
      message:
        "We did not get a clear response from Stripe. Refresh in a few minutes. Do not retry until the result is confirmed.",
    };
  }

  // ============================================================
  // 6. Success path. Stamp refund_status='succeeded', the Stripe
  //    refund id, and refunded_at. The DB UPDATE matches on
  //    refund_status='pending_stripe' so a concurrent
  //    reconciliation cannot overwrite a row that's already been
  //    handled.
  // ============================================================
  if (!refund) {
    // Defensive. Stripe SDK contract should mean refund is set
    // here, but the type allows null. Treat as unknown outcome.
    await recordOpsAlert({
      severity: "critical",
      event: "payment_refund_stripe_returned_null",
      message:
        "Stripe refund call returned null without throwing. Attempt row stays pending until reconciled.",
      studioId: attempt.studio_id,
      clientId: attempt.client_id,
      route: ROUTE,
      safeDetails: {
        attempt_id: attempt.id,
        refund_idempotency_key: idempotencyKey,
      },
    });
    return {
      ok: false,
      outcome: "needs_manual_review",
      message:
        "We did not get a clear response from Stripe. Refresh in a few minutes.",
    };
  }

  const refundedAtIso = new Date().toISOString();
  const { data: okRows, error: writeOkErr } = await admin
    .from("payment_charge_attempts")
    .update({
      refund_status: "succeeded",
      stripe_refund_id: refund.id,
      refunded_at: refundedAtIso,
      refund_failure_code: null,
      refund_failure_message_safe: null,
    })
    .eq("id", attempt.id)
    .eq("refund_status", "pending_stripe")
    .select("id");
  // PR #263: a zero-row update (no matching pending_stripe row) means
  // the refund is real on Stripe but nothing was persisted locally.
  // Treat it identically to a write error — never report success
  // without proving the row was stamped.
  const okWriteZeroRows = !writeOkErr && (!okRows || okRows.length === 0);
  if (writeOkErr || okWriteZeroRows) {
    // Stripe says refund is done but we could not persist the
    // success outcome (DB error or zero-row update). Critical alert;
    // do not invent the refund id elsewhere.
    logInternal("payment_refund_succeeded_write_failed", {
      attemptId: attempt.id,
      stripeRefundId: refund.id,
      code: writeOkErr?.code ?? null,
      message: writeOkErr?.message ?? null,
      zeroRows: okWriteZeroRows,
    });
    await recordOpsAlert({
      severity: "critical",
      event: "payment_refund_succeeded_write_failed",
      message:
        "Stripe refund succeeded, but Hone could not persist the succeeded outcome on the attempt row (DB error or zero-row update). The refund is real on Stripe; the row stays pending until reconciled.",
      studioId: attempt.studio_id,
      clientId: attempt.client_id,
      route: ROUTE,
      safeDetails: {
        attempt_id: attempt.id,
        charge_reason: attempt.charge_reason,
        stripe_refund_id: refund.id,
        db_code: writeOkErr?.code ?? null,
        zero_rows: okWriteZeroRows,
      },
    });
    return {
      ok: false,
      outcome: "needs_manual_review",
      message:
        "The refund went through on Stripe, but Hone could not save the result. The studio operator will reconcile this.",
    };
  }

  return {
    ok: true,
    outcome: "succeeded",
    stripeRefundId: refund.id,
    refundedAt: refundedAtIso,
    refundAmountCents,
  };
}
