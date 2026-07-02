import "server-only";
import type Stripe from "stripe";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { recordOpsAlert } from "@/lib/ops/alerts";

// ---------------------------------------------------------------------------
// PR #179. Stripe webhook reconciliation for payment_charge_attempts.
// ---------------------------------------------------------------------------
//
// Test-mode-only reconciliation helpers. The webhook route dispatches
// to these four exported handlers; each handler is responsible for
// safely reflecting a Stripe event onto a payment_charge_attempts row
// (or refusing to do so + recording an ops_alert when the local state
// would be corrupted by the mutation).
//
// Critical safety invariants (every handler):
//   * NO new PaymentIntent / Charge / Refund / SetupIntent / Checkout
//     Stripe call. The handlers only READ Stripe payloads passed in
//     by the webhook route + WRITE to payment_charge_attempts +
//     ops_alerts.
//   * Live-mode events: if event.livemode === true, the handler
//     returns a summary documenting the ignore + records a warning
//     ops_alert. No row mutation. The payment_charge_attempts_livemode
//     _false_check is the structural backstop even if a handler were
//     to forget the guard.
//   * Studio / client / charge_reason metadata mismatch: critical
//     ops_alert + no row mutation. Better to leave a row out of
//     sync (visible via the dashboard) than to overwrite it with
//     untrusted ids.
//   * Status transitions are conditional. A row that's already in a
//     terminal local state (failed / cancelled / blocked /
//     refund_status=succeeded) is NEVER silently flipped by a webhook;
//     a mismatch fires a critical ops_alert.
//   * Each handler is idempotent: rerunning on the same row produces
//     no additional mutations + no duplicate alerts.
//
// Reason-agnostic by construction. The handlers read the row's
// charge_reason; they never branch on it. The same code reconciles
// session_payment today and future late_cancellation_fee /
// no_show_fee rows without change.
//
// What this module does NOT do:
//   * No new Stripe API calls.
//   * No automatic refund triggers (a charge.dispute.created event
//     records an ops_alert only; this module deliberately does not
//     invoke the Stripe refund SDK, and the gate script counts
//     substring occurrences across runtime source files).
//   * No client portal mutation.
//   * No email / SMS.
//   * No manual_fee_charge_attempts touch.
//   * No live-mode CHECK relaxation.

const FAILURE_MESSAGE_MAX = 1000;
const FAILURE_CODE_MAX = 100;
const ROUTE = "app/api/stripe/webhook";

type WebhookCtx = {
  studioId: string | null;
  stripeAccountId: string | null;
  livemode: boolean;
};

type AttemptRow = {
  id: string;
  studio_id: string;
  client_id: string;
  charge_reason: string;
  status: string;
  stripe_livemode: boolean;
  stripe_payment_intent_id: string | null;
  stripe_charge_id: string | null;
  amount_cents: number;
  charged_at: string | null;
  refund_status: string | null;
  refund_amount_cents: number | null;
  refunded_at: string | null;
  stripe_refund_id: string | null;
};

const ATTEMPT_COLUMNS =
  "id, studio_id, client_id, charge_reason, status, stripe_livemode, stripe_payment_intent_id, stripe_charge_id, amount_cents, charged_at, refund_status, refund_amount_cents, refunded_at, stripe_refund_id";

// ---------------------------------------------------------------------------
// Sanitisers (mirror lib/billing/session-payment-charge.ts +
// lib/billing/payment-refund.ts so the webhook outcome columns are
// formatted identically to the action-layer outcome columns).
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Live-mode dormancy guard. Webhook handlers MUST call this first.
// Returns true when the event was a live-mode event that we ignored
// (and the caller should return its summary unchanged). Returns false
// when the handler should proceed with test-mode reconciliation.
// ---------------------------------------------------------------------------
// PR #319: exported so the setup_intent.succeeded handler (in the webhook
// route) can apply the SAME live-mode dormancy guard the four money handlers
// use. setup_intent.succeeded is the only card-WRITE path, so it must ignore
// live events (record a warning ops alert, write nothing) while live mode is
// structurally disabled — reusing this guard keeps the alert taxonomy and the
// livemode-mismatch semantics identical across every reconciliation surface.
export async function shouldIgnoreLiveModeEvent(
  event: Stripe.Event,
  ctx: WebhookCtx,
  eventForAlert: string,
): Promise<boolean> {
  if (event.livemode !== true && ctx.livemode !== true) {
    return false;
  }
  await recordOpsAlert({
    severity: "warning",
    event: "stripe_webhook_livemode_event_ignored",
    message:
      "Live-mode Stripe webhook event received while live mode is structurally disabled. Ignored.",
    studioId: ctx.studioId,
    stripeEventId: event.id,
    route: ROUTE,
    safeDetails: {
      event_type: event.type,
      target_event: eventForAlert,
      stripe_account_id: ctx.stripeAccountId,
    },
  });
  return true;
}

