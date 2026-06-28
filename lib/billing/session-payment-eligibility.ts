import "server-only";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { inferStripeLivemode } from "@/lib/stripe/server";
import { getChargeReadyCardAuthorizationStatus } from "@/lib/consent/current-card-authorization";
import type {
  SessionPaymentCardAuthorizationSummary,
  SessionPaymentCardSummary,
  SessionPaymentClientSummary,
  SessionPaymentEligibility,
  SessionPaymentExistingAttemptSummary,
  SessionPaymentSessionSummary,
  SessionPaymentAppointmentSummary,
} from "./session-payment-types";

// ---------------------------------------------------------------------------
// Session payment eligibility helper (PR #172).
// ---------------------------------------------------------------------------
//
// Pure server-side helper. Decides whether a completed treatment
// session is eligible for the practitioner to prepare a
// session_payment charge attempt. v1 only PREPARES; the actual
// Stripe charge will live in a follow-up PR (the runChargeAttempt
// counterpart to runManualFeeCharge). This helper exists so the
// session detail UI and that future charge action see the same
// eligibility decision computed exactly once per session.
//
// Evidence Hone requires before any session payment is prepared:
//   1. The session exists and belongs to the practitioner's studio.
//   2. The session is linked to a completed appointment OR has the
//      explicit completed proxy (per PR #172 audit: there is no
//      sessions.status column; the proxy is:
//        sessions.appointment_id IS NOT NULL
//        AND appointments.status = 'completed'
//        AND sessions.started_at IS NOT NULL
//      A future "freeform session" path (per PR #169's reason_shape
//      decision that left appointment_id OPTIONAL for session_payment)
//      will need a different proxy, but for v1 the appointment-linked
//      path is the only safe surface).
//   3. An ACTIVE client_payment_methods row matches (studio_id,
//      client_id) and the current environment's Stripe livemode. The
//      card row must carry a non-null card_authorization_signature_id.
//   4. The card_authorization signature is CURRENT
//      (getCardAuthorizationStatus returns kind='signed_current').
//      Old signatures against a pre-edit template version do NOT
//      satisfy the gate; this mirrors PR #170's enforcement on the
//      manual fee path and on createCardSetupIntentAction.
//   5. The studio_payment_settings row exists with stripe_account_id,
//      stripe_account_status='enabled', and stripe_livemode=false.
//   6. No existing active payment_charge_attempts row (status in
//      ready, pending_stripe, succeeded) is already sitting against
//      the same (session_id, charge_reason='session_payment') pair.
//      The DB partial unique
//      payment_charge_attempts_active_session_payment_uniq is the
//      structural backstop for the race; this pre-INSERT check is
//      defense-in-depth + the source of the practitioner-facing
//      duplicate message.
//
// What this helper does NOT do
// ----------------------------
// * No Stripe call. No PaymentMethod retrieve. No PaymentIntent
//   create. The helper reads only Hone's own tables.
// * No row writes. The prepare action does the writes.
// * No amount derivation. Per PR #169 the amount comes from the
//   practitioner-confirmed form input; the helper carries the
//   pre-existing sessions.price_paid_cents as a non-binding
//   suggestion only.
// * No currency lookup beyond launch. Sam's policy pegs launch
//   currency at 'cad' (also enforced by the table CHECK).

type Args = {
  studioId: string;
  sessionId: string;
};

