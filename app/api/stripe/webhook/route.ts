// Stripe webhook endpoint (Phase 1 + card-on-file Phase 1 + PR #179
// payment_charge_attempts reconciliation, test mode only).
//
// Allowed mutations:
//   - account.updated, capability.updated -> sync_studio_account_status
//   - setup_intent.succeeded               -> client_payment_methods INSERT
//     (PR #135; portal card-on-file)
//   - PR #179 (test mode only):
//       payment_intent.succeeded         -> reconcile to status='succeeded'
//                                            with PI id + Charge id + charged_at,
//                                            from {ready, pending_stripe} only.
//                                            Critical ops_alert on terminal-state
//                                            mismatch.
//       payment_intent.payment_failed    -> reconcile to status='failed' from
//                                            {ready, pending_stripe}. Critical
//                                            ops_alert if local already
//                                            succeeded.
//       charge.refunded                  -> reconcile FULL refunds to
//                                            refund_status='succeeded'. Partial
//                                            refunds: critical ops_alert + no
//                                            mutation. Out-of-band full
//                                            refunds: warning ops_alert.
//       charge.dispute.created           -> critical ops_alert ONLY (no
//                                            mutation; no automated dispute
//                                            response).
//
// Note on setup_intent.setup_failed: claimed + recorded with a small
// summary so the audit chain is complete, but no row is written.
// The client portal Elements form surfaces the Stripe error to the
// visitor directly.
//
// Forbidden mutations even with PR #179 (these events are claimed for
// idempotency and marked processed with a payload_summary, but they
// do NOT trigger any business-logic state change):
//   - charge.* OTHER THAN refunded / dispute.created
//   - refund.* (the refund row state mirrors charge.refunded)
//   - charge.dispute.* OTHER THAN created
//   - customer.*
//   - setup_intent.* OTHER THAN succeeded / setup_failed
//
// PR #179 reconciliation discipline:
//   * NO new Stripe API call. The handlers read the event payload
//     and write to payment_charge_attempts + ops_alerts only.
//   * event.livemode === true is the hard dormancy guard. A live
//     event is ignored + warning ops_alert + no row mutation.
//   * row.stripe_livemode must be false. The DB CHECK is the
//     structural backstop; the handler also checks defensively.
//   * Metadata mismatch (studio_id, client_id, charge_reason)
//     against the resolved row: critical ops_alert + no mutation.
//   * State transitions are conditional UPDATEs. A row in a
//     terminal local state is NEVER silently flipped; mismatch
//     fires a critical ops_alert and the row is left alone.
//   * Handlers are reason-agnostic. They read row.charge_reason
//     and never branch on the value.
//
// Webhook discipline:
//   * Raw body via await req.text(). NEVER req.json() before
//     constructEvent, Stripe's signature verification requires the
//     exact byte string sent.
//   * 400 with generic "Invalid signature" on any verification
//     failure. Stripe error message is logged internally, not
//     surfaced.
//   * Idempotent claim via public.claim_stripe_event(...). Concurrent
//     deliveries land on the same partial unique
//     (account_id, livemode, event_id); the loser sees
//     already_processed=true or currently_processing_elsewhere=true.
//   * No full webhook payload is logged. Only event id, event type,
//     and a small structured payload_summary (account id +
//     charges_enabled, etc.) is persisted on the stripe_events row.
//   * No raw bank/account/PII details are logged.

import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { getStripe } from "@/lib/stripe/server";
import { accountToStatusSnapshot } from "@/lib/stripe/account";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { recordOpsAlert } from "@/lib/ops/alerts";
import { captureServerEvent } from "@/lib/analytics/server";
import {
  handlePaymentIntentSucceeded,
  handlePaymentIntentPaymentFailed,
  handleChargeRefunded,
  handleChargeDisputeCreated,
  shouldIgnoreLiveModeEvent,
} from "@/lib/billing/payment-webhook-reconciliation";
import { ensureCardChangeNotification } from "@/lib/billing/card-change-notification";