// ---------------------------------------------------------------------------
// Attempt row resolver. Returns the row + an indicator of which key
// was used so the payload_summary can record provenance.
//
// Lookup order:
//   1. metadata canonical key 'hone_payment_charge_attempt_id'
//      (PR #178 refund) -- ALWAYS check this first.
//   2. metadata charge-specific key 'hone_session_payment_charge
//      _attempt_id' (PR #173 session_payment charge) -- read second
//      for backward compatibility on PaymentIntent events.
//   3. Fallback by stripe_payment_intent_id (for PI events) or
//      stripe_charge_id (for Charge events) -- the caller picks
//      which fallback applies.
// ---------------------------------------------------------------------------
type Resolution =
  | { ok: true; attempt: AttemptRow; via: "canonical_metadata" | "legacy_metadata" | "stripe_id_fallback" }
  | { ok: false; reason: "not_found" | "database_error"; detail?: string };

async function resolveAttemptByMetadataOrId(args: {
  metadata: Record<string, string> | undefined | null;
  fallbackByPaymentIntentId?: string | null;
  fallbackByChargeId?: string | null;
}): Promise<Resolution> {
  const admin = createAdminClient();
  const meta = args.metadata ?? {};
  const canonicalId = (meta["hone_payment_charge_attempt_id"] ?? "").trim();
  const legacyId =
    (meta["hone_session_payment_charge_attempt_id"] ?? "").trim();

  // 1. Canonical metadata.
  if (canonicalId) {
    const { data, error } = await admin
      .from("payment_charge_attempts")
      .select(ATTEMPT_COLUMNS)
      .eq("id", canonicalId)
      .maybeSingle();
    if (error) {
      return {
        ok: false,
        reason: "database_error",
        detail: `${error.code}:${error.message}`,
      };
    }
    if (data) {
      return { ok: true, attempt: data as AttemptRow, via: "canonical_metadata" };
    }
  }

  // 2. Legacy metadata (PR #173 session_payment-specific key).
  if (legacyId) {
    const { data, error } = await admin
      .from("payment_charge_attempts")
      .select(ATTEMPT_COLUMNS)
      .eq("id", legacyId)
      .maybeSingle();
    if (error) {
      return {
        ok: false,
        reason: "database_error",
        detail: `${error.code}:${error.message}`,
      };
    }
    if (data) {
      return { ok: true, attempt: data as AttemptRow, via: "legacy_metadata" };
    }
  }

  // 3. Stripe id fallback.
  if (args.fallbackByPaymentIntentId) {
    const { data, error } = await admin
      .from("payment_charge_attempts")
      .select(ATTEMPT_COLUMNS)
      .eq("stripe_payment_intent_id", args.fallbackByPaymentIntentId)
      .maybeSingle();
    if (error) {
      return {
        ok: false,
        reason: "database_error",
        detail: `${error.code}:${error.message}`,
      };
    }
    if (data) {
      return { ok: true, attempt: data as AttemptRow, via: "stripe_id_fallback" };
    }
  }
  if (args.fallbackByChargeId) {
    const { data, error } = await admin
      .from("payment_charge_attempts")
      .select(ATTEMPT_COLUMNS)
      .eq("stripe_charge_id", args.fallbackByChargeId)
      .maybeSingle();
    if (error) {
      return {
        ok: false,
        reason: "database_error",
        detail: `${error.code}:${error.message}`,
      };
    }
    if (data) {
      return { ok: true, attempt: data as AttemptRow, via: "stripe_id_fallback" };
    }
  }

  return { ok: false, reason: "not_found" };
}

