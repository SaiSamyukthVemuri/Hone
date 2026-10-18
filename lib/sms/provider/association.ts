import type { NumberAssociation } from "./types";

// WILLOW ADOPTION — shared association semantics.
//
// Pure, so both the real adapter and the fake reach the same verdict from the
// same evidence. A fake that classified differently from the adapter would make
// every adoption test a statement about the fake.

/**
 * Turn the census result — every service observed to hold the number — into the
 * five-state verdict.
 *
 * TWO OR MORE HOLDERS IS CONTRADICTORY, not a preference to resolve. Twilio
 * allows a number in exactly one Messaging Service, so observing two means the
 * census raced a change or the account is in a state nobody intended. Picking
 * the expected one would be the most dangerous possible reading: it would let
 * adoption proceed precisely when the provider is telling us it does not know
 * where the number is.
 */
export function classifyAssociation(
  holders: readonly string[],
  expectedMessagingServiceSid: string,
): NumberAssociation {
  const unique = [...new Set(holders)];
  if (unique.length === 0) return { kind: "not_associated" };
  if (unique.length > 1) {
    return { kind: "ambiguous", messagingServiceSids: unique };
  }
  const only = unique[0];
  return only === expectedMessagingServiceSid
    ? { kind: "in_expected_service", messagingServiceSid: only }
    : { kind: "in_other_service", messagingServiceSid: only };
}

/**
 * A provider identifier reduced to something safe to put in an operator message
 * or an ordinary log line: the two-character resource prefix and the last four
 * characters. Enough for an operator to recognise the resource in the Twilio
 * console, not enough to be a usable identifier if the line leaks.
 */
export function safeResourceId(sid: string | null | undefined): string {
  if (typeof sid !== "string" || sid.length < 6) return "unknown";
  return `${sid.slice(0, 2)}…${sid.slice(-4)}`;
}
