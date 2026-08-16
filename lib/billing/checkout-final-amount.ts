import {
  formatCadFromCents,
  parseCadAmountToCents,
} from "@/lib/billing/cad-amount";
import {
  SESSION_PAYMENT_ADJUSTMENT_REASON_MAX_LENGTH,
  SESSION_PAYMENT_INTERNAL_NOTE_MAX_LENGTH,
} from "@/lib/billing/session-payment-types";

// F-PAY-002. THE checkout amount decision, in one pure place.
//
// WHAT CHANGED, AND WHY IT IS NOT A ROLLBACK OF F-PAY-001.
//
// F-PAY-001 fixed a real defect: the prepare action read `amount_dollars` off
// the form and inserted it, so a tampered request decided what a client was
// charged. The repair made the server-resolved service/client price the SOLE
// preparation amount. That closed the hole and simultaneously removed a product
// capability Chloe depends on — she could no longer apply a discount, add an
// aftercare product, or make any adjustment at the till. Her report was blunt:
// "I can't do a custom price. When I prepare charge it's stuck as whatever the
// price of the service is."
//
// The distinction this module draws is the one F-PAY-001 collapsed:
//
//   * The browser may REQUEST an operator-authored final total. That is a
//     business decision a human is making with the client standing there, and
//     it is authorised, bounded, explained and audited here.
//   * The browser may NOT supply studio, practitioner, practitioner role,
//     client, session, appointment, service, card, consent signature, Stripe
//     account, Stripe customer or Stripe payment method. Every one of those is
//     still resolved server-side from trusted records and none of them is
//     reachable from this module.
//
// So the browser is a party to ONE number, under four conditions it cannot
// forge: the operator is the studio owner, the page was not stale, the amount
// is well-formed CAD within the ceiling, and a reason was given.
//
// PURE: no I/O, no clock, no mutation. `actorIsOwner` is a decided fact passed
// in by the caller, which MUST derive it from the authenticated practitioner.
// Nothing here reads a role, and nothing here can be told one by a form.

export type CheckoutFinalAmountDecision =
  // Prepare a payment_charge_attempts row at exactly `amountCents`, carrying
  // `internalNote` (already composed, already length-checked, may be null).
  | { kind: "prepare"; amountCents: number; internalNote: string | null }
  // $0.00. A calm, non-error outcome: nothing is prepared and nothing is wrong.
  | { kind: "no_charge_required"; message: string }
  // Any refusal. `error` is practitioner-facing and leaks nothing.
  | { kind: "reject"; error: string };

// STALE REFERENCE. The reference the browser was showing no longer matches the
// one the server just resolved. Never silently swap the number underneath her:
// preparing at an amount she never read is the failure F-PAY-001 existed to
// remove, and an operator-authored total does not buy an exemption from it.
export const REFERENCE_CHANGED_ERROR =
  "The booked service price changed. Refresh and review the current checkout amount before preparing payment.";

export const AMOUNT_BLANK_ERROR = "Enter the final charge, for example 120.00.";
export const AMOUNT_MALFORMED_ERROR =
  "Enter the final charge as a dollar amount with at most two decimals, for example 120.00.";

export function amountAboveCeilingError(ceilingCents: number): string {
  return `The final charge must be ${formatCadFromCents(ceilingCents)} or less.`;
}

export const OWNER_ONLY_AMOUNT_ERROR =
  "Only the studio owner can change the final charge. Prepare at the booked price, or ask the owner to apply the adjustment.";

export const ADJUSTMENT_REASON_REQUIRED_ERROR =
  "Add a short reason for the adjustment, for example a client discount or an aftercare product.";

export const ADJUSTMENT_REASON_TOO_LONG_ERROR =
  `Keep the adjustment reason under ${SESSION_PAYMENT_ADJUSTMENT_REASON_MAX_LENGTH} characters.`;

// The adjustment context and the practitioner's own note share ONE column.
// When they cannot both fit, say so. Truncating either would quietly destroy
// evidence about money: the note is clinical/operational context she chose to
// record, and the adjustment line is the audit trail for a total that differs
// from the booked price.
export const NOTE_AND_REASON_TOO_LONG_ERROR =
  `The internal note and the adjustment reason together must be under ${SESSION_PAYMENT_INTERNAL_NOTE_MAX_LENGTH} characters. Shorten one of them.`;

export const NO_CHARGE_REQUIRED_MESSAGE = "No charge is required at $0.00.";

/**
 * Compose the audit context for an adjusted checkout.
 *
 * PROSE, DELIBERATELY. This is explanatory context for a human reading the
 * row later; the AMOUNT COLUMN is the monetary fact. No code may parse this
 * string to infer a discount percentage, a product, a package or a tax
 * treatment — none of those are modelled by this change, and a parser here
 * would invent an accounting claim the studio never made.
 */
export function adjustmentAuditLine(input: {
  referenceCents: number;
  finalCents: number;
  reason: string;
}): string {
  return `Checkout adjusted from ${formatCadFromCents(
    input.referenceCents,
  )} to ${formatCadFromCents(input.finalCents)}. Reason: ${input.reason}`;
}

/**
 * Decide what a checkout submission may become.
 *
 * `referenceCents` is the amount the SERVER has just independently resolved
 * from current records. `expectedReferenceRaw` is what the browser claims it
 * was displaying; it can only ever cause a rejection and can never choose a
 * value.
 */
