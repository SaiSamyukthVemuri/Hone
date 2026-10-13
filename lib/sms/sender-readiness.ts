import { classifyNanpNumber, type NanpCountry } from "./nanp";
import { RECOVERY_ROUTE_BY_ERROR_CODE, type SenderRead } from "./sender-status";

// ===========================================================================
// SMS-SENDER-READY-01 (#824): can this studio's OWN sender text a Canadian
// recipient, and a US recipient? Said truthfully, per destination country.
// ===========================================================================
//
// Six owner-facing states, each with the next action and who takes it:
//
//   Not configured     no studio-owned sender (none, off, released)
//   Pending            a number is being chosen, provisioned or released, or a
//                      registration is under review
//   Requires information   something specific is missing before this
//                      destination can be served (e.g. US registration)
//   Active             the studio's own sender can serve this destination
//   Suspended          the sender or its registration is suspended
//   Failed             setup failed, or a registration was rejected
//
// plus "Unavailable" when the sender could not be read: a read that did not
// answer is never reported as any of the six.
//
// WHAT "ACTIVE" REQUIRES: ONE MATRIX, sender kind x destination, taken from
// Twilio's own documentation (checked 2026-10-12, Canada re-checked 2026-10-13;
// see DESTINATION_RULES):
//
//                         Canadian recipients          US recipients
//   Canadian long code    not an eligible A2P route    A2P 10DLC registration
//   US long code          not an eligible A2P route    A2P 10DLC registration
//   Toll-free             toll-free verification       toll-free verification
//
//   * CANADA (Codex P2 4253590276; Codex decision on #841). Hone's appointment
//     and waitlist texts are application-to-person (A2P). Twilio's guidance
//     is that Canadian carriers restrict A2P traffic from long codes
//     (twilio.com/docs/messaging/guides/best-practices-at-scale), and its
//     Canada guidelines, while listing domestic long-code capability,
//     recommend short codes or VERIFIED toll-free numbers for A2P
//     (twilio.com/en-us/guidelines/ca/sms). So a long code's TRANSPORT
//     capability, and US 10DLC registration not applying to Canada, are NOT
//     Canadian A2P readiness: such a sender is "Requires information" for
//     Canadian recipients, whatever its evidence. This is a readiness gate
//     based on provider guidance, not a legal conclusion. It changes no live
//     route and stops no message: nothing sends from this model.
//
//   * A2P 10DLC is scoped to traffic TO the US: "Anyone sending SMS/MMS
//     messages over a 10DLC number from an application to the US must
//     register for A2P 10DLC", and "US and Canadian 10-digit long code (10DLC)
//     phone numbers must be registered before you can use them to send
//     messages from your application to US-based recipients". So a REGISTERED
//     Canadian long code may serve US recipients, and a US long code serving
//     Canadian recipients needs no 10DLC registration.
//   * "Toll-free numbers must be verified before you can use them to send
//     messages to the United States or Canada."
//   A number existing, or passing one test send, establishes none of this.
//
// NOT A HIPAA STATEMENT. "Active" here means sender and registration
// eligibility only. Texting patient information also needs a provider account
// covered by a BAA (#828); nothing in this model knows or implies that.
//
// REGISTRATION EVIDENCE: the caller passes the evidence for the ONE kind of
// registration the sender's number uses (10DLC for a long code, Canadian or
// US; toll-free verification for a toll-free number). Hone support records it
// in 0217 (SMS-SENDER-REG-01) after checking the provider account, read
// through lib/sms/sender-registration.ts. Recording "approved" is evidence,
// not an activation.
//
// This module reads nothing and sends nothing. It is the input the later
// send-time refusal will consume, so the panel and the refusal cannot disagree.
// ===========================================================================

export type DestinationCountry = "CA" | "US";

/**
 * Registration evidence for THE EXACT CURRENT NUMBER (#844 binds every record
 * to the sender and the number support verified; a record for any other number
 * is not evidence for this one).
 *
 * `approved` IS COMPLETE AND VERIFIED, NOTHING LESS (Codex P2 4253281361 and
 * the Codex decision on #863). For A2P 10DLC that is the brand, the campaign
 * AND this number's own registration: Twilio registers each number separately
 * and asynchronously after campaign approval, and that step can lag or fail
 * (twilio.com/docs/messaging/compliance/a2p-10dlc/troubleshooting-a2p-brands/
 * troubleshooting-a2p-phone-number-registration-issues). For a toll-free
 * number it is completed verification of that number. A number still
 * UNREGISTERED or PENDING_REGISTRATION is `pending`; one whose registration
 * failed is `rejected`. Nothing short of complete is ever Active.
 */
