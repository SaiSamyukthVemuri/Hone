// PR #172. Shared types + constants for the session payment prepare
// flow. Kept in a separate file (mirroring lib/billing/manual-fee-types.ts)
// so types can be imported by both the server-only eligibility
// helper and the UI without dragging "server-only" into a client
// boundary.
//
// The session payment v1 model lives in docs/16 §12 + docs/02
// payment domain section:
//   * Practitioner-confirmed amount in CAD
//   * Charge AFTER the session is completed
//   * Off-session against the saved card
//   * Test mode only in this PR (no Stripe call; row only)
//
// The canonical row lands on public.payment_charge_attempts
// (migration 0073 + 0074) with charge_reason='session_payment',
// status='ready', stripe_livemode=false. No PaymentIntent is
// created here; that is a future PR.

// Same $2,000 CAD ceiling enforced by the
// payment_charge_attempts.amount_cents CHECK
// (amount_cents > 0 and amount_cents <= 200000). The application
// layer also enforces the ceiling so the practitioner sees a
// user-facing message before the DB rejects the insert.
export const SESSION_PAYMENT_AMOUNT_CEILING_CENTS = 200_000;

// Internal note bounded to mirror manual_fee's 1000-character cap.
// The note is shown only to studio members and is the practitioner's
// short explanation of why this charge is being prepared (the
// session that produced it, any discount applied, etc.).
export const SESSION_PAYMENT_INTERNAL_NOTE_MAX_LENGTH = 1000;

// Summary shapes mirror lib/billing/manual-fee-types.ts so the UI
// can render the same blocked / ready states without dragging a
// second style.

export type SessionPaymentSessionSummary = {
  id: string;
  modality: string;
  startedAt: string | null;
  endedAt: string | null;
  pricePaidCents: number | null;
};

export type SessionPaymentAppointmentSummary = {
  id: string | null;
  status: string | null;
  startsAt: string | null;
};

export type SessionPaymentClientSummary = {
  id: string;
  name: string;
};

export type SessionPaymentCardSummary = {
  id: string;
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
};

export type SessionPaymentCardAuthorizationSummary = {
  signatureId: string;
  templateVersion: number;
  signedAt: string;
};

// PR #174 added the post-execute fields (stripe_payment_intent_id,
// stripe_charge_id, charged_at, failed_at, failure_code,
// failure_message_safe) so the session detail page can render rich
// succeeded / failed / pending panels after a page refresh. Before
// PR #174 the card relied on React local state (executeSuccess) to
// show the PaymentIntent id immediately after Run test charge; that
// state was lost on reload, leaving the practitioner with a bare
// "Succeeded" label. The fields here are the same set ManualFeeCharge
// Card has read since PR #146; the session payment card now mirrors
// the manual fee precedent.
export type SessionPaymentExistingAttemptSummary = {
  id: string;
  status: string;
  amountCents: number;
  createdAt: string;
  stripePaymentIntentId: string | null;
  stripeChargeId: string | null;
  chargedAt: string | null;
  failedAt: string | null;
  failureCode: string | null;
  failureMessageSafe: string | null;
  // PR #175 receipt-state fields. Populated by the
  // sendPaymentChargeReceipt helper on payment_charge_attempts
  // (migration 0076). The succeeded panel reads these so the
  // already-sent state survives a page refresh and so the
  // failure detail is visible after a terminal send error.
  receiptStatus: string | null;
  receiptSentAt: string | null;
  receiptEmailTo: string | null;
  receiptFailureCode: string | null;
  receiptFailureMessageSafe: string | null;
};

// The discriminated union the prepare-card consumes. eligible=true
// means the practitioner sees a form; eligible=false means the
// card renders the blocking reasons. The session payment path
// does NOT consult any policy_acknowledgement (the v1 model in
// PR #169 § 12.6 is explicit: session payment is governed by the
// card_authorization template, not the cancellation /
// no-show policy).
export type SessionPaymentEligibility =
  | {
      eligible: true;
      session: SessionPaymentSessionSummary;
      appointment: SessionPaymentAppointmentSummary;
      client: SessionPaymentClientSummary;
      card: SessionPaymentCardSummary;
      cardAuthorization: SessionPaymentCardAuthorizationSummary;
      stripeAccountId: string;
      stripeCustomerId: string;
      stripePaymentMethodId: string;
      existingAttempts: SessionPaymentExistingAttemptSummary[];
    }
  | {
      eligible: false;
      blockingReasons: string[];
      session: SessionPaymentSessionSummary | null;
      appointment: SessionPaymentAppointmentSummary | null;
      client: SessionPaymentClientSummary | null;
      card: SessionPaymentCardSummary | null;
      cardAuthorization: SessionPaymentCardAuthorizationSummary | null;
      existingAttempts: SessionPaymentExistingAttemptSummary[];
    };
