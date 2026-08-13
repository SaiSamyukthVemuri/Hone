// BOOK-01 Tranche 1 — public booking confirmation copy, as a pure function.
//
// WHY THIS IS A MODULE AND NOT TERNARIES INSIDE THE JSX.
//
// The unit lane is `environment: "node"` and `include: ["tests/**/*.test.ts"]`
// (vitest.config.ts), so no test in this repository can render a `.tsx`
// component. Copy decisions embedded in JSX are therefore only reachable by
// source-regex assertions, which prove text and not behaviour. Lifting the
// decision into a pure function makes the ACTUAL rule — "never claim a
// delivery that did not happen, and always offer the management link" —
// executable, and gives the negative controls something real to turn red.
//
// The three-state vocabulary deliberately mirrors the reschedule surface
// (`ConfirmationEmailStatus` in app/reschedule/[token]/actions.ts:608), which
// established this pattern in the 0171 amendment. It is restated here rather
// than imported because that identifier lives inside a `"use server"` route
// module and this PR is scoped to public booking only; unifying the two into
// one shared vocabulary is a follow-up, not part of this change.
export type ConfirmationEmailStatus = "sent" | "failed" | "disabled";

export type BookingConfirmationCopy = {
  /**
   * Ordered "what happens next" lines. Every line must be true for the given
   * status — this is the whole point of the type.
   */
  steps: string[];
  /** Label for the primary management action. Present in every status. */
  manageLabel: string;
  /**
   * True ONLY when the copy asserts the confirmation email reached the client.
   * A provider failure or a studio with confirmations switched off must never
   * set this.
   */
  claimsEmailDelivered: boolean;
  /**
   * True ONLY when the copy tells the client the email carries their
   * cancel/reschedule links. When this is true the client is being pointed at
   * the email as A path to management; it must never be the ONLY path, which
   * is why `manageLabel` is unconditional.
   */
  claimsEmailCarriesManagementLinks: boolean;
  /**
   * True when the client should save or bookmark the in-band link because no
   * confirmed email copy of it exists.
   */
  urgesSavingLink: boolean;
};

/**
 * Build the confirmation copy for a COMMITTED public booking.
 *
 * The management link is unconditional: it is the client's guaranteed path to
 * the appointment and depends on no provider. Only the surrounding narrative
 * varies, and it varies strictly with what the provider actually did.
 */
export function buildBookingConfirmationCopy(input: {
  emailStatus: ConfirmationEmailStatus;
  email: string;
}): BookingConfirmationCopy {
  const { emailStatus, email } = input;
  const manageLabel = "Manage booking";

  if (emailStatus === "sent") {
    return {
      steps: [
        `We sent a confirmation to ${email}, with a calendar invite.`,
        "The email includes links to cancel or reschedule if your plans change.",
        "If your studio asks for a health intake, you’ll receive that link too.",
      ],
      manageLabel,
      claimsEmailDelivered: true,
      claimsEmailCarriesManagementLinks: true,
      urgesSavingLink: false,
    };
  }

  if (emailStatus === "failed") {
    // The provider refused or errored. We do not say the email is "on its
    // way", and we do not tell the client their links are in an email that
    // may never arrive. We also do not surface the provider's reason: it is
    // internal detail the client can do nothing with.
    return {
      steps: [
        `We couldn’t confirm that our confirmation email to ${email} went through.`,
        "Use Manage booking below to cancel or reschedule — save or bookmark that link.",
        "If your studio asks for a health intake, they’ll follow up with you about it.",
      ],
      manageLabel,
      claimsEmailDelivered: false,
      claimsEmailCarriesManagementLinks: false,
      urgesSavingLink: true,
    };
  }

  // "disabled": the studio turned confirmation emails off. That is a
  // configuration, not a failure, so there is nothing to apologise for and
  // no email to mention at all.
  return {
    steps: [
      "Use Manage booking below to cancel or reschedule — save or bookmark that link.",
      "If your studio asks for a health intake, they’ll follow up with you about it.",
    ],
    manageLabel,
    claimsEmailDelivered: false,
    claimsEmailCarriesManagementLinks: false,
    urgesSavingLink: true,
  };
}