export type UsRegistrationEvidence =
  | { state: "not_recorded" }
  /** The evidence read did not answer: never treated as "not recorded". */
  | { state: "unreadable" }
  | { state: "pending" }
  | { state: "requires_information"; missing: string }
  | { state: "approved" }
  | { state: "rejected" }
  | { state: "suspended" };

export type ReadinessState =
  | "not_configured"
  | "pending"
  | "requires_information"
  | "active"
  | "suspended"
  | "failed"
  | "unavailable";

export type ReadinessActor = "owner" | "support" | "none";

export type DestinationReadiness = {
  destination: DestinationCountry;
  state: ReadinessState;
  label: string;
  detail: string;
  nextAction: string | null;
  actor: ReadinessActor;
  /** The studio sender's number country, when there is one and it classifies. */
  senderCountry: NanpCountry | null;
};

export const READINESS_LABELS: Record<ReadinessState, string> = {
  not_configured: "Not configured",
  pending: "Pending",
  requires_information: "Requires information",
  active: "Active",
  suspended: "Suspended",
  failed: "Failed",
  unavailable: "Unavailable",
};

const DESTINATION_NAME: Record<DestinationCountry, string> = {
  CA: "Canadian",
  US: "US",
};

function make(
  destination: DestinationCountry,
  state: ReadinessState,
  detail: string,
  nextAction: string | null,
  actor: ReadinessActor,
  senderCountry: NanpCountry | null = null,
): DestinationReadiness {
  return { destination, state, label: READINESS_LABELS[state], detail, nextAction, actor, senderCountry };
}

/**
 * What a sender kind needs before it may text a destination.
 * `not_canadian_a2p_route`: provider guidance does not support this sender
 * type for A2P to that destination, so NO evidence makes it ready.
 */
export type RegistrationRequirement =
  | "none"
  | "a2p_10dlc"
  | "toll_free_verification"
  | "not_canadian_a2p_route";

/**
 * THE MATRIX (Twilio documentation, checked 2026-10-12):
 *   - A2P 10DLC is required for application traffic over a 10DLC number TO
 *     THE US, for US and Canadian long codes alike
 *     (twilio.com/docs/messaging/compliance/a2p-10dlc, "Who needs to register";
 *     twilio.com/docs/usage/tutorials/how-to-use-your-free-trial-account).
 *   - Toll-free numbers must be verified before messaging the US or Canada
 *     (same trial guide, "Toll-free verification (US and Canada only)";
 *     twilio.com/docs/messaging/compliance/toll-free/console-onboarding).
 * One table, so the panel, the tests and any later send-time check read the
 * same rule. `other_nanp` senders are refused before this is consulted.
 */
export const DESTINATION_RULES: Readonly<
  Record<Exclude<NanpCountry, "other_nanp">, Record<DestinationCountry, RegistrationRequirement>>
> = {
  CA: { CA: "not_canadian_a2p_route", US: "a2p_10dlc" },
  US: { CA: "not_canadian_a2p_route", US: "a2p_10dlc" },
  toll_free: { CA: "toll_free_verification", US: "toll_free_verification" },
};

const SENDER_KIND_NAME: Record<Exclude<NanpCountry, "other_nanp">, string> = {
  CA: "Canadian number",
  US: "US number",
  toll_free: "toll-free number",
};

/** Fixed: readiness is never a statement about HIPAA coverage (#828). */
export const NOT_HIPAA_COVERAGE =
  "Registration is not HIPAA coverage: texting patient information also needs a BAA-covered provider account.";