// Force Node runtime: Stripe SDK + raw body buffering need Node, not
// the Edge runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const GENERIC_BAD_SIGNATURE = "Invalid signature.";

function logInternal(event: string, detail: unknown) {
  try {
    console.error(
      JSON.stringify({ event, detail, timestamp: new Date().toISOString() }),
    );
  } catch {
    console.error(event, detail);
  }
}

function getWebhookSecretOrFail(): string {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    throw new Error("STRIPE_WEBHOOK_SECRET is not set");
  }
  return secret;
}

export async function POST(req: Request): Promise<Response> {
  // 1. Raw body. MUST be the exact bytes Stripe sent so the HMAC
  //    signature check succeeds.
  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch (err) {
    logInternal("stripe_webhook_body_read_failed", {
      err: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: GENERIC_BAD_SIGNATURE }, { status: 400 });
  }

  // 2. Signature header. Stripe-Signature is the canonical header
  //    name; Next normalizes to lower-case so we use that.
  const signature = req.headers.get("stripe-signature");
  if (!signature) {
    logInternal("stripe_webhook_missing_signature_header", {});
    return NextResponse.json({ error: GENERIC_BAD_SIGNATURE }, { status: 400 });
  }

  // 3. constructEvent. Stripe's library verifies the HMAC, the
  //    timestamp tolerance, and parses the JSON. Failure throws.
  let event: Stripe.Event;
  try {
    const stripe = getStripe();
    const webhookSecret = getWebhookSecretOrFail();
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (err) {
    logInternal("stripe_webhook_signature_verification_failed", {
      // Do NOT serialize the raw err.message (Stripe sometimes
      // includes parts of the body). Just record the error class.
      type:
        typeof err === "object" && err !== null && "type" in err
          ? (err as Record<string, unknown>).type
          : "unknown",
    });
    return NextResponse.json({ error: GENERIC_BAD_SIGNATURE }, { status: 400 });
  }

  // 4. Resolve account context. Stripe Connect webhooks include the
  //    connected `account` field on the event envelope. Some events
  //    arrive at the platform level with no account set: we still
  //    claim those but cannot sync per-studio status.
  const stripeAccountId = event.account ?? null;
  const livemode = event.livemode === true;

  // Look up the studio that owns this connected account, if any.
  let studioId: string | null = null;
  if (stripeAccountId) {
    const admin = createAdminClient();
    const { data } = await admin
      .from("studio_payment_settings")
      .select("studio_id")
      .eq("stripe_account_id", stripeAccountId)
      .eq("stripe_livemode", livemode)
      .maybeSingle();
    studioId = data?.studio_id ?? null;
  }

  // 5. Claim the event idempotently. The RPC enforces a partial
  //    unique on (account_id, livemode, event_id). A concurrent
  //    duplicate delivery sees `already_processed=true` and we ack
  //    with 200 to stop Stripe retrying.
  const admin = createAdminClient();
  const { data: claimRows, error: claimErr } = await admin.rpc(
    "claim_stripe_event",
    {
      p_event_id: event.id,
      p_event_type: event.type,
      p_stripe_account_id: stripeAccountId ?? "",
      p_stripe_livemode: livemode,
      p_studio_id: studioId,
    },
  );
  if (claimErr) {
    logInternal("stripe_webhook_claim_failed", {
      eventId: event.id,
      eventType: event.type,
      code: claimErr.code,
      message: claimErr.message,
    });
    // Return 500 so Stripe retries. The event is not yet recorded;
    // the next delivery will re-attempt.
    return NextResponse.json({ ok: false }, { status: 500 });
  }
  const claim = Array.isArray(claimRows) ? claimRows[0] : claimRows;
  if (!claim) {
    logInternal("stripe_webhook_claim_empty", { eventId: event.id });
    return NextResponse.json({ ok: false }, { status: 500 });
  }
  if (claim.already_processed) {
    return NextResponse.json({ ok: true, alreadyProcessed: true });
  }
  if (claim.currently_processing_elsewhere) {
    // Another worker is mid-process. Tell Stripe we're alive but not
    // done: they'll re-deliver shortly.
    return NextResponse.json({ ok: false, retry: true }, { status: 409 });
  }
  if (!claim.claimed_by_this_request || !claim.claim_token) {
    logInternal("stripe_webhook_claim_unexpected_shape", {
      eventId: event.id,
      claim,
    });
    return NextResponse.json({ ok: false }, { status: 500 });
  }
  const claimToken = claim.claim_token as string;

  // 6. Dispatch by event type. Phase 1 mutation surface is strictly
  //    account.updated and capability.updated; everything else is
  //    recorded for the audit trail without side effects.
  try {
    const payloadSummary = await handleStripeEvent(event, {
      studioId,
      stripeAccountId,
      livemode,
    });

    const { error: markErr } = await admin.rpc("mark_stripe_event_processed", {
      p_event_id: event.id,
      p_claim_token: claimToken,
      p_payload_summary: payloadSummary,
    });
    if (markErr) {
      logInternal("stripe_webhook_mark_processed_failed", {
        eventId: event.id,
        code: markErr.code,
        message: markErr.message,
      });
      return NextResponse.json({ ok: false }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    logInternal("stripe_webhook_handler_failed", {
      eventId: event.id,
      eventType: event.type,
      err: err instanceof Error ? err.message : String(err),
    });
    // PR #153. Persistent webhook processing failure is a critical
    // ops alert. For setup_intent.succeeded specifically, the
    // failure means the client may believe their card was saved
    // while Hone has no record; surface as a more specific event so
    // the operator's runbook can branch.
    await recordOpsAlert({
      severity: "critical",
      event:
        event.type === "setup_intent.succeeded"
          ? "card_on_file_setup_failed"
          : "stripe_webhook_processing_failed",
      message: err instanceof Error ? err.message : String(err),
      studioId,
      stripeEventId: event.id,
      route: "app/api/stripe/webhook",
      safeDetails: {
        event_type: event.type,
        stripe_account_id: stripeAccountId,
        livemode,
        handler: event.type,
      },
    });
    try {
      const { error: releaseErr } = await admin.rpc(
        "release_stripe_event_claim_with_error",
        {
          p_event_id: event.id,
          p_claim_token: claimToken,
          p_error: err instanceof Error ? err.message : "handler_failed",
        },
      );
      if (releaseErr) {
        logInternal("stripe_webhook_release_claim_failed", { releaseErr });
      }
    } catch (releaseErr) {
      logInternal("stripe_webhook_release_claim_threw", { releaseErr });
    }
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// handleStripeEvent
// ---------------------------------------------------------------------------
// Returns a small JSON summary that's safe to persist on
// stripe_events.payload_summary. NO PII, NO secrets, NO raw payload.
// ---------------------------------------------------------------------------
async function handleStripeEvent(
  event: Stripe.Event,
  ctx: { studioId: string | null; stripeAccountId: string | null; livemode: boolean },
): Promise<Record<string, unknown>> {
  switch (event.type) {
    case "account.updated":
    case "capability.updated": {
      // Allowed Phase 1 mutation: sync the connected-account status
      // onto studio_payment_settings.
      if (!ctx.studioId || !ctx.stripeAccountId) {
        // No local binding: record but don't sync.
        return {
          eventType: event.type,
          unboundAccount: true,
        };
      }
      const accountObject = await resolveAccountFromEvent(event, ctx.stripeAccountId);
      if (!accountObject) {
        return { eventType: event.type, accountResolutionFailed: true };
      }
      const snapshot = accountToStatusSnapshot(accountObject);

      const admin = createAdminClient();
      // Preserve-first-completion semantics (see equivalent block in
      // lib/stripe/account.ts#refreshAccountStatusFromStripe). The
      // sync_studio_account_status RPC uses
      //   coalesce(p_onboarding_completed_at, sps.stripe_onboarding_completed_at)
      // so a non-null value overwrites. Sending null on subsequent
      // webhooks preserves the original first-completion timestamp.
      // Mode-scoped (0103): a studio can hold one settings row per Stripe
      // mode; preserve-first-completion must read the row for THIS event's
      // mode only (never the other mode's timestamp).
      const { data: existingSettings } = await admin
        .from("studio_payment_settings")
        .select("stripe_onboarding_completed_at")
        .eq("studio_id", ctx.studioId)
        .eq("stripe_livemode", ctx.livemode)
        .maybeSingle();
      const onboardingCompletedAtForRpc =
        existingSettings?.stripe_onboarding_completed_at != null
          ? null
          : snapshot.onboardingCompletedAt;

      const { error: syncErr } = await admin.rpc("sync_studio_account_status", {
        p_studio_id: ctx.studioId,
        p_stripe_account_id: ctx.stripeAccountId,
        p_stripe_livemode: ctx.livemode,
        p_status: snapshot.status,
        p_charges_enabled: snapshot.chargesEnabled,
        p_payouts_enabled: snapshot.payoutsEnabled,
        p_onboarding_completed_at: onboardingCompletedAtForRpc,
      });
      if (syncErr) {
        throw new Error(
          `sync_studio_account_status failed: ${syncErr.message}`,
        );
      }

      if (snapshot.chargesEnabled) {
        // Post-response, bounded: analytics failure must never 500 this
        // webhook and trigger Stripe retries (P1/P2-ANALYTICS-03).
        captureServerEvent({
          actor: { kind: "studio", id: ctx.studioId },
          event: "stripe_account_connected",
          properties: { studio_id: ctx.studioId, livemode: ctx.livemode },
        });
      }

      return {
        eventType: event.type,
        status: snapshot.status,
        chargesEnabled: snapshot.chargesEnabled,
        payoutsEnabled: snapshot.payoutsEnabled,
        requirementsCurrentlyDueCount: snapshot.requirementsCurrentlyDue.length,
        requirementsEventuallyDueCount: snapshot.requirementsEventuallyDue.length,
      };
    }

    case "setup_intent.succeeded": {
      // PR #135. Card-on-file: insert / replace
      // client_payment_methods row. Every value flows from
      // server-side Stripe data via paymentMethods.retrieve; the
      // browser-supplied card metadata is never trusted.
      return await handleSetupIntentSucceeded(event, ctx);
    }

    case "setup_intent.setup_failed": {
      // Surface a small summary for audit; no DB write. The portal
      // Elements form already told the visitor what to do.
      const si = event.data.object as Stripe.SetupIntent;
      return {
        eventType: event.type,
        setupIntentId: si.id,
        // last_setup_error is a Stripe-defined shape that may
        // contain a sanitized 'code' and 'message'; we record only
        // the code to keep the summary PII-free.
        lastSetupErrorCode: si.last_setup_error?.code ?? null,
      };
    }

    // PR #179. Test-mode reconciliation for payment_charge_attempts.
    // Each handler is responsible for: (1) the live-mode dormancy
    // guard (no row mutation when event.livemode=true), (2) atomic
    // status-conditional UPDATE so a concurrent action-layer write
    // is never silently overwritten, (3) critical ops_alerts on any
    // local-vs-Stripe state mismatch (terminal-local-state vs
    // succeeded-stripe, succeeded-local vs failed-stripe, partial-
    // out-of-band refunds), (4) warning ops_alerts on softer cases
    // (no-match, live-mode ignored, out-of-band full refund
    // reconciled). NONE of these handlers create a PaymentIntent,
    // Charge, Refund, SetupIntent, Checkout session, SMS, email, or
    // touch manual_fee_charge_attempts. The webhook is a one-way
    // mirror: Stripe says X, Hone reflects X if safe; otherwise
    // Hone alerts and leaves the row alone.
    case "payment_intent.succeeded": {
      return await handlePaymentIntentSucceeded(event, ctx);
    }
    case "payment_intent.payment_failed": {
      return await handlePaymentIntentPaymentFailed(event, ctx);
    }
    case "charge.refunded": {
      return await handleChargeRefunded(event, ctx);
    }
    case "charge.dispute.created": {
      return await handleChargeDisputeCreated(event, ctx);
    }

    // Phase 1 + PR #179: every other event class is recorded without
    // side effects. No appointment state changes, no other payment
    // intent / charge / refund / dispute / customer / other-setup_
    // intent handling. The summary records the type so the audit
    // trail is complete; no body is logged.
    default:
      return {
        eventType: event.type,
        ignoredInPhase1: true,
      };
  }
}

// ---------------------------------------------------------------------------
// terminalCardRejection
// ---------------------------------------------------------------------------
// A payload Stripe legitimately delivered that Hone's domain cannot admit,
// forged/absent metadata, lineage that does not resolve, a non-card payment
// method. Retrying cannot fix any of these, so the event is marked processed
// rather than left to storm.
//
// But it must NEVER masquerade as success. Previously these branches returned
// a bare `rejected` summary; the parent then called mark_stripe_event_processed
// and the delivery ended as a 200 with NO alert at all, while the client had
// already been told "Card saved" and Hone held no card row.
//
// Operator-visible evidence, stated precisely:
//   * recordOpsAlert ALWAYS emits a structured stderr log with the event name
//     and safe identifiers: that is its documented floor, emitted even when
//     the DB insert fails;
//   * it also attempts a durable public.ops_alerts row. That insert is
//     best-effort by design ("No retry. A failure to insert is logged and
//     dropped.", lib/ops/alerts.ts), so it is NOT claimed here as guaranteed;
//   * the returned summary is persisted on stripe_events.payload_summary with
//     terminalRejection: true, which IS durable: the parent commits it via
//     mark_stripe_event_processed.
// So a terminal rejection always leaves at least two independent traces and can
// never be mistaken for a saved card.
// ---------------------------------------------------------------------------
async function terminalCardRejection(
  event: Stripe.Event,
  ctx: { studioId: string | null; stripeAccountId: string | null; livemode: boolean },
  si: Stripe.SetupIntent,
  reason: string,
): Promise<Record<string, unknown>> {
  const setupIntentId = si.id;
  // THE OWNERSHIP ANCHOR. The portal must be able to prove a rejection belongs
  // to the asking client WITHOUT trusting the SetupIntent's metadata: metadata
  // is caller-supplied and Stripe signing the envelope says nothing about who
  // authored it. (stripe_account_id, stripe_livemode, stripe_customer_id) is
  // UNIQUE in client_stripe_customers, so the customer resolves to exactly one
  // Hone (studio, client) through Hone's own provisioning table.
  //
  // Recorded even on branches where the customer did not validate: the portal
  // re-derives ownership itself and fails closed when it cannot.
  const stripeCustomerId =
    typeof si.customer === "string" && si.customer.length > 0 ? si.customer : null;
  await recordOpsAlert({
    severity: "critical",
    event: "card_on_file_setup_rejected",
    message: `setup_intent.succeeded terminally rejected: ${reason}`,
    studioId: ctx.studioId,
    stripeEventId: event.id,
    route: "app/api/stripe/webhook",
    safeDetails: {
      event_type: event.type,
      reason,
      setup_intent_id: setupIntentId,
      stripe_customer_id: stripeCustomerId,
      stripe_account_id: ctx.stripeAccountId,
      livemode: ctx.livemode,
    },
  });
  return {
    eventType: event.type,
    setupIntentId,
    // Ownership anchor for the portal's client-binding check. Null when the
    // event carried no usable customer: those rejections are deliberately not
    // portal-attributable and settle as "not confirmed" instead.
    stripeCustomerId,
    stripeAccountId: ctx.stripeAccountId,
    stripeLivemode: ctx.livemode,
    rejected: reason,
    // THE DURABLE FACT. The parent commits this summary onto
    // stripe_events.payload_summary via mark_stripe_event_processed, and the
    // portal reads terminalRejection from there.
    terminalRejection: true,
    // Named for what is actually guaranteed. recordOpsAlert always emits its
    // structured log, but its ops_alerts row insert is best-effort, so this
    // must not be called `opsAlerted`, that would imply a durable row exists.
    opsAlertAttempted: true,
  };
}

// PR #135. setup_intent.succeeded arm. Validates the metadata +
// every lineage dimension before writing client_payment_methods.
// Throws on validation failure so the parent handler releases the
// stripe_events claim with the error; Stripe retries the delivery,
// and the next attempt either succeeds against fresh server state
// or surfaces the same validation error for an operator to fix.
//
// Returns the sanitized payload_summary the parent persists on
// stripe_events. NEVER includes raw card data, PaymentMethod object,
// SetupIntent client_secret, or any PII.
async function handleSetupIntentSucceeded(
  event: Stripe.Event,
  ctx: { studioId: string | null; stripeAccountId: string | null; livemode: boolean },
): Promise<Record<string, unknown>> {
  const si = event.data.object as Stripe.SetupIntent;

  // 0. PR #319: live-mode dormancy guard. setup_intent.succeeded is the ONLY
  //    card-WRITE webhook path; while live mode is structurally disabled, a
  //    live-mode event must NOT insert/update client_payment_methods. Apply the
  //    same guard the four money handlers use: it records a warning ops alert
  //    (stripe_webhook_livemode_event_ignored) and we return a sanitized
  //    summary WITHOUT throwing, so the event is marked processed (idempotent,
  //    no retry storm). Test-mode events (livemode false) fall through
  //    unchanged. This writes nothing and calls no Stripe API.
  if (await shouldIgnoreLiveModeEvent(event, ctx, "setup_intent.succeeded")) {
    return {
      eventType: event.type,
      setupIntentId: si.id,
      livemodeEventIgnored: true,
    };
  }

  // 1. Metadata must carry the Hone identity tuple. We do NOT
  //    accept the SetupIntent if any field is missing.
  const meta = (si.metadata ?? {}) as Record<string, string>;
  const metaStudioId = meta.hone_studio_id;
  const metaClientId = meta.hone_client_id;
  const metaSignatureId = meta.hone_card_authorization_signature_id;
  if (!metaStudioId || !metaClientId || !metaSignatureId) {
    return await terminalCardRejection(event, ctx, si, "missing_metadata");
  }

  // 2. Connected-account context must agree with the event's
  //    account + the studio's payment settings.
  if (!ctx.stripeAccountId || !ctx.studioId) {
    return await terminalCardRejection(event, ctx, si, "missing_account_context");
  }
  if (ctx.studioId !== metaStudioId) {
    return await terminalCardRejection(event, ctx, si, "studio_metadata_mismatch");
  }

  const admin = createAdminClient();

  // 3. Validate the customer lineage against client_stripe_customers.
  //    A forged metadata.hone_studio_id / hone_client_id would not
  //    match the (studio, client, account, mode, customer) tuple
  //    here and is rejected.
  if (typeof si.customer !== "string" || si.customer.length === 0) {
    return await terminalCardRejection(event, ctx, si, "missing_customer");
  }
  const { data: customerLineage, error: customerLineageErr } = await admin
    .from("client_stripe_customers")
    .select("client_id, studio_id, stripe_account_id, stripe_livemode")
    .eq("studio_id", metaStudioId)
    .eq("client_id", metaClientId)
    .eq("stripe_account_id", ctx.stripeAccountId)
    .eq("stripe_livemode", ctx.livemode)
    .eq("stripe_customer_id", si.customer)
    .maybeSingle();
  if (customerLineageErr) {
    throw new Error(
      `customer_lineage_lookup_failed:${customerLineageErr.code}:${customerLineageErr.message}`,
    );
  }
  if (!customerLineage) {
    return await terminalCardRejection(event, ctx, si, "customer_lineage_mismatch");
  }

  // 4. Validate the card_authorization signature belongs to the
  //    same (studio, client) pair. A forged signature id from
  //    another studio/client is rejected.
  const { data: signature, error: signatureErr } = await admin
    .from("client_consent_signatures")
    .select("id")
    .eq("id", metaSignatureId)
    .eq("studio_id", metaStudioId)
    .eq("client_id", metaClientId)
    .maybeSingle();
  if (signatureErr) {
    throw new Error(
      `signature_lookup_failed:${signatureErr.code}:${signatureErr.message}`,
    );
  }
  if (!signature) {
    return await terminalCardRejection(event, ctx, si, "signature_lineage_mismatch");
  }

  // 5. PR #135 hardening. Idempotency SELECT first: if a row already
  //    exists for the same (studio, client, account, mode,
  //    setup_intent_id), this is a duplicate Stripe re-delivery
  //    after the first delivery already inserted. Return
  //    idempotent success WITHOUT pre-flipping any active row.
  //    Without this check, a re-delivery would UPDATE the active
  //    row inserted by the FIRST delivery to status='removed' and
  //    then hit the unique constraint on the INSERT, leaving the
  //    (studio, client) with no active card.
  //
  //    The DB-side guarantee for this idempotency is the partial
  //    unique index client_payment_methods_setup_intent_account_mode_uniq
  //    added in migration 0059. The application check below short-
  //    circuits the happy path; the 23505 catch on the INSERT
  //    further down is a defensive backstop against any race we
  //    do not anticipate (claim_stripe_event already serialises
  //    deliveries of the same event id).
  {
    const { data: existing, error: existingErr } = await admin
      .from("client_payment_methods")
      .select("id")
      .eq("studio_id", metaStudioId)
      .eq("client_id", metaClientId)
      .eq("stripe_account_id", ctx.stripeAccountId)
      .eq("stripe_livemode", ctx.livemode)
      .eq("stripe_setup_intent_id", si.id)
      .maybeSingle();
    if (existingErr) {
      throw new Error(
        `idempotency_lookup_failed:${existingErr.code}:${existingErr.message}`,
      );
    }
    if (existing) {
      // The card is already persisted (a prior delivery of THIS event
      // inserted it). The notification may still be missing if that prior
      // delivery failed after the card insert; ensure it now (deduped on the
      // mode-scoped SetupIntent). This is awaited and throws on failure so the parent
      // releases the claim and Stripe retries WITHOUT touching the card row.
      const notif = await ensureCardChangeNotification(admin, {
        studioId: metaStudioId,
        clientId: metaClientId,
        livemode: ctx.livemode,
        setupIntentId: si.id,
      });
      return {
        eventType: event.type,
        setupIntentId: si.id,
        idempotent: true,
        existingClientPaymentMethodId: existing.id,
        cardChangeNotification: notif.eventType,
        cardChangeNotificationDeduped: notif.deduped,
      };
    }
  }

  // 6. Retrieve the PaymentMethod from Stripe on the connected
  //    account. This is the only authoritative source for brand /
  //    last4 / exp; browser-side Elements never sends that data to
  //    Hone.
  if (typeof si.payment_method !== "string" || si.payment_method.length === 0) {
    return await terminalCardRejection(event, ctx, si, "missing_payment_method");
  }
  const stripe = getStripe();
  let pm: Stripe.PaymentMethod;
  try {
    pm = await stripe.paymentMethods.retrieve(
      si.payment_method,
      undefined,
      { stripeAccount: ctx.stripeAccountId },
    );
  } catch (err) {
    throw new Error(
      `payment_method_retrieve_failed:${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const card = pm.card;
  if (!card || !card.brand || !card.last4 || !card.exp_month || !card.exp_year) {
    return await terminalCardRejection(event, ctx, si, "non_card_payment_method");
  }

  // 7. Persist the card ATOMICALLY via the 0180 governed command.
  //
  //    This used to be two independent PostgREST writes: an UPDATE that
  //    retired the existing active row, then a separate INSERT. PostgREST
  //    gives each request its own transaction, so any non-23505 failure of the
  //    INSERT left the client with ZERO ACTIVE CARDS after their working card
  //    had already been retired. The retire-before-insert ordering is forced by
  //    the partial unique index client_payment_methods_one_active_per_pair, so
  //    it cannot be reordered away; it has to commit as one transaction.
  //
  //    save_client_card_on_file re-validates the customer and signature lineage
  //    inside that transaction, takes an advisory lock per
  //    (studio, client, mode) so two concurrent replacements cannot interleave,
  //    and returns 'inserted' or 'idempotent'. Anything else raises, which we
  //    surface as a throw so the parent releases the claim and Stripe retries,
  //    with the previous card still active, because the retire rolled back too.
  const { data: saveRows, error: saveErr } = await admin.rpc(
    "save_client_card_on_file",
    {
      p_studio_id: metaStudioId,
      p_client_id: metaClientId,
      p_stripe_account_id: ctx.stripeAccountId,
      p_stripe_livemode: ctx.livemode,
      p_stripe_customer_id: si.customer,
      p_stripe_payment_method_id: pm.id,
      p_stripe_setup_intent_id: si.id,
      p_brand: card.brand,
      p_last4: card.last4,
      p_exp_month: card.exp_month,
      p_exp_year: card.exp_year,
      p_card_authorization_signature_id: metaSignatureId,
    },
  );
  if (saveErr) {
    // 22023 is the command's own lineage refusal. It is terminal: a retry
    // cannot make forged lineage resolve, but it is still operator-visible,
    // and no card row was written because the whole transaction rolled back.
    if (saveErr.code === "22023") {
      return await terminalCardRejection(
        event,
        ctx,
        si,
        `command_${saveErr.message.replace(/[^a-z_]/gi, "_").slice(0, 60)}`,
      );
    }
    throw new Error(
      `save_client_card_on_file_failed:${saveErr.code}:${saveErr.message}`,
    );
  }
  const saved = Array.isArray(saveRows) ? saveRows[0] : saveRows;
  if (!saved || typeof saved.card_id !== "string") {
    throw new Error("save_client_card_on_file_returned_no_row");
  }
  const inserted = { id: saved.card_id as string };
  const wasIdempotent = saved.outcome === "idempotent";

  // Post-response, bounded: analytics failure must never 500 this webhook
  // and trigger Stripe retries (P1/P2-ANALYTICS-03). Fired here (before the
  // notification) so the existing card_on_file_saved analytics event keeps
  // firing on every fresh insert regardless of the notification outcome.
  captureServerEvent({
    actor: { kind: "studio", id: metaStudioId },
    event: "card_on_file_saved",
    properties: { studio_id: metaStudioId, livemode: ctx.livemode },
  });

  // Studio-facing notification (Chloe's ask): card added / replaced. Awaited
  // and durable, if it throws, the parent handler releases the Stripe event
  // claim and Stripe retries; the saved card is NOT undone (the row stays,
  // and the retry's idempotency branch re-ensures the notification). Added vs
  // replaced is derived from persisted same-mode history, not the portal mode.
  const notif = await ensureCardChangeNotification(admin, {
    studioId: metaStudioId,
    clientId: metaClientId,
    livemode: ctx.livemode,
    setupIntentId: si.id,
  });

  return {
    eventType: event.type,
    setupIntentId: si.id,
    cardPaymentMethodId: pm.id,
    cardBrandPresent: true,
    insertedId: inserted?.id,
    idempotent: wasIdempotent,
    previousCardRetiredId: saved.previous_card_id ?? null,
    cardChangeNotification: notif.eventType,
    cardChangeNotificationDeduped: notif.deduped,
  };
}

async function resolveAccountFromEvent(
  event: Stripe.Event,
  stripeAccountId: string,
): Promise<Stripe.Account | null> {
  // For account.updated the event.data.object IS the Account. For
  // capability.updated it's a Capability whose `.account` field
  // names the parent account id; we retrieve the full Account.
  const obj = event.data.object as Stripe.Account | Stripe.Capability;
  if (event.type === "account.updated") {
    return obj as Stripe.Account;
  }
  // capability.updated: refresh via accounts.retrieve.
  try {
    const stripe = getStripe();
    return await stripe.accounts.retrieve(stripeAccountId);
  } catch (err) {
    logInternal("capability_updated_account_retrieve_failed", {
      stripeAccountId,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
