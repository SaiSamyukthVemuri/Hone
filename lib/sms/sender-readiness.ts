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
// WHAT "ACTIVE" REQUIRES, and what it does not:
//   * Canada: an ACTIVE 0191 sender whose number is Canadian. A US number
//     serving Canadian recipients is held to the US-registration rule, because
//     the number's own carrier rules apply to everything it sends.
//   * United States: an ACTIVE sender whose number is US (10DLC) or toll-free,
//     AND recorded registration evidence that is approved — the 10DLC brand,
//     campaign and number association, or toll-free verification. A Canadian
//     number is never a registered US sender, and relabelling it cannot make
//     it one.
//   A number existing, or passing one test send, establishes neither.
//
// REGISTRATION EVIDENCE is recorded by Hone support in 0217
// (SMS-SENDER-REG-01) after checking the provider account, and read through
// lib/sms/sender-registration.ts. With no record, US readiness is "Requires
// information". Recording "approved" is evidence, not an activation.
//
// This module reads nothing and sends nothing. It is the input the later
// send-time refusal will consume, so the panel and the refusal cannot disagree.
// ===========================================================================

export type DestinationCountry = "CA" | "US";

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

/** The registration part of a US-registered sender's readiness. */
function fromRegistration(
  destination: DestinationCountry,
  evidence: UsRegistrationEvidence,
  senderCountry: NanpCountry,
): DestinationReadiness {
  const kind = senderCountry === "toll_free" ? "toll-free verification" : "US 10DLC brand and campaign registration";
  switch (evidence.state) {
    case "unreadable":
      return make(destination, "unavailable", `Hone could not read the ${kind} record just now.`, "Try again in a moment.", "none", senderCountry);
    case "approved":
      return make(destination, "active", `The studio's number has approved ${kind}.`, null, "none", senderCountry);
    case "pending":
      return make(destination, "pending", `The studio's ${kind} is under review.`, "Wait for the review to finish.", "support", senderCountry);
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

  if (destination === "CA") {
    if (senderCountry === "CA") {
      return make(destination, "active", "The studio's Canadian number can text Canadian recipients.", null, "none", senderCountry);
    }
    // A US long code or toll-free number is held to its own registration.
    return fromRegistration(destination, usRegistration, senderCountry);
  }

  // destination === "US"
  if (senderCountry === "CA") {
    return make(
      destination,
      "requires_information",
      "The studio's number is Canadian. Texting US recipients needs a US number with 10DLC registration, or a verified toll-free number.",
      "Contact Hone support to plan US texting.",
      "support",
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
