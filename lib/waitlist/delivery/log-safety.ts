// WAIT DELIVERY-01 — the only log record this feature may emit.
//
// ===========================================================================
// A CLOSED CONSTRUCTOR, NOT A SCRUBBER
// ===========================================================================
//
// Hone already has a redactor: `lib/ops/redact.ts` strips credential-shaped
// KEYS (`token`, `raw_token`, `secret`, …) and secret-shaped VALUES from every
// ops alert before it reaches a sink. That module is excellent and stays where
// it is. It is the wrong primary defence here, for one reason: a scrubber is a
// net, and a net is defined by what someone remembered to catch. It runs over
// text a caller already decided to log.
//
// This module inverts that. There is exactly ONE way to build a delivery log
// record, it takes a fixed set of named fields, and NONE of them can carry a
// secret because the type does not have a slot for one. A caller that wants to
// log the raw code has nowhere to put it. That is a wall rather than a net, and
// it is what makes the guard test in
// tests/security/waitlist-delivery-secret-logging.test.ts checkable at all: the
// test asserts a property of a closed shape instead of trying to prove the
// absence of a string across arbitrary free text.
//
// `redactOpsAlertDetails` remains the SECOND layer for anything that escalates
// to an ops alert. Two layers, different mechanisms, neither relying on the
// other having been remembered.
//
// ===========================================================================
// WHY NOT EVEN A HASH OR A PREFIX OF THE SECRET
// ===========================================================================
//
// `lib/security/token-routes.ts` already made this argument for the bearer
// token and it applies unchanged to the proof code:
//
//   *"A FIXED string, deliberately not a hash, not a fingerprint, not a
//    truncation. A stable hash of a bearer token is still a correlatable
//    identifier for that token, and a prefix/suffix is a brute-force head
//    start; neither is acceptable here."*
//
// A proof code is drawn from a far smaller space than a 256-bit token, so a
// truncation is proportionally more of a head start, not less. Nothing derived
// from the code is logged: not the code, not its hash, not its length, not its
// first character.
//
// Pure module: no I/O, no env, no provider, no `server-only`.

/** What was being delivered. */
export type DeliveryKind = "invitation" | "recipient_proof";

/**
 * The complete set of fields a delivery log line may carry.
 *
 * Every one is either an internal UUID, a bounded enum, or a provider-issued
 * message id. There is deliberately NO free-text field: a `message` or
 * `details` string is exactly where a provider error carrying a recipient
 * address or a URL would arrive, which is the leak `lib/ops/redact.ts` was
 * written after PR #285 to clean up. Here it simply cannot be passed.
 */
export type DeliveryLogInput = {
  kind: DeliveryKind;
  /** Internal UUID. Not personal data. */
  studioId: string;
  /** Internal UUID. Not the bearer token. */
  invitationId: string;
  /**
   * Internal UUID of the proof challenge, for proof sends. NEVER the code.
   * Present so an operator can correlate a complaint with a mint without any
   * secret being written down.
   */
  challengeId?: string | null;
  /** From `classifyDelivery`. A bounded vocabulary, never provider free text. */
  disposition: string;
  /** Provider-issued id for the accepted message. Safe: it identifies the
   *  message in the provider's console, not the credential inside it. */
  providerMessageId?: string | null;
};

/** The emitted record. Fixed keys, all non-sensitive. */
export type DeliveryLogRecord = {
  event: "waitlist_delivery";
  kind: DeliveryKind;
  studio_id: string;
  invitation_id: string;
  challenge_id: string | null;
  disposition: string;
  provider_message_id: string | null;
};

/**
 * Build the one legal delivery log record.
 *
 * Note what is absent from the return type as much as what is present: no
 * recipient address, no subject, no rendered body, no URL, no code. The
 * recipient is derivable from `invitation_id` by anyone with database access
 * and is therefore not worth writing into a log that may be shipped to a third
 * party, which is the same reasoning `lib/rate-limit/public.ts` uses when it
 * hashes an email before it can reach a Redis key or a log line.
 */
export function buildDeliveryLogRecord(
  input: DeliveryLogInput,
): DeliveryLogRecord {
  return {
    event: "waitlist_delivery",
    kind: input.kind,
    studio_id: input.studioId,
    invitation_id: input.invitationId,
    challenge_id: input.challengeId ?? null,
    disposition: input.disposition,
    provider_message_id: input.providerMessageId ?? null,
  };
}

/**
 * The keys a delivery log record is permitted to have.
 *
 * Exported so the guard test pins the shape from the outside. If someone adds a
 * field to `DeliveryLogRecord`, the test fails until this list is updated —
 * which is the moment to ask whether the new field can carry a secret. A type
 * alone would not force that pause, because TypeScript is happy to widen.
 */
export const DELIVERY_LOG_KEYS: readonly string[] = [
  "event",
  "kind",
  "studio_id",
  "invitation_id",
  "challenge_id",
  "disposition",
  "provider_message_id",
] as const;
