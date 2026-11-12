// The ONLY shape the fee card (a client component) receives.
//
// Privacy review of #1433 (F1): the card used to get the whole eligibility object, so the browser
// held provider identifiers it never renders (stripe_charge_id, stripe_refund_id, the raw provider
// refund status, the PaymentMethod id, signature ids, the policy hash). This module projects on the
// server to exactly what the card draws: state labels computed here (feeAttemptState and the shared
// refundDisplayState), amounts, dates, and the refund line. No `stripe_*` field crosses the boundary.
//
// Pure and framework-free so a test can assert the projected object carries no provider id.

import type {
  EligibilityExistingAttemptSummary,
  ManualFeeChargeType,
  ManualFeeEligibility,
} from "@/lib/billing/manual-fee-types";
import {
  feeAttemptState,
  feeRefund,
  type FeeAttemptStateKind,
} from "@/lib/billing/manual-fee-attempt-state";

export type FeeCardAttempt = {
  id: string;
  charge_type: ManualFeeChargeType;
  amount_cents: number;
  currency: string;
  created_at: string;
  /** Server-computed through feeAttemptState. */
  state: {
    kind: FeeAttemptStateKind;
    label: string;
    blocksNewCharge: boolean;
    mayRefreshCharge: boolean;
  };
  /** Server-computed through the shared refundDisplayState. `line` is null when nothing is refunded or in flight. */
  refund: { kind: string; line: string | null; mayStartRefund: boolean };
  charged_at: string | null;
  failed_at: string | null;
  failure_code: string | null;
  failure_message: string | null;
  cancelled_at: string | null;
  cancelled_reason: string | null;
  refunded_at: string | null;
  receipt_sent: boolean;
};

export type FeeCardEligibility = {
  eligible: boolean;
  blockingReasons: string[];
  amountCents: number | null;
  currency: string | null;
  clientName: string | null;
  serviceName: string | null;
  startsAt: string | null;
  card: { brand: string; last4: string } | null;
  cardAuthorizationSignedAt: string | null;
  policyAcknowledgedAt: string | null;
  attempts: FeeCardAttempt[];
};

export function projectFeeAttempt(
  a: EligibilityExistingAttemptSummary,
  now: Date,
  isOwner: boolean,
): FeeCardAttempt {
  const state = feeAttemptState(
    {
      status: a.status,
      failure_code: a.failure_code,
      has_payment_intent: !!a.stripe_payment_intent_id,
      charged_at: a.charged_at,
      updated_at: a.updated_at ?? null,
    },
    now,
  );
  const r = feeRefund(a);
  return {
    id: a.id,
    charge_type: a.charge_type,
    amount_cents: a.amount_cents,
    currency: a.currency,
    created_at: a.created_at,
    state: {
      kind: state.kind,
      label: state.label,
      blocksNewCharge: state.blocksNewCharge,
      mayRefreshCharge: state.mayRefreshCharge,
    },
    // Only the owner may start a refund (the server refuses anyone else; the button is hidden too).
    refund: { kind: r.display.kind, line: r.line, mayStartRefund: isOwner && r.display.mayStartRefund },
    charged_at: a.charged_at,
    failed_at: a.failed_at,
    failure_code: a.failure_code,
    failure_message: a.failure_message,
    cancelled_at: a.cancelled_at,
    cancelled_reason: a.cancelled_reason,
    refunded_at: r.display.kind === "refunded" ? (a.refunded_at ?? null) : null,
    receipt_sent: !!a.receipt_sent_at,
  };
}

export function projectFeeEligibility(
  e: ManualFeeEligibility,
  now: Date,
  isOwner: boolean,
): FeeCardEligibility {
  return {
    eligible: e.eligible,
    blockingReasons: e.eligible ? [] : e.blockingReasons,
    amountCents: e.amountCents,
    currency: e.currency,
    clientName: e.client?.name ?? null,
    serviceName: e.appointment?.service_name ?? null,
    startsAt: e.appointment?.starts_at ?? null,
    card: e.card ? { brand: e.card.brand, last4: e.card.last4 } : null,
    cardAuthorizationSignedAt: e.cardAuthorization?.signed_at ?? null,
    policyAcknowledgedAt: e.policyAcknowledgement?.acknowledged_at ?? null,
    attempts: e.existingAttempts.map((a) => projectFeeAttempt(a, now, isOwner)),
  };
}
