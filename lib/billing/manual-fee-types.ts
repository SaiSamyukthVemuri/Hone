// Constants + types for the manual fee charge attempt flow (PR #145).
//
// This module is plain TypeScript with no server-only imports so both
// the eligibility helper (which is server-only) and the client React
// components that render the practitioner-side preview / settings can
// import from it without dragging Supabase/admin-server code into the
// client bundle.

export type ManualFeeChargeType = "late_cancel" | "no_show";

// Launch ceiling for any single manual fee. Enforced by the column
// CHECK on studios.late_cancel_fee_cents / studios.no_show_fee_cents
// and again by the column CHECK on manual_fee_charge_attempts. The
// settings form input rejects amounts above $200.00 before submission;
// the action re-validates server-side.
export const MANUAL_FEE_AMOUNT_CEILING_CENTS = 20000;

// Internal-note cap on the prepare action. The DB column CHECK is
// (1..1000); the form mirrors the upper bound to prevent paste-bombs
// before the request leaves the browser.
export const MANUAL_FEE_INTERNAL_NOTE_MAX_LENGTH = 1000;

export type EligibilityAppointmentSummary = {
  id: string;
  status: "cancelled" | "no_show" | "other";
  starts_at: string;
  cancelled_at: string | null;
  created_at: string;
  service_name: string | null;
};

export type EligibilityClientSummary = {
  id: string;
  name: string;
};

export type EligibilityCardSummary = {
  id: string;
  brand: string;
  last4: string;
  exp_month: number;
  exp_year: number;
};

export type EligibilityCardAuthorizationSummary = {
  signature_id: string;
  signed_at: string;
  signature_name: string;
  template_title_snapshot: string;
};

export type EligibilityPolicyAckSummary = {
  id: string;
  acknowledged_at: string;
  policy_snapshot_hash: string;
};

export type EligibilityExistingAttemptSummary = {
  id: string;
  charge_type: ManualFeeChargeType;
  status: string;
  amount_cents: number;
  currency: string;
  created_at: string;
  // PR #146. Result fields populated by the Stripe test-charge or
  // cancel-prepared-attempt actions. Nullable across the board so the
  // 'ready' row still passes the type check before any Stripe call.
  stripe_payment_intent_id: string | null;
  stripe_charge_id: string | null;
  charged_at: string | null;
  failed_at: string | null;
  failure_code: string | null;
  failure_message: string | null;
  cancelled_at: string | null;
  cancelled_reason: string | null;
};

export type ManualFeeEligibility =
  | {
      eligible: true;
      cardPaymentMethodId: string;
      cardAuthorizationSignatureId: string;
      policyAcknowledgementId: string;
      policySnapshotHash: string;
      amountCents: number;
      currency: string;
      timingClassification: "practitioner_asserted";
      appointment: EligibilityAppointmentSummary;
      client: EligibilityClientSummary;
      card: EligibilityCardSummary;
      cardAuthorization: EligibilityCardAuthorizationSummary;
      policyAcknowledgement: EligibilityPolicyAckSummary;
      existingAttempts: EligibilityExistingAttemptSummary[];
    }
  | {
      eligible: false;
      blockingReasons: string[];
      appointment: EligibilityAppointmentSummary | null;
      client: EligibilityClientSummary | null;
      card: EligibilityCardSummary | null;
      cardAuthorization: EligibilityCardAuthorizationSummary | null;
      policyAcknowledgement: EligibilityPolicyAckSummary | null;
      amountCents: number | null;
      currency: string | null;
      timingClassification: "practitioner_asserted";
      existingAttempts: EligibilityExistingAttemptSummary[];
    };
