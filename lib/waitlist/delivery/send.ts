import "server-only";
import {
  sendWaitlistEmailIdempotent,
  type IdempotentEmailTransport,
} from "@/lib/email/new-client-waitlist-send";
import { studioEmailIdentity } from "@/lib/email/studio-identity";
import { buildWaitlistInvitationEmail } from "@/lib/email/templates/waitlist-invitation";
import { buildWaitlistRecipientProofEmail } from "@/lib/email/templates/waitlist-recipient-proof";
import {
  classifyDelivery,
  isProofExpiryWithinCeiling,
  proofWindowMinutes,
  type DeliveryDisposition,
} from "./policy";
import { buildDeliveryLogRecord, type DeliveryLogRecord } from "./log-safety";

// WAIT DELIVERY-01 — the two send paths.
//
// ===========================================================================
// WHY sendWaitlistEmailIdempotent AND NOT sendEmailSafely
// ===========================================================================
//
// The shared helper passes no provider options, so it cannot send an
// `Idempotency-Key`, and its 15s timeout cannot cancel the request already in
// flight — so a send may be reported failed and be accepted moments later. Its
// own header says every other caller survives that because it has a durable row
// to reconcile against.
//
// Both sends here are worse off than those callers in one specific way: a
// duplicate is not merely noisy. A second INVITATION email tells one prospect
// twice that a single spot is theirs. A second PROOF email delivers a code the
// database may already have superseded, and the recipient reasonably types the
// newest one they can see. So both take the idempotent path, and both consume
// its three-way outcome rather than a boolean.
//
// ===========================================================================
// EVENT SCOPE — WHAT MAKES TWO SENDS "THE SAME SEND"
// ===========================================================================
//
// `sendWaitlistEmailIdempotent` derives its key from the tenant, an optional
// durable event identity, and a hash of the exact payload. Passing an event
// scope is what turns "same bytes = same request" into "same EVENT = same
// request", and WAIT-02 added the parameter precisely because a re-join could
// render byte-identical mail for a genuinely new row.
//
// Both flows here have that problem in a sharper form:
//
//   INVITATION -> scope is the INVITATION id. An entry may be invited, expire,
//   be requeued and be invited again (0188's stated reason for a child table).
//   Two cycles render identical bytes for the same studio, so a payload-only
//   key would replay the first send's response and the second invitation would
//   report accepted while nobody received it.
//
//   PROOF -> scope is the CHALLENGE id, and it is the WHOLE key: this send sets
//   `payloadCarriesSecret`, so no payload digest is computed at all.
//
//   That is a security fix, not a refinement. The default key is SHA-256 over
//   the exact payload, the payload is the email body, and the body holds the
//   code. The digest travels to the provider in the `Idempotency-Key` header
//   and is retained there. Because every other field is deterministic and
//   knowable, a captured header lets an attacker enumerate a small code space
//   offline -- render, hash, compare -- until it matches. It was demonstrated
//   against this path: an eight-character code was recovered from the header
//   alone. So the proof key carries no payload component, and the challenge id
//   is what makes it unique.
//
//   THE PRICE, PAID DELIBERATELY. Without a payload digest the key no longer
//   tracks the bytes, so this payload must be a PURE FUNCTION of the challenge
//   -- the corollary new-client-waitlist-send.ts already states for every
//   caller. It is why the email advertises the AUTHORISED WINDOW rather than
//   the remaining time: a wall clock in the body would make two attempts under
//   one key render different bytes, and the provider answers that with
//   `invalid_idempotent_request` rather than a replay.
//
// ===========================================================================
// DELIVERY IS NOT LIFECYCLE
// ===========================================================================
//
// Neither function reads or writes invitation state. They render, send, and
// classify. `DeliveryDisposition.mayMutateLifecycle` is `false` in every branch
// and is returned to the caller so the rule is visible at the call site rather
// than implied by this module's silence.

export type DeliveryResult = {
  disposition: DeliveryDisposition;
  /** The only log record this feature emits. Safe by construction. */
  log: DeliveryLogRecord;
};

/** The studio fields both sends need. Server-resolved; never request input. */
export type DeliveryStudio = {
  id: string;
  name?: string | null;
  postcare_contact_email?: string | null;
  owner_email?: string | null;
};

/**
 * Send the invitation email.
 *
 * `recipientEmail` MUST be the address stored on the waitlist entry, resolved
 * server-side through `invitations.entry_id`. It is never taken from the
 * request: the whole point of the split is that possession of the link does not
 * let the holder choose where anything is delivered.
 */