// ---------------------------------------------------------------------------
// Metadata-consistency guard. The webhook never trusts metadata
// blindly; if the metadata claims a studio / client / charge_reason
// different from what's stamped on the row we resolved, that's a
// critical mismatch + we refuse to mutate the row.
// ---------------------------------------------------------------------------
async function metadataMismatchOpsAlert(args: {
  attempt: AttemptRow;
  metadata: Record<string, string>;
  stripeEventId: string;
  targetEvent: string;
  mismatch: "studio_id" | "client_id" | "charge_reason";
  expected: string;
  actual: string;
}): Promise<void> {
  await recordOpsAlert({
    severity: "critical",
    event: "stripe_webhook_metadata_mismatch",
    message:
      `Stripe webhook metadata does not match the resolved payment_charge_attempts row on ${args.mismatch}. Row was NOT mutated.`,
    studioId: args.attempt.studio_id,
    clientId: args.attempt.client_id,
    stripeEventId: args.stripeEventId,
    route: ROUTE,
    safeDetails: {
      target_event: args.targetEvent,
      attempt_id: args.attempt.id,
      mismatch: args.mismatch,
      expected_row_value: args.expected,
      stripe_metadata_value: args.actual,
    },
  });
}

async function verifyMetadataAgainstRow(args: {
  attempt: AttemptRow;
  metadata: Record<string, string>;
  stripeEventId: string;
  targetEvent: string;
}): Promise<boolean> {
  const m = args.metadata;
  if (m["hone_studio_id"] && m["hone_studio_id"] !== args.attempt.studio_id) {
    await metadataMismatchOpsAlert({
      attempt: args.attempt,
      metadata: m,
      stripeEventId: args.stripeEventId,
      targetEvent: args.targetEvent,
      mismatch: "studio_id",
      expected: args.attempt.studio_id,
      actual: m["hone_studio_id"],
    });
    return false;
  }
  if (m["hone_client_id"] && m["hone_client_id"] !== args.attempt.client_id) {
    await metadataMismatchOpsAlert({
      attempt: args.attempt,
      metadata: m,
      stripeEventId: args.stripeEventId,
      targetEvent: args.targetEvent,
      mismatch: "client_id",
      expected: args.attempt.client_id,
      actual: m["hone_client_id"],
    });
    return false;
  }
  if (
    m["hone_charge_reason"] &&
    m["hone_charge_reason"] !== args.attempt.charge_reason
  ) {
    await metadataMismatchOpsAlert({
      attempt: args.attempt,
      metadata: m,
      stripeEventId: args.stripeEventId,
      targetEvent: args.targetEvent,
      mismatch: "charge_reason",
      expected: args.attempt.charge_reason,
      actual: m["hone_charge_reason"],
    });
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// payment_intent.succeeded
// ---------------------------------------------------------------------------
export async function handlePaymentIntentSucceeded(
  event: Stripe.Event,
  ctx: WebhookCtx,
): Promise<Record<string, unknown>> {
  if (await shouldIgnoreLiveModeEvent(event, ctx, "payment_intent.succeeded")) {
    return {
      eventType: event.type,
      livemodeEventIgnored: true,
    };
  }

  const pi = event.data.object as Stripe.PaymentIntent;
  const metadata = (pi.metadata ?? {}) as Record<string, string>;

  const resolution = await resolveAttemptByMetadataOrId({
    metadata,
    fallbackByPaymentIntentId: pi.id,
  });
  if (!resolution.ok) {
    if (resolution.reason === "database_error") {
      throw new Error(
        `payment_intent_succeeded_lookup_failed:${resolution.detail ?? ""}`,
      );
    }
    await recordOpsAlert({
      severity: "warning",
      event: "payment_intent_succeeded_no_match",
      message:
        "Stripe payment_intent.succeeded event did not match any payment_charge_attempts row. No mutation.",
      stripeEventId: event.id,
      stripePaymentIntentId: pi.id,
      route: ROUTE,
      safeDetails: {
        event_type: event.type,
        stripe_payment_intent_id: pi.id,
      },
    });
    return {
      eventType: event.type,
      stripePaymentIntentId: pi.id,
      noMatch: true,
    };
  }
  const attempt = resolution.attempt;

  if (
    !(await verifyMetadataAgainstRow({
      attempt,
      metadata,
      stripeEventId: event.id,
      targetEvent: "payment_intent.succeeded",
    }))
  ) {
    return {
      eventType: event.type,
      attemptId: attempt.id,
      metadataMismatch: true,
    };
  }

  // Defence in depth: the row's stripe_livemode must be false. The
  // CHECK constraint refuses a live row anyway; this guards against
  // an event resolved by a fallback path against a row that the CHECK
  // never enforced (impossible today; future-proofing).
  if (attempt.stripe_livemode !== false) {
    await recordOpsAlert({
      severity: "critical",
      event: "payment_intent_succeeded_livemode_row_mismatch",
      message:
        "Stripe payment_intent.succeeded resolved to a row with stripe_livemode=true. Row was NOT mutated.",
      studioId: attempt.studio_id,
      clientId: attempt.client_id,
      stripeEventId: event.id,
      stripePaymentIntentId: pi.id,
      route: ROUTE,
      safeDetails: {
        attempt_id: attempt.id,
      },
    });
    return {
      eventType: event.type,
      attemptId: attempt.id,
      livemodeRowMismatch: true,
    };
  }

  if (attempt.status === "succeeded") {
    // Idempotent. If charge id is missing on the row (rare race),
    // stamp it from the PI's latest_charge. Never overwrite existing
    // succeeded fields.
    const latestChargeId =
      typeof pi.latest_charge === "string"
        ? pi.latest_charge
        : (pi.latest_charge?.id ?? null);
    if (!attempt.stripe_charge_id && latestChargeId) {
      const admin = createAdminClient();
      await admin
        .from("payment_charge_attempts")
        .update({ stripe_charge_id: latestChargeId })
        .eq("id", attempt.id)
        .is("stripe_charge_id", null);
    }
    return {
      eventType: event.type,
      attemptId: attempt.id,
      alreadySucceeded: true,
      resolutionVia: resolution.via,
    };
  }

  if (
    attempt.status === "failed" ||
    attempt.status === "cancelled" ||
    attempt.status === "blocked"
  ) {
    await recordOpsAlert({
      severity: "critical",
      event: "payment_intent_succeeded_local_terminal_mismatch",
      message:
        `Stripe says payment_intent.succeeded but Hone payment_charge_attempts row is in terminal local state '${attempt.status}'. Row was NOT flipped to 'succeeded'.`,
      studioId: attempt.studio_id,
      clientId: attempt.client_id,
      stripeEventId: event.id,
      stripePaymentIntentId: pi.id,
      route: ROUTE,
      safeDetails: {
        attempt_id: attempt.id,
        local_status: attempt.status,
        resolution_via: resolution.via,
      },
    });
    return {
      eventType: event.type,
      attemptId: attempt.id,
      localTerminalMismatch: attempt.status,
    };
  }

  // ready / pending_stripe: reconcile to succeeded. Conditional
  // UPDATE on status='ready' OR 'pending_stripe' so a concurrent
  // action-layer write that already moved the row to succeeded is
  // not double-stamped.
  const latestChargeId =
    typeof pi.latest_charge === "string"
      ? pi.latest_charge
      : (pi.latest_charge?.id ?? null);
  const admin = createAdminClient();
  const updates: Record<string, unknown> = {
    status: "succeeded",
    charged_at: new Date().toISOString(),
    failure_code: null,
    failure_message_safe: null,
    failed_at: null,
  };
  if (!attempt.stripe_payment_intent_id) {
    updates.stripe_payment_intent_id = pi.id;
  }
  if (!attempt.stripe_charge_id && latestChargeId) {
    updates.stripe_charge_id = latestChargeId;
  }
  const { data: updatedRows, error: updateErr } = await admin
    .from("payment_charge_attempts")
    .update(updates)
    .eq("id", attempt.id)
    .in("status", ["ready", "pending_stripe"])
    .select("id");
  if (updateErr) {
    throw new Error(
      `payment_intent_succeeded_update_failed:${updateErr.code}:${updateErr.message}`,
    );
  }
  // PR #263: zero-row detection. The status-conditional UPDATE matched
  // no row — the attempt left ready/pending_stripe between the read
  // above and this write (a concurrent action-layer or webhook write).
  // Do NOT report a reconciliation that did not happen.
  if (!updatedRows || updatedRows.length === 0) {
    await recordOpsAlert({
      severity: "warning",
      event: "payment_intent_succeeded_reconcile_zero_rows",
      message:
        "payment_intent.succeeded reconciliation affected zero rows (the attempt was no longer ready/pending_stripe). No mutation; likely already reconciled by a concurrent writer. Verify the row state.",
      studioId: attempt.studio_id,
      clientId: attempt.client_id,
      stripeEventId: event.id,
      stripePaymentIntentId: pi.id,
      route: ROUTE,
      safeDetails: {
        attempt_id: attempt.id,
        read_status: attempt.status,
        attempted_status: "succeeded",
      },
    });
    return {
      eventType: event.type,
      attemptId: attempt.id,
      zeroRowNoMutation: true,
    };
  }

  return {
    eventType: event.type,
    attemptId: attempt.id,
    reconciledFromStatus: attempt.status,
    resolutionVia: resolution.via,
  };
}

// ---------------------------------------------------------------------------
// payment_intent.payment_failed
// ---------------------------------------------------------------------------
export async function handlePaymentIntentPaymentFailed(
  event: Stripe.Event,
  ctx: WebhookCtx,
): Promise<Record<string, unknown>> {
  if (
    await shouldIgnoreLiveModeEvent(event, ctx, "payment_intent.payment_failed")
  ) {
    return {
      eventType: event.type,
      livemodeEventIgnored: true,
    };
  }

  const pi = event.data.object as Stripe.PaymentIntent;
  const metadata = (pi.metadata ?? {}) as Record<string, string>;

  const resolution = await resolveAttemptByMetadataOrId({
    metadata,
    fallbackByPaymentIntentId: pi.id,
  });
  if (!resolution.ok) {
    if (resolution.reason === "database_error") {
      throw new Error(
        `payment_intent_failed_lookup_failed:${resolution.detail ?? ""}`,
      );
    }
    await recordOpsAlert({
      severity: "warning",
      event: "payment_intent_failed_no_match",
      message:
        "Stripe payment_intent.payment_failed event did not match any payment_charge_attempts row. No mutation.",
      stripeEventId: event.id,
      stripePaymentIntentId: pi.id,
      route: ROUTE,
      safeDetails: {
        event_type: event.type,
        stripe_payment_intent_id: pi.id,
      },
    });
    return {
      eventType: event.type,
      stripePaymentIntentId: pi.id,
      noMatch: true,
    };
  }
  const attempt = resolution.attempt;

  if (
    !(await verifyMetadataAgainstRow({
      attempt,
      metadata,
      stripeEventId: event.id,
      targetEvent: "payment_intent.payment_failed",
    }))
  ) {
    return {
      eventType: event.type,
      attemptId: attempt.id,
      metadataMismatch: true,
    };
  }

  if (attempt.status === "succeeded") {
    await recordOpsAlert({
      severity: "critical",
      event: "payment_intent_failed_after_local_succeeded",
      message:
        "Stripe payment_intent.payment_failed received but Hone payment_charge_attempts row is already 'succeeded'. Row was NOT flipped to 'failed'.",
      studioId: attempt.studio_id,
      clientId: attempt.client_id,
      stripeEventId: event.id,
      stripePaymentIntentId: pi.id,
      route: ROUTE,
      safeDetails: {
        attempt_id: attempt.id,
        local_status: attempt.status,
      },
    });
    return {
      eventType: event.type,
      attemptId: attempt.id,
      localSucceededMismatch: true,
    };
  }

  if (attempt.status === "failed") {
    // Idempotent. Safe fields may be refreshed from the latest
    // event's error, but we leave them alone for v1: a webhook
    // refresh on an already-failed row is rare and the action-
    // layer write is the canonical source.
    return {
      eventType: event.type,
      attemptId: attempt.id,
      alreadyFailed: true,
    };
  }

  if (attempt.status === "cancelled" || attempt.status === "blocked") {
    await recordOpsAlert({
      severity: "critical",
      event: "payment_intent_failed_local_terminal_mismatch",
      message:
        `Stripe says payment_intent.payment_failed but Hone payment_charge_attempts row is in terminal local state '${attempt.status}'. Row was NOT flipped.`,
      studioId: attempt.studio_id,
      clientId: attempt.client_id,
      stripeEventId: event.id,
      stripePaymentIntentId: pi.id,
      route: ROUTE,
      safeDetails: {
        attempt_id: attempt.id,
        local_status: attempt.status,
      },
    });
    return {
      eventType: event.type,
      attemptId: attempt.id,
      localTerminalMismatch: attempt.status,
    };
  }

  // ready / pending_stripe: reconcile to failed.
  const lastError = pi.last_payment_error;
  const code = sanitizeFailureCode(lastError?.code ?? lastError?.type ?? null);
  const safeMessage =
    sanitizeFailureMessage(lastError?.message ?? null) ??
    "Stripe payment_intent.payment_failed (no message)";
  const admin = createAdminClient();
  const updates: Record<string, unknown> = {
    status: "failed",
    failed_at: new Date().toISOString(),
    failure_code: code,
    failure_message_safe: safeMessage,
  };
  if (!attempt.stripe_payment_intent_id) {
    updates.stripe_payment_intent_id = pi.id;
  }
  const { data: updatedRows, error: updateErr } = await admin
    .from("payment_charge_attempts")
    .update(updates)
    .eq("id", attempt.id)
    .in("status", ["ready", "pending_stripe"])
    .select("id");
  if (updateErr) {
    throw new Error(
      `payment_intent_failed_update_failed:${updateErr.code}:${updateErr.message}`,
    );
  }
  // PR #263: zero-row detection (see handlePaymentIntentSucceeded).
  if (!updatedRows || updatedRows.length === 0) {
    await recordOpsAlert({
      severity: "warning",
      event: "payment_intent_failed_reconcile_zero_rows",
      message:
        "payment_intent.payment_failed reconciliation affected zero rows (the attempt was no longer ready/pending_stripe). No mutation; likely already reconciled by a concurrent writer. Verify the row state.",
      studioId: attempt.studio_id,
      clientId: attempt.client_id,
      stripeEventId: event.id,
      stripePaymentIntentId: pi.id,
      route: ROUTE,
      safeDetails: {
        attempt_id: attempt.id,
        read_status: attempt.status,
        attempted_status: "failed",
      },
    });
    return {
      eventType: event.type,
      attemptId: attempt.id,
      zeroRowNoMutation: true,
    };
  }

  return {
    eventType: event.type,
    attemptId: attempt.id,
    reconciledFromStatus: attempt.status,
  };
}

// ---------------------------------------------------------------------------
// charge.refunded
// ---------------------------------------------------------------------------
//
// Full refund only is reconciled to the row. Partial refunds (out-of-
// band Stripe Dashboard issuing a partial) record a critical ops_alert
// and DO NOT touch the row's refund_status -- v1 schema cannot
// truthfully represent partial state. A future PR may add a
// refund_out_of_band_amount_cents column.
// ---------------------------------------------------------------------------
export async function handleChargeRefunded(
  event: Stripe.Event,
  ctx: WebhookCtx,
): Promise<Record<string, unknown>> {
  if (await shouldIgnoreLiveModeEvent(event, ctx, "charge.refunded")) {
    return {
      eventType: event.type,
      livemodeEventIgnored: true,
    };
  }

  const charge = event.data.object as Stripe.Charge;
  const metadata = (charge.metadata ?? {}) as Record<string, string>;

  const resolution = await resolveAttemptByMetadataOrId({
    metadata,
    fallbackByChargeId: charge.id,
  });
  if (!resolution.ok) {
    if (resolution.reason === "database_error") {
      throw new Error(
        `charge_refunded_lookup_failed:${resolution.detail ?? ""}`,
      );
    }
    await recordOpsAlert({
      severity: "warning",
      event: "charge_refunded_no_match",
      message:
        "Stripe charge.refunded event did not match any payment_charge_attempts row. No mutation.",
      stripeEventId: event.id,
      route: ROUTE,
      safeDetails: {
        event_type: event.type,
        stripe_charge_id: charge.id,
        charge_metadata_attempt_id:
          metadata["hone_payment_charge_attempt_id"] ?? null,
      },
    });
    return {
      eventType: event.type,
      stripeChargeId: charge.id,
      noMatch: true,
    };
  }
  const attempt = resolution.attempt;

  if (
    !(await verifyMetadataAgainstRow({
      attempt,
      metadata,
      stripeEventId: event.id,
      targetEvent: "charge.refunded",
    }))
  ) {
    return {
      eventType: event.type,
      attemptId: attempt.id,
      metadataMismatch: true,
    };
  }

  if (attempt.stripe_livemode !== false) {
    await recordOpsAlert({
      severity: "critical",
      event: "charge_refunded_livemode_row_mismatch",
      message:
        "Stripe charge.refunded resolved to a row with stripe_livemode=true. Row was NOT mutated.",
      studioId: attempt.studio_id,
      clientId: attempt.client_id,
      stripeEventId: event.id,
      route: ROUTE,
      safeDetails: {
        attempt_id: attempt.id,
        stripe_charge_id: charge.id,
      },
    });
    return {
      eventType: event.type,
      attemptId: attempt.id,
      livemodeRowMismatch: true,
    };
  }

  const amountCaptured = charge.amount ?? 0;
  const amountRefunded = charge.amount_refunded ?? 0;
  const isFullRefund =
    charge.refunded === true && amountRefunded === amountCaptured;

  if (!isFullRefund) {
    // Partial refund. v1 schema does not have a column to
    // truthfully represent "Stripe refunded X but only Y of Z".
    // Record a critical ops_alert; do NOT touch the row. The
    // operator must reconcile via Stripe Dashboard.
    await recordOpsAlert({
      severity: "critical",
      event: "charge_refunded_partial_out_of_band",
      message:
        "Stripe charge.refunded with a partial amount. v1 Hone schema does not represent partial refunds; row was NOT mutated. Reconcile via Stripe Dashboard.",
      studioId: attempt.studio_id,
      clientId: attempt.client_id,
      stripeEventId: event.id,
      route: ROUTE,
      safeDetails: {
        attempt_id: attempt.id,
        stripe_charge_id: charge.id,
        amount_captured: amountCaptured,
        amount_refunded: amountRefunded,
        currency: charge.currency,
      },
    });
    return {
      eventType: event.type,
      attemptId: attempt.id,
      partialRefundIgnored: true,
      amountRefunded,
      amountCaptured,
    };
  }

  // Resolve the Stripe refund id. Prefer the most recent refund
  // object on the charge (refunds.data is ordered newest-first by
  // Stripe in the standard payload).
  const latestRefund = charge.refunds?.data?.[0];
  const stripeRefundId = latestRefund?.id ?? null;

  if (attempt.refund_status === "succeeded") {
    // Idempotent: stamp the Stripe refund id if missing (rare
    // race window between PR #178 helper writing and the webhook
    // arriving before the .update fully landed).
    if (!attempt.stripe_refund_id && stripeRefundId) {
      const admin = createAdminClient();
      await admin
        .from("payment_charge_attempts")
        .update({ stripe_refund_id: stripeRefundId })
        .eq("id", attempt.id)
        .is("stripe_refund_id", null);
    }
    return {
      eventType: event.type,
      attemptId: attempt.id,
      alreadyRefunded: true,
    };
  }

  if (attempt.refund_status === "pending_stripe") {
    // PR #178 helper claimed the row but the action either lost
    // the writeOk leg or the webhook beat the helper's UPDATE.
    // Either way: reconcile to succeeded.
    const admin = createAdminClient();
    const refundAmountCents =
      attempt.refund_amount_cents ?? attempt.amount_cents;
    const updates: Record<string, unknown> = {
      refund_status: "succeeded",
      refunded_at: new Date().toISOString(),
      refund_amount_cents: refundAmountCents,
      refund_failure_code: null,
      refund_failure_message_safe: null,
    };
    if (!attempt.stripe_refund_id && stripeRefundId) {
      updates.stripe_refund_id = stripeRefundId;
    }
    const { data: updatedRows, error: updateErr } = await admin
      .from("payment_charge_attempts")
      .update(updates)
      .eq("id", attempt.id)
      .eq("refund_status", "pending_stripe")
      .select("id");
    if (updateErr) {
      throw new Error(
        `charge_refunded_pending_update_failed:${updateErr.code}:${updateErr.message}`,
      );
    }
    // PR #263: zero-row detection. refund_status left pending_stripe
    // before this write (a concurrent helper/webhook reconciled it).
    if (!updatedRows || updatedRows.length === 0) {
      await recordOpsAlert({
        severity: "warning",
        event: "charge_refunded_pending_reconcile_zero_rows",
        message:
          "charge.refunded reconciliation of a pending_stripe refund affected zero rows (refund_status was no longer pending_stripe). No mutation; likely already reconciled by a concurrent writer. Verify the row state.",
        studioId: attempt.studio_id,
        clientId: attempt.client_id,
        stripeEventId: event.id,
        route: ROUTE,
        safeDetails: {
          attempt_id: attempt.id,
          stripe_charge_id: charge.id,
          attempted_refund_status: "succeeded",
        },
      });
      return {
        eventType: event.type,
        attemptId: attempt.id,
        zeroRowNoMutation: true,
      };
    }
    return {
      eventType: event.type,
      attemptId: attempt.id,
      reconciledFromPending: true,
    };
  }

  // null OR 'failed': this is an out-of-band full refund (Stripe
  // Dashboard or another tool). Reconcile to succeeded so the UI
  // truthfully reflects state, but flag the origin via a warning
  // ops_alert so the operator knows.
  const admin = createAdminClient();
  const refundAmountCents = attempt.amount_cents;
  const updates: Record<string, unknown> = {
    refund_status: "succeeded",
    refunded_at: new Date().toISOString(),
    refund_amount_cents: refundAmountCents,
    refund_failure_code: null,
    refund_failure_message_safe: null,
  };
  if (stripeRefundId) {
    updates.stripe_refund_id = stripeRefundId;
  }
  // Use a status-conditional UPDATE so we do not race a concurrent
  // helper run that just claimed pending_stripe; only flip rows
  // whose refund_status is null or 'failed'.
  const { data: updatedRows, error: updateErr } = await admin
    .from("payment_charge_attempts")
    .update(updates)
    .eq("id", attempt.id)
    .or("refund_status.is.null,refund_status.eq.failed")
    .select("id");
  if (updateErr) {
    throw new Error(
      `charge_refunded_out_of_band_update_failed:${updateErr.code}:${updateErr.message}`,
    );
  }
  // PR #263: zero-row detection. The conditional matched no row
  // (refund_status was concurrently moved off null/failed, e.g. a refund
  // helper just claimed pending_stripe). Do NOT emit the "out-of-band
  // reconciled" alert for a reconciliation that did not happen; surface
  // the zero-row instead so an operator can verify the row state.
  if (!updatedRows || updatedRows.length === 0) {
    await recordOpsAlert({
      severity: "warning",
      event: "charge_refunded_out_of_band_zero_rows",
      message:
        "charge.refunded out-of-band reconciliation affected zero rows (refund_status was no longer null/failed). No mutation; likely a concurrent refund helper claimed the row. Verify the row state.",
      studioId: attempt.studio_id,
      clientId: attempt.client_id,
      stripeEventId: event.id,
      route: ROUTE,
      safeDetails: {
        attempt_id: attempt.id,
        stripe_charge_id: charge.id,
        previous_refund_status: attempt.refund_status,
      },
    });
    return {
      eventType: event.type,
      attemptId: attempt.id,
      zeroRowNoMutation: true,
    };
  }

  await recordOpsAlert({
    severity: "warning",
    event: "charge_refunded_out_of_band_reconciled",
    message:
      "Stripe charge.refunded reconciled an out-of-band full refund onto the payment_charge_attempts row. No Hone refund action was recorded; the refund_initiated_by_practitioner_id is null.",
    studioId: attempt.studio_id,
    clientId: attempt.client_id,
    stripeEventId: event.id,
    route: ROUTE,
    safeDetails: {
      attempt_id: attempt.id,
      stripe_charge_id: charge.id,
      stripe_refund_id: stripeRefundId,
      previous_refund_status: attempt.refund_status,
      refund_amount_cents: refundAmountCents,
    },
  });

  return {
    eventType: event.type,
    attemptId: attempt.id,
    outOfBandReconciled: true,
    previousRefundStatus: attempt.refund_status,
  };
}

// ---------------------------------------------------------------------------
// charge.dispute.created
// ---------------------------------------------------------------------------
//
// Alert-only. No automated dispute response. No mutation of the
// charge row. The operator runbook handles the dispute via Stripe
// Dashboard.
// ---------------------------------------------------------------------------
export async function handleChargeDisputeCreated(
  event: Stripe.Event,
  ctx: WebhookCtx,
): Promise<Record<string, unknown>> {
  if (await shouldIgnoreLiveModeEvent(event, ctx, "charge.dispute.created")) {
    return {
      eventType: event.type,
      livemodeEventIgnored: true,
    };
  }

  const dispute = event.data.object as Stripe.Dispute;
  const chargeId =
    typeof dispute.charge === "string"
      ? dispute.charge
      : dispute.charge?.id ?? null;

  let attemptId: string | null = null;
  let studioId: string | null = null;
  let clientId: string | null = null;
  if (chargeId) {
    const admin = createAdminClient();
    const { data } = await admin
      .from("payment_charge_attempts")
      .select("id, studio_id, client_id")
      .eq("stripe_charge_id", chargeId)
      .maybeSingle();
    if (data) {
      attemptId = data.id as string;
      studioId = data.studio_id as string;
      clientId = data.client_id as string;
    }
  }

  await recordOpsAlert({
    severity: "critical",
    event: "payment_charge_dispute_created",
    message:
      "Stripe charge.dispute.created event received. No automated response; review in Stripe Dashboard.",
    studioId,
    clientId,
    stripeEventId: event.id,
    route: ROUTE,
    safeDetails: {
      attempt_id: attemptId,
      stripe_charge_id: chargeId,
      stripe_dispute_id: dispute.id,
      amount: dispute.amount,
      currency: dispute.currency,
      reason: dispute.reason,
      status: dispute.status,
    },
  });

  return {
    eventType: event.type,
    stripeDisputeId: dispute.id,
    stripeChargeId: chargeId,
    attemptId,
  };
}