export function decideCheckoutFinalAmount(input: {
  referenceCents: number;
  ceilingCents: number;
  expectedReferenceRaw: string;
  requestedFinalRaw: string;
  adjustmentReasonRaw: string;
  internalNoteRaw: string;
  // Derived server-side from the authenticated practitioner. A form field of
  // this name does not exist and must never be introduced.
  actorIsOwner: boolean;
}): CheckoutFinalAmountDecision {
  const {
    referenceCents,
    ceilingCents,
    expectedReferenceRaw,
    requestedFinalRaw,
    adjustmentReasonRaw,
    internalNoteRaw,
    actorIsOwner,
  } = input;

  // 1. STALE DISPLAY, FIRST. A request that cannot say what it was showing, or
  //    that was showing a price that has since moved, is refused before any
  //    other field is even considered. This runs ahead of amount parsing so a
  //    practitioner looking at an out-of-date page is told to refresh rather
  //    than being sent to correct an amount that is about to change anyway.
  if (!/^\d+$/.test(expectedReferenceRaw)) {
    return { kind: "reject", error: REFERENCE_CHANGED_ERROR };
  }
  const expectedCents = Number(expectedReferenceRaw);
  if (!Number.isSafeInteger(expectedCents) || expectedCents <= 0) {
    return { kind: "reject", error: REFERENCE_CHANGED_ERROR };
  }
  if (expectedCents !== referenceCents) {
    return { kind: "reject", error: REFERENCE_CHANGED_ERROR };
  }

  // 2. THE FINAL TOTAL. Strict: parsed, never coerced, never clamped.
  const parsed = parseCadAmountToCents(requestedFinalRaw, ceilingCents);
  if (!parsed.ok) {
    switch (parsed.reason) {
      case "blank":
        return { kind: "reject", error: AMOUNT_BLANK_ERROR };
      case "malformed":
        return { kind: "reject", error: AMOUNT_MALFORMED_ERROR };
      case "above_ceiling":
        return {
          kind: "reject",
          error: amountAboveCeilingError(ceilingCents),
        };
    }
  }
  const finalCents = parsed.cents;

  // 3. $0.00. A comped visit is not a zero-dollar chargeable row; the DB CHECK
  //    forbids one and, more importantly, a row that exists is a charge waiting
  //    to be attempted. This returns BEFORE any authorisation or reason gate
  //    because it authorises nothing: no attempt, no Stripe call, no money
  //    fact. Recording a deliberately comped session as a financial event is
  //    real, separate work this change does not claim to do.
  if (finalCents === 0) {
    return { kind: "no_charge_required", message: NO_CHARGE_REQUIRED_MESSAGE };
  }

  const internalNote = internalNoteRaw.trim();
  const unchanged = finalCents === referenceCents;

  // 4. THE ORDINARY PATH. Charging exactly the booked price is not an
  //    adjustment, needs no owner and needs no explanation, so the common
  //    client-in-the-chair checkout stays a two-tap.
  if (unchanged) {
    // The prepare action caps a bare note before it does any work, so through
    // that caller this branch is unreachable. It stays because the cap is THIS
    // module's guarantee: no path here may emit a note longer than the column
    // allows, whoever calls it.
    if (internalNote.length > SESSION_PAYMENT_INTERNAL_NOTE_MAX_LENGTH) {
      return { kind: "reject", error: NOTE_AND_REASON_TOO_LONG_ERROR };
    }
    return {
      kind: "prepare",
      amountCents: finalCents,
      internalNote: internalNote.length > 0 ? internalNote : null,
    };
  }

  // 5. AN AUTHORED TOTAL. Owner only, and enforced on a role the caller
  //    derived from the authenticated practitioner.
  if (!actorIsOwner) {
    return { kind: "reject", error: OWNER_ONLY_AMOUNT_ERROR };
  }

  // Collapsed to a single line BEFORE the bound is applied. The audit context
  // is one sentence appended to a note the practitioner also writes in, and a
  // reason containing newlines could be typed to look like a second, separate
  // audit entry ("...\n\nCheckout adjusted from $1.00 to $1.00. Reason: x").
  // Nothing parses this note, so that is presentation rather than privilege —
  // but a machine-written line should stay one line, and collapsing costs
  // nothing. Interior runs of whitespace become one space; her words survive.
  const reason = adjustmentReasonRaw.replace(/\s+/g, " ").trim();
  if (reason.length === 0) {
    return { kind: "reject", error: ADJUSTMENT_REASON_REQUIRED_ERROR };
  }
  if (reason.length > SESSION_PAYMENT_ADJUSTMENT_REASON_MAX_LENGTH) {
    return { kind: "reject", error: ADJUSTMENT_REASON_TOO_LONG_ERROR };
  }

  const auditLine = adjustmentAuditLine({
    referenceCents,
    finalCents,
    reason,
  });
  // Both, or neither. A practitioner's own note is never dropped to make room
  // for the audit line, and the audit line is never dropped to make room for
  // the note.
  const composed =
    internalNote.length > 0 ? `${internalNote}\n\n${auditLine}` : auditLine;
  if (composed.length > SESSION_PAYMENT_INTERNAL_NOTE_MAX_LENGTH) {
    return { kind: "reject", error: NOTE_AND_REASON_TOO_LONG_ERROR };
  }

  return { kind: "prepare", amountCents: finalCents, internalNote: composed };
}