/** The registration part of readiness, when the matrix requires one. */
function fromRegistration(
  destination: DestinationCountry,
  evidence: UsRegistrationEvidence,
  senderCountry: NanpCountry,
): DestinationReadiness {
  const kind = senderCountry === "toll_free" ? "toll-free verification" : "A2P 10DLC brand and campaign registration";
  switch (evidence.state) {
    case "unreadable":
      return make(destination, "unavailable", `Hone could not read the ${kind} record just now.`, "Try again in a moment.", "none", senderCountry);
    case "approved":
      return make(
        destination,
        "active",
        senderCountry === "toll_free"
          ? "Toll-free verification of the studio's number is complete."
          : "A2P 10DLC registration is complete for the studio's number: the brand, the campaign and the number's own registration.",
        null,
        "none",
        senderCountry,
      );
    case "pending":
      return make(
        destination,
        "pending",
        senderCountry === "toll_free"
          ? "Toll-free verification of the studio's number is not complete yet."
          : "A2P 10DLC registration is not complete yet: the brand, the campaign or the number's own registration is still under review.",
        "Wait for the registration to complete.",
        "support",
        senderCountry,
      );
    case "requires_information":
      return make(
        destination,
        "requires_information",
        `The ${kind} needs more information: ${evidence.missing}.`,
        "Provide the missing registration information.",
        "owner",
        senderCountry,
      );
    case "rejected":
      return make(destination, "failed", `The studio's ${kind} was rejected.`, "Contact Hone support to review the registration.", "support", senderCountry);
    case "suspended":
      return make(destination, "suspended", `The studio's ${kind} is suspended.`, "Contact Hone support.", "support", senderCountry);
    case "not_recorded":
      return make(
        destination,
        "requires_information",
        `Hone has no record of ${kind} for this studio's number. A purchased or tested number is not registered by itself.`,
        "Contact Hone support to start registration.",
        "support",
        senderCountry,
      );
  }
}

/** Readiness of the studio's own sender for one destination country. */
export function destinationReadiness(
  destination: DestinationCountry,
  read: SenderRead,
  usRegistration: UsRegistrationEvidence,
): DestinationReadiness {
  if (!read.ok) {
    return make(destination, "unavailable", "Hone could not read this studio's SMS sender just now.", "Try again in a moment.", "none");
  }
  const row = read.sender;
  if (!row || row.status === "off" || row.status === "released") {
    return make(
      destination,
      "not_configured",
      "This studio does not have its own SMS number.",
      "Contact Hone support to request a studio number.",
      "support",
    );
  }
  switch (row.status) {
    case "selecting":
    case "provisioning":
      return make(destination, "pending", "The studio's number is being set up.", null, "none");
    case "releasing":
      return make(destination, "pending", "The studio's number is being released.", null, "none");
    case "suspended":
      return make(destination, "suspended", "The studio's number is suspended.", "Contact Hone support.", "support");
    case "error": {
      const route = row.last_error_code ? RECOVERY_ROUTE_BY_ERROR_CODE[row.last_error_code] : undefined;
      return make(
        destination,
        "failed",
        "Setting up the studio's number did not finish.",
        route === "retry" ? "Retry setup, or contact Hone support." : "Contact Hone support.",
        "support",
      );
    }
    case "active":
      break;
  }

  // ACTIVE: what the number is decides what it may serve.
  const number = classifyNanpNumber(row.phone_number);
  if (!number.ok) {
    return make(
      destination,
      "failed",
      "The studio's sender is active but its number is missing or not a valid +1 number.",
      "Contact Hone support.",
      "support",
    );
  }
  const senderCountry = number.country;
  if (senderCountry === "other_nanp") {
    return make(
      destination,
      "requires_information",
      `The studio's number is not Canadian or US, so it is not a supported sender for ${DESTINATION_NAME[destination]} recipients.`,
      "Contact Hone support.",
      "support",
      senderCountry,
    );
  }

  const rule = DESTINATION_RULES[senderCountry][destination];
  if (rule === "not_canadian_a2p_route") {
    return make(
      destination,
      "requires_information",
      `Twilio's guidance is that Canadian carriers restrict automated (A2P) texts sent from long codes, and it recommends short codes or verified toll-free numbers for automated texts to Canada. Hone therefore does not treat the studio's ${SENDER_KIND_NAME[senderCountry]} as ready for automated texts to Canadian clients.`,
      "Contact Hone support about a verified toll-free number for Canadian clients.",
      "support",
      senderCountry,
    );
  }
  if (rule === "none") {
    return make(
      destination,
      "active",
      `The studio's ${SENDER_KIND_NAME[senderCountry]} can text ${DESTINATION_NAME[destination]} recipients.`,
      null,
      "none",
      senderCountry,
    );
  }
  return fromRegistration(destination, usRegistration, senderCountry);
}

/** Both destinations, in the order the panel shows them. */
export function studioSenderReadiness(
  read: SenderRead,
  usRegistration: UsRegistrationEvidence,
): DestinationReadiness[] {
  return [
    destinationReadiness("CA", read, usRegistration),
    destinationReadiness("US", read, usRegistration),
  ];
}
