// WAIT B2b — the possession-proof provider boundary.
//
// TYPES AND A HONE-OWNED VOCABULARY ONLY. No provider call, no credentials, no
// HTTP. The real adapter (B2b-2) and the process-wide fake both satisfy this
// interface, so nothing above them can tell which is installed — and nothing
// below them can leak a provider's own error text to a public surface.
//
// WHY A BOUNDARY AT ALL, rather than calling Twilio Verify from the action:
// scattering provider calls through actions is how a provider's vocabulary ends
// up rendered to a person, and how a test ends up needing network access. The
// existing lib/sms/provider/ boundary made the same choice for provisioning and
// is the pattern this follows.
//
// WHAT VERIFICATION IS NOT. Nothing in this file knows about studios, senders,
// #716 routing, or per-studio sender activation. Verification identity is a HONE
// concern: it answers "does this person reach this number", which is true or
// false independently of which studio later wants to text them. Binding it to a
// studio sender would make a person's proven number un-proven the moment a
// studio changed numbers.

/**
 * OUTCOMES, DELIBERATELY COARSE AT THE EDGES.
 *
 * `rejected` covers every "the code was not right" case the provider can
 * report — wrong, expired, already-consumed, too many attempts. They are one
 * value here because the SURFACE must render one message: telling an anonymous
 * caller that a code was "expired rather than wrong" tells them the code
 * existed, which tells them the number is on a waitlist.
 *
 * `unavailable` is the only outcome that invites a retry, and it is what an
 * unconfigured deployment returns — so an install with no Verify configuration
 * cannot accidentally report success or a refusal it did not earn.
 */
export const VERIFICATION_START_OUTCOMES = [
  "started",
  /** The provider would not start a challenge for this destination. */
  "refused",
  /** Too many challenges for this destination in the current window. */
  "rate_limited",
  /** Not configured, network failure, provider error. Retryable. */
  "unavailable",
] as const;

export type VerificationStartOutcome = (typeof VERIFICATION_START_OUTCOMES)[number];

export const VERIFICATION_CHECK_OUTCOMES = [
  /** Possession proved. The ONLY value that may lead to a standing promotion. */
  "approved",
  /** Wrong, expired, consumed, or too many attempts. One value on purpose. */
  "rejected",
  /** Too many checks in the current window. */
  "rate_limited",
  /** Not configured, network failure, provider error. Retryable. */
  "unavailable",
] as const;

export type VerificationCheckOutcome = (typeof VERIFICATION_CHECK_OUTCOMES)[number];

/**
 * The destination is an E.164 string and nothing else.
 *
 * NO ENTRY ID, NO STUDIO, NO CAPABILITY TOKEN crosses this boundary. A provider
 * needs a phone number and a code; giving it Hone's identifiers would put them
 * in a third party's logs for no benefit, and would let a future adapter start
 * making decisions that belong to Hone.
 */
export type VerificationDestination = { e164: string };

export interface MobileVerificationProvider {
  /** Ask the provider to deliver a possession challenge. */
  start(destination: VerificationDestination): Promise<VerificationStartOutcome>;
  /**
   * Ask the provider whether this code proves possession of this destination.
   *
   * THE PROVIDER DECIDES, NOT HONE. Hone holds no OTP secret, no expiry clock
   * and no attempt counter — inventing those is how brute-force and replay bugs
   * get written. `approved` is the provider's answer to a question only it can
   * answer, and it is the sole path to a verified standing.
   */
  check(
    destination: VerificationDestination,
    code: string,
  ): Promise<VerificationCheckOutcome>;
}