export async function sendWaitlistInvitationEmail(args: {
  studio: DeliveryStudio;
  invitationId: string;
  recipientEmail: string;
  /** Absolute URL that RESOLVES the invitation. Must not mutate it. */
  invitationUrl: string;
  /** Human phrase derived by the caller from the stored `expires_at`. */
  expiresInPhrase: string;
  /** Test seam. Omitted in production, where the shared client is used. */
  transport?: IdempotentEmailTransport | null;
}): Promise<DeliveryResult> {
  const email = buildWaitlistInvitationEmail({
    studioName: args.studio.name ?? "",
    invitationUrl: args.invitationUrl,
    expiresInPhrase: args.expiresInPhrase,
  });

  const outcome = await sendWaitlistEmailIdempotent({
    namespace: "client",
    studioId: args.studio.id,
    // One key per invitation, not per payload. See the header.
    eventScope: args.invitationId,
    to: args.recipientEmail,
    subject: email.subject,
    html: email.html,
    text: email.text,
    // COMMS-01A: a client-facing send carries the studio's identity, so the
    // From reads "<Studio> via Hone" and Reply-To resolves to the studio's own
    // contact authority rather than to Hone.
    studioIdentity: studioEmailIdentity(args.studio),
    ...(args.transport !== undefined ? { transport: args.transport } : {}),
  });

  const disposition = classifyDelivery(outcome);
  return {
    disposition,
    log: buildDeliveryLogRecord({
      kind: "invitation",
      studioId: args.studio.id,
      invitationId: args.invitationId,
      disposition: disposition.reason,
      providerMessageId:
        outcome.status === "accepted" ? outcome.messageId : null,
    }),
  };
}

/**
 * Send the recipient-proof email.
 *
 * REFUSES BEFORE IT SENDS if the stored expiry is outside the mandate. A proof
 * that outlives `PROOF_TTL_CEILING_MINUTES`, or one that has already elapsed,
 * indicates the mint and this path disagree; delivering it either extends the
 * window past what was authorised or burns the recipient's resend budget on a
 * dead code. The refusal is classified as an ordinary rejection so the caller's
 * existing branch handles it, and it is recorded with its own reason so the
 * cause is not mistaken for a provider fault.
 */
export async function sendWaitlistRecipientProofEmail(args: {
  studio: DeliveryStudio;
  invitationId: string;
  /** Internal UUID of the challenge. Never the code. */
  challengeId: string;
  recipientEmail: string;
  /** The raw proof code. Rendered into the email and NEVER logged. */
  code: string;
  /** Stored mint time, owned by the database. With `expiresAt` it gives the
   *  AUTHORISED WINDOW the email advertises — a value that does not drift. */
  issuedAt: Date;
  /** Stored expiry, owned by the database. Used for the ceiling guard only. */
  expiresAt: Date;
  /** What the code will authorise, so the copy states the consequence. */
  action: "book" | "decline";
  /** Injected for determinism in tests; defaults to now. */
  now?: Date;
  transport?: IdempotentEmailTransport | null;
}): Promise<DeliveryResult> {
  const now = args.now ?? new Date();

  if (!isProofExpiryWithinCeiling(args.expiresAt, now)) {
    const disposition = classifyDelivery({
      status: "rejected",
      code: "proof_expiry_outside_mandate",
    });
    return {
      disposition,
      log: buildDeliveryLogRecord({
        kind: "recipient_proof",
        studioId: args.studio.id,
        invitationId: args.invitationId,
        challengeId: args.challengeId,
        disposition: disposition.reason,
      }),
    };
  }

  const email = buildWaitlistRecipientProofEmail({
    studioName: args.studio.name ?? "",
    code: args.code,
    // The AUTHORISED WINDOW, from two database-owned values. Deliberately not
    // the remaining time: the key below carries no payload digest, so this
    // payload has to be a pure function of the challenge or two attempts under
    // one key would render different bytes.
    windowMinutes: proofWindowMinutes(args.issuedAt, args.expiresAt),
    action: args.action,
  });

  const outcome = await sendWaitlistEmailIdempotent({
    namespace: "client",
    studioId: args.studio.id,
    // One key per CHALLENGE. See the header on why the code's own bytes are
    // not enough.
    eventScope: args.challengeId,
    to: args.recipientEmail,
    subject: email.subject,
    html: email.html,
    text: email.text,
    studioIdentity: studioEmailIdentity(args.studio),
    // THE CODE MUST NOT REACH THE PROVIDER HEADER. Without this the key is
    // SHA-256 over the exact payload, and the payload is the email body — so
    // the transmitted Idempotency-Key becomes an offline verifier for a
    // small-search-space secret. Demonstrated against this very path before the
    // flag existed; the negative control lives in
    // tests/security/waitlist-delivery-secret-logging.test.ts.
    payloadCarriesSecret: true,
    ...(args.transport !== undefined ? { transport: args.transport } : {}),
  });

  const disposition = classifyDelivery(outcome);
  return {
    disposition,
    log: buildDeliveryLogRecord({
      kind: "recipient_proof",
      studioId: args.studio.id,
      invitationId: args.invitationId,
      challengeId: args.challengeId,
      disposition: disposition.reason,
      providerMessageId:
        outcome.status === "accepted" ? outcome.messageId : null,
    }),
  };
}