export async function getSessionPaymentEligibility(
  args: Args,
): Promise<SessionPaymentEligibility> {
  const admin = createAdminClient();
  const reasons: string[] = [];

  // 1) Session + appointment join. The select carries the
  //    appointment row so we can read its status without a second
  //    query; sessions.appointment_id is nullable so the row may
  //    not exist and the join key is the FK.
  const { data: sessionRow } = await admin
    .from("sessions")
    .select(
      "id, studio_id, client_id, modality, started_at, ended_at, price_paid_cents, appointment_id, appointments(id, status, starts_at)",
    )
    .eq("id", args.sessionId)
    .eq("studio_id", args.studioId)
    .maybeSingle();

  let sessionSummary: SessionPaymentSessionSummary | null = null;
  let appointmentSummary: SessionPaymentAppointmentSummary | null = null;
  let clientId: string | null = null;

  if (!sessionRow) {
    reasons.push("Session not found in this studio.");
  } else {
    sessionSummary = {
      id: sessionRow.id as string,
      modality: sessionRow.modality as string,
      startedAt: (sessionRow.started_at as string | null) ?? null,
      endedAt: (sessionRow.ended_at as string | null) ?? null,
      pricePaidCents:
        (sessionRow.price_paid_cents as number | null) ?? null,
    };
    clientId = sessionRow.client_id as string;
    // Supabase nests the embedded join as an array OR an object
    // depending on the driver build; defensively normalise.
    const apptEmbed = (sessionRow as { appointments: unknown }).appointments;
    const apptObj =
      Array.isArray(apptEmbed)
        ? (apptEmbed[0] as Record<string, unknown> | undefined)
        : (apptEmbed as Record<string, unknown> | null);
    appointmentSummary = {
      id: (apptObj?.id as string | undefined) ?? (sessionRow.appointment_id as string | null) ?? null,
      status: (apptObj?.status as string | undefined) ?? null,
      startsAt: (apptObj?.starts_at as string | undefined) ?? null,
    };

    // Chargeability proxy (per PR #172 audit § Audit 1):
    //   sessions.appointment_id IS NOT NULL
    //   AND appointments.status = 'completed'
    //   AND sessions.started_at IS NOT NULL
    // A session that has not been started is not yet a treatment
    // record. A session linked to a future / cancelled / no_show
    // appointment is not chargeable. A freeform (unlinked) session
    // is intentionally deferred until the future product decision
    // lands (PR #169 §12.6 left appointment_id optional in the
    // schema precisely so a later relax does not need a migration).
    if (sessionSummary.startedAt == null) {
      reasons.push(
        "Session has not started yet. A session payment cannot be prepared until the session is in progress.",
      );
    }
    if (!appointmentSummary.id) {
      reasons.push(
        "Session is not linked to a confirmed appointment. Freeform-session payments are not supported in v1.",
      );
    } else if (appointmentSummary.status !== "completed") {
      reasons.push(
        `Appointment is not completed (current status: ${appointmentSummary.status ?? "unknown"}). Mark the appointment complete before preparing a session payment.`,
      );
    }
  }

  // 2) Active client_payment_methods row scoped to (studio, client)
  //    and to the current environment's Stripe livemode.
  let cardSummary: SessionPaymentCardSummary | null = null;
  let cardPaymentMethodId: string | null = null;
  let stripeAccountIdFromCard: string | null = null;
  let stripeCustomerIdFromCard: string | null = null;
  let stripePaymentMethodIdFromCard: string | null = null;
  const livemode = inferStripeLivemode();
  if (clientId) {
    const { data: cardRow } = await admin
      .from("client_payment_methods")
      .select(
        "id, brand, last4, exp_month, exp_year, status, stripe_livemode, stripe_account_id, stripe_customer_id, stripe_payment_method_id, card_authorization_signature_id",
      )
      .eq("studio_id", args.studioId)
      .eq("client_id", clientId)
      .eq("status", "active")
      .eq("stripe_livemode", livemode)
      .maybeSingle();
    if (!cardRow) {
      reasons.push(
        "Client must add a card on file before a session payment can be prepared.",
      );
    } else {
      cardSummary = {
        id: cardRow.id as string,
        brand: cardRow.brand as string,
        last4: cardRow.last4 as string,
        expMonth: cardRow.exp_month as number,
        expYear: cardRow.exp_year as number,
      };
      cardPaymentMethodId = cardRow.id as string;
      stripeAccountIdFromCard = (cardRow.stripe_account_id as string | null) ?? null;
      stripeCustomerIdFromCard = (cardRow.stripe_customer_id as string | null) ?? null;
      stripePaymentMethodIdFromCard = (cardRow.stripe_payment_method_id as string | null) ?? null;
    }
  }

  // 3) Card authorization gate (PR #170 base + PR #177 strict). The
  //    charge-ready helper extends the base getCardAuthorizationStatus
  //    with a card-row pointer-equality check so a stale pointer
  //    (docs/16 §5.11) blocks PREPARE at this surface, not at execute
  //    time with confusing "signature has changed since prepared"
  //    copy. Add Card / portal re-sign deliberately keep using the
  //    BASE helper so a stale pointer never deadlocks the remedy.
  let cardAuthSummary: SessionPaymentCardAuthorizationSummary | null = null;
  if (clientId) {
    const status = await getChargeReadyCardAuthorizationStatus({
      studioId: args.studioId,
      clientId,
    });
    switch (status.kind) {
      case "no_live_template":
        reasons.push(
          "Card authorization template is not configured. Set it up in Settings before preparing a session payment.",
        );
        break;
      case "unsigned":
        reasons.push(
          "Card authorization is not signed. Ask the client to open their portal and sign card authorization before a session payment can be prepared.",
        );
        break;
      case "signed_out_of_date":
        reasons.push(
          "Card authorization on file is out of date. Ask the client to open their portal and sign the updated card authorization before a session payment can be prepared.",
        );
        break;
      case "signed_current_but_card_pointer_stale":
        // PR #177. Client has a current signed authorization but
        // the active card row's audit pointer still references an
        // older signature. The remedy is a fresh portal re-sign
        // (which now auto-refreshes the pointer via PR #177's
        // refresh helper) OR an Add Card flow (which stamps the
        // current signature directly on the new row). Either is
        // self-service from the client portal; the practitioner
        // does not need a backoffice tool.
        reasons.push(
          "Client must re-sign the current card authorization for the card on file.",
        );
        break;
      case "signed_current":
        cardAuthSummary = {
          signatureId: status.signatureId,
          templateVersion: status.templateVersion,
          signedAt: status.signedAt,
        };
        break;
    }
  }

  // 4) Studio Stripe Connect status. Lookup mirrors the SetupIntent
  //    action so a studio whose onboarding has not completed cannot
  //    have a session payment prepared even if the card row from
  //    step 2 somehow exists. stripe_livemode=false is the v1
  //    requirement; the new payment_charge_attempts
  //    _livemode_false_check makes the DB also refuse a live row.
  let resolvedStripeAccountId: string | null = stripeAccountIdFromCard;
  const { data: settings } = await admin
    .from("studio_payment_settings")
    .select(
      "stripe_account_id, stripe_account_status, stripe_livemode",
    )
    .eq("studio_id", args.studioId)
    .maybeSingle();
  if (!settings) {
    reasons.push(
      "Studio payment settings are not configured. Complete Stripe onboarding in Settings before preparing a session payment.",
    );
  } else {
    if (!settings.stripe_account_id) {
      reasons.push(
        "Studio is missing a Stripe connected account. Complete Stripe onboarding in Settings.",
      );
    }
    if (settings.stripe_account_status !== "enabled") {
      reasons.push(
        `Studio Stripe account status is "${settings.stripe_account_status ?? "unknown"}". Complete Stripe onboarding before preparing a session payment.`,
      );
    }
    if (settings.stripe_livemode !== false) {
      reasons.push(
        "Live mode is not supported in v1. Session payment is test mode only.",
      );
    }
    resolvedStripeAccountId =
      stripeAccountIdFromCard ?? (settings.stripe_account_id as string | null);
  }

  // 5) Existing attempts. Read every payment_charge_attempts row
  //    for this session + reason so the UI can show the history
  //    even when an active row blocks a new prepare.
  let existingAttempts: SessionPaymentExistingAttemptSummary[] = [];
  if (sessionSummary) {
    // PR #174 widened the SELECT to carry every field the
    // SessionPaymentPrepareCard needs to render rich
    // post-refresh panels (succeeded shows PaymentIntent +
    // Charge id + charged_at; failed shows failure_code +
    // failure_message_safe + failed_at). All fields exist on
    // payment_charge_attempts (migration 0073) and are populated
    // by writeSucceededOutcome / writeFailedOutcome in
    // lib/billing/session-payment-charge.ts (PR #173). No
    // migration; no Stripe call.
    // PR #175 added the receipt_* columns to the SELECT so the
    // succeeded panel can show the already-sent state across
    // refreshes (mirroring the PR #174 pattern). All five fields
    // are nullable on the row and on the summary; populated only
    // after the sendPaymentChargeReceipt helper claims and
    // updates the row.
    const { data: attemptRows } = await admin
      .from("payment_charge_attempts")
      .select(
        "id, status, amount_cents, created_at, stripe_payment_intent_id, stripe_charge_id, charged_at, failed_at, failure_code, failure_message_safe, receipt_status, receipt_sent_at, receipt_email_to, receipt_failure_code, receipt_failure_message_safe, refund_status, refund_amount_cents, refunded_at, stripe_refund_id, refund_failure_code, refund_failure_message_safe",
      )
      .eq("studio_id", args.studioId)
      .eq("session_id", sessionSummary.id)
      .eq("charge_reason", "session_payment")
      .order("created_at", { ascending: false });
    existingAttempts = (attemptRows ?? []).map((row) => ({
      id: row.id as string,
      status: row.status as string,
      amountCents: row.amount_cents as number,
      createdAt: row.created_at as string,
      stripePaymentIntentId:
        (row.stripe_payment_intent_id as string | null) ?? null,
      stripeChargeId: (row.stripe_charge_id as string | null) ?? null,
      chargedAt: (row.charged_at as string | null) ?? null,
      failedAt: (row.failed_at as string | null) ?? null,
      failureCode: (row.failure_code as string | null) ?? null,
      failureMessageSafe:
        (row.failure_message_safe as string | null) ?? null,
      receiptStatus: (row.receipt_status as string | null) ?? null,
      receiptSentAt: (row.receipt_sent_at as string | null) ?? null,
      receiptEmailTo: (row.receipt_email_to as string | null) ?? null,
      receiptFailureCode:
        (row.receipt_failure_code as string | null) ?? null,
      receiptFailureMessageSafe:
        (row.receipt_failure_message_safe as string | null) ?? null,
      // PR #178 refund fields (migration 0078).
      refundStatus: (row.refund_status as string | null) ?? null,
      refundAmountCents:
        (row.refund_amount_cents as number | null) ?? null,
      refundedAt: (row.refunded_at as string | null) ?? null,
      stripeRefundId: (row.stripe_refund_id as string | null) ?? null,
      refundFailureCode:
        (row.refund_failure_code as string | null) ?? null,
      refundFailureMessageSafe:
        (row.refund_failure_message_safe as string | null) ?? null,
    }));
    const blockingStatuses = new Set([
      "ready",
      "pending_stripe",
      "succeeded",
    ]);
    const activeAttempt = existingAttempts.find((a) =>
      blockingStatuses.has(a.status),
    );
    if (activeAttempt) {
      reasons.push(
        `A session payment attempt is already prepared for this session (status: ${activeAttempt.status}). Cancel it before preparing another.`,
      );
    }
  }

  // Build the eligibility result. The discriminated union mirrors
  // the manual fee shape so the UI can render summaries without
  // a second style.
  const client: SessionPaymentClientSummary | null = clientId
    ? { id: clientId, name: "" }
    : null;

  if (
    reasons.length === 0 &&
    sessionSummary &&
    client &&
    cardSummary &&
    cardAuthSummary &&
    cardPaymentMethodId &&
    resolvedStripeAccountId &&
    stripeCustomerIdFromCard &&
    stripePaymentMethodIdFromCard
  ) {
    return {
      eligible: true,
      session: sessionSummary,
      appointment: appointmentSummary ?? {
        id: null,
        status: null,
        startsAt: null,
      },
      client,
      card: cardSummary,
      cardAuthorization: cardAuthSummary,
      stripeAccountId: resolvedStripeAccountId,
      stripeCustomerId: stripeCustomerIdFromCard,
      stripePaymentMethodId: stripePaymentMethodIdFromCard,
      existingAttempts,
    };
  }

  return {
    eligible: false,
    blockingReasons: reasons.length > 0 ? reasons : [
      "Session payment cannot be prepared right now. Refresh and try again.",
    ],
    session: sessionSummary,
    appointment: appointmentSummary,
    client,
    card: cardSummary,
    cardAuthorization: cardAuthSummary,
    existingAttempts,
  };
}
