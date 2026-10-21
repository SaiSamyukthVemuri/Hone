import "server-only";
import type Stripe from "stripe";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { inferStripeLivemode } from "@/lib/stripe/server";
import { recordOpsAlert } from "@/lib/ops/alerts";
import {
  compareProviderMoney,
  providerMoneyMismatchDetails,
} from "@/lib/billing/provider-money-facts";

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
//   * Amount / currency mismatch (PAY-CCY-01): the PaymentIntent or
//     Charge must state exactly the row's prepared amount_cents and
//     currency. Otherwise critical ops_alert + no row mutation.
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
  stripe_account_id: string | null;
  stripe_customer_id: string | null;
  stripe_payment_intent_id: string | null;
  stripe_charge_id: string | null;
  amount_cents: number;
  currency: string;
  charged_at: string | null;
  refund_status: string | null;
  refund_amount_cents: number | null;
  refunded_at: string | null;
  stripe_refund_id: string | null;
};

const ATTEMPT_COLUMNS =
  "id, studio_id, client_id, charge_reason, status, stripe_livemode, stripe_account_id, stripe_customer_id, stripe_payment_intent_id, stripe_charge_id, amount_cents, currency, charged_at, refund_status, refund_amount_cents, refunded_at, stripe_refund_id";

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
// Exported (PR #319) so the setup_intent.succeeded handler applies the SAME
// guard the four money handlers use. PR #323: this is now a MODE-MATCHING guard,
// not a "live is structurally disabled" guard: the reconcilers process ONLY
// events whose mode matches the current deployment mode (inferStripeLivemode()),
// and safely IGNORE mismatched-mode events (record a warning ops alert, mutate
// nothing). In test env inferStripeLivemode() is false, so this is identical to
// before: test events process, live events are ignored. After the #324 env flip
// it flips to: live events process, stray test events are ignored.
export async function shouldIgnoreLiveModeEvent(
  event: Stripe.Event,
  ctx: WebhookCtx,
  eventForAlert: string,
): Promise<boolean> {
  const eventLive = event.livemode === true;
  const deploymentLive = inferStripeLivemode();
  if (eventLive === deploymentLive) {
    // Event mode matches the deployment mode → process it.
    return false;
  }
  // Mode mismatch (e.g. a live event delivered to a test deployment, or vice
  // versa) → ignore safely. Never mutate a row from a mismatched-mode event.
  await recordOpsAlert({
    severity: "warning",
    event: "stripe_webhook_livemode_event_ignored",
    message:
      "Stripe webhook event mode does not match the deployment mode. Ignored (no row mutation).",
    studioId: ctx.studioId,
    stripeEventId: event.id,
    route: ROUTE,
    safeDetails: {
      event_type: event.type,
      target_event: eventForAlert,
      event_livemode: eventLive,
      deployment_livemode: deploymentLive,
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
  ctx: WebhookCtx;
  metadata: Record<string, string> | undefined | null;
  fallbackByPaymentIntentId?: string | null;
  fallbackByChargeId?: string | null;
}): Promise<Resolution> {
  if (!args.ctx.studioId || !args.ctx.stripeAccountId) return { ok: false, reason: "not_found" };
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
      .eq("studio_id", args.ctx.studioId)
      .eq("stripe_account_id", args.ctx.stripeAccountId)
      .eq("stripe_livemode", args.ctx.livemode)
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
      .eq("studio_id", args.ctx.studioId)
      .eq("stripe_account_id", args.ctx.stripeAccountId)
      .eq("stripe_livemode", args.ctx.livemode)
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
      .eq("studio_id", args.ctx.studioId)
      .eq("stripe_account_id", args.ctx.stripeAccountId)
      .eq("stripe_livemode", args.ctx.livemode)
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
      .eq("studio_id", args.ctx.studioId)
      .eq("stripe_account_id", args.ctx.stripeAccountId)
      .eq("stripe_livemode", args.ctx.livemode)
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
// Money-consistency guard (PAY-CCY-01, #824). Metadata names WHICH attempt an
// event is about; this asks whether it is about the SAME MONEY. A PaymentIntent
// or Charge whose amount or currency differs from the prepared attempt is not
// that attempt's charge as prepared, so nothing is reflected from it: critical
// alert, no mutation, exactly the metadata-mismatch posture above.
// ---------------------------------------------------------------------------
async function verifyProviderMoneyAgainstRow(args: {
  attempt: AttemptRow;
  provider: { amount: unknown; currency: unknown };
  stripeEventId: string;
  targetEvent: string;
  stripePaymentIntentId?: string | null;
  stripeChargeId?: string | null;
}): Promise<boolean> {
  const prepared = {
    amountCents: args.attempt.amount_cents,
    currency: args.attempt.currency,
  };
  const money = compareProviderMoney(prepared, args.provider);
  if (money.ok) return true;
  await recordOpsAlert({
    severity: "critical",
    event: "stripe_webhook_money_mismatch",
    message:
      "Stripe webhook amount or currency does not equal the prepared payment_charge_attempts row. Row was NOT mutated.",
    studioId: args.attempt.studio_id,
    clientId: args.attempt.client_id,
    stripeEventId: args.stripeEventId,
    stripePaymentIntentId: args.stripePaymentIntentId ?? undefined,
    route: ROUTE,
    safeDetails: {
      target_event: args.targetEvent,
      attempt_id: args.attempt.id,
      stripe_charge_id: args.stripeChargeId ?? null,
      ...providerMoneyMismatchDetails(prepared, args.provider, money.mismatches),
    },
  });
  return false;
}

// A normal create/confirm-to-persistence race, distinct from a genuine handler
// failure. The route recognizes this exact server-only type, never message text.
export class PaymentOriginalBindingPendingError extends Error {
  constructor() {
    super("stripe_webhook_payment_original_binding_pending");
    this.name = "PaymentOriginalBindingPendingError";
  }
}

// The signature proves the event came from Stripe. It does not let metadata
// replace the account/customer/provider object stamped on this durable attempt.
async function verifyPaymentEventIdentity(args: {
  attempt: AttemptRow;
  event: Stripe.Event;
  ctx: WebhookCtx;
  paymentIntentId: string | null;
  chargeId: string | null;
  customerId: string | null;
  metadata: Record<string, string>;
  requireCharge: boolean;
}): Promise<boolean> {
  const { attempt, event, ctx } = args;
  const mismatches: string[] = [];
  if (!ctx.studioId || ctx.studioId !== attempt.studio_id) mismatches.push("studio");
  if (!ctx.stripeAccountId || event.account !== ctx.stripeAccountId || ctx.stripeAccountId !== attempt.stripe_account_id) mismatches.push("account");
  if (event.livemode !== ctx.livemode || event.livemode !== attempt.stripe_livemode) mismatches.push("mode");
  if (!attempt.stripe_customer_id || args.customerId !== attempt.stripe_customer_id) mismatches.push("customer");
  if (!attempt.stripe_payment_intent_id || args.paymentIntentId !== attempt.stripe_payment_intent_id) mismatches.push("payment_intent");
  if ((args.requireCharge && !attempt.stripe_charge_id) || (attempt.stripe_charge_id && args.chargeId !== attempt.stripe_charge_id)) mismatches.push("charge");
  for (const key of ["hone_payment_charge_attempt_id", "hone_session_payment_charge_attempt_id"]) {
    const id = args.metadata[key]?.trim();
    if (id && id !== attempt.id) mismatches.push(key);
  }
  if (mismatches.length === 0) return true;

  // create(confirm:true) can deliver this event before the charge request has
  // persisted its returned PI/charge. Missing pending originals are not a
  // contradictory identity: preserve delivery through the route's existing
  // release-claim/500 path. Never bind IDs from the event or invoke Stripe here.
  // Any known contradictory account/customer/mode/object/metadata still refuses.
  const awaitingOriginalBinding = attempt.status === "pending_stripe"
    && !!args.paymentIntentId
    && mismatches.every((mismatch) =>
      (mismatch === "payment_intent" && !attempt.stripe_payment_intent_id)
      || (mismatch === "charge" && args.requireCharge
        && !attempt.stripe_charge_id && !!args.chargeId));
  if (awaitingOriginalBinding) {
    throw new PaymentOriginalBindingPendingError();
  }

  await recordOpsAlert({
    severity: "critical",
    event: "stripe_webhook_payment_identity_mismatch",
    message: "Signed payment event does not match the durable attempt identity. No payment row was mutated.",
    studioId: attempt.studio_id,
    clientId: attempt.client_id,
    stripeEventId: event.id,
    route: ROUTE,
    safeDetails: { attempt_id: attempt.id, event_type: event.type, mismatches },
  });
  return false;
}

// A cumulative charge observation is not a single full Refund object. Keep
// only the bound evidence needed by the locked command; no provider lookup.
function isCumulativeChargeRefund(charge: Stripe.Charge): boolean {
  return (charge.refunds?.data?.length ?? 0) > 1
    || charge.refunds?.data?.[0]?.amount !== charge.amount;
}

function cumulativeChargeRefundEvidence(event: Stripe.Event, ctx: WebhookCtx, attempt: AttemptRow) {
  const charge = event.data.object as Stripe.Charge;
  const id = (v: string | { id: string } | null | undefined) => typeof v === "string" ? v : v?.id ?? null;
  if (charge.object !== "charge" || charge.status !== "succeeded" || charge.paid !== true
      || charge.captured !== true || charge.amount_captured !== attempt.amount_cents
      || charge.livemode !== ctx.livemode || charge.refunded !== true
      || charge.amount_refunded !== attempt.amount_cents || charge.amount !== attempt.amount_cents
      || !Number.isSafeInteger(event.created) || event.created < 0
      || typeof event.id !== "string" || !event.id.trim()
      || charge.refunds?.object !== "list" || charge.refunds.has_more !== false
      || !Array.isArray(charge.refunds.data) || charge.refunds.data.length === 0) return null;
  const seen = new Set<string>();
  const components: Array<Record<string, unknown>> = [];
  let total = 0;
  for (const refund of charge.refunds.data) {
    const hasCustomer = "customer" in refund;
    const customer = hasCustomer ? refund.customer : undefined;
    const customerId = typeof customer === "string" ? customer
      : customer && typeof customer === "object" && "id" in customer && typeof customer.id === "string" ? customer.id : null;
    if (refund.object !== "refund" || typeof refund.id !== "string" || !refund.id.trim() || seen.has(refund.id)
        || !Number.isSafeInteger(refund.amount) || refund.amount <= 0 || refund.amount > attempt.amount_cents
        || !["succeeded", "failed", "canceled"].includes(refund.status ?? "")
        || id(refund.charge) !== attempt.stripe_charge_id
        || id(refund.payment_intent) !== attempt.stripe_payment_intent_id
        || refund.currency !== attempt.currency || (hasCustomer && customerId !== attempt.stripe_customer_id)) return null;
    seen.add(refund.id);
    if (refund.status === "succeeded") total += refund.amount;
    if (!Number.isSafeInteger(total) || total > attempt.amount_cents) return null;
    components.push({ object_type: refund.object, refund_id: refund.id, amount_cents: refund.amount,
      currency: refund.currency, refund_status: refund.status, charge_id: id(refund.charge),
      payment_intent_id: id(refund.payment_intent), customer_present: hasCustomer, customer_id: customerId });
  }
  if (total !== attempt.amount_cents) return null;
  return { charge_object_type: charge.object, charge_status: charge.status, charge_paid: charge.paid,
    charge_captured: charge.captured, charge_amount_captured: charge.amount_captured,
    charge_livemode: charge.livemode, charge_refunded: charge.refunded,
    charge_amount_refunded: charge.amount_refunded, charge_refund_list_complete: true,
    charge_refund_components: components };
}

async function reconcileBoundEvent(event: Stripe.Event, ctx: WebhookCtx, attempt: AttemptRow) {
  const isRefund = event.type === "charge.refunded";
  const isStandaloneRefund = event.type.startsWith("refund.");
  const pi = event.data.object as Stripe.PaymentIntent;
  const charge = event.data.object as Stripe.Charge;
  const refund = isStandaloneRefund ? event.data.object as Stripe.Refund : isRefund ? charge.refunds?.data?.[0] : undefined;
  const cumulative = isRefund && isCumulativeChargeRefund(charge);
  const cumulativeEvidence = cumulative ? cumulativeChargeRefundEvidence(event, ctx, attempt) : null;
  const objectId = (value: string | { id: string } | null | undefined) => typeof value === "string" ? value : value?.id ?? null;
  const { data, error } = await createAdminClient().rpc("reconcile_bound_payment_event", {
    p_attempt_id: attempt.id,
    p_event_id: event.id,
    p_event_type: event.type,
    p_studio_id: ctx.studioId,
    p_stripe_account_id: ctx.stripeAccountId,
    p_livemode: ctx.livemode,
    p_object: {
      // Refund events carry original PI/charge IDs, not a customer in this
      // pinned API. Their customer remains the immutable original attempt fact;
      // the signed PI/charge pair must independently match before this command.
      customer_id: isStandaloneRefund ? attempt.stripe_customer_id : objectId(isRefund ? charge.customer : pi.customer),
      payment_intent_id: isStandaloneRefund ? objectId(refund?.payment_intent) : isRefund ? objectId(charge.payment_intent) : pi.id,
      charge_id: isStandaloneRefund ? objectId(refund?.charge) : isRefund ? charge.id : objectId(pi.latest_charge),
      amount_cents: isStandaloneRefund ? attempt.amount_cents : isRefund ? charge.amount : pi.amount,
      currency: isStandaloneRefund ? attempt.currency : isRefund ? charge.currency : pi.currency,
      ...(cumulative ? cumulativeEvidence ?? { charge_refund_components: null } : {}),
      refund_id: cumulative ? null : refund?.id ?? null,
      refund_amount_cents: cumulative ? null : refund?.amount ?? null,
      refund_currency: cumulative ? null : refund?.currency ?? null,
      refund_charge_id: cumulative ? null : objectId(refund?.charge),
      refund_status: cumulative ? null : refund?.status ?? null,
      failure_code: sanitizeFailureCode(pi.last_payment_error?.code ?? pi.last_payment_error?.type),
      failure_message_safe: sanitizeFailureMessage(pi.last_payment_error?.message),
      event_created: event.created,
      evidence_kind: "signed_event",
    },
  });
  const outcome = (Array.isArray(data) ? data[0] : data) as { result?: string } | null;
  if (!error && ["identity_mismatch", "refund_evidence_refused", "invalid_input", "terminal_refund_mismatch"].includes(outcome?.result ?? "")) {
    await recordOpsAlert({
      severity: "critical", event: "stripe_webhook_bound_command_refused",
      message: "The locked payment command refused the signed event evidence. No payment row was mutated.",
      studioId: ctx.studioId, stripeEventId: event.id, route: ROUTE,
      safeDetails: { attempt_id: attempt.id, result: outcome?.result, event_type: event.type },
    });
  }
  return { data, error };
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
    ctx,
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

  if (!(await verifyPaymentEventIdentity({
    attempt, event, ctx, metadata,
    paymentIntentId: pi.id,
    chargeId: typeof pi.latest_charge === "string" ? pi.latest_charge : pi.latest_charge?.id ?? null,
    customerId: typeof pi.customer === "string" ? pi.customer : pi.customer?.id ?? null,
    requireCharge: false,
  }))) {
    return { eventType: event.type, attemptId: attempt.id, identityMismatch: true };
  }

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
  if (attempt.stripe_livemode !== inferStripeLivemode()) {
    await recordOpsAlert({
      severity: "critical",
      event: "payment_intent_succeeded_livemode_row_mismatch",
      message:
        "Stripe payment_intent.succeeded resolved to a row whose stripe_livemode does not match the deployment mode. Row was NOT mutated.",
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

  // PAY-CCY-01. Before ANY branch below, including the idempotent charge-id
  // stamp: a PaymentIntent about different money must not lend this row its
  // charge id either.
  if (
    !(await verifyProviderMoneyAgainstRow({
      attempt,
      provider: { amount: pi.amount, currency: pi.currency },
      stripeEventId: event.id,
      targetEvent: "payment_intent.succeeded",
      stripePaymentIntentId: pi.id,
    }))
  ) {
    return {
      eventType: event.type,
      attemptId: attempt.id,
      moneyMismatch: true,
    };
  }

  // PAY-SETTLE / 0187. THE TERMINAL SHORTCUT USED TO LIVE HERE, AND IT HID THE
  // ANSWER.
  //
  // A locally terminal row (failed / cancelled / blocked) returned straight
  // out with a generic "row is in a terminal local state" alert, before the
  // locked command was ever called. But the MOST LIKELY way this row becomes
  // terminal is a settlement retiring it — the settlement usually commits well
  // before the webhook arrives — so the common case reported the least useful
  // thing: "terminal", when the truth was "Stripe took money for a visit the
  // studio recorded as paid in cash, and somebody has to refund it or supersede
  // the record".
  //
  // The status branches now live INSIDE the command, after its settlement
  // conflict check and under the shared lock, which is the only place that can
  // tell those two apart. Terminal rows still reach the same critical alert and
  // the same return shape; they simply get there by a route that can recognise
  // the conflict first.

  // ready / pending_stripe: reconcile to succeeded. Conditional
  // UPDATE on status='ready' OR 'pending_stripe' so a concurrent
  // action-layer write that already moved the row to succeeded is
  // not double-stamped.

  // PAY-SETTLE / 0187. THE WRITE MOVED INTO THE DATABASE, UNDER THE SHARED
  // APPOINTMENT ADVISORY KEY.
  //
  // This used to be a direct conditional UPDATE with no lock, and it was the
  // one writer that could turn a RETIRABLE state (`ready`) into money while a
  // settlement was deciding. Two orderings, both bad: a settlement could pass
  // its card-money check on the still-`ready` row, this could commit
  // `succeeded`, and the settlement would insert anyway — a card charge and an
  // external settlement on the same visit. Or the settlement retired the row
  // first and a real Stripe success survived only as an ops alert.
  //
  // The command takes the same key the settlement commands and the claim
  // command take, so all three now serialize. Nothing about which transitions
  // are legal changed: it is still ready/pending_stripe -> succeeded only, and
  // still conditional, so a concurrent action-layer write is not double-stamped.
  const { data: rpcRows, error: rpcErr } = await reconcileBoundEvent(event, ctx, attempt);
  if (rpcErr) {
    throw new Error(
      `payment_intent_succeeded_update_failed:${rpcErr.code}:${rpcErr.message}`,
    );
  }
  const outcome = (Array.isArray(rpcRows) ? rpcRows[0] : rpcRows) as
    | { result?: string; status_before?: string | null }
    | null;
  const reconcileResult = outcome?.result ?? null;
  if (!["reconciled", "already_succeeded", "zero_rows", "not_found", "terminal_mismatch", "settled_externally_conflict"].includes(reconcileResult ?? "")) {
    // A refusal or malformed command response is never a successful write and
    // must not dispatch a receipt, even if the earlier application read matched.
    return { eventType: event.type, attemptId: attempt.id, commandRefused: true };
  }

  // The status the command read UNDER THE LOCK. Preferred over the pre-lock
  // read wherever it is reported, because the pre-lock one can be stale by
  // exactly the race this command exists to serialize.
  const statusBefore = outcome?.status_before ?? null;

  // STRIPE SAYS MONEY MOVED AND THE STUDIO SAYS THE VISIT WAS SETTLED IN CASH.
  //
  // Both cannot be collected, and neither fact may be quietly discarded. The
  // command refused to flip the row, so no double collection exists in the
  // data; what exists is a contradiction that a person has to resolve — refund
  // the card, or supersede the settlement. That is not a decision a webhook
  // handler is entitled to make, so it is raised at CRITICAL and left alone.
  if (reconcileResult === "settled_externally_conflict") {
    await recordOpsAlert({
      severity: "critical",
      event: "payment_intent_succeeded_settled_externally_conflict",
      message:
        "Stripe reports payment_intent.succeeded for an appointment that already has a recorded non-card settlement (paid cash / e-transfer / another way / waived). The local attempt was NOT flipped to succeeded. Resolve by refunding the card charge or superseding the settlement record.",
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
      settledExternallyConflict: true,
    };
  }

  // Carried unchanged: a locally terminal row is never flipped. The command
  // re-checks this under the lock, so the earlier read cannot go stale.
  // Genuinely terminal for reasons that have nothing to do with a settlement —
  // a failed charge, an operator cancellation, a blocked row. Same alert, same
  // event name and same return shape as before this moved; the status reported
  // is the one the command read UNDER THE LOCK (`status_before`), which cannot
  // be stale the way the pre-read could.
  if (reconcileResult === "terminal_mismatch") {
    const terminalStatus = statusBefore ?? attempt.status;
    await recordOpsAlert({
      severity: "critical",
      event: "payment_intent_succeeded_local_terminal_mismatch",
      message:
        `Stripe says payment_intent.succeeded but Hone payment_charge_attempts row is in terminal local state '${terminalStatus}'. Row was NOT flipped to 'succeeded'.`,
      studioId: attempt.studio_id,
      clientId: attempt.client_id,
      stripeEventId: event.id,
      stripePaymentIntentId: pi.id,
      route: ROUTE,
      safeDetails: {
        attempt_id: attempt.id,
        local_status: terminalStatus,
        resolution_via: resolution.via,
      },
    });
    return {
      eventType: event.type,
      attemptId: attempt.id,
      localTerminalMismatch: terminalStatus,
    };
  }

  // PAY-SETTLE / 0187 — P2. ANOTHER LEGITIMATE WRITER WON THE ROW.
  //
  // The row was ready/pending_stripe at the read above, and the action-layer
  // success writer committed before this command took the lock. THIS WEBHOOK
  // CHANGED NOTHING, so it must not claim it did: falling through to the
  // success return below would report `reconciledFromStatus` for a
  // reconciliation that never happened, which is precisely the
  // no-false-reconciliation contract this handler has always kept (before the
  // command existed, the same race produced the zero-row warning).
  //
  // Reported as the ordinary idempotent outcome, the same shape the
  // already-succeeded-at-read-time branch returns, because it is the same fact
  // observed a moment later.
  if (reconcileResult === "already_succeeded") {
    return {
      eventType: event.type,
      attemptId: attempt.id,
      alreadySucceeded: true,
      resolutionVia: resolution.via,
    };
  }

  // PR #263: zero-row detection. The status-conditional UPDATE matched
  // no row: the attempt left ready/pending_stripe between the read
  // above and this write (a concurrent action-layer or webhook write).
  // Do NOT report a reconciliation that did not happen.
  if (reconcileResult === "zero_rows" || reconcileResult === "not_found") {
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

  // Reached only on `reconciled`: the command actually moved the row.
  return {
    eventType: event.type,
    attemptId: attempt.id,
    reconciledFromStatus: statusBefore ?? attempt.status,
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
    ctx,
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

  if (!(await verifyPaymentEventIdentity({
    attempt, event, ctx, metadata,
    paymentIntentId: pi.id,
    chargeId: typeof pi.latest_charge === "string" ? pi.latest_charge : pi.latest_charge?.id ?? null,
    customerId: typeof pi.customer === "string" ? pi.customer : pi.customer?.id ?? null,
    requireCharge: false,
  }))) {
    return { eventType: event.type, attemptId: attempt.id, identityMismatch: true };
  }

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

  // Resolved-row mode guard (mirrors payment_intent.succeeded + charge.refunded).
  // The event-mode guard above only checks event.livemode; the resolver + the
  // metadata guard historically did not check the row's mode. The bound identity
  // guard now does too; retain this independent mode refusal. Post-0105 a session
  // can hold both a test and a live attempt with the same studio/client/reason,
  // so a mode-matching failed event could resolve the OTHER mode's row: refuse
  // to mutate it and alert, exactly as the two other mutating handlers do.
  if (attempt.stripe_livemode !== inferStripeLivemode()) {
    await recordOpsAlert({
      severity: "critical",
      event: "payment_intent_failed_livemode_row_mismatch",
      message:
        "Stripe payment_intent.payment_failed resolved to a row whose stripe_livemode does not match the deployment mode. Row was NOT mutated.",
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

  // PAY-CCY-01. A failure report about different money is not this attempt's
  // failure. Flipping the row to `failed` on its word would retire a prepared
  // charge whose own PaymentIntent may still succeed.
  if (
    !(await verifyProviderMoneyAgainstRow({
      attempt,
      provider: { amount: pi.amount, currency: pi.currency },
      stripeEventId: event.id,
      targetEvent: "payment_intent.payment_failed",
      stripePaymentIntentId: pi.id,
    }))
  ) {
    return {
      eventType: event.type,
      attemptId: attempt.id,
      moneyMismatch: true,
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

  // A verified card decline may finish this ATTEMPT with an intent awaiting
  // a new payment method; it is not autonomous completion of an existing
  // payment. PR320 separately keeps requires_action/in-progress/unknown
  // outcomes unresolved. This observer never confirms or cancels the provider.
  const knownOriginalIntent = typeof attempt.stripe_payment_intent_id === "string" &&
    attempt.stripe_payment_intent_id.length > 0 && attempt.stripe_payment_intent_id === pi.id;
  const observedCardDecline = pi.status === "requires_payment_method" &&
    pi.last_payment_error?.type === "card_error";
  if (!knownOriginalIntent || (pi.status !== "canceled" && !observedCardDecline)) {
    await recordOpsAlert({
      severity: "critical",
      event: "session_payment_needs_manual_review",
      message:
        "Stripe reported an active or unresolved original intent rather than a verified card decline or cancellation. Hone retained the original payment claim; no terminal failure was recorded. Manual reconciliation required.",
      studioId: attempt.studio_id,
      clientId: attempt.client_id,
      stripeEventId: event.id,
      stripePaymentIntentId: pi.id,
      route: ROUTE,
      safeDetails: {
        attempt_id: attempt.id,
        reason: "payment_intent_failed_unverified_or_unresolved",
      },
    });
    return {
      eventType: event.type,
      attemptId: attempt.id,
      providerOutcomeUnresolved: true,
    };
  }

  // ready / pending_stripe: reconcile to failed.
  const { data: commandRows, error: updateErr } = await reconcileBoundEvent(event, ctx, attempt);
  const commandResult = (Array.isArray(commandRows) ? commandRows[0] : commandRows)?.result;
  const updatedRows = commandResult === "reconciled" ? [{ id: attempt.id }] : [];

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
    ctx,
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

  if (!(await verifyPaymentEventIdentity({
    attempt, event, ctx, metadata,
    paymentIntentId: typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id ?? null,
    chargeId: charge.id,
    customerId: typeof charge.customer === "string" ? charge.customer : charge.customer?.id ?? null,
    requireCharge: true,
  }))) {
    return { eventType: event.type, attemptId: attempt.id, identityMismatch: true };
  }

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

  if (attempt.stripe_livemode !== inferStripeLivemode()) {
    await recordOpsAlert({
      severity: "critical",
      event: "charge_refunded_livemode_row_mismatch",
      message:
        "Stripe charge.refunded resolved to a row whose stripe_livemode does not match the deployment mode. Row was NOT mutated.",
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

  // PAY-CCY-01. The charge Stripe refunded must be the prepared charge: the
  // same captured amount, in the same currency. Checked before the partial /
  // full decision below, which compares Stripe's two numbers with each other
  // and so cannot see a charge that is wholly different money.
  if (
    !(await verifyProviderMoneyAgainstRow({
      attempt,
      provider: { amount: charge.amount, currency: charge.currency },
      stripeEventId: event.id,
      targetEvent: "charge.refunded",
      stripeChargeId: charge.id,
    }))
  ) {
    return {
      eventType: event.type,
      attemptId: attempt.id,
      moneyMismatch: true,
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

  const cumulative = isCumulativeChargeRefund(charge);
  if (cumulative && !cumulativeChargeRefundEvidence(event, ctx, attempt)) {
    await recordOpsAlert({ severity: "critical", event: "charge_refunded_cumulative_evidence_refused",
      message: "Charge-level full refund lacks complete, distinct, bound successful refund evidence. No payment row was mutated.",
      studioId: attempt.studio_id, clientId: attempt.client_id, stripeEventId: event.id, route: ROUTE,
      safeDetails: { attempt_id: attempt.id, reason: "incomplete_or_conflicting_cumulative_evidence" } });
    return { eventType: event.type, attemptId: attempt.id, cumulativeRefundEvidenceRefused: true };
  }

  // Resolve the Stripe refund id. Prefer the most recent refund
  // object on the charge (refunds.data is ordered newest-first by
  // Stripe in the standard payload).
  const latestRefund = charge.refunds?.data?.[0];
  const stripeRefundId = cumulative ? null : latestRefund?.id ?? null;

  if (attempt.refund_status === "pending_stripe") {
    // PR #178 helper claimed the row but the action either lost
    // the writeOk leg or the webhook beat the helper's UPDATE.
    // Either way: reconcile to succeeded.
    const { data: commandRows, error: updateErr } = await reconcileBoundEvent(event, ctx, attempt);
    const commandResult = (Array.isArray(commandRows) ? commandRows[0] : commandRows)?.result;
    const updatedRows = commandResult === "reconciled" ? [{ id: attempt.id }] : [];
    if (commandResult === "already_refunded") return { eventType: event.type, attemptId: attempt.id, alreadyRefunded: true };

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
  const refundAmountCents = attempt.amount_cents;
  const { data: commandRows, error: updateErr } = await reconcileBoundEvent(event, ctx, attempt);
  const commandResult = (Array.isArray(commandRows) ? commandRows[0] : commandRows)?.result;
  const updatedRows = commandResult === "reconciled" ? [{ id: attempt.id }] : [];
  if (commandResult === "already_refunded") return { eventType: event.type, attemptId: attempt.id, alreadyRefunded: true };

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

// Standalone Refund status events are authoritative only through their signed
// account/mode AND original charge/PI pair. No extra provider read is necessary.
export async function handleRefundStatusEvent(event: Stripe.Event, ctx: WebhookCtx): Promise<Record<string, unknown>> {
  if (await shouldIgnoreLiveModeEvent(event, ctx, event.type)) return { eventType: event.type, livemodeEventIgnored: true };
  const refund = event.data.object as Stripe.Refund;
  const id = (value: string | { id: string } | null | undefined) => typeof value === "string" ? value : value?.id ?? null;
  const metadata = refund.metadata ?? {};
  const resolution = await resolveAttemptByMetadataOrId({ ctx, metadata,
    fallbackByPaymentIntentId: id(refund.payment_intent), fallbackByChargeId: id(refund.charge) });
  if (!resolution.ok) {
    if (resolution.reason === "database_error") throw new Error("refund_status_lookup_failed");
    return { eventType: event.type, noMatch: true };
  }
  const attempt = resolution.attempt;
  // Some provider API versions include customer on Refund. If present it must
  // agree too; otherwise the signed original PI/charge pair binds the stored
  // customer without inventing a new observation or doing a provider lookup.
  const refundCustomer = "customer" in refund ? refund.customer : undefined;
  const observedCustomer = refundCustomer === undefined ? attempt.stripe_customer_id
    : typeof refundCustomer === "string" ? refundCustomer
      : refundCustomer && typeof refundCustomer === "object" && "id" in refundCustomer && typeof refundCustomer.id === "string" ? refundCustomer.id : null;
  if (!(await verifyPaymentEventIdentity({ attempt, event, ctx, metadata,
    paymentIntentId: id(refund.payment_intent), chargeId: id(refund.charge),
    customerId: observedCustomer, requireCharge: true }))) {
    return { eventType: event.type, attemptId: attempt.id, identityMismatch: true };
  }
  if (!(await verifyMetadataAgainstRow({ attempt, metadata, stripeEventId: event.id, targetEvent: event.type }))) {
    return { eventType: event.type, attemptId: attempt.id, metadataMismatch: true };
  }
  if (!(await verifyProviderMoneyAgainstRow({ attempt, provider: { amount: refund.amount, currency: refund.currency },
    stripeEventId: event.id, targetEvent: event.type }))) {
    return { eventType: event.type, attemptId: attempt.id, moneyMismatch: true };
  }
  const { data, error } = await reconcileBoundEvent(event, ctx, attempt);
  if (error) throw new Error("refund_status_update_failed");
  const result = (Array.isArray(data) ? data[0] : data)?.result;
  return { eventType: event.type, attemptId: attempt.id, refundObservationResult: result ?? "unknown" };
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
