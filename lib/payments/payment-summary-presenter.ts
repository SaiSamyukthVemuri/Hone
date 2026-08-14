// Pure, client-safe presentation helpers for the compact session-payment card
// (Chloe feedback: the payment panel showed too many Stripe internals and took
// too much charting space). NO server-only, NO queries, NO Stripe SDK: pure
// derivation over data the card already holds, so it is unit-testable without a
// database and safe to import into a client component.
//
// This module NEVER writes anything back to storage; masked/derived values are
// display-only. It deliberately keeps raw processor identifiers, raw failure
// codes, and full email addresses OUT of the practitioner-facing strings: those
// stay in storage and are surfaced only through the owner-only technical
// disclosure and the existing admin surfaces.

import type { SessionPaymentExistingAttemptSummary } from "@/lib/billing/session-payment-types";

const CENTS_PER_DOLLAR = 100;

export function formatCadFromCents(cents: number | null | undefined): string {
  if (cents == null) return "";
  return `$${(cents / CENTS_PER_DOLLAR).toFixed(2)}`;
}

// Mask a receipt destination for the practitioner card: keep the first local-part
// character + the full domain, replace the rest of the local part with bullets
// (minimum three, so a one-character local part is not revealed as one char).
// Returns "" for a missing/implausible value so the caller falls back to the
// plain "Receipt sent" copy, never a malformed address, never the full email.
// Display-only; never written back to storage.
export function maskReceiptEmail(email: string | null | undefined): string {
  const e = (email ?? "").trim();
  if (!e) return "";
  const at = e.lastIndexOf("@");
  if (at <= 0 || at === e.length - 1) return ""; // no local part or no domain
  const local = e.slice(0, at);
  const domain = e.slice(at + 1);
  if (!domain.includes(".") || /\s/.test(e)) return ""; // implausible stored value
  const bullets = "•".repeat(Math.max(local.length - 1, 3));
  return `${local[0]}${bullets}@${domain}`;
}

// The receipt line for the practitioner card. Never shows the full email.
export type ReceiptLine =
  | { kind: "sent"; masked: string | null } // masked may be null → "Receipt sent"
  | { kind: "failed" }
  | { kind: "sending" }
  | { kind: "none" };

export function deriveReceiptLine(
  attempt: Pick<
    SessionPaymentExistingAttemptSummary,
    "receiptStatus" | "receiptEmailTo"
  >,
): ReceiptLine {
  switch (attempt.receiptStatus) {
    case "sent": {
      const masked = maskReceiptEmail(attempt.receiptEmailTo);
      return { kind: "sent", masked: masked || null };
    }
    case "failed":
      return { kind: "failed" };
    case "sending":
      return { kind: "sending" };
    default:
      return { kind: "none" };
  }
}

// A practitioner-friendly charge-failure reason. Uses ONLY wording supported by
// the stored code family; the raw code and any processor message stay in the
// owner-only technical disclosure. Never returns the raw code/message.
export function humanChargeFailure(
  failureCode: string | null | undefined,
): string {
  const code = (failureCode ?? "").toLowerCase();
  if (
    code.includes("expired_card") ||
    code === "expired" ||
    code.includes("card_expired")
  ) {
    return "The card has expired. Ask the client to update their card, then try again.";
  }
  if (code.includes("insufficient_funds")) {
    return "The card was declined for insufficient funds. Try again or use another payment method.";
  }
  if (
    code.includes("decline") || // card_declined, generic_decline, declined
    code.includes("do_not_honor") ||
    code.includes("card_not_supported")
  ) {
    return "The card was declined. Try again or use another payment method.";
  }
  return "The payment could not be completed. Try again or use another payment method.";
}

// The compact top-line state of the practitioner card. Derived from the persisted
// attempt (the same source of truth the panels already use). `null` attempt =
// nothing prepared yet ("Not charged").
export type PaymentSummaryKind =
  | "not_charged"
  | "ready"
  | "processing"
  | "paid"
  | "paid_receipt_failed"
  | "refunded"
  | "refund_pending"
  | "failed";

export type PaymentSummary = {
  kind: PaymentSummaryKind;
  // "Paid", "Ready to charge", "Not charged", "Payment processing", "Refunded",
  // "Payment issue".
  headline: string;
  tone: "paid" | "ready" | "neutral" | "processing" | "issue";
  amountCents: number | null;
};

export function derivePaymentSummary(
  attempt: SessionPaymentExistingAttemptSummary | null,
): PaymentSummary {
  if (!attempt) {
    return { kind: "not_charged", headline: "Not charged", tone: "neutral", amountCents: null };
  }
  const amountCents = attempt.amountCents;
  if (attempt.status === "succeeded") {
    if (attempt.refundStatus === "succeeded") {
      return { kind: "refunded", headline: "Refunded", tone: "neutral", amountCents };
    }
    if (attempt.refundStatus === "pending_stripe") {
      return { kind: "refund_pending", headline: "Refund processing", tone: "processing", amountCents };
    }
    if (attempt.receiptStatus === "failed") {
      return { kind: "paid_receipt_failed", headline: "Paid", tone: "paid", amountCents };
    }
    return { kind: "paid", headline: "Paid", tone: "paid", amountCents };
  }
  if (attempt.status === "pending_stripe") {
    return { kind: "processing", headline: "Payment processing", tone: "processing", amountCents };
  }
  if (attempt.status === "ready") {
    return { kind: "ready", headline: "Ready to charge", tone: "ready", amountCents };
  }
  if (attempt.status === "failed") {
    return { kind: "failed", headline: "Charge was not completed", tone: "issue", amountCents };
  }
  // cancelled / blocked / unknown → treat as not-charged for the compact face
  // (the detail callout still explains why a new attempt is being prepared).
  return { kind: "not_charged", headline: "Not charged", tone: "neutral", amountCents };
}

// The technical rows for the owner-only disclosure: raw identifiers/codes that
// must NOT appear in the practitioner face. Null/blank entries are dropped by the
// component. This is the ONE place that enumerates the hidden fields so no panel
// reintroduces a raw id inline.
export function technicalRowsForAttempt(
  attempt: SessionPaymentExistingAttemptSummary,
): Array<{ label: string; value: string | null }> {
  return [
    { label: "Attempt ID", value: attempt.id },
    { label: "PaymentIntent", value: attempt.stripePaymentIntentId },
    { label: "Charge", value: attempt.stripeChargeId },
    { label: "Refund", value: attempt.stripeRefundId },
    { label: "Failure code", value: attempt.failureCode },
    { label: "Failure detail", value: attempt.failureMessageSafe },
    { label: "Refund failure code", value: attempt.refundFailureCode },
    { label: "Refund failure detail", value: attempt.refundFailureMessageSafe },
    { label: "Receipt to", value: attempt.receiptEmailTo },
    { label: "Receipt failure code", value: attempt.receiptFailureCode },
  ];
}
